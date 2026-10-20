/**
 * 生成可分发版：把最终版本打成别人拿到就能用的压缩包
 *   node tools/make-release.js
 *
 * 产物：
 *   dist/超星刷课-云端版-v1.0-飞飞.zip    （服务器上解压 → bash deploy.sh）
 *   dist/chaoxing-cloud.tar.gz            （同一份内容，Linux 用）
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const STAGE_ROOT = path.join(DIST, "release");
const VERSION = require(path.join(ROOT, "version.js"));
const VER = "v" + VERSION.cloudVersion;
const BRAND = "飞飞";
const NAME = `超星刷课-云端版-${VER}-${BRAND}`;
const STAGE = path.join(STAGE_ROOT, NAME);
const ZIP = path.join(DIST, NAME + ".zip");

function rm(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

console.log("① 重新打包程序 …");
execFileSync(process.execPath, [path.join(__dirname, "pack-cloud.js")], { stdio: "inherit" });

console.log("\n② 组装分发目录 …");
rm(STAGE_ROOT);
fs.mkdirSync(STAGE, { recursive: true });

// 程序本体
const APP_SRC = path.join(DIST, "云端部署包", "chaoxing-cloud");
fs.cpSync(APP_SRC, STAGE, { recursive: true });

// 部署脚本提到根目录，解压后一条命令即可
const DEPLOY = path.join(STAGE, "deploy", "deploy.sh");
if (fs.existsSync(DEPLOY)) {
  fs.copyFileSync(DEPLOY, path.join(STAGE, "一键部署.sh"));
}

// 文档（有的在根目录，有的在 deploy 下）
for (const d of ["云端部署手册.md", "阿里云新手操作.md", "IP方案.md"]) {
  const src = [path.join(ROOT, d), path.join(ROOT, "deploy", d)].find((p) => fs.existsSync(p));
  if (!src) { console.log("  ⚠ 缺文档: " + d); continue; }
  fs.copyFileSync(src, path.join(STAGE, d));
}

// 给同学的说明
fs.writeFileSync(
  path.join(STAGE, "使用说明.txt"),
  [
    "================================================",
    `  超星刷课 云端版 ${VER}        作者：${BRAND}`,
    "================================================",
    "",
    "【这个包是什么】",
    "  一个可以在服务器上跑的刷课网站。装好之后，你和同学用浏览器",
    "  打开一个网址，填自己的超星账号密码，勾课、点开始就行。",
    "  关掉网页不影响，后台继续刷。",
    "",
    "【怎么装】（服务器需 Ubuntu，root 身份执行）",
    "  1. 把这个文件夹整个上传到服务器，例如 /root",
    "  2. cd /root/" + NAME,
    "  3. bash 一键部署.sh",
    "  4. 装完屏幕上会打印访问地址和管理员密码，记下来",
    "",
    "  有域名的话：",
    "     bash 一键部署.sh --domain 你的域名.com --email 你的邮箱",
    "  （会自动配 nginx + 免费 HTTPS 证书）",
    "",
    "【日常维护】",
    "  systemctl status chaoxing      看状态",
    "  systemctl restart chaoxing     重启",
    "  tail -f /opt/chaoxing/logs/out.log     看日志",
    "  cat /opt/chaoxing/.env         看管理员密码",
    "",
    "【已经内置的安全机制】",
    "  · 章节间随机停顿 8~20 秒，每 12 章休息 1~3 分钟",
    "  · 每 55 分钟长休 5~15 分钟",
    "  · 每小时最多 35 个章节",
    "  · 只在 07:00~23:00 工作，其余时间待机",
    "  · 弹题延迟 8~25 秒作答（不像机器）",
    "  · 强制单路 + 强制 1 倍速",
    "  · 每日时长上限",
    "  这些是为了降低被超星判为异常的风险，不要为了快而关掉。",
    "",
    "【出问题看这里】",
    "  打不开网页   → 阿里云安全组有没有放行 8080",
    "  登录失败     → 别反复试密码，超星会锁号 87 分钟",
    "  进度不涨     → 看日志有没有『风控拦截』，有就停 6~24 小时再试",
    "",
    "  ⚠ 服务器换成机房 IP 后，超星可能封 IP。判断方法：",
    "     同一账号在自家宽带上能正常刷，换服务器就不行 → 是 IP 问题，",
    "     不是账号问题，也不是程序问题。",
    "",
    "================================================",
    `  本程序由 ${BRAND} 开发维护，请勿转卖`,
    "  联系邮箱：cc040921f@gmail.com",
    "================================================",
    "",
  ].join("\r\n"),
  "utf8"
);

console.log("③ 生成压缩包 …");
rm(ZIP);
execFileSync("tar", ["-a", "-cf", ZIP, "-C", STAGE_ROOT, NAME], { stdio: "inherit" });

const kb = (fs.statSync(ZIP).size / 1024).toFixed(1);
console.log("");
console.log("✔ 分发版完成");
console.log("  " + ZIP + "  (" + kb + " KB)");
console.log("");
console.log("  压缩包内容:");
for (const f of fs.readdirSync(STAGE).sort()) {
  const st = fs.statSync(path.join(STAGE, f));
  console.log("    " + (st.isDirectory() ? "[目录] " : "       ") + f);
}
