/**
 * 自动等待风控解冻后登录
 *
 * 学习通的风控冻结是 15 分钟，且每次失败尝试都会重置计时。
 * 本脚本每隔 3 分钟探测一次（间隔足够长，不会重置计时），
 * 检测到「仍冻结」就继续等，解冻后立刻登录并写入 config.json。
 *
 * 用法: node tools/unfreeze-login.js
 */
const path = require("path");
const Loginer = require("../loginer.js");
const Config = require("../config.js");

const sleep = (t) => new Promise((y) => setTimeout(y, t));
const PROBE_INTERVAL = 3 * 60 * 1000; // 3 分钟
const MAX_WAIT = 90 * 60 * 1000; // 最多等 90 分钟

(async () => {
  const cfg0 = await new Config(path.resolve(__dirname, "..", "config.json")).read();
  const uname = cfg0.uname;
  const password = cfg0.password;

  if (!uname || !password) {
    console.error("config.json 缺少 uname / password");
    process.exit(1);
  }

  console.log("=== 自动解冻登录 ===");
  console.log("账号: " + uname);
  console.log("策略: 每 " + PROBE_INTERVAL / 60000 + " 分钟探测一次，最多等 " + MAX_WAIT / 60000 + " 分钟");
  console.log("（探测间隔足够长，不会重置风控计时）\n");

  const t0 = Date.now();
  let round = 0;

  while (Date.now() - t0 < MAX_WAIT) {
    round++;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const stamp = new Date().toLocaleTimeString("zh-CN");

    const cfg = new Config(path.resolve(__dirname, "..", "config.json"));
    await cfg.read();
    cfg.uname = uname;
    cfg.password = password;
    cfg.saveCookie = "";
    cfg.maxRetry = 1;

    const lo = new Loginer(cfg);
    try {
      const ck = await lo.login();
      console.log("\n========================================");
      console.log("  解冻成功，已登录!");
      console.log("  时间: " + stamp + "  等待: " + elapsed + "s  轮次: " + round);
      console.log("========================================");
      console.log("cookie: " + ck);
      console.log("uid:    " + lo.extractUid(ck));

      // 写入 config.json
      const w = new Config(path.resolve(__dirname, "..", "config.json"));
      await w.read();
      w.uname = uname;
      w.password = password;
      w.saveCookie = ck;
      await w.write();
      console.log("\n已写入 config.json（下次运行可跳过登录）");
      console.log("\n下一步: npm start -- --yes");
      process.exit(0);
    } catch (e) {
      const m = String(e && e.message ? e.message : e);
      const frozen = m.indexOf("冻结") !== -1 || m.indexOf("多次") !== -1;
      if (frozen) {
        console.log("[" + stamp + " " + String(elapsed).padStart(4) + "s] 仍冻结，下次探测在 3 分钟后");
      } else {
        console.log("[" + stamp + " " + String(elapsed).padStart(4) + "s] 其他错误: " + m);
      }
    }

    await sleep(PROBE_INTERVAL);
  }

  console.log("\n超时未解冻。请手动确认账号密码是否正确。");
  process.exit(1);
})();
