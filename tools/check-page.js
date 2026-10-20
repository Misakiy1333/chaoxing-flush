/**
 * 校验 multi.html：内联脚本能解析、所有 getElementById 引用的元素都存在
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "web", "multi.html");
const html = fs.readFileSync(file, "utf8");

// 1) 提取所有 <script> 内联块
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
console.log("内联脚本块数:", scripts.length);
let ok = true;
scripts.forEach((s, i) => {
  try {
    new Function(s);
    console.log(`  块${i + 1} 语法 OK (${s.length} 字符)`);
  } catch (e) {
    ok = false;
    console.log(`  块${i + 1} 语法错误: ${e.message}`);
  }
});

// 2) id 引用检查
const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...html.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));
const missing = [...used].filter((x) => !defined.has(x));
console.log("\n已定义 id:", defined.size, "被引用 id:", used.size);
console.log(missing.length ? "缺失引用: " + missing.join(", ") : "引用全部存在 OK");
if (missing.length) ok = false;

// 3) 关键 id 必须存在
const must = ["uname", "password", "fid", "proxy", "loginBtn", "startBtn", "stopBtn", "log", "pct", "courseList"];
const lack = must.filter((m) => !defined.has(m));
console.log(lack.length ? "缺少关键 id: " + lack.join(", ") : "关键 id 齐全 OK");
if (lack.length) ok = false;

// 4) 不该有 CRLF 导致的模板字符串断裂 / 中文乱码
if (html.includes("\uFFFD")) { console.log("发现乱码字符 U+FFFD"); ok = false; }
console.log("\n结果:", ok ? "通过" : "有问题");
process.exit(ok ? 0 : 1);
