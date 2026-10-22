#!/usr/bin/env node
/**
 * 章节测验 / 作业自动化 · 单元测试
 * 覆盖：题干清洗、相似度、答案抽取、判断题归一、题库学习与求解、
 *      正确率区间规划（含种子可复现）、答题页解析、交卷表单构造、批阅页解析、
 *      workAgent 端到端（mock 会话）、course.getJobs 任务点解析。
 *
 * 跑法：node tools/test-work.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const A = require(path.join(ROOT, "answerer.js"));
const Acc = require(path.join(ROOT, "accuracy.js"));
const { WorkAgent } = require(path.join(ROOT, "workAgent.js"));
const CourseData = require(path.join(ROOT, "course.js"));
const { parseMarg } = require(path.join(ROOT, "course.js"));

const FIX = path.join(__dirname, "fixtures");
const editableHtml = fs.readFileSync(path.join(FIX, "work-editable.html"), "utf8");
const reviewHtml = fs.readFileSync(path.join(FIX, "work-review.html"), "utf8");

let pass = 0;
let fail = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ✔ " + name);
  } catch (e) {
    fail++;
    failures.push({ name, err: e });
    console.log("  ✖ " + name + "  → " + e.message);
  }
}
async function ta(name, fn) {
  try {
    await fn();
    pass++;
    console.log("  ✔ " + name);
  } catch (e) {
    fail++;
    failures.push({ name, err: e });
    console.log("  ✖ " + name + "  → " + e.message);
  }
}
function group(title) {
  console.log("\n" + title);
}

(async () => {
  /* ---------------------------------------------------- 1. 题干清洗 */
  group("1) 题干清洗");
  t("去掉题号与题型标注", () => {
    const got = A.cleanQuestion("1.[单选题] 总体国家安全观是哪个会议中提出的重大战略思想?( )");
    assert.strictEqual(got, "总体国家安全观是哪个会议中提出的重大战略思想?");
  });
  t("去掉【多选题】与分值", () => {
    const got = A.cleanQuestion("2.【多选题】（2.0分）当前我国国家安全面临哪些挑战？( )");
    assert.strictEqual(got, "当前我国国家安全面临哪些挑战？");
  });
  t("去掉 第1题 / （1） 前缀", () => {
    assert.ok(!/^第/.test(A.cleanQuestion("第3题 判断题内容")));
    assert.ok(!/^1/.test(A.cleanQuestion("（1）这是题干")));
  });
  t("保留正文标点", () => {
    assert.strictEqual(A.cleanQuestion("中国的首都是哪里?"), "中国的首都是哪里?");
  });

  /* ---------------------------------------------------- 2. 相似度 */
  group("2) 相似度匹配");
  t("同一题不同标点 → 1", () => {
    assert.ok(A.similarity("中国的首都是哪里?", "中国的首都是哪里？") === 1);
  });
  t("近似题 > 0.6", () => {
    const s = A.similarity("总体国家安全观是哪个会议中提出的重大战略思想", "总体国家安全观是在哪个会议提出的重大战略思想");
    assert.ok(s > 0.6, "similarity=" + s);
  });
  t("无关题 < 0.6", () => {
    const s = A.similarity("总体国家安全观是哪个会议中提出的重大战略思想", "视频播放完成度统计接口的签名方式");
    assert.ok(s < 0.6, "similarity=" + s);
  });

  /* ---------------------------------------------------- 3. 答案抽取 */
  group("3) 选项字母抽取");
  const opts4 = { A: "党的十八大", B: "党的十九大", C: "十八届中央国家安全委员会第一次会议", D: "党的十一届三中全会" };
  t("纯字母 A", () => assert.deepStrictEqual(A.extractLetters("A", opts4), ["A"]));
  t("多选 AB / A,B / A、B", () => {
    assert.deepStrictEqual(A.extractLetters("AB", opts4), ["A", "B"]);
    assert.deepStrictEqual(A.extractLetters("A,B", opts4), ["A", "B"]);
    assert.deepStrictEqual(A.extractLetters("A、B", opts4), ["A", "B"]);
  });
  t("中文答案反查选项", () => {
    assert.deepStrictEqual(A.extractLetters("党的十九大", opts4), ["B"]);
  });

  /* ---------------------------------------------------- 4. 判断题 */
  group("4) 判断题归一");
  t("对/是/√/true → true", () => {
    ["对", "是", "√", "true", "T", "1", "正确"].forEach((v) => assert.strictEqual(A.toBool(v), true, v));
  });
  t("错/否/×/false → false", () => {
    ["错", "否", "×", "false", "F", "0", "错误"].forEach((v) => assert.strictEqual(A.toBool(v), false, v));
  });
  t("不正确 → false（不能被'正确'带偏）", () => {
    assert.strictEqual(A.toBool("不正确"), false);
  });
  t("判断字母映射 A=对 B=错", () => {
    assert.strictEqual(A.judgeAnswerToLetter(true, { A: "对", B: "错" }), "A");
    assert.strictEqual(A.judgeAnswerToLetter(false, { A: "对", B: "错" }), "B");
  });

  /* ---------------------------------------------------- 5. 题库学习 */
  group("5) 题库学习与求解");
  t("单选答错 → 排除该项", () => {
    const bank = A.emptyBank();
    const q = "总体国家安全观是哪个会议中提出的重大战略思想";
    A.learn(bank, q, 0, "A", "marking_cuo", opts4, 0);
    const e = A.findEntry(bank, q);
    assert.deepStrictEqual(e.wrong, ["A"]);
  });
  t("单选排除 3 项 → 推出答案", () => {
    const bank = A.emptyBank();
    const q = "测试单选题干";
    A.learn(bank, q, 0, "A", "marking_cuo", opts4, 0);
    A.learn(bank, q, 0, "B", "marking_cuo", opts4, 0);
    A.learn(bank, q, 0, "C", "marking_cuo", opts4, 0);
    const s = A.solve(bank, { type: 0, title: q, options: opts4 });
    assert.strictEqual(s.answer, "D");
    assert.ok(s.from === "bank-eliminate" || s.from === "bank", s.from);
  });
  t("单选答对 → 锁定答案", () => {
    const bank = A.emptyBank();
    const q = "另一道单选题";
    A.learn(bank, q, 0, "C", "marking_dui", opts4, 1);
    const s = A.solve(bank, { type: 0, title: q, options: opts4 });
    assert.strictEqual(s.answer, "C");
    assert.strictEqual(s.confidence, 1);
  });
  t("多选半对 → 记录已确认成员", () => {
    const bank = A.emptyBank();
    const q = "多选半对题";
    A.learn(bank, q, 1, "A", "marking_bandui", opts4, 0.5);
    const e = A.findEntry(bank, q);
    assert.deepStrictEqual(e.members, ["A"]);
    const s = A.solve(bank, { type: 1, title: q, options: opts4 });
    assert.strictEqual(s.answer, "A");
    assert.strictEqual(s.from, "bank-members");
  });
  t("多选满分 → 锁定组合", () => {
    const bank = A.emptyBank();
    const q = "多选满分题";
    A.learn(bank, q, 1, "ABC", "marking_dui", opts4, 1);
    const s = A.solve(bank, { type: 1, title: q, options: opts4 });
    assert.strictEqual(s.answer, "ABC");
  });
  // 回归：题库必须存下选项文本。曾经只存题干不存 options，
  // 答题时给模型看的只有题干、没有 A/B/C/D 内容，模型只能靠常识硬猜，
  // 这是正确率长期卡在四成左右、而不是模型本身不行的真正原因。
  t("learn 会把选项文本一起存进题库", () => {
    const bank = A.emptyBank();
    A.learn(bank, "带选项的题", 0, "A", "marking_dui", opts4, 1);
    const e = A.findEntry(bank, "带选项的题");
    assert.ok(e.options, "题库记录应当有 options 字段");
    assert.strictEqual(e.options.A, opts4.A);
    assert.strictEqual(e.options.D, opts4.D);
  });
  t("rememberOptions 单独调用也能补存选项", () => {
    const bank = A.emptyBank();
    A.rememberOptions(bank, "补存选项的题", opts4);
    const e = A.findEntry(bank, "补存选项的题");
    assert.ok(e.options);
    assert.deepStrictEqual(Object.keys(e.options).sort(), ["A", "B", "C", "D"]);
  });
  t("solve 遇到新题会把选项顺手补进题库", () => {
    const bank = A.emptyBank();
    A.solve(bank, { type: 0, title: "从没见过的题", options: opts4 });
    const e = A.findEntry(bank, "从没见过的题");
    assert.ok(e && e.options, "solve 应当补存 options");
    assert.strictEqual(e.options.B, opts4.B);
  });
  t("判断题答错 → 直接学到反面", () => {
    const bank = A.emptyBank();
    const q = "高等学校开设国家安全教育公共基础课程";
    A.learn(bank, q, 3, "对", "marking_cuo", { A: "对", B: "错" }, 0);
    const s = A.solve(bank, { type: 3, title: q, options: { A: "对", B: "错" } });
    assert.strictEqual(s.answer, "B");
  });
  t("判断题答对（中文答案）→ 题库记成字母 A", () => {
    const bank = A.emptyBank();
    const q = "判断对的中文答案";
    A.learn(bank, q, 3, "对", "marking_dui", { A: "对", B: "错" }, 1);
    const e = A.findEntry(bank, q);
    assert.strictEqual(e.correct, "A");
    assert.deepStrictEqual(e.wrong, ["B"]);
  });
  t("旧版扁平题库可迁移", () => {
    const bank = A.migrateBank({ "老题目干": "B" });
    const s = A.solve(bank, { type: 0, title: "老题目干", options: opts4 });
    assert.strictEqual(s.answer, "B");
  });
  t("题库落盘再读一致", () => {
    const tmp = path.join(require("os").tmpdir(), "qb-" + Date.now() + ".json");
    const bank = A.emptyBank();
    A.learn(bank, "落盘题", 0, "D", "marking_dui", opts4, 1);
    A.saveBank(bank, tmp);
    const back = A.loadBank(tmp);
    assert.strictEqual(A.solve(back, { type: 0, title: "落盘题", options: opts4 }).answer, "D");
    fs.unlinkSync(tmp);
  });

  /* ---------------------------------------------------- 6. 正确率规划 */
  group("6) 正确率区间规划");
  const mkQs = (n, known) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      arr.push({
        id: String(i + 1),
        type: i === n - 1 ? 3 : 0,
        answer: i < known ? ["A", "B", "C", "D"][i % 4] : null,
        options: { A: "甲", B: "乙", C: "丙", D: "丁" },
      });
    }
    return arr;
  };
  t("同种子 → 同结果（可复现）", () => {
    const qs = mkQs(10, 10);
    const p1 = Acc.plan({ questions: qs, fullScore: 100, min: 80, max: 90, seed: 12345 });
    const p2 = Acc.plan({ questions: qs, fullScore: 100, min: 80, max: 90, seed: 12345 });
    assert.deepStrictEqual(p1.plan, p2.plan);
    assert.deepStrictEqual(p1.missed, p2.missed);
  });
  t("全知 10 题 100 分、目标 80-90% → 故意错 1~2 道且落在区间", () => {
    const qs = mkQs(10, 10);
    const p = Acc.plan({ questions: qs, fullScore: 100, min: 80, max: 90, seed: 7 });
    assert.strictEqual(p.knownCount, 10);
    assert.ok(p.missed.length >= 1 && p.missed.length <= 2, "missed=" + JSON.stringify(p.missed));
    assert.ok(p.reachable, p.note);
    assert.ok(p.expected >= 80 && p.expected <= 90, "expected=" + p.expected);
  });
  t("目标 100% → 不故意错", () => {
    const qs = mkQs(10, 10);
    const p = Acc.plan({ questions: qs, fullScore: 100, min: 100, max: 100, seed: 3 });
    assert.strictEqual(p.missed.length, 0);
    assert.strictEqual(p.expected, 100);
  });
  t("故意错的题一定给错答案", () => {
    const qs = mkQs(6, 6);
    const p = Acc.plan({ questions: qs, fullScore: 60, min: 50, max: 60, seed: 99 });
    for (const id of p.missed) {
      const q = qs.find((x) => String(x.id) === id);
      assert.notStrictEqual(p.plan[id], q.answer, "missed q" + id + " 仍然答了正确答案");
    }
  });
  t("题目太少（4 题 ×25）→ 区间不可达时就近取，不超上限", () => {
    const qs = mkQs(4, 4);
    const p = Acc.plan({ questions: qs, fullScore: 100, min: 80, max: 90, seed: 5 });
    // 只有 0/25/50/75/100 可达：75 低于区间，应优先 75 而不是 100
    assert.strictEqual(p.expected, 75, "expected=" + p.expected);
    assert.strictEqual(p.reachable, false);
  });
  t("区间反了会自动纠正", () => {
    const r = Acc.normalizeRange(90, 80);
    assert.deepStrictEqual(r, { min: 80, max: 90 });
  });
  t("未知题按猜对概率折算期望分", () => {
    const qs = mkQs(10, 5);
    const p = Acc.plan({ questions: qs, fullScore: 100, min: 80, max: 90, seed: 11 });
    assert.strictEqual(p.unknownCount, 5);
    assert.ok(p.expected < 80); // 一半不会 → 期望分被拉低
    assert.ok(/低于/.test(p.note), p.note);
  });

  /* ---------------------------------------------------- 7. 答题页解析 */
  group("7) 答题页解析");
  const page = WorkAgent.parsePage(editableHtml);
  t("识别为可作答页", () => assert.strictEqual(page.state, "editable"));
  t("解析出 4 道题", () => assert.strictEqual(page.questions.length, 4));
  t("题型识别 0/1/3/2", () => {
    assert.deepStrictEqual(page.questions.map((q) => q.type), ["0", "1", "3", "2"]);
  });
  t("题号从 answertype 字段取", () => {
    assert.deepStrictEqual(page.questions.map((q) => q.id), ["406480337", "406480338", "406480340", "406480341"]);
  });
  t("题干已清洗", () => {
    assert.strictEqual(page.questions[0].title, "总体国家安全观是哪个会议中提出的重大战略思想?");
  });
  t("单选选项解析出 4 个键", () => {
    assert.deepStrictEqual(Object.keys(page.questions[0].options).sort(), ["A", "B", "C", "D"]);
  });
  t("选项正文去掉了前缀字母", () => {
    assert.strictEqual(page.questions[0].options.A, "党的十八大");
  });
  t("判断题默认 A=对 B=错", () => {
    assert.deepStrictEqual(page.questions[2].options, { A: "对", B: "错" });
  });
  t("填空题识别出 1 个空", () => {
    assert.strictEqual(page.questions[3].blanks.length, 1);
  });
  t("判断题字母→true/false（服务端要求）", () => {
    assert.strictEqual(WorkAgent.judgeValue("A"), "true");
    assert.strictEqual(WorkAgent.judgeValue("B"), "false");
    assert.strictEqual(WorkAgent.judgeValue("对"), "true");
    assert.strictEqual(WorkAgent.judgeValue("错"), "false");
    assert.strictEqual(WorkAgent.judgeValue("true"), "true");
    assert.strictEqual(WorkAgent.judgeValue(""), "true");
  });
  t("表单参数齐全", () => {
    const f = page.form;
    ["workAnswerId", "totalQuestionNum", "fullScore", "workRelationId", "enc_work", "jobid", "knowledgeid"].forEach((k) => {
      assert.ok(f[k] != null && String(f[k]).length, "缺参数 " + k);
    });
    assert.strictEqual(f.workRelationId, "56704189");
    assert.strictEqual(f.enc_work, "ae29f0f71df378c9adc0cb928d44e29f");
  });
  t("提交动作 URL 带 query", () => {
    assert.ok(page.action.indexOf("/mooc-ans/work/addStudentWorkNew?") === 0);
    assert.ok(page.action.indexOf("token=ae29") !== -1);
  });
  t("已批阅页识别为 done", () => {
    const done = WorkAgent.parsePage("<html><head><title>已批阅</title></head><body><p class='blankTips'>已批阅</p></body></html>");
    assert.strictEqual(done.state, "done");
  });
  t("空页面识别为 error", () => {
    assert.strictEqual(WorkAgent.parsePage("<html><body>nothing</body></html>").state, "error");
  });

  /* ---------------------------------------------------- 8. 交卷表单 */
  group("8) 交卷表单构造");
  const body = WorkAgent.buildSubmitBody(page, {
    "406480337": "B",
    "406480338": "ABC",
    "406480340": "A", // 判断题给字母，提交时必须变成 true
    "406480341": "人民安全",
  });
  t("answerwqbid 是全部题号", () => {
    assert.strictEqual(body.answerwqbid, "406480337,406480338,406480340,406480341");
  });
  t("pyFlag 为空 = 交卷", () => assert.strictEqual(body.pyFlag, ""));
  t("answertype / answer 成对出现", () => {
    assert.strictEqual(body["answertype406480337"], "0");
    assert.strictEqual(body["answer406480337"], "B");
    assert.strictEqual(body["answertype406480338"], "1");
    assert.strictEqual(body["answer406480338"], "ABC");
    assert.strictEqual(body["answertype406480340"], "3");
    assert.strictEqual(body["answer406480340"], "true");
  });
  t("填空按 1..n 编号", () => {
    assert.strictEqual(body["tiankongsize406480341"], "1");
    assert.strictEqual(body["answer4064803411"], "人民安全");
  });
  t("关键表单字段带到 body", () => {
    assert.strictEqual(body.workAnswerId, "55373412");
    assert.strictEqual(body.enc_work, "ae29f0f71df378c9adc0cb928d44e29f");
    assert.strictEqual(body.workRelationId, "56704189");
    assert.strictEqual(body.isphone, "true");
  });

  /* ---------------------------------------------------- 9. 批阅页解析 */
  group("9) 批阅页解析");
  const rev = WorkAgent.parseReview(reviewHtml);
  t("总分解析", () => assert.strictEqual(rev.score, 50));
  t("解析出 3 道批阅题", () => assert.strictEqual(rev.items.length, 3));
  t("我的答案", () => assert.deepStrictEqual(rev.items.map((i) => i.mine), ["A", "A", "对"]));
  t("对错标记", () => {
    assert.deepStrictEqual(rev.items.map((i) => i.mark), ["marking_cuo", "marking_bandui", "marking_dui"]);
  });
  t("每题得分", () => assert.deepStrictEqual(rev.items.map((i) => i.score), [0, 12.5, 25]));
  t("题干已清洗（去掉【单选题】）", () => {
    assert.ok(rev.items[0].title.indexOf("总体国家安全观") === 0, rev.items[0].title);
  });

  /* ---------------------------------------------------- 10. 端到端 */
  group("10) workAgent 端到端（mock 会话）");
  await ta("完整一轮：拉题 → 规划 → 交卷 → 查分 → 学习", async () => {
    const calls = { submit: [], review: 0 };
    const fakeSession = {
      async req() {
        return { status: 200, url: "https://mooc1-api.chaoxing.com/mooc-ans/work/phone/doHomeWork?x=1", text: editableHtml };
      },
      async postForm(url, body) {
        calls.submit.push({ url, body });
        return {
          status: 200,
          text: JSON.stringify({ msg: "success!", status: true, stuStatus: 4 }),
        };
      },
      async get() {
        calls.review++;
        // 第一题故意答错（模拟规划生效），其余全对
        const html = reviewHtml;
        return { status: 200, text: html };
      },
    };
    const tmpBank = path.join(require("os").tmpdir(), "qb-e2e-" + Date.now() + ".json");
    const agent = new WorkAgent(fakeSession, {
      bank: A.emptyBank(),
      bankFile: tmpBank,
      accuracyMin: 80,
      accuracyMax: 90,
      log: () => {},
    });
    const res = await agent.run(
      {
        courseid: "267805464",
        clazzId: "156575659",
        cpi: "571078478",
        knowledgeid: "1260415987",
        workid: "8c50e935820a4a7fb3759839cf5e8838",
        jobid: "work-8c50e935820a4a7fb3759839cf5e8838",
        enc: "1fc91ef0b7e46540ce081c545046948d",
        ktoken: "kt",
        userid: "464065014",
        title: "导论（章节测验）",
      },
      { rounds: 1 }
    );
    assert.strictEqual(calls.submit.length, 1, "应该只交一次卷");
    assert.strictEqual(res.state, "submitted");
    assert.strictEqual(res.score, 50);
    assert.strictEqual(res.fullScore, 100);
    assert.strictEqual(res.ratio, 50);
    assert.ok(calls.submit[0].body.answerwqbid.indexOf("406480337") === 0);
    // 题库应学到东西
    const learned = A.loadBank(tmpBank);
    assert.ok(Object.keys(learned.entries).length >= 3, "题库学习条目=" + Object.keys(learned.entries).length);
    // 判断题答对"对"，应锁定 A
    const judgeEntry = A.findEntry(learned, "高等学校开设国家安全教育公共基础课程，是贯彻落实总体国家安全观的要求。");
    assert.ok(judgeEntry && judgeEntry.correct, "判断题应学到答案");
    fs.unlinkSync(tmpBank);
  });

  await ta("已批阅页 → 直接跳过，不交卷", async () => {
    let submitted = 0;
    const fakeSession = {
      async req() {
        return { status: 200, url: "x", text: "<html><head><title>已批阅</title></head><body></body></html>" };
      },
      async postForm() {
        submitted++;
        return { status: 200, text: "{}" };
      },
      async get() {
        return { status: 200, text: "" };
      },
    };
    const agent = new WorkAgent(fakeSession, { bank: A.emptyBank(), log: () => {} });
    const res = await agent.run({ courseid: "1", clazzId: "2", cpi: "3", knowledgeid: "4", workid: "w", jobid: "work-w" }, { rounds: 1 });
    assert.strictEqual(res.state, "done");
    assert.strictEqual(submitted, 0);
  });

  await ta("交卷失败会如实报错", async () => {
    const fakeSession = {
      async req() {
        return { status: 200, url: "x", text: editableHtml };
      },
      async postForm() {
        return { status: 200, text: JSON.stringify({ msg: "已批阅作业，不允许重复提交！", status: false }) };
      },
      async get() {
        return { status: 200, text: "" };
      },
    };
    const agent = new WorkAgent(fakeSession, { bank: A.emptyBank(), log: () => {} });
    const res = await agent.run({ courseid: "1", clazzId: "2", cpi: "3", knowledgeid: "4", workid: "w", jobid: "work-w" }, { rounds: 1 });
    assert.strictEqual(res.state, "error");
    assert.ok(/不允许重复提交/.test(res.note), res.note);
  });

  /* ---------------------------------------------------- 11. 猜题分布 */
  group("11) 未知题的猜法（不能全选 A）");
  t("同一道题每次猜同一个（稳定）", () => {
    const fake = { s: { async req() {}, async postForm() {}, async get() {} } };
    const ag = new WorkAgent(fake, { log: () => {} });
    const q = { id: "1", type: "0", title: "某道单选题干", options: { A: "甲", B: "乙", C: "丙", D: "丁" } };
    const a1 = ag._guessFor(q);
    const a2 = ag._guessFor(q);
    assert.strictEqual(a1, a2);
    assert.ok(/^[A-D]$/.test(a1), a1);
  });
  t("20 道不同单选题的猜测覆盖 3 个以上选项", () => {
    const fake = { s: { async req() {}, async postForm() {}, async get() {} } };
    const ag = new WorkAgent(fake, { log: () => {} });
    const set = new Set();
    for (let i = 0; i < 20; i++) {
      set.add(ag._guessFor({ id: String(i), type: "0", title: "第" + i + "道题目的题干内容", options: { A: "甲", B: "乙", C: "丙", D: "丁" } }));
    }
    assert.ok(set.size >= 3, "只用到 " + Array.from(set).join(""));
  });
  t("未知判断题猜「对」", () => {
    const fake = { s: { async req() {}, async postForm() {}, async get() {} } };
    const ag = new WorkAgent(fake, { log: () => {} });
    assert.strictEqual(ag._guessFor({ id: "1", type: "3", title: "某判断题", options: { A: "对", B: "错" } }), "A");
  });
  t("未知多选题猜两个选项", () => {
    const fake = { s: { async req() {}, async postForm() {}, async get() {} } };
    const ag = new WorkAgent(fake, { log: () => {} });
    const g = ag._guessFor({ id: "1", type: "1", title: "某多选题", options: { A: "甲", B: "乙", C: "丙", D: "丁" } });
    assert.strictEqual(g.length, 2, g);
    assert.strictEqual(g[0] === g[1], false);
  });

  /* ---------------------------------------------------- 12. 在线答题源 */
  group("12) 在线答题源（题库接口 / 大模型）");
  const AP = require(path.join(ROOT, "answerProvider.js"));
  const httpLib = require("http");

  t("提示词包含题干和选项", () => {
    const p = AP.buildPrompt({ type: 0, title: "中国的首都是哪座城市", options: { A: "北京", B: "上海" } });
    assert.ok(p.indexOf("中国的首都是哪座城市") >= 0);
    assert.ok(p.indexOf("A. 北京") >= 0);
    assert.ok(p.indexOf("单选题") >= 0);
  });
  t("从模型回复抠字母（多种写法）", () => {
    const q = { type: 0, options: { A: "甲", B: "乙", C: "丙" } };
    assert.strictEqual(AP.parseLlmAnswer("B", q), "B");
    assert.strictEqual(AP.parseLlmAnswer("答案：B", q), "B");
    assert.strictEqual(AP.parseLlmAnswer("选 B，因为…", q), "B");
    assert.strictEqual(AP.parseLlmAnswer("丙", q), "C");
  });
  t("多选回复 ≥2 个字母会保留（排序）", () => {
    const q = { type: 1, options: { A: "甲", B: "乙", C: "丙", D: "丁" } };
    assert.strictEqual(AP.parseLlmAnswer("BCA", q), "ABC");
  });
  t("判断题回复 true/对 → A", () => {
    const q = { type: 3, options: { A: "对", B: "错" } };
    assert.strictEqual(AP.parseLlmAnswer("对", q), "A");
    assert.strictEqual(AP.parseLlmAnswer("错", q), "B");
  });
  t("填空回复原样返回", () => {
    const q = { type: 2, options: {} };
    assert.strictEqual(AP.parseLlmAnswer("人民安全", q), "人民安全");
  });

  await ta("题库接口 + 大模型都走通，并写回本地题库缓存", async () => {
    const seen = { remote: 0, llm: 0 };
    const cloudEntries = {};
    const cloudQ = "云端题库里已经有的题";
    cloudEntries[A.qkey(cloudQ)] = { type: 0, correct: "C", updatedAt: Date.now() };
    const srv = httpLib.createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url.indexOf("/api/bank") === 0 && req.method === "GET") {
          res.end(JSON.stringify({ ok: true, total: Object.keys(cloudEntries).length, entries: cloudEntries }));
        } else if (req.url.indexOf("/api/bank") === 0 && req.method === "POST") {
          const inc = (JSON.parse(buf || "{}").entries) || {};
          let added = 0;
          for (const k of Object.keys(inc)) {
            if (!cloudEntries[k]) added++;
            cloudEntries[k] = inc[k];
          }
          res.end(JSON.stringify({ ok: true, total: Object.keys(cloudEntries).length, added }));
        } else if (req.url.indexOf("/answer") === 0) {
          seen.remote++;
          res.end(JSON.stringify({ code: 0, question: "C" }));
        } else if (req.url.indexOf("/v1/chat/completions") === 0) {
          seen.llm++;
          res.end(JSON.stringify({ choices: [{ message: { content: "B" } }] }));
        } else {
          res.statusCode = 404;
          res.end("{}");
        }
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    const bank = A.emptyBank();
    const prov = new AP.AnswerProvider({
      bank,
      remote: { enabled: true, url: "http://127.0.0.1:" + port + "/answer" },
      llm: { enabled: true, baseUrl: "http://127.0.0.1:" + port + "/v1", apiKey: "k", model: "m" },
    });
    assert.strictEqual(prov.online, true);

    const q1 = { id: "1", type: 0, title: "题库能答的题", options: { A: "甲", B: "乙", C: "丙" } };
    const r1 = await prov.resolve(q1);
    assert.ok(r1 && r1.answer === "C", JSON.stringify(r1));
    assert.strictEqual(r1.from, "remote-bank");
    assert.strictEqual(seen.remote, 1);
    assert.strictEqual(seen.llm, 0, "题库命中就不该再调大模型");

    // 题库接口失败 → 落到大模型
    prov.remote.url = "http://127.0.0.1:" + port + "/nothing";
    const q2 = { id: "2", type: 0, title: "题库答不了的题", options: { A: "甲", B: "乙" } };
    const r2 = await prov.resolve(q2);
    assert.ok(r2 && r2.answer === "B", JSON.stringify(r2));
    assert.strictEqual(r2.from, "llm");
    assert.strictEqual(seen.llm, 1);

    // 缓存进题库 → solve 能拿到，且置信度低（当"不确定"处理）
    const s1 = A.solve(bank, { type: 0, title: q1.title, options: q1.options });
    assert.strictEqual(s1.answer, "C");
    assert.strictEqual(s1.from, "provider");
    assert.ok(s1.confidence < 0.9, "在线答案置信度应低于已批阅题库");

    // 批阅后 → 猜测被清掉，以批阅结果为准
    A.learn(bank, q1.title, 0, "C", "marking_dui", q1.options, 1);
    const e = A.findEntry(bank, q1.title);
    assert.strictEqual(e.guess, undefined);
    const s2 = A.solve(bank, { type: 0, title: q1.title, options: q1.options });
    assert.strictEqual(s2.from, "bank");
    assert.strictEqual(s2.confidence, 1);

    // 调用次数上限
    const prov2 = new AP.AnswerProvider({
      bank: A.emptyBank(),
      llm: { enabled: true, baseUrl: "http://127.0.0.1:" + port + "/v1", apiKey: "k", model: "m", maxCalls: 1 },
    });
    await prov2.resolve({ type: 0, title: "第一道", options: { A: "甲", B: "乙" } });
    const blocked = await prov2.resolve({ type: 0, title: "第二道", options: { A: "甲", B: "乙" } });
    assert.strictEqual(blocked, null);
    assert.strictEqual(prov2.stats.llmCalls, 1);

    // 超时/连不上不抛异常，只是返回 null
    const prov3 = new AP.AnswerProvider({
      bank: A.emptyBank(),
      llm: { enabled: true, baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m", timeoutMs: 800 },
    });
    assert.strictEqual(await prov3.resolve({ type: 0, title: "连不上", options: { A: "甲" } }), null);

    // ---- 云端共享题库：先查它，再问大模型 ----
    const bank4 = A.emptyBank();
    const prov4 = new AP.AnswerProvider({
      bank: bank4,
      shared: { enabled: true, url: "http://127.0.0.1:" + port, key: "shared" },
      llm: { enabled: true, baseUrl: "http://127.0.0.1:" + port + "/v1", apiKey: "k", model: "m" },
    });
    const beforeLlm = seen.llm;
    const r4 = await prov4.resolve({ type: 0, title: cloudQ, options: { A: "甲", B: "乙", C: "丙" } });
    assert.ok(r4 && r4.answer === "C", "云端题库应直接给出 C，实际 " + JSON.stringify(r4));
    assert.strictEqual(r4.from, "cloud-bank");
    assert.strictEqual(seen.llm, beforeLlm, "云端题库命中时不该再调大模型");
    assert.strictEqual(prov4.stats.cloudHit, 1);

    // 答过的题推回云端
    A.learn(bank4, "一道新学的题", 0, "B", "marking_dui", { A: "甲", B: "乙" }, 1);
    const pushed = await prov4.pushShared();
    assert.ok(pushed >= 1, "应至少推送 1 条，实际 " + pushed);
    assert.ok(cloudEntries[A.qkey("一道新学的题")], "云端应收到新条目");

    await new Promise((r) => srv.close(r));
  });

  await ta("置信度低的答案不算已掌握（不影响压分规划）", async () => {
    const qs = [
      { id: "1", type: 0, answer: "A", confidence: 1, options: { A: "甲", B: "乙" } },
      { id: "2", type: 0, answer: "A", confidence: 0.8, options: { A: "甲", B: "乙" } },
      { id: "3", type: 1, answer: "AB", confidence: 0.6, options: { A: "甲", B: "乙", C: "丙" } },
    ];
    const p = Acc.plan({ questions: qs, fullScore: 100, min: 80, max: 90, seed: 1 });
    // 只有题库确认过(conf=1)的才算已掌握；大模型答的(0.8)以前被当已知，
    // 结果 3 题卷以为满分、实际 66.6，所以现在收紧为"必须 1"
    assert.strictEqual(p.knownCount, 1, "只有 conf=1 的算已知");
    assert.strictEqual(p.unknownCount, 2);
    assert.strictEqual(p.plan["3"], "AB", "低置信度答案仍然照它交");
  });

  await ta("大模型答的题不算已知（守卫 66.6 分那类事故）", async () => {
    // 真实事故：3 题卷，压分器以为 3 道全已知 → 目标 100 分不压分，
    // 实际有 1 道是大模型猜的且猜错 → 只考 66.6，掉出区间。
    const qs = [
      { id: "1", type: 0, answer: "A", from: "bank", confidence: 1, options: { A: "甲", B: "乙" } },
      { id: "2", type: 0, answer: "B", from: "bank", confidence: 1, options: { A: "甲", B: "乙" } },
      { id: "3", type: 0, answer: "C", from: "provider", confidence: 0.85, options: { A: "甲", B: "乙", C: "丙" } },
    ];
    const p = Acc.plan({ questions: qs, fullScore: 100, min: 80, max: 100, seed: 5 });
    assert.strictEqual(p.knownCount, 2, "只有题库确认的 2 道算已知");
    assert.strictEqual(p.unknownCount, 1, "大模型那道算未知");
    assert.ok(p.expected >= 80, "预估分要落进区间，实际 " + p.expected);
    assert.ok(p.probInRange > 0.8, "落区间概率应较高，实际 " + p.probInRange);
  });

  await ta("按「落区间概率」选方案，而不是按期望分", async () => {
    const mk = (i, conf) => ({ id: String(i), type: 0, answer: "A", confidence: conf == null ? 1 : conf, options: { A: "甲", B: "乙", C: "丙", D: "丁" } });
    const mkU = (i, t) => ({ id: String(i), type: t == null ? 0 : t, answer: null, confidence: 0, guess: "A", options: { A: "甲", B: "乙", C: "丙", D: "丁" } });
    const go = (qs) => Acc.plan({ questions: qs, fullScore: 100, min: 80, max: 90, seed: 7 });

    // 5 题全已知：只能 80 或 100 → 必须选 80（满分一眼假）
    const p1 = go([1, 2, 3, 4, 5].map((i) => mk(i)));
    assert.strictEqual(p1.missed.length, 1);
    assert.strictEqual(p1.expected, 80);
    assert.ok(p1.probInRange > 0.99, "全已知应 100% 落区间");

    // 大模型答的(0.8)不算已知：不主动压分，靠它自己可能错的那 20% 自然落区间
    const p2 = go([1, 2, 3, 4, 5].map((i) => mk(i, 0.8)));
    assert.strictEqual(p2.knownCount, 0, "大模型答案不计入已知，避免压分计划被它带崩");
    assert.strictEqual(p2.missed.length, 0);

    // 4 已知 + 1 未知（单选 25%）：不压分，靠未知题自然掉分更稳
    const p3 = go([1, 2, 3, 4].map((i) => mk(i)).concat([mkU(5)]));
    assert.strictEqual(p3.missed.length, 0);
    assert.ok(p3.probInRange > 0.7, "4已知1未知 落区间概率 " + p3.probInRange);

    // 2 题（每题 50 分）：80~90 不可达 → 如实标记、概率 0
    const p4 = go([mk(1), mk(2)]);
    assert.strictEqual(p4.reachable, false);
    assert.strictEqual(p4.probInRange, 0);

    // 8 题：每题 12.5 分，压一道刚好 87.5
    const p5 = go([1, 2, 3, 4, 5, 6, 7, 8].map((i) => mk(i)));
    assert.strictEqual(p5.missed.length, 1);
    assert.ok(Math.abs(p5.expected - 87.5) < 0.01, "8题压一道应 87.5，实际 " + p5.expected);

    // 4 题（每题 25 分）：区间不可达，取离区间更近的 75，不要 100
    const p6 = go([1, 2, 3, 4].map((i) => mk(i)));
    assert.strictEqual(p6.reachable, false);
    assert.strictEqual(p6.expected, 75);
  });

  /* ---------------------------------------------------- 13. 任务点解析 */
  group("13) course.getJobs 任务点解析");
  const mArg = {
    attachments: [
      { type: "video", jobid: "video-111", property: { objectid: "obj1", name: "1.1 视频" }, attDuration: 600, isPassed: false, otherInfo: "nodeId_1-cpi_2" },
      { type: "workid", jobid: "work-abc123", enc: "enc-xyz", property: { workid: "abc123", worktype: "workA", title: "导论", module: "work" }, mid: "m1", aid: 1 },
      { type: "workid", jobid: "work-abc123", enc: "enc-xyz", property: { workid: "abc123", worktype: "workA", title: "导论", module: "work" }, mid: "m1", aid: 1 },
    ],
    defaults: { courseid: "267805464", clazzId: "156575659", cpi: "571078478", knowledgeid: "1260415987", userid: "464065014", ktoken: "kt0" },
  };
  const cardsHtml = `<html><body><script>mArg = ""; try{ mArg = ${JSON.stringify(mArg)} }catch(e){}</script></body></html>`;
  t("parseMarg 能取到 attachments", () => {
    const m = parseMarg(cardsHtml);
    assert.ok(m && m.attachments.length === 3);
    assert.strictEqual(m.defaults.clazzId, "156575659");
  });
  await ta("getJobs 分离视频与测验，并对 workid 去重", async () => {
    const fakeSession = {
      async get(url) {
        const n = (url.match(/num=(\d+)/) || [])[1];
        return { status: 200, text: Number(n) === 0 ? cardsHtml : "<html></html>" };
      },
    };
    const course = new CourseData(fakeSession, { courseId: "267805464", clazzId: "156575659", cpi: "571078478", title: "测试课" });
    const jobs = await course.getJobs("1260415987");
    assert.strictEqual(jobs.videos.length, 1);
    assert.strictEqual(jobs.videos[0].objectId, "obj1");
    assert.strictEqual(jobs.works.length, 1, "重复 workid 应去重");
    assert.strictEqual(jobs.works[0].workid, "abc123");
    assert.strictEqual(jobs.works[0].worktype, "workA");
    assert.strictEqual(jobs.works[0].enc, "enc-xyz");
    assert.strictEqual(jobs.works[0].defaults.ktoken, "kt0");
  });

  /* ---------------------------------------------------- 汇总 */
  console.log("\n================ 测试结果 ================");
  console.log(`  通过 ${pass}   失败 ${fail}`);
  if (fail) {
    failures.forEach((f) => console.log(`  ✖ ${f.name}: ${f.err.message}`));
    console.log("==========================================");
    process.exit(1);
  }
  console.log("  全部通过 ✔");
  console.log("==========================================");
})();