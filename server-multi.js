/**
 * 多用户云端服务（多人共用一台服务器）
 *
 * 特点：
 *   - 每个用户独立账号、独立任务、独立进度，互不影响
 *   - 登录态持久化：登录后发 sid Cookie，刷新页面/服务器重启都不用重新登录
 *   - 实时推送：GET /api/events 用 SSE 每 2 秒推一次状态（页面用 EventSource）
 *   - 随时开始 / 随时停止
 *   - 进度、风控状态、每门课完成度都通过 /api/state 暴露给前端
 *   - 用户数据存 data/users.json（密码用 ENC_KEY 加密）
 *
 * 启动:
 *   ADMIN_PASSWORD=你的管理密码 PORT=8080 ENC_KEY=xxx node server-multi.js
 *
 * 环境变量:
 *   PORT            监听端口（默认 8080）
 *   ADMIN_PASSWORD  管理员密码（查看所有用户）
 *   MAX_RUNNING     全局同时刷课用户数上限（默认 30）
 *   ENC_KEY         加密密钥（不设则用机器标识，容器部署必须设）
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const Loginer = require("./loginer.js");
const Session = require("./session.js");
const CourseData = require("./course.js");
const CourseTask = require("./courseTask.js");
const { QuizAgent } = require("./quizAgent.js");
const { encrypt, decrypt } = require("./crypto-util.js");
const VERSION = require("./version.js");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const MAX_RUNNING = parseInt(process.env.MAX_RUNNING || "30", 10);
const SID_DAYS = 30;

// 哪些账号登录后可以进管理后台（逗号分隔）；不设就没人能进后台
const ADMIN_USERS = String(process.env.ADMIN_USERS || "")
  .split(/[,，\s]+/)
  .map((x) => x.trim())
  .filter(Boolean);
function isAdminUser(uname) {
  return !!uname && ADMIN_USERS.indexOf(String(uname).trim()) !== -1;
}
/** 管理接口鉴权：管理员账号的登录态，或管理员密码 */
function adminAllowed(req, url, uname) {
  if (isAdminUser(uname)) return true;
  const pwd = url.searchParams.get("pwd") || req.headers["x-admin"];
  return !!ADMIN_PASSWORD && pwd === ADMIN_PASSWORD;
}

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const BANK_FILE = path.join(DATA_DIR, "bank-shared.json"); // 云端共享题库：所有账号答过的题都汇到这里
const ANNOUNCE_FILE = path.join(DATA_DIR, "announce.json");
const RELEASE_FILE = path.join(DATA_DIR, "release.json");
const RELEASE_DIR = path.join(DATA_DIR, "release");
const WHITELIST_FILE = path.join(DATA_DIR, "whitelist.json");
const PAGE_FILE = path.join(__dirname, "web", "multi.html");
const ADMIN_PAGE_FILE = path.join(__dirname, "web", "admin.html");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ============================ 云端共享题库 ============================ */
const BANK_KEY = process.env.BANK_KEY || "shared";
// 全局大模型默认（.env 里配一次，所有账号共用；账号自己配了就以账号为准）
const GLOBAL_LLM = {
  enabled: process.env.LLM_ENABLED === "1" || process.env.LLM_ENABLED === "true",
  baseUrl: process.env.LLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
  apiKey: process.env.LLM_API_KEY || "",
  model: process.env.LLM_MODEL || "glm-4-flash",
  maxCalls: Number(process.env.LLM_MAX_CALLS || 400) || 400,
};
let sharedBankCache = null;

function bankKeyOk(req) {
  const got = String(req.headers["x-bank-key"] || "") || String((req.url.split("?")[1] || "").match(/(?:^|&)key=([^&]*)/) ? decodeURIComponent((req.url.split("?")[1] || "").match(/(?:^|&)key=([^&]*)/)[1]) : "");
  return got === BANK_KEY;
}

function loadSharedBank() {
  if (sharedBankCache) return sharedBankCache;
  let b = { v: 2, entries: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(BANK_FILE, "utf8"));
    if (raw && raw.entries) b = raw;
  } catch (e) {}
  sharedBankCache = b;
  return b;
}

let bankSaveTimer = null;
function saveSharedBankSoon() {
  if (bankSaveTimer) return;
  bankSaveTimer = setTimeout(() => {
    bankSaveTimer = null;
    try {
      const b = loadSharedBank();
      fs.writeFileSync(BANK_FILE + ".tmp", JSON.stringify(b));
      fs.renameSync(BANK_FILE + ".tmp", BANK_FILE);
    } catch (e) {
      console.error("[bank] 落盘失败", e.message);
    }
  }, 1500);
}

/** 合并条目：已确认对错的信息优先保留，猜测只在不冲突时写入 */
function mergeSharedBank(inc) {
  const bank = loadSharedBank();
  bank.entries = bank.entries || {};
  const rank = (e) => (e && e.correct ? 3 : e && e.guess ? 2 : e && (e.wrong || e.members) ? 1 : 0);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const k of Object.keys(inc)) {
    const raw = inc[k];
    if (!raw || !k || typeof raw !== "object") { skipped++; continue; }
    // 清洗：自检/空条目不留；type 缺失补 0；q 缺失用关键词兜底
    if (!raw.q && !raw.correct && !raw.guess && !raw.wrong) { skipped++; continue; }
    const e = Object.assign({}, raw);
    if (e.type == null) e.type = 0;
    if (!e.q) e.q = k;
    const old = bank.entries[k];
    if (!old) {
      bank.entries[k] = e;
      added++;
      continue;
    }
    if (rank(e) > rank(old)) {
      bank.entries[k] = Object.assign({}, old, e);
      updated++;
    } else if (rank(e) === rank(old) && rank(e) >= 2) {
      // 同等可信：合并 wrong/members，长度取并集
      const w = new Set([].concat(old.wrong || [], e.wrong || []));
      const m = new Set([].concat(old.members || [], e.members || []));
      bank.entries[k] = Object.assign({}, old, e, { wrong: Array.from(w), members: Array.from(m) });
      updated++;
    }
  }
  saveSharedBankSoon();
  return { total: Object.keys(bank.entries).length, added, updated, skipped };
}
if (!fs.existsSync(RELEASE_DIR)) fs.mkdirSync(RELEASE_DIR, { recursive: true });

