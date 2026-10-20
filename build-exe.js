/**
 * 打包脚本：esbuild 打成单 bundle → Node SEA 生成独立 exe
 *
 * 产物：dist\超星刷课.exe
 *   双击运行 → 打开可视化控制台 http://127.0.0.1:8765
 */
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const OUT = path.join(__dirname, "dist");
fs.mkdirSync(OUT, { recursive: true });

// 先把网页内嵌成模块，exe 才能带上和云端一致的页面
require("./tools/gen-page-module.js").build();

(async () => {
  console.log("[1/3] esbuild 打包 gui.js（含全部依赖）…");
  await esbuild.build({
    entryPoints: [path.join(__dirname, "gui.js")],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: path.join(OUT, "bundle.cjs"),
    external: [], // 全部打入
    minify: false,
    logLevel: "error",
  });
  console.log("      bundle 大小:", (fs.statSync(path.join(OUT, "bundle.cjs")).size / 1024 / 1024).toFixed(1), "MB");

  console.log("[2/3] 生成 SEA 配置…");
  const seaConfig = {
    main: path.join(OUT, "bundle.cjs"),
    output: path.join(OUT, "sea-prep.blob"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };
  fs.writeFileSync(path.join(__dirname, "sea-config.json"), JSON.stringify(seaConfig, null, 2));

  console.log("[3/3] 生成 exe…");
  const nodeExe = process.execPath;
  const blob = path.join(OUT, "sea-prep.blob");
  execSync(`node --experimental-sea-config sea-config.json`, { cwd: __dirname, stdio: "inherit" });

  // 复制 node.exe → 改名 → 注入 blob
  const exe = path.join(OUT, "超星刷课.exe");
  fs.copyFileSync(nodeExe, exe);

  // 用 postject 注入（npx postject）
  execSync(
    `npx --yes postject "${exe}" NODE_SEA_BLOB "${blob}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { cwd: __dirname, stdio: "inherit" }
  );

  console.log("\n[4/4] 清除失效的数字签名…");
  // postject 注入后 node.exe 自带的签名就失效了，Windows 应用控制策略会以
  // 「签名损坏」为由拦截。把 PE 签名表清零 = 变成普通未签名文件，即可正常运行。
  execSync(`node "${path.join(__dirname, "tools", "strip-sign.js")}" strip "${exe}"`, {
    cwd: __dirname,
    stdio: "inherit",
  });

  console.log("\n✔ 打包完成:", exe);
  console.log("  大小:", (fs.statSync(exe).size / 1024 / 1024).toFixed(1), "MB");

  // exe 一跑就会读写同目录的 config.json，可能把你的账号写进去。
  // 打完包一律重置成空白模板，避免误把带账号的配置发给别人。
  fs.writeFileSync(
    path.join(OUT, "config.json"),
    JSON.stringify({
      uname: "", password: "", speed: 1, test: true, pick: false, pickinfos: null,
      saveCookie: "", domain: "https://mooc1-1.chaoxing.com/", debug: false,
      updateUrl: require("./version.js").updateUrl,
      skipCourse: "", parallel: 1, dailyHours: 24, brushStart: 0, brushEnd: 24, fid: "-1",
    }, null, "\t") + "\n",
    "utf8"
  );
  console.log("  已重置 dist\\config.json 为空白模板");

  // 构建中间产物用完就删，别留在 dist 里白占 6.7MB
  for (const f of ["bundle.cjs", "sea-prep.blob", "sea-config.json"]) {
    const p = path.join(OUT, f);
    try {
      if (fs.existsSync(p)) { fs.unlinkSync(p); console.log("  已清理中间产物 " + f); }
    } catch (e) {}
  }
})();
