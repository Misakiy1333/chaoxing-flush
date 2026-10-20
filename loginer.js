/**
 * 学习通登录器（2026 版协议）
 *
 * 逆向自 passport2-static.chaoxing.com/js/fanya/login.js?v=20260908
 * uname 与 password 均需 AES-128-CBC（key=iv="u2oh6Vu^HWe4_AES"，Pkcs7，Base64）。
 * 自带动态 cookie jar（吸收 route/jrose/k8s），与 session.js 无耦合。
 */
const CryptoJS = require("crypto-js");
const fetch = require("node-fetch");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const TRANSFER_KEY = "u2oh6Vu^HWe4_AES";

const sleep = (t) => new Promise((y) => setTimeout(y, t));

function encryptByAES(message, key) {
  key = key || TRANSFER_KEY;
  const k = CryptoJS.enc.Utf8.parse(key);
  const iv = CryptoJS.enc.Utf8.parse(key);
  const data = CryptoJS.enc.Utf8.parse(String(message));
  const out = CryptoJS.AES.encrypt(data, k, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  return CryptoJS.enc.Base64.stringify(out.ciphertext);
}

class Loginer {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.cookies = {};
    this.maxRetry = this.cfg.maxRetry == null ? 2 : this.cfg.maxRetry;
  }

  header(referer) {
    const h = { "User-Agent": UA };
    if (referer) h["Referer"] = referer;
    return h;
  }

  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => k + "=" + v).join("; ");
  }

  absorb(res) {
    (res.headers.raw()["set-cookie"] || []).forEach((c) => {
      const kv = c.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) this.cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
  }

  /** 代理 Agent（登录也要走同一出口 IP，否则风控更严） */
  agent() {
    if (this._agentTried) return this._agent || null;
    this._agentTried = true;
    const p = this.cfg && this.cfg.proxy;
    if (!p) return null;
    try {
      if (/^socks/i.test(p)) {
        const { SocksProxyAgent } = require("socks-proxy-agent");
        this._agent = new SocksProxyAgent(p);
      } else {
        const { HttpsProxyAgent } = require("https-proxy-agent");
        this._agent = new HttpsProxyAgent(p);
      }
    } catch (e) {
      console.error("[login] 代理初始化失败: " + e.message);
      this._agent = null;
    }
    return this._agent;
  }

  async get(url, referer) {
    const opt = {
      headers: Object.assign(this.header(referer), { Cookie: this.cookieHeader() }),
      redirect: "manual",
      timeout: 25000,
    };
    const a = this.agent();
    if (a) opt.agent = a;
    const r = await fetch(url, opt);
    this.absorb(r);
    return { status: r.status, text: await r.text(), location: r.headers.get("location") };
  }

  async post(url, params, referer) {
    const body = new URLSearchParams();
    Object.keys(params).forEach((k) => body.append(k, params[k]));
    const opt = {
      method: "POST",
      headers: Object.assign(this.header(referer), {
        Cookie: this.cookieHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      }),
      body,
      timeout: 25000,
    };
    const a = this.agent();
    if (a) opt.agent = a;
    const r = await fetch(url, opt);
    this.absorb(r);
    return { status: r.status, text: await r.text(), location: r.headers.get("location") };
  }

  /** 入口：优先复用 cookie，否则账号密码登录 */
  async login(opts) {
    opts = opts || {};
    // 分发版：登录框传入了新账号 → 忽略旧 cookie，强制账号登录
    if (this.cfg.forceLogin) {
      this.cfg.saveCookie = null;
    } else if (this.cfg.saveCookie && String(this.cfg.saveCookie).trim().length > 10) {
      console.log("[login] 尝试使用 config.json 中的 saveCookie");
      const ok = await this.verifyCookieStr(this.cfg.saveCookie);
      if (ok) {
        console.log("[login] cookie 有效，跳过登录");
        return this.cfg.saveCookie;
      }
      console.log("[login] cookie 已失效，转为账号密码登录");
    }

    let uname = this.cfg.uname;
    let password = this.cfg.password;
    if (!uname || !password) {
      throw "config.json 缺少 uname/password，请填写后重试";
    }

    let lastErr;
    for (let attempt = 1; attempt <= this.maxRetry; attempt++) {
      try {
        await this.doLogin(uname, password, opts.validate);
        console.log("[login] 登录成功");
        const ck = this.buildCookie();
        this.cfg.saveCookie = ck;
        try {
          if (this.cfg.write) await this.cfg.write();
          console.log("[login] cookie 已写入 config.json");
        } catch (e) {}
        return ck;
      } catch (e) {
        lastErr = e;
        console.log(`[login] 第 ${attempt} 次登录失败: ${e && e.message ? e.message : e}`);
        // 需要验证码：直接上抛，由界面提示用户输入
        if (e && e.needCaptcha) throw e;
        // 用户名/密码错误：绝对不能再试，多试几次会被超星锁号 87 分钟
        if (e && e.badCredential) {
          console.log("[login] 账号或密码错误，停止重试（避免触发锁号）");
          throw e;
        }
        const msg = String(e && e.message ? e.message : e);
        if (msg.indexOf("冻结") !== -1 || msg.indexOf("多次") !== -1) {
          console.log("[login] 账号已触发风控，停止重试。请等待 15 分钟后重试。");
          throw e;
        }
        if (attempt < this.maxRetry) await sleep(1500);
      }
    }
    throw lastErr && lastErr.message ? lastErr : "登录失败: " + lastErr;
  }

  /** 校验一段 cookie 字符串是否有效（用新版课程列表接口探测） */
  async verifyCookieStr(cookieStr) {
    try {
      const body = new URLSearchParams({
        courseType: "1",
        courseFolderId: "0",
        baseEducation: "0",
        superstarClass: "",
        courseFolderSize: "0",
      });
      const opt = {
        method: "POST",
        headers: { "User-Agent": UA, Cookie: cookieStr, "Content-Type": "application/x-www-form-urlencoded", Referer: "https://mooc1-1.chaoxing.com/visit/interaction" },
        body,
        timeout: 25000,
      };
      const a = this.agent();
      if (a) opt.agent = a;
      const r = await fetch("https://mooc1-1.chaoxing.com/mooc-ans/visit/courselistdata", opt);
      const t = await r.text();
      return !!(t && t.indexOf("stucoursemiddle") !== -1);
    } catch (e) {
      return false;
    }
  }

  /** 建立 session 并提交登录（AES 加密凭据） */
  async doLogin(uname, password, validate) {
    // 学校/单位 ID：多数学校用 -1（手机号直登）；用学号登录的学校可能需要填自己学校的 fid
    const fid = this.cfg && this.cfg.fid != null && String(this.cfg.fid).trim() !== "" ? String(this.cfg.fid).trim() : "-1";
    // 1) 登录页领 JSESSIONID/route
    await this.get("https://passport2.chaoxing.com/login?fid=" + (fid === "-1" ? "" : encodeURIComponent(fid)) + "&refer=http%3A%2F%2Fi.mooc.chaoxing.com");

    // 2) 提交加密凭据
    const r = await this.post(
      "https://passport2.chaoxing.com/fanyalogin",
      {
        fid: fid,
        uname: encryptByAES(uname),
        password: encryptByAES(password),
        refer: "http%3A%2F%2Fi.mooc.chaoxing.com",
        t: "true",
        forbidotherlogin: "0",
        validate: validate || "",
        doubleFactorLogin: "0",
        independentId: "0",
        independentNameId: "0",
      },
      "https://passport2.chaoxing.com/login"
    );

    let j;
    try {
      j = JSON.parse(r.text);
    } catch (e) {
      throw "登录响应解析失败: " + String(r.text).slice(0, 200);
    }

    if (j.status === true || j.status === "true") {
      if (j.containTwoFactorLogin) {
        throw "该账号开启了双因子认证，需在网页端完成验证后用 --cookie 参数运行";
      }
      return j;
    }

    const msg = String(j.msg2 || j.msg || j.message || "");
    const err = new Error(msg || "用户名或密码错误");
    // 需要验证码 / 需要网页端验证 等，交给上层决定
    if (/验证码|validate|code/i.test(msg)) err.needCaptcha = true;
    // 凭据错误：不可重试（重试 = 帮着把账号锁掉）
    if (/密码|账号|用户名|不存在|错误/.test(msg) && !/冻结|锁定|多次/.test(msg)) err.badCredential = true;
    err.raw = r.text.slice(0, 300);
    throw err;
  }

  /** 取登录验证码图片（返回 {buffer, contentType}） */
  async fetchCaptcha() {
    const url = "https://passport2.chaoxing.com/num/code?time=" + Date.now();
    const opt = {
      headers: Object.assign(this.header("https://passport2.chaoxing.com/login"), {
        Cookie: this.cookieHeader(),
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      }),
      timeout: 20000,
    };
    const a = this.agent();
    if (a) opt.agent = a;
    const res = await fetch(url, opt);
    this.absorb(res);
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, contentType: res.headers.get("content-type") || "image/png", status: res.status };
  }

  /** 提取关键 cookie 字段 */
  buildCookie() {
    const need = ["_uid", "_d", "vc3", "UID", "uf", "fid"];
    const picked = [];
    for (const k of need) {
      if (this.cookies[k] != null && this.cookies[k] !== "") picked.push(`${k}=${this.cookies[k]}`);
    }
    if (!picked.length) return this.cookieHeader();
    console.log("[login] 关键字段: " + picked.map((x) => x.split("=")[0]).join(", "));
    return picked.join("; ") + "; ";
  }
}

Loginer.encryptByAES = encryptByAES;
Loginer.TRANSFER_KEY = TRANSFER_KEY;
module.exports = Loginer;
