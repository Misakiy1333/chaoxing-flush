/**
 * 远程一键部署：把 dist/chaoxing-cloud.tar.gz 传上去，解压，跑 deploy.sh
 *
 * 用法（密码登录）:
 *   set DEPLOY_HOST=1.2.3.4
 *   set DEPLOY_USER=root
 *   set DEPLOY_PASS=你的密码
 *   node tools/remote-deploy.js
 *
 * 带域名:
 *   node tools/remote-deploy.js --domain cx.example.com --email me@qq.com
 *
 * 用密钥登录（更安全）:
 *   set DEPLOY_KEY=C:\Users\你\.ssh\id_rsa
 *   node tools/remote-deploy.js
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("ssh2");

const ROOT = path.join(__dirname, "..");
const TGZ = path.join(ROOT, "dist", "chaoxing-cloud.tar.gz");

const HOST = process.env.DEPLOY_HOST || process.argv.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
const USER = process.env.DEPLOY_USER || "root";
const PASS = process.env.DEPLOY_PASS || "";
const KEY = process.env.DEPLOY_KEY || "";
const PORT = parseInt(process.env.DEPLOY_PORT || "22", 10);

// 传给 deploy.sh 的额外参数
const argv = process.argv.slice(2);
const extra = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--domain") { extra.push("--domain", argv[++i]); }
  else if (argv[i] === "--email") { extra.push("--email", argv[++i]); }
  else if (argv[i] === "--port-web") { extra.push("--port", argv[++i]); }
}

if (!HOST) {
  console.error("缺少服务器 IP。设置环境变量 DEPLOY_HOST=1.2.3.4 或直接作为参数传入。");
  process.exit(1);
}
if (!fs.existsSync(TGZ)) {
  console.error("找不到 " + TGZ + "，先跑 node tools/pack-cloud.js");
  process.exit(1);
}
if (!PASS && !KEY) {
  console.error("缺少认证信息：设置 DEPLOY_PASS 或 DEPLOY_KEY");
  process.exit(1);
}

const conn = new Client();

function run(cmd, label) {
  return new Promise((res, rej) => {
    conn.exec(cmd, { pty: false }, (err, stream) => {
      if (err) return rej(err);
      let code = 0;
      stream.on("close", (c) => { res(c == null ? code : c); });
      stream.on("data", (d) => process.stdout.write(d.toString("utf8")));
      stream.stderr.on("data", (d) => process.stderr.write(d.toString("utf8")));
      stream.on("exit", (c) => (code = c));
    });
  });
}

conn.on("ready", async () => {
  console.log("已连接 " + USER + "@" + HOST + ":" + PORT);
  try {
    // 1) 上传
    console.log("\n[1/3] 上传部署包 ...");
    const size = fs.statSync(TGZ).size;
    await new Promise((res, rej) => {
      conn.sftp((err, sftp) => {
        if (err) return rej(err);
        const remote = "/tmp/chaoxing-cloud.tar.gz";
        const rs = fs.createReadStream(TGZ);
        const ws = sftp.createWriteStream(remote);
        ws.on("close", () => { console.log("  已上传 " + (size / 1024).toFixed(1) + " KB → " + remote); res(); });
        ws.on("error", rej);
        rs.pipe(ws);
      });
    });

    // 2) 解压
    console.log("\n[2/3] 解压 ...");
    const c1 = await run("rm -rf /root/chaoxing-cloud && cd /root && tar -xzf /tmp/chaoxing-cloud.tar.gz && ls -1 /root/chaoxing-cloud | head -20", "extract");
    if (c1 !== 0) throw new Error("解压失败，退出码 " + c1);

    // 3) 部署
    console.log("\n[3/3] 执行部署脚本（装 Node / 依赖 / 服务，约需 2~4 分钟）...\n");
    const cmd = "cd /root/chaoxing-cloud && bash deploy/deploy.sh " + extra.join(" ");
    const c2 = await run(cmd, "deploy");
    if (c2 !== 0) throw new Error("部署脚本返回 " + c2 + "，请查看上面的输出");

    console.log("\n远程部署结束。");
  } catch (e) {
    console.error("\n失败: " + e.message);
    conn.end();
    process.exit(1);
  }
  conn.end();
});

conn.on("error", (e) => {
  console.error("连接失败: " + e.message);
  if (/authentication/i.test(e.message)) console.error("→ 密码错了，或者 sshd 不让 root 密码登录（腾讯云/部分镜像默认关闭）");
  process.exit(1);
});

conn.connect({
  host: HOST,
  port: PORT,
  username: USER,
  password: PASS || undefined,
  privateKey: KEY ? fs.readFileSync(KEY) : undefined,
  readyTimeout: 20000,
  tryKeyboard: true,
});

conn.on("keyboard-interactive", (name, desc, lang, prompts, finish) => {
  finish(prompts.map(() => PASS));
});
