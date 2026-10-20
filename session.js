/**
 * 会话层：统一封装带 cookie 的 HTTP 请求。
 *
 * 2026 版学习通要点：
 *  - 大部分接口在 mooc1-1.chaoxing.com / mooc2-ans.chaoxing.com
 *  - 课程列表是 POST /mooc-ans/visit/courselistdata
 *  - 进入课程会 302 到 mooc2-ans，Location 里带 enc（必须原样跟随）
 *  - 上报接口必须带原始 otherInfo（不能 URL 编码），否则 403 code=6
 */
const fetch = require("node-fetch");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const sleep = (t) => new Promise((y) => setTimeout(y, t));

/** 判定是否属于网络层故障（值得长时间等待重连，而不是直接放弃） */
const NET_ERRORS = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EPIPE|socket hang up|network|getaddrinfo/i;

class Session {
  constructor(opts) {
    opts = opts || {};
    this.cookie = opts.cookie || "";
    this.domain = opts.domain || "https://mooc1-1.chaoxing.com";
    this.debug = !!opts.debug;
    this.retry = opts.retry == null ? 3 : opts.retry;
    this.timeout = opts.timeout == null ? 30000 : opts.timeout;
    // 断网重连：默认最多等约 1 小时（指数退避，5s→300s 封顶）
    this.netRetry = opts.netRetry == null ? 40 : opts.netRetry;
    this.onNetWait = opts.onNetWait || null;
    // 代理支持：HTTP/HTTPS 或 SOCKS5（每个用户可绑不同出口 IP，降低同 IP 风控）
    this.proxy = opts.proxy || "";
    this._agent = null;
    if (this.proxy) {
      try {
        if (/^socks/i.test(this.proxy)) {
          const { SocksProxyAgent } = require("socks-proxy-agent");
          this._agent = new SocksProxyAgent(this.proxy);
        } else {
          const { HttpsProxyAgent } = require("https-proxy-agent");
          this._agent = new HttpsProxyAgent(this.proxy);
        }
      } catch (e) {
        console.error("[session] 代理初始化失败: " + e.message);
        this._agent = null;
      }
    }

    const map = {};
    String(this.cookie)
      .split(";")
      .forEach((s) => {
        const i = s.indexOf("=");
        if (i > 0) map[s.slice(0, i).trim()] = s.slice(i + 1).trim();
      });
    this.cookies = map;
    this.fid = map["fid"] || map["_fid"] || "";
    this.uid = map["_uid"] || map["UID"] || "";
  }

  headers(referer, extra) {
    const h = {
      "User-Agent": UA,
      Cookie: this.cookie,
      "Accept-Language": "zh-CN,zh;q=0.9",
    };
    if (referer) h["Referer"] = referer;
    return Object.assign(h, extra || {});
  }

  async req(url, opts) {
    opts = opts || {};
    const init = {
      method: opts.method || "GET",
      headers: this.headers(opts.referer, opts.headers),
      redirect: opts.redirect || "manual",
      timeout: this.timeout,
    };
    if (opts.body) init.body = opts.body;
    if (this._agent) init.agent = this._agent;

    let lastErr;
    let netWait = 0;
    for (let attempt = 1; attempt <= this.retry; attempt++) {
      try {
        const res = await fetch(url, init);
        const text = await res.text();
        // 动态吸收服务端下发的会话 cookie（route/jrose/k8s 等）
        // 没有这些，log 上报虽返回 200 但进度不记账
        try {
          (res.headers.raw()["set-cookie"] || []).forEach((c) => {
            const kv = c.split(";")[0];
            const i = kv.indexOf("=");
            if (i > 0) this.cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
          });
          this.cookie = Object.entries(this.cookies).map(([k, v]) => k + "=" + v).join("; ");
        } catch (e) {}
        if (netWait) {
          const msg = `[http] 网络已恢复（等待 ${Math.round(netWait / 1000)}s）`;
          if (this.onNetWait) this.onNetWait(msg); else if (this.debug) console.log(msg);
          netWait = 0;
        }
        if (this.debug) console.log(`[http] ${init.method} ${res.status} ${url.slice(0, 120)}`);
        const loc = res.headers.get("location") || "";
        // 风控拦截：立即停止，绝不重试（继续请求会加重封禁）
        if (/antispider|antispiderShowMsg/i.test(loc) || /antispider/i.test(res.url || "")) {
          const err = new Error("账号被学习通风控拦截（访问异常），必须停止并人工解除");
          err.blocked = true;
          throw err;
        }
        // 302 跳登录页 = 登录态失效，交给上层自动重登
        if (res.status === 302 && /passport2|login|passport/i.test(loc) && !/stucoursemiddle|studentcourse/i.test(url)) {
          const err = new Error("登录态已失效（被重定向到登录页）");
          err.expired = true;
          throw err;
        }
        return { status: res.status, text, location: res.headers.get("location"), url: res.url };
      } catch (e) {
        lastErr = e;
        // 风控拦截 / 登录态失效：不重试，直接上抛
        if (e && (e.expired || e.blocked)) throw e;
        const msg = String(e && e.message ? e.message : e);
        // 网络层故障：长时间退避重连，不消耗普通重试次数
        if (NET_ERRORS.test(msg) && netWait / 1000 < this.netRetry * 300) {
          netWait += Math.min(300000, 5000 + netWait);
          const line = `[http] 网络中断（${msg.slice(0, 60)}），${Math.round(netWait / 1000)}s 后重试`;
          if (this.onNetWait) this.onNetWait(line); else console.log(line);
          await sleep(netWait);
          attempt--; // 不占用普通重试额度
          continue;
        }
        if (this.debug) console.log(`[http] 第${attempt}次失败 ${url.slice(0, 90)}: ${msg}`);
        if (attempt < this.retry) await sleep(400 * attempt);
      }
    }
    throw lastErr;
  }

  get(url, referer) {
    return this.req(url, { method: "GET", referer });
  }

  postForm(url, params, referer) {
    const body = new URLSearchParams();
    Object.keys(params).forEach((k) => body.append(k, params[k]));
    return this.req(url, {
      method: "POST",
      referer,
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  /** GET 并自动跟随 302（最多 5 跳），返回最终 HTML */
  async follow(url, referer, maxHop) {
    maxHop = maxHop == null ? 5 : maxHop;
    let cur = url;
    let ref = referer;
    for (let i = 0; i <= maxHop; i++) {
      const r = await this.req(cur, { method: "GET", referer: ref });
      if (r.status >= 300 && r.status < 400 && r.location) {
        const next = r.location.startsWith("http")
          ? r.location
          : new URL(r.location, cur).href;
        ref = cur;
        cur = next;
        continue;
      }
      return { text: r.text, status: r.status, url: cur };
    }
    throw new Error("重定向层数过多: " + url);
  }
}

module.exports = Session;
module.exports.UA = UA;
