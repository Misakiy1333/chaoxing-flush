const fs = require("fs");
const path = require("path");

/**
 * 配置读写。
 * 配置项:
 *   uname      超星账号（手机号）
 *   password   密码（明文或 ENC: 前缀的加密串）
 *   speed      刷课倍速（默认 2，建议 1.5~4）
 *   test       是否自动答题（保留字段，默认 true）
 *   pick       是否进入手动选课模式
 *   pickinfos  选课结果，{clazzId: {picked: bool, title: string}}
 *   saveCookie 可选，登录后的 cookie 字符串，填了就跳过登录
 *   domain     可选，默认 https://mooc1-1.chaoxing.com/
 *   debug      可选，打印协议细节
 */
class Config {
  constructor(p) {
    // SEA exe 模式：config.json 与 exe 同目录；源码模式：与项目同目录
    let base = __dirname;
    try {
      if (process.execPath && process.execPath.toLowerCase().endsWith(".exe") &&
          !/node(\.exe)?$/i.test(process.execPath)) {
        base = path.dirname(process.execPath);
      }
    } catch (e) {}
    this.path = p || path.resolve(base, "config.json");
    this.uname = null;
    this.password = null;
    this.speed = 2;
    this.pick = false;
    this.test = true;
    this.saveCookie = null;
    this.pickinfos = null;
    this.domain = "https://mooc1-1.chaoxing.com/";
    this.debug = false;
    // 云端更新/公告地址：本地版启动时会去这里查新版本和公告（可改成自己的服务器）
    this.updateUrl = require("./version.js").updateUrl || "";
    // 章节测验/作业自动作答 + 正确率区间（默认 80%~90%，界面上可改）
    this.workEnabled = true;
    this.accuracyMin = 80;
    this.accuracyMax = 90;
    this.workRounds = 2;
    // 在线答题源：外部题库接口（兼容 OCS AnswererWrapper）
    this.answerRemoteEnabled = false;
    this.answerRemoteUrl = "";
    this.answerRemoteToken = "";
    // 在线答题源：大模型（OpenAI 兼容，硅基流动/智谱/DeepSeek/Ollama 都行）
    this.llmEnabled = false;
    this.llmBaseUrl = "https://open.bigmodel.cn/api/paas/v4";
    this.llmApiKey = "";
    this.llmModel = "glm-4-flash";
    this.llmMaxCalls = 200;
    // 云端共享题库（本地版默认指向云端；服务器自己用 127.0.0.1）
    this.sharedBankUrl = "";
    this.sharedBankKey = "shared";
    this._exists = false;
  }

  /** 写入配置，密码若未加密则自动加密存储 */
  async write() {
    const { encrypt } = require("./crypto-util.js");
    // 保留所有业务字段（skipCourse/parallel/reportInterval 等），避免每次写回丢配置
    const out = {
      uname: this.uname,
      password:
        typeof this.password === "string" && this.password.startsWith("ENC:")
          ? this.password
          : encrypt(this.password == null ? "" : String(this.password)),
      speed: this.speed,
      test: this.test,
      pick: this.pick,
      pickinfos: this.pickinfos,
      saveCookie: this.saveCookie,
      domain: this.domain,
      debug: this.debug,
    };
    const skip = new Set([
      "path", "saveCookie", "uname", "password", "speed", "test", "pick",
      "pickinfos", "domain", "debug", "_exists", "write", "read",
      "forceLogin", "dryRun", "onlyCourse", "log", "quizAgent", "maxRetry",
    ]);
    for (const k of Object.keys(this)) {
      if (skip.has(k)) continue;
      if (typeof this[k] === "function") continue;
      if (this[k] === undefined) continue;
      out[k] = this[k];
    }
    return await fs.promises.writeFile(this.path, JSON.stringify(out, null, "\t"), {
      encoding: "utf8",
    });
  }

  /** 读取配置，返回 this；文件不存在时返回带默认值的 this */
  async read() {
    const defaults = {
      speed: 2,
      pick: false,
      test: true,
      domain: "https://mooc1-1.chaoxing.com/",
      debug: false,
      updateUrl: require("./version.js").updateUrl || "",
      workEnabled: true,
      accuracyMin: 80,
      accuracyMax: 90,
      workRounds: 2,
      answerRemoteEnabled: false,
      answerRemoteUrl: "",
      answerRemoteToken: "",
      llmEnabled: false,
      llmBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      llmApiKey: "",
      llmModel: "glm-4-flash",
      llmMaxCalls: 200,
      sharedBankUrl: "",
      sharedBankKey: "shared",
    };
    let raw;
    try {
      raw = await fs.promises.readFile(this.path, { encoding: "utf8" });
      this._exists = true;
    } catch (e) {
      console.log(`[config] 未找到配置文件: ${this.path}`);
      console.log(`[config] 请复制 config.example.json 为 config.json 并填写账号密码`);
      Object.assign(this, defaults);
      return this;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // 配置损坏不退出：备份坏文件，用默认值继续（界面重新登录即可）
      console.error(`[config] config.json 格式有误(${e.message})，已忽略并使用默认配置`);
      try {
        await fs.promises.copyFile(this.path, this.path + ".bad");
        console.error("[config] 损坏文件已备份为 config.json.bad");
      } catch (e2) {}
      Object.assign(this, defaults);
      this._exists = false;
      return this;
    }

    // 兼容旧字段名
    if (parsed.saveCookit && !parsed.saveCookie) parsed.saveCookie = parsed.saveCookit;

    const cfg = Object.assign(defaults, parsed);

    // 解密密码（密文与机器绑定：从别的电脑拷过来的配置解不开，清空让人重新输入即可）
    if (typeof cfg.password === "string" && cfg.password.startsWith("ENC:")) {
      try {
        const { decrypt } = require("./crypto-util.js");
        cfg.password = decrypt(cfg.password.slice(4));
      } catch (e) {
        console.error("[config] 保存的密码无法在本机解密（配置来自其他电脑），已清空，请在页面重新输入密码");
        cfg.password = "";
        cfg.saveCookie = null;
        cfg._needPassword = true;
      }
    }

    for (const key in cfg) this[key] = cfg[key];

    // ⚠ 环境变量优先级最高：服务器 .env 里配一次，所有账号共用同一把大模型 key
    const env = process.env;
    if (env.LLM_ENABLED === "1" || env.LLM_ENABLED === "true") this.llmEnabled = true;
    if (env.LLM_ENABLED === "0" || env.LLM_ENABLED === "false") this.llmEnabled = false;
    if (env.LLM_BASE_URL) this.llmBaseUrl = env.LLM_BASE_URL;
    if (env.LLM_API_KEY) this.llmApiKey = env.LLM_API_KEY;
    if (env.LLM_MODEL) this.llmModel = env.LLM_MODEL;
    if (env.LLM_MAX_CALLS) this.llmMaxCalls = Number(env.LLM_MAX_CALLS) || this.llmMaxCalls;
    if (env.SHARED_BANK_URL) this.sharedBankUrl = env.SHARED_BANK_URL;
    if (env.SHARED_BANK_KEY) this.sharedBankKey = env.SHARED_BANK_KEY;
    return this;
  }
}

module.exports = Config;
