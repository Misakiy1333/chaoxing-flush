/**
 * 云端账号白名单管理
 *   node tools/whitelist.js list
 *   node tools/whitelist.js on                 # 开启限制（只允许名单内的账号）
 *   node tools/whitelist.js off                # 关闭限制（谁都能登）
 *   node tools/whitelist.js add 13900000000 13800000000
 *   node tools/whitelist.js remove 13900000000
 *   node tools/whitelist.js set 13900000000 13800000000   # 直接覆盖整份名单
 */
const http = require("http");

const HOST = process.env.DEPLOY_HOST || "";
const PORT = 8080;
const PWD = process.env.ADMIN_PWD || "";

function call(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const headers = {};
    if (data) { headers["Content-Type"] = "application/json; charset=utf-8"; headers["Content-Length"] = data.length; }
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers, timeout: 20000 }, (x) => {
      let b = "";
      x.on("data", (c) => (b += c));
      x.on("end", () => {
        try { res(JSON.parse(b)); } catch (e) { res({ ok: false, error: b.slice(0, 120) }); }
      });
    });
    r.on("error", rej);
    r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); });
    if (data) r.write(data);
    r.end();
  });
}

function show(w) {
  console.log("  白名单: " + (w.enabled ? "已开启（只允许名单内账号）" : "未开启（任何账号都能登录）"));
  console.log("  名单  : " + (w.unames.length ? w.unames.join(", ") : "（空）"));
  if (w.enabled && !w.unames.length) console.log("  ⚠ 已开启但名单为空 → 谁都不能登录");
}

(async () => {
  const cmd = (process.argv[2] || "list").toLowerCase();
  const args = process.argv.slice(3).filter(Boolean);
  const base = "/api/admin/whitelist?pwd=" + encodeURIComponent(PWD);

  try {
    if (cmd === "list") {
      const j = await call("GET", base);
      if (!j.ok) return console.error("读取失败: " + j.error);
      show(j.whitelist);
      return;
    }
    if (cmd === "on" || cmd === "off") {
      const j = await call("POST", base, { enabled: cmd === "on" });
      if (!j.ok) return console.error("操作失败: " + j.error);
      console.log("✔ 已" + (cmd === "on" ? "开启" : "关闭") + "白名单限制");
      show(j.whitelist);
      return;
    }
    if (cmd === "add" || cmd === "remove" || cmd === "set") {
      if (!args.length) return console.error("请至少给一个账号");
      const body = cmd === "set" ? { enabled: true, unames: args } : { [cmd]: args };
      const j = await call("POST", base, body);
      if (!j.ok) return console.error("操作失败: " + j.error);
      console.log("✔ 已" + ({ add: "添加", remove: "移除", set: "覆盖为" })[cmd] + " " + args.join(", "));
      show(j.whitelist);
      return;
    }
    console.log("用法: list | on | off | add <账号...> | remove <账号...> | set <账号...>");
  } catch (e) {
    console.error("请求失败: " + e.message);
    process.exit(1);
  }
})();
