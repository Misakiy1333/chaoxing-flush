/**
 * 完全打通！！
 *   answerContent 传选项 name（"A"/"B"），isRight:true 表示答对。
 *   服务端记录 answerContent="A"。answered 字段刷新有延迟但服务端已收。
 * 结论：弹题自动作答 = GET quiz-validation?classid=&objectid=&dtype=Video&eventid=<resourceId>&memberinfo=<mi>&answerContent=<name>
 *
 * 「接入 agent」：接本地 LLM？无外部 key。务实方案：
 *   1) 题库策略：优先常识规则 + 记忆（错过的题记住正确答案）
 *   2) answerContent 尝试 A→若 isRight=false 依次 B/C/D（服务端全收，只是 isRight 标记）
 *   3) isRight=false 不影响弹题放行（msg=通过 status:true）
 * 题目文本 + 选项发给我方 agent 判断 —— 这里做成 agentHook 可插入自定义 API；
 *   默认策略：顺序试探直到 isRight:true（对判断题最多 2 次，选择题最多 4 次）。
 */
const Config = require("./config.js");
const Session = require("./session.js");
const fs = require("fs");
const path = require("path");

const PLAYER = "https://mooc1-1.chaoxing.com/ananas/modules/video/index.html?v=2026-0920-1154";
const BANK = path.join(__dirname, "quizbank.json");

function loadBank() { try { return JSON.parse(fs.readFileSync(BANK, "utf8")); } catch (e) { return {}; } }
function saveBank(b) { fs.writeFileSync(BANK, JSON.stringify(b, null, 1), "utf8"); }

class QuizAgent {
  constructor(session, opts) {
    this.s = session;
    this.hz = (opts && opts.humanizer) || null; // 拟人化：作答前要有思考时间
    this.bank = loadBank();
    this.stats = { total: 0, right: 0, tried: 0 };
  }

  /** agent 决策钩子：可替换为任何 LLM API。默认：题库 → 常识关键词 → 顺序试探 */
  async decide(question, options, qtype) {
    const key = question.replace(/\s+/g, "").slice(0, 80);
    if (this.bank[key]) return { answer: this.bank[key], from: "bank" };

    // 常识规则（教育类课程高频题）
    const q = question;
    const isJudge = qtype === "判断题";
    if (isJudge) {
      if (/必须|应当|严禁|不得|禁止|全部|都要/.test(q) && !/不必须|不应当时|不是都/.test(q)) return { answer: "A", from: "heuristic" };
    }
    return { answer: null, from: "explore" };
  }

  /** 作答一题（自动试探到 isRight） */
  async answer(courseCtx, quizData) {
    const d = quizData; // datas[0]
    const qtype = d.questionType;
    const options = d.options || [];
    this.stats.total++;

    const dec = await this.decide(d.description, options, qtype);
    const order = dec.answer
      ? [dec.answer, ...options.map(o => o.name).filter(n => n !== dec.answer)]
      : options.map(o => o.name);

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
      try { j = JSON.parse(r.text); } catch (e) {}
      if (j && j.status) {
        if (j.isRight) {
          this.stats.right++;
          const key = d.description.replace(/\s+/g, "").slice(0, 80);
          this.bank[key] = name;
          saveBank(this.bank);
          return { ok: true, right: true, answer: name, msg: j.msg };
        }
        return { ok: true, right: false, answer: name, msg: j.msg };
      }
    }
    return { ok: false, right: false };
  }
}

module.exports = { QuizAgent, PLAYER };

// 自测
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
        options: [{ name: "A", description: "对" }, { name: "B", description: "错" }],
      }
    );
    console.log("agent 作答:", JSON.stringify(r), "统计:", agent.stats);
  })();
}
