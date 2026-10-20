/**
 * 蓝奏云客户端（自动过 CDN 的 JS 挑战 acw_sc__v2）
 *
 *   node tools/lanzou.js probe
 *   node tools/lanzou.js login <账号> <密码>
 *   node tools/lanzou.js upload <文件> <账号> <密码>
 *
 * 说明：蓝奏云挂在 CDN 后面，首次请求会返回一段混淆 JS，需要执行后算出
 * acw_sc__v2 cookie 再重放请求。这里把那段脚本取回，在受限沙箱里跑一遍，
 * 只捕获它设置的 cookie，不执行任何网络/文件操作。
 */
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const md5 = (s) => crypto.createHash("md5").update(String(s)).digest("hex");

class Jar {
  constructor() { this.c = {}; }
  header() { return Object.entries(this.c).map(([k, v]) => k + "=" + v).join("; "); }
  set(k, v) { this.c[k] = v; }
  absorb(res) {
    const raw = res.headers.raw ? res.headers.raw()["set-cookie"] : null;
    (raw || []).forEach((line) => {
      const kv = line.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) this.c[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
  }
}

/** 在沙箱里执行挑战脚本，只取它设置的 cookie */
function solveChallenge(html) {
  const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  const code = m[1];
  let cookie = "";
  const doc = {
    get cookie() { return cookie; },
    set cookie(v) { cookie = String(v); },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    addEventListener() {},
    getElementsByTagName: () => [],
    getElementById: () => null,
    body: {},
    documentElement: {},
  };
  const loc = { reload() {}, href: "", assign() {}, replace() {} };
  const nav = { userAgent: UA };
  const win = { document: doc, location: loc, navigator: nav };
  win.window = win; win.self = win; win.top = win; win.globalThis = win;
  const noop = () => 0;
  try {
    // 只给浏览器环境对象，不传 require/process/fs
    const fn = new Function(
      "window", "self", "top", "globalThis", "document", "navigator", "location",
      "setTimeout", "setInterval", "clearTimeout", "clearInterval", "alert",
      code
    );
    fn(win, win, win, win, doc, nav, loc, noop, noop, noop, noop, noop);
  } catch (e) {
    return { error: e.message, cookie: cookie || null };
  }
  return { cookie: cookie || null };
}

function takeCookies(str) {
  const out = {};
  String(str || "").split(";").forEach((kv) => {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  return out;
}

async function req(jar, url, opt) {
  opt = opt || {};
  const headers = Object.assign(
    {
      "User-Agent": UA,
      Referer: opt.referer || "https://up.woozooo.com/",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    opt.headers || {}
  );
  if (jar.header()) headers.Cookie = jar.header();

  let r = await fetch(url, { method: opt.method || "GET", headers, body: opt.body, timeout: 25000, redirect: "manual" });
  jar.absorb(r);
  let text = await r.text();

  // CDN 挑战：跑脚本算 cookie，再重放一次
  if (/var\s+arg1\s*=/.test(text)) {
    const solved = solveChallenge(text);
    if (solved && solved.cookie) {
      const cs = takeCookies(solved.cookie.replace(/^cookie\s*=\s*/i, ""));
      Object.entries(cs).forEach(([k, v]) => jar.set(k, v));
      const h2 = Object.assign({}, headers, { Cookie: jar.header() });
      r = await fetch(url, { method: opt.method || "GET", headers: h2, body: opt.body, timeout: 25000, redirect: "manual" });
      jar.absorb(r);
      text = await r.text();
      return { status: r.status, text, solved: true, cookieNames: Object.keys(cs) };
    }
    return { status: r.status, text, solved: false, solveError: solved && solved.error };
  }

  return { status: r.status, text, solved: null };
}

/* ---------------- 命令 ---------------- */

async function probe() {
  const jar = new Jar();
  const a = await req(jar, "https://up.woozooo.com/");
  console.log("up.woozooo.com   HTTP " + a.status + "  " + a.text.length + " 字节  过挑战=" + a.solved);
  const b = await req(jar, "https://up.woozooo.com/mlogin.php");
  console.log("mlogin.php       HTTP " + b.status + "  " + b.text.length + " 字节  过挑战=" + b.solved);
  console.log("Cookie: " + (jar.header() ? jar.header().slice(0, 90) + "…" : "无"));
}

async function login(user, pwd) {
  const jar = new Jar();
  console.log("① 预热（拿 cookie + 过 CDN 挑战）");
  const warm = await req(jar, "https://up.woozooo.com/mlogin.php");
  console.log("   HTTP " + warm.status + "  过挑战=" + warm.solved + "  Cookie 数 " + Object.keys(jar.c).length);

  console.log("\n② 提交账号密码（只 1 次）");
  const body = new URLSearchParams({ task: "1", uid: user, pwd: md5(pwd), action: "login" });
  const r = await req(jar, "https://up.woozooo.com/mlogin.php", {
    method: "POST",
    body,
    referer: "https://up.woozooo.com/mlogin.php",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
  });
  console.log("   HTTP " + r.status + "  过挑战=" + r.solved);
  console.log("   返回: " + r.text.slice(0, 260).replace(/\s+/g, " "));

  let j = null;
  try { j = JSON.parse(r.text); } catch (e) {}
  if (j && (j.zt === 1 || j.zt === "1")) {
    console.log("\n>>> 登录成功");
    const ck = jar.header();
    fs.writeFileSync(path.join(__dirname, ".lanzou-cookie"), ck, "utf8");
    console.log("   cookie 已保存到 tools/.lanzou-cookie");
    return jar;
  }
  console.log("\n>>> 登录失败" + (j ? "（zt=" + j.zt + "）" : "（非 JSON，可能仍需滑块）"));
  return null;
}

async function upload(file, jar) {
  if (!fs.existsSync(file)) throw new Error("文件不存在: " + file);
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  console.log("① 上传 " + name + "  (" + (size / 1024 / 1024).toFixed(1) + " MB)");

  const FormData = require("form-data");
  const fd = new FormData();
  fd.append("task", "1");
  fd.append("ve", "2");
  fd.append("id", "WU_FILE_0");
  fd.append("name", name);
  fd.append("type", "application/zip");
  fd.append("lastModifiedDate", new Date().toString());
  fd.append("size", String(size));
  fd.append("folder_id", "-1");
  fd.append("upload_file", fs.createReadStream(file), { filename: name, contentType: "application/zip" });

  const headers = Object.assign(fd.getHeaders(), {
    "User-Agent": UA,
    Referer: "https://up.woozooo.com/mypan.php",
    Accept: "*/*",
    Cookie: jar.header(),
  });

  const r = await fetch("https://up.woozooo.com/html5up.php", { method: "POST", headers, body: fd, timeout: 300000 });
  const text = await r.text();
  console.log("   HTTP " + r.status);
  console.log("   返回: " + text.slice(0, 400).replace(/\s+/g, " "));

  let j = null;
  try { j = JSON.parse(text); } catch (e) {}
  if (j && (j.zt === 1 || j.zt === "1") && j.text && j.text[0]) {
    const f = j.text[0];
    console.log("\n>>> 上传成功  id=" + (f.id || "") + "  name=" + (f.name || f.name_all || ""));
    return f;
  }
  console.log("\n>>> 上传失败");
  return null;
}

(async () => {
  const cmd = process.argv[2] || "probe";
  try {
    if (cmd === "probe") return await probe();
    if (cmd === "login") return await login(process.argv[3], process.argv[4]);
    if (cmd === "upload") {
      const file = process.argv[3];
      const ckFile = path.join(__dirname, ".lanzou-cookie");
      if (!fs.existsSync(ckFile)) throw new Error("还没有登录，先跑 login");
      const jar = new Jar();
      takeCookies(fs.readFileSync(ckFile, "utf8"));
      Object.entries(takeCookies(fs.readFileSync(ckFile, "utf8"))).forEach(([k, v]) => jar.set(k, v));
      return await upload(file, jar);
    }
    console.log("用法: probe | login <账号> <密码> | upload <文件>");
  } catch (e) {
    console.error("错误: " + e.message);
    process.exit(1);
  }
})();
