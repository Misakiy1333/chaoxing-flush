#!/usr/bin/env bash
LOG=/opt/chaoxing/logs/out.log
L=$(grep -n '云端多人版' "$LOG" | tail -1 | cut -d: -f1)
echo "本次服务启动: 第 ${L:-?} 行（总行数 $(wc -l < "$LOG")）"
echo ""
if [ -n "$L" ]; then
  SEG=$(mktemp)
  tail -n +"$L" "$LOG" > "$SEG"
  echo "本次运行日志行数: $(wc -l < "$SEG")"
  echo "  风控拦截 : $(grep -c '风控拦截' "$SEG" || true)"
  echo "  已完成视频: $(grep -c '已完成' "$SEG" || true)"
  echo "  整章跳过 : $(grep -c '整章已完成' "$SEG" || true)"
  echo "  失败     : $(grep -c '失败' "$SEG" || true)"
  echo "  暂停(拟人): $(grep -c '⏸ 暂停' "$SEG" || true)"
  echo "  小憩     : $(grep -c '☕' "$SEG" || true)"
  echo ""
  echo "--- 本段第一行 ---"
  head -1 "$SEG"
  rm -f "$SEG"
fi
echo ""
echo "--- 服务运行时长 ---"
ps -o etime= -C node | head -1
echo "--- 磁盘 ---"
df -h / | tail -1
