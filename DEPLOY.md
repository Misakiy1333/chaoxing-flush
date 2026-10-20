# 云端部署指南

三种方式任选。刷课逻辑完全相同（1x 墙钟记账 + 弹题 agent），只是跑在服务器上。

## 方式一：Docker（推荐，任意 VPS）

```bash
# 1. 上传整个 chaoxing-flush 目录到服务器
scp -r chaoxing-flush user@你的服务器:/opt/

# 2. 服务器上
cd /opt/chaoxing-flush
docker build -t chaoxing .
docker run -d --name chaoxing \
  -p 8765:8765 \
  -v $(pwd)/config.json:/app/config.json \
  -v $(pwd)/quizbank.json:/app/quizbank.json \
  --restart unless-stopped \
  chaoxing

# 3. 手机浏览器打开  http://服务器IP:8765   看进度
```

## 方式二：systemd（Linux 裸机）

```bash
# 服务器装 Node 20+，然后
cd /opt/chaoxing-flush && npm install

sudo tee /etc/systemd/system/chaoxing.service <<'EOF'
[Unit]
Description=Chaoxing auto-flush cloud
After=network.target

[Service]
WorkingDirectory=/opt/chaoxing-flush
ExecStart=/usr/bin/node cloud.js --watch
Restart=always
RestartSec=60

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now chaoxing
journalctl -u chaoxing -f        # 看日志
```

## 方式三：本地电脑当云端（挂在家里不关机）

```
node cloud.js --watch
# 手机连同一 WiFi 访问 http://电脑IP:8765
```

## 云服务器选择与开通

任选一家便宜 VPS（阿里云/腾讯云轻量 2C2G 即可，Node 内存占用 <200MB）。
注意：**选国内服务器**（境外 IP 访问 chaoxing.com 会触发风控）。

## 安全组/防火墙

放行 TCP 8765。更安全的做法：不开公网端口，用 SSH 隧道：
```bash
ssh -L 8765:127.0.0.1:8765 user@服务器IP
# 然后手机/电脑访问 http://127.0.0.1:8765
```

## --watch 模式

`node cloud.js --watch`：全部课程刷完后进程不退出，12 小时后自动重新扫描
（老师后加的新任务点会继续刷），直到你 docker stop / systemctl stop。
