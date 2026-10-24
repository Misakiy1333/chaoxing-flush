/**
 * 课程级调度（2026 版 · 支持并发）
 *
 * 加速方式：
 *  1) 并发池：同时刷 N 个章节的视频（各自独立会话），服务端按视频分别记账
 *     —— 实测同账号并发上报两个视频都被记账，吞吐 = 并发数
 *  2) 课程放开倍速时（attachment.property.doublespeed>=1）按 2x 推进
 */
const CourseData = require("./course.js");
const { isVideoDone } = require("./course.js");
const WA = require("./workAgent.js");
const Reporter = require("./logger.js");
const Player = require("./player.js");
const Session = require("./session.js");
const { Humanizer } = require("./humanize.js");
const sleep = (t) => new Promise((y) => setTimeout(y, t));

class CourseTask {
  constructor(session, cfg) {
    this.s = session;
    this.cfg = cfg || {};
    this.quizAgent = this.cfg.quizAgent || null;
    this.reporter = new Reporter(session);
    // 拟人化调度：除出口 IP 外的所有风控特征都由它压平
    this.hz = new Humanizer(Object.assign({}, this.cfg, { log: (l) => this.log(l) }));
    if (this.quizAgent && !this.quizAgent.hz) this.quizAgent.hz = this.hz;

    this.player = new Player(session, this.reporter, {
      speed: 1,
      interval: this.cfg.reportInterval || 60,
      dryRun: !!this.cfg.dryRun,
      log: this.cfg.log || console.log,
      quizAgent: this.quizAgent,
      humanizer: this.hz,
    });

    // 章节测验 / 作业（手机端协议，含正确率区间控制）
    // 默认关闭：只有明确 workEnabled === true 才创建 workAgent。
    // 用 !== false 会把「没配过」也当成开，界面上开关显示关闭却仍在后台答题。
    this.workState = WA.loadState();
    this.workEnabled = this.cfg.workEnabled === true;
    this.workAgent = this.workEnabled
      ? this.cfg.workAgent ||
        new WA.WorkAgent(session, {
          // 优先用调用方传进来的 bank（预热/单测都会传），否则退回 quizAgent 的
          bank: this.cfg.bank || (this.quizAgent ? this.quizAgent.bank : undefined),
          accuracyMin: this.cfg.accuracyMin,
          accuracyMax: this.cfg.accuracyMax,
          rounds: this.cfg.workRounds,
          log: (l) => this.log(l),
          humanizer: this.hz,
          // 在线答题源：外部题库接口(OCS AnswererWrapper 协议) + 大模型(OpenAI 兼容)
          remote: {
            enabled: this.cfg.answerRemoteEnabled === true,
            url: this.cfg.answerRemoteUrl || "",
            token: this.cfg.answerRemoteToken || "",
          },
          llm: {
            enabled: this.cfg.llmEnabled === true,
            baseUrl: this.cfg.llmBaseUrl || "",
            apiKey: this.cfg.llmApiKey || "",
            model: this.cfg.llmModel || "",
            maxCalls: this.cfg.llmMaxCalls == null ? 200 : Number(this.cfg.llmMaxCalls),
            // 推理模型要给足思考空间，给小了 content 会是空串（实测 96% → 0%）
            maxTokens: this.cfg.llmMaxTokens == null ? 800 : Number(this.cfg.llmMaxTokens),
            timeoutMs: this.cfg.llmTimeoutMs == null ? 60000 : Number(this.cfg.llmTimeoutMs),
          },
          // 云端共享题库：先查它，再问大模型
          shared: {
            enabled: !!this.cfg.sharedBankUrl,
            url: this.cfg.sharedBankUrl || "",
            key: this.cfg.sharedBankKey || "shared",
          },
        })
      : null;
    // 弹题和章节测验共用同一个答题源（题库接口/大模型的额度不被重复计）
    if (this.workAgent && this.workAgent.provider && this.quizAgent) {
      this.quizAgent.provider = this.workAgent.provider;
    }
    // 拟人模式下强制单路：同账号并发本身就是强风控特征
    this.parallel = this.hz.enabled
      ? 1
      : Math.max(1, Math.min(8, parseInt(this.cfg.parallel, 10) || 1));
    // 每日限量：防止长时间连续访问触发风控（单位小时，0=不限）
    this.dailyHours = this.cfg.dailyHours == null ? 4 : Number(this.cfg.dailyHours);
    // 刷课时段（小时，24 表示当天结束；0~24 表示全天）
    this.brushStart = this.cfg.brushStart == null ? 0 : Number(this.cfg.brushStart);
    this.brushEnd = this.cfg.brushEnd == null ? 24 : Number(this.cfg.brushEnd);
    this.windowNotified = 0;
    this.runStart = 0;
    this.limitReached = false;
    this.stats = { courses: 0, chapters: 0, videos: 0, passed: 0, failed: 0, skipped: 0, quiz: 0, works: 0 };
    this.workScores = []; // [{title, score, full, ratio}]
    this.courseList = [];
    this.failedChapters = [];
    this.active = {}; // workerId -> {course, chapter, video, playingTime, duration, pct}
    this.ui = { current: null, currentCourse: "", doneCourses: 0, totalCourses: 0, active: [] };
    // 每门课的实时进度（前端进度条用）
    this.courseProgress = {};
    // 风控状态（前端风控面板用）
    this.risk = { blockHits: 0, coolingUntil: 0, lastBlockAt: 0, blocked: false, note: "" };
    this.stopped = false; // 随时可停
  }

