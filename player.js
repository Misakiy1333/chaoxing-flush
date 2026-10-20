/**
 * 视频播放模拟（2026 版 · 已实测打通）
 *
 * 节奏（服务端按墙钟记账）：
 *   起播 isdrag=3 → 每 65s 心跳一次 isdrag=2（playingTime +60）
 *   → 到顶 isdrag=4，响应 isPassed=true 即完成。
 *   每轮心跳前重新取 status 换新 dtoken。
 */
const sleep = (t) => new Promise((y) => setTimeout(y, t));

/** 可中断的等待：调用 stop() 后 250ms 内返回，实现「立即停止」 */
async function sleepAbortable(ms, isStopped) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isStopped && isStopped()) return;
    await sleep(Math.min(250, Math.max(0, end - Date.now())));
  }
}

class Player {
  constructor(session, reporter, opts) {
    this.s = session;
    this.reporter = reporter;
    this.speed = Math.max(0.5, Math.min(Number(opts && opts.speed) || 1, 8));
    this.interval = Math.max(60, Number(opts && opts.interval) || 65); // 墙钟秒
    this.dryRun = !!(opts && opts.dryRun);
    this.log = (opts && opts.log) || console.log;
    this.quizAgent = opts && opts.quizAgent; // QuizAgent 实例（可选）
    this.hz = (opts && opts.humanizer) || null; // 拟人化调度（可选）
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  /**
   * 播放一个视频任务点。
   * @param onTick 可选回调 (playingTime, duration)
   * @returns {ok, isPassed, playingTime, duration}
   */
  async play(course, job, onTick) {
    const tick = (pt, dur) => { try { onTick && onTick(pt, dur); } catch (e) {} };
    const isDone = require("./course.js").isVideoDone;

    // ① 任务点资料里已经显示完成 → 直接跳过，连请求都省了
    if (isDone(job)) {
      this.log(`  ✔ ${String(job.name || "").slice(0, 30)}  已完成（跳过）`);
      return { ok: true, isPassed: true, playingTime: 0, duration: Number(job.attDuration) || 0, skipped: true };
    }

    // ② 回读服务端记录（按 objectId 精确匹配当前视频；只读第一页的多视频章节会串位）
    let base = 0;
    let durationHint = Number(job.attDuration) || 0;
    try {
      const prog = await course.readProgress(job.kid);
      if (prog && prog.objectId === job.objectId) {
        if (prog.playTime > 0) base = prog.playTime;
        if (prog.attDuration) durationHint = Number(prog.attDuration) || durationHint;
        if (isDone(prog)) {
          this.log(`  ✔ ${String(job.name || "").slice(0, 30)}  已完成（跳过）`);
          return { ok: true, isPassed: true, playingTime: base, duration: prog.attDuration, skipped: true };
        }
      }
    } catch (e) {}

    const status = await course.getStatus(job.objectId);
    const duration = Number(status.duration) || durationHint || 0;
    if (!duration) throw new Error("取不到视频时长");

    let playing = base;
    let passed = false;
    let lastOk = true;

    const name = String(job.name || "").slice(0, 34);
    const remain = Math.max(0, duration - base);
    this.log(`\n  ▶ ${name}  (${Math.round(remain / 60)} 分钟@${this.speed}x${base ? `，续播自${base}s` : ""})`);

    if (this.dryRun) {
      this.log(`    [dry] 将从 ${base}s 推进到 ${duration}s`);
      return { ok: true, isPassed: false, playingTime: base, duration, dry: true };
    }

    // 起播
    let r = await this.reporter.send(course, job, status, playing, 3);
    lastOk = r.ok;
    passed = r.isPassed;

    // 视频内插题：开播即取题并交给 agent 作答（播放到时间点时服务端已收到答案）
    if (this.quizAgent && job.mid) {
      try {
        const quizzes = await course.getQuizData(job.mid);
        for (const q of quizzes) {
          if (q.answered) continue;
          const r = await this.quizAgent.answer(
            { clazzId: course.cz, objectId: job.objectId },
            q
          );
          this.log(
            `    ✎ 弹题[${q.questionType}] ${String(q.description).slice(0, 30)}… → ${r.answer || "?"}` +
              (r.right ? " ✔答对" : r.ok ? "（已提交）" : " ✖提交失败")
          );
        }
      } catch (e) {
        this.log("    ✎ 弹题处理失败: " + e.message);
      }
    }

    // 心跳推进（speed>1 仅在课程放开倍速时有效；服务端按墙钟校验）
    // 间隔加入随机抖动（65±8s），避免过于机械的固定周期
    while (!this.stopped && playing < duration && !passed) {
      const jitter = 1 + (Math.random() * 16 - 8) / 100; // 0.92 ~ 1.08
      await sleepAbortable(Math.round(this.interval * 1000 * jitter), () => this.stopped);
      if (this.stopped) break;

      playing = Math.min(duration, playing + Math.round(this.speed * 60));
      const isEnd = playing >= duration;
      const isdrag = isEnd ? 4 : 2;

      // 每轮新 dtoken
      const fresh = await course.getStatus(job.objectId).catch(() => status);
      r = await this.reporter.send(course, job, fresh, playing, isdrag);
      lastOk = r.ok;
      passed = r.isPassed;

      const pct = ((playing / duration) * 100).toFixed(1);
      tick(playing, duration);
      this.log(
        `    ${pct}%  ${playing}/${duration}s  HTTP ${r.status}` +
          (r.isPassed ? "  ✔ 已完成" : "") +
          (r.ok ? "" : "  ✖ " + String(r.raw || "").slice(0, 80))
      );

      if (!r.ok) {
        await sleepAbortable(3000, () => this.stopped);
        if (this.stopped) break;
        const r2 = await this.reporter.send(course, job, fresh, playing, isdrag);
        lastOk = r2.ok;
        passed = r2.isPassed;
        if (!r2.ok) this.log("    重试仍失败: " + String(r2.raw || "").slice(0, 100));
      }

      // 拟人化：偶尔暂停再继续（真人会切出去、接个电话、走开一会儿）
      if (this.hz && !isEnd && this.hz.shouldPause()) {
        try { await this.reporter.send(course, job, fresh, playing, 3); } catch (e) {}
        const t = await this.hz.pauseLikeHuman();
        this.log(`    ⏸ 暂停 ${Math.round(t / 1000)} 秒`);
      }
    }

    if (!this.dryRun && !this.stopped && playing >= duration && !passed) {
      const r = await this.reporter.send(course, job, status, duration, 4);
      lastOk = r.ok;
      passed = r.isPassed;
    }

    return { ok: lastOk, isPassed: passed, playingTime: playing, duration };
  }
}

module.exports = Player;
