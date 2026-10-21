# 超星学习通 刷课助手（飞飞）

> **把学习通网页端的协议链路完整实现了一遍**：登录 → 选课 → 章节 → 视频心跳上报 → 弹题作答，并做成两套可运行的产品形态：**本地单机版** 和 **云端多人版**。
>
> 前端只有一份（`web/multi.html`），本地和云端共用，所以界面、进度条、风控面板、开始/停止行为完全一致。

---

## ⚠️ 免责声明（先读）

- 本项目**仅供学习与交流**：用于研究 Web 协议实现、Node.js 全栈、前端实时推送（SSE）、单文件可执行程序打包等工程实践。
- 使用本工具可能**违反学习通的服务条款**，可能导致账号被限制、课程进度异常甚至封号。**一切后果由使用者自行承担**。
- 代码中确实包含了降低被风控识别概率的节奏控制（随机间隔、拟人停顿等），这是为了让请求速率更接近真人浏览，**但不保证一定不被识别**。
- 请勿用于商业用途、代刷牟利、批量注册等行为。**如果你不认同以上任意一条，请不要使用本项目。**

---

## 功能

| 模块 | 说明 |
|---|---|
| **登录** | 学习通 2026 协议：AES-128-CBC 加密凭据提交，动态 cookie jar 吸收 `route/jrose/k8s` |
| **课程/章节** | 自动拉取课程列表、章节列表，识别「已完成」标记 |
| **视频刷课** | 起播 → 按墙钟 60s 心跳 → 结束上报，服务端按视频分别记账 |
| **跳过已完成** | 启动时先扫描：整门课/整章/单个视频已完成都不会重复刷，不占节奏额度 |
| **弹题作答** | 视频内插题（InteractiveQuiz）自动作答，支持题库记忆 |
| **拟人化节奏** | 章节随机间隔、周期小憩、长休、弹题思考延迟、随机暂停、1 倍速单线 |
| **风控处理** | 识别拦截 → 退避（最多等 5 分钟）→ 连续 3 次停止；状态实时可视化 |
| **本地版 GUI** | 单文件 exe，双击开网页控制台，无需服务器 |
| **云端多人版** | 一个网址，多账号各自独立任务，持久登录态（30 天） |
| **实时推送** | SSE 每 2 秒推状态，断线自动降级轮询 |
| **管理后台** | 管理员账号登录后可进 `/admin`：看所有账号、停止/踢下线、白名单、公告、下载链接 |

---

## 架构

```
web/multi.html          唯一前端（界面 / 选课 / 进度 / 风控面板 / 开始停止）
    │
    ├── server-multi.js  云端后端：多用户、sid Cookie、users.json、SSE、管理后台
    └── local-server.js  本地后端：单用户、config.json、同样一套 /api/*
             ↑
          gui.js         本地版入口（起服务 + 开浏览器）
             ↑
        build-exe.js     打成单文件 exe（esbuild + Node SEA + 签名清理）
```

两套后端实现**完全相同的 `/api/*` 契约**，所以前端只维护一份。

### 目录结构

```
├── server-multi.js     云端多人服务（入口）
├── local-server.js     本地单用户服务
├── gui.js              本地版启动器（exe 入口）
├── session.js          HTTP 会话 + 动态 cookie jar + 代理
├── loginer.js          登录（AES 加密 / 验证码 / 代理 / 错误分类）
├── course.js           课程、章节、任务点、视频状态、进度回读
├── courseTask.js       任务调度（扫描 / 排队 / 跳过 / 风控退避 / 进度统计）
├── player.js           视频心跳模拟（含可中断等待、随机暂停）
├── logger.js           上报 URL 与 enc 签名
├── quizAgent.js        弹题作答
├── humanize.js         拟人化节奏（间隔 / 小憩 / 限速 / 可中断睡眠）
├── config.js           本地配置读写（密码加密存储）
├── crypto-util.js      AES-256-GCM 加密（支持 ENC_KEY 环境变量）
├── version.js          版本号 / 更新公告 / 下载地址
├── web/
│   ├── multi.html      前端页面（前端/登录页/仪表盘/下载入口）
│   └── admin.html      管理后台页面
├── deploy/             部署脚本、nginx、pm2、Docker
└── tools/              测试、诊断、发布、白名单等运维脚本
```

---

## 快速开始

### 方式一：本地版（推荐给个人）

```bash
npm install
node gui.js
# 浏览器打开 http://127.0.0.1:8765
```

打包成单文件 exe：

```bash
node build-exe.js
# 产物：dist/超星刷课.exe（约 93MB）
```

首次运行会在同目录生成 `config.json`，在里面填账号密码即可（程序也会在网页里让你输）。

### 方式二：云端多人版

需要一台 Linux 服务器（Ubuntu 20.04+，1核2G 起）。

```bash
npm install
export PORT=8080
export ADMIN_PASSWORD=你的管理密码        # 管理员密码（也可用管理员账号登录后台）
export ADMIN_USERS=18800000000            # 哪些账号登录后能进后台，逗号分隔
export ENC_KEY=一串固定的随机字符串        # 用户密码加密密钥，务必固定
export MAX_RUNNING=20                     # 同时刷课人数上限
node server-multi.js
```

或用 `deploy/deploy.sh` 一键部署（自动装 Node、配 systemd、开端口、可配 nginx + HTTPS）：

```bash
bash deploy/deploy.sh
bash deploy/deploy.sh --domain example.com --email you@example.com
```

Docker：

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

> Docker 部署**必须**设置 `ENC_KEY`，否则容器重建后保存的密码会解不开。

