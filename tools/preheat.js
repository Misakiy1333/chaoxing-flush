/**
 * 开课前预热：把某门课所有章节测验题先拉下来批量预答，写进题库，不交卷。
 *
 * 好处：
 *   1) 刷课时零等待（题目答案已经在库里）
 *   2) 提前暴露"这门课题库覆盖率 0"，用户能及早决定要不要开自动答题
 *   3) 模型调用集中，不必边刷边建连接
 *
 * 用法（本地）:
 *   node tools/preheat.js                → 预热所有课
 *   node tools/preheat.js <课程名片段>    → 只预热匹配的课
 *   node tools/preheat.js --dry          → 只统计，不写题库
 */
const path = require("path");
const fs = require("fs");
const A = require(path.join(__dirname, "..", "answerer.js"));
const WA = require(path.join(__dirname, "..", "workAgent.js"));
const { WorkAgent } = WA;

/**
 * 预热引擎：不依赖浏览器、不交卷，只读题 + 求解 + 入库。
 *
 * 请求节奏很重要：逐章拉任务点是密集请求，太快会触发超星风控
 * （表现为「账号被学习通风控拦截（访问异常）」）。
 * 所以这里内置限速 + 风控退避，宁可慢也不被封。
 */
class Preheater {
  constructor(opts) {
    opts = opts || {};
    this.session = opts.session;
    this.courseTask = opts.courseTask;
    this.provider = opts.provider;
    this.log = opts.log || (() => {});
    this.dry = !!opts.dry;

    // 节奏参数（毫秒）：每章间隔、每次测验间隔、风控后的冷却
    this.chapterGap = opts.chapterGap == null ? 2500 : opts.chapterGap;
    this.workGap = opts.workGap == null ? 1200 : opts.workGap;
    this.riskCooldown = opts.riskCooldown == null ? 120000 : opts.riskCooldown; // 2 分钟
    this.maxRisk = opts.maxRisk == null ? 2 : opts.maxRisk;  // 连续风控几次就彻底停

    this._riskHits = 0;
    this.stopped = false;

    this.stats = {
      courses: 0, works: 0, worksDone: 0, worksSkipped: 0,
      questions: 0, fromBank: 0, fromProvider: 0, unknown: 0, errors: 0, risks: 0,
    };
    this.detail = [];   // 每个测验的覆盖率
  }

  _sleep(ms) {
    return new Promise((y) => setTimeout(y, ms));
  }

  /** 检测是不是风控异常 */
  _isRisk(e) {
    const m = String((e && e.message) || e || "");
    return /风控|访问异常|antispider|blocked/i.test(m);
  }

  /** 遇到风控：冷却后允许再试，连续多次则彻底停止 */
  async _onRisk(err) {
    this.stats.risks++;
    this._riskHits++;
    this.log(`  ⚠ 触发风控（第 ${this._riskHits} 次）: ${(err && err.message) || err}`);
    if (this._riskHits >= this.maxRisk) {
      this.stopped = true;
      this.log(`  ✖ 连续风控 ${this._riskHits} 次，本次预热停止。`);
      this.log(`    建议：过 1~2 小时再试，或减少课程范围（node tools/preheat.js 课程名）`);
      return;
    }
    this.log(`    冷却 ${Math.round(this.riskCooldown / 1000)} 秒后继续…`);
    await this._sleep(this.riskCooldown);
  }

