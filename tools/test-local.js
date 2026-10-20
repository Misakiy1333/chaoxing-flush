/**
 * 本地版自测：起 LocalServer（不开浏览器），验证接口与页面和云端一致
 *   node tools/test-local.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const LocalServer = require(path.join(ROOT, "local-server.js"));
const PORT = 8125;

let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}
const sleep = (t) => new Promise((r) => setTimeout(r, t));

function req(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const headers = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers, timeout: 20000 }, (x) => {
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
const j = (r) => { try { return JSON.parse(r.body); } catch (e) { return null; } };

(async () => {
  const app = new LocalServer({ port: PORT });
  await app.init();
  app.onListening = () => {};
  app.serve();
  await sleep(900);

  console.log("=== 页面 ===");
  const p = await req("GET", "/");
  const src = fs.readFileSync(path.join(ROOT, "web", "multi.html"), "utf8").replace(/\r\n/g, "\n");
  ok("首页 200", p.code === 200);
  ok("页面与云端完全同一份", p.body === src, p.body.length + " 字符 / " + Buffer.byteLength(src, "utf8") + " 字节");
  for (const k of ["totalBar", "courseGrid", "riskPill", "connPill", "stopBtn", "setHours"]) {
    ok("含 " + k, p.body.indexOf(k) >= 0);
  }
  ok("含署名与邮箱", /飞飞/.test(p.body) && /cc040921f@gmail\.com/.test(p.body));

  console.log("\n=== 接口 ===");
  const h = await req("GET", "/health");
  ok("/health", h.code === 200 && h.body === "ok");

  const me = await req("GET", "/api/me");
  // 本机 config.json 里存了 cookie，所以应为已登录
  const meJ = j(me);
  ok("/api/me 可用（有存档 cookie 时免登录）", me.code === 200, "HTTP " + me.code);
  if (me.code === 200) {
    ok("返回设置", !!(meJ && meJ.settings));
    ok("标记为本地版", meJ.local === true);
  }

  const st = await req("GET", "/api/state");
  ok("/api/state 200", st.code === 200);
  const stJ = j(st);
  ok("state 结构完整", stJ && "running" in stJ && "risk" in stJ && "settings" in stJ && "logs" in stJ);

  const se = await req("POST", "/api/settings", { dailyHours: 3.5, brushStart: 8, brushEnd: 22 });
  ok("/api/settings 保存", se.code === 200 && j(se).ok === true, JSON.stringify(j(se).settings));

  const sp = await req("POST", "/api/stop");
  ok("/api/stop 可用", sp.code === 200 && j(sp).ok === true);

  const nf = await req("GET", "/api/nope");
  ok("未知接口 404", nf.code === 404);

  console.log("\n=== SSE 实时推送 ===");
  const frame = await new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: "/api/events", method: "GET" }, (x) => {
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
  ok("SSE 类型正确", /text\/event-stream/.test(frame.ct || ""), frame.ct);
  ok("SSE 首帧合法", /^data: \{/.test(frame.body.trim()), frame.body.slice(0, 36));

  console.log("\n=== 版本 / 云端更新检查 ===");
  const v = await req("GET", "/api/version");
  const vj = j(v);
  ok("/api/version 200", v.code === 200);
  ok("本地版版本号", !!(vj && vj.version), vj && vj.version);
  ok("带公告", !!(vj && vj.announcement && vj.announcement.items), vj && vj.announcement && vj.announcement.title);
  ok("云端可达并返回版本", !!(vj && vj.cloud && vj.cloud.reachable), JSON.stringify(vj && vj.cloud));
  ok("返回更新服务地址", !!(vj && vj.updateUrl), vj && vj.updateUrl);
  ok("更新地址指向云端", !!(vj && /^https?:\/\//.test(String(vj.updateUrl))), vj && vj.updateUrl);

  console.log("\n=== 课程列表（真实请求超星，只读）===");
  const cs = await req("GET", "/api/courses");
  const csJ = j(cs);
  ok("/api/courses 200", cs.code === 200);
  ok("拉到课程", !!(csJ && csJ.ok && csJ.courses && csJ.courses.length), csJ && csJ.courses ? csJ.courses.length + " 门" : (csJ && csJ.error));

  console.log("\n" + "=".repeat(44));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(44));
  process.exit(fail ? 1 : 0);
})();
