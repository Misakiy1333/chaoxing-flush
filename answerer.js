/**
 * 答案引擎 —— 题目清洗 / 相似度匹配 / 单选·多选·判断 求解 / 题库读写
 *
 * 算法借鉴 ocsjs 开源实现（MIT）的几个关键点：
 *   1) 题干清洗：去掉题号、题型标注、分值标注、括号占位
 *   2) 相似度：归一化后按编辑距离求相似度，> 0.6 认为同题
 *   3) 判断题：关键词表（是/对/√/T/1/true  vs  否/错/×/F/0/false）
 *   4) 单选：归一化完全匹配 → 相似度匹配 → 纯字母答案 → 多片段合并
 *
 * 题库（quizbank.json）结构与视频弹题共用，除旧版 {题目: "A"} 之外新增：
 *   { v: 2, entries: { <key>: {
 *       q: "题干预览", type: 0|1|2|3,
 *       correct: "A" | null,        // 已确认正确的答案（多选为 "AB" 这种排序串）
 *       wrong: ["B", "C"],          // 已确认错误的单选项（单选/判断用）
 *       members: ["A"],             // 多选中已确认"属于正确答案"的选项
 *       tried: { "A": 0, "AB": 0.5 },// 尝试过的答案 → 得分率
 *       updatedAt: 1700000000000
 *   }}}
 */
const fs = require("fs");
const path = require("path");

const BANK_FILE = path.join(__dirname, "quizbank.json");

/* ------------------------------------------------------------------ 题目清洗 */

/** 题型标注形如 [单选题] 【多选题】 (判断题) 等 */
const TYPE_TAGS = [
  "单选题", "多选题", "判断题", "填空题", "简答题", "论述题", "问答题",
  "单选", "多选", "判断", "填空", "简答", "论述",
];

/**
 * 清洗题干：去掉题号、题型标注、分值、括号占位、空白
 * @param {string} raw
 * @returns {string}
 */
function cleanQuestion(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.replace(/\u00a0/g, " ");
  // 题号：1. / 1、 / 1) / （1） / 第1题
  s = s.replace(/^\s*[（(]?\s*\d+\s*[）)]?\s*[.、．。)）:：]\s*/g, "");
  s = s.replace(/^\s*第\s*\d+\s*题[\s.、．:：]*/g, "");
  // 题型标注：【单选题】 [多选题] （判断题） 等（可能在开头，也可能紧跟在题号后）
  for (const t of TYPE_TAGS) {
    s = s.replace(new RegExp(`^\\s*[【\\[(（]\\s*${t}\\s*[】\\])）]\\s*`, "g"), "");
  }
  // 分值：（2.0分） (2分) 【2分】
  s = s.replace(/[【\[(（]\s*\d+(?:\.\d+)?\s*分\s*[】\])）]/g, "");
  // 题型+分值组合：(单选题, 2.0分)
  s = s.replace(/[【\[(（]\s*[\u4e00-\u9fa5]{1,3}题\s*[,，]\s*\d+(?:\.\d+)?\s*分\s*[】\])）]/g, "");
  // 结尾括号占位：( ) （ ） (  )
  s = s.replace(/[（(]\s*[）)]\s*$/g, "");
  // 结尾的 ____ / （）/ 空白
  s = s.replace(/[_＿]{2,}\s*$/g, "");
  return s.replace(/\s+/g, "").trim();
}

/** 归一化：全角转半角、去标点空白、小写 */
function normalize(s) {
  return String(s == null ? "" : s)
    .replace(/\u00a0/g, " ")
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，。、；：？！“”‘’（）《》【】…—\-,.;:?!"'()<>\[\]]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}

/** 题库键：清洗后取前 120 字符 */
function qkey(raw) {
  return cleanQuestion(raw).slice(0, 120);
}

/** Lei how similar: 1 - editDistance/maxLen */
function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const m = x.length;
  const n = y.length;
  // 长度差太大直接判定不相似，省算力
  if (Math.abs(m - n) / Math.max(m, n) > 0.6) return 0;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const cx = x.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = cx === y.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  const d = prev[n];
  return 1 - d / Math.max(m, n);
}

/* ------------------------------------------------------------------ 判断题 */

const TRUE_WORDS = ["是", "对", "正确", "√", "t", "true", "1", "yes", "y", "对的", "正确的"];
const FALSE_WORDS = ["否", "错", "错误", "×", "x", "f", "false", "0", "no", "n", "错的", "错误的"];