  /** 立即停止：清空队列并停掉正在播的视频 */
  stop() {
    this.stopped = true;
    try { if (this.player && this.player.stop) this.player.stop(); } catch (e) {}
    try { if (this.hz && this.hz.stop) this.hz.stop(); } catch (e) {}
    this.log("⏹ 已请求停止，正在收尾…");
  }

  /** 给服务端/前端用的状态快照 */
  snapshot() {
    const now = Date.now();
    const usedMs = this.runStart ? now - this.runStart : 0;
    return {
      stats: this.stats,
      ui: this.ui,
      courses: Object.values(this.courseProgress),
      quiz: this.quizAgent ? this.quizAgent.stats : null,
      works: this.workScores.slice(-12),
      accuracy: this.workAgent
        ? { min: this.workAgent.accuracy.min, max: this.workAgent.accuracy.max }
        : null,
      answer: this.workAgent && this.workAgent.provider ? this.workAgent.provider.stats : null,
      risk: {
        level: this.risk.blocked ? "blocked" : this.risk.coolingUntil > now ? "cooling" : this.risk.blockHits ? "warn" : "ok",
        blockHits: this.risk.blockHits,
        coolingUntil: this.risk.coolingUntil,
        coolingLeftMs: this.risk.coolingUntil > now ? this.risk.coolingUntil - now : 0,
        lastBlockAt: this.risk.lastBlockAt,
        note: this.risk.note,
      },
      time: {
        usedMs,
        dailyLimitMs: this.dailyHours > 0 ? this.dailyHours * 3600000 : 0,
        limitReached: !!this.limitReached,
        brushStart: this.brushStart,
        brushEnd: this.brushEnd,
      },
    };
  }

  log(...a) {
    if (this.cfg.log) this.cfg.log(...a);
    else console.log(...a);
  }

  _setCurrent(workerId, course, chapter, video, playingTime, duration) {
    const rec = {
      course: course ? course.title : "",
      chapter: chapter || "",
      video: video || "",
      playingTime: playingTime || 0,
      duration: duration || 0,
      pct: duration ? Math.min(100, Math.round(((playingTime || 0) / duration) * 1000) / 10) : 0,
    };
    if (workerId == null) {
      this.ui.current = rec;
      if (course) this.ui.currentCourse = course.title;
    } else {
      this.active[workerId] = rec;
      const arr = Object.values(this.active);
      this.ui.active = arr;
      // 展示进度最靠前的作为 current
      let best = null;
      for (const a of arr) if (!best || (a.duration && a.pct > (best.duration ? best.pct : -1))) best = a;
      if (best) this.ui.current = best;
    }
  }

