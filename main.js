/**
 * 超星学习通自动刷课 - 入口（2026 版协议）
 *
 * 用法:
 *   npm start                    读 config.json 直接刷
 *   npm start -- --yes           无交互
 *   npm start -- --speed 2       倍速
 *   npm start -- --course 高等数学  只刷指定课程
 *   npm start -- --dry           只探测不真上报
 *   npm start -- --list          只列课程
 *   npm start -- --cookie "..."  用指定 cookie
 */
const path = require("path");
const Config = require("./config.js");
const Loginer = require("./loginer.js");
const Session = require("./session.js");
const CourseData = require("./course.js");
const CourseTask = require("./courseTask.js");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};

async function main() {
  console.log("========================================");
  console.log("  超星学习通全自动刷课  v2.0 (2026协议)");
  console.log("========================================\n");

  const cfgPath = path.resolve(__dirname, "config.json");
  const cfg = await new Config(cfgPath).read();

  // 命令行覆盖
  const cliSpeed = opt("--speed");
  if (cliSpeed) cfg.speed = parseFloat(cliSpeed);
  const cliCookie = opt("--cookie");
  if (cliCookie) cfg.saveCookie = cliCookie;
  cfg.dryRun = has("--dry");
  cfg.onlyCourse = opt("--course");
  if (opt("--skip")) cfg.skipCourse = opt("--skip");
  const cliInterval = opt("--interval");
  if (cliInterval) cfg.reportInterval = parseInt(cliInterval, 10);
  const cliParallel = opt("--parallel");
  if (cliParallel) cfg.parallel = parseInt(cliParallel, 10);

  // 登录
  let cookie = cfg.saveCookie;
  if (!cookie || String(cookie).trim().length < 10) {
    const lo = new Loginer(cfg);
    cookie = await lo.login();
  } else {
    console.log("[main] 使用 config.json 中的 cookie");
  }

  const session = new Session({ cookie, debug: cfg.debug });
  console.log("[main] uid=" + session.uid + "  fid=" + session.fid);

  // 只列课程
  if (has("--list")) {
    const list = await CourseData.list(session, { courseType: 1 });
    console.log("\n=========== 我学的课 ===========");
    list.forEach((c, i) => console.log(`${String(i).padStart(2)}  ${c.title}  (courseId=${c.courseId}, clazzId=${c.clazzId})`));
    console.log("================================\n共 " + list.length + " 门");
    return;
  }

  const speed = Number(cfg.speed) || 1;
  console.log(`[main] 倍速=${speed}  并发=${cfg.parallel || 3}  上报间隔=${cfg.reportInterval || 60}s${cfg.dryRun ? "  (dry-run)" : ""}\n`);

  const task = new CourseTask(session, cfg);
  await task.run();

  try {
    if (cfg.write) await cfg.write();
  } catch (e) {}
}

main().catch((e) => {
  console.error("\n[main] 运行失败:", e && e.message ? e.message : e);
  process.exit(1);
});
