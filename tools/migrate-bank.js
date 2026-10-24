/**
 * 题库迁移 v2
 *
 * 做三件事：
 *   1) 数据规整：options 被存成字符串的解析回对象；correct 被存成 JSON 数组字符串的解析回字母
 *   2) 补字段：correctText（选项文本，防乱序）、correctBool（判断题）、memberText（多选成员）
 *   3) 清理：删掉没有任何信息的纯废条目
 *
 * 自包含，不 require answerer.js，旧版服务器上也能直接跑。
 *
 * 用法: node migrate-bank.js <bank.json> [--dry]
 */
const fs = require("fs");

/* ---------- options 规整 ---------- */

/** 把各种畸形的 options 规整成 { A: "文本", ... }，失败返回 null */
function fixOptions(o) {
  if (o == null) return null;

  // ① 字符串：可能是 JSON、也可能是别的形式
  if (typeof o === "string") {
    const s = o.trim();
    if (!s) return null;
    try {
      const p = JSON.parse(s);
      return normalKeys(p);
    } catch (e) {
      return null;
    }
  }

  // ② 数组：[{ text }] 或 ["甲","乙"]
  if (Array.isArray(o)) {
    const out = {};
    "ABCDEFGHIJ".split("").forEach((L, i) => {
      const v = o[i];
      if (v == null) return;
      const t = typeof v === "object" ? (v.text || v.content || v.option || v.value || "") : v;
      if (t !== "") out[L] = String(t).slice(0, 200);
    });
    return Object.keys(out).length ? out : null;
  }

  // ③ 对象
  if (typeof o === "object") return normalKeys(o);

  return null;
}

/** 键名规整：数字键 0..n → A..; 字母键统一大写 */
function normalKeys(p) {
  if (!p || typeof p !== "object") return null;
  const ks = Object.keys(p);
  if (!ks.length) return null;
  const out = {};
  const allNum = ks.every((k) => /^\d+$/.test(k));
  if (allNum) {
    ks.sort((a, b) => Number(a) - Number(b)).forEach((k, i) => {
      const L = "ABCDEFGHIJ"[i];
      if (!L) return;
      const t = String(p[k] == null ? "" : p[k]).trim();
      if (t) out[L] = t.slice(0, 200);
    });
  } else {
    for (const k of ks) {
      const L = String(k).trim().toUpperCase();
      if (!/^[A-Z]$/.test(L)) continue;
      const t = String(p[k] == null ? "" : p[k]).trim();
      if (t) out[L] = t.slice(0, 200);
    }
  }
  return Object.keys(out).length ? out : null;
}

/* ---------- correct 规整 ---------- */

