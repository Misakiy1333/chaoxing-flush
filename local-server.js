/**
 * 本地版服务端（单用户）
 *
 * 提供和云端版**完全一致**的 /api/* 接口，前端共用 web/multi.html，
 * 所以本地 exe 和云端网站的界面、进度、风控面板、开始/停止行为都一样。
 *
 * 存储：config.json（密码 AES 加密、cookie 本地保存 → 刷新免登录）
 */
const http = require("http");
const crypto = require("crypto");

const Config = require("./config.js");
const Loginer = require("./loginer.js");
const Session = require("./session.js");
const CourseData = require("./course.js");
const CourseTask = require("./courseTask.js");
const { QuizAgent } = require("./quizAgent.js");
const VERSION = require("./version.js");

const HTML = require("./web-page.js");

/** 版本号比较：a 是否比 b 新 */
function isNewer(a, b) {
  const pa = String(a || "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

class LocalServer {
  constructor(opts) {
    opts = opts || {};
    this.port = opts.port || 8765;
    this.cfg = null;
    this.session = null;
    this.task = null;
    this.running = false;
    this.taskActive = false;
    this.startedAt = 0;
    this.logs = [];
    this.sse = new Set();
    this.lastState = null;
  }

  async init() {
    this.cfg = new Config();
    await this.cfg.read();
    // 有存档 cookie 就直接建会话（刷新/重启免登录）
    if (this.cfg.saveCookie) {
      this.session = new Session({ cookie: this.cfg.saveCookie, debug: false, proxy: this.cfg.proxy || "" });
    }
    // 后台查一次云端版本，不阻塞启动与页面渲染
    this.cloudInfo().catch(() => {});
    return this;
  }

  /** 云端更新服务器地址（共享题库也走它） */
  _bankBase() {
    return String((this.cfg && this.cfg.updateUrl) || VERSION.updateUrl || "").replace(/\/+$/, "");
  }

  /** 向云端查最新版本与公告（缓存 1 小时，失败不影响本地使用） */
  async cloudInfo(force) {
    const now = Date.now();
    if (!force && this._cloudAt && now - this._cloudAt < 3600 * 1000) return this._cloud;
    const base = String((this.cfg && this.cfg.updateUrl) || VERSION.updateUrl || "").replace(/\/+$/, "");
    if (!base) return null;
    try {
      const fetch = require("node-fetch");
      const r = await fetch(base + "/api/version", { timeout: 3500 });
      const j = await r.json();
      if (j && j.ok) {
        this._cloud = j;
        this._cloudAt = now;
        return j;
      }
    } catch (e) {}
    this._cloudAt = now;
    return this._cloud || null;
  }

  log(...a) {
    const line = a.join(" ");
    console.log(line);
    this.logs.push(line);
    if (this.logs.length > 600) this.logs.splice(0, this.logs.length - 600);
  }

  settings() {
    return {
      dailyHours: this.cfg.dailyHours == null ? 24 : Number(this.cfg.dailyHours),
      brushStart: this.cfg.brushStart == null ? 0 : Number(this.cfg.brushStart),
      brushEnd: this.cfg.brushEnd == null ? 24 : Number(this.cfg.brushEnd),
      skipCourse: this.cfg.skipCourse || "",
      accuracyMin: this.cfg.accuracyMin == null ? 80 : Number(this.cfg.accuracyMin),
      accuracyMax: this.cfg.accuracyMax == null ? 90 : Number(this.cfg.accuracyMax),
      workEnabled: this.cfg.workEnabled !== false,
      workRounds: this.cfg.workRounds == null ? 2 : Number(this.cfg.workRounds),
      answerRemoteEnabled: this.cfg.answerRemoteEnabled === true,
      answerRemoteUrl: this.cfg.answerRemoteUrl || "",
      hasAnswerRemoteToken: !!this.cfg.answerRemoteToken,
      llmEnabled: this.cfg.llmEnabled === true,
      llmBaseUrl: this.cfg.llmBaseUrl || "",
      llmModel: this.cfg.llmModel || "",
      llmMaxCalls: this.cfg.llmMaxCalls == null ? 200 : Number(this.cfg.llmMaxCalls),
      hasLlmKey: !!(this.cfg.llmApiKey || (this._cloud && this._cloud.bank && this._cloud.bank.llmEnabled)),
      // 云端共享题库
      sharedBankUrl: this.cfg.sharedBankUrl || this._bankBase() || "",
      bankTotal: (this._cloud && this._cloud.bank && this._cloud.bank.total) || 0,
    };
  }

  stateOf() {
    const snap = this.task && this.task.snapshot ? this.task.snapshot() : null;
    const base = snap || this.lastState || {};
    return {
      ok: true,
      uname: this.cfg.uname || "本机",
      running: !!this.running,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      stats: base.stats || null,
      ui: base.ui || null,
      quiz: base.quiz || (this.task && this.task.quizAgent ? this.task.quizAgent.stats : null) || null,
      courses: base.courses || [],
      works: base.works || [],
      answer: base.answer || null,
      risk: base.risk || { level: "ok", blockHits: 0, coolingUntil: 0, coolingLeftMs: 0, lastBlockAt: 0, note: "" },
      time: base.time || null,
      settings: this.settings(),
      logs: this.logs.slice(-80),
      local: true,
    };
  }

  async login(uname, password, fid, proxy) {
    const lo = new Loginer({
      uname,
      password,
      fid: fid && String(fid).trim() ? String(fid).trim() : this.cfg.fid || "-1",
      forceLogin: true,
      saveCookie: null,
      proxy: proxy || this.cfg.proxy || "",
    });
    const cookie = await lo.login();
    const s = new Session({ cookie, debug: false, proxy: proxy || this.cfg.proxy || "" });
    const courses = await CourseData.list(s, { courseType: 1 });

    this.cfg.uname = uname;
    this.cfg.password = password;
    this.cfg.saveCookie = cookie;
    if (fid) this.cfg.fid = String(fid);
    if (proxy) this.cfg.proxy = String(proxy);
    await this.cfg.write();

    this.session = s;
    this.log(`登录成功，课程 ${courses.length} 门`);
    return courses.map((c) => ({ courseId: c.courseId, title: c.title }));
  }

  async start(courseIds) {
    if (this.running) throw new Error("任务已在运行");
    if (this.taskActive) throw new Error("上一个任务正在停止，请等几秒再启动");
    if (!this.session) throw new Error("请先登录");

    const cfg = {
      uname: this.cfg.uname,
      // 页面明确勾选时以勾选为准；跳过列表只影响"默认勾选"状态
      skipCourse: Array.isArray(courseIds) && courseIds.length ? "" : (this.cfg.skipCourse || ""),
      parallel: 1,
      dailyHours: this.cfg.dailyHours == null ? 24 : Number(this.cfg.dailyHours),
      brushStart: this.cfg.brushStart == null ? 0 : Number(this.cfg.brushStart),
      brushEnd: this.cfg.brushEnd == null ? 24 : Number(this.cfg.brushEnd),
      speed: 1,
      humanMode: true,
      onlyCourse: Array.isArray(courseIds) && courseIds.length ? courseIds.map(String) : null,
      // 章节测验/作业 + 正确率区间（设置页可改，默认 80~90）
      workEnabled: this.cfg.workEnabled !== false,
      accuracyMin: this.cfg.accuracyMin == null ? 80 : Number(this.cfg.accuracyMin),
      accuracyMax: this.cfg.accuracyMax == null ? 90 : Number(this.cfg.accuracyMax),
      workRounds: this.cfg.workRounds == null ? 2 : Number(this.cfg.workRounds),
      // 在线答题源
      answerRemoteEnabled: this.cfg.answerRemoteEnabled === true,
      answerRemoteUrl: this.cfg.answerRemoteUrl || "",
      answerRemoteToken: this.cfg.answerRemoteToken || "",
      llmEnabled: this.cfg.llmEnabled === true,
      llmBaseUrl: this.cfg.llmBaseUrl || "",
      llmApiKey: this.cfg.llmApiKey || "",
      llmModel: this.cfg.llmModel || "",
      llmMaxCalls: this.cfg.llmMaxCalls == null ? 200 : Number(this.cfg.llmMaxCalls),
      // 云端共享题库：本地版也用云端题库（地址取自更新服务器，配了就生效）
      sharedBankUrl: this.cfg.sharedBankUrl || this._bankBase() || "",
      sharedBankKey: this.cfg.sharedBankKey || (this._cloud && this._cloud.bank && this._cloud.bank.key) || "shared",
      log: (l) => this.log(l),
    };

    const quizAgent = new QuizAgent(this.session);
    const task = new CourseTask(this.session, cfg);
    task.cfg.log = (l) => this.log(l);
    task.quizAgent = quizAgent;
    if (!quizAgent.hz) quizAgent.hz = task.hz;

    task.cfg.relogin = async () => {
      const lo = new Loginer({
        uname: this.cfg.uname,
        password: this.cfg.password,
        forceLogin: true,
        saveCookie: null,
        fid: this.cfg.fid || "-1",
        proxy: this.cfg.proxy || "",
      });
      const ck = await lo.login();
      this.cfg.saveCookie = ck;
      await this.cfg.write();
      this.session = new Session({ cookie: ck, debug: false, proxy: this.cfg.proxy || "" });
      return ck;
    };

    this.task = task;
    this.running = true;
    this.taskActive = true;
    this.startedAt = Date.now();
    this.logs = [];
    this.log("▶ 收到启动指令");

    task.run()
      .then(() => this.log("任务结束"))
      .catch((e) => this.log("异常: " + (e && e.message ? e.message : e)))
      .finally(() => {
        this.running = false;
        this.taskActive = false;
        try {
          this.lastState = {
            stats: task.stats, ui: task.ui,
            courses: Object.values(task.courseProgress || {}),
            risk: task.risk,
            time: { usedMs: Date.now() - (this.startedAt || Date.now()) },
          };
        } catch (e) {}
      });
  }

  stop() {
    const had = !!this.running;
    if (this.task && this.task.stop) this.task.stop();
    if (this.running) this.running = false; // 立即生效，不等收尾
    this.log(had ? "⏹ 已强制停止，进度已保存，下次接着刷" : "当前没有运行中的任务");
    return had;
  }

  serve() {
    const server = http.createServer((req, res) => this.route(req, res));
    const listen = (port) => {
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && port < this.port + 20) listen(port + 1);
        else { console.error("[本地版] 监听失败: " + e.message); process.exit(1); }
      });
      server.listen(port, "127.0.0.1", () => {
        this.actualPort = port;
        const url = `http://127.0.0.1:${port}`;
        console.log("");
        console.log("========================================");
        console.log("  超星刷课助手  本地版  v" + VERSION.version + "        飞飞 出品");
        console.log("  联系邮箱: cc040921f@gmail.com");
        console.log("========================================");
        console.log("  控制台地址: " + url);
        console.log("");
        console.log("  和云端版完全相同的界面：实时进度、风控面板、");
        console.log("  随时开始/停止、刷新免登录。");
        console.log("");
        console.log("  关闭本窗口 = 停止程序（进度不丢，重开续播）。");
        console.log("========================================");
        console.log("");
        if (this.onListening) this.onListening(url);
      });
    };
    listen(this.port);
    return server;
  }

  readBody(req) {
    return new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        try { resolve(JSON.parse(b || "{}")); } catch (e) { resolve({}); }
      });
    });
  }

  route(req, res) {
    const u = req.url.split("?")[0];
    const json = (o, code) => {
      res.writeHead(code || 200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(o));
    };

    if (u === "/" || u === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(HTML);
      return;
    }
    if (u === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    // 版本与更新公告（公开；立即返回，不等云端）
    if (u === "/api/version") {
      if (!this._cloudAt) this.cloudInfo().catch(() => {});
      const cloud = this._cloud || null;
      const latest = (cloud && cloud.latest) || VERSION.latest || {};
      const latestVer = String(latest.version || VERSION.version);
      const newer = isNewer(latestVer, VERSION.version);
      // 下载走云端 /download 中转：蓝奏云链接换了，本地版不用跟着改
      const base = String((this.cfg && this.cfg.updateUrl) || VERSION.updateUrl || "").replace(/\/+$/, "");
      const downloadUrl = base ? base + "/download" : String(latest.downloadUrl || "");
      json({
        ok: true,
        role: "local",
        version: VERSION.version,
        buildAt: VERSION.buildAt,
        changelog: VERSION.changelog,
        announcement: (cloud && cloud.announcement) || {
          id: VERSION.buildAt + "-local",
          title: "更新公告",
          date: VERSION.buildAt,
          items: VERSION.changelog,
        },
        latest: {
          version: latestVer,
          downloadUrl,
          note: String(latest.note || ""),
        },
        updateUrl: base,
        newer,
        // 云端共享题库（本地版答题先查它，再问大模型）
        bank: {
          url: base,
          key: (cloud && cloud.bank && cloud.bank.key) || this.cfg.sharedBankKey || "shared",
          total: (cloud && cloud.bank && cloud.bank.total) || 0,
          enabled: !!base,
        },
        cloud: cloud
          ? {
              version: cloud.version,
              latestLocal: latestVer,
              newer,
              reachable: true,
            }
          : { reachable: false },
      });
      return;
    }

    // 登录态：有 cookie 存档就算已登录（本地没有密码也能免登录）
    const authed = !!(this.cfg && this.cfg.saveCookie);
    if (u.startsWith("/api/") && u !== "/api/login" && !authed) {
      json({ ok: false, error: "未登录或会话已失效" }, 401);
      return;
    }

    if (u === "/api/me") {
      json({ ok: true, uname: this.cfg.uname || "本机", settings: this.settings(), running: !!this.running, local: true });
      return;
    }

    if (u === "/api/login" && req.method === "POST") {
      this.readBody(req).then(async (p) => {
        try {
          if (!p.uname || !p.password) return json({ ok: false, error: "请填写账号密码" });
          const courses = await this.login(String(p.uname).trim(), String(p.password), p.fid, p.proxy);
          json({ ok: true, courses });
        } catch (e) {
          json({ ok: false, error: String(e && e.message ? e.message : e), needCaptcha: !!(e && e.needCaptcha) });
        }
      });
      return;
    }

    if (u === "/api/logout" && req.method === "POST") {
      this.stop();
      this.session = null;
      this.cfg.saveCookie = null;
      this.cfg.write().catch(() => {});
      try { res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "sid=; Path=/; Max-Age=0" }); } catch (e) {}
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (u === "/api/courses") {
      (async () => {
        try {
          if (!this.session) throw new Error("请先登录");
          const list = await CourseData.list(this.session, { courseType: 1 });
          const out = list.map((c) => ({ courseId: c.courseId, title: c.title }));
          if (out.length) this._lastCourses = out;
          // 线上拉空时用上次结果，避免选课列表空白
          json({ ok: true, courses: out.length ? out : (this._lastCourses || []), cached: !out.length });
        } catch (e) {
          if (this._lastCourses && this._lastCourses.length) {
            return json({ ok: true, courses: this._lastCourses, cached: true });
          }
          json({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      })();
      return;
    }

    if (u === "/api/settings" && req.method === "POST") {
      this.readBody(req).then(async (p) => {
        if (p.skipCourse != null) this.cfg.skipCourse = String(p.skipCourse);
        for (const k of ["dailyHours", "brushStart", "brushEnd"]) {
          if (p[k] != null && p[k] !== "" && !isNaN(Number(p[k]))) this.cfg[k] = Number(p[k]);
        }
        // 正确率区间（0~100，自动纠正上下限）
        for (const k of ["accuracyMin", "accuracyMax"]) {
          if (p[k] != null && p[k] !== "" && !isNaN(Number(p[k]))) {
            this.cfg[k] = Math.max(0, Math.min(100, Math.round(Number(p[k]))));
          }
        }
        if (Number(this.cfg.accuracyMin) > Number(this.cfg.accuracyMax)) {
          const t = this.cfg.accuracyMin;
          this.cfg.accuracyMin = this.cfg.accuracyMax;
          this.cfg.accuracyMax = t;
        }
        if (p.workEnabled != null) this.cfg.workEnabled = !!p.workEnabled;
        if (p.workRounds != null && !isNaN(Number(p.workRounds))) {
          this.cfg.workRounds = Math.max(1, Math.min(3, Number(p.workRounds)));
        }
        // 在线答题源：题库接口 + 大模型
        if (p.answerRemoteEnabled != null) this.cfg.answerRemoteEnabled = !!p.answerRemoteEnabled;
        if (p.answerRemoteUrl != null) this.cfg.answerRemoteUrl = String(p.answerRemoteUrl).trim();
        if (p.answerRemoteToken === "__CLEAR__") this.cfg.answerRemoteToken = "";
        else if (p.answerRemoteToken != null && p.answerRemoteToken !== "") this.cfg.answerRemoteToken = String(p.answerRemoteToken).trim();
        if (p.llmEnabled != null) this.cfg.llmEnabled = !!p.llmEnabled;
        if (p.llmBaseUrl != null) this.cfg.llmBaseUrl = String(p.llmBaseUrl).trim();
        if (p.llmModel != null) this.cfg.llmModel = String(p.llmModel).trim();
        if (p.llmApiKey === "__CLEAR__") this.cfg.llmApiKey = "";
        else if (p.llmApiKey != null && p.llmApiKey !== "") this.cfg.llmApiKey = String(p.llmApiKey).trim();
        if (p.llmMaxCalls != null && !isNaN(Number(p.llmMaxCalls))) {
          this.cfg.llmMaxCalls = Math.max(0, Math.min(2000, Math.round(Number(p.llmMaxCalls))));
        }
        try { await this.cfg.write(); } catch (e) {}
        json({ ok: true, settings: this.settings() });
      });
      return;
    }

    if (u === "/api/start" && req.method === "POST") {
      this.readBody(req).then(async (p) => {
        try {
          await this.start(Array.isArray(p.courseIds) ? p.courseIds : null);
          json({ ok: true });
        } catch (e) {
          json({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      });
      return;
    }

    if (u === "/api/stop" && req.method === "POST") {
      const forced = this.stop();
      json({ ok: true, forced });
      return;
    }

    if (u === "/api/state") {
      json(this.stateOf());
      return;
    }

    if (u === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = () => {
        try { res.write("data: " + JSON.stringify(this.stateOf()) + "\n\n"); } catch (e) {}
      };
      send();
      const timer = setInterval(send, 2000);
      const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 15000);
      this.sse.add(res);
      req.on("close", () => {
        clearInterval(timer);
        clearInterval(hb);
        this.sse.delete(res);
      });
      return;
    }

    json({ ok: false, error: "not found" }, 404);
  }
}

module.exports = LocalServer;
