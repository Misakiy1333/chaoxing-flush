/**
 * 验证「本地版 / 云端版」标题渲染是否正确
 *   node tools/test-role.js
 *
 * 用最小 DOM 桩把页面脚本真跑一遍，分别模拟 role=local / role=cloud，
 * 检查标题、副标题、页脚、document.title 有没有按环境切换。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "web", "multi.html"), "utf8");
const SCRIPT = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");

let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}

function makeEl(id) {
  const el = {
    id, innerHTML: "", className: "", value: "",
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [],
    insertBefore() {}, appendChild() {}, setAttribute() {}, addEventListener() {},
  };
  // 模拟真实 DOM：设 textContent 后 innerHTML 得到转义后的 HTML（esc() 依赖这个行为）
  let text = "";
  Object.defineProperty(el, "textContent", {
    get: () => text,
    set: (v) => {
      text = String(v == null ? "" : v);
      el.innerHTML = text
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },
  });
  return el;
}

async function run(role) {
  const els = {};
  const getEl = (id) => (els[id] = els[id] || makeEl(id));
  const doc = {
    getElementById: getEl,
    createElement: (t) => makeEl(t),
    addEventListener() {},
    body: makeEl("body"),
    title: "",
    hidden: false,
  };
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const fetchStub = async (url) => {
    if (String(url).indexOf("/api/version") >= 0) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          role,
          version: role === "local" ? "3.6" : "1.2",
          buildAt: "2026-10-19",
          announcement: { id: "a1", title: "更新公告", date: "2026-10-19", items: ["测试公告"] },
          latest: { version: "3.6", downloadUrl: "https://wwang.lanzouv.com/iqWEs4cktcra", note: "安装包（提取码 ff66）" },
          cloud: { reachable: true, version: "1.2", latestLocal: "3.6", newer: false },
        }),
      };
    }
    return { ok: false, status: 401, json: async () => ({ ok: false }) };
  };
  class ES { constructor() {} close() {} }
  const sandbox = {
    document: doc, localStorage, fetch: fetchStub, EventSource: ES,
    location: { protocol: "http:", host: "127.0.0.1:8765" },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; },
    confirm: () => false, console,
  };
  const fn = new Function(
    "document", "localStorage", "fetch", "EventSource", "location", "setInterval", "clearInterval", "setTimeout", "confirm", "console",
    SCRIPT
  );
  fn(sandbox.document, sandbox.localStorage, sandbox.fetch, sandbox.EventSource,
     sandbox.location, sandbox.setInterval, sandbox.clearInterval, sandbox.setTimeout,
     sandbox.confirm, sandbox.console);

  // 等异步的 /api/version 回来
  await new Promise((r) => setTimeout(r, 60));
  return { els, title: doc.title };
}

(async () => {
  console.log("=== 本地版角色 ===");
  const L = await run("local");
  ok("登录页标题", L.els.roleTag && L.els.roleTag.textContent === "· 本地版", JSON.stringify(L.els.roleTag && L.els.roleTag.textContent));
  ok("主界面标题", L.els.roleTag2 && L.els.roleTag2.textContent === "· 本地版");
  ok("副标题是本地文案", /本机运行/.test(L.els.subLine && L.els.subLine.textContent), L.els.subLine && L.els.subLine.textContent);
  ok("页脚标题", /本地版/.test(L.els.footTitle && L.els.footTitle.textContent), L.els.footTitle && L.els.footTitle.textContent);
  ok("浏览器标题", /本地版/.test(L.title), L.title);
  ok("公告已渲染", /测试公告/.test(L.els.annBody && L.els.annBody.innerHTML));
  ok("版本行", /本地版 v3\.6/.test(L.els.verLine && L.els.verLine.textContent), L.els.verLine && L.els.verLine.textContent);
  ok("已是最新版时不显示更新卡", (L.els.updCard && L.els.updCard.style.display) === "none", "display=" + (L.els.updCard && L.els.updCard.style.display));

  console.log("\n=== 云端版角色 ===");
  const C = await run("cloud");
  ok("登录页标题", C.els.roleTag && C.els.roleTag.textContent === "· 云端版", JSON.stringify(C.els.roleTag && C.els.roleTag.textContent));
  ok("主界面标题", C.els.roleTag2 && C.els.roleTag2.textContent === "· 云端版");
  ok("副标题是云端文案", /多人共用/.test(C.els.subLine && C.els.subLine.textContent), C.els.subLine && C.els.subLine.textContent);
  ok("页脚标题", /云端版/.test(C.els.footTitle && C.els.footTitle.textContent), C.els.footTitle && C.els.footTitle.textContent);
  ok("浏览器标题", /云端版/.test(C.title), C.title);
  ok("版本行", /云端版 v1\.2/.test(C.els.verLine && C.els.verLine.textContent), C.els.verLine && C.els.verLine.textContent);
  ok("云端页面显示下载入口", (C.els.updCard && C.els.updCard.style.display) === "block", "display=" + (C.els.updCard && C.els.updCard.style.display));
  ok("登录页也挂了下载入口", (C.els.updCardLogin && C.els.updCardLogin.style.display) === "block", "display=" + (C.els.updCardLogin && C.els.updCardLogin.style.display));
  ok("登录页下载按钮指向蓝奏云", /lanzouv\.com/.test(String(C.els.updLinkLogin && C.els.updLinkLogin.href)), C.els.updLinkLogin && C.els.updLinkLogin.href);
  ok("下载按钮指向蓝奏云", /lanzouv\.com/.test(String(C.els.updLink && C.els.updLink.href)), C.els.updLink && C.els.updLink.href);
  ok("提示里带提取码", /ff66/.test(C.els.updBody && C.els.updBody.innerHTML), (C.els.updBody && C.els.updBody.innerHTML || "").slice(0, 40));

  console.log("\n" + "=".repeat(44));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(44));
  process.exit(fail ? 1 : 0);
})();
