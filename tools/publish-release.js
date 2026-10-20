/**
 * 发布新版本到云端（上传安装包 + 更新版本号）
 *   set DEPLOY_PASS=xxx ADMIN_PWD=xxx
 *   node tools/publish-release.js dist\超星刷课-本地版-v3.6-飞飞-极简.zip 3.6 "修复了XXX"
 *
 * 做的事：
 *   1. 通过 SFTP 把 zip 传到服务器 data/release/
 *   2. 调 /api/admin/release 登记版本号
 *   3. 校验 /download 真的能下到同样大小的文件
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Client } = require("ssh2");

const HOST = process.env.DEPLOY_HOST || "";
const USER = process.env.DEPLOY_USER || "root";
const PASS = process.env.DEPLOY_PASS || "";
const ADMIN = process.env.ADMIN_PWD || "";
const REMOTE_DIR = "/opt/chaoxing/data/release";

const file = process.argv[2];
const version = process.argv[3];
const note = process.argv[4] || "";

if (!file || !version) {
  console.error("用法: node tools/publish-release.js <本地zip> <版本号> [说明]");
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error("文件不存在: " + file);
  process.exit(1);
}
if (!PASS) {
  console.error("缺少 DEPLOY_PASS");
  process.exit(1);
}

const base = path.basename(file);
const size = fs.statSync(file).size;

function post(p, body) {
  return new Promise((res, rej) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const r = http.request(
      { host: HOST, port: 8080, path: p, method: "POST", timeout: 30000,
        headers: { "Content-Type": "application/json", "Content-Length": data.length } },
      (x) => { let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => res({ code: x.statusCode, body: b })); }
    );
    r.on("error", rej);
    r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); });
    r.write(data);
    r.end();
  });
}

function probeDownload() {
  return new Promise((res, rej) => {
    const r = http.request({ host: HOST, port: 8080, path: "/download", method: "GET", timeout: 30000 }, (x) => {
      let got = 0;
      x.on("data", (c) => { got += c.length; if (got > 2 * 1024 * 1024) { x.destroy(); } });
      x.on("end", () => res({ code: x.statusCode, size: got, headers: x.headers }));
      x.on("close", () => res({ code: x.statusCode, size: got, headers: x.headers }));
    });
    r.on("error", () => res({ code: 0, size: 0 }));
    r.end();
  });
}

const conn = new Client();
conn.on("ready", () => {
  conn.sftp((err, sftp) => {
    if (err) { console.error("SFTP 失败: " + err.message); process.exit(1); }
    sftp.mkdir(REMOTE_DIR, { mode: 0o755 }, () => {
      console.log("① 上传 " + base + "  (" + (size / 1024 / 1024).toFixed(1) + " MB) …");
      let lastPct = 0;
      const ws = sftp.createWriteStream(REMOTE_DIR + "/" + base);
      const rs = fs.createReadStream(file);
      let sent = 0;
      rs.on("data", (c) => {
        sent += c.length;
        const pct = Math.floor((sent / size) * 100);
        if (pct >= lastPct + 25) { lastPct = pct; process.stdout.write("   " + pct + "%\n"); }
      });
      ws.on("close", async () => {
        console.log("   上传完成");
        console.log("\n② 登记版本 …");
        try {
          const r = await post("/api/admin/release?pwd=" + encodeURIComponent(ADMIN), {
            version, localFile: base, note,
          });
          const j = JSON.parse(r.body);
          console.log("   " + (j.ok ? "已发布 v" + j.release.version : "失败: " + j.error));
          if (j.ok) console.log("   托管: " + (j.release.hosted ? "是，本机文件" : "否") + "  大小: " + (j.release.size || 0) + " 字节");

          console.log("\n③ 校验下载 …");
          const d = await probeDownload();
          console.log("   /download → HTTP " + d.code + "  已接收 " + (d.size / 1024 / 1024).toFixed(1) + " MB");
          console.log("   " + (d.code === 200 && d.size > 1024 * 1024 ? "✔ 下载正常" : "✖ 下载异常"));
          console.log("\n下载地址: http://" + HOST + ":8080/download");
        } catch (e) {
          console.error("   登记失败: " + e.message);
        }
        conn.end();
        process.exit(0);
      });
      ws.on("error", (e) => { console.error("上传失败: " + e.message); conn.end(); process.exit(1); });
      rs.pipe(ws);
    });
  });
});
conn.on("error", (e) => { console.error("连接失败: " + e.message); process.exit(1); });
conn.connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
