/**
 * 查看 / 清除 PE 文件的 Authenticode 签名表
 *
 *   node tools/strip-sign.js info  <exe>     # 只看
 *   node tools/strip-sign.js strip <exe>     # 清除
 *
 * 原因：postject 把 SEA blob 注入 node.exe 后，Node 自带的数字签名就失效了，
 * Windows 的 Application Control / SmartScreen 会以「签名损坏」为由直接拦截。
 * 把 PE 的 Certificate Table 目录项清零 = 变成普通的「未签名文件」，就不再被拦。
 */
const fs = require("fs");

const mode = process.argv[2];
const file = process.argv[3];

if (!mode || !file) {
  console.error("用法: node tools/strip-sign.js info|strip <exe>");
  process.exit(1);
}

const buf = fs.readFileSync(file);

// DOS 头 → e_lfanew
const peOff = buf.readUInt32LE(0x3c);
if (buf.toString("ascii", peOff, peOff + 4) !== "PE\0\0") {
  console.error("不是有效的 PE 文件");
  process.exit(1);
}

const coffOff = peOff + 4;
const optOff = coffOff + 20;
const magic = buf.readUInt16LE(optOff);
const is64 = magic === 0x20b;
const dataDirOff = optOff + (is64 ? 112 : 96);
const secEntryOff = dataDirOff + 4 * 8; // 目录索引 4 = Certificate Table

const certRva = buf.readUInt32LE(secEntryOff);
const certSize = buf.readUInt32LE(secEntryOff + 4);

console.log("文件: " + file);
console.log("  格式: " + (is64 ? "PE32+" : "PE32"));
console.log("  签名表 RVA/大小: 0x" + certRva.toString(16) + " / " + certSize + " 字节");
console.log("  状态: " + (certSize === 0 ? "未签名（正常）" : "带签名（可能已损坏）"));

if (mode === "strip") {
  if (certSize === 0) {
    console.log("  无需处理");
  } else {
    buf.writeUInt32LE(0, secEntryOff);
    buf.writeUInt32LE(0, secEntryOff + 4);
    fs.writeFileSync(file, buf);
    console.log("  ✔ 已清除签名表，文件现在是「未签名」状态");
  }
}
