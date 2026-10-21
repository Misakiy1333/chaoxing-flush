/**
 * 拟人化调度（Humanizer）
 *
 * 目的：除了出口 IP 之外，把所有能被风控识别的「机器特征」压到最低。
 *
 * 覆盖的风险点：
 *   1. 请求爆发        → 章节间隔随机 8~20 秒 + 每小时上限
 *   2. 连续不停歇      → 每 12 个章节一次 1~3 分钟小憩
 *   3. 连续作战过久    → 每 55 分钟一次 5~15 分钟休息
 *   4. 作息不自然      → 只在 07:00~23:00 干活，其余时间待机（按北京时间）
 *   5. 登录即操作      → 启动前随机热身 5~30 秒
 *   6. 弹题秒答        → 每题延迟 8~25 秒才提交，选项试探间隔 3~8 秒
 *   7. 完美顺序/零抖动 → 所有等待都带随机抖动
 *
 * 所有等待都是可中断的：调用 stop() 后 1 秒内退出。
 */

const realSleep = (t) => new Promise((y) => setTimeout(y, t));
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));

/** 取北京时间的小时（服务器可能是 UTC 时区） */
function hourCST() {
  return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
}
function minuteCST() {
  return new Date(Date.now() + 8 * 3600 * 1000).getUTCMinutes();
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 可中断的分段睡眠 */
async function chunkSleep(ms, isStopped) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isStopped && isStopped()) return;
    await realSleep(Math.min(1000, Math.max(0, end - Date.now())));
  }
}

/** 每小时请求上限 */
class RateLimiter {
  constructor(maxPerHour, log, isStopped, maxWaitMs) {
    this.max = Math.max(1, maxPerHour || 120);
    this.stamps = [];
    this.log = log || (() => {});
    this.isStopped = isStopped || (() => false);
    this.maxWaitMs = maxWaitMs || 5 * 60 * 1000; // 最多等 5 分钟，超了就放行
  }
  async take() {
    for (;;) {
      if (this.isStopped()) return false;
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 3600 * 1000);
      if (this.stamps.length < this.max) {
        this.stamps.push(now);
        return true;
      }
      const rawWait = this.stamps[0] + 3600 * 1000 - now + randInt(2000, 15000);
      if (rawWait > this.maxWaitMs) {
        // 要等太久了：只等一小段就把最老的记录清掉放行，避免卡几十分钟
        this.log(`   ⏳ [节奏] 接近每小时 ${this.max} 章上限，最多等 ${Math.round(this.maxWaitMs / 60000)} 分钟就继续`);
        await chunkSleep(this.maxWaitMs, this.isStopped);
        this.stamps.shift();
      } else {
        this.log(`   ⏳ [节奏] 已达每小时 ${this.max} 个章节上限，等 ${(rawWait / 60000).toFixed(1)} 分钟`);
        await chunkSleep(rawWait, this.isStopped);
      }
    }
  }
  /** 本章其实没干活（整章已完成等），把刚占用的额度退回 */
  refund() {
    if (this.stamps.length) this.stamps.pop();
  }
}

class Humanizer {
  constructor(cfg) {
    cfg = cfg || {};
    this.log = cfg.log || (() => {});
    this.enabled = cfg.humanMode !== false && String(cfg.humanMode) !== "false";
    this.stopped = false;

    // 作息窗口（北京时间，左闭右开）；0~24 表示不限时段
    this.activeStart = num(cfg.activeStart, 0);
    this.activeEnd = num(cfg.activeEnd, 24);

    // 章节间隔
    this.gapMinMs = num(cfg.chapterGapMin, 3) * 1000;
    this.gapMaxMs = num(cfg.chapterGapMax, 8) * 1000;

    // 小憩
    this.microEvery = num(cfg.microBreakEvery, 20);
    this.microMinMs = num(cfg.microBreakMin, 0.5) * 60 * 1000;
    this.microMaxMs = num(cfg.microBreakMax, 1.5) * 60 * 1000;

    // 长休
    this.longAfterMs = num(cfg.sessionBreakAfterMin, 90) * 60 * 1000;
    this.longMinMs = num(cfg.sessionBreakMin, 2) * 60 * 1000;
    this.longMaxMs = num(cfg.sessionBreakMax, 5) * 60 * 1000;

    // 弹题
    this.quizMinMs = num(cfg.quizDelayMin, 3) * 1000;
    this.quizMaxMs = num(cfg.quizDelayMax, 8) * 1000;
    this.quizTryMinMs = num(cfg.quizTryMin, 1.5) * 1000;
    this.quizTryMaxMs = num(cfg.quizTryMax, 4) * 1000;

    this.maxPerHour = num(cfg.maxChaptersPerHour, 120);
    this.maxWaitMs = num(cfg.maxWaitMin, 5) * 60 * 1000;
    this.limiter = new RateLimiter(this.maxPerHour, this.log, () => this.stopped, this.maxWaitMs);

    this.chapterCount = 0;
    this.startedAt = Date.now();
    this.lastLongBreak = Date.now();
  }

