#!/usr/bin/env bash
#
# 超星刷课 云端多人版 —— 一键部署脚本
#
# 用法（在解压后的项目目录里，用 root 执行）：
#   bash deploy.sh                        # 直接用 IP:8080 访问
#   bash deploy.sh --domain a.com         # 带域名 + 自动 HTTPS 证书
#   bash deploy.sh --domain a.com --email me@qq.com
#   bash deploy.sh --port 9000 --admin-pass 你的密码
#
# 支持：Ubuntu 20.04/22.04/24.04、Debian 11/12
#
set -euo pipefail

APP_DIR="/opt/chaoxing"
SERVICE="chaoxing"
PORT="8080"
DOMAIN=""
EMAIL=""
ADMIN_PASS=""
MAX_RUNNING="30"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email)  EMAIL="$2"; shift 2 ;;
    --port)   PORT="$2"; shift 2 ;;
    --admin-pass) ADMIN_PASS="$2"; shift 2 ;;
    --max-running) MAX_RUNNING="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_blue()  { printf '\033[36m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }

# 云服务器上 unattended-upgrades 常占着 apt 锁，失败就等一会重试
apt_retry() {
  local n=0
  until "$@" >/dev/null 2>&1; do
    n=$((n + 1))
    if [[ $n -ge 24 ]]; then
      c_red "apt 操作失败（重试 $n 次）：$*"
      return 1
    fi
    sleep 10
  done
  return 0
}

[[ $EUID -eq 0 ]] || { c_red "请用 root 执行：sudo bash deploy.sh"; exit 1; }

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$SRC_DIR/server-multi.js" ]] || { c_red "找不到 server-multi.js，请把整个项目一起上传"; exit 1; }

c_blue "==> 1/7 安装基础依赖"
export DEBIAN_FRONTEND=noninteractive
apt_retry apt-get update -qq || true
apt_retry apt-get install -y -qq curl ca-certificates tar gzip || true
for b in curl tar gzip; do
  command -v "$b" >/dev/null 2>&1 || { c_red "缺少 $b，请手动安装后重跑"; exit 1; }
done

node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  command -v npm >/dev/null 2>&1 || return 1
  [[ "$(node_major)" -ge 18 ]] || return 1
  return 0
}

c_blue "==> 2/7 检查 Node.js"
if node_ok; then
  c_green "已有 Node $(node -v)，跳过"
