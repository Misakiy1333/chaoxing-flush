/**
 * 探测章节页结构：看每章有没有「任务点总数 / 已完成数」字段
 *   node tools/probe-chapters.js
 *
 * 只读：进一次课程 + 拉一次章节页，不建立学习会话、不上报。
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const Session = require(path.join(ROOT, "session.js"));
const CourseData = require(path.join(ROOT, "course.js"));

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const INFO = { courseId: "444444444", clazzId: "888000002", cpi: "999000002", title: "实验室安全准入教育" };

(async () => {
  const s = new Session({ cookie: cfg.saveCookie, debug: false });
  const c = new CourseData(s, INFO);

  await c.open();
  console.log("① 进入课程 OK");

  const html = await (async () => {
    await c.getChapters();
    return c.chapterHtml || "";
  })();
  console.log("② 章节页长度 " + html.length);

  // 找章节项，打印第一个的完整结构
  const m = html.match(/<div[^>]*class="[^"]*chapter_item[^"]*"[\s\S]{0,1600}/);
  if (m) {
    console.log("\n=== 第一个章节项（前 1600 字）===");
    console.log(m[0].replace(/\t/g, "  "));
  } else {
    console.log("\n没找到 chapter_item");
  }

  // 存一份样本，方便离线分析
  const sample = path.join(__dirname, "_chapter-sample.html");
  fs.writeFileSync(sample, html, "utf8");
  console.log("\n已保存样本: " + sample);

  // 定位最近一次探测到的第一个章节 id，打印它后面 2200 字
  const firstId = (html.match(/id="cur(\d+)"/) || [])[1];
  if (firstId) {
    const i = html.indexOf('id="cur' + firstId + '"');
    console.log("\n=== 章节 cur" + firstId + " 完整片段 ===");
    console.log(html.slice(Math.max(0, i - 200), i + 2200).replace(/\t/g, "  "));
  }

  // 统计所有可能的"任务点相关"属性名
  const attrs = new Set();
  const re = /(knowledge[A-Za-z]*|job[A-Za-z]*|finish[A-Za-z]*)\s*=\s*"([^"]*)"/gi;
  let x;
  while ((x = re.exec(html))) attrs.add(x[1] + " = \"" + x[2] + "\"");
  console.log("\n=== 页面里出现的任务点相关属性（去重，最多 25 条）===");
  Array.from(attrs).slice(0, 25).forEach((a) => console.log("  " + a));

  // 章节数
  const ids = [...html.matchAll(/id="cur(\d+)"/g)].map((x) => x[1]);
  console.log("\n章节数: " + ids.length);
})();
