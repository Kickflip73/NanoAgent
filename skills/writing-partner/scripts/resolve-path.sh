#!/bin/bash
# 解析并校验文章保存路径，输出绝对路径
# 用法:
#   bash resolve-path.sh "YYYYMMDD-标题.md"                                              # 输出 03-outputs/articles/ 下的绝对路径
#   bash resolve-path.sh --dir 03-outputs/reports "YYYYMMDD-标题.md"                     # 输出指定子目录下的绝对路径
#   bash resolve-path.sh --dir 99-materials/2026Q2/<项目> "调研素材.md"                  # 调研素材路径(LLM 自行根据当前日期拼季度+项目)
#   bash resolve-path.sh --append "YYYYMMDD-标题.md"                                     # 校验文件存在后输出路径
#   bash resolve-path.sh --dir 03-outputs/reports --append "YYYYMMDD.md"                 # 组合使用

set -eo pipefail

APPEND_MODE=false
TARGET_SUBDIR="03-outputs/articles"

while [ $# -gt 0 ]; do
  case "$1" in
    --append)
      APPEND_MODE=true
      shift
      ;;
    --dir)
      if [ -z "${2:-}" ]; then
        echo "错误: --dir 需要指定子目录名" >&2
        exit 1
      fi
      TARGET_SUBDIR="$2"
      shift 2
      ;;
    --*)
      echo "错误: 未知参数 $1" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [ $# -ne 1 ]; then
  echo "用法: bash $0 [--dir 子目录] [--append] \"YYYYMMDD-标题.md\"" >&2
  exit 1
fi

FILENAME="$1"

find_project_root() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/CLAUDE.md" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  echo "错误: 未找到项目根目录（找不到 CLAUDE.md）" >&2
  return 1
}

PROJECT_ROOT="$(find_project_root)"
TARGET_DIR="$PROJECT_ROOT/$TARGET_SUBDIR"

if [ ! -d "$TARGET_DIR" ]; then
  echo "错误: 目录不存在: $TARGET_DIR" >&2
  exit 1
fi

TARGET_FILE="$TARGET_DIR/$FILENAME"

if [ "$APPEND_MODE" = true ] && [ ! -f "$TARGET_FILE" ]; then
  echo "错误: 文件不存在，无法追加: $TARGET_FILE" >&2
  exit 1
fi

echo "$TARGET_FILE"
