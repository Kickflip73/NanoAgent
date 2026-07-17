#!/bin/bash
# 将文章/素材保存到项目相应目录
# 用法:
#   echo "内容" | bash save-article.sh "YYYYMMDD-标题.md"                                              # 默认保存到 03-outputs/articles/
#   echo "内容" | bash save-article.sh --append "YYYYMMDD-标题.md"                                     # 追加到 03-outputs/articles/ 下已有文件
#   echo "内容" | bash save-article.sh --dir 03-outputs/reports "YYYYMMDD-标题.md"                     # 保存到 reports
#   echo "内容" | bash save-article.sh --dir 99-materials/2026Q2/<项目> "调研素材.md"                  # 调研素材(LLM 自行根据当前日期拼季度+项目)
#   echo "内容" | bash save-article.sh --dir 99-materials/2026Q2/<项目> --append "调研素材.md"         # 追加

set -eo pipefail

APPEND_MODE=false
TARGET_SUBDIR="03-outputs/articles"

# 解析参数（支持 --dir 和 --append 任意顺序）
while [ $# -gt 0 ]; do
  case "$1" in
    --append)
      APPEND_MODE=true
      shift
      ;;
    --dir)
      if [ -z "${2:-}" ]; then
        echo "错误: --dir 需要指定子目录名(如 03-outputs/articles | 03-outputs/reports | 99-materials/2026Q2/<项目>)" >&2
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
  echo "用法: echo \"内容\" | bash $0 [--dir 子目录] [--append] \"YYYYMMDD-标题.md\"" >&2
  exit 1
fi

FILENAME="$1"

# 向上查找包含 CLAUDE.md 的项目根目录
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

# 确保目标目录存在
if [ ! -d "$TARGET_DIR" ]; then
  echo "错误: 目录不存在: $TARGET_DIR" >&2
  exit 1
fi

TARGET_FILE="$TARGET_DIR/$FILENAME"

if [ "$APPEND_MODE" = true ]; then
  # 追加模式：文件必须已存在
  if [ ! -f "$TARGET_FILE" ]; then
    echo "错误: 文件不存在，无法追加: $TARGET_FILE" >&2
    echo "提示: 首次保存请不要使用 --append 参数" >&2
    exit 1
  fi
  # 追加时先加一个空行分隔
  echo "" >> "$TARGET_FILE"
  cat >> "$TARGET_FILE"
  echo "已追加: $TARGET_FILE"
else
  # 创建模式：警告覆盖
  if [ -f "$TARGET_FILE" ]; then
    echo "警告: 文件已存在，将覆盖: $TARGET_FILE" >&2
  fi
  cat > "$TARGET_FILE"
  echo "已保存: $TARGET_FILE"
fi
