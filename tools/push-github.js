/**
 * 把本地仓库推送到 GitHub（自动建仓库）
 *
 *   set GITHUB_USER=你的用户名
 *   set GITHUB_TOKEN=ghp_xxx        （fine-grained 或 classic，需要 repo 权限）
 *   set REPO=chaoxing-flush          （可选，默认 chaoxing-flush）
 *   set PRIVATE=0                    （可选，0=公开 1=私有）
 *   node tools/push-github.js
 *
 * 推完会把 remote 里的 token 去掉，避免留在 .git/config 里。
 */
const https = require("https");
const { execFileSync } = require("child_process");

const USER = process.env.GITHUB_USER || "";
const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.REPO || "chaoxing-flush";
const PRIVATE = String(process.env.PRIVATE || "0") === "1";
const DESC = process.env.DESC || "学习通刷课助手：云端多人版 + 本地单机版，Node.js 全栈实现（仅供学习交流）";

if (!USER || !TOKEN) {
  console.error("缺少 GITHUB_USER / GITHUB_TOKEN");
  process.exit(1);
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = https.request(
      {
        host: "api.github.com",
        path,
        method,
        timeout: 30000,
        headers: Object.assign(
          {
            "User-Agent": USER + "-push-script",
            Accept: "application/vnd.github+json",
            Authorization: "Bearer " + TOKEN,
          },
          data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}
        ),
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          let j = null;
          try { j = JSON.parse(b); } catch (e) {}
          resolve({ code: res.statusCode, body: j, raw: b });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

function git(args) {
  return execFileSync("git", args, { stdio: "inherit", cwd: __dirname + "/.." });
}

(async () => {
  console.log("① 检查 token …");
  const me = await api("GET", "/user");
  if (me.code !== 200) {
    console.error("   token 无效（HTTP " + me.code + "）: " + (me.body && me.body.message));
    process.exit(1);
  }
  console.log("   已登录: " + me.body.login);

  console.log("\n② 创建仓库 " + USER + "/" + REPO + (PRIVATE ? "（私有）" : "（公开）") + " …");
  let created = await api("POST", "/user/repos", {
    name: REPO,
    description: DESC,
    private: PRIVATE,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  });
  if (created.code === 201) {
    console.log("   创建成功");
  } else if (created.code === 422) {
    console.log("   仓库已存在，直接推");
  } else {
    console.error("   创建失败（HTTP " + created.code + "）: " + (created.body && created.body.message));
    process.exit(1);
  }

  const authedUrl = "https://" + USER + ":" + TOKEN + "@github.com/" + USER + "/" + REPO + ".git";
  const cleanUrl = "https://github.com/" + USER + "/" + REPO + ".git";

  console.log("\n③ 推送 …");
  try { git(["remote", "remove", "origin"]); } catch (e) {}
  git(["remote", "add", "origin", authedUrl]);
  try { git(["branch", "-M", "main"]); } catch (e) {}
  git(["push", "-u", "origin", "main"]);

  console.log("\n④ 清理 remote 里的 token …");
  git(["remote", "set-url", "origin", cleanUrl]);

  console.log("\n✔ 完成: " + cleanUrl);
  console.log("   （token 已从 .git/config 移除）");
})().catch((e) => {
  console.error("失败: " + e.message);
  process.exit(1);
});
