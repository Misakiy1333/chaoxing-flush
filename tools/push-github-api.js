/**
 * 通过 GitHub Git Data API 提交整个仓库（不依赖 github.com 的 git 协议）
 *
 * 适用：github.com 被网络阻断、只有 api.github.com 可访问。
 *
 *   set GITHUB_TOKEN=xxx
 *   node tools/push-github-api.js owner/repo
 *
 * 空仓库会先用 Contents API 建一个基线提交（Git Data API 不支持空仓库），
 * 之后逐文件建 blob → 建 tree → 建 commit → 更新 refs。
 */
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TOKEN = process.env.GITHUB_TOKEN || "";
const SLUG = process.argv[2] || process.env.REPO_SLUG || "";
const MESSAGE =
  process.env.COMMIT_MSG ||
  "feat: 超星刷课助手 初始开源版本\n\n" +
    "- 云端多人版：多用户、持久登录态、SSE 实时推送、管理后台、账号白名单\n" +
    "- 本地单机版：单文件 exe，界面与云端完全一致\n" +
    "- 协议实现：登录 / 课程 / 章节 / 视频心跳 / 弹题作答\n" +
    "- 拟人化节奏：随机间隔、小憩长休、限速与额度退回、可中断\n" +
    "- 跳过逻辑：整门课 / 整章 / 单视频已完成均跳过\n" +
    "- 部署：deploy.sh 一键部署、nginx、pm2、Docker\n" +
    "- 测试：9 个套件 278 项断言";

if (!TOKEN || !SLUG) {
  console.error("用法: set GITHUB_TOKEN=xxx && node tools/push-github-api.js owner/repo");
  process.exit(1);
}

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = https.request(
      {
        host: "api.github.com",
        path: p,
        method,
        timeout: 60000,
        headers: Object.assign(
          {
            "User-Agent": "chaoxing-api-pusher",
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

(async () => {
  console.log("① 仓库信息");
  const repo = await api("GET", "/repos/" + SLUG);
  if (repo.code !== 200) {
    console.error("   无法访问仓库（HTTP " + repo.code + "）：" + (repo.body && repo.body.message));
    process.exit(1);
  }
  let branch = repo.body.default_branch || "main";
  console.log("   " + repo.body.full_name + "　分支 " + branch + "　默认分支已存在：" + !!repo.body.size);

  console.log("\n② 检查是否是空仓库");
  const ref = await api("GET", "/repos/" + SLUG + "/git/ref/heads/" + branch);
  let parentSha = null;
  let skipFiles = [];

  if (ref.code === 200) {
    parentSha = ref.body.object.sha;
    console.log("   已有提交：" + parentSha.slice(0, 10) + "…（将在其之上提交）");
  } else {
    console.log("   空仓库 → 先用 Contents API 建基线提交");
    const gi = fs.readFileSync(path.join(ROOT, ".gitignore"));
    const boot = await api("PUT", "/repos/" + SLUG + "/contents/.gitignore", {
      message: "chore: 初始化仓库",
      content: gi.toString("base64"),
      branch,
    });
    if (boot.code !== 201 && boot.code !== 200) {
      console.error("   基线提交失败（HTTP " + boot.code + "）：" + (boot.body && boot.body.message));
      process.exit(1);
    }
    parentSha = boot.body.commit.sha;
    skipFiles.push(".gitignore"); // 已经在基线里了
    console.log("   基线提交：" + parentSha.slice(0, 10) + "…");
  }

  console.log("\n③ 读取待提交文件");
  const raw = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  const all = raw.split("\0").filter(Boolean);
  const files = all.filter((f) => skipFiles.indexOf(f) === -1);
  console.log("   共 " + files.length + " 个（跳过基线已有的 " + skipFiles.length + " 个）");

  console.log("\n④ 建立 blob");
  const tree = [];
  let done = 0;
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const mode = /\.sh$/i.test(rel) ? "100755" : "100644";
    const r = await api("POST", "/repos/" + SLUG + "/git/blobs", {
      content: buf.toString("base64"),
      encoding: "base64",
    });
    if (r.code !== 201) {
      console.error("\n   ✖ " + rel + " → HTTP " + r.code + " " + (r.body && r.body.message));
      process.exit(1);
    }
    tree.push({ path: rel, mode, type: "blob", sha: r.body.sha });
    done++;
    if (done % 10 === 0 || done === files.length) {
      process.stdout.write("   已上传 " + done + "/" + files.length + "\r");
    }
  }
  console.log("");

  console.log("\n⑤ 建立 tree（基于父提交的 tree）");
  const parentCommit = await api("GET", "/repos/" + SLUG + "/git/commits/" + parentSha);
  const baseTree = parentCommit.body && parentCommit.body.tree ? parentCommit.body.tree.sha : undefined;
  const tr = await api("POST", "/repos/" + SLUG + "/git/trees", baseTree ? { base_tree: baseTree, tree } : { tree });
  if (tr.code !== 201) {
    console.error("   失败 " + tr.code + ": " + (tr.body && tr.body.message));
    process.exit(1);
  }
  console.log("   tree " + tr.body.sha.slice(0, 10) + "…");

  console.log("\n⑥ 建立 commit");
  const cm = await api("POST", "/repos/" + SLUG + "/git/commits", {
    message: MESSAGE,
    tree: tr.body.sha,
    parents: [parentSha],
  });
  if (cm.code !== 201) {
    console.error("   失败 " + cm.code + ": " + (cm.body && cm.body.message));
    process.exit(1);
  }
  console.log("   commit " + cm.body.sha.slice(0, 10) + "…");

  console.log("\n⑦ 更新分支 refs/heads/" + branch);
  const up = await api("PATCH", "/repos/" + SLUG + "/git/refs/heads/" + branch, {
    sha: cm.body.sha,
    force: true,
  });
  if (up.code !== 200) {
    console.error("   失败 " + up.code + ": " + (up.body && up.body.message));
    process.exit(1);
  }
  console.log("   已更新");

  console.log("\n⑧ 设为默认分支");
  const pat = await api("PATCH", "/repos/" + SLUG, { default_branch: branch });
  console.log("   " + (pat.code === 200 ? "已设置 " + branch : "跳过（" + pat.code + "）"));

  console.log("\n✔ 完成：https://github.com/" + SLUG);
  console.log("   提交 " + cm.body.sha.slice(0, 12) + "　文件 " + (files.length + skipFiles.length) + " 个");
})().catch((e) => {
  console.error("失败：" + e.message);
  process.exit(1);
});
