/**
 * 「已完成视频必须跳过」的回归测试
 *   node tools/test-skip.js
 *
 * 背景：朋友反馈有些刷完的课没跳过。原因有两个：
 *   1) getVideoJobs 没带 isPassed 字段
 *   2) readProgress 只读第一页第一个视频，多视频章节 objectId 对不上 → 从 0 重刷
 */
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { isVideoDone } = require(path.join(ROOT, "course.js"));
const Player = require(path.join(ROOT, "player.js"));

let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}

console.log("=== isVideoDone 判定 ===");
const cases = [
  ["isPassed 为真", { isPassed: true }, true],
  ["播放位置毫秒制到顶", { attDuration: 600, playTime: 600000 }, true],
  ["播放位置秒制到顶", { attDuration: 600, playTime: 600 }, true],
  ["差 1 秒（容差内）", { attDuration: 600, playTime: 599 }, true],
  ["差 2 秒（容差边界）", { attDuration: 600, playTime: 598 }, true],
  ["差 3 秒（未完成）", { attDuration: 600, playTime: 597 }, false],
  ["只播了一半", { attDuration: 600, playTime: 590 }, false],
  ["播放位置为 0", { attDuration: 600, playTime: 0 }, false],
  ["时长为 0", { attDuration: 0, playTime: 500 }, false],
  ["空对象", null, false],
  ["超长视频（1 小时）", { attDuration: 3600, playTime: 3598000 }, true],
];
for (const [name, input, want] of cases) {
  const got = isVideoDone(input);
  ok(name, got === want, "期望 " + want + "，实际 " + got);
}

console.log("\n=== player 跳过路径（不该发任何请求）===");
(async () => {
  // 模拟：任何网络调用都算失败
  const session = {};
  const reporter = { send: async () => { throw new Error("跳过路径不应上报"); } };
  const logs = [];
  const player = new Player(session, reporter, { log: (l) => logs.push(l) });

  const course = {
    readProgress: async () => { throw new Error("跳过路径不应读进度"); },
    getStatus: async () => { throw new Error("跳过路径不应请求状态"); },
    getQuizData: async () => { throw new Error("跳过路径不应取题"); },
  };

  // ① 任务点自带完成标记
  const r1 = await player.play(course, { name: "已看完.mp4", objectId: "a1", kid: "k1", attDuration: 300, playTime: 300000 }, () => {});
  ok("任务点已完成 → 跳过", r1.skipped === true && r1.isPassed === true);
  ok("跳过时不发请求", true, logs.length + " 条日志");

  // ② 任务点没标记，但回读进度显示到顶
  const course2 = {
    readProgress: async () => ({ objectId: "a2", playTime: 299, attDuration: 300, isPassed: false }),
    getStatus: async () => { throw new Error("不应请求状态"); },
  };
  const r2 = await player.play(course2, { name: "续播到顶.mp4", objectId: "a2", kid: "k2", attDuration: 300, playTime: 0 }, () => {});
  ok("进度到顶 → 跳过", r2.skipped === true && r2.isPassed === true);

  // ③ objectId 不匹配时不能误判跳过（避免串位）
  let getStatusCalled = false;
  const course3 = {
    readProgress: async () => ({ objectId: "别的视频", playTime: 300, attDuration: 300, isPassed: true }),
    getStatus: async () => { getStatusCalled = true; return { duration: 60 }; },
  };
  const player3 = new Player(session, { send: async () => ({ ok: true, isPassed: false, status: 200 }) }, { log: () => {}, interval: 60 });
  try {
    await player3.play(course3, { name: "另一个视频.mp4", objectId: "a3", kid: "k3", attDuration: 60, playTime: 0 }, () => {});
  } catch (e) {}
  ok("objectId 不匹配时不误跳过", getStatusCalled === true);

  // ④ 播放中途强制停止：必须在 1.5 秒内返回（之前要等一个 65 秒心跳）
  const player4 = new Player(session, { send: async () => ({ ok: true, isPassed: false, status: 200 }) }, { log: () => {}, interval: 65 });
  const course4 = {
    readProgress: async () => null,
    getStatus: async () => ({ duration: 3600 }),
    getQuizData: async () => [],
  };
  const t0 = Date.now();
  const playing = player4.play(course4, { name: "长视频.mp4", objectId: "a4", kid: "k4", attDuration: 3600, playTime: 0 }, () => {});
  setTimeout(() => player4.stop(), 400);
  const r4 = await playing;
  const elapsed = Date.now() - t0;
  ok("停止能在 1.5 秒内生效", elapsed < 1500, elapsed + "ms");
  ok("停止后返回未完成", r4 && r4.isPassed === false);

  console.log("\n" + "=".repeat(44));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(44));
  process.exit(fail ? 1 : 0);
})();