// ---------- 账号白名单 ----------
/**
 * data/whitelist.json: { "enabled": true, "unames": ["13800000000", ...] }
 * enabled 为 false 或文件不存在 → 不限制（谁能登录都行）
 */
function loadWhitelist() {
  try {
    const w = JSON.parse(fs.readFileSync(WHITELIST_FILE, "utf8"));
    return {
      enabled: !!w.enabled,
      unames: Array.isArray(w.unames) ? w.unames.map((x) => String(x).trim()).filter(Boolean) : [],
      note: String(w.note || ""),
    };
  } catch (e) {
    return { enabled: false, unames: [], note: "" };
  }
}
function saveWhitelist(w) {
  try { fs.writeFileSync(WHITELIST_FILE, JSON.stringify(w, null, 1), "utf8"); } catch (e) {}
}
function isAllowed(uname) {
  const w = loadWhitelist();
  if (!w.enabled) return true;              // 没开白名单 = 不限制
  if (!w.unames.length) return false;       // 开了但没名单 = 谁都不许
  return w.unames.includes(String(uname).trim());
}
const NOT_ALLOWED_MSG = "该账号未开通使用权限，请联系飞飞（cc040921f@gmail.com）";

// ---------- 更新公告 ----------
function defaultAnnounce() {
  return {
    id: VERSION.buildAt + "-" + VERSION.cloudVersion,
    title: "更新公告",
    date: VERSION.buildAt,
    items: VERSION.changelog,
  };
}
function loadAnnounce() {
  try {
    const a = JSON.parse(fs.readFileSync(ANNOUNCE_FILE, "utf8"));
    if (a && a.id) return a;
  } catch (e) {}
  const a = defaultAnnounce();
  try { fs.writeFileSync(ANNOUNCE_FILE, JSON.stringify(a, null, 1), "utf8"); } catch (e) {}
  return a;
}

// ---------- 最新版本（蓝奏云下载页）----------
function loadRelease() {
  let r = null;
  try {
    r = JSON.parse(fs.readFileSync(RELEASE_FILE, "utf8"));
  } catch (e) {}
  const def = VERSION.latest || {};
  const rel = {
    version: String((r && r.version) || def.version || VERSION.version),
    downloadUrl: String((r && r.downloadUrl) || def.downloadUrl || ""),
    localFile: String((r && r.localFile) || ""),
    note: String((r && r.note) || def.note || ""),
    updatedAt: (r && r.updatedAt) || 0,
  };
  // 本机托管的文件优先，其次才是外部链接（蓝奏云等）
  if (rel.localFile) {
    const p = path.join(RELEASE_DIR, rel.localFile);
    if (fs.existsSync(p)) {
      rel.size = fs.statSync(p).size;
      rel.hosted = true;
    } else {
      rel.localFile = "";
      rel.hosted = false;
    }
  }
  return rel;
}

// ---------- 用户存储 ----------
function loadUsers() {
  try {
    const db = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    if (!db.users) db.users = {};
    return db;
  } catch (e) {
    return { users: {} };
  }
}
function saveUsers(db) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 1), "utf8");
  } catch (e) {
    console.error("[store] 写入失败: " + e.message);
  }
}

// ---------- 运行时状态（内存） ----------
const runtime = {}; // uname -> { session, task, running, logs, token, sid, sse:Set, startedAt }
let shuttingDown = false; // 正在重启/关闭：此时中断的任务要保留续刷标记

function rt(uname) {
  if (!runtime[uname]) {
    runtime[uname] = { logs: [], running: false, taskActive: false, task: null, session: null, sse: new Set(), startedAt: 0 };
  }
  return runtime[uname];
}
function pushLog(uname, line) {
  const r = rt(uname);
  r.logs.push(line);
  if (r.logs.length > 600) r.logs.splice(0, r.logs.length - 600);
  console.log(`[${uname}] ${line}`);
}
function runningCount() {
  return Object.values(runtime).filter((r) => r.running).length;
}

// ---------- Cookie ----------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  raw.split(";").forEach((kv) => {
    const i = kv.indexOf("=");
    if (i < 0) return;
    out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}
function sidCookie(sid) {
  return `sid=${sid}; Path=/; Max-Age=${SID_DAYS * 86400}; HttpOnly; SameSite=Lax`;
}
function findUserBySid(db, sid) {
  if (!sid) return null;
  for (const k of Object.keys(db.users)) if (db.users[k].sid === sid) return db.users[k];
  return null;
}

// ---------- 会话恢复（用已存 cookie 直接建 Session，不用密码） ----------
function ensureSession(uname) {
  const r = rt(uname);
  if (r.session) return r.session;
  const db = loadUsers();
  const rec = db.users[uname];
  if (!rec || !rec.cookie) return null;
  r.session = new Session({ cookie: rec.cookie, debug: false, proxy: rec.proxy || "" });
  return r.session;
}

// ---------- 页面 ----------
function page() {
  try { return fs.readFileSync(PAGE_FILE, "utf8"); } catch (e) { return "<h1>页面缺失</h1>"; }
}

