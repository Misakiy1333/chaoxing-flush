/**
 * 打包云端部署文件，生成的 tar.gz 直接 scp 到服务器解压即可
 *   node tools/pack-cloud.js
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist", "云端部署包");
const STAGE = path.join(OUT, "chaoxing-cloud");
const TGZ = path.join(ROOT, "dist", "chaoxing-cloud.tar.gz");

// 只带运行必需的东西
const JS = [
  "server-multi.js", "session.js", "loginer.js", "course.js", "courseTask.js",
  "player.js", "logger.js", "quizAgent.js", "crypto-util.js", "config.js", "humanize.js", "version.js",
  // 章节测验/作业 + 正确率区间 + 在线答题源
  "answerer.js", "accuracy.js", "workAgent.js", "answerProvider.js",
];
// quizbank.json / workstate.json 是各自机器上的运行状态，不进包（避免覆盖服务器已积累的题库）
const EXTRA = ["package.json", "package-lock.json", "config.example.json"];
const DIRS = ["web", "deploy"];
const DOCS = ["README.md", "DEPLOY.md", "DEPLOY-多人版.md", "IP方案.md", "流量成本说明.md"];

function rm(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

rm(OUT);
fs.mkdirSync(STAGE, { recursive: true });

for (const f of [...JS, ...EXTRA]) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) { console.log("跳过（不存在）: " + f); continue; }
  fs.copyFileSync(src, path.join(STAGE, f));
}
for (const d of DIRS) {
  const src = path.join(ROOT, d);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(STAGE, d), { recursive: true });
}
for (const f of DOCS) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, f));
}
fs.mkdirSync(path.join(STAGE, "data"), { recursive: true });
fs.writeFileSync(path.join(STAGE, "data", ".gitkeep"), "");

// 顺手放一份部署说明在包根目录，解压就看到
const guide = path.join(ROOT, "deploy", "云端部署手册.md");
if (fs.existsSync(guide)) fs.copyFileSync(guide, path.join(STAGE, "云端部署手册.md"));

// 快速开始提示
fs.writeFileSync(
  path.join(STAGE, "解压后看这里.txt"),
  [
    "超星刷课 云端多人版",
    "",
    "在服务器上执行（root）：",
    "  cd /root/chaoxing-cloud",
    "  bash deploy/deploy.sh",
    "",
    "带域名 + 自动 HTTPS：",
    "  bash deploy/deploy.sh --domain 你的域名.com --email 你的邮箱",
    "",
    "详细步骤见：云端部署手册.md",
    "",
  ].join("\r\n"),
  "utf8"
);

rm(TGZ);
execFileSync("tar", ["-czf", TGZ, "-C", OUT, "chaoxing-cloud"], { stdio: "inherit" });

const size = (fs.statSync(TGZ).size / 1024).toFixed(1);
console.log("");
console.log("打包完成: " + TGZ + "  (" + size + " KB)");
console.log("解压目录: " + STAGE);

// 列一下内容
console.log("");
console.log("包含文件:");
for (const f of fs.readdirSync(STAGE).sort()) {
  const st = fs.statSync(path.join(STAGE, f));
  console.log("  " + (st.isDirectory() ? "[dir] " : "      ") + f);
}
