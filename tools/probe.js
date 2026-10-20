/**
 * 工具：网络连通性自检。
 * 检查 passport2 / mooc1 是否可达，DNS 是否正常。
 * 用法: npm run probe
 */
const fetch = require("node-fetch");

const targets = [
  ["passport2 登录入口", "https://passport2.chaoxing.com/"],
  ["mooc1-1 课程站", "https://mooc1-1.chaoxing.com/"],
  ["mooc1 课程站", "https://mooc1.chaoxing.com/"],
  ["i.mooc 学习中心", "https://i.mooc.chaoxing.com/"],
  ["学习通移动端", "https://mobilelearn.chaoxing.com/"],
];

(async () => {
  console.log("网络连通性自检\n");
  for (const [name, url] of targets) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0" },
      });
      console.log(`[OK]   ${name.padEnd(20)} HTTP ${res.status}  ${Date.now() - t0}ms  ${url}`);
    } catch (e) {
      console.log(`[FAIL] ${name.padEnd(20)} ${e.message}  ${url}`);
    }
  }
  console.log("\n若 passport2 不可达，登录会失败；若 mooc1 不可达，刷课会失败。");
})();