  async loadCourses() {
    const list = await CourseData.list(this.s, { courseType: 1 });
    this.courseList = list;
    return list;
  }

  /** 任务点兼容：旧结构是数组，新结构是 {videos, works} */
  _videos(j) {
    return Array.isArray(j) ? j : (j && j.videos) || [];
  }
  _works(j) {
    return Array.isArray(j) ? [] : (j && j.works) || [];
  }
  /** 还没处理过的测验/作业 */
  _pendingWorks(works) {
    if (!this.workAgent || !works || !works.length) return [];
    return works.filter((w) => !WA.isWorkDone(this.workState, w.workid));
  }

  /**
   * 处理一章里的章节测验 / 作业
   * 全部交卷 + 按用户设的正确率区间控分，做完把状态记到 workstate.json
   */
  async runWorks(course, wid, info, kid, works, chapterLabel) {
    if (!this.workAgent || !works || !works.length) return;
    for (const w of works) {
      if (WA.isWorkDone(this.workState, w.workid)) {
        this.log(`     [${wid}] ⏭ ${w.title} 已经做过，跳过`);
        continue;
      }
      // 考试/测验类考试绝不碰（挂了就是 0 分，而且一次机会）
      if (/exam|考试|测试/i.test(String(w.worktype || "") + " " + String(w.title || ""))) {
        this.log(`     [${wid}] ⏭ 跳过考试类任务点：${w.title}`);
        continue;
      }
      const d = w.defaults || {};
      const ctx = {
        courseid: d.courseid || info.courseId,
        clazzId: d.clazzId || info.clazzId,
        cpi: d.cpi || info.cpi,
        knowledgeid: d.knowledgeid || kid,
        workid: w.workid,
        workRelationId: "",
        jobid: w.jobid,
        enc: w.enc || "",
        ktoken: d.ktoken || "",
        userid: d.userid || "",
        title: w.title + (w.worktype === "workA" ? "（章节测验）" : ""),
      };
      this._setCurrent(wid, course, chapterLabel, "测验 " + w.title, 0, 0);
      try {
        const r = await this.workAgent.run(ctx, {
          rounds: this.cfg.workRounds,
          log: (l) => this.log(l),
        });
        this.stats.works = (this.stats.works || 0) + 1;
        if (r.state === "submitted" || r.state === "done") {
          WA.markWorkDone(this.workState, w.workid, {
            score: r.score,
            full: r.fullScore,
            ratio: r.ratio,
            title: w.title,
          });
          WA.saveState(this.workState);
        }
        if (r.state === "submitted") {
          this.workScores.push({ title: w.title, score: r.score, full: r.fullScore, ratio: r.ratio });
        } else if (r.state === "error") {
          this.log(`     [${wid}] ⚠ ${w.title}: ${r.note}`);
        }
      } catch (e) {
        // 风控/登录失效往上抛，其它错误只记录，别影响整章
        if (e && (e.expired || e.blocked)) throw e;
        this.log(`     [${wid}] ✖ ${w.title} 处理失败: ${e.message}`);
      }
      await sleep(800 + Math.floor(Math.random() * 800));
    }
  }

