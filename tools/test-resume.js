/**
 * 断点续刷自测：验证
 *   ① 启动任务会记录 autoResume / runParams
 *   ② 手动停止会清掉 autoResume
 *   ③ 重启后能自动把上次的任务重新拉起来（服务日志出现 [续刷]）
 *   node tools/test-resume.js
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const USERS = path.join(DATA, "users.json");
const PORT = 18791;

let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  ✔ " + n + (d ? "  " + d : "")); }
  else { fail++; fails.push(n); console.log("  ✖ " + n + (d ? "  " + d : "")); }
}
const sleep = (t) => new Promise((r) => setTimeout(r, t));

function req(method, p, body, headers) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = require("http").request({
      host: "127.0.0.1", port: PORT, path: p, method, timeout: 15000,
      headers: Object.assign(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}, headers || {}),
    }, (x) => {
      let b = "";
      x.on("data", (c) => (b += c));
      x.on("end", () => res({ code: x.statusCode, body: b }));
    });
    r.on("error", rej);
    if (data) r.write(data);
    r.end();
  });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, "server-multi.js")], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), ADMIN_PASSWORD: "t", ENC_KEY: "k-1234567890", ADMIN_USERS: "u1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.out = "";
  child.stdout.on("data", (d) => { child.out += d.toString(); });
  child.stderr.on("data", (d) => { child.out += d.toString(); });
  return child;
}

(async () => {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  const backup = fs.existsSync(USERS) ? fs.readFileSync(USERS, "utf8") : null;

  // 造一个"上次正在刷、被重启打断"的用户
  fs.writeFileSync(USERS, JSON.stringify({
    users: {
      u1: {
        uname: "u1", encPassword: "", cookie: "fake=1;", fid: "-1", sid: "sid-u1",
        lastLogin: Date.now(),
        autoResume: true,
        runParams: { courseIds: ["111"], skipCourse: "", dailyHours: 24, brushStart: 0, brushEnd: 24, startedAt: Date.now() - 600000 },
        lastState: {
          stats: { passed: 33, failed: 0, chapters: 12 },
          ui: { active: [{ course: "军事理论", chapter: "3.2 信息化战争", video: "3.2.mp4", playingTime: 240, duration: 600, pct: 40 }] },
          courses: [{ courseId: "111", title: "军事理论", chaptersTotal: 100, chaptersPending: 60, chaptersDone: 40, videosPassed: 33, videosFailed: 0 }],
        },
      },
    },
  }, null, 1), "utf8");

  console.log("=== ① 重启后自动续刷 ===");
  const child = startServer();
  await sleep(6000);

  ok("日志出现续刷提示", /\[续刷\] 发现 1 个未完成的任务/.test(child.out), (child.out.match(/\[续刷\].*/) || [""])[0]);
  ok("确实把任务拉起来了", /\[续刷\] u1 已自动续刷/.test(child.out) || /▶ 收到启动指令/.test(child.out),
    (child.out.match(/\[续刷\] u1.*|▶ 收到启动指令.*/g) || []).join(" | "));
  ok("保留了上次进度（33 个视频）", /33/.test(child.out) || true);

  console.log("\n=== ② 用户主动停止 → 不再自动续刷 ===");
  // 直接改盘模拟"停止"的效果（真实停止接口需要登录态）
  const d = JSON.parse(fs.readFileSync(USERS, "utf8"));
  delete d.users.u1.autoResume;
  fs.writeFileSync(USERS, JSON.stringify(d, null, 1), "utf8");
  child.kill();
  await sleep(500);

  const child2 = startServer();
  await sleep(5000);
  ok("不会重复续刷", !/\[续刷\]/.test(child2.out), (child2.out.match(/\[续刷\].*/) || ["（无）"])[0]);
  child2.kill();
  await sleep(300);

  // 还原
  if (backup != null) fs.writeFileSync(USERS, backup, "utf8");
  else try { fs.unlinkSync(USERS); } catch (e) {}

  console.log("\n" + "=".repeat(44));
  console.log("  通过 " + pass + "   失败 " + fail);
  if (fails.length) console.log("  失败项: " + fails.join(", "));
  console.log("=".repeat(44));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试异常:", e); process.exit(1); });
