#!/bin/bash
# K-pop 服务器一键部署脚本
# 用法：./deploy.sh
# 干什么：git pull → npm install → pm2 restart

set -e   # 任何一步出错就立刻退出

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}🔄 拉取最新代码...${NC}"
git pull --rebase

echo -e "${YELLOW}📦 检查依赖（如有新增会自动安装）...${NC}"
npm install --omit=dev

echo -e "${YELLOW}🚀 重启 PM2 服务...${NC}"
pm2 restart kpop-server --update-env

echo -e "${YELLOW}📊 服务状态：${NC}"
pm2 list

echo -e "${GREEN}✅ 部署完成${NC}"
echo -e "${YELLOW}查看日志：${NC}pm2 logs kpop-server"
