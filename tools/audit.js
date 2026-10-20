/**
 * 程序全面自检
 *   node tools/audit.js
 *
 * 检查项：语法 / 模块加载 / 加密 / 页面 / 全部接口 / 拟人化默认值 / 打包完整性 / 部署脚本
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0, warn = 0;
const fails = [];
const warns = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✔ " + name + (detail ? "  " + detail : "")); }
  else { fail++; fails.push(name + (detail ? "  " + detail : "")); console.log("  ✖ " + name + (detail ? "  " + detail : "")); }
  return cond;
}
function warning(name, detail) { warn++; warns.push(name + "  " + detail); console.log("  ⚠ " + name + "  " + detail); }
function section(t) { console.log("\n=== " + t + " ==="); }

const sleep = (t) => new Promise((r) => setTimeout(r, t));

function httpGet(port, p, headers) {
  return new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers: headers || {}, timeout: 8000 }, (x) => {
      let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => res({ code: x.statusCode, body: b }));
    });
    r.on("error", rej); r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); }); r.end();
  });
}
function httpPost(port, p, obj, headers) {
  return new Promise((res, rej) => {
    const data = Buffer.from(JSON.stringify(obj || {}), "utf8");
    const r = http.request({ host: "127.0.0.1", port, path: p, method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": data.length }, headers || {}), timeout: 10000 },
      (x) => { let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => res({ code: x.statusCode, body: b })); });
    r.on("error", rej); r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); });
    r.write(data); r.end();
  });
}

(async () => {
  // ---------- A 语法 ----------
  section("A. 语法检查");
  const jsFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js") && f !== "build-exe.js");
  for (const f of jsFiles) {
    try { execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" }); pass++; }
    catch (e) { fail++; fails.push("语法错误: " + f); console.log("  ✖ 语法错误: " + f + "  " + String(e.stderr || e.message).slice(0, 120)); }
  }
  console.log("  检查了 " + jsFiles.length + " 个文件");

  // ---------- B 模块加载 ----------
  section("B. 模块加载");
  process.env.ENC_KEY = "audit-test-key-123456";
  const mods = ["session.js", "course.js", "courseTask.js", "player.js", "logger.js", "quizAgent.js", "crypto-util.js", "humanize.js", "loginer.js", "config.js", "local-server.js"];
  for (const m of mods) {
    try { require(path.join(ROOT, m)); ok(m, true); }
    catch (e) { ok(m, false, e.message); }
  }

  // ---------- C 加密 ----------
  section("C. 加密存储");
  try {
    delete require.cache[require.resolve(path.join(ROOT, "crypto-util.js"))];
    const cu = require(path.join(ROOT, "crypto-util.js"));
    const enc = cu.encrypt("TestPass123.");
    ok("ENC_KEY 加密往返", cu.decrypt(enc.slice(4)) === "TestPass123.");
    ok("密文带 ENC: 前缀", enc.startsWith("ENC:"));
    // 换密钥应解不开
    process.env.ENC_KEY = "another-key-987654";
    delete require.cache[require.resolve(path.join(ROOT, "crypto-util.js"))];
    const cu2 = require(path.join(ROOT, "crypto-util.js"));
    let bad = false;
    try { cu2.decrypt(enc.slice(4)); } catch (e) { bad = true; }
    ok("错误密钥无法解密", bad);
    process.env.ENC_KEY = "audit-test-key-123456";
    delete require.cache[require.resolve(path.join(ROOT, "crypto-util.js"))];
  } catch (e) { ok("加密模块", false, e.message); }

  // ---------- D 拟人化 ----------
  section("D. 拟人化默认值");
  try {
    delete require.cache[require.resolve(path.join(ROOT, "humanize.js"))];
    const { Humanizer } = require(path.join(ROOT, "humanize.js"));
    const hz = new Humanizer({});
    ok("默认开启", hz.enabled === true);
    ok("章节间隔 3~8s", hz.gapMinMs >= 2000 && hz.gapMaxMs <= 12000, `${hz.gapMinMs / 1000}~${hz.gapMaxMs / 1000}s`);
    ok("每小时上限 ≤150", hz.maxPerHour <= 150, `${hz.maxPerHour} 章节/小时`);
    ok("超限最多等 5 分钟", hz.maxWaitMs <= 5 * 60000, `${hz.maxWaitMs / 60000} 分钟`);
    ok("小憩周期 ≤25 章", hz.microEvery <= 25, `每 ${hz.microEvery} 章`);
    ok("长休间隔 ≤120 分钟", hz.longAfterMs <= 120 * 60000, `每 ${hz.longAfterMs / 60000} 分钟`);
    ok("弹题思考 3~8s", hz.quizMinMs >= 2000 && hz.quizMaxMs <= 12000, `${hz.quizMinMs / 1000}~${hz.quizMaxMs / 1000}s`);
    ok("默认不限时段 0~24", hz.activeStart === 0 && hz.activeEnd === 24, `${hz.activeStart}~${hz.activeEnd}`);
  } catch (e) { ok("拟人化模块", false, e.message); }

  // ---------- E 任务装配 ----------
  section("E. 任务装配（拟人化是否真的生效）");
  try {
    const Session = require(path.join(ROOT, "session.js"));
    const CourseTask = require(path.join(ROOT, "courseTask.js"));
    const s = new Session({ cookie: "a=1" });
    const t = new CourseTask(s, { parallel: 4, speed: 2, log: () => {} });
    ok("并发被强制为 1", t.parallel === 1, `实际 ${t.parallel}`);
    ok("player 拿到 humanizer", !!t.player.hz);
    ok("player 速度锁 1x", t.player.speed === 1, `实际 ${t.player.speed}x`);
    const t2 = new CourseTask(s, { humanMode: false, parallel: 3, log: () => {} });
    ok("关闭拟人化后恢复并发", t2.parallel === 3, `实际 ${t2.parallel}`);
    // 逐个任务点还会再设一次速度，必须也受拟人化开关约束，否则课程放开倍速时会跑 2x
    const srcTask = fs.readFileSync(path.join(ROOT, "courseTask.js"), "utf8");
    const guards = (srcTask.match(/!this\.hz\.enabled && job\.doublespeed/g) || []).length;
    ok("倍速锁 1x（含逐任务点赋值）", guards >= 2, `找到 ${guards} 处保护`);
  } catch (e) { ok("任务装配", false, e.message); }

  // ---------- F 页面 ----------
  section("F. 网页");
  try {
    const html = fs.readFileSync(path.join(ROOT, "web", "multi.html"), "utf8");
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    let syntaxOk = true;
    scripts.forEach((sc) => { try { new Function(sc); } catch (e) { syntaxOk = false; } });
    ok("内联脚本语法", syntaxOk, `${scripts.length} 个块`);
    const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...html.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));
    const missing = [...used].filter((x) => !defined.has(x));
    ok("元素 id 引用完整", missing.length === 0, missing.join(",") || `${defined.size} 个 id`);
    ok("无乱码字符", !html.includes("\uFFFD"));
    ok("页面有代理输入框", defined.has("proxy"));
    // exe 用的是 web-page.js 里内嵌的副本，必须和源码同步，否则本地版界面会是旧的
    try {
      delete require.cache[require.resolve(path.join(ROOT, "web-page.js"))];
      const embedded = require(path.join(ROOT, "web-page.js"));
      ok("exe 内嵌页面与源码同步", embedded === html.replace(/\r\n/g, "\n"), embedded.length + " 字符");
    } catch (e) {
      ok("exe 内嵌页面存在", false, e.message);
    }
    if (/innerHTML\s*=/.test(html)) {
      // 页面用 innerHTML 拼 HTML，但外部数据必须都过 esc()
      const hasEsc = /function\s+esc\s*\(/.test(html);
      const logEscaped = /esc\(l\)/.test(html);
      const titleEscaped = /esc\(c\.title\)/.test(html);
      ok("外部数据已转义", hasEsc && logEscaped && titleEscaped,
        `esc定义=${hasEsc} 日志=${logEscaped} 课程名=${titleEscaped}`);
    }
  } catch (e) { ok("网页检查", false, e.message); }

  // ---------- G 打包 ----------
  section("G. 部署包完整性");
  try {
    const tgz = path.join(ROOT, "dist", "chaoxing-cloud.tar.gz");
    ok("压缩包存在", fs.existsSync(tgz), fs.existsSync(tgz) ? (fs.statSync(tgz).size / 1024).toFixed(1) + " KB" : "");
    const list = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" });
    const need = ["server-multi.js", "session.js", "loginer.js", "course.js", "courseTask.js",
      "player.js", "logger.js", "quizAgent.js", "crypto-util.js", "humanize.js", "config.js",
      "package.json", "web/multi.html", "deploy/deploy.sh"];
    const missing = need.filter((n) => !list.includes("chaoxing-cloud/" + n));
    ok("必需文件齐全", missing.length === 0, missing.join(", ") || `${need.length} 个`);
    ok("未打包本地配置", !/chaoxing-cloud\/config\.json$/.test(list));
    ok("未打包 node_modules", !list.includes("node_modules"));
  } catch (e) { ok("打包检查", false, e.message); }

  // ---------- H 部署脚本 ----------
  section("H. 部署脚本");
  try {
    const sh = fs.readFileSync(path.join(ROOT, "deploy", "deploy.sh"), "utf8");
    ok("纯 LF 换行", !sh.includes("\r"));
    ok("有 shebang", sh.startsWith("#!/usr/bin/env bash"));
    ok("set -euo pipefail", sh.includes("set -euo pipefail"));
    ok("apt 锁重试", sh.includes("apt_retry"));
    ok("Node 三级兜底", sh.includes("deb.nodesource.com") && sh.includes("nodejs.org/dist"));
    const exclData = /--exclude=['"]?\.\/data/.test(sh);
    const exclEnv = /--exclude=['"]?\.\/\.env/.test(sh);
    ok("保护 data/.env", exclData && exclEnv, `data=${exclData} env=${exclEnv}`);
    ok("注册 systemd", sh.includes("systemctl enable"));
    ok("使用解析到的 node", sh.includes("ExecStart=$NODE_BIN"));
    ok("设置北京时间", sh.includes("Asia/Shanghai"));
  } catch (e) { ok("部署脚本检查", false, e.message); }

  // ---------- I 接口 ----------
  section("I. 服务端接口");
  const PORT = 8123;
  const child = spawn(process.execPath, [path.join(ROOT, "server-multi.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_PASSWORD: "auditpw", ENC_KEY: "audit-test-key-123456", MAX_RUNNING: "5" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let srvOut = "";
  child.stdout.on("data", (d) => (srvOut += d));
  child.stderr.on("data", (d) => (srvOut += d));
  await sleep(1600);

  try {
    const h = await httpGet(PORT, "/health");
    ok("/health", h.code === 200);
    const p = await httpGet(PORT, "/");
    ok("首页 200", p.code === 200 && p.body.length > 5000, `${p.body.length} 字节`);
    ok("首页含登录表单", p.body.includes('id="uname"') && p.body.includes('id="password"'));

    const s401 = await httpGet(PORT, "/api/state");
    ok("/api/state 未登录 401", s401.code === 401);
    const st401 = await httpPost(PORT, "/api/start", {});
    ok("/api/start 未登录 401", st401.code === 401);
    const se401 = await httpPost(PORT, "/api/settings", { parallel: 8 });
    ok("/api/settings 未登录 401", se401.code === 401);

    const a0 = await httpGet(PORT, "/api/admin/users");
    ok("admin 无密码 403", a0.code === 403);
    const a1 = await httpGet(PORT, "/api/admin/users?pwd=bad");
    ok("admin 错密码 403", a1.code === 403);
    const a2 = await httpGet(PORT, "/api/admin/users?pwd=auditpw");
    ok("admin 对密码 200", a2.code === 200 && JSON.parse(a2.body).ok === true);

    const bad = await httpPost(PORT, "/api/login", { uname: "", password: "" });
    ok("登录空参数被拒", bad.code === 200 && JSON.parse(bad.body).ok === false);
    const notFound = await httpGet(PORT, "/api/nope");
    ok("未知接口 404/401", notFound.code === 404 || notFound.code === 401, `HTTP ${notFound.code}`);
  } catch (e) {
    ok("接口测试", false, e.message);
  }
  child.kill();
  await sleep(300);
  if (/Error|throw/.test(srvOut) && !/监听端口/.test(srvOut)) warning("服务启动输出异常", srvOut.slice(0, 200));

  // ---------- 汇总 ----------
  console.log("\n" + "=".repeat(46));
  console.log(`  通过 ${pass}   失败 ${fail}   警告 ${warn}`);
  if (fails.length) { console.log("\n失败项:"); fails.forEach((f) => console.log("  - " + f)); }
  if (warns.length) { console.log("\n警告项:"); warns.forEach((w) => console.log("  - " + w)); }
  console.log("=".repeat(46));
  process.exit(fail > 0 ? 1 : 0);
})();
