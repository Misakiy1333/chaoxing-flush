/**
 * 工具：登录并列出账号下所有课程（用于确认 cookie 有效 / 拿到 clazzId）
 * 用法: npm run list
 */
const path = require("path");
const Config = require("../config.js");
const Loginer = require("../loginer.js");
const Net = require("../net.js");
const CourseList = require("../courselist.js");

(async () => {
  const cfg = await new Config(path.resolve(__dirname, "..", "config.json")).read();
  const loginer = new Loginer(cfg);
  const cookie = await loginer.login();
  const uid = loginer.extractUid(cookie);

  const net = new Net(cfg.domain, { debug: cfg.debug });
  await net.loadCookieString(cookie);

  const user = { userid: uid, cookie, net };
  const list = await new CourseList(user).getList();

  console.log("\n=========== 课程列表 ===========");
  if (!list.length) {
    console.log("未获取到课程。可能 cookie 失效或接口结构变更。");
  }
  list.forEach((c, i) => {
    console.log(`${String(i).padStart(2)}  clazzId=${c.clazzId}  courseId=${c.courseId}  ${c.title}`);
  });
  console.log("================================\n");
  console.log(`共 ${list.length} 门课程`);
  console.log(`当前 cookie: ${cookie}\n`);
})().catch((e) => {
  console.error("失败:", e && e.message ? e.message : e);
  process.exit(1);
});
