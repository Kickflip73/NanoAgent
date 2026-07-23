#!/bin/bash
# Mimi memwatch - 实时监控内存大户，超过阈值自动通知
THRESHOLD_MB=3000
INTERVAL=30

echo "🔍 Mimi 内存监控已启动 | 阈值: ${THRESHOLD_MB}MB | 间隔: ${INTERVAL}s | $(date)"

while true; do
  free_mb=$(vm_stat 2>/dev/null | awk '/Pages free/ {free=$3} /Pages active/ {act=$3} /Pages inactive/ {inact=$3} /Pages speculative/ {spec=$3} END {if(free) print int((free+act+inact+spec)*4096/1048576); else print "N/A"}')

  > /tmp/mimi_mem_alert.txt
  alert=0
  while read -r pid comm mem_mb; do
    if [ "$mem_mb" -gt "$THRESHOLD_MB" ] 2>/dev/null; then
      echo "⚠️  PID $pid $comm: ${mem_mb}MB" >> /tmp/mimi_mem_alert.txt
      alert=1
    fi
  done < <(ps aux --sort=-%mem 2>/dev/null | awk 'NR>1{printf "%s %s %d\n", $2, $11, $6/1024}' | head -10)

  if [ "$alert" -eq 1 ]; then
    osascript -e "display notification \"$(head -3 /tmp/mimi_mem_alert.txt | tr '\n' ' ')\" with title \"Mimi 内存告警\""
  fi

  sleep "$INTERVAL"
done