  stop() { this.stopped = true; }
  /** 本章没有实际刷课（整章已完成/无任务点），不收额度 */
  refund() { try { this.limiter.refund(); } catch (e) {} }
  _sleep(ms) { return chunkSleep(ms, () => this.stopped); }

  /** 启动热身：别一登录就发请求 */
  async warmup() {
    if (!this.enabled) return;
    const t = randInt(2, 6) * 1000;
    this.log(`   🌤 热身 ${Math.round(t / 1000)} 秒后开始`);
    await this._sleep(t);
  }

  /** 等到作息窗口内 */
  async waitActiveWindow() {
    if (!this.enabled) return;
    for (;;) {
      if (this.stopped) return;
      const h = hourCST();
      const inWindow =
        this.activeStart <= this.activeEnd
          ? h >= this.activeStart && h < this.activeEnd
          : h >= this.activeStart || h < this.activeEnd;
      if (inWindow) return;

      let waitH = (this.activeStart - h + 24) % 24;
      if (waitH === 0) waitH = 24;
      const waitMs = waitH * 3600 * 1000 - minuteCST() * 60 * 1000 + randInt(0, 600) * 1000;
      this.log(
        `   🌙 当前北京时间 ${String(h).padStart(2, "0")}:${String(minuteCST()).padStart(2, "0")}，` +
        `不在 ${this.activeStart}:00~${this.activeEnd}:00 活跃时段，待机 ${(waitMs / 3600000).toFixed(1)} 小时后继续`
      );
      await this._sleep(waitMs);
    }
  }

  /** 每个章节开始前 */
  async beforeChapter() {
    if (!this.enabled) return;
    const got = await this.limiter.take();
    if (!got) return;
    await this._sleep(randInt(this.gapMinMs, this.gapMaxMs));
  }

  /** 每个章节结束后：小憩 + 长休 */
  async afterChapter() {
    if (!this.enabled || this.stopped) return;
    this.chapterCount++;

    if (this.microEvery > 0 && this.chapterCount % this.microEvery === 0) {
      const t = randInt(this.microMinMs, this.microMaxMs);
      this.log(`   ☕ 已连续 ${this.chapterCount} 个章节，休息 ${(t / 60000).toFixed(1)} 分钟`);
      await this._sleep(t);
      if (this.stopped) return;
    }

    if (Date.now() - this.lastLongBreak > this.longAfterMs) {
      const t = randInt(this.longMinMs, this.longMaxMs);
      this.log(`   🛋 已连续工作 ${Math.round((Date.now() - this.lastLongBreak) / 60000)} 分钟，长休 ${Math.round(t / 60000)} 分钟`);
      await this._sleep(t);
      this.lastLongBreak = Date.now();
    }
  }

  /** 通用拟人停顿（毫秒）：章节测验/作业里"读题、检查、等成绩"都走这里 */
  async think(ms, label) {
    if (!this.enabled || this.stopped) return;
    const t = Math.max(0, Math.round(ms));
    if (t < 300) return;
    if (label) this.log(`   💭 ${label} ${(t / 1000).toFixed(1)} 秒`);
    await this._sleep(t);
  }

  /** 弹题作答前的思考时间 */
  async beforeQuiz() {
    if (!this.enabled) return;
    const t = randInt(this.quizMinMs, this.quizMaxMs);
    this.log(`   💭 弹题思考 ${(t / 1000).toFixed(0)} 秒`);
    await this._sleep(t);
  }

  /** 弹题选项试探之间的间隔 */
  async betweenQuizTry() {
    if (!this.enabled) return;
    await this._sleep(randInt(this.quizTryMinMs, this.quizTryMaxMs));
  }

  /** 视频播放中的偶尔暂停（像真人切出去看一眼） */
  shouldPause() {
    return this.enabled && !this.stopped && Math.random() < 0.25;
  }
  async pauseLikeHuman() {
    const t = randInt(4, 25) * 1000;
    await this._sleep(t);
    return t;
  }
}

module.exports = { Humanizer, RateLimiter, hourCST, minuteCST, rand, randInt };