/**
 * 把各种写法的判断答案归一为 true / false
 * @returns {boolean|null}
 */
function toBool(v) {
  if (v === true || v === false) return v;
  const s = normalize(String(v == null ? "" : v));
  if (!s) return null;
  if (TRUE_WORDS.includes(s)) return true;
  if (FALSE_WORDS.includes(s)) return false;
  // 包含式兜底：先看"不/否/错"再肯定词，避免"不正确"被当正确
  if (/不对|不是|错误|错的|不正确|false|^x$/.test(s)) return false;
  if (/^对|正确|^是|true/.test(s)) return true;
  return null;
}

/** 判断题选项：A=对 B=错（学习通固定顺序） */
function judgeAnswerToLetter(bool, options) {
  const list = options || {};
  const keys = Object.keys(list);
  for (const k of keys) {
    const b = toBool(list[k]);
    if (b === (bool ? true : false)) return k;
  }
  return bool ? (keys[0] || "A") : (keys[1] || "B");
}

/* ------------------------------------------------------------------ 单选题 */

/**
 * 从"答案文本"里抽取选项字母
 * 支持："A" / "AB" / "A,B" / "A、B" / "A、党的十八大" / 选项全文
 * @param {string} ans
 * @param {Object} options  { A: "选项文本", ... }
 * @returns {string[]} 选项字母（已去重排序）
 */
function extractLetters(ans, options) {
  const raw = String(ans == null ? "" : ans).trim();
  if (!raw) return [];
  const keys = Object.keys(options || {}).sort();
  if (!keys.length) {
    const only = raw.replace(/[^A-Za-z]/g, "").toUpperCase();
    return only ? only.split("").sort() : [];
  }
  // ① 纯字母
  const pure = raw.replace(/[\s,，、;；/|]+/g, "").toUpperCase();
  if (/^[A-Z]+$/.test(pure) && pure.split("").every((c) => keys.includes(c))) {
    return Array.from(new Set(pure.split(""))).sort();
  }
  // ② 字母 + 选项文本混合：按选项文本反查
  const hits = [];
  for (const k of keys) {
    const body = normalize(options[k]);
    if (!body) continue;
    if (normalize(raw).includes(body)) hits.push(k);
  }
  if (hits.length) return Array.from(new Set(hits)).sort();
  // ③ 退化为取前面出现的字母
  const lead = pure.match(/^[A-Z]+/);
  if (lead && lead[0].split("").every((c) => keys.includes(c))) {
    return Array.from(new Set(lead[0].split(""))).sort();
  }
  return [];
}

/* ------------------------------------------------------------------ 题库 */

function emptyBank() {
  return { v: 2, entries: {} };
}

function loadBank(file) {
  const f = file || BANK_FILE;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    return emptyBank();
  }
  return migrateBank(raw);
}

/** 兼容旧版扁平结构 { "题干": "A" } 与新版 { v:2, entries:{...} } */
function migrateBank(raw) {
  if (!raw || typeof raw !== "object") return emptyBank();
  if (raw.v === 2 && raw.entries) return raw;
  const bank = emptyBank();
  for (const k of Object.keys(raw)) {
    if (k === "v" || k === "entries") continue;
    const v = raw[k];
    if (typeof v !== "string") continue;
    bank.entries[qkey(k)] = {
      q: String(k).slice(0, 80),
      type: null,
      correct: v,
      wrong: [],
      members: [],
      tried: { [v]: 1 },
      updatedAt: Date.now(),
    };
  }
  return bank;
}

