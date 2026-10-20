/**
 * 发布本地版下载地址（蓝奏云分享链接）
 *   node tools/set-release.js <分享链接> [版本号] [说明]
 */
const http = require("http");
const path = require("path");
const VERSION = require(path.join(__dirname, "..", "version.js"));

const HOST = process.env.DEPLOY_HOST || "";
const PWD = process.env.ADMIN_PWD || "";

const url = process.argv[2];
const ver = process.argv[3] || VERSION.version;
const note = process.argv[4] || "";

if (!url || !/^https?:\/\//.test(url)) {
  console.error("用法: node tools/set-release.js <蓝奏云分享链接> [版本号] [说明]");
  process.exit(1);
}

const body = JSON.stringify({ version: ver, downloadUrl: url, localFile: "", note });

function post(p, data) {
  return new Promise((res, rej) => {
    const b = Buffer.from(data, "utf8");
    const r = http.request(
      { host: HOST, port: 8080, path: p, method: "POST", timeout: 20000,
        headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": b.length } },
      (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => res({ code: x.statusCode, body: s })); }
    );
    r.on("error", rej); r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); });
    r.write(b); r.end();
  });
}

function get(p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: HOST, port: 8080, path: p, method: "GET", timeout: 20000 }, (x) => {
      res({ code: x.statusCode, loc: x.headers.location, body: x.statusCode === 302 ? "" : "..." });
      x.resume();
    });
    r.on("error", rej); r.end();
  });
}

(async () => {
  console.log("① 发布版本信息 …");
  const r = await post("/api/admin/release?pwd=" + encodeURIComponent(PWD), body);
  console.log("   HTTP " + r.code);
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) {}
  if (!j || !j.ok) {
    console.log("   ✖ 失败: " + (j && j.error || r.body.slice(0, 120)));
    process.exit(1);
  }
  console.log("   ✔ 已发布 v" + j.release.version);
  console.log("   下载地址: " + j.release.downloadUrl);
  console.log("   说明: " + (j.release.note || "(无)"));

  console.log("\n② 校验 /download 跳转 …");
  const d = await get("/download");
  console.log("   HTTP " + d.code + "  Location: " + (d.loc || "(无)"));
  console.log("   " + (d.code === 302 && d.loc === url ? "✔ 跳转正确" : "✖ 跳转异常"));

  console.log("\n③ 校验 /api/version …");
  const v = await get("/api/version");
  console.log("   (跳到上面看返回即可)");
})();