// ---------- 状态快照 ----------
function stateOf(uname) {
  const r = rt(uname);
  const db = loadUsers();
  const rec = db.users[uname] || {};
  const snap = r.task && r.task.snapshot ? r.task.snapshot() : null;
  const last = rec.lastState || null;

  const base = snap || last || {};
  return {
    ok: true,
    uname,
    running: !!r.running,
    stopped: r.task ? !!r.task.stopped : false,
    startedAt: r.startedAt || 0,
    elapsedMs: r.startedAt ? Date.now() - r.startedAt : 0,
    stats: base.stats || null,
    ui: base.ui || null,
    quiz: base.quiz || (r.task && r.task.quizAgent ? r.task.quizAgent.stats : null) || (rec.lastState && rec.lastState.quiz) || null,
    courses: base.courses || rec.courses || [],
    risk: base.risk || { level: "ok", blockHits: 0, coolingUntil: 0, coolingLeftMs: 0, lastBlockAt: 0, note: "" },
    time: base.time || null,
    settings: {
      dailyHours: rec.dailyHours == null ? 24 : rec.dailyHours,
      brushStart: rec.brushStart == null ? 0 : rec.brushStart,
      brushEnd: rec.brushEnd == null ? 24 : rec.brushEnd,
      parallel: 1,
      skipCourse: rec.skipCourse || "",
      accuracyMin: rec.accuracyMin == null ? 80 : rec.accuracyMin,
      accuracyMax: rec.accuracyMax == null ? 100 : rec.accuracyMax,
      workEnabled: rec.workEnabled !== false,
      workRounds: rec.workRounds == null ? 2 : rec.workRounds,
      answerRemoteEnabled: rec.answerRemoteEnabled === true,
      answerRemoteUrl: rec.answerRemoteUrl || "",
      hasAnswerRemoteToken: !!rec.answerRemoteToken,
      llmEnabled: rec.llmEnabled == null ? GLOBAL_LLM.enabled : rec.llmEnabled === true,
      llmBaseUrl: rec.llmBaseUrl || GLOBAL_LLM.baseUrl,
      llmModel: rec.llmModel || GLOBAL_LLM.model,
      llmMaxCalls: rec.llmMaxCalls == null ? GLOBAL_LLM.maxCalls : rec.llmMaxCalls,
      hasLlmKey: !!(rec.llmApiKey || GLOBAL_LLM.apiKey),
    },
    works: base.works || [],
    answer: base.answer || null,
    bankTotal: Object.keys(loadSharedBank().entries || {}).length,
    logs: r.logs.slice(-80),
    runningNow: runningCount(),
    maxRunning: MAX_RUNNING,
  };
}

// ---------- 任务启动 ----------
async function startTask(uname, courseIds) {
  const r = rt(uname);
  if (r.running) throw new Error("任务已在运行");
  if (r.taskActive) throw new Error("上一个任务正在停止，请等几秒再启动");
  if (runningCount() >= MAX_RUNNING) throw new Error("服务器当前繁忙，请稍后再试");

  const session = ensureSession(uname);
  if (!session) throw new Error("登录已失效，请重新登录");

  const db = loadUsers();
  const rec = db.users[uname] || {};
  const cfg = {
    uname,
    // 用户在页面上明确勾了课，就以勾选为准（跳过列表只作为"默认不勾"的提示）
    skipCourse: Array.isArray(courseIds) && courseIds.length ? "" : (rec.skipCourse || ""),
    parallel: 1,
    dailyHours: rec.dailyHours == null ? 24 : rec.dailyHours,
    brushStart: rec.brushStart == null ? 0 : rec.brushStart,
    brushEnd: rec.brushEnd == null ? 24 : rec.brushEnd,
    speed: 1,
    humanMode: true,
    onlyCourse: Array.isArray(courseIds) && courseIds.length ? courseIds : null,
    // 章节测验/作业：自动作答 + 正确率区间（用户在页面上可改）
    workEnabled: rec.workEnabled !== false,
    accuracyMin: rec.accuracyMin == null ? 80 : rec.accuracyMin,
    accuracyMax: rec.accuracyMax == null ? 100 : rec.accuracyMax,
    workRounds: rec.workRounds == null ? 2 : rec.workRounds,
    // 在线答题源：题库接口 + 大模型（账号没单独配就用服务器 .env 里的全局 key）
    answerRemoteEnabled: rec.answerRemoteEnabled === true,
    answerRemoteUrl: rec.answerRemoteUrl || "",
    answerRemoteToken: rec.answerRemoteToken || "",
    llmEnabled: rec.llmEnabled == null ? GLOBAL_LLM.enabled : rec.llmEnabled === true,
    llmBaseUrl: rec.llmBaseUrl || GLOBAL_LLM.baseUrl,
    llmApiKey: rec.llmApiKey || GLOBAL_LLM.apiKey,
    llmModel: rec.llmModel || GLOBAL_LLM.model,
    llmMaxCalls: rec.llmMaxCalls == null ? GLOBAL_LLM.maxCalls : rec.llmMaxCalls,
    // 云端共享题库：所有账号答过的题汇在一起，答题先查它
    sharedBankUrl: "http://127.0.0.1:" + PORT,
    sharedBankKey: BANK_KEY,
    log: (line) => pushLog(uname, line),
  };

  const quizAgent = new QuizAgent(session);
  const task = new CourseTask(session, cfg);
  task.cfg.log = (line) => pushLog(uname, line);
  task.quizAgent = quizAgent;
  if (!quizAgent.hz) quizAgent.hz = task.hz;

  task.cfg.relogin = async () => {
    const d2 = loadUsers();
    const rec2 = d2.users[uname];
    if (!rec2 || !rec2.encPassword) throw new Error("没有保存密码，请重新登录");
    const c2 = {
      uname,
      password: decrypt(rec2.encPassword),
      forceLogin: true,
      saveCookie: null,
      fid: rec2.fid || "-1",
      proxy: rec2.proxy || "",
    };
    const lo = new Loginer(c2);
    const ck = await lo.login();
    d2.users[uname].cookie = ck;
    saveUsers(d2);
    r.session = new Session({ cookie: ck, debug: false, proxy: rec2.proxy || "" });
    return ck;
  };

  r.task = task;
  r.running = true;
  r.taskActive = true;
  r.startedAt = Date.now();
  r.logs = [];
  pushLog(uname, "▶ 收到启动指令");

  // 记录续刷参数：服务重启（更新代码）后能自动接着刷
  try {
    const d = loadUsers();
    if (d.users[uname]) {
      d.users[uname].autoResume = true;
      d.users[uname].runParams = {
        courseIds: Array.isArray(courseIds) && courseIds.length ? courseIds.map(String) : null,
        skipCourse: cfg.skipCourse,
        dailyHours: cfg.dailyHours,
        brushStart: cfg.brushStart,
        brushEnd: cfg.brushEnd,
        startedAt: r.startedAt,
      };
      saveUsers(d);
    }
  } catch (e) {}

  task.run()
    .then(() => pushLog(uname, "任务结束"))
    .catch((e) => pushLog(uname, "异常: " + (e && e.message ? e.message : e)))
    .finally(() => {
      r.running = false;
      r.taskActive = false;
      // 把最后状态落盘，刷新页面/重启后还能看到
      try {
        const d3 = loadUsers();
        if (d3.users[uname]) {
          const s = function () {
            try { return { stats: task.stats, ui: task.ui, courses: Object.values(task.courseProgress || {}), risk: task.risk, time: { usedMs: Date.now() - (r.startedAt || Date.now()) } }; }
            catch (e) { return null; }
          }();
          if (s) d3.users[uname].lastState = s;
          // 正常结束 / 手动停止 → 不再自动续刷；
          // 因重启中断 → 保留标记；续刷后 1 分钟内又挂了（多半是登录态问题）也保留，等下次重启再试
          const ranMs = Date.now() - (r.startedAt || Date.now());
          const keep = shuttingDown || (r.startedByResume && ranMs < 60000);
          if (!keep) delete d3.users[uname].autoResume;
          r.startedByResume = false;
          saveUsers(d3);
        }
      } catch (e) {}
    });

  return { ok: true };
}