function saveBank(bank, file) {
  const f = file || BANK_FILE;
  try {
    fs.writeFileSync(f, JSON.stringify(bank, null, 1), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

/** 取（或创建）某题的题库条目 */
function entryOf(bank, question) {
  const k = qkey(question);
  if (!bank.entries[k]) {
    bank.entries[k] = {
      q: cleanQuestion(question).slice(0, 80),
      type: null,
      correct: null,
      wrong: [],
      members: [],
      tried: {},
      updatedAt: Date.now(),
    };
  }
  return bank.entries[k];
}

/**
 * 把题目选项一起存档。
 * 之前只存题干不存选项，导致后来答题时给模型看的只有题干、没有 A/B/C/D 内容，
 * 模型只能靠常识硬猜——这是正确率长期卡在四成左右的真正原因。
 */
function rememberOptions(bank, question, options) {
  const keys = options && typeof options === "object" ? Object.keys(options) : [];
  if (!keys.length) return;
  const e = entryOf(bank, question);
  const clean = {};
  for (const k of keys) {
    const v = String(options[k] == null ? "" : options[k]).replace(/\s+/g, " ").trim();
    if (v) clean[k] = v.slice(0, 200);
  }
  if (Object.keys(clean).length) e.options = clean;
  return e.options;
}

/** 在题库里找同题（先精确，再相似度） */
function findEntry(bank, question, threshold) {
  const th = threshold == null ? 0.6 : threshold;
  const k = qkey(question);
  if (bank.entries[k]) return bank.entries[k];
  let best = null;
  let bestScore = 0;
  for (const key of Object.keys(bank.entries)) {
    const e = bank.entries[key];
    if (!e || !e.q) continue;
    const s = similarity(question, e.q);
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  return bestScore >= th ? best : null;
}

/**
 * 记录一次作答结果（学习）
 * @param {Object} bank
 * @param {string} question 题干
 * @param {number} type 0单选 1多选 2填空 3判断
 * @param {string} myAnswer 本次提交的答案
 * @param {string} mark marking_dui | marking_bandui | marking_cuo
 * @param {Object} options 选项表 { A: "文本" }
 * @param {number} ratio 得分率 0~1（可选，比 mark 更精确）
 */
function learn(bank, question, type, myAnswer, mark, options, ratio, correctAnswer) {
  const e = entryOf(bank, question);
  e.type = type;
  e.updatedAt = Date.now();
  // 顺手把选项也存下来，下次答题时模型就能看到完整的 A/B/C/D
  if (options && Object.keys(options).length) {
    const clean = {};
    for (const k of Object.keys(options)) {
      const v = String(options[k] == null ? "" : options[k]).replace(/\s+/g, " ").trim();
      if (v) clean[k] = v.slice(0, 200);
    }
    if (Object.keys(clean).length) e.options = clean;
  }
  // 已经批阅出结果了，之前在线答题源留下的猜测就没用了
  if (e.guess) {
    delete e.guess;
    delete e.guessConf;
  }
  const keys = Object.keys(options || {}).sort();
  const r = typeof ratio === "number" ? ratio : mark === "marking_dui" ? 1 : mark === "marking_bandui" ? 0.5 : 0;

  // 【最可靠的一条】批阅页通常直接给出「正确答案」(.correctAnswer .answerCon)。
  // 有它就不必靠"答对了才敢确认"或排除法慢慢推，一次就能把题彻底锁死。
  // 早期版本解析出了这个字段却没往这传，所以题库堆了一堆 correct:null 的题。
  const direct = correctAnswer == null ? "" : String(correctAnswer).replace(/\s+/g, " ").trim();
  if (direct && !/^(正确答案|未作答|null|undefined|-)$/i.test(direct)) {
    if (type === 3) {
      const b = toBool(direct);
      if (b != null) {
        e.correct = b === true ? "A" : "B";
        e.wrong = [b === true ? "B" : "A"];
        e.from = "review";
        return e;
      }
      const L = direct.toUpperCase().match(/[AB]/);
      if (L) {
        e.correct = L[0];
        e.wrong = [L[0] === "A" ? "B" : "A"];
        e.from = "review";
        return e;
      }
    } else if (type === 0) {
      const L = extractLetters(direct, options);
      if (L.length) {
        e.correct = L.join("");
        e.wrong = keys.filter((k) => !L.includes(k));
        e.from = "review";
        return e;
      }
    } else if (type === 1) {
      const L = extractLetters(direct, options);
      if (L.length) {
        e.correct = L.slice().sort().join("");
        e.members = L.slice().sort();
        e.wrong = keys.filter((k) => !L.includes(k));
        e.from = "review";
        return e;
      }
    } else if (type === 2) {
      e.correct = direct;
      e.from = "review";
      return e;
    }
  }

  const letters = extractLetters(myAnswer, options);
  if (myAnswer) e.tried[String(myAnswer)] = r;

  if (type === 3) {
    // 判断题：只有两解，答错即得正确答案（题库里统一用字母 A=对 B=错）
    const b = toBool(myAnswer);
    if (b == null) return e;
    if (r >= 0.999) {
      e.correct = b === true ? "A" : "B";
      e.wrong = [b === true ? "B" : "A"];
    } else {
      // 学到的正确判断：与本次相反
      const rightLetter = keys.find((k) => k !== letters[0]);
      if (rightLetter) e.correct = rightLetter;
      if (letters[0]) e.wrong = [letters[0]];
    }
    return e;
  }

  if (type === 0) {
    // 单选：答对即锁定；答错则本次选项被排除
    if (r >= 0.999) {
      e.correct = letters.join("");
      e.wrong = keys.filter((k) => !letters.includes(k));
    } else if (letters.length === 1) {
      if (!e.wrong.includes(letters[0])) e.wrong.push(letters[0]);
      const remain = keys.filter((k) => !e.wrong.includes(k));
      if (remain.length === 1) e.correct = remain[0];
    }
    return e;
  }

  if (type === 1) {
    // 多选：满分 = 本次集合就是正确集合；半对 = 本次所选的每个选项都属于正确答案
    if (r >= 0.999) {
      e.correct = letters.join("");
      e.members = letters.slice();
    } else if (r > 0) {
      for (const L of letters) if (!e.members.includes(L)) e.members.push(L);
      e.members.sort();
      // 已确认成员数 = 正确选项总数（半对说明"漏选"，且 chaoxing 规则下漏选不加错选）
      if (e.members.length === 1 && letters.length === 1) {
        // 只确认了一个成员，另一个未知：继续留着
        e.correct = null;
      }
    } else {
      // 0 分：至少有一个选错；只选了一个时可直接判定该选项错误
      if (letters.length === 1) {
        if (!e.wrong.includes(letters[0])) e.wrong.push(letters[0]);
        e.members = e.members.filter((m) => m !== letters[0]);
      }
    }
    return e;
  }

  return e;
}

/* ------------------------------------------------------------------ 求解 */

/**
 * 求解一道题
 * @param {Object} bank
 * @param {Object} q { id, type, title, options:{A:"..."} }
 * @returns {{answer:string|null, from:string, confidence:number}}
 */
function solve(bank, q) {
  const type = Number(q.type);
  const options = q.options || {};
  const keys = Object.keys(options).sort();
  // 顺手补存选项：老题库里大量记录只有题干没有选项，模型没选项就只能瞎猜
  try {
    if (keys.length) rememberOptions(bank, q.title, options);
  } catch (e) {}
  const entry = findEntry(bank, q.title);

  if (entry) {
    // ① 已确认正确
    if (entry.correct) {
      const letters = extractLetters(entry.correct, options);
      if (letters.length) {
        return { answer: letters.join(""), from: "bank", confidence: 1 };
      }
    }
    // ② 多选：已确认成员 + 剩下靠未知补（保守：只用已确认成员）
    if (type === 1 && entry.members && entry.members.length) {
      const m = entry.members.filter((k) => keys.includes(k));
      if (m.length) return { answer: m.join(""), from: "bank-members", confidence: 0.6 };
    }
    // ③ 单选/判断：排除法
    if ((type === 0 || type === 3) && entry.wrong && entry.wrong.length) {
      const remain = keys.filter((k) => !entry.wrong.includes(k));
      if (remain.length === 1) return { answer: remain[0], from: "bank-eliminate", confidence: 0.9 };
    }
  }

  // ④ 在线答题源（题库接口/大模型）留下的待验证答案：置信度低于已批阅过的题库
  if (entry && entry.guess) {
    const letters = extractLetters(entry.guess, options);
    const ans = letters.length ? letters.join("") : String(entry.guess);
    if (ans) {
      return { answer: ans, from: "provider", confidence: Number(entry.guessConf) || 0.8 };
    }
  }

  // ⑤ 判断题常识规则（教育类课程高频）
  if (type === 3 && keys.length === 2) {
    const q2 = cleanQuestion(q.title);
    const neg = /不属于|不正确|错误|不可以|不需要|不能|不得|不必|无须|没有/.test(q2);
    const pos = /必须|应当|需要|可以|属于|是|要|应|坚持|加强|提高|促进|有利于/.test(q2);
    const b = neg && !pos ? false : pos ? true : true;
    return { answer: judgeAnswerToLetter(b, options), from: "heuristic", confidence: 0.45 };
  }

  return { answer: null, from: "unknown", confidence: 0 };
}

module.exports = {
  cleanQuestion,
  normalize,
  qkey,
  similarity,
  toBool,
  judgeAnswerToLetter,
  extractLetters,
  emptyBank,
  loadBank,
  migrateBank,
  saveBank,
  entryOf,
  rememberOptions,
  findEntry,
  learn,
  solve,
  BANK_FILE,
};