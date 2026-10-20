/**
 * 跳过课程 / 只刷指定课程 的回归测试
 *   node tools/test-skipcourse.js
 *
 * 用打桩的课程列表跑 CourseTask.run()，检查筛选结果，
 * 全程不联网（课程入口被替换成直接抛错）。
 */
const path = require("path");
const ROOT = path.join(__dirname, "..");

const CourseData = require(path.join(ROOT, "course.js"));
const Session = require(path.join(ROOT, "session.js"));
const CourseTask = require(path.join(ROOT, "courseTask.js"));

const FIXTURES = [
  { courseId: "111111111", title: "国家安全教育", clazzId: "1", cpi: "1" },
  { courseId: "222222222", title: "军事理论（同济大学版）", clazzId: "2", cpi: "1" },
  { courseId: "267000002", title: "人工智能通识课（混合式课程）", clazzId: "3", cpi: "1" },
  { courseId: "333333333", title: "高校实验室安全通识课", clazzId: "4", cpi: "1" },
  { courseId: "267000001", title: "高等数学", clazzId: "5", cpi: "1" },
  { courseId: "444444444", title: "实验室安全准入教育", clazzId: "6", cpi: "1" },
];

let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}

// 打桩：课程列表固定；进入课程直接抛错（阻止联网）
CourseData.list = async () => FIXTURES.map((x) => Object.assign({}, x));
CourseData.prototype.open = async function () {
  throw new Error("测试环境不联网");
};

async function runTask(cfg) {
  const logs = [];
  const s = new Session({ cookie: "test=1" });
  const task = new CourseTask(s, Object.assign(
    { humanMode: false, parallel: 1, dailyHours: 0, brushStart: 0, brushEnd: 24, log: (l) => logs.push(String(l)) },
    cfg || {}
  ));
  let err = null;
  try { await task.run(); } catch (e) { err = e; }
  return { task, logs, err, text: logs.join("\n") };
}

(async () => {
  console.log("=== ① 不跳过：6 门全在 ===");
  {
    const r = await runTask({});
    ok("课程数 6", r.task.stats.courses === 6, "实际 " + r.task.stats.courses);
    ok("没有报错", !r.err, r.err && r.err.message);
    ok("日志里没有跳过提示", !/跳过课程设置生效/.test(r.text));
  }

  console.log("\n=== ② 按课程名跳过 2 门 ===");
  {
    const r = await runTask({ skipCourse: "高等数学,人工智能通识课" });
    ok("课程数 4", r.task.stats.courses === 4, "实际 " + r.task.stats.courses);
    ok("不含高等数学", r.text.indexOf("高等数学") === -1 || !/──.*高等数学/.test(r.text), "日志已排除");
    ok("不含人工智能", !/课程清单[\s\S]*人工智能/.test(r.text));
    ok("保留国家安全教育", /国家安全教育/.test(r.text));
    ok("打印了跳过提示", /跳过课程设置生效：已排除 2 门/.test(r.text), (r.text.match(/⏭.*/) || [""])[0]);
  }

  console.log("\n=== ③ 按 courseId 跳过 ===");
  {
    const r = await runTask({ skipCourse: "267000001" });
    ok("课程数 5", r.task.stats.courses === 5, "实际 " + r.task.stats.courses);
  }

  console.log("\n=== ④ 中文逗号 / 分号 / 空格混合 ===");
  {
    const r = await runTask({ skipCourse: " 高等数学，人工智能通识课 ； 军事理论 " });
    ok("课程数 3", r.task.stats.courses === 3, "实际 " + r.task.stats.courses);
    ok("排除了 3 门", /已排除 3 门/.test(r.text), (r.text.match(/⏭.*/) || [""])[0]);
  }

  console.log("\n=== ⑤ 只刷指定课程（页面勾选走的就是这条）===");
  {
    const r = await runTask({ onlyCourse: ["111111111", "444444444"] });
    ok("课程数 2", r.task.stats.courses === 2, "实际 " + r.task.stats.courses);
    ok("只含选中的两门", /国家安全教育/.test(r.text) && /实验室安全准入教育/.test(r.text));
    ok("不含未选的", !/──.*高等数学/.test(r.text));
  }

  console.log("\n=== ⑥ 只刷 + 跳过 叠加：跳过优先 ===");
  {
    const r = await runTask({ onlyCourse: ["111111111", "267000001"], skipCourse: "高等数学" });
    ok("课程数 1", r.task.stats.courses === 1, "实际 " + r.task.stats.courses);
    ok("剩下国家安全教育", /国家安全教育/.test(r.text) && !/──.*高等数学/.test(r.text));
  }

  console.log("\n=== ⑦ 全被跳过 → 必须报错而不是静默跑 0 门 ===");
  {
    const r = await runTask({ skipCourse: "国家安全教育,军事理论,人工智能,高校实验室,高等数学,实验室安全准入" });
    ok("抛出明确错误", !!r.err, r.err && r.err.message);
    ok("错误信息可读", !!(r.err && /匹配不到任何课程/.test(r.err.message)));
  }

  console.log("\n=== ⑧ 不存在的关键词不影响结果 ===");
  {
    const r = await runTask({ skipCourse: "不存在的课程名,另一个" });
    ok("课程数仍为 6", r.task.stats.courses === 6, "实际 " + r.task.stats.courses);
  }

  console.log("\n" + "=".repeat(46));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(46));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试异常:", (e && e.stack) || e); process.exit(1); });