---

## 配置

### `config.json`（本地版）

```json
{
  "uname": "手机号",
  "password": "明文或 ENC: 开头的密文",
  "saveCookie": "",
  "skipCourse": "高等数学,人工智能通识课",
  "parallel": 1,
  "dailyHours": 24,
  "brushStart": 0,
  "brushEnd": 24,
  "updateUrl": "http://你的更新服务地址:8080"
}
```

- `skipCourse`：不想刷的课程，逗号分隔（中英文逗号都行），支持课程名或 courseId
- `dailyHours`：每日时长上限，24 表示不限
- `brushStart/brushEnd`：刷课时段，0~24 表示全天
- `parallel`：并发路数，**拟人模式下强制 1**

### 环境变量（云端版）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `ADMIN_PASSWORD` | 空 | 管理员密码（接口级兜底） |
| `ADMIN_USERS` | 空 | 可进后台的账号，逗号分隔 |
| `ENC_KEY` | 空 | 用户密码加密密钥，**生产必须设置且固定** |
| `MAX_RUNNING` | 30 | 全局同时刷课人数上限 |
| `UPDATE_URL` | 空 | 本地版检查更新用的云端地址（如 `http://1.2.3.4:8080`） |
| `AUTO_RESUME` | 1 | 服务重启后是否自动接着刷上次中断的任务（设 0 关闭） |

> `ADMIN_USERS` 必须写进服务器的 `.env`，否则没人能进管理后台（代码里不带默认账号）。

### 断点续刷（更新代码不中断刷课）

服务重启（部署更新、systemd 重启、机器重启）时：

1. 收到 `SIGTERM` → 立刻把每个任务的进度写盘 → 停止任务
2. 启动时扫描 `data/users.json` 里带 `autoResume` 的账号 → 自动重新拉起任务
3. 任务从「扫描章节」阶段重新开始，已完成的章节/视频自动跳过，所以接着上次的位置继续
4. 用户**手动点停止** → 清掉标记，不再自动续刷
5. 任务**正常跑完** → 同样清掉标记

页面日志里会看到：

```
🔄 服务已重启完成，自动接着上次的进度继续刷
```

---

## 管理后台

管理员账号登录后，页面右上角出现「🛠 管理后台」，或直接访问 `/admin`。

- 总览：账号数、正在刷、累计完成、内存、运行时长、版本
- 用户列表：状态 / 已完成 / 失败 / 风控等级 / 在线 / 白名单 / 最后登录
- 操作：停止某人任务、踢下线
- 白名单：开关 + 增删
- 公告：直接编辑发布
- 下载：发布蓝奏云等外链（页面登录页和仪表盘都会显示）

---

## 常用脚本

| 脚本 | 作用 |
|---|---|
| `node tools/audit.js` | 全量自检（语法、模块、加密、拟人化、接口） |
| `node tools/final-check.js` | 全部测试套件 + 线上状态汇总 |
| `node tools/test-pick.js` | 选课逻辑（jsdom 真点击） |
| `node tools/test-skipcourse.js` | 跳过课程 / 只刷指定课程 |
| `node tools/test-course-skip.js` | 整门课已完成是否整体跳过 |
| `node tools/test-skip.js` | 已完成视频是否跳过 + 停止是否立即生效 |
| `node tools/test-login.js` | 登录全链路（离线打桩） |
| `node tools/test-humanize.js` | 拟人化节奏默认值与可中断性 |
| `node tools/whitelist.js` | 白名单管理（add/remove/list/on/off） |
| `node tools/publish-release.js` | 上传安装包并发布版本 |
| `node tools/set-announce.js` | 发布更新公告 |
| `node tools/remote-deploy.js` | 通过 SSH 一键部署到服务器 |
| `node tools/push-github.js` | 推送代码到 GitHub（自动建仓库） |
| `node tools/push-github-api.js` | 走 GitHub API 提交（`github.com` 被墙时用这个） |

> **国内网络提示**：`github.com` 的 git 协议常被重置，但 `api.github.com` 通常可访问。
> 如果 `git push` 一直失败，用 `node tools/push-github-api.js 用户名/仓库名`，
> 它通过 REST API 逐文件提交，不依赖 git 协议。

绝大多数运维脚本需要这两个环境变量：

```bash
set DEPLOY_HOST=你的服务器IP
set ADMIN_PWD=你的管理密码
```

---

## 测试

```bash
node tools/final-check.js
```

会依次跑 10 个套件（约 300 项断言），最后汇总线上状态。测试里的网络请求全部打桩，不会消耗真实登录次数。

---

## 实现要点（踩过的坑）

1. **上报必须并发真实墙钟**：一次性报满会被判定无效；心跳必须 60s 级推进。
2. **`otherInfo` 不能 URL 编码**，否则返回 403。
3. **cookie 必须是完整的会话链**：`route/jrose/k8s` 缺一个就不记账。
4. **`enc` 签名算法**：`MD5(clazzId + userid + jobid + objectId + playingTime*1000 + d_yHJ!$pdA~5 + duration*1000 + 0_duration)`。
5. **跳过已完成**依赖章节页的 `catalog_state icon_yiwanc` 标记 + 任务点 `isPassed`/`playTime`。
6. **单文件 exe**：esbuild 打包 → Node SEA 注入 → **清除失效的 Authenticode 签名**，否则 Windows 应用控制策略会拦截。

---

## License

[MIT](LICENSE) © 2026 飞飞

联系邮箱：cc040921f@gmail.com
