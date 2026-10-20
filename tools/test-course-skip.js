/**
 * 「整门课已完成就整体跳过」验证
 *   node tools/test-course-skip.js
 *
 * 打桩：课程列表 / 章节列表都来自固定数据，studyChapter 直接抛错阻止联网。
 */
const path = require("path");
const ROOT = path.join(__dirname, "..");

const CourseData = require(path.join(ROOT, "course.js"));
const Session = require(path.join(ROOT, "session.js"));
const CourseTask = require(path.join(ROOT, "courseTask.js"));

let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}

// 三门课：A 全部完成 / B 部分完成 / C 全未完成
const COURSES = [
  { courseId: "A", title: "已刷完的课", clazzId: "1", cpi: "1" },
  { courseId: "B", title: "刷了一半的课", clazzId: "2", cpi: "1" },
  { courseId: "C", title: "没刷过的课", clazzId: "3", cpi: "1" },
];
const CHAPTERS = {
  A: [
    { kid: "a1", title: "A1", jobCount: 2, finished: true },
    { kid: "a2", title: "A2", jobCount: 1, finished: true },
  ],
  B: [
    { kid: "b1", title: "B1", jobCount: 1, finished: true },
    { kid: "b2", title: "B2", jobCount: 1, finished: false },
    { kid: "b3", title: "B3", jobCount: 0, finished: false }, // 无任务点
  ],
  C: [
    { kid: "c1", title: "C1", jobCount: 1, finished: false }, // 页面没标完成，但视频其实刷完了
    { kid: "c2", title: "C2", jobCount: 1, finished: false }, // 真没刷
  ],
};

// 各章节的任务点：playTime 到顶 = 已完成
const JOBS = {
  a1: [{ objectId: "oa1", attDuration: 600, playTime: 600000 }],
  a2: [{ objectId: "oa2", attDuration: 300, playTime: 300000 }],
  b2: [{ objectId: "ob2", attDuration: 400, playTime: 100000 }],
  c1: [{ objectId: "oc1", attDuration: 500, playTime: 500000 }], // 已刷完 → 扫描阶段应跳过
  c2: [{ objectId: "oc2", attDuration: 500, playTime: 0 }],      // 未刷
};

CourseData.list = async () => COURSES.map((x) => Object.assign({}, x));
CourseData.prototype.open = async function () { return this; };
CourseData.prototype.getChapters = async function () { return (CHAPTERS[this.cid] || []).map((x) => Object.assign({}, x)); };
CourseData.prototype.getVideoJobs = async function (kid) { return (JOBS[kid] || []).map((x) => Object.assign({ kid }, x)); };
CourseData.prototype.studyChapter = async function () { throw new Error("测试环境不联网"); };

async function runTask(cfg) {
  const logs = [];
  const s = new Session({ cookie: "t=1" });
  const task = new CourseTask(s, Object.assign(
    { humanMode: false, parallel: 1, dailyHours: 0, brushStart: 0, brushEnd: 24, scanDelay: 0, log: (l) => logs.push(String(l)) },
    cfg || {}
  ));
  let err = null;
  try { await task.run(); } catch (e) { err = e; }
  return { task, logs, err, text: logs.join("\n") };
}

(async () => {
  console.log("=== ① 三门课：A 整门完成、B 半完成、C 未开始 ===");
  {
    const r = await runTask({});
    ok("A 被判定整门完成", /已刷完的课: \d+ 章节，已完成 2，待刷 0　→ 整门已完成，跳过/.test(r.text),
      (r.text.match(/已刷完的课.*/) || [""])[0]);
    ok("B 只排 1 个待刷（已完成1 + 无任务点1 都排除）", /刷了一半的课: \d+ 章节，已完成 1，待刷 1/.test(r.text),
      (r.text.match(/刷了一半的课.*/) || [""])[0]);
    ok("C 扫描后只待刷 1 个", /没刷过的课: \d+ 章节，已完成 1，待刷 1/.test(r.text), (r.text.match(/没刷过的课.*/) || [""])[0]);
    ok("汇总里点名跳过了 A", /整门已完成 1 门，直接跳过：已刷完的课/.test(r.text), (r.text.match(/✔ 整门已完成.*/) || [""])[0]);
    ok("待处理章节 = B1 + C2 = 2", /待处理章节: 2 个（2 门课轮转交错）/.test(r.text), (r.text.match(/待处理章节.*/) || [""])[0]);
    ok("进度里 A 显示 2/2 已完成", (() => {
      const p = r.task.courseProgress["A"];
      return p && p.chaptersDone === 2 && p.chaptersPending === 2;
    })(), JSON.stringify(r.task.courseProgress["A"]));
    ok("进度里 C 显示 1/2（扫描发现 1 章已完成）", (() => {
      const p = r.task.courseProgress["C"];
      return p && p.chaptersDone === 1 && p.chaptersPending === 2;
    })(), JSON.stringify(r.task.courseProgress["C"]));
  }

  console.log("\n=== ② 只选了已完成的那门 —— 应直接结束，不做任何请求 ===");
  {
    const r = await runTask({ onlyCourse: ["A"] });
    ok("提示全部刷完", /所有选中的课程都已经刷完/.test(r.text), (r.text.match(/所有选中的课程.*/) || [""])[0]);
    ok("没有待处理章节", !/待处理章节: [1-9]/.test(r.text));
    ok("没有报错", !r.err, r.err && r.err.message);
    ok("统计里课程数为 1", r.task.stats.courses === 1, "实际 " + r.task.stats.courses);
  }

  console.log("\n=== ③ 页面没标完成，靠扫描发现视频已刷完 ===");
  {
    const backup = CHAPTERS.C;
    CHAPTERS.C = [{ kid: "c1", title: "C1", jobCount: 1 }, { kid: "c2", title: "C2", jobCount: 1 }];
    const r = await runTask({ onlyCourse: ["C"] });
    ok("扫描后只留 1 个待刷", /待刷 1/.test(r.text), (r.text.match(/没刷过的课.*/) || [""])[0]);
    ok("扫描过程有日志", /开始扫描 2 个待定章节/.test(r.text), (r.text.match(/开始扫描.*/) || [""])[0]);
    CHAPTERS.C = backup;
  }

  console.log("\n=== ④ jobCount 为 0 的章节不算待刷 ===");
  {
    const backup = CHAPTERS.C;
    CHAPTERS.C = [
      { kid: "c1", title: "C1", jobCount: 0, finished: false },
      { kid: "c2", title: "C2", jobCount: 0, finished: false },
    ];
    const r = await runTask({ onlyCourse: ["C"] });
    ok("无任务点 → 视为整门完成", /待刷 0　→ 整门已完成/.test(r.text), (r.text.match(/没刷过的课.*/) || [""])[0]);
    CHAPTERS.C = backup;
  }

  console.log("\n=== ⑤ 扫描阶段不发学习会话请求（只读任务点）===");
  {
    let studyCalls = 0;
    const origStudy = CourseData.prototype.studyChapter;
    CourseData.prototype.studyChapter = async function () { studyCalls++; throw new Error("不联网"); };
    const r = await runTask({ onlyCourse: ["A"] }); // A 全完成，扫描都不该发生
    ok("全完成的课程一次 studyChapter 都不调", studyCalls === 0, studyCalls + " 次");
    ok("也没有扫描日志（已完成章节不探测）", !/开始扫描/.test(r.text));
    CourseData.prototype.studyChapter = origStudy;
  }

  console.log("\n" + "=".repeat(46));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(46));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试异常:", (e && e.stack) || e); process.exit(1); });
