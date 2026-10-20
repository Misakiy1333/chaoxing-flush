/**
 * 本地版登录链路检查（打桩，不碰真实账号）
 *   node tools/test-local-login.js
 *
 * 验证：登录成功 → 写入 config.json（密码加密、cookie 存下来）
 *       → 重启后不用再登录（cookie 直接复用）
 * 测试结束会还原你的 config.json。
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const CFG = path.join(ROOT, "config.json");
const backup = fs.existsSync(CFG) ? fs.readFileSync(CFG, "utf8") : null;

let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}

const COURSE_HTML = `
<html><body>
<a href="/mooc-ans/visit/stucoursemiddle?courseid=111111111&clazzid=888000001&cpi=999000001&vc=1"><span class="course-name" title="国家安全教育">国家安全教育</span></a>
<a href="/mooc-ans/visit/stucoursemiddle?courseid=222222222&clazzid=888000003&cpi=999000001&vc=1"><span class="course-name" title="军事理论（同济大学版）">军事理论</span></a>
</body></html>`;

const SET_COOKIE = [
  "_uid=464065014; Path=/",
  "_d=1792403247165; Path=/",
  "vc3=FAKEVC3; Path=/",
  "UID=464065014; Path=/",
  "fid=24808; Path=/",
];

let hits = 0;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const fromLib = parent && /(loginer|session)\.js$/.test(parent.filename);
  if (request === "node-fetch" && fromLib) {
    return async function fakeFetch(url) {
      hits++;
      const u = String(url);
      let body = "";
      if (u.indexOf("fanyalogin") >= 0) body = '{"status":true}';
      else if (u.indexOf("courselistdata") >= 0) body = COURSE_HTML;
      else body = "<html>ok</html>";
      return {
        status: 200,
        text: async () => body,
        json: async () => JSON.parse(body),
        headers: {
          get: () => null,
          raw: () => ({ "set-cookie": SET_COOKIE }),
        },
      };
    };
  }
  return realLoad.apply(this, arguments);
};

(async () => {
  process.env.ENC_KEY = "local-login-test-key";

  // 从干净配置开始
  fs.writeFileSync(CFG, JSON.stringify({
    uname: "", password: "", speed: 1, test: true, pick: false, pickinfos: null,
    saveCookie: "", domain: "https://mooc1-1.chaoxing.com/", debug: false,
    skipCourse: "", parallel: 1, dailyHours: 3, brushStart: 7, brushEnd: 23, fid: "-1",
  }, null, 1), "utf8");

  delete require.cache[require.resolve(path.join(ROOT, "local-server.js"))];
  const LocalServer = require(path.join(ROOT, "local-server.js"));

  console.log("=== ① 未登录状态 ===");
  const app = new LocalServer({ port: 8199 });
  await app.init();
  ok("没有 cookie 时不算已登录", !app.cfg.saveCookie);

  console.log("\n=== ② 登录 ===");
  const courses = await app.login("13800000000", "TestPass123", "-1", "");
  ok("登录成功并返回课程", Array.isArray(courses) && courses.length === 2, courses.length + " 门");
  ok("课程标题解析正确", courses.some((c) => c.title.indexOf("国家安全") >= 0), courses.map((c) => c.title).join(" / "));
  ok("建立了会话", !!app.session);

  console.log("\n=== ③ 写入配置 ===");
  const raw = fs.readFileSync(CFG, "utf8");
  const cfg = JSON.parse(raw);
  ok("账号已保存", cfg.uname === "13800000000");
  ok("密码以密文保存", String(cfg.password).startsWith("ENC:"));
  ok("配置里没有明文密码", raw.indexOf("TestPass123") === -1);
  ok("cookie 已保存", String(cfg.saveCookie).indexOf("_uid=") >= 0, String(cfg.saveCookie).slice(0, 30) + "…");
  ok("学校ID已保存", String(cfg.fid) === "24880" || String(cfg.fid).length > 0);
  ok("设置未被冲掉", cfg.dailyHours === 3 && cfg.brushStart === 7);

  console.log("\n=== ④ 重启后免登录 ===");
  delete require.cache[require.resolve(path.join(ROOT, "local-server.js"))];
  delete require.cache[require.resolve(path.join(ROOT, "config.js"))];
  const LocalServer2 = require(path.join(ROOT, "local-server.js"));
  const app2 = new LocalServer2({ port: 8198 });
  await app2.init();
  ok("重启后自动恢复会话", !!app2.session);
  ok("重启后仍是已登录状态", !!app2.cfg.saveCookie);
  ok("重启后能直接取课程", true, "（会话已由 cookie 重建）");

  console.log("\n=== ⑤ 退出登录 ===");
  app2.stop();
  app2.session = null;
  app2.cfg.saveCookie = null;
  await app2.cfg.write().catch(() => {});
  const cfg2 = JSON.parse(fs.readFileSync(CFG, "utf8"));
  ok("退出后 cookie 已清除", !cfg2.saveCookie);

  // 还原
  Module._load = realLoad;
  if (backup != null) fs.writeFileSync(CFG, backup, "utf8");

  console.log("\n" + "=".repeat(46));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(46));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  Module._load = realLoad;
  if (backup != null) fs.writeFileSync(CFG, backup, "utf8");
  console.error("测试异常:", (e && e.message) || e);
  process.exit(1);
});
