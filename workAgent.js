/**
 * 章节测验 / 作业 全自动作答（手机端协议）
 *
 * 链路（已在真实账号上验证通过）：
 *   1) GET  https://mooc1-api.chaoxing.com/android/mworkspecial?courseid&workid&jobid&needRedirect=true
 *           &knowledgeid&userid&ut=s&clazzId&cpi&ktoken&enc        （手机 UA，跟随 302）
 *        → 未作答：页面是答题页，含 form#form1（workAnswerId / totalQuestionNum /
 *          fullScore / workRelationId / enc_work）+ div.Py-mian1 题目节点
 *        → 已作答：页面标题「已批阅」，只有批阅结果，没有 form
 *   2) POST <form#form1 的 action>   （表单字段见 buildSubmitBody）
 *        → {"msg":"success!","stuStatus":4,"status":true}
 *   3) GET  https://mooc1.chaoxing.com/mooc-ans/work/record-detail?courseId&classId&workId
 *           &workAnswerId&times=1&cpi&ut=s&...                     （workId 传 workRelationId）
 *        → 每题：我的答案 .myAnswer .answerCon、对错 .CorrectOrNot span[class=marking_*]、
 *          得分 .newAnswerScore .scoreNum；总分 本次成绩<i>N</i>
 *   4) 可选 GET /mooc-ans/work/retest?...&phone=true&wMicroNodeId=0 → {"status":true,"url":"..."}
 *        → 允许重做时拿到新一轮答卷（服务端可能拒绝：作答次数已用完）
 *
 * 正确率控制：见 accuracy.js —— 知道的题故意错几道，把总分压进用户设的区间。
 */
const cheerio = require("cheerio");
const A = require("./answerer.js");
const Acc = require("./accuracy.js");
const AP = require("./answerProvider.js");

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const HOST_MOBILE = "https://mooc1-api.chaoxing.com";
const HOST_PC = "https://mooc1.chaoxing.com";

/** 题型：0单选 1多选 2填空 3判断（简答等其它题型不碰） */
const SUPPORTED = { 0: "单选", 1: "多选", 2: "填空", 3: "判断" };

class WorkAgent {
  constructor(session, opts) {
    this.s = session;
    this.opts = opts || {};
    this.bank = (opts && opts.bank) || A.loadBank(opts && opts.bankFile);
    this.bankFile = (opts && opts.bankFile) || A.BANK_FILE;
    this.accuracy = Acc.normalizeRange(opts && opts.accuracyMin, opts && opts.accuracyMax);
    this.log = (opts && opts.log) || console.log;
    this.hz = (opts && opts.humanizer) || null;
    this.seed = opts && opts.seed != null ? opts.seed : null;
    this.stats = { works: 0, submitted: 0, skipped: 0, failed: 0, scores: [] };
    // 在线答题源（外部题库接口 / 大模型），没配就只用本地题库
    if (opts && opts.provider) {
      this.provider = opts.provider;
    } else {
      this.provider = new AP.AnswerProvider({
        bank: this.bank,
        onSaved: () => this.saveBank(),
        log: this.log,
        remote: opts && opts.remote,
        llm: opts && opts.llm,
        shared: opts && opts.shared,
      });
    }
  }

  /** 保存题库（学习结果落盘） */
  saveBank() {
    return A.saveBank(this.bank, this.bankFile);
  }