  /** 单个 worker：独立会话，循环领取章节任务（同一门课同时只允许 1 路，保证多课齐头并进） */
  async worker(wid, items, take) {
    let s = new Session({ cookie: this.s.cookie, onNetWait: this.s.onNetWait, proxy: this.s.proxy });
    let rep = new Reporter(s);
    let player = new Player(s, rep, {
      speed: 1,
      interval: this.cfg.reportInterval || 60,
      dryRun: !!this.cfg.dryRun,
      log: this.log.bind(this),
      quizAgent: this.quizAgent,
      humanizer: this.hz,
    });
    const courses = {};

    // 登录态失效 → 自动重登并用新会话重建
    const relogin = async () => {
      if (!this.cfg.relogin) throw new Error("登录已过期，请重新登录");
      this.log(`     [${wid}] 登录态失效，正在自动重新登录…`);
      const cookie = await this.cfg.relogin();
      this.s.cookie = cookie;
      s = new Session({ cookie, onNetWait: this.s.onNetWait, proxy: this.s.proxy });
      rep = new Reporter(s);
      player = new Player(s, rep, {
        speed: 1,
        interval: this.cfg.reportInterval || 60,
        dryRun: !!this.cfg.dryRun,
        log: this.log.bind(this),
        quizAgent: this.quizAgent,
        humanizer: this.hz,
      });
      Object.keys(courses).forEach((k) => delete courses[k]);
      this.log(`     [${wid}] 已重新登录，继续刷课`);
    };

    while (true) {
      const item = take();
      if (!item) break;
      if (item === "WAIT") { await sleep(4000); continue; }
      const { info, kid, title, idx, total } = item;
      // 拟人化：请求限速 + 章节间随机间隔
      await this.hz.beforeChapter();

      let chapterOk = false;
      try {
        let course = courses[info.courseId];
        if (!course) {
          course = new CourseData(s, info);
          await course.open();
          await course.getChapters();
          courses[info.courseId] = course;
        }

        this.stats.chapters++;
        this.log(`\n  ── [${wid}] ${info.title} [${idx}/${total}] ${title}`);

        // 扫描阶段已经拿到任务点了就直接用，省一次请求
        let preJobs = item.jobs || null;
        if (!preJobs) {
          try { preJobs = await course.getJobs(kid); } catch (e) { preJobs = null; }
        }
        const preVideos = this._videos(preJobs);
        const preWorks = this._works(preJobs);
        if (preVideos.length && preVideos.every((jj) => isVideoDone(jj)) && !this._pendingWorks(preWorks).length) {
          this.log(`     [${wid}] ✔ 整章已完成，跳过（${preVideos.length} 个视频）`);
          this.hz.refund(); // 没实际刷课，不占每小时额度
          continue;
        }

        try {
          await course.studyChapter(kid);
        } catch (e) {
          // 风控/登录失效必须抛出去走退避逻辑，否则会一路硬撞剩余全部章节
          if (e && (e.expired || e.blocked)) throw e;
          this.log(`     [${wid}] 学习会话失败: ${e.message}`);
          this.failedChapters.push({ info, kid, title });
          continue;
        }

        let jobs = [];
        try {
          jobs = preVideos.length ? preVideos : this._videos(await course.getJobs(kid));
        } catch (e) {
          if (e && (e.expired || e.blocked)) throw e;
          this.log(`     [${wid}] 任务点读取失败: ${e.message}`);
          this.failedChapters.push({ info, kid, title });
          continue;
        }
        if (!jobs.length) {
          this.log(`     [${wid}] 无视频任务点`);
          // 没有视频但有测验/作业也要做
          try {
            const js = this._works(preJobs) .length ? this._works(preJobs) : this._works(await course.getJobs(kid));
            if (js.length) await this.runWorks(course, wid, info, kid, js, `[${idx}/${total}] ${title}`);
          } catch (e) {
            if (e && (e.expired || e.blocked)) throw e;
            this.log(`     [${wid}] 测验任务读取失败: ${e.message}`);
          }
          chapterOk = true;
          this.hz.refund();
          continue;
        }

        let jobFail = 0;
        for (const job of jobs) {
          this.stats.videos++;
          // 拟人模式下一律 1x：倍速本身就是风控特征
          player.speed = !this.hz.enabled && job.doublespeed && Number(job.doublespeed) >= 1
            ? Math.max(2, this.cfg.speed || 2)
            : 1;
          this._setCurrent(wid, course, `[${idx}/${total}] ${title}`, job.name, 0, job.attDuration);
          try {
            const r = await player.play(course, job, (pt, dur) => {
              this._setCurrent(wid, course, `[${idx}/${total}] ${title}`, job.name, pt, dur);
            });
            const cp = this.courseProgress[info.courseId];
            if (r.isPassed || r.skipped) {
              this.stats.passed++;
              if (cp) cp.videosPassed++;
            } else {
              jobFail++;
              this.stats.skipped++;
              if (cp) cp.videosFailed++;
              this.log(`     [${wid}] ⚠ 未完成 ${r.playingTime}/${r.duration}`);
            }
            if (this.quizAgent) this.stats.quiz = this.quizAgent.stats.right;
          } catch (e) {
            if (e && (e.expired || e.blocked)) throw e;
            jobFail++;
            this.stats.failed++;
            this.log(`     [${wid}] ✖ 播放失败: ${e.message}`);
            this.failedChapters.push({ info, kid, title });
          }
        }
        chapterOk = jobFail === 0; // 本章所有视频都过了，才算这章完成

        // 视频刷完 → 接着做本章的章节测验 / 作业（交卷 + 按区间控分）
        try {
          const ws2 = this._works(preJobs).length
            ? this._works(preJobs)
            : this._works(await course.getJobs(kid));
          await this.runWorks(course, wid, info, kid, ws2, `[${idx}/${total}] ${title}`);
        } catch (e) {
          if (e && (e.expired || e.blocked)) throw e;
          this.log(`     [${wid}] 测验处理异常: ${e.message}`);
        }

        // 节奏控制：章节之间短停顿（主要间隔由 humanize.beforeChapter 控制）
        const gap = this.cfg.chapterDelay == null ? 1500 : Number(this.cfg.chapterDelay);
        if (gap > 0) await sleep(gap + Math.floor(Math.random() * 1500));
      } catch (e) {
        if (e && e.blocked) {
          // 风控可能是短时 IP 限流，先退避重试，连续多次才真正停止
          this.blockHits = (this.blockHits || 0) + 1;
          this.risk.blockHits = this.blockHits;
          this.risk.lastBlockAt = Date.now();
          this.risk.note = "被超星风控拦截";
          if (this.blockHits <= 3) {
            const waitMin = [15, 45, 90][this.blockHits - 1] || 90;
            this.risk.coolingUntil = Date.now() + waitMin * 60 * 1000;
            this.risk.note = `第 ${this.blockHits}/3 次拦截，冷却 ${waitMin} 分钟`;
            this.log(`\n⚠ [${wid}] 检测到风控拦截（第 ${this.blockHits}/3 次），暂停 ${waitMin} 分钟后再试…`);
            this.log("     提示：浏览器能打开说明可能只是短时限流，不一定是真封号。\n");
            await sleep(waitMin * 60 * 1000);
            this.risk.coolingUntil = 0;
            this.risk.note = "";
            items.unshift({ info, kid, title, idx, total });
          } else {
            this.blocked = true;
            this.risk.blocked = true;
            this.risk.coolingUntil = 0;
            this.risk.note = "连续拦截，已停止，请等 6~24 小时后重试";
            this.log(`\n████ 连续 ${this.blockHits} 次被风控拦截，已停止所有请求。`);
            this.log("     请用浏览器确认能否打开课程：能打开→稍后重启程序继续；不能→按话术联系客服。\n");
            this._busy = {};
            items.length = 0;
            return;
          }
        } else if (e && e.expired) {
          // 自动重登后把该章节放回队首重试
          try {
            await relogin();
            items.unshift({ info, kid, title, idx, total });
          } catch (e2) {
            if (e2 && e2.blocked) {
              this.blocked = true;
              this.risk.blocked = true;
              this.risk.lastBlockAt = Date.now();
              this.risk.note = "重新登录时被风控拦截";
              this.log(`\n████ 账号被风控拦截，已停止。请用浏览器验证后再试。\n`);
              items.length = 0;
              return;
            }
            this.log(`     [${wid}] ✖ 重新登录失败: ${e2.message}`);
            await sleep(60000);
            items.unshift({ info, kid, title, idx, total });
          }
        } else {
          this.log(`     [${wid}] ✖ ${e.message}`);
        }
      } finally {
        delete this.active[wid];
        this._release(info.courseId);
        const cp2 = this.courseProgress[info.courseId];
        if (cp2 && chapterOk) cp2.chaptersDone++;
        await this.hz.afterChapter();
      }
      await sleep(300);
    }
  }

