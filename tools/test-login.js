/**
 * 登录全盘检查
 *   node tools/test-login.js                                   # 离线部分（不碰你的账号）
 *   set CHX_PASS=xxx && node tools/test-login.js --live 你的服务器IP   # 加测真实登录 1 次
 *
 * 覆盖：加密算法 / 参数默认值 / 错误分类与重试策略 / 云端接口 / 安全存储
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const LIVE = process.argv.includes("--live");
const hostIdx = process.argv.indexOf("--live");
const HOST = hostIdx >= 0 && process.argv[hostIdx + 1] && !process.argv[hostIdx + 1].startsWith("--")
  ? process.argv[hostIdx + 1] : (process.env.DEPLOY_HOST || "");
const PASS = process.env.CHX_PASS || "";
const UNAME = process.env.CHX_USER || "你的超星账号";

let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}

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

(async () => {
  /* ============ A. 加密 ============ */
  console.log("=== A. 密码加密（AES-128-CBC）===");
  const CryptoJS = require(path.join(ROOT, "node_modules", "crypto-js"));
  const LoginerBase = require(path.join(ROOT, "loginer.js"));
  const encryptByAES = LoginerBase.encryptByAES;
  const KEY = "u2oh6Vu^HWe4_AES";

  function decrypt(ct) {
    const k = CryptoJS.enc.Utf8.parse(KEY);
    const dec = CryptoJS.AES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(ct) },
      k,
      { iv: k, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
    );
    return dec.toString(CryptoJS.enc.Utf8);
  }

  const encPwd = encryptByAES("TestPass123");
  ok("输出是合法 Base64", /^[A-Za-z0-9+/]+=*$/.test(encPwd), encPwd.slice(0, 20) + "…");
  ok("能被服务端算法解回原文", decrypt(encPwd) === "TestPass123");
  const rawBytes = Buffer.from(encPwd, "base64");
  ok("密文字节数是 16 的倍数（CBC 分组）", rawBytes.length % 16 === 0, rawBytes.length + " 字节 / Base64 " + encPwd.length + " 字符");
  ok("相同输入产生相同密文（固定 IV，服务端可解）", encryptByAES("abc123") === encryptByAES("abc123"));
  ok("中文账号也能加密", decrypt(encryptByAES("学号2026")) === "学号2026");
  ok("空串不崩", typeof encryptByAES("") === "string");

  /* ============ B. 错误分类与重试策略（打桩，不联网）============ */
  console.log("\n=== B. 登录错误分类与重试策略 ===");
  let queue = [];
  let fetchCount = 0;
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "node-fetch" && parent && /loginer\.js$/.test(parent.filename)) {
      return async function fakeFetch() {
        fetchCount++;
        const next = queue.shift() || { status: 200, body: '{"status":true}' };
        if (next.throw) throw new Error(next.throw);
        return {
          status: next.status == null ? 200 : next.status,
          text: async () => next.body || "",
          json: async () => JSON.parse(next.body || "{}"),
          headers: {
            get: (k) => (next.headers && next.headers[k]) || null,
            raw: () => (next.headersRaw ? next.headersRaw() : {}),
          },
        };
      };
    }
    return realLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(ROOT, "loginer.js"))];
  const Loginer = require(path.join(ROOT, "loginer.js"));

  const mk = (extra) => new Loginer(Object.assign({ uname: "u1", password: "p1", fid: "-1", forceLogin: true }, extra || {}));

  queue = [{ body: "<html>login</html>" }, { body: '{"status":false,"msg2":"用户名或密码错误"}' }];
  fetchCount = 0;
  let e1 = null;
  try { await mk().login(); } catch (e) { e1 = e; }
  ok("密码错误被识别为凭据问题", !!e1 && e1.badCredential === true, (e1 && e1.message) || "");
  ok("密码错误只提交 1 次（不重试，避免锁号）", fetchCount === 2, "共 " + fetchCount + " 个请求");

  queue = [{ body: "<html></html>" }, { body: '{"status":false,"msg2":"请输入验证码"}' }];
  fetchCount = 0;
  let e2 = null;
  try { await mk().login(); } catch (e) { e2 = e; }
  ok("验证码被识别", !!e2 && e2.needCaptcha === true, (e2 && e2.message) || "");
  ok("验证码只提交 1 次", fetchCount === 2, fetchCount + " 个请求");

  queue = [{ body: "<html></html>" }, { body: '{"status":false,"msg2":"账号已冻结，请15分钟后重试"}' }];
  fetchCount = 0;
  try { await mk().login(); } catch (e) {}
  ok("冻结提示会停止重试", fetchCount === 2, fetchCount + " 个请求");

  queue = [{ throw: "ECONNRESET" }, { throw: "ECONNRESET" }];
  fetchCount = 0;
  try { await mk({ maxRetry: 2 }).login(); } catch (e) {}
  ok("网络错误会重试", fetchCount === 2, fetchCount + " 个请求");

  const hdr = () => ({ "set-cookie": ["_uid=123; Path=/", "_d=abc; Path=/", "vc3=xyz; Path=/", "fid=24808; Path=/"] });
  queue = [{ body: "<html></html>", headersRaw: hdr }, { body: '{"status":true}', headersRaw: hdr }];
  const ck = await mk().login();
  ok("登录成功返回 cookie", typeof ck === "string" && ck.indexOf("_uid=123") >= 0, ck.slice(0, 44) + "…");
  ok("cookie 含 fid（学校标识）", ck.indexOf("fid=24808") >= 0);

  ok("fid 默认 -1", String(mk().cfg.fid) === "-1");
  ok("fid 可自定义", String(mk({ fid: "24808" }).cfg.fid) === "24808");
  ok("无代理时不创建 agent", mk().agent() === null);
  let agentOk = false;
  try { agentOk = !!new Loginer({ uname: "u", password: "p", proxy: "http://127.0.0.1:8888" }).agent(); } catch (e) {}
  ok("配置代理后创建 agent", agentOk);

  let e8 = null;
  try { await new Loginer({ uname: "", password: "", forceLogin: true }).login(); } catch (e) { e8 = e; }
  ok("缺账号密码时报错", !!e8, String((e8 && e8.message) || e8).slice(0, 28));

  Module._load = realLoad;

  /* ============ C. 密码存储安全 ============ */
  console.log("\n=== C. 密码存储安全 ===");
  process.env.ENC_KEY = "login-audit-key-1234";
  delete require.cache[require.resolve(path.join(ROOT, "crypto-util.js"))];
  const cu = require(path.join(ROOT, "crypto-util.js"));
  const enc = cu.encrypt("TestPass123");
  ok("落盘密码是密文", enc.startsWith("ENC:"));
  ok("密文里没有明文", enc.indexOf("TestPass123") === -1);
  ok("可正确还原", cu.decrypt(enc.slice(4)) === "TestPass123");
  process.env.ENC_KEY = "";
  delete require.cache[require.resolve(path.join(ROOT, "crypto-util.js"))];

  /* ============ D. 云端登录接口 ============ */
  if (!HOST) {
    console.log("\n=== D. 云端登录接口 ===");
    console.log("  （未设置 DEPLOY_HOST，跳过线上接口测试）");
    console.log("\n" + "=".repeat(48));
    console.log("  通过 " + pass + "   失败 " + fail);
    if (fails.length) console.log("  失败项: " + fails.join(", "));
    console.log("=".repeat(48));
    process.exit(fail ? 1 : 0);
  }
  console.log("\n=== D. 云端登录接口 ===");
  const empty = await req("POST", "/api/login", { body: { uname: "", password: "" } });
  let ej = null;
  try { ej = JSON.parse(empty.body); } catch (e) {}
  ok("空账号被拒", empty.code === 200 && ej && ej.ok === false, ej && ej.error);
  const noPwd = await req("POST", "/api/login", { body: { uname: "13800000000", password: "" } });
  let nj = null;
  try { nj = JSON.parse(noPwd.body); } catch (e) {}
  ok("空密码被拒", nj && nj.ok === false);

  if (LIVE) {
    console.log("  （下一步会用你的账号真实登录 1 次）");
    const li = await req("POST", "/api/login", { body: { uname: UNAME, password: PASS, fid: "-1" } });
    let lj = null;
    try { lj = JSON.parse(li.body); } catch (e) {}
    ok("真实登录成功", lj && lj.ok === true, (lj && lj.error) || "");
    ok("返回课程列表", !!(lj && Array.isArray(lj.courses) && lj.courses.length), ((lj && lj.courses) || []).length + " 门");
    const sc = [].concat(li.headers["set-cookie"] || []).join(";");
    const sid = (sc.match(/sid=([a-f0-9]+)/) || [])[1] || "";
    ok("下发 sid", !!sid);
    ok("Cookie 带 HttpOnly", /HttpOnly/i.test(sc));
    ok("Cookie 30 天有效", /Max-Age=2592000/.test(sc));
    ok("Cookie SameSite 保护", /SameSite=Lax/i.test(sc));
    const me = await req("GET", "/api/me", { headers: { Cookie: "sid=" + sid } });
    let mj = null;
    try { mj = JSON.parse(me.body); } catch (e) {}
    ok("用 sid 取到本人", me.code === 200 && mj && mj.uname === UNAME, (mj && mj.uname) || "");
    const out = await req("POST", "/api/logout", { headers: { Cookie: "sid=" + sid } });
    ok("退出接口成功", out.code === 200);
    const me2 = await req("GET", "/api/me", { headers: { Cookie: "sid=" + sid } });
    ok("退出后 sid 立即失效", me2.code === 401, "HTTP " + me2.code);
  } else {
    console.log("  （未加 --live，跳过真实登录）");
  }

  console.log("\n" + "=".repeat(48));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(48));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试异常:", (e && e.message) || e); process.exit(1); });
