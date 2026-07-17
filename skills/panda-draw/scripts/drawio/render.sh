#!/usr/bin/env bash
# render.sh — 把 .drawio 导出为 PNG/SVG/PDF(视觉自检/交付用),可选在 draw.io app 中打开
#
# 用法:
#   bash render.sh <file.drawio> [--format png|svg|pdf] [--scale N] [--open] [--no-export]
#
#   --format   导出格式,默认 png
#   --scale    导出缩放,默认 png=2(文字清晰便于 AI 看图自检),其他格式=1
#   --open     导出后用 draw.io 桌面 app 打开 .drawio 源文件
#   --no-export  只打开不导出(配合 --open)
#
# 输出文件与源文件同目录: <name>.<format>(自检用,不嵌 XML;交付可编辑图就是 .drawio 本身)
set -euo pipefail

DRAWIO_BIN=""
for cand in "/Applications/draw.io.app/Contents/MacOS/draw.io" "$(command -v drawio || true)"; do
  if [[ -n "$cand" && -x "$cand" ]]; then DRAWIO_BIN="$cand"; break; fi
done

FILE=""
FORMAT="png"
SCALE=""
DO_OPEN=0
DO_EXPORT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --format) FORMAT="$2"; shift 2 ;;
    --scale)  SCALE="$2"; shift 2 ;;
    --open)   DO_OPEN=1; shift ;;
    --no-export) DO_EXPORT=0; shift ;;
    -*) echo "未知参数: $1" >&2; exit 2 ;;
    *)  FILE="$1"; shift ;;
  esac
done

[[ -n "$FILE" ]] || { echo "用法: render.sh <file.drawio> [--format png|svg|pdf] [--open]" >&2; exit 2; }
[[ -f "$FILE" ]] || { echo "文件不存在: $FILE" >&2; exit 2; }

if [[ "$DO_EXPORT" -eq 1 ]]; then
  if [[ -z "$DRAWIO_BIN" ]]; then
    echo "未找到 draw.io 桌面 CLI(/Applications/draw.io.app 或 PATH 上的 drawio)。" >&2
    echo "请安装 draw.io Desktop: https://github.com/jgraph/drawio-desktop/releases" >&2
    exit 3
  fi
  case "$FORMAT" in png|svg|pdf) ;; *) echo "不支持的格式: $FORMAT" >&2; exit 2 ;; esac
  if [[ -z "$SCALE" ]]; then
    [[ "$FORMAT" == "png" ]] && SCALE=2 || SCALE=1
  fi
  OUT="${FILE%.drawio}.${FORMAT}"
  rm -f "$OUT"
  if ! EXPORT_LOG="$("$DRAWIO_BIN" -x -f "$FORMAT" -b 12 -s "$SCALE" -o "$OUT" "$FILE" 2>/dev/null)"; then
    echo "导出失败: draw.io CLI 退出非 0(GUI 占用时偶发,可重试)" >&2
    exit 4
  fi
  printf '%s\n' "$EXPORT_LOG" | grep -v "^\[" || true
  [[ -f "$OUT" ]] || { echo "导出失败: 未生成 $OUT(draw.io GUI 正在占用时偶发,可重试)" >&2; exit 4; }
  echo "EXPORTED: $OUT"
fi

if [[ "$DO_OPEN" -eq 1 ]]; then
  OPEN_OK=0
  if [[ "$(uname)" == "Darwin" ]]; then
    if open -a "draw.io" "$FILE" 2>/dev/null || open "$FILE" 2>/dev/null; then OPEN_OK=1; fi
  else
    if xdg-open "$FILE" >/dev/null 2>&1; then OPEN_OK=1; fi
  fi
  if [[ "$OPEN_OK" -eq 1 ]]; then
    echo "OPENED: $FILE"
  else
    echo "无法自动打开,请手动打开: $FILE" >&2
  fi
fi