  _release(courseId) {
    if (this._busy) delete this._busy[courseId];
  }

  async run() {
    let list = this.courseList.length ? this.courseList : await this.loadCourses();

    if (this.cfg.onlyCourse) {
      const only = Array.isArray(this.cfg.onlyCourse) ? this.cfg.onlyCourse : [this.cfg.onlyCourse];
      list = list.filter((c) => only.some((k) => c.courseId === k || c.title.indexOf(k) !== -1));
    }
    if (this.cfg.skipCourse) {
      // 中英文逗号、分号、换行都当分隔符，避免用户填「高等数学，人工智能」时整串被当成一个关键词
      const sk = String(this.cfg.skipCourse)
        .split(/[,，;；\n\r]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (sk.length) {
        const before = list.length;
        list = list.filter((c) => !sk.some((k) => c.courseId === k || c.title.indexOf(k) !== -1));
        if (before !== list.length) this.log(`  ⏭ 跳过课程设置生效：已排除 ${before - list.length} 门（${sk.join("、")}）`);
      }
    }

    if (!list.length) {
      throw new Error("所选课程匹配不到任何课程（可能课程已结束或列表已变化），请刷新页面重新选课");
    }

    this.stats.courses = list.length;
    this.ui.totalCourses = list.length;
    this.runStart = Date.now();
    this.log("\n================ 课程清单 ================");
    list.forEach((c, i) => this.log(`  ${String(i).padStart(2)}  ${c.title}  (courseId=${c.courseId})`));
    this.log("==========================================");
    this.log(`共 ${list.length} 门，并发 ${this.parallel} 路（服务端按视频分别记账，实测并发生效）\n`);

    // 预处理：拉取所有课程的章节，按课程分组
    const perCourse = [];
    const doneCourses = [];
    for (const info of list) {
      const course = new CourseData(this.s, info);
      try {
        await course.open();
        const chapters = await course.getChapters();
        const arr = [];
        let finished = 0;
        chapters.forEach((ch, i) => {
          if (ch.jobCount === 0) return;
          // 页面已标"已完成"的章节直接跳过，不建学习会话、不探测任务点
          if (ch.finished) { finished++; return; }
          arr.push({ info, kid: ch.kid, title: ch.title, idx: i + 1, total: chapters.length });
        });
        const total = chapters.filter((ch) => ch.jobCount !== 0).length;

        // ② 快速扫描：先弄清每章到底还有没有要刷的视频，避免"跳过也要等节奏"
        //    这一步只用很短的间隔读任务点，不建学习会话、不占每小时额度。
        const arr2 = [];
        let scannedDone = 0;
        if (arr.length) {
          this.log(`  ${info.title}: 开始扫描 ${arr.length} 个待定章节…`);
          const gapMin = this.cfg.scanDelay == null ? 700 : Number(this.cfg.scanDelay);
          for (let i = 0; i < arr.length; i++) {
            const it = arr[i];
            let jobs = null;
            try { jobs = await course.getJobs(it.kid); } catch (e) { jobs = null; }
            if (!jobs) {
              it.jobs = null;
              arr2.push(it); // 读不到就按"需要刷"处理，后面再确认
            } else {
              const vids = this._videos(jobs);
              const need = vids.filter((j) => !isVideoDone(j));
              const pendingW = this._pendingWorks(this._works(jobs));
              if (need.length === 0 && pendingW.length === 0) {
                scannedDone++;
              } else {
                it.jobs = jobs;
                arr2.push(it);
              }
            }
            if (this.stopped) break;
            await sleep(gapMin + Math.floor(Math.random() * Math.max(200, gapMin)));
            if ((i + 1) % 25 === 0) this.log(`     已扫描 ${i + 1}/${arr.length}，发现 ${arr2.length} 个待刷、${scannedDone} 个已完成`);
          }
        }
        finished += scannedDone;

        this.log(
          `  ${info.title}: ${chapters.length} 章节，已完成 ${finished}，待刷 ${arr2.length}` +
          (arr2.length === 0 ? "　→ 整门已完成，跳过 ✔" : "")
        );
        this.courseProgress[info.courseId] = {
          courseId: info.courseId,
          title: info.title,
          chaptersTotal: chapters.length,
          chaptersPending: total,
          chaptersDone: finished,
          videosPassed: 0,
          videosFailed: 0,
        };
        if (arr2.length === 0) {
          doneCourses.push(info.title);
          continue; // 整门课都刷完了，不排进队列
        }
        perCourse.push(arr2);
      } catch (e) {
        this.log(`  ✖ ${info.title} 章节拉取失败: ${e.message}`);
      }
    }

    // 轮转交错：各课交替排队，保证多门课同时推进（否则会一门一门刷）
    const items = [];
    let maxLen = 0;
    perCourse.forEach((a) => (maxLen = Math.max(maxLen, a.length)));
    for (let i = 0; i < maxLen; i++) {
      for (const a of perCourse) {
        if (i < a.length) items.push(a[i]);
      }
    }
    if (doneCourses.length) {
      this.log(`\n✔ 整门已完成 ${doneCourses.length} 门，直接跳过：${doneCourses.join("、")}`);
    }
    if (!items.length) {
      this.log("\n所有选中的课程都已经刷完，没有需要处理的章节。");
      this.stats.courses = list.length;
      return this.stats;
    }
    this.log(`\n待处理章节: ${items.length} 个（${perCourse.length} 门课轮转交错），并发 ${this.parallel} 路…\n`);

    let cursor = 0;
    const taken = new Set();
    this._busy = {};
    // 领取策略：轮转顺序里挑第一门「当前没有其它 worker 在刷」的课
    const take = () => {
      if (this.stopped) return null;
      // 刷课时段检查（只允许在设定时间段内刷）
      const bs = this.brushStart, be = this.brushEnd;
      if (bs != null && be != null && !(bs === 0 && be === 24)) {
        const now = new Date();
        const h = now.getHours() + now.getMinutes() / 60;
        const inWindow = bs < be ? h >= bs && h < be : h >= bs || h < be;
        if (!inWindow) {
          if (!this.windowNotified || Date.now() - this.windowNotified > 600000) {
            this.windowNotified = Date.now();
            this.log(`\n⏰ 当前不在刷课时段（${bs}:00 ~ ${be}:00），暂停等待…`);
          }
          return "WAIT";
        }
      }
      // 每日限量检查
      if (this.dailyHours > 0 && this.runStart) {
        const usedH = (Date.now() - this.runStart) / 3600000;
        if (usedH >= this.dailyHours) {
          if (!this.limitReached) {
            this.limitReached = true;
            this.log(`\n████ 已达每日限量 ${this.dailyHours} 小时，自动停止（防风控）。`);
            this.log("     明天再启动即可，进度不丢。\n");
          }
          return null;
        }
      }
      for (let i = 0; i < items.length; i++) {
        if (taken.has(i)) continue;
        const it = items[i];
        if (this._busy[it.info.courseId]) continue;
        taken.add(i);
        this._busy[it.info.courseId] = true;
        return it;
      }
      // 还有没做完的，但课程都被占着 → 等
      if (taken.size < items.length) return "WAIT";
      return null;
    };
    // 先等进活跃时段，再热身，最后才发第一个请求（登录即开刷是明显机器特征）
    await this.hz.waitActiveWindow();
    await this.hz.warmup();

    const workers = [];
    for (let w = 0; w < this.parallel; w++) workers.push(this.worker(w + 1, items, take));
    await Promise.all(workers);

    // 补刷失败章节
    if (this.failedChapters.length && !this._retried) {
      this._retried = true;
      const uniq = [];
      const seen = new Set();
      for (const f of this.failedChapters) {
        const k = f.info.courseId + ":" + f.kid;
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(f);
      }
      this.failedChapters = [];
      if (uniq.length) {
        this.log(`\n████ 补刷 ${uniq.length} 个失败章节`);
        let c2 = 0;
        const take2 = () => (c2 < uniq.length ? uniq[c2++] : null);
        const ws = [];
        for (let w = 0; w < Math.min(this.parallel, uniq.length); w++) {
          ws.push((async (wid) => {
            const s = new Session({ cookie: this.s.cookie, onNetWait: this.s.onNetWait });
            const rep = new Reporter(s);
            const player = new Player(s, rep, {
              speed: 1, interval: this.cfg.reportInterval || 60,
              dryRun: !!this.cfg.dryRun, log: this.log.bind(this), quizAgent: this.quizAgent,
              humanizer: this.hz,
            });
            const courses = {};
            let it;
            while ((it = take2())) {
              try {
                let course = courses[it.info.courseId];
                if (!course) { course = new CourseData(s, it.info); await course.open(); await course.getChapters(); courses[it.info.courseId] = course; }
                await course.studyChapter(it.kid);
                const allJobs = await course.getJobs(it.kid);
                const jobs = this._videos(allJobs);
                for (const job of jobs) {
                  this.stats.videos++;
                  player.speed = !this.hz.enabled && job.doublespeed && Number(job.doublespeed) >= 1 ? 2 : 1;
                  const r = await player.play(course, job, (pt, dur) => this._setCurrent(wid, course, "[补刷] " + it.title, job.name, pt, dur));
                  if (r.isPassed || r.skipped) this.stats.passed++; else this.stats.skipped++;
                }
                // 补刷阶段同样补做章节测验
                await this.runWorks(course, wid, it.info, it.kid, this._works(allJobs), "[补刷] " + it.title);
              } catch (e) {
                // 补刷阶段遇到风控必须立刻停，否则又是一轮硬撞
                if (e && e.blocked) {
                  this.blocked = true;
                  this.log(`     [补刷${wid}] ✖ 风控拦截，停止补刷`);
                  break;
                }
                this.stats.failed++;
                this.log(`     [补刷${wid}] ✖ ${e.message}`);
              }
              const gap2 = this.cfg.chapterDelay == null ? 1500 : Number(this.cfg.chapterDelay);
              if (gap2 > 0) await sleep(gap2 + Math.floor(Math.random() * 1500));
            }
          })(w + 1));
        }
        await Promise.all(ws);
      }
    }

    this.log("\n================ 完成统计 ================");
    this.log(`  课程: ${this.stats.courses}   章节: ${this.stats.chapters}`);
    this.log(`  视频: ${this.stats.videos}   已完成: ${this.stats.passed}   未完成: ${this.stats.skipped}   失败: ${this.stats.failed}`);
    if (this.quizAgent) this.log(`  弹题: 共 ${this.quizAgent.stats.total} 题，答对 ${this.quizAgent.stats.right}`);
    if (this.stats.works) {
      this.log(`  测验/作业: 共处理 ${this.stats.works} 个（目标正确率 ${this.workAgent ? this.workAgent.accuracy.min + "-" + this.workAgent.accuracy.max + "%" : "-"}）`);
      for (const w of this.workScores) {
        this.log(`     ${w.title}: ${w.score == null ? "?" : w.score}/${w.full} (${w.ratio == null ? "?" : w.ratio}%)`);
      }
    }
    this.log("==========================================");
    return this.stats;
  }
}

module.exports = CourseTask;