  /** 预热一门课：遍历所有章节，把章节测验/作业的题先答一遍（不交卷） */
  async course(course) {
    const ct = this.courseTask;
    if (!ct || !ct.workAgent) return;
    if (this.stopped) return;
    this.stats.courses++;

    // 课程对象上没有 works，必须逐章拉任务点（和 courseTask.run() 里的用法一致）
    let chapters = [];
    try {
      chapters = await course.getChapters();
    } catch (e) {
      if (this._isRisk(e)) { await this._onRisk(e); return; }
      this.stats.errors++;
      this.log(`  ✖ 拉章节失败: ${e.message}`);
      return;
    }
    if (!Array.isArray(chapters)) chapters = (chapters && chapters.chapters) || [];
    this.log(`  共 ${chapters.length} 章`);

    for (const ch of chapters) {
      if (this.stopped) return;
      // 章节对象的 id 字段名是 kid（course.js getChapters 返回 { kid, title, jobCount, finished }）
      const kid = ch.kid || ch.id || ch.knowledgeid || ch.knowledgeId || "";
      if (!kid) continue;
      let jobs = ch.jobs || null;
      if (!jobs) {
        try {
          jobs = await course.getJobs(kid);
        } catch (e) {
          if (this._isRisk(e)) { await this._onRisk(e); return; }
          jobs = null;
        }
        // 每章之间歇一下，横向请求太快最容易触发风控
        if (this.chapterGap) await this._sleep(this.chapterGap);
      }
      if (!jobs) continue;
      const works = ct._works(jobs);
      if (!works || !works.length) continue;

      for (const w of works) {
        if (this.stopped) return;
        if (WA.isWorkDone(ct.workState, w.workid)) { this.stats.worksSkipped++; continue; }
        try {
          await this._oneWork(course, Object.assign({}, w, { knowledgeid: w.knowledgeid || kid }));
        } catch (e) {
          if (this._isRisk(e)) { await this._onRisk(e); return; }
          this.stats.errors++;
          this.log(`  ✖ ${w.title || w.workid}: ${e.message}`);
        }
        if (this.workGap) await this._sleep(this.workGap);
      }
    }
  }

  async _oneWork(course, w) {
    const wa = this.courseTask.workAgent;
    const ctx = {
      courseid: course.cid || course.courseId || course.courseid,
      clazzId: course.cz || course.clazzId,
      cpi: course.cpi,
      knowledgeid: w.knowledgeid || "",
      workid: w.workid,
      jobid: w.jobid,
      enc: w.enc || "",
      ktoken: course.ktoken || "",
      userid: this.courseTask.userid || "",
    };
    const r = await wa.fetch(ctx);
    const page = WorkAgent.parsePage(r.html);
    if (page.state !== "editable" || !page.questions || !page.questions.length) {
      this.stats.worksSkipped++;
      return;
    }
    this.stats.works++;
    let hit = 0, missed = 0;

    for (const q of page.questions) {
      this.stats.questions++;
      // ① 本地/云端题库先查
      const local = A.solve(this.courseTask.bank || A.emptyBank(), {
        type: Number(q.type), title: q.title, options: q.options || {},
      });
      if (local && local.answer && local.confidence >= 0.7) {
        this.stats.fromBank++;
        hit++;
        continue;
      }
      // ② 问答题源（云端题库 → 外部题库 → 大模型）
      if (!this.provider) { this.stats.unknown++; missed++; continue; }
      const got = await this.provider.resolve({
        type: Number(q.type), title: q.title, options: q.options || {},
      });
      if (got && got.answer) {
        this.stats.fromProvider++;
        hit++;
        // 写进题库（不覆盖已确认答案）
        try {
          const e = A.entryOf(this.courseTask.bank, q.title);
          if (!e.correct) {
            e.type = Number(q.type);
            if (q.options && Object.keys(q.options).length) A.rememberOptions(this.courseTask.bank, q.title, q.options);
            e.guess = got.answer;
            e.guessConf = got.confidence || 0.8;
            e.preheated = true;
            e.updatedAt = Date.now();
          }
        } catch (err) {}
      } else {
        this.stats.unknown++;
        missed++;
      }
    }

    this.stats.worksDone++;
    const cov = page.questions.length ? (hit / page.questions.length * 100).toFixed(0) : "0";
    this.detail.push({
      course: course.title,
      work: w.title || w.workid,
      total: page.questions.length,
      hit, missed, coverage: Number(cov),
    });
    this.log(`  ${w.title || w.workid}: ${page.questions.length} 题，有答案 ${hit} 题（覆盖 ${cov}%）`);
  }

