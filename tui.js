/**
 * 原生控制台界面（TUI）—— 不开浏览器，exe 双击直接出图形化控制台窗口。
 * 用 ANSI 转义序列绘制：进度条/统计/日志区，Windows 10+ 终端原生支持。
 *
 * 启动: node tui.js（或打包成 exe）
 */
const readline = require("readline");
const path = require("path");

const Config = require("./config.js");
const Loginer = require("./loginer.js");
const Session = require("./session.js");
const CourseTask = require("./courseTask.js");
const { QuizAgent } = require("./quizAgent.js");

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  blue: "\x1b[94m",
};

let W = 80;
const LOG_LINES = 10;
const logs = [];
const state = {
  phase: "init", // init | login | ready | running | done
  message: "",
  ui: null,
  stats: null,
  startedAt: 0,
  running: false,
  quiz: { total: 0, right: 0 },
};

function fmt(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function bar(pct, width) {
  width = width || 40;
  const filled = Math.round((pct / 100) * width);
  return "[" + "█".repeat(filled) + "·".repeat(Math.max(0, width - filled)) + "]";
}

function pushLog(line) {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logs.push({ t, line: String(line) });
  if (logs.length > 500) logs.splice(0, logs.length - 500);
}

function render() {
  const lines = [];
  const pad = (s, n) => (String(s) + " ".repeat(n)).slice(0, n);

  lines.push("");
  lines.push(C.bold + C.cyan + "  ╔══════════════════════════════════════════════════════════╗" + C.reset);
  lines.push(C.bold + C.cyan + "  ║        超星学习通自动刷课  ·  v2.0 (2026协议)             ║" + C.reset);
  lines.push(C.bold + C.cyan + "  ╚══════════════════════════════════════════════════════════╝" + C.reset);
  lines.push("");

  // 状态区
  const u = state.ui || {};
  const cur = u.current;
  let phaseText, phaseColor;
  if (state.phase === "init") { phaseText = "初始化…"; phaseColor = C.gray; }
  else if (state.phase === "login") { phaseText = "登录中…"; phaseColor = C.yellow; }
  else if (state.phase === "running") { phaseText = "刷课运行中（Ctrl+C 停止，进度已实时上报）"; phaseColor = C.green; }
  else if (state.phase === "done") { phaseText = "全部完成 ✔"; phaseColor = C.green; }
  else { phaseText = state.message || "待机"; phaseColor = C.gray; }
  lines.push("  状态: " + phaseColor + C.bold + phaseText + C.reset);

  if (state.phase === "running" && cur) {
    lines.push("  课程: " + C.blue + C.bold + (cur.course || "") + C.reset);
    lines.push("  章节: " + (cur.chapter || ""));
    if (cur.video) {
      const pct = cur.pct || 0;
      lines.push("  视频: " + cur.video);
      const mm = Math.floor(cur.playingTime / 60), ss = cur.playingTime % 60;
      const dm = Math.floor(cur.duration / 60), ds = cur.duration % 60;
      lines.push(
        "  " + C.cyan + bar(pct, 46) + C.reset + " " + C.bold + pct.toFixed(1) + "%" + C.reset +
        C.gray + "  " + mm + ":" + String(ss).padStart(2, "0") + "/" + dm + ":" + String(ds).padStart(2, "0") + C.reset
      );
    }
  }

  lines.push("");
  // 统计卡
  const st = state.stats || {};
  const run = state.startedAt && state.running ? fmt((Date.now() - state.startedAt) / 1000) : "--:--";
  lines.push(
    "  ┌─────────┬─────────┬─────────┬─────────┬─────────┐"
  );
  lines.push(
    "  │ " + C.bold + C.cyan + pad((u.doneCourses || 0) + "/" + (u.totalCourses || 0), 7) + C.reset +
    "│ " + C.bold + pad(st.videos || 0, 7) + C.reset +
    "│ " + C.bold + C.green + pad(st.passed || 0, 7) + C.reset +
    "│ " + C.bold + C.yellow + pad((state.quiz.right || 0) + " 题", 7) + C.reset +
    "│ " + C.bold + pad(run, 7) + C.reset + "│"
  );
  lines.push(
    "  │ 课程    │ 视频    │ 已完成  │ 弹题答对│ 用时    │"
  );
  lines.push(
    "  └─────────┴─────────┴─────────┴─────────┴─────────┘"
  );
  lines.push("");

  // 日志区
  lines.push("  " + C.gray + "─".repeat(W - 4) + C.reset);
  const visible = logs.slice(-LOG_LINES);
  visible.forEach((l) => {
    let color = "";
    if (/✖|失败|错误/.test(l.line)) color = C.red;
    else if (/✔|答对|已完成/.test(l.line)) color = C.green;
    else if (/⚠|弹题/.test(l.line)) color = C.yellow;
    lines.push("  " + C.gray + l.t + C.reset + " " + color + l.line.slice(0, W - 16) + C.reset);
  });
  for (let i = visible.length; i < LOG_LINES; i++) lines.push("");
  lines.push("  " + C.gray + "─".repeat(W - 4) + C.reset);
  lines.push(C.gray + "  服务端按真实时间记账 · 关闭窗口即停（进度不丢）· 请勿双开" + C.reset);

  // 整屏重绘
  process.stdout.write("\x1b[2J\x1b[H" + lines.join("\r\n") + "\r\n");
}

async function main() {
  // Windows 终端开启 ANSI
  try { readline.emitKeypressEvents(process.stdin); } catch (e) {}
  if (process.platform === "win32") {
    try { process.stdout.write("\x1b[9999;9999H\x1b[6n"); } catch (e) {}
  }
  W = Math.min(120, (process.stdout.columns || 80));

  const cfgPath = path.join(__dirname, "config.json");
  const cfg = await new Config(cfgPath).read();
  state.phase = "login";
  state.message = "使用已保存登录态";
  render();

  const logFn = (...a) => { pushLog(a.join(" ")); render(); };

  const lo = new Loginer(cfg);
  const cookie = await lo.login();
  const session = new Session({ cookie, debug: false });
  pushLog("登录成功 uid=" + session.uid);
  try { if (cfg.write) await cfg.write(); } catch (e) {}

  state.phase = "running";
  state.running = true;
  state.startedAt = Date.now();
  render();

  const quizAgent = new QuizAgent(session);
  const task = new CourseTask(session, cfg);
  task.cfg.log = logFn;
  task.quizAgent = quizAgent;

  // 定时刷新 UI（播放进度从 ui.current 读）
  const uiTimer = setInterval(() => {
    state.ui = task.ui;
    state.stats = task.stats;
    state.quiz = quizAgent.stats;
    render();
  }, 1000);

  try {
    await task.run();
    state.phase = "done";
    pushLog("全部任务结束 ✔");
  } catch (e) {
    pushLog("任务异常: " + (e && e.message ? e.message : e));
  } finally {
    state.running = false;
    clearInterval(uiTimer);
    render();
    // 保持窗口
    process.stdin.resume();
  }
}

process.on("SIGINT", () => {
  pushLog("收到停止信号，进度已实时上报");
  render();
  setTimeout(() => process.exit(0), 800);
});

main().catch((e) => {
  pushLog("启动失败: " + (e && e.message ? e.message : e));
  render();
  setTimeout(() => process.exit(1), 4000);
});
