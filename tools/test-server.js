/**
 * 服务端本地自测（不需要真的登录超星）
 *   node tools/test-server.js
 *
 * 做法：临时往 data/users.json 写一个带 sid 的测试用户，验证
 *   Cookie 鉴权 / SSE 实时推送 / 状态接口 / 401 / 管理员 等路径，
 * 跑完自动还原 users.json。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const USERS = path.join(DATA, "users.json");
const PORT = 8124;
const SID = "test-sid-1234567890abcdef";
const SID2 = "admin-sid-1234567890abcdef";

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✔ " + name + (detail ? "  " + detail : "")); }
  else { fail++; fails.push(name); console.log("  ✖ " + name + (detail ? "  " + detail : "")); }
}

function req(method, p, opts) {
  opts = opts || {};
  return new Promise((res, rej) => {
    const data = opts.body ? Buffer.from(JSON.stringify(opts.body), "utf8") : null;
    const headers = Object.assign({}, opts.headers || {});
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers, timeout: 8000 }, (x) => {
      let b = "";
      x.on("data", (c) => (b += c));
      x.on("end", () => res({ code: x.statusCode, body: b, headers: x.headers }));
    });
    r.on("error", rej);
    r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); });
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (t) => new Promise((r) => setTimeout(r, t));

(async () => {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  const backup = fs.existsSync(USERS) ? fs.readFileSync(USERS, "utf8") : null;
  const WL = path.join(DATA, "whitelist.json");
  const wlBackup = fs.existsSync(WL) ? fs.readFileSync(WL, "utf8") : null;

  // 造两个测试用户：testuser 普通，adminuser 管理员
  const now = Date.now();
  const lastState = {
    stats: { courses: 4, chapters: 10, videos: 8, passed: 7, failed: 1, skipped: 0, quiz: 0 },
    ui: { active: [{ course: "国家安全教育", chapter: "1.1 总体国家安全观", video: "1.1.mp4", playingTime: 120, duration: 600, pct: 20 }] },
    courses: [{ courseId: "1", title: "国家安全教育", chaptersTotal: 69, chaptersPending: 60, chaptersDone: 12, videosPassed: 7, videosFailed: 1 }],
    risk: { level: "ok", blockHits: 0, coolingUntil: 0, lastBlockAt: 0, note: "" },
    time: { usedMs: 600000 },
  };
  fs.writeFileSync(USERS, JSON.stringify({
    users: {
      testuser: {
        uname: "testuser", encPassword: "", cookie: "fake=1;", fid: "-1", sid: SID,
        lastLogin: now, dailyHours: 3, brushStart: 7, brushEnd: 23, lastState,
      },
      adminuser: {
        uname: "adminuser", encPassword: "", cookie: "fake=2;", fid: "-1", sid: SID2,
        lastLogin: now, dailyHours: 24, brushStart: 0, brushEnd: 24, lastState,
      },
    },
  }, null, 1), "utf8");

  const child = spawn(process.execPath, [path.join(ROOT, "server-multi.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_PASSWORD: "testadmin", ENC_KEY: "test-key-12345678", MAX_RUNNING: "5", ADMIN_USERS: "adminuser" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  await sleep(1800);

  const CK = { Cookie: "sid=" + SID };

  try {
    console.log("\n=== 基础 ===");
    const h = await req("GET", "/health");
    ok("/health 200", h.code === 200 && h.body === "ok");
    const p = await req("GET", "/");
    ok("首页 200", p.code === 200 && p.body.length > 8000, p.body.length + " 字节");
    ok("首页含新仪表盘元素", /totalBar|courseGrid|riskPill/.test(p.body));
    ok("首页有署名和邮箱", /飞飞/.test(p.body) && /cc040921f@gmail\.com/.test(p.body));
    ok("首页有公告容器和版本行", /annCard/.test(p.body) && /verLine/.test(p.body));

    console.log("\n=== 版本 / 公告 ===");
    const v = await req("GET", "/api/version");
    let vj = null;
    try { vj = JSON.parse(v.body); } catch (e) {}
    ok("/api/version 公开可访问", v.code === 200 && vj && vj.ok === true);
    ok("含版本号", !!(vj && vj.version), vj && vj.version);
    ok("含公告内容", !!(vj && vj.announcement && vj.announcement.items && vj.announcement.items.length), vj && vj.announcement && vj.announcement.title);
    ok("含本地版版本供更新检查", !!(vj && vj.localVersion), vj && vj.localVersion);
    const av = await req("POST", "/api/admin/announce", { body: { title: "x" } });
    ok("发公告需要管理员密码", av.code === 403);

    console.log("\n=== 鉴权 ===");
    const me401 = await req("GET", "/api/me");
    ok("无 Cookie /api/me 401", me401.code === 401);
    const c401 = await req("GET", "/api/courses");
    ok("无 Cookie /api/courses 401", c401.code === 401);
    const s401 = await req("GET", "/api/state");
    ok("无 Cookie /api/state 401", s401.code === 401);
    const st401 = await req("POST", "/api/start", { body: {} });
    ok("无 Cookie /api/start 401", st401.code === 401);

    console.log("\n=== Cookie 鉴权（持久登录态）===");
    const me = await req("GET", "/api/me", { headers: CK });
    ok("带 sid /api/me 200", me.code === 200);
    const meJ = JSON.parse(me.body);
    ok("返回正确用户名", meJ.uname === "testuser");
    ok("返回设置", meJ.settings && meJ.settings.dailyHours === 3, JSON.stringify(meJ.settings));

    const st = await req("GET", "/api/state", { headers: CK });
    ok("带 sid /api/state 200", st.code === 200);
    const sj = JSON.parse(st.body);
    ok("state 含 courses 进度", Array.isArray(sj.courses) && sj.courses.length === 1);
    ok("state 含 risk", sj.risk && typeof sj.risk.level === "string", sj.risk && sj.risk.level);
    ok("state 含 time", !!sj.time);
    ok("state 含 ui.active", sj.ui && sj.ui.active && sj.ui.active.length === 1);
    ok("state 含 settings", !!sj.settings);

    console.log("\n=== SSE 实时推送 ===");
    const frame = await new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: PORT, path: "/api/events", method: "GET", headers: CK }, (x) => {
        let buf = "";
        x.on("data", (c) => {
          buf += c;
          if (buf.indexOf("\n\n") >= 0) { x.destroy(); resolve({ ct: x.headers["content-type"], body: buf }); }
        });
      });
      r.on("error", () => {});
      r.end();
      setTimeout(() => reject(new Error("SSE 超时")), 6000);
    });
    ok("SSE Content-Type 正确", /text\/event-stream/.test(frame.ct || ""), frame.ct);
    ok("SSE 首帧是合法 JSON", /^data: \{/.test(frame.body.trim()), frame.body.slice(0, 40));

    console.log("\n=== 设置 / 停止 ===");
    const se = await req("POST", "/api/settings", { headers: CK, body: { dailyHours: 2, brushStart: 8, brushEnd: 22 } });
    ok("/api/settings 保存成功", se.code === 200 && JSON.parse(se.body).ok === true);
    const me2 = JSON.parse((await req("GET", "/api/me", { headers: CK })).body);
    ok("设置已生效", me2.settings.dailyHours === 2 && me2.settings.brushStart === 8);
    const stop = await req("POST", "/api/stop", { headers: CK });
    ok("/api/stop 可用", stop.code === 200 && JSON.parse(stop.body).ok === true);

    console.log("\n=== 管理员 ===");
    const a0 = await req("GET", "/api/admin/users");
    ok("admin 无密码 403", a0.code === 403);
    const a1 = await req("GET", "/api/admin/users?pwd=testadmin");
    ok("admin 正确密码 200", a1.code === 200 && JSON.parse(a1.body).ok === true);
    const aj = JSON.parse(a1.body);
    ok("admin 能看到用户", aj.users.some((u) => u.uname === "testuser"));

    console.log("\n=== 账号白名单 ===");
    const wl0 = await req("GET", "/api/admin/whitelist?pwd=testadmin");
    let wj0 = null;
    try { wj0 = JSON.parse(wl0.body); } catch (e) {}
    ok("默认不限制（没白名单文件）", wl0.code === 200 && wj0 && wj0.whitelist.enabled === false, JSON.stringify(wj0 && wj0.whitelist));
    const wlNoPwd = await req("GET", "/api/admin/whitelist");
    ok("白名单接口需要管理员密码", wlNoPwd.code === 403);

    // 开启白名单但只放别人 → 当前用户应立刻被拒
    const wl1 = await req("POST", "/api/admin/whitelist?pwd=testadmin", { body: { enabled: true, unames: ["13800000000"] } });
    let wj1 = null;
    try { wj1 = JSON.parse(wl1.body); } catch (e) {}
    ok("能开启并写入名单", wl1.code === 200 && wj1 && wj1.ok && wj1.whitelist.enabled === true, JSON.stringify(wj1 && wj1.whitelist));
    const meBlocked = await req("GET", "/api/me", { headers: CK });
    let mb = null;
    try { mb = JSON.parse(meBlocked.body); } catch (e) {}
    ok("不在名单的账号被拒（403）", meBlocked.code === 403 && mb && mb.code === "not_whitelisted", "HTTP " + meBlocked.code);
    ok("提示信息可读", !!(mb && /未开通使用权限/.test(mb.error)), mb && mb.error);
    const loginBlocked = await req("POST", "/api/login", { body: { uname: "13900000000", password: "x" } });
    let lb = null;
    try { lb = JSON.parse(loginBlocked.body); } catch (e) {}
    ok("登录接口也拦（不会去试超星密码）", lb && lb.ok === false && lb.code === "not_whitelisted", lb && lb.error);

    // 把自己加进去 → 恢复
    const wl2 = await req("POST", "/api/admin/whitelist?pwd=testadmin", { body: { add: ["testuser"] } });
    let wj2 = null;
    try { wj2 = JSON.parse(wl2.body); } catch (e) {}
    ok("add 能追加", wl2.code === 200 && wj2 && wj2.whitelist.unames.indexOf("testuser") >= 0, JSON.stringify(wj2 && wj2.whitelist.unames));
    const meOk = await req("GET", "/api/me", { headers: CK });
    ok("加进名单后恢复访问", meOk.code === 200, "HTTP " + meOk.code);

    // 移除 → 再被拒
    const wl3 = await req("POST", "/api/admin/whitelist?pwd=testadmin", { body: { remove: ["testuser"] } });
    let wj3 = null;
    try { wj3 = JSON.parse(wl3.body); } catch (e) {}
    ok("remove 能移除", wl3.code === 200 && wj3 && wj3.whitelist.unames.indexOf("testuser") === -1);
    const meBlocked2 = await req("GET", "/api/me", { headers: CK });
    ok("移除后立即失效", meBlocked2.code === 403, "HTTP " + meBlocked2.code);

    // 关掉白名单 → 恢复
    const wl4 = await req("POST", "/api/admin/whitelist?pwd=testadmin", { body: { enabled: false } });
    const meOk2 = await req("GET", "/api/me", { headers: CK });
    ok("关闭白名单后恢复", wl4.code === 200 && meOk2.code === 200, "HTTP " + meOk2.code);

    console.log("\n=== 管理后台 ===");
    const ap = await req("GET", "/admin");
    ok("/admin 页面可访问", ap.code === 200 && /管理后台/.test(ap.body), ap.body.length + " 字节");
    const ovNoAuth = await req("GET", "/api/admin/overview");
    ok("总览接口需要权限（无登录无密码 403）", ovNoAuth.code === 403, "HTTP " + ovNoAuth.code);
    const ovPwd = await req("GET", "/api/admin/overview?pwd=testadmin");
    let ovj = null;
    try { ovj = JSON.parse(ovPwd.body); } catch (e) {}
    ok("用管理员密码能拿总览", ovPwd.code === 200 && ovj && ovj.ok === true);
    ok("总览含用户列表", !!(ovj && Array.isArray(ovj.users)));
    ok("总览含白名单/公告/版本", !!(ovj && ovj.whitelist && ovj.announce && ovj.version));
    const ovUser = await req("GET", "/api/admin/overview", { headers: CK });
    ok("普通账号登录态不能看总览", ovUser.code === 403, "HTTP " + ovUser.code);

    const ADCK = { Cookie: "sid=" + SID2 };
    const meAdmin = await req("GET", "/api/me", { headers: ADCK });
    let maj = null;
    try { maj = JSON.parse(meAdmin.body); } catch (e) {}
    ok("管理员账号 /api/me 带 isAdmin", maj && maj.isAdmin === true, JSON.stringify(maj && maj.isAdmin));
    const meNormal = await req("GET", "/api/me", { headers: CK });
    let mnj = null;
    try { mnj = JSON.parse(meNormal.body); } catch (e) {}
    ok("普通账号 isAdmin=false", mnj && mnj.isAdmin === false, JSON.stringify(mnj && mnj.isAdmin));
    const ovAdmin = await req("GET", "/api/admin/overview", { headers: ADCK });
    let oaj = null;
    try { oaj = JSON.parse(ovAdmin.body); } catch (e) {}
    ok("管理员登录态能直接看总览（不用再输密码）", ovAdmin.code === 200 && oaj && oaj.ok === true, "HTTP " + ovAdmin.code);
    ok("总览里能看到自己的管理员身份", !!(oaj && oaj.admins && oaj.admins.indexOf("adminuser") >= 0));
    const stopOther = await req("POST", "/api/admin/user-action?pwd=testadmin", { body: { uname: "testuser", action: "stop" } });
    ok("管理员能给指定账号发停止指令", stopOther.code === 200 && JSON.parse(stopOther.body).ok === true);
    const stopNoAuth = await req("POST", "/api/admin/user-action", { body: { uname: "testuser", action: "stop" } });
    ok("无权限时拒绝账号操作", stopNoAuth.code === 403, "HTTP " + stopNoAuth.code);

    console.log("\n=== 错误处理 ===");
    const bad = await req("POST", "/api/login", { body: { uname: "", password: "" } });
    ok("空参数被拒", JSON.parse(bad.body).ok === false);
    const nf = await req("GET", "/api/nope", { headers: CK });
    ok("未知接口 404", nf.code === 404);
  } catch (e) {
    fail++; fails.push("异常: " + e.message);
    console.log("  ✖ 测试异常: " + e.message);
  }

  child.kill();
  await sleep(300);

  // 还原
  if (backup != null) fs.writeFileSync(USERS, backup, "utf8");
  else try { fs.unlinkSync(USERS); } catch (e) {}
  if (wlBackup != null) fs.writeFileSync(WL, wlBackup, "utf8");
  else try { fs.unlinkSync(WL); } catch (e) {}

  console.log("\n" + "=".repeat(44));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) { console.log("  失败项: " + fails.join(", ")); }
  console.log("=".repeat(44));
  process.exit(fail ? 1 : 0);
})();
