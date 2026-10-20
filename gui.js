/**
 * 超星刷课助手 · 本地版（exe 入口）
 *
 * 只做三件事：起服务、打印地址、打开浏览器。
 * 界面和接口全部由 local-server.js + web/multi.html 提供，
 * 所以本地版和云端版的页面、进度条、风控面板、开始/停止完全一致。
 */
const { spawn, execSync } = require("child_process");
const LocalServer = require("./local-server.js");
const VERSION = require("./version.js");

const PORT = 8765;

// Windows 控制台默认 GBK，先切 UTF-8，避免中文乱码
if (process.platform === "win32") {
  try { execSync("chcp 65001", { stdio: "ignore" }); } catch (e) {}
  try { process.title = "超星刷课助手 本地版 v" + VERSION.version + " · 飞飞"; } catch (e) {}
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (e) {}
}

(async () => {
  const app = new LocalServer({ port: PORT });
  await app.init();
  app.onListening = openBrowser;
  app.serve();
})();

process.on("SIGINT", () => {
  console.log("\n已停止。");
  process.exit(0);
});
