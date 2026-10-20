/**
 * 本地单点探测（用家里 IP），和服务器上的探测结果对比，
 * 用来判断风控是「账号级」还是「IP 级」
 *   node tools/probe-local.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const Session = require(path.join(ROOT, "session.js"));
const CourseData = require(path.join(ROOT, "course.js"));

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const INFO = { courseId: "111111111", clazzId: "888000001", cpi: "999000001", title: "国家安全教育" };

const t0 = Date.now();
const ms = () => "[" + ((Date.now() - t0) / 1000).toFixed(1) + "s] ";

(async () => {
  const s = new Session({ cookie: cfg.saveCookie, debug: false });
  const c = new CourseData(s, INFO);

  try {
    await c.open();
    console.log(ms() + "① 进入课程 OK, enc=" + String(c.enc).slice(0, 12) + "...");
  } catch (e) {
    console.log(ms() + "① 进入课程失败: " + e.message + (e.blocked ? "  [风控]" : ""));
    return;
  }

  let chs;
  try {
    chs = await c.getChapters();
    console.log(ms() + "② 章节列表 OK: " + chs.length + " 个");
  } catch (e) {
    console.log(ms() + "② 章节列表失败: " + e.message + (e.blocked ? "  [风控]" : ""));
    return;
  }

  const last = chs[chs.length - 1];
  const kid = last && (last.kid || last);
  console.log(ms() + "③ 测试章节 kid=" + kid);

  try {
    await c.studyChapter(kid);
    console.log(ms() + "④ 学习会话 OK");
  } catch (e) {
    console.log(ms() + "④ 学习会话失败: " + e.message + (e.blocked ? "  [风控]" : ""));
  }

  try {
    const cards = await c.getCards(kid, 0);
    const n = (String(cards).match(/jobid/g) || []).length;
    console.log(ms() + "⑤ 任务点读取 OK, jobid 次数=" + n);
  } catch (e) {
    console.log(ms() + "⑤ 任务点读取失败: " + e.message + (e.blocked ? "  [风控]" : ""));
  }
})();