// ---------- HTTP ----------
// 兜底：任何未捕获异常只记日志，绝不让整个服务退出（以前一个请求出错就重启，
// 重启循环会把所有号的刷课进度反复打断）
process.on("uncaughtException", (e) => {
  try {
    console.error("[uncaught] " + ((e && e.stack) || e));
  } catch (x) {}
});
process.on("unhandledRejection", (e) => {
  try {
    console.error("[unhandled] " + ((e && e.stack) || e));
  } catch (x) {}
});

const server = http.createServer((req, res) => {
  // 路由内部再包一层，单个接口抛错只影响这一次请求
  try {
    handle(req, res);
  } catch (e) {
    try {
      console.error("[route] " + ((e && e.stack) || e));
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "服务器内部错误：" + (e && e.message) }));
      } else {
        res.end();
      }
    } catch (x) {}
  }
});

function handle(req, res) {
  const u = req.url.split("?")[0];
  const url = new URL("http://x" + req.url);
  const db = loadUsers();
  const cookies = parseCookies(req);

  const json = (o, code, headers) => {
    res.writeHead(code || 200, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}));
    res.end(JSON.stringify(o));
  };
  const body = (cb) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { cb(JSON.parse(b || "{}")); } catch (e) { json({ ok: false, error: "请求格式错误" }); }
    });
  };

  // 页面
  if (u === "/" || u === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page());
    return;
  }
  // 管理后台页面（本身不校验，页面里的接口会按登录态判断权限）
  if (u === "/admin" || u === "/admin.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    try {
      res.end(fs.readFileSync(ADMIN_PAGE_FILE, "utf8"));
    } catch (e) {
      res.end("<meta charset='utf-8'><h2>后台页面缺失</h2>");
    }
    return;
  }
  if (u === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  // ---------------- 云端共享题库 ----------------
  // 所有账号答过的题汇到 data/bank-shared.json；答题时先查这里，再问大模型。
  // 用 x-bank-key 做一道轻门槛（默认 shared，可由 .env 的 BANK_KEY 改）。
  if (u === "/api/bank") {
    if (!bankKeyOk(req)) {
      json({ ok: false, error: "题库密钥不对" }, 401);
      return;
    }
    if (req.method === "GET") {
      const bank = loadSharedBank();
      json({ ok: true, total: Object.keys(bank.entries || {}).length, entries: bank.entries || {} });
      return;
    }
    if (req.method === "POST") {
      // 用统一的 body() 读请求体：之前这里引用了一个不存在的 readBody，
      // 只要有人推题库就会抛 ReferenceError 把整个服务打死（重启循环的元凶）
      body((p) => {
        const inc = p && p.entries && typeof p.entries === "object" ? p.entries : {};
        let r;
        try {
          r = mergeSharedBank(inc);
        } catch (e) {
          json({ ok: false, error: "合并失败：" + (e && e.message) }, 500);
          return;
        }
        json({ ok: true, total: r.total, added: r.added, updated: r.updated, skipped: r.skipped || 0 });
      });
      return;
    }
  }

  // 版本与更新公告（公开，不需要登录）
  if (u === "/api/version") {
    json({
      ok: true,
      role: "cloud",
      version: VERSION.cloudVersion,
      buildAt: VERSION.buildAt,
      changelog: VERSION.changelog,
      announcement: loadAnnounce(),
      localVersion: VERSION.version,
      latest: loadRelease(),
      // 本地版从这里拿到共享题库地址与密钥，自动接入云端题库
      bank: {
        url: (process.env.UPDATE_URL || "").replace(/\/+$/, "") || ("http://127.0.0.1:" + PORT),
        key: BANK_KEY,
        total: Object.keys(loadSharedBank().entries || {}).length,
        llmModel: GLOBAL_LLM.model,
        llmEnabled: GLOBAL_LLM.enabled,
      },
    });
    return;
  }

  // 下载最新本地版：优先发本机托管的文件，其次 302 到外部链接（蓝奏云等）
  if (u === "/download" || u === "/download/") {
    const rel = loadRelease();
    if (rel.localFile) {
      const p = path.join(RELEASE_DIR, rel.localFile);
      let st = null;
      try { st = fs.statSync(p); } catch (e) { st = null; }
      if (st) {
        const total = st.size;
        const name = String(rel.localFile);
        const disp =
          'attachment; filename="chaoxing-' + rel.version + '.zip"; filename*=UTF-8\'\'' + encodeURIComponent(name);
        const baseHdr = {
          "Content-Type": "application/zip",
          "Content-Disposition": disp,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        };
        // 支持断点续传 / 多线程下载
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(String(range));
          let start = m && m[1] ? parseInt(m[1], 10) : 0;
          let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
          if (!(start >= 0) || start >= total) {
            res.writeHead(416, { "Content-Range": "bytes */" + total });
            res.end();
            return;
          }
          end = Math.min(end, total - 1);
          res.writeHead(206, Object.assign({}, baseHdr, {
            "Content-Range": "bytes " + start + "-" + end + "/" + total,
            "Content-Length": end - start + 1,
          }));
          fs.createReadStream(p, { start, end }).pipe(res);
          return;
        }
        res.writeHead(200, Object.assign({}, baseHdr, { "Content-Length": total }));
        fs.createReadStream(p).pipe(res);
        return;
      }
    }
    if (rel.downloadUrl) {
      res.writeHead(302, { Location: rel.downloadUrl, "Cache-Control": "no-store" });
      res.end();
      return;
    }
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<meta charset='utf-8'><h2>暂无下载地址</h2><p>请联系飞飞 索取最新版</p>");
    return;
  }

  // 登录
  if (u === "/api/login" && req.method === "POST") {
    body(async (p) => {
      try {
        const uname = String(p.uname || "").trim();
        const password = String(p.password || "");
        if (!uname || !password) return json({ ok: false, error: "请填写账号密码" });
        // 白名单先拦一道：没开通的账号直接拒绝，不去消耗超星的登录次数
        if (!isAllowed(uname)) {
          pushLog(uname, "被白名单拦截");
          return json({ ok: false, error: NOT_ALLOWED_MSG, code: "not_whitelisted" });
        }

        const rec = db.users[uname] || {};
        const cfg = {
          uname, password,
          fid: p.fid && String(p.fid).trim() ? String(p.fid).trim() : (rec.fid || "-1"),
          forceLogin: true, saveCookie: null,
          skipCourse: rec.skipCourse || "",
          parallel: 1,
          dailyHours: rec.dailyHours == null ? 24 : rec.dailyHours,
          brushStart: rec.brushStart == null ? 0 : rec.brushStart,
          brushEnd: rec.brushEnd == null ? 24 : rec.brushEnd,
          proxy: p.proxy != null && String(p.proxy).trim() ? String(p.proxy).trim() : (rec.proxy || ""),
        };
        const lo = new Loginer(cfg);
        const cookie = await lo.login();
        const session = new Session({ cookie, debug: false, proxy: cfg.proxy });
        const courses = await CourseData.list(session, { courseType: 1 });

        const sid = crypto.randomBytes(24).toString("hex");
        const token = crypto.randomBytes(16).toString("hex");
        db.users[uname] = Object.assign(rec, {
          uname,
          encPassword: encrypt(password),
          cookie,
          fid: cfg.fid,
          proxy: cfg.proxy,
          sid,
          lastLogin: Date.now(),
        });
        saveUsers(db);

        const r = rt(uname);
        r.session = session;
        r.token = token;
        r.sid = sid;
        pushLog(uname, `登录成功，课程 ${courses.length} 门`);

        json({
          ok: true,
          token,
          isAdmin: isAdminUser(uname),
          courses: courses.map((c) => ({ courseId: c.courseId, title: c.title })),
        }, 200, {
          "Set-Cookie": sidCookie(sid),
        });
      } catch (e) {
        json({ ok: false, error: String(e && e.message ? e.message : e), needCaptcha: !!(e && e.needCaptcha) });
      }
    });
    return;
  }

  // 退出
  if (u === "/api/logout" && req.method === "POST") {
    const rec = findUserBySid(db, cookies.sid);
    if (rec) {
      delete db.users[rec.uname].sid;
      saveUsers(db);
      const r = runtime[rec.uname];
      if (r) { r.sid = null; r.token = null; }
    }
    json({ ok: true }, 200, { "Set-Cookie": "sid=; Path=/; Max-Age=0" });
    return;
  }

  // 鉴权：sid Cookie 优先，其次 token
  let uname = null;
  const bySid = findUserBySid(db, cookies.sid);
  if (bySid) uname = bySid.uname;
  if (!uname) {
    const tk = url.searchParams.get("token") || req.headers["x-token"] || "";
    uname = Object.keys(runtime).find((k) => runtime[k].token && runtime[k].token === tk) || null;
  }
  // Cookie 有效但内存里没有运行时对象 → 补建（服务器重启后免登录）
  if (uname && !runtime[uname]) rt(uname);

  // 账号被移出白名单 → 现有会话立即失效（保留 sid，重新加回白名单即可恢复，不用重登）
  if (uname && !isAllowed(uname)) {
    const r = runtime[uname];
    if (r && r.task && r.task.stop && r.running) {
      try { r.task.stop(); } catch (e) {}
      pushLog(uname, "⏹ 已被移出白名单，任务已停止");
    }
    json({ ok: false, error: NOT_ALLOWED_MSG, code: "not_whitelisted" }, 403);
    return;
  }

  if (u.startsWith("/api/") && !u.startsWith("/api/admin/") && !uname) {
    json({ ok: false, error: "未登录或会话已失效" }, 401);
    return;
  }

  // 我是谁 + 设置
  if (u === "/api/me") {
    const rec = db.users[uname] || {};
    json({
      ok: true,
      uname,
      isAdmin: isAdminUser(uname),
      settings: {
        dailyHours: rec.dailyHours == null ? 24 : rec.dailyHours,
        brushStart: rec.brushStart == null ? 0 : rec.brushStart,
        brushEnd: rec.brushEnd == null ? 24 : rec.brushEnd,
        skipCourse: rec.skipCourse || "",
      },
      running: !!rt(uname).running,
    });
    return;
  }

  // 课程列表（不用启动任务就能看到，用于勾选）
  if (u === "/api/courses") {
    (async () => {
      const rec0 = (loadUsers().users || {})[uname] || {};
      const cached = Array.isArray(rec0.courses) ? rec0.courses : [];
      try {
        const s = ensureSession(uname);
        if (!s) {
          if (cached.length) return json({ ok: true, courses: cached, cached: true });
          return json({ ok: false, error: "登录已失效，请重新登录" }, 401);
        }
        const list = await CourseData.list(s, { courseType: 1 });
        if (!list.length) {
          // 线上暂时拉不到（可能是超星抖动），用上次记录，避免选课列表空白
          if (cached.length) return json({ ok: true, courses: cached, cached: true });
          return json({ ok: false, error: "没拉到课程，请稍后重试或重新登录" });
        }
        const out = list.map((c) => ({ courseId: c.courseId, title: c.title }));
        const d = loadUsers();
        if (d.users[uname]) { d.users[uname].courses = out; saveUsers(d); }
        json({ ok: true, courses: out });
      } catch (e) {
        if (cached.length) return json({ ok: true, courses: cached, cached: true });
        json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return;
  }

  // 保存设置
  if (u === "/api/settings" && req.method === "POST") {
    body((p) => {
      const rec = db.users[uname] || { uname };
      if (p.skipCourse != null) rec.skipCourse = String(p.skipCourse);
      for (const k of ["dailyHours", "brushStart", "brushEnd"]) {
        if (p[k] != null && p[k] !== "" && !isNaN(Number(p[k]))) rec[k] = Number(p[k]);
      }
      // 正确率区间：0~100，自动纠正上下限反了的输入
      if (p.accuracyMin != null && p.accuracyMin !== "" && !isNaN(Number(p.accuracyMin))) {
        rec.accuracyMin = Math.max(0, Math.min(100, Math.round(Number(p.accuracyMin))));
      }
      if (p.accuracyMax != null && p.accuracyMax !== "" && !isNaN(Number(p.accuracyMax))) {
        rec.accuracyMax = Math.max(0, Math.min(100, Math.round(Number(p.accuracyMax))));
      }
      if (rec.accuracyMin != null && rec.accuracyMax != null && rec.accuracyMin > rec.accuracyMax) {
        const t = rec.accuracyMin;
        rec.accuracyMin = rec.accuracyMax;
        rec.accuracyMax = t;
      }
      if (p.workEnabled != null) rec.workEnabled = !!p.workEnabled;
      if (p.workRounds != null && !isNaN(Number(p.workRounds))) {
        rec.workRounds = Math.max(1, Math.min(3, Number(p.workRounds)));
      }
      // 在线答题源：题库接口
      if (p.answerRemoteEnabled != null) rec.answerRemoteEnabled = !!p.answerRemoteEnabled;
      if (p.answerRemoteUrl != null) rec.answerRemoteUrl = String(p.answerRemoteUrl).trim();
      if (p.answerRemoteToken != null && p.answerRemoteToken !== "") rec.answerRemoteToken = String(p.answerRemoteToken).trim();
      if (p.answerRemoteToken === "__CLEAR__") rec.answerRemoteToken = "";
      // 在线答题源：大模型（key 只进不出）
      if (p.llmEnabled != null) rec.llmEnabled = !!p.llmEnabled;
      if (p.llmBaseUrl != null) rec.llmBaseUrl = String(p.llmBaseUrl).trim();
      if (p.llmModel != null) rec.llmModel = String(p.llmModel).trim();
      if (p.llmApiKey != null && p.llmApiKey !== "") rec.llmApiKey = String(p.llmApiKey).trim();
      if (p.llmApiKey === "__CLEAR__") rec.llmApiKey = "";
      if (p.llmMaxCalls != null && !isNaN(Number(p.llmMaxCalls))) {
        rec.llmMaxCalls = Math.max(0, Math.min(2000, Math.round(Number(p.llmMaxCalls))));
      }
      db.users[uname] = rec;
      saveUsers(db);
      json({ ok: true, settings: rec });
    });
    return;
  }

  // 读设置（页面初始化、以及"正确率"卡片显示用）
  if (u === "/api/settings" && req.method === "GET") {
    const rec = db.users[uname] || {};
    return json({
      ok: true,
      settings: {
        skipCourse: rec.skipCourse || "",
        dailyHours: rec.dailyHours == null ? 24 : rec.dailyHours,
        brushStart: rec.brushStart == null ? 0 : rec.brushStart,
        brushEnd: rec.brushEnd == null ? 24 : rec.brushEnd,
        accuracyMin: rec.accuracyMin == null ? 80 : rec.accuracyMin,
        accuracyMax: rec.accuracyMax == null ? 100 : rec.accuracyMax,
        workEnabled: rec.workEnabled !== false,
        workRounds: rec.workRounds == null ? 2 : rec.workRounds,
        // 答题源：key/token 只回报"有没有配"
        answerRemoteEnabled: rec.answerRemoteEnabled === true,
        answerRemoteUrl: rec.answerRemoteUrl || "",
        hasAnswerRemoteToken: !!rec.answerRemoteToken,
        llmEnabled: rec.llmEnabled === true,
        llmBaseUrl: rec.llmBaseUrl || "",
        llmModel: rec.llmModel || "",
        llmMaxCalls: rec.llmMaxCalls == null ? 200 : rec.llmMaxCalls,
        hasLlmKey: !!rec.llmApiKey,
      },
    });
  }

  // 开始
  if (u === "/api/start" && req.method === "POST") {
    body(async (p) => {
      try {
        await startTask(uname, Array.isArray(p.courseIds) ? p.courseIds.map(String) : null);
        json({ ok: true });
      } catch (e) {
        json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });
    return;
  }

  // 停止（随时，立即生效）
  if (u === "/api/stop" && req.method === "POST") {
    const r = rt(uname);
    let forced = false;
    if (r.task && r.task.stop) { r.task.stop(); forced = true; }
    if (r.running) { r.running = false; forced = true; } // 立刻反映到界面，不等收尾
    // 用户主动停止 = 不要自动续刷
    try {
      const d = loadUsers();
      if (d.users[uname]) { delete d.users[uname].autoResume; saveUsers(d); }
    } catch (e) {}
    pushLog(uname, forced ? "⏹ 已强制停止，进度已保存，下次接着刷" : "当前没有运行中的任务");
    json({ ok: true, forced });
    return;
  }

  // 状态（轮询兜底）
  if (u === "/api/state") {
    json(stateOf(uname));
    return;
  }

  // 实时推送
  if (u === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = () => {
      try { res.write("data: " + JSON.stringify(stateOf(uname)) + "\n\n"); } catch (e) {}
    };
    send();
    const r = rt(uname);
    const timer = setInterval(send, 2000);
    const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 15000);
    r.sse.add(res);
    req.on("close", () => {
      clearInterval(timer);
      clearInterval(hb);
      r.sse.delete(res);
    });
    return;
  }

  // 管理员
  if (u === "/api/admin/users") {
    if (!adminAllowed(req, url, uname)) return json({ ok: false, error: "无权限" }, 403);
    const list = Object.values(db.users).map((x) => {
      const r = runtime[x.uname] || {};
      return {
        uname: x.uname,
        lastLogin: x.lastLogin,
        running: !!r.running,
        passed: r.task ? r.task.stats.passed : (x.lastState && x.lastState.stats ? x.lastState.stats.passed : null),
        risk: r.task ? r.task.risk.level : null,
      };
    });
    json({ ok: true, users: list, runningNow: runningCount(), maxRunning: MAX_RUNNING });
    return;
  }

  // 管理员：账号白名单（GET 查看 / POST 修改）
  if (u === "/api/admin/whitelist") {
    if (!adminAllowed(req, url, uname)) return json({ ok: false, error: "无权限" }, 403);
    if (req.method === "GET") return json({ ok: true, whitelist: loadWhitelist() });
    body((p) => {
      const cur = loadWhitelist();
      const next = {
        enabled: p.enabled != null ? !!p.enabled : cur.enabled,
        unames: cur.unames.slice(),
        note: p.note != null ? String(p.note) : cur.note,
      };
      if (Array.isArray(p.unames)) {
        next.unames = p.unames.map((x) => String(x).trim()).filter(Boolean);
      }
      if (Array.isArray(p.add)) {
        p.add.forEach((x) => {
          const v = String(x).trim();
          if (v && next.unames.indexOf(v) === -1) next.unames.push(v);
        });
      }
      if (Array.isArray(p.remove)) {
        const rm = p.remove.map((x) => String(x).trim());
        next.unames = next.unames.filter((x) => rm.indexOf(x) === -1);
      }
      saveWhitelist(next);
      console.log("[whitelist] enabled=" + next.enabled + " 名单 " + next.unames.length + " 个: " + next.unames.join(","));
      json({ ok: true, whitelist: next });
    });
    return;
  }

  // 管理员：发布新版本下载地址（蓝奏云），不用重新打包
  if (u === "/api/admin/release" && req.method === "POST") {
    if (!adminAllowed(req, url, uname)) return json({ ok: false, error: "无权限" }, 403);
    body((p) => {
      const cur = loadRelease();
      const rel = {
        version: String(p.version || cur.version),
        downloadUrl: String(p.downloadUrl != null ? p.downloadUrl : cur.downloadUrl),
        localFile: String(p.localFile != null ? p.localFile : cur.localFile),
        note: String(p.note != null ? p.note : cur.note),
        updatedAt: Date.now(),
      };
      try { fs.writeFileSync(RELEASE_FILE, JSON.stringify(rel, null, 1), "utf8"); } catch (e) {}
      console.log("[release] 新版本已发布: v" + rel.version + " → " + (rel.localFile || rel.downloadUrl));
      json({ ok: true, release: loadRelease() });
    });
    return;
  }

  // 管理员：发公告
  if (u === "/api/admin/announce" && req.method === "POST") {
    if (!adminAllowed(req, url, uname)) return json({ ok: false, error: "无权限" }, 403);
    body((p) => {
      const a = {
        id: String(p.id || Date.now()),
        title: String(p.title || "更新公告"),
        date: String(p.date || new Date().toISOString().slice(0, 10)),
        items: Array.isArray(p.items) ? p.items.map(String) : [],
      };
      try { fs.writeFileSync(ANNOUNCE_FILE, JSON.stringify(a, null, 1), "utf8"); } catch (e) {}
      json({ ok: true, announcement: a });
    });
    return;
  }

  // 管理员：后台总览（一次拉齐所有数据）
  if (u === "/api/admin/overview") {
    if (!adminAllowed(req, url, uname)) return json({ ok: false, error: "无权限" }, 403);
    const w = loadWhitelist();
    const users = Object.values(db.users).map((x) => {
      const r = runtime[x.uname] || {};
      const t = r.task;
      const st = (t && t.stats) || (x.lastState && x.lastState.stats) || {};
      return {
        uname: x.uname,
        running: !!r.running,
        passed: st.passed || 0,
        failed: st.failed || 0,
        risk: t ? (t.risk && t.risk.level) : null,
        lastLogin: x.lastLogin || 0,
        hasCookie: !!x.cookie,
        online: !!x.sid,
        inWhitelist: w.unames.indexOf(x.uname) !== -1,
        courses: (x.lastState && x.lastState.courses) || x.courses || [],
      };
    });
    const mem = process.memoryUsage();
    json({
      ok: true,
      me: uname,
      admins: ADMIN_USERS,
      users,
      runningNow: runningCount(),
      maxRunning: MAX_RUNNING,
      whitelist: w,
      announce: loadAnnounce(),
      release: loadRelease(),
      version: { cloud: VERSION.cloudVersion, local: VERSION.version, buildAt: VERSION.buildAt },
      mem: { rssMB: Math.round(mem.rss / 1024 / 1024), heapMB: Math.round(mem.heapUsed / 1024 / 1024) },
      uptimeSec: Math.round(process.uptime()),
    });
    return;
  }

  // 管理员：对某个账号操作（停止任务 / 踢下线）
  if (u === "/api/admin/user-action" && req.method === "POST") {
    if (!adminAllowed(req, url, uname)) return json({ ok: false, error: "无权限" }, 403);
    body((p) => {
      const target = String(p.uname || "").trim();
      const action = String(p.action || "");
      if (!target) return json({ ok: false, error: "缺少账号" });
      const r = runtime[target];
      if (action === "stop") {
        if (r && r.task && r.task.stop) { r.task.stop(); pushLog(target, "⏹ 管理员停止任务"); }
        return json({ ok: true, action, uname: target });
      }
      if (action === "kick") {
        const d = loadUsers();
        if (d.users[target]) { delete d.users[target].sid; saveUsers(d); }
        if (r) { r.sid = null; r.token = null; }
        pushLog(target, "🚪 管理员踢下线");
        return json({ ok: true, action, uname: target });
      }
      json({ ok: false, error: "未知操作" });
    });
    return;
  }

  json({ ok: false, error: "not found" }, 404);
}

// 每 30 秒把运行中任务的状态落盘（服务器重启后前端还能看到进度）
setInterval(() => {
  const running = Object.keys(runtime).filter((k) => runtime[k].running && runtime[k].task);
  if (!running.length) return;
  const db = loadUsers();
  let dirty = false;
  for (const k of running) {
    try {
      const t = runtime[k].task;
      db.users[k].lastState = {
        stats: t.stats,
        ui: t.ui,
        courses: Object.values(t.courseProgress || {}),
        risk: t.risk,
        time: { usedMs: Date.now() - (runtime[k].startedAt || Date.now()) },
      };
      dirty = true;
    } catch (e) {}
  }
  if (dirty) saveUsers(db);
}, 30000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("========================================");
  console.log("  超星刷课 云端多人版   飞飞 出品");
  console.log("========================================");
  console.log("  监听端口: " + PORT);
  console.log("  同时刷课上限: " + MAX_RUNNING + " 人");
  console.log("  管理员密码: " + (ADMIN_PASSWORD ? "已设置" : "未设置（无法查看用户列表）"));
  console.log("  访问地址: http://服务器IP:" + PORT);
  console.log("  断点续刷: " + (autoResumeEnabled() ? "已开启" : "已关闭"));
  console.log("  联系邮箱: cc040921f@gmail.com");
  console.log("========================================");
  console.log("");

  // 服务启动（含更新后重启）→ 自动接着刷上次中断的任务
  autoResumeAll();
});

// ---------- 断点续刷 ----------
function autoResumeEnabled() {
  return String(process.env.AUTO_RESUME || "1") !== "0";
}

/** 把运行中的任务状态立刻写盘（重启前调用） */
function flushState(uname) {
  const r = runtime[uname];
  if (!r || !r.task) return;
  try {
    const d = loadUsers();
    if (!d.users[uname]) return;
    const t = r.task;
    d.users[uname].lastState = {
      stats: t.stats,
      ui: t.ui,
      courses: Object.values(t.courseProgress || {}),
      risk: t.risk,
      time: { usedMs: Date.now() - (r.startedAt || Date.now()) },
    };
    saveUsers(d);
  } catch (e) {}
}

/** 启动后把上次没刷完的任务重新拉起来 */
function autoResumeAll() {
  if (!autoResumeEnabled()) return;
  let list = [];
  try {
    const db = loadUsers();
    list = Object.values(db.users).filter((x) => x && x.autoResume && x.uname);
  } catch (e) { return; }
  if (!list.length) return;

  console.log("[续刷] 发现 " + list.length + " 个未完成的任务，开始自动续刷");
  list.forEach((rec, i) => {
    const uname = rec.uname;
    const p = rec.runParams || {};
    setTimeout(async () => {
      try {
        if (!rec.cookie && !rec.encPassword) {
          pushLog(uname, "⏸ 上次的任务没能续刷：登录态已失效，请重新登录后再点开始");
          return;
        }
        await startTask(uname, Array.isArray(p.courseIds) && p.courseIds.length ? p.courseIds : null);
        runtime[uname].startedByResume = true;
        pushLog(uname, "🔄 服务已重启完成，自动接着上次的进度继续刷");
        console.log("[续刷] " + uname + " 已自动续刷");
      } catch (e) {
        pushLog(uname, "⏸ 自动续刷失败：" + (e && e.message ? e.message : e) + "（可手动点开始）");
        console.log("[续刷] " + uname + " 失败: " + (e && e.message ? e.message : e));
      }
    }, 3000 + i * 4000);
  });
}

/** 收到重启/关闭信号：保存进度、停任务，保留续刷标记 */
function gracefulShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[" + sig + "] 正在保存进度并停止任务…");
  for (const uname of Object.keys(runtime)) {
    flushState(uname);
    try {
      const r = runtime[uname];
      if (r && r.task && r.task.stop) r.task.stop();
    } catch (e) {}
  }
  setTimeout(() => process.exit(0), 1200);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
