/**
 * 答题源链：本地题库 → 外部题库接口（兼容 OCS 的 AnswererWrapper）→ 大模型（OpenAI 兼容）
 *
 * 为什么这么设计：
 *   1) 本地题库（quizbank.json）：免费、零延迟，答过一次就永远记得，命中率随时间上涨
 *   2) 外部题库接口：一次请求拿答案，最省 token。协议照抄 OCS 的 AnswererWrapper，
 *      所以任何 OCS 能用的题库服务这里也能用
 *   3) 大模型：兜底。用 OpenAI 兼容的 /chat/completions，硅基流动、智谱 GLM-4-Flash、
 *      DeepSeek、本地 Ollama、OpenRouter 免费模型都行——只填 baseUrl / model / key 即可
 *
 * 注意：不抓网页版聊天。抓网页既不稳定也违反对方条款；免费额度都在 API 上。
 */
const http = require("http");
const https = require("https");
const A = require("./answerer.js");

const TYPE_LABEL = { 0: "单选题", 1: "多选题", 2: "填空题", 3: "判断题" };

/** 极简 HTTP 请求（不引第三方依赖，超时可中断） */
function request(urlStr, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error("地址不合法：" + urlStr));
    }
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const payload = o.body == null ? null : Buffer.from(String(o.body), "utf8");
    const headers = Object.assign({}, o.headers);
    if (payload) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      headers["Content-Length"] = payload.length;
    }
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: o.method || (payload ? "POST" : "GET"),
        headers,
        timeout: o.timeoutMs || 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, text });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("请求超时"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 题干 + 选项 → 给模型的提示词 */
function buildPrompt(q) {
  const type = Number(q.type);
  const keys = Object.keys(q.options || {}).sort();
  const lines = [];
  lines.push("这是一道" + (TYPE_LABEL[type] || "题") + "，请直接给出答案。");
  lines.push("题目：" + String(q.title || "").trim());
  if (type === 3) {
    lines.push("选项：A.对  B.错");
  } else if (keys.length) {
    lines.push("选项：");
    for (const k of keys) lines.push(k + ". " + String(q.options[k] || "").trim());
  }
  if (type === 2) {
    lines.push("这是填空题，请给出应填内容本身（多个空用 | 分隔），不要解释。");
  } else if (type === 1) {
    lines.push("这是多选题，可能有多项正确。只输出选项字母，例如 ABD，不要解释。");
  } else {
    lines.push("只输出一个选项字母（A/B/C/D），不要解释。");
  }
  return lines.join("\n");
}

/** 从模型回复里抠出选项字母 */
function parseLlmAnswer(text, q) {
  const type = Number(q.type);
  const s = String(text || "").trim();
  if (!s) return null;
  if (type === 2) {
    const m = s.match(/^(?:答案[:：]\s*)?(.+)$/m);
    return m ? m[1].replace(/[。.]$/, "").trim() : null;
  }
  const keys = type === 3 ? ["A", "B"] : Object.keys(q.options || {}).sort();
  // ① 模型直接答了选项内容（例如"丙"）
  const byText = A.extractLetters(s, q.options || {});
  const okText = byText.filter((l) => keys.includes(l));
  if (okText.length) return type === 1 ? Array.from(new Set(okText)).sort().join("") : okText[0];
  // ② 回复里含独立字母串（"答案：B"、"选 B，因为…"、"ABD"）
  const cands = [];
  const re = /(?:^|[^A-Za-z])([A-Za-z]{1,6})(?![A-Za-z])/g;
  let m;
  while ((m = re.exec(s))) {
    const t = m[1].toUpperCase().split("");
    if (t.every((c) => keys.includes(c))) cands.push(t.join(""));
  }
  if (cands.length) {
    const first = cands[0];
    return type === 1 ? Array.from(new Set(first.split(""))).sort().join("") : first[0];
  }
  // ③ 判断题口语回答
  if (type === 3) {
    const b = A.toBool(s);
    if (b != null) return A.judgeAnswerToLetter(b, { A: "对", B: "错" });
  }
  return null;
}

class AnswerProvider {
  /**
   * @param {Object} opts
   *   bank       本地题库对象（会写回）
   *   onSaved    落盘回调
   *   remote     { enabled, url, token, timeoutMs }  外部题库（OCS AnswererWrapper 协议）
   *   llm        { enabled, baseUrl, apiKey, model, timeoutMs, maxCalls }
   *   log        日志
   */
  constructor(opts) {
    const o = opts || {};
    this.bank = o.bank || A.emptyBank();
    this.onSaved = o.onSaved || null;
    this.remote = Object.assign({ enabled: false, url: "", token: "", timeoutMs: 12000 }, o.remote || {});
    // 云端共享题库：所有账号答过的题汇在一起，本地没答案时先问它
    this.shared = Object.assign(
      { enabled: false, url: "", key: "", timeoutMs: 8000, pullMs: 15000 },
      o.shared || {}
    );
    this.llm = Object.assign(
      {
        enabled: false,
        baseUrl: "",
        apiKey: "",
        model: "",
        timeoutMs: 20000,
        maxCalls: 200, // 每次运行最多调多少次，防烧额度
      },
      o.llm || {}
    );
    this.log = o.log || (() => {});
    this.stats = { remoteHit: 0, llmHit: 0, llmCalls: 0, failed: 0, cached: 0, cloudHit: 0, cloudPulled: 0, cloudPushed: 0 };
    this._lastPull = 0;
  }

  /** 有没有配置任何在线答题源 */
  get online() {
    return (
      !!(this.shared.enabled && this.shared.url) ||
      !!(this.remote.enabled && this.remote.url) ||
      !!(this.llm.enabled && this.llm.baseUrl && this.llm.model)
    );
  }

  /** 云端共享题库：拉下来并合并进本地题库（默认 60 秒内不重复拉） */
  async refreshShared(force) {
    if (!this.shared.enabled || !this.shared.url) return 0;
    const now = Date.now();
    if (!force && this._lastPull && now - this._lastPull < this.shared.pullMs) return 0;
    this._lastPull = now;
    let j = null;
    try {
      const r = await request(String(this.shared.url).replace(/\/+$/, "") + "/api/bank", {
        method: "GET",
        headers: { "x-bank-key": this.shared.key || "" },
        timeoutMs: this.shared.timeoutMs,
      });
      if (r.status !== 200) {
        this.stats.failed++;
        return 0;
      }
      j = JSON.parse(r.text);
    } catch (e) {
      this.stats.failed++;
      return 0;
    }
    if (!j || !j.ok || !j.entries) return 0;
    const inc = j.entries;
    const rank = (e) => (e && e.correct ? 3 : e && e.guess ? 2 : e && (e.wrong || e.members) ? 1 : 0);
    let merged = 0;
    for (const k of Object.keys(inc)) {
      const e = inc[k];
      if (!e) continue;
      const old = this.bank.entries[k];
      if (!old) {
        this.bank.entries[k] = e;
        merged++;
        continue;
      }
      if (rank(e) > rank(old)) {
        this.bank.entries[k] = Object.assign({}, old, e);
        merged++;
      } else if (rank(e) === rank(old) && rank(e) >= 1) {
        const w = new Set([].concat(old.wrong || [], e.wrong || []));
        const m = new Set([].concat(old.members || [], e.members || []));
        this.bank.entries[k] = Object.assign({}, old, { wrong: Array.from(w), members: Array.from(m) });
      }
    }
    this.stats.cloudPulled = merged;
    if (merged && this.onSaved) this.onSaved();
    return merged;
  }

  /** 把本地题库推回云端（答题/批阅后调用，服务端按可信度合并） */
  async pushShared() {
    if (!this.shared.enabled || !this.shared.url) return 0;
    const all = this.bank.entries || {};
    // 只推有用的条目：自检残留（没有 q 字段的假题）、空条目一律不推；
    // type 缺失的按 0（单选）补齐，避免云端出现 type:null 的脏数据
    const entries = {};
    for (const k of Object.keys(all)) {
      const e = all[k];
      if (!e || typeof e !== "object") continue;
      if (!e.q && !e.correct && !e.guess) continue;
      const clean = Object.assign({}, e);
      if (clean.type == null) clean.type = 0;
      if (!clean.q) clean.q = k;
      entries[k] = clean;
    }
    const n = Object.keys(entries).length;
    if (!n) return 0;
    try {
      const r = await request(String(this.shared.url).replace(/\/+$/, "") + "/api/bank", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bank-key": this.shared.key || "" },
        body: JSON.stringify({ entries }),
        timeoutMs: this.shared.timeoutMs,
      });
      if (r.status !== 200) {
        this.stats.failed++;
        return 0;
      }
      const j = JSON.parse(r.text);
      if (j && j.ok) {
        this.stats.cloudPushed = (j.added || 0) + (j.updated || 0);
        return this.stats.cloudPushed;
      }
    } catch (e) {
      this.stats.failed++;
    }
    return 0;
  }

  /**
   * 在线求解一道题（本地题库由调用方先查）
   * @returns {Promise<{answer:string, from:string, confidence:number}|null>}
   */
  async resolve(q) {
    if (!q || !q.title) return null;
    // ① 云端共享题库（别的账号答过的题，先问它，最省）
    if (this.shared.enabled && this.shared.url) {
      await this.refreshShared();
      const hit = A.solve(this.bank, { type: Number(q.type), title: q.title, options: q.options || {} });
      if (hit && hit.answer && hit.confidence >= 0.7) {
        this.stats.cloudHit++;
        return { answer: hit.answer, from: "cloud-bank", confidence: hit.confidence };
      }
    }
    // ② 外部题库
    if (this.remote.enabled && this.remote.url) {
      const r = await this._askRemote(q);
      if (r) {
        this.stats.remoteHit++;
        this._remember(q, r, 0.85);
        return { answer: r, from: "remote-bank", confidence: 0.85 };
      }
    }
    // ③ 大模型
    if (this.llm.enabled && this.llm.baseUrl && this.llm.model) {
      if (this.stats.llmCalls >= this.llm.maxCalls) {
        this.log(`     ⚠ 大模型调用已达上限 ${this.llm.maxCalls} 次，本次运行不再调用`);
        return null;
      }
      const r = await this._askLlm(q);
      if (r) {
        this.stats.llmHit++;
        // 大模型的答案给 0.6 的置信度：实测免费模型在超星题上只有三四成准，
        // 给高了会让压分器误判成"已掌握"、按满分规划，一错整卷就崩
        // 大模型答案的可信度。默认 0.9：题库实测 deepseek-v4.1-flash 在
        // 超星判断题上 96.7%（29/30），qwen3.8-max 93.3%，已经够高。
        // 早期给 0.6 是因为当时的免费模型只有三四成准，换模型后要跟着调。
        const conf = Number(this.llm.confidence) > 0 ? Number(this.llm.confidence) : 0.9;
        this._remember(q, r, conf);
        return { answer: r, from: "llm", confidence: conf };
      }
    }
    return null;
  }

  /** 把在线得到的答案记进本地题库（标成"待验证"，等批阅结果纠正） */
  _remember(q, answer, conf) {
    try {
      const e = A.entryOf(this.bank, q.title);
      e.type = Number(q.type);
      e.guess = answer;
      e.guessConf = conf;
      e.updatedAt = Date.now();
      if (this.onSaved) this.onSaved();
    } catch (e) {}
  }

  /** 外部题库：兼容 OCS AnswererWrapper（POST {title, options, type}） */
  async _askRemote(q) {
    const keys = Object.keys(q.options || {}).sort();
    const body = JSON.stringify({
      title: String(q.title || "").trim(),
      options: keys.map((k) => k + "." + String(q.options[k] || "").trim()),
      type: TYPE_LABEL[Number(q.type)] || "单选题",
    });
    const headers = { "Content-Type": "application/json" };
    if (this.remote.token) headers.Authorization = "Bearer " + this.remote.token;
    try {
      const r = await request(this.remote.url, {
        method: "POST",
        body,
        headers,
        timeoutMs: this.remote.timeoutMs,
      });
      if (r.status !== 200) return null;
      let j = null;
      try {
        j = JSON.parse(r.text);
      } catch (e) {
        return null;
      }
      // 常见返回：{code:1, data:{answer:"A"}} / {code:0, question:"A"} / {answer:"A"}
      const raw =
        (j && j.data && (j.data.answer || j.data.答案)) ||
        (j && (j.answer || j.答案 || j.question)) ||
        (j && j.data && j.data.data && j.data.data.answer) ||
        "";
      const ans = parseLlmAnswer(String(raw), q);
      if (ans) return ans;
      if (j && j.code === 0 && j.question) return parseLlmAnswer(String(j.question), q);
      return null;
    } catch (e) {
      this.stats.failed++;
      return null;
    }
  }

  /** 大模型：OpenAI 兼容 /chat/completions */
  async _askLlm(q) {
    this.stats.llmCalls++;
    const base = String(this.llm.baseUrl || "").replace(/\/+$/, "");
    const url = /\/chat\/completions$/.test(base) ? base : base + "/chat/completions";
    // 现在主流模型（deepseek-v4 / qwen3.8 / glm-4.5+）全是推理模型：
    // max_tokens 给小了会被思考过程吃光，content 变空串 → 实测直接把 96% 打成 0%
    const maxTokens = Number(this.llm.maxTokens) > 0 ? Number(this.llm.maxTokens) : 800;
    const payload = {
      model: this.llm.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        {
          role: "system",
          content:
            "你是严谨的答题器，只按题型要求输出答案（选项字母或填空内容），不要解释、不要复述题目。",
        },
        { role: "user", content: buildPrompt(q) },
      ],
    };
    // 智谱系可以用 thinking 开关直接关掉思考；不支持的平台传了会被 400，所以只对智谱发
    if (/bigmodel\.cn|zhipu/i.test(base)) payload.thinking = { type: "disabled" };
    const body = JSON.stringify(payload);
    try {
      const r = await request(url, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.llm.apiKey,
        },
        timeoutMs: this.llm.timeoutMs,
      });
      if (r.status !== 200) {
        this.stats.failed++;
        if (r.status === 401 || r.status === 403) this.log(`     ⚠ 大模型鉴权失败（检查 key）`);
        return null;
      }
      let j = null;
      try {
        j = JSON.parse(r.text);
      } catch (e) {
        return null;
      }
      const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
      const content = msg.content || "";
      let ans = parseLlmAnswer(content, q);
      // content 空 / 没解析出答案时，从 reasoning_content 末尾再抠一次
      // （推理模型把答案写在思考过程的最后一句，content 偶尔仍是空的）
      if (!ans && msg.reasoning_content) {
        const rc = String(msg.reasoning_content);
        const hits = rc.match(/[（(【\s]*([ABCD])[）)】\s]*(?:选项|项|正确|答案|为)/g);
        if (hits && hits.length) {
          const last = hits[hits.length - 1].match(/([ABCD])/);
          if (last) ans = parseLlmAnswer(last[1], q);
        }
        if (!ans) {
          const tail = rc.slice(-120);
          const lm = tail.match(/([ABCD])(?![A-Za-z])/);
          if (lm) ans = parseLlmAnswer(lm[1], q);
        }
      }
      if (!ans) this.stats.failed++;
      return ans;
    } catch (e) {
      this.stats.failed++;
      return null;
    }
  }
}

module.exports = { AnswerProvider, buildPrompt, parseLlmAnswer, request, TYPE_LABEL };