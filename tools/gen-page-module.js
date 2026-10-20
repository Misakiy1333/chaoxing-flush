/**
 * 把 web/multi.html 转成一个 JS 模块（web-page.js），
 * 这样 exe（单文件二进制）也能内嵌同一份前端页面。
 *
 *   node tools/gen-page-module.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "web", "multi.html");
const OUT = path.join(ROOT, "web-page.js");

function build() {
  if (!fs.existsSync(SRC)) throw new Error("找不到 " + SRC);
  const html = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");
  const out =
    "// 自动生成，请勿手改。源码：web/multi.html（改完跑 node tools/gen-page-module.js）\n" +
    "module.exports = " + JSON.stringify(html) + ";\n";
  fs.writeFileSync(OUT, out, "utf8");
  return { bytes: Buffer.byteLength(html, "utf8"), file: OUT };
}

if (require.main === module) {
  const r = build();
  console.log("已生成 " + r.file + "（" + r.bytes + " 字节）");
}

module.exports = { build };
