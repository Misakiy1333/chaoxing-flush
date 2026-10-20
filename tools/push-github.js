/**
 * 把本地仓库推送到 GitHub（自动建仓库）
 *
 *   set GITHUB_TOKEN=xxx          （必须，需 repo 权限）
 *   set GITHUB_USER=你的用户名     （可选，不填会自动查）
 *   set REPO=chaoxing-flush       （可选）
 *   set PRIVATE=0                 （可选，0=公开 1=私有）
 *   node tools/push-github.js
 *
 * 鉴权走 http.extraheader，令牌不会写进 .git/config，也不会出现在 URL 里。
 */
const https = require("https");
const { execFileSync } = require("child_process");

let USER = process.env.GITHUB_USER || "";
const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.REPO || "chaoxing-flush";
const PRIVATE = String(process.env.PRIVATE || "0") === "1";
const DESC =
  process.env.DESC ||
  "学习通刷课助手：云端多人版 + 本地单机版，Node.js 全栈实现（仅供学习交流）";

if (!TOKEN) {
  console.error("缺少 GITHUB_TOKEN");
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
            "User-Agent": "chaoxing-push-script",
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

function git(args, extraEnv) {
  return execFileSync("git", args, {
    stdio: "inherit",
    cwd: __dirname + "/..",
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0" }, extraEnv || {}),
  });
}

(async () => {
  console.log("① 校验令牌 …");
  const me = await api("GET", "/user");
  if (me.code !== 200) {
    console.error("   令牌无效（HTTP " + me.code + "）：" + (me.body && me.body.message));
    process.exit(1);
  }
  if (!USER) USER = me.body.login;
  console.log("   账号：" + me.body.login + (USER !== me.body.login ? "（将推到 " + USER + " 名下）" : ""));

  console.log("\n② 检查仓库 " + USER + "/" + REPO + " …");
  const exists = await api("GET", "/repos/" + USER + "/" + REPO);
  if (exists.code === 200) {
    console.log("   仓库已存在，直接推送");
  } else if (exists.code === 404) {
    console.log("   仓库不存在，尝试创建（" + (PRIVATE ? "私有" : "公开") + "）");
    const created = await api("POST", "/user/repos", {
      name: REPO,
      description: DESC,
      private: PRIVATE,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    });
    if (created.code === 201) console.log("   创建成功");
    else if (created.code === 422) console.log("   仓库已存在，直接推送");
    else {
      console.error("   创建失败（HTTP " + created.code + "）：" + (created.body && created.body.message));
      console.error("   → 细粒度令牌没有建仓库权限时，请先在网页手动建一个空仓库：https://github.com/new");
      process.exit(1);
    }
  } else {
    console.error("   查询仓库失败（HTTP " + exists.code + "）：" + (exists.body && exists.body.message));
    process.exit(1);
  }

  console.log("\n③ 推送 …");
  const cleanUrl = "https://github.com/" + USER + "/" + REPO + ".git";
  try { git(["remote", "remove", "origin"]); } catch (e) {}
  git(["remote", "add", "origin", cleanUrl]);
  try { git(["branch", "-M", "main"]); } catch (e) {}

  // 令牌只在这个进程的请求头里，不落盘
  const basic = Buffer.from(USER + ":" + TOKEN, "utf8").toString("base64");
  const pushArgs = ["-c", "http.extraheader=Authorization: Basic " + basic];
  // 国内直连 GitHub 常被重置，走本地代理（GIT_PROXY=http://127.0.0.1:7892）
  if (process.env.GIT_PROXY) {
    pushArgs.push("-c", "http.proxy=" + process.env.GIT_PROXY);
    console.log("   走代理：" + process.env.GIT_PROXY);
  }
  pushArgs.push("push", "-u", "origin", "main");

  let ok = false;
  for (let i = 1; i <= 3 && !ok; i++) {
    try {
      git(pushArgs);
      ok = true;
    } catch (e) {
      console.log("   第 " + i + " 次推送失败，3 秒后重试…");
      if (i === 3) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  console.log("\n✔ 完成：" + cleanUrl);
  console.log("   令牌没有写入 .git/config（可用 git remote -v 确认）");
})().catch((e) => {
  console.error("失败：" + e.message);
  process.exit(1);
});