/** 把 "[\"A\", \"B\"]" / "['A','B']" / "\"A\"" / "AB" 统一成 "AB" */
function fixCorrect(c) {
  if (c == null) return null;
  if (Array.isArray(c)) {
    const s = c.map((x) => String(x).trim().toUpperCase()).join("");
    return /^[A-Z]*$/.test(s) && s ? s : null;
  }
  let s = String(c).trim();
  if (!s) return null;
  // JSON 数组字符串
  if (s.startsWith("[")) {
    try {
      const p = JSON.parse(s);
      if (Array.isArray(p)) {
        const j = p.map((x) => String(x).trim().toUpperCase()).join("");
        if (/^[A-Z]+$/.test(j)) return j;
      }
    } catch (e) {
      // ['A','B'] 这种单引号形式
      const m = s.match(/[A-Za-z]/g);
      if (m) {
        const j = m.join("").toUpperCase();
        if (/^[A-Z]+$/.test(j)) return j;
      }
    }
  }
  // 带引号
  s = s.replace(/^["']|["']$/g, "").trim();
  if (/^[A-Za-z]+$/.test(s)) return s.toUpperCase();
  return null;
}

const file = process.argv[2];
const dry = process.argv.includes("--dry");
if (!file) { console.error("用法: node migrate-bank.js <bank.json> [--dry]"); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const entries = raw.entries || raw;
const keys = Object.keys(entries);

const st = {
  optFixed: 0, optDroppedEmpty: 0, correctFixed: 0, correctTrimmed: 0,
  texted: 0, textSkipped: 0, booled: 0, memberTexted: 0, dropped: 0, orderRisk: 0, keep: 0,
};
const drops = [];

for (const k of keys) {
  const e = entries[k];
  if (!e || typeof e !== "object") { delete entries[k]; st.dropped++; continue; }

  /* 1) 规整 options */
  if (e.options != null) {
    const fixed = fixOptions(e.options);
    if (fixed) {
      e.options = fixed;
      st.optFixed++;
    } else {
      delete e.options;
      st.optDroppedEmpty++;
    }
  }

  /* 2) 规整 correct */
  if (e.correct != null) {
    const fc = fixCorrect(e.correct);
    if (fc) {
      if (fc !== e.correct) st.correctFixed++;
      e.correct = fc;
    } else {
      delete e.correct;
    }
  }

  const hasOpt = !!(e.options && Object.keys(e.options).length);
  const hasAns = !!(e.correct || e.correctBool != null || (e.members && e.members.length) || e.guess);
  const hasWrong = !!(e.wrong && e.wrong.length);
  const hasTried = !!(e.tried && Object.keys(e.tried).length);

  /* 3) 纯废条目 */
  if (!hasOpt && !hasAns && !hasWrong && !hasTried) {
    drops.push((e.q || "").slice(0, 40) || "(空题干)");
    delete entries[k];
    st.dropped++;
    continue;
  }

  /* 4) 判断题 → correctBool */
  if (Number(e.type) === 3 && typeof e.correct === "string" && /^[AB]$/.test(e.correct) && e.correctBool == null) {
    e.correctBool = e.correct === "A";
    st.booled++;
  }

  /* 5) 单选/多选 → correctText */
  if ((Number(e.type) === 0 || Number(e.type) === 1) && e.correct && hasOpt) {
    // 先剔掉超出选项范围的字母：爬来的题里有一批"答案 ABCDE 但只有 4 个选项"，
    // 留着会让 correctText 比 correct 少一位，求解时答得少一个选项。
    const oKeys = Object.keys(e.options);
    const inRange = e.correct.split("").filter((L) => oKeys.includes(L));
    if (inRange.length && inRange.length !== e.correct.length) {
      e.correct = inRange.join("");
      st.correctTrimmed++;
    }
    if (!(e.correctText && e.correctText.length)) {
      const txt = e.correct.split("").map((L) => e.options[L]).filter(Boolean).map((t) => String(t).slice(0, 200));
      if (txt.length === e.correct.length) { e.correctText = txt; st.texted++; }
      else st.textSkipped++;
    }
  }

  /* 6) 多选成员 → memberText */
  if (Number(e.type) === 1 && e.members && e.members.length && hasOpt && !(e.memberText && e.memberText.length)) {
    const txt = e.members.map((L) => e.options[L]).filter(Boolean).map((t) => String(t).slice(0, 200));
    if (txt.length) { e.memberText = txt; st.memberTexted++; }
  }

  /* 7) 有答案没选项 → 标记顺序风险 */
  if (e.correct && !hasOpt && Number(e.type) !== 2) {
    e.orderRisk = true;
    st.orderRisk++;
  }

  st.keep++;
}

console.log("原条目: " + keys.length);
console.log("保留:   " + st.keep);
console.log("删除:   " + st.dropped);
console.log("");
console.log("options 修复:      " + st.optFixed);
console.log("options 清空(无效): " + st.optDroppedEmpty);
console.log("correct 修复:      " + st.correctFixed);
console.log("correct 剔除越界:  " + st.correctTrimmed);
console.log("");
console.log("补 correctText:    " + st.texted);
console.log("跳过(选项不全):    " + st.textSkipped);
console.log("补 correctBool:    " + st.booled);
console.log("补 memberText:     " + st.memberTexted);
console.log("标记顺序风险:      " + st.orderRisk);

if (drops.length) {
  console.log("");
  console.log("被删样例（前 5 条）:");
  drops.slice(0, 5).forEach((d) => console.log("  · " + d));
}

if (dry) {
  console.log("");
  console.log("[dry-run] 未写入");
} else {
  fs.writeFileSync(file + ".tmp", JSON.stringify(raw, null, 1));
  fs.renameSync(file + ".tmp", file);
  console.log("");
  console.log("已写入 " + file);
}
