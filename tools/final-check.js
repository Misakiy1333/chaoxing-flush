/**
 * 最终回归：配置完整性 + 四个测试套件 + 线上状态
 *   node tools/final-check.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HOST = process.env.DEPLOY_HOST || "";
let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}

function get(p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: HOST, port: 8080, path: p, method: "GET", timeout: 20000 }, (x) => {
      let b = "";
      x.on("data", (c) => (b += c));
      x.on("end", () => res({ code: x.statusCode, body: b, headers: x.headers }));
    });
    r.on("error", rej);
    r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); });
    r.end();
  });
}

function runSuite(name, args) {
  try {
    const out = execFileSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 240000 });
    const m = out.match(/通过 (\d+)\s+失败 (\d+)/);
    if (!m) return ok(name, false, "无结果输出");
    ok(name, Number(m[2]) === 0, `通过 ${m[1]} / 失败 ${m[2]}`);
  } catch (e) {
    const out = String(e.stdout || "");
    const m = out.match(/通过 (\d+)\s+失败 (\d+)/);
    ok(name, false, m ? `通过 ${m[1]} / 失败 ${m[2]}` : "异常退出");
  }
}

(async () => {
  console.log("=== ① 本机配置完整性 ===");
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")); } catch (e) {}
  ok("config.json 是合法 JSON", !!cfg);
  if (cfg) {
    ok("账号已保存", !!cfg.uname, cfg.uname);
    ok("密码是密文", String(cfg.password).startsWith("ENC:"));
    ok("没有明文密码", JSON.stringify(cfg).indexOf("TestPass123") === -1);
    ok("cookie 已保存", String(cfg.saveCookie).length > 100, String(cfg.saveCookie).length + " 字符");
    ok("中文课程名正常", /高等数学/.test(cfg.skipCourse || ""), cfg.skipCourse);
    const cu = require(path.join(ROOT, "crypto-util.js"));
    let dec = "";
    try { dec = cu.decrypt(String(cfg.password).slice(4)); } catch (e) {}
    ok("密码能解密（本机）", !!dec, dec ? "长度 " + dec.length : "解密失败");
  }

  console.log("\n=== ② 测试套件 ===");
  runSuite("程序自检 audit", [path.join(ROOT, "tools", "audit.js")]);
  runSuite("选课 test-pick（真实 DOM）", [path.join(ROOT, "tools", "test-pick.js")]);
  runSuite("跳过课程 test-skipcourse", [path.join(ROOT, "tools", "test-skipcourse.js")]);
  runSuite("服务端 test-server", [path.join(ROOT, "tools", "test-server.js")]);
  runSuite("登录 test-login（离线）", [path.join(ROOT, "tools", "test-login.js")]);
  runSuite("本地登录 test-local-login", [path.join(ROOT, "tools", "test-local-login.js")]);
  runSuite("本地服务 test-local", [path.join(ROOT, "tools", "test-local.js")]);
  runSuite("跳过/停止 test-skip", [path.join(ROOT, "tools", "test-skip.js")]);
  runSuite("角色渲染 test-role", [path.join(ROOT, "tools", "test-role.js")]);
  runSuite("断点续刷 test-resume", [path.join(ROOT, "tools", "test-resume.js")]);
  runSuite("章节测验/作业 + 正确率 test-work", [path.join(ROOT, "tools", "test-work.js")]);

  console.log("\n=== ③ 线上状态 ===");
  if (!HOST) {
    console.log("  （未设置 DEPLOY_HOST，跳过线上检查）");
  } else try {
    const h = await get("/health");
    ok("云端 /health", h.code === 200);
    const v = await get("/api/version");
    let vj = JSON.parse(v.body);
    ok("云端版本接口", vj.ok === true, "v" + vj.version + " / 本地版 v" + vj.localVersion);
    ok("公告可用", !!(vj.announcement && vj.announcement.items.length), vj.announcement.title);
    ok("下载信息存在", !!vj.latest, "最新 v" + (vj.latest && vj.latest.version) + "，下载地址：" + ((vj.latest && vj.latest.downloadUrl) || "（未填，蓝奏云链接待发布）"));
    const p = await get("/");
    ok("云端首页", p.code === 200 && p.body.length > 20000, p.body.length + " 字符");
    const d = await get("/download");
    ok("/download 路由存在", d.code === 302 || d.code === 404, "HTTP " + d.code);
    const me = await get("/api/me");
    ok("未登录访问被拒", me.code === 401);
  } catch (e) {
    ok("线上检查", false, e.message);
  }

  console.log("\n" + "=".repeat(50));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(50));
  process.exit(fail ? 1 : 0);
})();
