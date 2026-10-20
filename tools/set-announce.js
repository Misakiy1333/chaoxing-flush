/**
 * 把 version.js 里的更新内容发布成线上公告
 *   node tools/set-announce.js [管理员密码]
 */
const http = require("http");
const path = require("path");
const VERSION = require(path.join(__dirname, "..", "version.js"));

const HOST = process.env.DEPLOY_HOST || "";
const PWD = process.argv[2] || process.env.ADMIN_PWD || "";

const body = JSON.stringify({
  id: VERSION.buildAt + "-" + VERSION.cloudVersion + "-" + String(Date.now()).slice(-5),
  title: "更新公告",
  date: VERSION.buildAt,
  items: VERSION.changelog,
});

const r = http.request(
  {
    host: HOST, port: 8080, path: "/api/admin/announce?pwd=" + encodeURIComponent(PWD),
    method: "POST", timeout: 20000,
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) },
  },
  (x) => {
    let b = "";
    x.on("data", (c) => (b += c));
    x.on("end", () => {
      console.log("HTTP " + x.statusCode);
      try {
        const j = JSON.parse(b);
        if (j.ok) {
          console.log("✔ 公告已发布（" + j.announcement.items.length + " 条）");
          j.announcement.items.forEach((it) => console.log("   · " + it));
        } else {
          console.log("✖ 失败: " + j.error);
        }
      } catch (e) {
        console.log(b.slice(0, 200));
      }
    });
  }
);
r.on("error", (e) => console.error("请求失败: " + e.message));
r.write(body);
r.end();
