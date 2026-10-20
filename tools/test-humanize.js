/**
 * humanize.js 单元自测（用极小的数字，秒级完成）
 *   node tools/test-humanize.js
 */
const path = require("path");
const { Humanizer, hourCST, minuteCST } = require(path.join(__dirname, "..", "humanize.js"));

let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const logs = [];
const log = (l) => { logs.push(l); console.log(l); };

(async () => {
  console.log("=== ① 时段窗口 ===");
  console.log("  当前北京时间: " + String(hourCST()).padStart(2, "0") + ":" + String(minuteCST()).padStart(2, "0"));
  {
    const h = hourCST();
    const hz = new Humanizer({
      activeStart: h, activeEnd: (h + 2) % 24,
      chapterGapMin: 0.05, chapterGapMax: 0.1,
      microBreakEvery: 2, microBreakMin: 0.02, microBreakMax: 0.03,
      sessionBreakAfterMin: 999, log,
    });
    const t0 = Date.now();
    await hz.waitActiveWindow();
    ok("窗口内立即返回", Date.now() - t0 < 500, (Date.now() - t0) + "ms");

    const gaps = [];
    for (let i = 0; i < 3; i++) {
      const a = Date.now();
      await hz.beforeChapter();
      gaps.push(Date.now() - a);
      await hz.afterChapter();
    }
    ok("章节间隔在设定区间", gaps.every((g) => g >= 45 && g <= 130), gaps.join(", ") + "ms");
    ok("小憩会触发", logs.filter((l) => l.includes("休息")).length >= 1);
  }

  console.log("\n=== ② 默认值（不该太激进） ===");
  {
    const hz = new Humanizer({});
    ok("章节间隔 2~5s", hz.gapMinMs >= 2000 && hz.gapMinMs <= 5000, hz.gapMinMs / 1000 + "s");
    ok("章节最大间隔 5~12s", hz.gapMaxMs >= 5000 && hz.gapMaxMs <= 12000, hz.gapMaxMs / 1000 + "s");
    ok("每小时 ≤150 章", hz.maxPerHour <= 150, hz.maxPerHour + " 章/小时");
    ok("小憩周期 ≤25 章", hz.microEvery <= 25, "每 " + hz.microEvery + " 章");
    ok("长休 ≤120 分钟", hz.longAfterMs <= 120 * 60000, "每 " + hz.longAfterMs / 60000 + " 分钟");
    ok("弹题 2~12 秒", hz.quizMinMs >= 2000 && hz.quizMaxMs <= 12000, hz.quizMinMs / 1000 + "~" + hz.quizMaxMs / 1000 + "s");
    ok("超限最多等 5 分钟", hz.maxWaitMs <= 5 * 60000, hz.maxWaitMs / 60000 + " 分钟");
    ok("不限时段 0~24", hz.activeStart === 0 && hz.activeEnd === 24, hz.activeStart + "~" + hz.activeEnd);
    ok("默认启用", hz.enabled === true);
  }

  console.log("\n=== ③ 额度退回（跳过的不计数） ===");
  {
    const hz = new Humanizer({ maxChaptersPerHour: 1, chapterGapMin: 0, chapterGapMax: 0, maxWaitMin: 0.02, log });
    await hz.beforeChapter(); // 占掉唯一额度
    hz.refund();              // 模拟「整章已完成，跳过」
    const t1 = Date.now();
    await hz.beforeChapter(); // 退回后应立刻通过
    const e1 = Date.now() - t1;
    ok("退额度后立即通过", e1 < 400, e1 + "ms");

    const t2 = Date.now();
    await hz.beforeChapter(); // 这次不退，撞上限
    const e2 = Date.now() - t2;
    ok("超限时最多等 maxWaitMin，不会卡几十分钟", e2 < 5000, e2 + "ms");
  }

  console.log("\n=== ④ 可中断 ===");
  {
    const hz = new Humanizer({ chapterGapMin: 30, chapterGapMax: 30, log });
    const t0 = Date.now();
    const p = hz.beforeChapter();
    setTimeout(() => hz.stop(), 200);
    await p;
    ok("stop() 能打断长等待", Date.now() - t0 < 1500, (Date.now() - t0) + "ms");
  }

  console.log("\n" + "=".repeat(46));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(46));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试异常:", (e && e.stack) || e); process.exit(1); });
