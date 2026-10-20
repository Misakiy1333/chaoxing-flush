/**
 * Cookie 提取辅助工具
 *
 * 用法：把本文件内容复制到 Edge 的 Console（F12）里，在学习通页面执行。
 * 会自动打印诊断信息 + 可用的 cookie 串。
 *
 * 关键：必须满足两个条件
 *   1. 当前页面是 mooc 域（mooc1.chaoxing.com / mooc1-1.chaoxing.com / i.mooc.chaoxing.com）
 *   2. 已登录（页面右上角有头像/用户名）
 */
(function () {
  const NEED = ["_uid", "_d", "vc3", "_vci", "uf", "fid", "lv", "UID", "vc2", "jrose", "k8s"];

  console.log("%c===== 学习通 Cookie 提取工具 =====", "color:#0af;font-size:14px;font-weight:bold");
  console.log("当前 URL:", location.href);
  console.log("当前域名:", location.hostname);
  console.log("");

  // 1) 收集当前域可见的 cookie
  const jar = {};
  document.cookie.split(";").forEach(function (c) {
    const i = c.indexOf("=");
    if (i < 0) return;
    jar[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  });

  const allNames = Object.keys(jar);
  console.log("%c当前域可读 cookie（" + allNames.length + " 个）:", "color:#0a0");
  console.log(allNames.join(", ") || "(空)");
  console.log("");

  // 2) 检查关键字段
  console.log("%c关键字段检查:", "color:#0a0");
  const picked = [];
  NEED.forEach(function (k) {
    if (jar[k] != null && jar[k] !== "") {
      picked.push(k + "=" + jar[k]);
      console.log("  [有] " + k.padEnd(8) + " = " + jar[k].slice(0, 50) + (jar[k].length > 50 ? "..." : ""));
    }
  });
  const missing = ["_uid", "_d", "vc3"].filter(function (k) { return jar[k] == null || jar[k] === ""; });
  if (missing.length) {
    console.log("  [缺] " + missing.join(", "));
  }
  console.log("");

  // 3) 关键提示
  if (missing.indexOf("vc3") !== -1) {
    console.log("%c⚠ 缺少 vc3 —— 这是核心鉴权令牌，没有它无法通过接口认证", "color:#f80;font-weight:bold");
    console.log("   可能原因：");
    console.log("   a) 当前不在 mooc 域，请在 mooc1.chaoxing.com 或 i.mooc.chaoxing.com 页面执行");
    console.log("   b) vc3 在父域 .chaoxing.com 下，F12 → Application → Cookies → 展开 .chaoxing.com 查看");
    console.log("   c) 尚未登录，请先完成登录再执行");
    console.log("");
    console.log("%c请改用这个方式：", "color:#0af;font-weight:bold");
    console.log("   F12 → Application → Cookies → https://chaoxing.com");
    console.log("   找到 vc3 一行，双击 Value 全选复制，然后告诉我");
    console.log("");
  }

  // 4) 输出可用的 cookie 串
  if (picked.length) {
    const out = picked.join("; ") + "; ";
    console.log("%c===== cookie 串（已复制到剪贴板）=====", "color:#0a0;font-weight:bold");
    console.log(out);
    try {
      copy(out);
      console.log("%c✓ 已复制，直接粘贴给程序即可", "color:#0a0");
    } catch (e) {
      console.log("(自动复制失败，请手动选中上面那行复制)");
    }
  } else {
    console.log("%c没有可用的字段，无法生成 cookie 串", "color:#f00");
  }

  console.log("");
  console.log("%c===== 排查建议 =====", "color:#0af");
  console.log("若提示未登录/缺字段，请：");
  console.log("1. 地址栏输入 https://i.mooc.chaoxing.com/ 回车，确认页面显示你的名字");
  console.log("2. 再执行本脚本");
  console.log("3. 若仍缺 vc3，用 Application 面板手动抄");
})();
