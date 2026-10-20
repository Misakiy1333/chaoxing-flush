/**
 * 选课功能真实 DOM 测试（用 jsdom 真跑页面，真点复选框）
 *   node tools/test-pick.js
 *
 * 背景：原来 startBtn 用 Object.keys(picked) 取已选课程，而 picked 只记录
 * 用户点过的项 —— 取消一门课反而会把「全部课程」传上去。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "web", "multi.html"), "utf8");

const COURSES = [
  { courseId: "111111111", title: "国家安全教育" },
  { courseId: "222222222", title: "军事理论（同济大学版）" },
  { courseId: "333333333", title: "高校实验室安全通识课" },
  { courseId: "444444444", title: "实验室安全准入教育" },
  { courseId: "267000001", title: "高等数学" },
  { courseId: "267000002", title: "人工智能通识课" },
];

let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}
const sleep = (t) => new Promise((r) => setTimeout(r, t));

async function newPage(courses, settings) {
  const started = [];
  const list = courses || COURSES;
  const st = settings || { dailyHours: 24, brushStart: 0, brushEnd: 24, skipCourse: "" };

  // 关键：必须在脚本执行前注入 fetch/EventSource（beforeParse）
  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "http://127.0.0.1:8080/",
    beforeParse(w) {
      w.EventSource = class {
        constructor() { this.readyState = 0; setTimeout(() => { if (this.onopen) this.onopen(); }, 0); }
        close() {}
      };
      w.confirm = () => false;
      w.fetch = async (url, opt) => {
        const u = String(url);
        const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (u.indexOf("/api/version") >= 0) {
          return json({
            ok: true, role: "cloud", version: "1.2", buildAt: "2026-10-19",
            announcement: { id: "a1", title: "更新公告", date: "2026-10-19", items: ["测试"] },
            latest: { version: "3.6", downloadUrl: "", note: "" },
          });
        }
        if (u.indexOf("/api/me") >= 0) {
          return json({ ok: true, uname: "tester", settings: st, running: false });
        }
        if (u.indexOf("/api/courses") >= 0) return json({ ok: true, courses: list });
        if (u.indexOf("/api/start") >= 0) {
          let body = null;
          try { body = JSON.parse(opt && opt.body); } catch (e) {}
          started.push(body);
          return json({ ok: true });
        }
        return json({ ok: true });
      };
    },
  });

  await sleep(150);
  return { dom, w: dom.window, d: dom.window.document, started };
}

function boxes(d) {
  return Array.prototype.slice.call(d.querySelectorAll("#coursePick input"));
}

(async () => {
  console.log("=== ① 初始状态 ===");
  let { w, d, started } = await newPage();
  await sleep(60);
  const bs = boxes(d);
  ok("课程勾选框渲染出来了", bs.length === COURSES.length, bs.length + " 个");
  ok("默认全部勾选", bs.every((b) => b.checked), bs.filter((b) => b.checked).length + "/" + bs.length);
  ok("有课时「开始」按钮可点", d.getElementById("startBtn").disabled === false);
  ok("已选数量提示正确", /已选 6 \/ 6/.test(d.getElementById("ctrlMsg").textContent), d.getElementById("ctrlMsg").textContent);
  ok("显示当前生效配置", /单线/.test(d.getElementById("cfgHint").textContent), d.getElementById("cfgHint").textContent);
  ok("默认不限时·全时段", /不限时|全时段/.test(d.getElementById("cfgHint").textContent), d.getElementById("cfgHint").textContent);

  console.log("\n=== ② 取消 2 门 → 只能传剩下 4 门（这就是原 bug）===");
  started.length = 0;
  // 取消「高等数学」和「人工智能通识课」
  const idxHigh = COURSES.findIndex((c) => c.title === "高等数学");
  const idxAI = COURSES.findIndex((c) => c.title.indexOf("人工智能") >= 0);
  for (const i of [idxHigh, idxAI]) {
    bs[i].checked = false;
    bs[i].dispatchEvent(new w.Event("change"));
  }
  await sleep(30);
  ok("提示变成已选 4 门", /已选 4 \/ 6/.test(d.getElementById("ctrlMsg").textContent), d.getElementById("ctrlMsg").textContent);

  d.getElementById("startBtn").click();
  await sleep(120);
  const body1 = started[0];
  ok("确实调用了开始接口", !!body1);
  const ids1 = (body1 && body1.courseIds) || [];
  ok("只传 4 门，不是 6 门", ids1.length === 4, "传了 " + ids1.length + " 门: " + ids1.join(","));
  ok("不包含高等数学", ids1.indexOf("267000001") === -1);
  ok("不包含人工智能", ids1.indexOf("267000002") === -1);
  ok("包含其余 4 门", ["111111111", "222222222", "333333333", "444444444"].every((id) => ids1.indexOf(id) >= 0));

  console.log("\n=== ③ 只取消 1 门 → 只传 5 门 ===");
  started.length = 0;
  {
    const p = await newPage();
    const b2 = boxes(p.d);
    b2[0].checked = false;
    b2[0].dispatchEvent(new p.w.Event("change"));
    await sleep(30);
    p.d.getElementById("startBtn").click();
    await sleep(120);
    const ids2 = (p.started[0] && p.started[0].courseIds) || [];
    ok("传 5 门", ids2.length === 5, "传了 " + ids2.length + " 门");
    ok("被取消的那门不在里面", ids2.indexOf(COURSES[0].courseId) === -1);
  }

  console.log("\n=== ④ 全不选 → 必须拒绝，不能偷偷刷全部 ===");
  started.length = 0;
  {
    const p = await newPage();
    await sleep(60);
    p.d.getElementById("selNone").click();
    await sleep(30);
    const all = boxes(p.d);
    ok("全不选后勾选框全部为空", all.every((b) => !b.checked));
    ok("全不选时「开始」按钮被禁用", p.d.getElementById("startBtn").disabled === true);
    p.d.getElementById("startBtn").click();
    await sleep(150);
    ok("没有发出开始请求", p.started.length === 0, "请求数 " + p.started.length);
    ok("页面给出了提示", /至少勾选一门/.test(p.d.getElementById("ctrlMsg").textContent), p.d.getElementById("ctrlMsg").textContent);
  }

  console.log("\n=== ⑤ 全选 → 传 6 门 ===");
  {
    const p = await newPage();
    await sleep(60);
    p.d.getElementById("selNone").click();
    await sleep(20);
    p.d.getElementById("selAll").click();
    await sleep(20);
    p.d.getElementById("startBtn").click();
    await sleep(120);
    const ids = (p.started[0] && p.started[0].courseIds) || [];
    ok("传 6 门", ids.length === 6, "传了 " + ids.length + " 门");
  }

  console.log("\n=== ⑥ 课程列表为空时不允许启动 ===");
  {
    const p = await newPage([]); // 空课程列表
    await sleep(80);
    p.d.getElementById("startBtn").click();
    await sleep(150);
    ok("空课程列表时拒绝启动", p.started.length === 0, "请求数 " + p.started.length);
    ok("给出提示", /刷新|加载/.test(p.d.getElementById("ctrlMsg").textContent), p.d.getElementById("ctrlMsg").textContent);
  }

  console.log("\n=== ⑦ 配置里的「跳过课程」生效（默认不勾，且标注）===");
  {
    const p = await newPage(COURSES, { dailyHours: 3, brushStart: 7, brushEnd: 23, skipCourse: "高等数学,人工智能通识课" });
    await sleep(90);
    const b = boxes(p.d);
    const boxOf = (title) => b[COURSES.findIndex((c) => c.title === title)];
    ok("高等数学默认未勾选", boxOf("高等数学").checked === false);
    ok("人工智能默认未勾选", boxOf("人工智能通识课").checked === false);
    ok("其它课程仍默认勾选", boxOf("国家安全教育").checked === true);
    ok("列表里标了「跳过」", /跳过/.test(p.d.getElementById("coursePick").textContent));
    ok("提示为已选 4/6", /已选 4 \/ 6/.test(p.d.getElementById("ctrlMsg").textContent), p.d.getElementById("ctrlMsg").textContent);
    p.d.getElementById("startBtn").click();
    await sleep(150);
    const ids = (p.started[0] && p.started[0].courseIds) || [];
    ok("开始只传 4 门", ids.length === 4, "传了 " + ids.length + " 门");
    ok("不含被跳过的两门", ids.indexOf("267000001") === -1 && ids.indexOf("267000002") === -1);
  }

  console.log("\n=== ⑧ 用户主动勾上被跳过的课 → 以勾选为准 ===");
  {
    const p = await newPage(COURSES, { dailyHours: 3, brushStart: 7, brushEnd: 23, skipCourse: "高等数学" });
    await sleep(90);
    const b = boxes(p.d);
    const idx = COURSES.findIndex((c) => c.title === "高等数学");
    b[idx].checked = true;
    b[idx].dispatchEvent(new p.w.Event("change"));
    await sleep(30);
    p.d.getElementById("startBtn").click();
    await sleep(150);
    const ids = (p.started[0] && p.started[0].courseIds) || [];
    ok("主动勾选后会被传上去", ids.indexOf("267000001") >= 0, "传了 " + ids.length + " 门");
  }

  console.log("\n" + "=".repeat(46));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(46));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试异常:", e && e.stack || e); process.exit(1); });
