#!/bin/bash
# auto-push.sh — 监听本地仓库变化，自动 commit + push
# 用法：./auto-push.sh
# 停止：Ctrl+C

set -u

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DEBOUNCE_SEC=3       # 文件停止变化后等几秒再 push（避免抓到半改完的状态）
POLL_INTERVAL=2      # 每隔几秒检查一次

# 颜色
G='\033[0;32m'
Y='\033[1;33m'
R='\033[0;31m'
B='\033[0;34m'
NC='\033[0m'

cd "$REPO_DIR"

if [[ ! -d ".git" ]]; then
  echo -e "${R}❌ 当前目录不是 git 仓库${NC}"
  exit 1
fi

echo -e "${G}🤖 K-pop 自动 push 监听已启动${NC}"
echo -e "${B}监听目录：${NC}$REPO_DIR"
echo -e "${B}防抖间隔：${NC}${DEBOUNCE_SEC}s · ${B}轮询间隔：${NC}${POLL_INTERVAL}s"
echo -e "${Y}停止：Ctrl+C${NC}"
echo ""

# trap Ctrl+C
trap 'echo ""; echo -e "${Y}👋 监听已停止${NC}"; exit 0' INT

while true; do
  # 1) 看有没有未提交的变化
  changes="$(git status --porcelain 2>/dev/null)"

  if [[ -z "$changes" ]]; then
    # 没变化，继续等
    sleep "$POLL_INTERVAL"
    continue
  fi

  # 2) 找最近 DEBOUNCE_SEC 秒内是否还有文件被修改
  recent_file=$(find . -type f \
    -not -path "./.git/*" \
    -not -path "./node_modules/*" \
    -not -path "./data/*" \
    -not -path "./logs/*" \
    -not -path "./.DS_Store" \
    -newermt "$(date -v-${DEBOUNCE_SEC}S '+%Y-%m-%d %H:%M:%S')" \
    -print -quit 2>/dev/null)

  if [[ -n "$recent_file" ]]; then
    # 最近还有改动，继续等
    sleep "$POLL_INTERVAL"
    continue
  fi

  # 3) 文件稳定了，开始 push
  echo -e "${B}─────────────────────────────────────────${NC}"
  echo -e "${G}🚀 检测到稳定的改动，开始 push  $(date '+%H:%M:%S')${NC}"
  echo -e "${Y}变更文件：${NC}"
  echo "$changes" | sed 's/^/  /'
  echo ""

  msg="auto: Claude 更新 $(date '+%H:%M:%S')"

  if git add . && git commit -m "$msg" >/dev/null 2>&1; then
    if git push 2>&1 | sed 's/^/  /'; then
      echo -e "${G}✅ Push 成功${NC}"
      echo -e "${B}💡 GitHub Actions 自动部署中，约 30 秒后刷新浏览器查看效果${NC}"
    else
      echo -e "${R}❌ Push 失败，下个循环会重试${NC}"
    fi
  else
    echo -e "${Y}（git commit 没有要提交的内容，可能是 .gitignore 全部过滤了）${NC}"
  fi
  echo ""

  sleep "$POLL_INTERVAL"
done