  /**
   * 拉取一次作业/测验页面
   * @param {Object} ctx { courseid, clazzId, cpi, knowledgeid, workid, jobid, enc, ktoken, userid }
   */
  async fetch(ctx) {
    const params = new URLSearchParams({
      courseid: String(ctx.courseid),
      workid: String(ctx.workid),
      jobid: String(ctx.jobid),
      needRedirect: "true",
      knowledgeid: String(ctx.knowledgeid),
      userid: String(ctx.userid || ""),
      ut: "s",
      clazzId: String(ctx.clazzId),
      cpi: String(ctx.cpi),
      ktoken: String(ctx.ktoken || ""),
      enc: String(ctx.enc || ""),
    });
    const url = `${HOST_MOBILE}/android/mworkspecial?${params.toString()}`;
    const r = await this.s.req(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": MOBILE_UA, Accept: "*/*" },
    });
    return { url: r.url || url, html: r.text || "", status: r.status };
  }

  /**
   * 解析作业页
   * @returns {{state:"editable"|"done"|"error", title:string, form:Object, action:string,
   *            questions:Array, error:string}}
   */
  static parsePage(html) {
    const out = { state: "error", title: "", form: {}, action: "", questions: [], error: "" };
    const $ = cheerio.load(html || "");
    out.title = ((html || "").match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";

    // 错误提示
    const tips = $("p.blankTips").first().text().trim();
    if (tips) {
      out.error = tips;
      out.state = /已批阅|已完成/.test(out.title) ? "done" : "error";
      return out;
    }
    if (/已批阅|已完成|查看已批阅/.test(out.title)) {
      out.state = "done";
      out.doneHtml = html;
      return out;
    }

    const form = $("form#form1");
    if (!form.length) {
      out.error = "页面里没有答题表单（可能已被删除或教师未创建完成）";
      return out;
    }
    form.find("input").each((i, el) => {
      const name = $(el).attr("name") || $(el).attr("id");
      if (!name) return;
      out.form[name] = $(el).attr("value") || "";
    });
    out.action = form.attr("action") || "";

    $("div.Py-mian1").each((i, el) => {
      const $q = $(el);
      const at = $q.find("input[id^='answertype']").first();
      const id = (at.attr("id") || "").replace("answertype", "");
      if (!id) {
        // 兜底：从 name=questionId 隐藏域取
        const qid = $q.find("input[name='questionId']").first().attr("value");
        if (!qid) return;
      }
      const qid = id || ($q.find("input[name='questionId']").first().attr("value") || "");
      const type = String(at.attr("value") == null ? "" : at.attr("value"));
      const titleNode = $q.find("div.Py-m1-title").first();
      const rawTitle = titleNode.text().replace(/\s+/g, " ").trim();
      const typeLabel = ((rawTitle.match(/[【\[]\s*([\u4e00-\u9fa5]{1,3}题)\s*[】\]]/) || [])[1] || SUPPORTED[type] || "").trim();
      const q = {
        id: qid,
        type,
        typeLabel,
        rawTitle,
        title: A.cleanQuestion(rawTitle),
        options: {},
        blanks: [],
        savedAnswer: ($q.find("input.answerInput").first().attr("value") || "").trim(),
      };

      if (type === "0" || type === "1") {
        $q.find("li.more-choose-item").each((j, o) => {
          const $o = $(o);
          const key = ($o.find("em.choose-opt").first().attr("id-param") || "").trim();
          let text = $o.find("div.choose-desc").first().text().replace(/\s+/g, " ").trim();
          text = text.replace(new RegExp("^\\s*" + (key || "\\w") + "\\s*[.、．:：)）]?\\s*"), "");
          if (key) q.options[key] = text;
        });
      } else if (type === "2") {
        $q.find("ul.blankList2 > li").each((j, b) => {
          q.blanks.push({
            label: $(b).find("span").first().text().trim(),
            value: ($(b).find("input.blankInp2").first().attr("value") || "").trim(),
          });
        });
      } else if (type === "3") {
        // 判断题选项固定 A=对 B=错（页面通常不列 option 节点）
        q.options = { A: "对", B: "错" };
      }
      out.questions.push(q);
    });

    out.state = out.questions.length ? "editable" : "error";
    if (!out.questions.length) out.error = "答题页里没有解析到题目";
    return out;
  }

  /** 解析批阅结果页（record-detail / selectWorkQuestionYiPiYue） */
  static parseReview(html) {
    const $ = cheerio.load(html || "");
    const items = [];
    $("div.TiMu").each((i, el) => {
      const $q = $(el);
      const qid = ($q.attr("data") || ($q.attr("id") || "").replace(/^question/, "")).trim();
      // 题干：优先 .qtContent（题号在旁边的 <i> 里，不能带进来）
      let titleNode = $q.find(".qtContent").first();
      if (!titleNode.length) titleNode = $q.find(".Zy_TItle").first();
      if (!titleNode.length) titleNode = $q.find(".mark_name").first();
      const rawTitle = titleNode.text().replace(/\s+/g, " ").trim();
      const typeLabel = ($q.find(".newZy_TItle").first().text() || "").replace(/[【\]]/g, "").trim();
      const mark = ($q.find(".CorrectOrNot span").first().attr("class") || "").trim();
      const scoreTxt = $q.find(".newAnswerScore .scoreNum").first().text().trim();
      const mine = $q.find(".myAnswer .answerCon").first().text().replace(/\s+/g, " ").trim();
      const correct = $q.find(".correctAnswer .answerCon").first().text().replace(/\s+/g, " ").trim();
      items.push({
        id: qid,
        rawTitle,
        title: A.cleanQuestion(rawTitle),
        typeLabel,
        mark, // marking_dui / marking_bandui / marking_cuo
        score: parseFloat(scoreTxt) || 0,
        mine,
        correct,
      });
    });
    let score = null;
    const m = (html || "").match(/本次成绩\s*<i>\s*([\d.]+)\s*<\/i>/) ||
      (html || "").match(/本次成绩[^0-9]{0,20}([\d.]+)/);
    if (m) score = parseFloat(m[1]);
    return { score, items };
  }

  /** 组装交卷表单 */
  static buildSubmitBody(page, answers) {
    const f = page.form;
    const body = {
      pyFlag: "",
      courseId: f.courseId || "",
      classId: f.classId || "",
      api: f.api || "1",
      mooc: f.mooc || "0",
      workAnswerId: f.workAnswerId || "",
      totalQuestionNum: f.totalQuestionNum || "",
      fullScore: f.fullScore || "100.0",
      knowledgeid: f.knowledgeid || f.knowledgeId || "",
      oldSchoolId: "",
      oldWorkId: f.oldWorkId || "",
      jobid: f.jobid || "",
      workRelationId: f.workRelationId || "",
      enc_work: f.enc_work || "",
      isphone: "true",
      userId: f.userId || "",
      workTimesEnc: f.workTimesEnc || "",
      answerwqbid: page.questions.map((q) => q.id).join(","),
    };
    for (const q of page.questions) {
      const a = answers[q.id];
      body["answertype" + q.id] = q.type;
      if (q.type === "2") {
        const arr = Array.isArray(a) ? a : [a == null ? "" : String(a)];
        body["tiankongsize" + q.id] = String(arr.length || q.blanks.length || 1);
        const n = Math.max(arr.length, q.blanks.length || 1);
        for (let i = 0; i < n; i++) body["answer" + q.id + (i + 1)] = arr[i] == null ? "" : String(arr[i]);
      } else if (q.type === "3") {
        // 判断题：服务端要 true/false，交 A/B 会整卷"作业提交失败！"（实测）
        body["answer" + q.id] = WorkAgent.judgeValue(a);
      } else {
        body["answer" + q.id] = a == null ? "" : String(a);
      }
    }
    return body;
  }

  /**
   * 判断题答案 → 服务端要的 true/false
   * 接受字母(A/B)、中文(对/错)、true/false 本身
   */
  static judgeValue(a) {
    if (a == null || a === "") return "true"; // 空就按"对"，多数判断题为真
    const s = String(a).trim();
    if (/^true$/i.test(s)) return "true";
    if (/^false$/i.test(s)) return "false";
    const letter = s.toUpperCase();
    if (letter === "A") return "true";
    if (letter === "B") return "false";
    const b = A.toBool(s);
    if (b === true) return "true";
    if (b === false) return "false";
    return "true";
  }

  /** 交卷 */
  async submit(page, body) {
    const action = page.action || "";
    const url = action.startsWith("http")
      ? action
      : HOST_MOBILE + (action.startsWith("/") ? action : "/" + action);
    const r = await this.s.postForm(url, body, HOST_MOBILE + "/");
    let j = null;
    try {
      j = JSON.parse(r.text || "");
    } catch (e) {
      j = null;
    }
    return { status: r.status, json: j, text: r.text || "", ok: !!(j && j.status) };
  }

  /** 查询批阅结果 */
  async fetchReview(ctx, form) {
    const times = (form && form.times) || "1";
    const url =
      `${HOST_PC}/mooc-ans/work/record-detail?courseId=${encodeURIComponent(ctx.courseid)}` +
      `&classId=${encodeURIComponent(ctx.clazzId)}&workId=${encodeURIComponent(form.workRelationId || ctx.workRelationId || "")}` +
      `&workAnswerId=${encodeURIComponent(form.workAnswerId || "")}&times=${encodeURIComponent(times)}` +
      `&cpi=${encodeURIComponent(ctx.cpi)}&ut=s&isdisplaytable=0&firstHeader=2&isWork=false` +
      `&workSystem=0&api=1&archive=false&mooc2=1`;
    let r = await this.s.get(url, HOST_PC + "/");
    let parsed = WorkAgent.parseReview(r.text || "");
    if (!parsed.items.length) {
      // 兜底：走 api/work 的批阅页
      const ctx2 = {
        api: "1", workId: ctx.workid, jobid: ctx.jobid, originJobId: ctx.jobid,
        needRedirect: "true", skipHeader: "true", knowledgeid: ctx.knowledgeid,
        ktoken: ctx.ktoken, cpi: ctx.cpi, ut: "s", clazzId: ctx.clazzId, type: "",
        enc: ctx.enc, mooc2: "1", courseid: ctx.courseid,
      };
      const q = Object.keys(ctx2).map((k) => k + "=" + encodeURIComponent(ctx2[k])).join("&");
      const r2 = await this.s.req(`${HOST_PC}/mooc-ans/api/work?${q}`, { method: "GET", redirect: "follow" });
      parsed = WorkAgent.parseReview(r2.text || "");
    }
    return parsed;
  }

  /** 请求重做（服务端可能不允许） */
  async retest(ctx, form) {
    const params = new URLSearchParams({
      courseId: String(ctx.courseid),
      classId: String(ctx.clazzId),
      workId: String(form.workRelationId || ctx.workRelationId || ""),
      workAnswerId: String(form.workAnswerId || ""),
      knowledgeid: String(ctx.knowledgeid),
      jobid: String(ctx.jobid),
      originJobId: String(form.originJobId || ""),
      enc: String(ctx.enc),
      cpi: String(ctx.cpi),
      phone: "true",
      wMicroNodeId: "0",
    });
    const r = await this.s.req(`${HOST_MOBILE}/mooc-ans/work/retest?${params.toString()}`, {
      method: "GET",
      headers: {
        "User-Agent": MOBILE_UA,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    let j = null;
    try {
      j = JSON.parse(r.text || "");
    } catch (e) {
      j = null;
    }
    if (j && j.status && j.url) {
      const u = j.url.startsWith("http") ? j.url : HOST_MOBILE + (j.url.startsWith("/") ? j.url : "/" + j.url);
      const page = await this.s.req(u, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": MOBILE_UA, Accept: "*/*" },
      });
      return { ok: true, url: u, html: page.text || "" };
    }
    return { ok: false, msg: (j && j.msg) || "重做请求失败", json: j };
  }

  /** 拟人停顿：只有开了拟人模式才真的等，测试/关闭时立即返回 */
  async _pace(minSec, maxSec, label) {
    if (!this.hz || !this.hz.enabled || this.hz.stopped) return;
    const ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
    if (typeof this.hz.think === "function") await this.hz.think(ms, label);
    else await new Promise((x) => setTimeout(x, ms));
  }

  /**
   * 处理一个作业/测验任务点
   * @param {Object} ctx { courseid, clazzId, cpi, knowledgeid, workid, jobid, enc, ktoken, userid, title }
   * @param {Object} o   { rounds, log }
   */
  async run(ctx, o) {
    const opt = o || {};
    const log = opt.log || this.log;
    const maxRounds = Math.max(1, Math.min(3, Number(opt.rounds || this.opts.rounds || 2)));
    const res = {
      workid: ctx.workid,
      title: ctx.title || "",
      state: "unknown",
      rounds: 0,
      score: null,
      fullScore: null,
      ratio: null,
      target: null,
      learned: 0,
      note: "",
    };

    let round = 0;
    let cur = null;
    let fetchCtx = ctx;

    // 开跑前先同步一次云端题库（别的账号答过的题直接可用，省大模型调用）
    if (this.provider && this.provider.refreshShared) {
      try {
        const n = await this.provider.refreshShared(true);
        if (n) this.log(`     ☁ 云端题库新增 ${n} 条`);
      } catch (e) {}
    }

    // 点进测验要有个"翻页"的停顿，别一进章节就秒交
    await this._pace(5, 15, "打开测验");

    while (round < maxRounds) {
      round++;
      res.rounds = round;
      if (this.hz && this.hz.beforeQuiz) await this.hz.beforeQuiz();

      const got = await this.fetch(fetchCtx);
      const page = WorkAgent.parsePage(got.html);

      if (page.state === "done") {
        if (round === 1) {
          res.state = "done";
          res.note = "已作答过，跳过";
        }
        break;
      }
      if (page.state !== "editable") {
        res.state = "error";
        res.note = page.error || "页面状态异常";
        break;
      }
      cur = page;
      res.fullScore = parseFloat(page.form.fullScore) || 100;

      // ① 逐题求解（云端题库 → 外部题库 → 大模型），每题之间有"读题"停顿
      const solved = [];
      for (const q of page.questions) {
        await this._pace(2.5, 7, "读题");
        const s = A.solve(this.bank, { id: q.id, type: q.type, title: q.title, options: q.options });
        let answer = s.answer;
        let from = s.from;
        let confidence = s.confidence;
        // 本地没答案、或只有低置信度的常识猜测（判断题启发式）时，问问题库接口或大模型
        if ((!answer || confidence < 0.7) && this.provider && this.provider.online) {
          let r = null;
          try {
            r = await this.provider.resolve({ id: q.id, type: Number(q.type), title: q.title, options: q.options });
          } catch (e) {
            r = null;
          }
          if (r && r.answer) {
            answer = r.answer;
            from = r.from;
            confidence = r.confidence;
          }
        }
        solved.push({
          id: q.id,
          type: Number(q.type),
          answer,
          from,
          confidence,
          options: q.options,
          title: q.title,
          wrongOptions: this._wrongOptionsFor(q.title),
          guess: this._guessFor(q),
        });
      }

      // ② 分数线规划（已知题按区间故意错几道）
      const p = Acc.plan({
        questions: solved,
        fullScore: res.fullScore,
        min: this.accuracy.min,
        max: this.accuracy.max,
        seed: this.seed == null ? Date.now() % 0x7fffffff : (this.seed + round * 7919) % 0x7fffffff,
      });

      // ③ 没答案的题给个"像人猜"的答案（必须非空，否则多选可能报错）
      const answers = {};
      for (const q of page.questions) {
        let a = p.plan[q.id];
        if (a == null || a === "") a = this._guessFor(q);
        answers[q.id] = a;
      }

      log(
        `     📝 ${ctx.title || "测验"} 第${round}轮：${page.questions.length} 题` +
        `（已知 ${p.knownCount}，未知 ${p.unknownCount}），目标 ${p.target}%，${p.note}`
      );

      // ④ 交卷（交之前假装检查一遍答案）
      await this._pace(4, 12, "检查答案");
      const body = WorkAgent.buildSubmitBody(page, answers);
      const sub = await this.submit(page, body);
      if (!sub.ok) {
        res.state = "error";
        res.note = "交卷失败：" + ((sub.json && sub.json.msg) || String(sub.text).slice(0, 80));
        break;
      }
      this.stats.submitted++;
      if (this.hz && this.hz.betweenQuizTry) await this.hz.betweenQuizTry();

      // ⑤ 查分 + 学答案（交完先停一下再看成绩，别 0.1 秒就刷出来）
      await this._pace(6, 20, "等成绩");
      const rev = await this.fetchReview(fetchCtx, { workAnswerId: page.form.workAnswerId, workRelationId: page.form.workRelationId });
      if (rev && typeof rev.score === "number") res.score = rev.score;
      let learned = 0;
      if (rev && rev.items && rev.items.length) {
        for (const it of rev.items) {
          const q = page.questions.find((x) => String(x.id) === String(it.id)) ||
            page.questions.find((x) => A.similarity(x.title, it.title) > 0.7);
          if (!q) continue;
          const full = res.fullScore / page.questions.length;
          const ratio = full > 0 ? Math.min(1, it.score / full) : 0;
          A.learn(this.bank, q.title, Number(q.type), it.mine, it.mark, q.options, ratio);
          learned++;
        }
        this.saveBank();
        // 学到的东西立刻同步到云端共享题库，别的账号也能用上
        if (this.provider && this.provider.pullAndPush) await this.provider.pullAndPush();
        else if (this.provider && this.provider.pushShared) { try { await this.provider.pushShared(); } catch (e) {} }
      }
      res.learned += learned;
      res.ratio = res.fullScore ? Math.round(((res.score || 0) / res.fullScore) * 1000) / 10 : null;
      res.target = `${this.accuracy.min}~${this.accuracy.max}`;
      res.state = "submitted";
      log(
        `     📊 ${ctx.title || "测验"} 得分 ${res.score == null ? "?" : res.score}/${res.fullScore}` +
        `（${res.ratio == null ? "?" : res.ratio}%），目标区间 ${this.accuracy.min}-${this.accuracy.max}%` +
        (learned ? `，学到 ${learned} 题` : "")
      );
      this.stats.scores.push({ title: ctx.title, score: res.score, full: res.fullScore, ratio: res.ratio });

      const inRange =
        res.ratio != null && res.ratio >= this.accuracy.min - 0.5 && res.ratio <= this.accuracy.max + 0.5;
      if (inRange) {
        res.note = "已落在目标区间";
        break;
      }
      if (round >= maxRounds) {
        res.note = res.ratio != null && res.ratio > this.accuracy.max ? "高于目标区间（题量太粗，压不下来）" : "低于目标区间（题库还不足）";
        break;
      }
      // ⑥ 尝试重做：允许就再来一轮（题库已学，下一轮更准）
      const rt = await this.retest(fetchCtx, page.form);
      if (!rt.ok) {
        res.note = "服务端不允许重做：" + rt.msg;
        break;
      }
      log(`     🔁 ${ctx.title || "测验"} 允许重做，进入第 ${round + 1} 轮`);
      await new Promise((x) => setTimeout(x, 1200));
    }

    if (res.state === "error" || res.state === "unknown") {
      this.stats.failed++;
    } else if (res.state === "done") {
      this.stats.skipped++;
    }
    this.stats.works++;
    return res;
  }

  /** 题库里该题已确认的错误选项（给"故意答错"用） */
  _wrongOptionsFor(title) {
    const e = A.findEntry(this.bank, title);
    if (!e || !e.wrong) return [];
    return e.wrong.slice();
  }

  /** 未知题的"人类式猜测"：判断题偏"对"，选择题按题干哈希分散（全选 A 一眼就是机器） */
  _guessFor(q) {
    const type = String(q.type);
    const keys = Object.keys(q.options || {}).sort();
    if (type === "3") return A.judgeAnswerToLetter(true, { A: "对", B: "错" });
    if (type === "2") return (q.blanks || []).map(() => "").join(",") || "";
    if (!keys.length) return "";
    const h = WorkAgent._hash(String(q.title || "") + "|" + String(q.id || ""));
    if (type === "0") return keys[h % keys.length];
    // 多选：四选二最常见，按哈希挑两个不重复的
    const a = h % keys.length;
    const b = (a + 1 + (h >> 5) % (keys.length - 1)) % keys.length;
    if (b === a) return keys[a];
    return [keys[a], keys[b]].sort().join("");
  }

  /** 稳定哈希（同一道题每次猜同一个，重启也不变） */
  static _hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }
}

/* ------------------------------------------------------- 已做作业状态（避免重复交卷） */

const STATE_FILE = require("path").join(__dirname, "workstate.json");

function loadState(file) {
  try {
    return JSON.parse(require("fs").readFileSync(file || STATE_FILE, "utf8"));
  } catch (e) {
    return { v: 1, done: {} };
  }
}

function saveState(st, file) {
  try {
    require("fs").writeFileSync(file || STATE_FILE, JSON.stringify(st, null, 1), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

/** 本地记录：这个作业已经处理过（交过卷 / 服务端已批阅） */
function markWorkDone(st, workid, info) {
  if (!workid) return st;
  st.done[String(workid)] = Object.assign({ at: Date.now() }, info || {});
  return st;
}

function isWorkDone(st, workid) {
  return !!(st && st.done && st.done[String(workid)]);
}

module.exports = { WorkAgent, MOBILE_UA, SUPPORTED, loadState, saveState, markWorkDone, isWorkDone, STATE_FILE };