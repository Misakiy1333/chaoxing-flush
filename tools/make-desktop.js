/**
 * 生成「本地版」分发压缩包（给同学双击用的 exe）
 *   node tools/make-desktop.js
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const VERSION = require(path.join(ROOT, "version.js"));
const VER = "v" + VERSION.version;
const BRAND = "飞飞";
const NAME = `超星刷课-本地版-${VER}-${BRAND}`;
const STAGE_ROOT = path.join(DIST, "release");
const STAGE = path.join(STAGE_ROOT, NAME);
const ZIP = path.join(DIST, NAME + ".zip");
// 极简版：只放 exe + 启动脚本 + 一页说明，解压双击就能用
const LEAN_NAME = `超星刷课-本地版-${VER}-${BRAND}-极简`;
const LEAN_STAGE = path.join(STAGE_ROOT, LEAN_NAME);
const LEAN_ZIP = path.join(DIST, LEAN_NAME + ".zip");

function rm(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

const EXE = path.join(DIST, "超星刷课.exe");
if (!fs.existsSync(EXE)) {
  console.error("找不到 dist\\超星刷课.exe，先跑 node build-exe.js");
  process.exit(1);
}

rm(STAGE);
fs.mkdirSync(STAGE, { recursive: true });

console.log("① 复制 exe …");
fs.copyFileSync(EXE, path.join(STAGE, "超星刷课.exe"));

// 用过的 dist\config.json 可能已写入真实账号，这里一律重写空白模板
console.log("② 写入空白配置模板 …");
fs.writeFileSync(
  path.join(STAGE, "config.json"),
  JSON.stringify({
    uname: "", password: "", speed: 1, test: true, pick: false, pickinfos: null,
    saveCookie: "", domain: "https://mooc1-1.chaoxing.com/", debug: false,
    updateUrl: VERSION.updateUrl,
    skipCourse: "", parallel: 1, dailyHours: 24, brushStart: 0, brushEnd: 24, fid: "-1",
  }, null, 1) + "\n",
  "utf8"
);

console.log("③ 写入启动脚本和说明 …");
fs.writeFileSync(
  path.join(STAGE, "双击启动.bat"),
  [
    "@echo off",
    "chcp 65001 >nul",
    "cd /d \"%~dp0\"",
    "start \"\" \"超星刷课.exe\"",
    "timeout /t 3 >nul",
    "start \"\" http://127.0.0.1:8765",
    "exit",
    "",
  ].join("\r\n"),
  "utf8"
);

fs.writeFileSync(
  path.join(STAGE, "使用说明.txt"),
  [
    "================================================",
    `  超星刷课助手 本地版 ${VER}       作者：${BRAND}`,
    "================================================",
    "",
    "【怎么用】",
    "  1. 双击「双击启动.bat」（或直接双击 超星刷课.exe）",
    "  2. 浏览器会自动打开 http://127.0.0.1:8765",
    "  3. 填超星手机号 + 密码 → 登录",
    "  4. 勾选要刷的课程 → 点「开始」",
    "",
    "  ⚠ 程序运行期间电脑不能关机、不能睡眠；可以锁屏，也可以最小化。",
    "",
    "【已经内置的防封节奏】",
    "  · 章节间随机停顿 8~20 秒",
    "  · 每 12 个章节休息 1~3 分钟",
    "  · 每 55 分钟长休 5~15 分钟",
    "  · 每小时最多 35 个章节",
    "  · 只在 07:00~23:00 工作",
    "  · 强制 1 倍速、强制单路",
    "  · 弹题延迟 8~25 秒作答",
    "",
    "  不要为了快而改这些参数，被风控封了要等 6~24 小时。",
    "",
    "【常见问题】",
    "  · 密码输错别反复试，超星会锁账号 87 分钟",
    "  · 进度不涨先看「日志」里有没有『风控拦截』",
    "  · 有就停掉，过几个小时再试，别硬刷",
    "  · 一天刷 3~4 小时就够，别连刷 14 小时",
    "",
    "【配置在哪】",
    "  同目录的 config.json，程序会自动读写，一般不用手动改。",
    "  密码是加密存的，而且绑定这台电脑，拷给别人也用不了。",
    "",
    "【更新地址】",
    "  config.json 里的 updateUrl 就是更新/公告服务地址：",
    "    " + VERSION.updateUrl,
    "  程序每次启动会去这里查有没有新版本和公告，连不上不影响刷课。",
    "",
    "================================================",
    `  本程序由 ${BRAND} 开发维护，请勿转卖`,
    "  联系邮箱：cc040921f@gmail.com",
    "================================================",
    "",
  ].join("\r\n"),
  "utf8"
);

// 附上风控说明，同学自己看
const fk = path.join(DIST, "风控说明.txt");
if (fs.existsSync(fk)) fs.copyFileSync(fk, path.join(STAGE, "风控说明.txt"));

console.log("④ 压缩 …");
rm(ZIP);
execFileSync("tar", ["-a", "-cf", ZIP, "-C", STAGE_ROOT, NAME], { stdio: "inherit" });

const mb = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(1);
console.log("");
console.log("✔ 本地版分发包: " + ZIP + "  (" + mb + " MB)");
for (const f of fs.readdirSync(STAGE)) {
  const st = fs.statSync(path.join(STAGE, f));
  console.log("    " + (st.isDirectory() ? "[目录] " : "       ") + f + "  " + (st.size / 1024).toFixed(0) + " KB");
}

// ---------- 极简版（给同学：解压 → 双击 → 完事）----------
console.log("\n⑤ 生成极简版 …");
rm(LEAN_STAGE);
fs.mkdirSync(LEAN_STAGE, { recursive: true });
fs.copyFileSync(EXE, path.join(LEAN_STAGE, "超星刷课.exe"));
fs.writeFileSync(
  path.join(LEAN_STAGE, "双击启动.bat"),
  [
    "@echo off",
    "chcp 65001 >nul",
    "cd /d \"%~dp0\"",
    "start \"\" \"超星刷课.exe\"",
    "timeout /t 3 >nul",
    "start \"\" http://127.0.0.1:8765",
    "exit",
    "",
  ].join("\r\n"),
  "utf8"
);
fs.writeFileSync(
  path.join(LEAN_STAGE, "看这里.txt"),
  [
    "================================================",
    `  超星刷课助手 ${VER}            飞飞 出品`,
    "  联系邮箱：cc040921f@gmail.com",
    "================================================",
    "",
    "【三步】",
    "  1. 双击「双击启动.bat」",
    "  2. 浏览器自动打开后，填超星手机号 + 密码，点登录",
    "  3. 勾要刷的课，点「开始刷课」",
    "",
    "【注意】",
    "  · 程序开着的时候电脑别关机、别睡眠；可以锁屏、可以最小化",
    "  · 一天刷 3~4 小时就够，别连着刷十几个小时，容易被系统限流",
    "  · 页面上的「风控状态」变红就停一会儿再开，别硬刷",
    "  · 配置会自动生成在同目录，别删；删了要重新登录",
    "  · 更新服务地址：" + VERSION.updateUrl + "（自动检查新版和公告）",
    "",
    "【卡住了】",
    "  · 双击后浏览器没反应 → 手动打开 http://127.0.0.1:8765",
    "  · 提示被 Windows 拦截 → 点「更多信息」→「仍要运行」",
    "  · 还是不行 → 发邮件到上面的邮箱",
    "",
    "================================================",
    "  请勿转卖",
    "================================================",
    "",
  ].join("\r\n"),
  "utf8"
);

rm(LEAN_ZIP);
execFileSync("tar", ["-a", "-cf", LEAN_ZIP, "-C", STAGE_ROOT, LEAN_NAME], { stdio: "inherit" });
console.log("✔ 极简版: " + LEAN_ZIP + "  (" + (fs.statSync(LEAN_ZIP).size / 1024 / 1024).toFixed(1) + " MB)");
for (const f of fs.readdirSync(LEAN_STAGE)) {
  console.log("    " + f + "  " + (fs.statSync(path.join(LEAN_STAGE, f)).size / 1024).toFixed(0) + " KB");
}
