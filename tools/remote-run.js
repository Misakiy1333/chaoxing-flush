/**
 * 在远程服务器上执行命令 / 脚本
 *
 *   node tools/remote-run.js "单行命令"
 *   node tools/remote-run.js --file tools/diag.sh      # 上传脚本用 bash 执行，不怕引号换行
 */
const fs = require("fs");
const { Client } = require("ssh2");

const HOST = process.env.DEPLOY_HOST;
const USER = process.env.DEPLOY_USER || "root";
const PASS = process.env.DEPLOY_PASS || "";
const KEY = process.env.DEPLOY_KEY || "";
const PORT = parseInt(process.env.DEPLOY_PORT || "22", 10);

let CMD = null;
let SCRIPT = null;

const argv = process.argv.slice(2);
if (argv[0] === "--file") {
  SCRIPT = fs.readFileSync(argv[1], "utf8").replace(/\r\n/g, "\n");
} else {
  CMD = argv.join(" ");
}

if (!HOST || (!CMD && !SCRIPT)) {
  console.error("用法: set DEPLOY_HOST=... DEPLOY_PASS=... && node tools/remote-run.js \"命令\"");
  console.error("  或: node tools/remote-run.js --file tools/diag.sh");
  process.exit(1);
}

const conn = new Client();
conn.on("ready", () => {
  const execIt = (cmd) => {
    conn.exec(cmd, (err, stream) => {
      if (err) { console.error("执行失败: " + err.message); conn.end(); process.exit(1); }
      if (SCRIPT) { stream.end(SCRIPT); }
      stream.on("close", (c) => { conn.end(); process.exit(typeof c === "number" ? c : 0); });
      stream.on("data", (d) => process.stdout.write(d.toString("utf8")));
      stream.stderr.on("data", (d) => process.stderr.write(d.toString("utf8")));
    });
  };
  execIt(SCRIPT ? "bash -s" : CMD);
});
conn.on("error", (e) => { console.error("连接失败: " + e.message); process.exit(1); });
conn.connect({
  host: HOST, port: PORT, username: USER,
  password: PASS || undefined,
  privateKey: KEY ? fs.readFileSync(KEY) : undefined,
  readyTimeout: 20000,
});
