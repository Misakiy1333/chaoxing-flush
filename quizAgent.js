/**
 * 视频内弹题自动作答（与章节测验共用同一份题库 quizbank.json）
 *
 * 协议结论（已实测）：
 *   GET quiz-validation?classid=&objectid=&dtype=Video&eventid=<resourceId>&memberinfo=<mi>&answerContent=<选项名>
 *   → {status:true, isRight:true/false, msg:"通过"}
 *   isRight=false 也不挡播放，但答对会记进题库，后面章节测验/作业能直接复用。
 *
 * 作答策略：
 *   1) 题库（quizbank.json，与 workAgent 共用）：精确 → 相似度匹配
 *   2) 常识规则（判断题关键词）
 *   3) 顺序试探（服务端每题最多返回一次 isRight，试探到对为止）
 */
const Config = require("./config.js");
const Session = require("./session.js");
const A = require("./answerer.js");

const PLAYER = "https://mooc1-1.chaoxing.com/ananas/modules/video/index.html?v=2026-0920-1154";

/** 弹题题型中文 → 数字 */
function typeNum(t) {
  const s = String(t || "");
  if (s.indexOf("多选") !== -1) return 1;
  if (s.indexOf("填空") !== -1) return 2;
  if (s.indexOf("判断") !== -1) return 3;
  return 0;
}

function toOptionMap(options) {
  const m = {};
  (options || []).forEach((o) => {
    if (o && o.name) m[String(o.name).toUpperCase()] = String(o.description == null ? "" : o.description).trim();
  });
  return m;
}

class QuizAgent {
  constructor(session, opts) {
    this.s = session;
    this.hz = (opts && opts.humanizer) || null;
    this.bankFile = (opts && opts.bankFile) || A.BANK_FILE;
    this.bank = (opts && opts.bank) || A.loadBank(this.bankFile);
    this.stats = { total: 0, right: 0, tried: 0 };
    // 在线答题源（和章节测验共用：题库接口 / 大模型）
    if (opts && opts.provider) {
      this.provider = opts.provider;
    } else {
      const AP = require("./answerProvider.js");
      this.provider = new AP.AnswerProvider({
        bank: this.bank,
        onSaved: () => this.saveBank(),
        log: () => {},
        remote: opts && opts.remote,
        llm: opts && opts.llm,
      });
    }
  }

  saveBank() {
    return A.saveBank(this.bank, this.bankFile);
  }

  /** agent 决策钩子：题库 → 在线答题源 → 顺序试探 */
  async decide(question, options, qtype) {
    const t = typeNum(qtype);
    const opts = Array.isArray(options) ? toOptionMap(options) : options || {};
    const hit = A.solve(this.bank, { type: t, title: question, options: opts });
    if (hit.answer) {
      // 多选：弹题接口只认单个选项，取第一个
      const first = String(hit.answer).split("")[0];
      return { answer: first, from: hit.from };
    }
    if (this.provider && this.provider.online) {
      try {
        const r = await this.provider.resolve({ type: t, title: question, options: opts });
        if (r && r.answer) return { answer: String(r.answer).split("")[0], from: r.from };
      } catch (e) {}
    }
    return { answer: null, from: "explore" };
  }

  /** 作答一题（自动试探到 isRight） */
  async answer(courseCtx, quizData) {
    const d = quizData;
    const qtype = d.questionType;
    const options = d.options || [];
    const t = typeNum(qtype);
    const optMap = toOptionMap(options);
    this.stats.total++;

    const dec = await this.decide(d.description, options, qtype);
    const names = options.map((o) => String(o.name).toUpperCase());
    const order = dec.answer
      ? [dec.answer, ...names.filter((n) => n !== dec.answer)]
      : names;

    // 真人看到题目要读一遍、想一下，秒答是明显的机器特征
    if (this.hz) await this.hz.beforeQuiz();

    let attempt = 0;
    for (const name of order) {
      if (attempt++ > 0 && this.hz) await this.hz.betweenQuizTry();
      this.stats.tried++;
      const u =
        `https://mooc1-1.chaoxing.com/question/quiz-validation` +
        `?classid=${courseCtx.clazzId}` +
        `&objectid=${courseCtx.objectId}` +
        `&dtype=Video` +
        `&eventid=${d.resourceId}` +
        `&memberinfo=${d.memberinfo}` +
        `&answerContent=${encodeURIComponent(name)}`;
      const r = await this.s.get(u, PLAYER);
      let j = null;
      try {
        j = JSON.parse(r.text);
      } catch (e) {}
      if (j && j.status) {
        if (j.isRight) {
          this.stats.right++;
          // 学到的正确答案写进共用题库（判断题能直接反推另一半）
          A.learn(this.bank, d.description, t, name, "marking_dui", optMap, 1);
          if (t === 3) A.learn(this.bank, d.description, 3, name, "marking_dui", { A: "对", B: "错" }, 1);
          this.saveBank();
          return { ok: true, right: true, answer: name, msg: j.msg };
        }
        return { ok: true, right: false, answer: name, msg: j.msg };
      }
    }
    return { ok: false, right: false };
  }
}

module.exports = { QuizAgent, PLAYER };

// 自测（需要 config.json 里的有效 cookie）
if (require.main === module) {
  (async () => {
    const cfg = await new Config("./config.json").read();
    const s = new Session({ cookie: cfg.saveCookie });
    const agent = new QuizAgent(s);
    const r = await agent.answer(
      { clazzId: "888000003", objectId: "0000000000000000000000000000aaaa" },
      {
        resourceId: 12289325,
        memberinfo: "0000000000000000000000000000000000000000000000",
        description: "2008年北京奥运会有77个国家的总统与总理来到中国参加开幕式。",
        questionType: "判断题",
        options: [
          { name: "A", description: "对" },
          { name: "B", description: "错" },
        ],
      }
    );
    console.log("agent 作答:", JSON.stringify(r), "统计:", agent.stats);
  })();
}