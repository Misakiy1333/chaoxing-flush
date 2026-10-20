/**
 * 线上端到端验证：登录 → Cookie 持久 → 课程列表 → 启动 → 实时状态 → 停止
 *   set CHX_PASS=xxx && set DEPLOY_HOST=你的服务器IP && node tools/test-live.js
 */
const http = require("http");

const HOST = process.argv[2] || process.env.DEPLOY_HOST || "";
const PASS = process.env.CHX_PASS || "";
const UNAME = process.env.CHX_USER || "你的超星账号";
const TEST_COURSE = "444444444"; // 实验室安全准入教育，25 章节，最小

let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}
const sleep = (t) => new Promise((r) => setTimeout(r, t));

function req(method, p, opts) {
  opts = opts || {};
  return new Promise((res, rej) => {
    const data = opts.body ? Buffer.from(JSON.stringify(opts.body), "utf8") : null;
    const headers = Object.assign({}, opts.headers || {});
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
    const r = http.request({ host: HOST, port: 8080, path: p, method, headers, timeout: 90000 }, (x) => {
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
function jget(r) { try { return JSON.parse(r.body); } catch (e) { return null; } }

(async () => {
  console.log("=== ① 登录 ===");
  const li = await req("POST", "/api/login", { body: { uname: UNAME, password: PASS, fid: "-1" } });
  const lj = jget(li);
  ok("登录成功", li.code === 200 && lj && lj.ok, lj && lj.error);
  if (!lj || !lj.ok) { console.log("  无法继续"); process.exit(1); }
  ok("返回课程列表", Array.isArray(lj.courses) && lj.courses.length > 0, (lj.courses || []).length + " 门");

  const setCookie = [].concat(li.headers["set-cookie"] || []).join(";");
  const sidMatch = setCookie.match(/sid=([a-f0-9]+)/);
  ok("下发了持久 Cookie(sid)", !!sidMatch);
  ok("Cookie 带 HttpOnly", /HttpOnly/i.test(setCookie));
  ok("Cookie 有效期 30 天", /Max-Age=2592000/.test(setCookie));
  const CK = { Cookie: "sid=" + (sidMatch ? sidMatch[1] : "") };

  console.log("\n=== ② 刷新页面免登录（Cookie 鉴权）===");
  const me = jget(await req("GET", "/api/me", { headers: CK }));
  ok("用 Cookie 取到用户", me && me.uname === UNAME, me && me.uname);
  const cs = jget(await req("GET", "/api/courses", { headers: CK }));
  ok("用 Cookie 取到课程", cs && cs.ok && cs.courses.length > 0, (cs && cs.courses || []).length + " 门");

  console.log("\n=== ③ 启动任务 ===");
  const st = jget(await req("POST", "/api/start", { headers: CK, body: { courseIds: [TEST_COURSE] } }));
  ok("启动成功", st && st.ok, st && st.error);

  console.log("\n=== ④ 实时状态（SSE）===");
  const frames = [];
  await new Promise((resolve) => {
    const r = http.request({ host: HOST, port: 8080, path: "/api/events", method: "GET", headers: CK }, (x) => {
      let buf = "";
      x.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i).trim();
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) {
            try { frames.push(JSON.parse(chunk.slice(6))); } catch (e) {}
          }
          if (frames.length >= 3) { x.destroy(); resolve(); return; }
        }
      });
    });
    r.on("error", () => {});
    r.end();
    setTimeout(resolve, 12000);
  });
  ok("SSE 收到多帧", frames.length >= 2, frames.length + " 帧");
  const f = frames[frames.length - 1] || {};
  ok("帧里有 running 字段", typeof f.running === "boolean", String(f.running));
  ok("帧里有 risk", f.risk && typeof f.risk.level === "string", f.risk && f.risk.level);
  ok("帧里有 time", !!f.time, f.time ? Math.round((f.time.usedMs || 0) / 1000) + "s" : "");

  console.log("\n=== ⑤ 观察 70 秒，看进度与风控 ===");
  for (let i = 1; i <= 7; i++) {
    await sleep(10000);
    const s = jget(await req("GET", "/api/state", { headers: CK }));
    if (!s) continue;
    const c0 = (s.courses && s.courses[0]) || {};
    const cur = (s.ui && s.ui.active && s.ui.active[0]) || {};
    console.log(`   [${i * 10}s] 运行=${s.running} 通过=${(s.stats || {}).passed} 风控=${s.risk.level} | ${c0.title || "-"} 章节 ${c0.chaptersDone}/${c0.chaptersPending} | ${cur.video || ""}`);
  }
  const s2 = jget(await req("GET", "/api/state", { headers: CK }));
  ok("课程进度有数据", s2 && s2.courses && s2.courses.length > 0, JSON.stringify((s2.courses || [])[0] || {}));
  ok("运行时长在累计", s2 && s2.time && s2.time.usedMs > 30000, Math.round(((s2.time || {}).usedMs || 0) / 1000) + "s");
  ok("风控状态可读", s2 && s2.risk, s2 && s2.risk.level);

  console.log("\n=== ⑥ 随时停止 ===");
  const sp = jget(await req("POST", "/api/stop", { headers: CK }));
  ok("停止接口返回成功", sp && sp.ok);
  await sleep(4000);
  const s3 = jget(await req("GET", "/api/state", { headers: CK }));
  ok("停止后 running=false", s3 && s3.running === false, "running=" + (s3 && s3.running));
  ok("停止后仍保留进度数据", s3 && s3.courses && s3.courses.length > 0);

  console.log("\n" + "=".repeat(46));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(46));
  process.exit(fail ? 1 : 0);
})();
