云端多人部署 - 服务器选型与成本
========================================

【实测资源占用（基准）】
  单实例空闲: 75 MB 内存 / 18 线程 / CPU≈0
  刷课运行时: 80~110 MB（一个视频在跑）
  上报频率: 每个视频每 65 秒 1 次请求，约 3 个请求/分钟/人
  带宽: 每人约 2~5 KB/s（几乎可忽略）

【按人数选服务器】

  人数      配置         内存估算    推荐机型            年费参考
  ------------------------------------------------------------------
  1~5      1核1G        约 0.3G     轻量应用服务器       100~400 元
  5~20     1核2G        约 0.8G     轻量 2G             300~700 元
  20~50    2核4G        约 2G       轻量/CVM 2C4G       800~1800 元
  50~100   4核8G        约 4G        CVM 4C8G            2000~4000 元
  >100     多台分摊      每台≤50人   2C4G × N 台         按台累加

  磁盘：20~40G SSD 足够（数据只有几百 KB/人）
  带宽：1~3 Mbps 足够（100 人也就 0.5 Mbps 左右）
  系统：Ubuntu 22.04 / Debian 12

【真正的瓶颈不是服务器，是 IP 风控】
  所有用户从同一台服务器 IP 访问学习通 →
  请求量叠加后极易触发平台风控（你已经遇到过一次）。

  推荐做法：
  · 每台服务器 / 每个出口 IP 承载 ≤ 10~20 个账号
  · MAX_RUNNING 环境变量限制同时刷课人数（默认 30，建议 10~20）
  · 每人并发固定 1 路，禁止多人同时多路
  · 错峰启动：不要所有人整点一起开刷
  · 出问题只影响一台机器的一段 IP，不会全灭

【部署方式（三种，任选）】

① PM2（最简单，推荐）
   npm i -g pm2
   cd chaoxing-flush
   npm install --omit=dev
   pm2 start deploy/ecosystem.config.js
   pm2 save && pm2 startup
   访问 http://服务器IP:8080

② Docker
   cd chaoxing-flush
   docker compose -f deploy/docker-compose.yml up -d
   数据在 deploy/data/ 目录，备份这个目录即可

③ systemd（不用 PM2 的话）
   [Unit]
   Description=Chaoxing Multi
   After=network.target
   [Service]
   WorkingDirectory=/opt/chaoxing-flush
   Environment=PORT=8080 ADMIN_PASSWORD=你的密码 MAX_RUNNING=20
   ExecStart=/usr/bin/node server-multi.js
   Restart=always
   RestartSec=10
   [Install]
   WantedBy=multi-user.target

【多用户是怎么隔离的】
  · 每个用户在 data/users.json 里有独立记录
  · 密码用服务器密钥加密存储（不存明文）
  · 登录后发 32 位 token，后续请求带 token 鉴权
  · 每个用户独立 Session + 独立 CourseTask，进度互不影响
  · 一人停止/出错不影响其他人

【安全建议】
  · 必须设 ADMIN_PASSWORD，否则管理员接口关闭
  · Nginx 上 HTTPS（Let's Encrypt 免费）
  · /api/admin/ 只允许内网访问
  · 对外最好用邀请码控制注册，别公开让陌生人用
  · 日志会记录账号，注意不要外泄

【风险提示（务必看）】
  1. 多人共用一台服务器 = 同 IP 大量访问，风控概率显著上升
  2. 一旦 IP 被封，所有用户一起受影响
  3. 平台可能升级反爬，程序需要持续维护
  4. 用于自己/小范围同学可，大规模对外提供服务风险高