  report() {
    const s = this.stats;
    const lines = [];
    lines.push("========== 预热结果 ==========");
    lines.push(`课程:       ${s.courses}`);
    lines.push(`可做题测验: ${s.works}（跳过已完成 ${s.worksSkipped}）`);
    lines.push(`题目总数:   ${s.questions}`);
    lines.push(`题库命中:   ${s.fromBank}`);
    lines.push(`问答题源:   ${s.fromProvider}`);
    lines.push(`仍未知:     ${s.unknown}`);
    if (s.errors) lines.push(`出错:       ${s.errors}`);
    if (s.risks) lines.push(`风控:       ${s.risks} 次${this.stopped ? "（已停止）" : ""}`);
    if (s.questions) {
      const cov = ((s.fromBank + s.fromProvider) / s.questions * 100).toFixed(1);
      lines.push("");
      lines.push(`总体可答率: ${cov}%`);
      lines.push(cov >= 70 ? "→ 覆盖率不错，可以放心开自动答题"
        : cov >= 40 ? "→ 覆盖率一般，开了会有相当多错题"
        : "→ 覆盖率很低，开了大概率低分");
    }
    if (this.detail.length) {
      lines.push("");
      lines.push("按测验:");
      const sorted = this.detail.slice().sort((a, b) => a.coverage - b.coverage);
      for (const d of sorted) {
        lines.push(`  ${String(d.coverage).padStart(3)}%  ${d.total}题  ${d.course} / ${d.work}`);
      }
    }
    return lines.join("\n");
  }
}

module.exports = { Preheater };

/* ---------- 命令行入口 ---------- */
if (require.main === module) {
  (async () => {
    const Session = require(path.join(__dirname, "..", "session.js"));
    const CourseData = require(path.join(__dirname, "..", "course.js"));
    const CourseTask = require(path.join(__dirname, "..", "courseTask.js"));
    const AP = require(path.join(__dirname, "..", "answerProvider.js"));
    const argv = process.argv.slice(2);
    const dry = argv.includes("--dry");
    const filter = argv.find((a) => !a.startsWith("--")) || "";

    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
    if (!cfg.saveCookie) {
      console.error("config.json 里没有登录 cookie，先在主程序里登录一次");
      process.exit(1);
    }

    // Session 直接用 cookie 构造（和 local-server 一样），没有独立登录方法
    const s = new Session({ cookie: cfg.saveCookie, debug: false, proxy: cfg.proxy || "" });

    const bank = A.loadBank();
    const provider = new AP.AnswerProvider({
      bank,
      shared: cfg.sharedBankUrl ? { enabled: true, url: cfg.sharedBankUrl, key: cfg.sharedBankKey || "shared" } : { enabled: false },
      remote: cfg.answerRemoteUrl ? { enabled: true, url: cfg.answerRemoteUrl, token: cfg.answerRemoteToken || "" } : { enabled: false },
      llm: cfg.llmEnabled && cfg.llmApiKey ? {
        enabled: true, baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey,
        model: cfg.llmModel, maxTokens: cfg.llmMaxTokens || 800,
      } : { enabled: false },
    });

    // 云端题库（本地版先从云端拉一批，命中率会高很多）
    if (provider.refreshShared) {
      try { await provider.refreshShared(true); } catch (e) {}
    }

    const ct = new CourseTask(s, Object.assign({}, cfg, { bank, log: () => {} }));
    let courses = [];
    try {
      courses = await CourseData.list(s, { courseType: 1 });
    } catch (e) {
      console.error("拉课程列表失败: " + e.message);
      process.exit(1);
    }
    const list = filter ? courses.filter((c) => String(c.title || "").includes(filter)) : courses;
    if (!list.length) { console.log("没有匹配的课程（共 " + courses.length + " 门）"); process.exit(0); }

    console.log("待预热课程: " + list.length + " 门" + (dry ? "（dry-run，不写题库）" : ""));
    // --fast 把间隔压短（自己承担风控风险），--slow 更保守
    const fast = argv.includes("--fast");
    const slow = argv.includes("--slow");
    const ph = new Preheater({
      session: s, courseTask: ct, provider, dry, log: console.log,
      chapterGap: fast ? 800 : slow ? 6000 : 2500,
      workGap: fast ? 400 : slow ? 2500 : 1200,
      riskCooldown: fast ? 60000 : slow ? 300000 : 120000,
    });
    for (const info of list) {
      // list() 返回的是纯数据，必须包成 CourseData 才有 getChapters / getJobs
      const course = info && typeof info.getChapters === "function" ? info : new CourseData(s, info);
      console.log("\n【" + (course.title || "") + "】");
      await ph.course(course);
    }
    console.log("\n" + ph.report());
    if (!dry) { A.saveBank(bank); console.log("\n题库已保存到 " + A.BANK_FILE); }
    process.exit(0);
  })().catch((e) => { console.error("预热失败: " + e.message); process.exit(1); });
}
