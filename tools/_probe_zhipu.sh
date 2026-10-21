#!/bin/bash
# 验证智谱接口可达 + 请求格式正确（故意用假 key，期望 401）
set -e
cat > /tmp/probe-zhipu.js <<'JSEOF'
const AP = require("/opt/chaoxing/answerProvider.js");
const A = require("/opt/chaoxing/answerer.js");

(async () => {
  const q = { type: 0, title: "总体国家安全观是在哪次会议上首次提出的", options: { A: "党的十八大", B: "党的十九大", C: "十八届中央国家安全委员会第一次会议", D: "党的十九届四中全会" } };
  console.log("提示词:\n" + AP.buildPrompt(q) + "\n");

  // 直接打接口，看状态码（假 key）
  const r = await AP.request("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake-key-for-test" },
    body: JSON.stringify({ model: "glm-4-flash", messages: [{ role: "user", content: "hi" }] }),
    timeoutMs: 20000,
  });
  console.log("HTTP", r.status);
  console.log("响应:", String(r.text).slice(0, 300));
})().catch((e) => { console.error("失败:", e && e.stack || e); process.exit(1); });
JSEOF
cd /opt/chaoxing && node /tmp/probe-zhipu.js 2>&1