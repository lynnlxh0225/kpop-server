#!/bin/bash
# auto-push.sh — 监听本地仓库变化，自动 commit + push
# 用法：./auto-push.sh
# 停止：Ctrl+C
#
# v2 变化：
#  - 修了「push 失败仍显示成功」的管道 bug（看的是 sed 的退出码而不是 git push）
#  - 每轮先检查本地有没有未推的 commit (ahead of origin)，有就先 push，
#    这样网络抽风时遗留的 commit 之后会被自动追上，不用手动 git push

set -u

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DEBOUNCE_SEC=3       # 文件停止变化后等几秒再 commit（避免抓到半改完的状态）
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

# 执行 git push 并真实捕获退出码（管道里 sed 不再吞错）
# 返回 0=成功 / 非 0=失败
do_push() {
  local out rc
  # PIPESTATUS[0] 是管道里第一个命令（git push）的退出码
  out="$(git push 2>&1)"
  rc=$?
  echo "$out" | sed 's/^/  /'
  return $rc
}

while true; do
  # === 0) 优先尝试把"已 commit 但还没推"的提交追上去 ===
  # @{u} = upstream（默认 origin/main）。如果没设 upstream，count 会报错，2>/dev/null 屏掉
  ahead=$(git rev-list --count @{u}..HEAD 2>/dev/null || echo "0")
  if [[ "$ahead" =~ ^[0-9]+$ ]] && [[ "$ahead" -gt 0 ]]; then
    echo -e "${B}─────────────────────────────────────────${NC}"
    echo -e "${Y}📤 检测到 ${ahead} 个未推的 commit，先把它们推上去  $(date '+%H:%M:%S')${NC}"
    if do_push; then
      echo -e "${G}✅ 追赶 push 成功${NC}"
    else
      echo -e "${R}❌ 追赶 push 失败，下个循环再重试${NC}"
    fi
    echo ""
    sleep "$POLL_INTERVAL"
    continue
  fi

  # === 1) 看有没有未提交的工作区变化 ===
  changes="$(git status --porcelain 2>/dev/null)"
  if [[ -z "$changes" ]]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  # === 2) 防抖：最近 DEBOUNCE_SEC 秒内还有文件被修改就再等等 ===
  recent_file=$(find . -type f \
    -not -path "./.git/*" \
    -not -path "./node_modules/*" \
    -not -path "./data/*" \
    -not -path "./logs/*" \
    -not -path "./.DS_Store" \
    -newermt "$(date -v-${DEBOUNCE_SEC}S '+%Y-%m-%d %H:%M:%S')" \
    -print -quit 2>/dev/null)

  if [[ -n "$recent_file" ]]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  # === 3) 文件稳定了，commit + push ===
  echo -e "${B}─────────────────────────────────────────${NC}"
  echo -e "${G}🚀 检测到稳定的改动，开始 push  $(date '+%H:%M:%S')${NC}"
  echo -e "${Y}变更文件：${NC}"
  echo "$changes" | sed 's/^/  /'
  echo ""

  msg="auto: Claude 更新 $(date '+%H:%M:%S')"

  if git add . && git commit -m "$msg" >/dev/null 2>&1; then
    if do_push; then
      echo -e "${G}✅ Push 成功${NC}"
      echo -e "${B}💡 GitHub Actions 自动部署中，约 30 秒后刷新浏览器查看效果${NC}"
    else
      echo -e "${R}❌ Push 失败（commit 已留在本地，下个循环会自动追赶）${NC}"
    fi
  else
    echo -e "${Y}（git commit 没有要提交的内容，可能是 .gitignore 全部过滤了）${NC}"
  fi
  echo ""

  sleep "$POLL_INTERVAL"
done