else
  c_blue "安装 Node.js（三级兜底，兼容很新的 Ubuntu）..."
  # 兜底 1：系统自带源
  apt_retry apt-get install -y -qq nodejs npm || true

  # 兜底 2：NodeSource（新发行版可能还没收录）
  if ! node_ok; then
    ( curl -fsSL https://deb.nodesource.com/setup_22.x | bash - ) >/dev/null 2>&1 || true
    apt_retry apt-get install -y -qq nodejs || true
  fi

  # 兜底 3：官方二进制包，任何发行版都能用
  if ! node_ok; then
    c_blue "改用 Node.js 官方二进制包 ..."
    cd /tmp
    rm -f node-v*-linux-x64.tar.xz 2>/dev/null || true
    NODE_FILE="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ 2>/dev/null | grep -oE 'node-v22\.[0-9.]+-linux-x64\.tar\.xz' | head -1)"
    if [[ -n "$NODE_FILE" ]]; then
      curl -fsSL -O "https://nodejs.org/dist/latest-v22.x/$NODE_FILE"
      tar -xf "$NODE_FILE" -C /usr/local --strip-components=1 \
          --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md 2>/dev/null || true
    fi
  fi
fi
node_ok || { c_red "Node 安装失败，请手动装 Node 18+ 后重跑"; exit 1; }
NODE_BIN="$(command -v node)"
c_green "Node $(node -v) / npm $(npm -v) → $NODE_BIN"

c_blue "==> 3/7 复制程序到 $APP_DIR"
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  mkdir -p "$APP_DIR"
  # 只复制运行需要的东西，跳过本地垃圾
  # data/ 和 .env 绝不能覆盖：里面有用户账号和密钥
  tar -C "$SRC_DIR" -cf - \
      --exclude=node_modules --exclude=.git --exclude=dist \
      --exclude='_br*' --exclude='_e*.txt' --exclude='_f*.txt' --exclude='_o.txt' \
      --exclude=run.log --exclude='*.exe' --exclude='*.zip' \
      --exclude='./data' --exclude='./logs' --exclude='./backup' --exclude='./.env' \
      . 2>/dev/null | tar -C "$APP_DIR" -xf -
fi
mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
c_green "程序已就位"

c_blue "==> 4/7 安装 npm 依赖（国内源）"
cd "$APP_DIR"
# 时区设成北京时间，日志和作息判断才对得上
timedatectl set-timezone Asia/Shanghai 2>/dev/null || true
npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund
c_green "依赖安装完成"

c_blue "==> 5/7 生成配置"
ENV_FILE="$APP_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  c_green "已有 .env，保留原有密钥"
else
  [[ -n "$ADMIN_PASS" ]] || ADMIN_PASS="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)"
  ENC_KEY="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
ADMIN_PASSWORD=$ADMIN_PASS
ENC_KEY=$ENC_KEY
MAX_RUNNING=$MAX_RUNNING
NODE_ENV=production
EOF
  chmod 600 "$ENV_FILE"
  c_green "已生成 .env（管理员密码：$ADMIN_PASS）"
fi
# 从 .env 读回真实值（重复部署时保证密码不丢）
set -a; . "$ENV_FILE"; set +a
PORT="${PORT:-8080}"
ADMIN_PASS="${ADMIN_PASSWORD:-$ADMIN_PASS}"

c_blue "==> 6/7 注册 systemd 服务"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Chaoxing Multi-User Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$NODE_BIN $APP_DIR/server-multi.js
Restart=always
RestartSec=5
StandardOutput=append:$APP_DIR/logs/out.log
StandardError=append:$APP_DIR/logs/err.log
# 内存保护：超过 900M 自动重启
MemoryMax=900M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  c_green "服务已启动"
else
  c_red "服务启动失败，看日志：journalctl -u $SERVICE -n 50"
  exit 1
fi

# 每天 4 点备份用户数据
cat > /etc/cron.daily/chaoxing-backup <<EOF
#!/bin/sh
mkdir -p $APP_DIR/backup
cp $APP_DIR/data/users.json $APP_DIR/backup/users-\$(date +\%m\%d).json 2>/dev/null
ls -t $APP_DIR/backup/users-*.json 2>/dev/null | tail -n +8 | xargs -r rm -f
EOF
chmod +x /etc/cron.daily/chaoxing-backup

c_blue "==> 7/7 配置防火墙 / 反向代理"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if [[ -n "$DOMAIN" ]]; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  else
    ufw allow "$PORT"/tcp >/dev/null
  fi
  c_green "已放行端口"
fi

if [[ -n "$DOMAIN" ]]; then
  c_blue "安装 nginx + 申请证书 ..."
  apt_retry apt-get install -y -qq nginx certbot python3-certbot-nginx || true
  cat > /etc/nginx/sites-available/chaoxing <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
    # 管理接口只许本机访问
    location /api/admin/ {
        allow 127.0.0.1;
        deny all;
        proxy_pass http://127.0.0.1:$PORT;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/chaoxing /etc/nginx/sites-enabled/chaoxing
  rm -f /etc/nginx/sites-enabled/default
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  c_green "nginx 已配置"
  if [[ -n "$EMAIL" ]]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || c_red "证书申请失败，先用 http 访问"$'\n'
  else
    c_blue "没给 --email，跳过证书。想开 HTTPS 再跑：certbot --nginx -d $DOMAIN"
  fi
fi

IP="$(curl -s --max-time 5 https://api.ipify.org || echo '服务器IP')"
echo ""
c_green "================ 部署完成 ================"
if [[ -n "$DOMAIN" ]]; then
  echo "  访问地址: http://$DOMAIN"
else
  echo "  访问地址: http://$IP:$PORT"
fi
echo "  管理员密钥: $ADMIN_PASS"
echo "  查看用户:   http://$IP:$PORT/api/admin/users?pwd=$ADMIN_PASS"
echo ""
echo "  常用命令:"
echo "    systemctl status $SERVICE      # 看状态"
echo "    systemctl restart $SERVICE     # 重启"
echo "    tail -f $APP_DIR/logs/out.log  # 看日志"
echo "    cat $APP_DIR/.env              # 看配置"
echo ""
echo "  ⚠ 记下管理员密钥，重启服务器不会丢（存在 $APP_DIR/.env）"
c_green "========================================="
