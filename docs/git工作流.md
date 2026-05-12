# Git 工作流（从手动 scp 升级到 GitHub）

> 本文档面向"非开发者"，每一步都是可复制粘贴的命令。
>
> 核心思路：**代码以 GitHub 为准；服务器只读拉取；密钥和数据库不进仓库。**

## 阶段总览

```
阶段 1：本机初始化（5 分钟）
   把现有 outputs 里的代码推到 GitHub 私有仓库

阶段 2：服务器迁移（10 分钟）
   生成 SSH 密钥 → 加到 GitHub → 克隆仓库到服务器
   迁移 .env、data/ 到新位置

阶段 3：日常工作流
   Claude 改代码 → 你 commit + push → 服务器 ./deploy.sh
```

---

## 阶段 1：本机初始化

### 1.1 在本机选一个位置放代码仓库

打开 **Mac 终端**（本机，不是 SSH）：

```bash
# 建议放这里，方便找
mkdir -p ~/code
cd ~/code
```

### 1.2 克隆 GitHub 仓库（空仓库）

> 你已经在 GitHub 建好私有仓库了。假设它叫 `kpop-server`，用户名 `lynnlxh`，下面命令请用你实际的替换。

```bash
git clone git@github.com:lynnlxh0225/kpop-server.git
cd kpop-server
```

⚠️ 如果第一次用 SSH 推送/克隆，需要先把本机 SSH 公钥加到 GitHub。如果没配过，临时用 HTTPS：

```bash
git clone https://github.com/lynnlxh0225/kpop-server.git
```

之后再补 SSH 配置。

### 1.3 把现有 v2 代码拷进仓库

```bash
# 从 Claude outputs 复制所有文件进当前仓库（注意末尾的 / 和 .）
cp -R "/Users/didi/Library/Application Support/Claude/local-agent-mode-sessions/eee5bdf3-af79-4797-92f7-2a46ee362e5a/90dbe772-2687-42da-95c2-4f311956d6d4/local_a1aaf578-c8db-4626-aa9f-a8c3128ad89d/outputs/kpop-server-v2/." .

# 验证文件齐全
ls -la
```

应该看到：

```
README.md
deploy.sh
ecosystem.config.cjs
package.json
public/
docs/
.env.example
.gitignore
server.js
```

### 1.4 让 deploy.sh 可执行 + 第一次提交

```bash
chmod +x deploy.sh

git add .
git commit -m "feat: initial v2 commit (好友+车主模型)"
git push origin main
```

> 第一次 push 如果报错说 `master` 不存在，把 `main` 换成 `master`，或先建分支：`git branch -M main`。

打开浏览器，刷新 GitHub 仓库页面，应该看到你的所有代码了。

---

## 阶段 2：服务器迁移到 Git 拉取模式

### 2.1 服务器生成 SSH 密钥

SSH 登录服务器：

```bash
ssh lynn@47.93.9.199
```

生成密钥（如果还没有）：

```bash
# 一路回车，不设密码方便自动化
ssh-keygen -t ed25519 -C "lynn@kpop-server" -f ~/.ssh/id_ed25519 -N ""

# 显示公钥（复制下面输出的完整内容）
cat ~/.ssh/id_ed25519.pub
```

输出形如：

```
ssh-ed25519 AAAAC3Nz...省略...== lynn@kpop-server
```

### 2.2 把公钥加到 GitHub

1. 打开 [GitHub → Settings → SSH and GPG keys](https://github.com/settings/keys)
2. 点 **New SSH key**
3. Title 填 `阿里云北京服务器`
4. Key type 选 `Authentication Key`
5. Key 框里**整段粘贴**上一步输出的公钥
6. 点 **Add SSH key**

### 2.3 服务器测试 SSH 连接 GitHub

```bash
ssh -T git@github.com
# 第一次会问 yes/no，输入 yes
# 成功会看到：Hi lynnlxh! You've successfully authenticated...
```

### 2.4 把现有 kpop-server 目录迁移成 Git 仓库

⚠️ **这一步很关键**：服务器上现在的 `~/kpop-server/` 是从 scp 上来的散文件。我们需要把它"变成"一个 git 工作目录，同时**保留** `.env` 和 `data/`。

最安全的做法：备份 → 重新克隆 → 还原私密文件。

```bash
cd ~

# 1) 停服务
pm2 stop kpop-server

# 2) 备份关键文件
mkdir -p ~/secrets-backup
cp ~/kpop-server/.env ~/secrets-backup/.env
cp -R ~/kpop-server/data ~/secrets-backup/data

# 3) 备份整个旧目录（万一）
mv ~/kpop-server ~/kpop-server-old-$(date +%Y%m%d)

# 4) 从 GitHub 克隆全新仓库
git clone git@github.com:lynnlxh0225/kpop-server.git ~/kpop-server

# 5) 进入新目录，还原私密文件
cd ~/kpop-server
cp ~/secrets-backup/.env .env
cp -R ~/secrets-backup/data data

# 6) 安装依赖
npm install --omit=dev

# 7) 创建日志目录
mkdir -p logs

# 8) 让 deploy.sh 可执行
chmod +x deploy.sh

# 9) 重新启动 PM2
pm2 delete kpop-server 2>/dev/null
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs kpop-server --lines 10 --nostream
```

应该看到 `🚀 K-pop server v2 running`。浏览器刷新一下 `http://47.93.9.199:8080` 验证一切正常。

### 2.5 确认无误后清理备份（可选）

跑 1-2 天没问题后再清：

```bash
rm -rf ~/kpop-server-old-*
# secrets-backup 可以多留一段时间作为安全网
```

---

## 阶段 3：日常工作流

### 3.1 Claude 改代码后，你怎么把代码同步到 GitHub

**Claude 直接写到你本地仓库**（最简单）：

> 你授权 Claude 访问 `~/code/kpop-server/` 这个目录后，Claude 改代码就直接改在你本地仓库里。你只需要：

```bash
cd ~/code/kpop-server

# 看看 Claude 改了哪些文件
git status

# 看看具体改了什么
git diff

# 提交并推送
git add .
git commit -m "feat: 加上拍摄计划模块"
git push
```

### 3.2 服务器一键更新

```bash
ssh lynn@47.93.9.199
cd ~/kpop-server
./deploy.sh
```

`deploy.sh` 做的事：
1. `git pull --rebase` 拉最新代码
2. `npm install --omit=dev` 装新依赖（如果有）
3. `pm2 restart kpop-server` 重启服务
4. 显示 `pm2 list` 当前状态

约 5-10 秒完成。

### 3.3 想看服务器实时日志

```bash
pm2 logs kpop-server
# Ctrl+C 退出
```

### 3.4 改坏了想回滚到上一版

```bash
# 在服务器
cd ~/kpop-server
git log --oneline | head -5     # 看最近 5 条提交
git reset --hard HEAD~1          # 回滚到上一条
pm2 restart kpop-server
```

或者更安全的做法（不动 GitHub）：

```bash
git checkout <旧commit的hash>
pm2 restart kpop-server
# 验证 OK 后再决定要不要把 main 也回滚
```

---

## 提交规范（可选，但推荐）

为了 commit history 清晰，建议用 [Conventional Commits](https://www.conventionalcommits.org/) 简化版：

- `feat: 加好友页面` — 新功能
- `fix: 复制按钮在 HTTP 下失效` — 修 bug
- `docs: 更新部署指南` — 文档
- `style: 调登录页颜色` — 仅样式
- `refactor: 拆分 server.js` — 代码重构
- `chore: 升级 express 版本` — 杂项

---

## 安全检查清单

每次 commit 前问自己：

- [ ] 我有没有把 `.env` 不小心加进去？运行 `git status` 看看 staged 文件
- [ ] 有没有 `data/data.db` 出现在 status 里？（应该被 .gitignore 拦住）
- [ ] commit message 里有没有写出密码 / 邮箱密码 / Token？

如果不小心 push 了密钥：**立即在 GitHub 把 token / SSH 密钥失效**，然后改本地代码删掉，重新 push。

---

## 故障排查

### `git push` 报 `Permission denied (publickey)`
本机 SSH 密钥没加到 GitHub。在本机执行：
```bash
cat ~/.ssh/id_ed25519.pub   # 没有就 ssh-keygen 生成
# 输出整段加到 GitHub Settings → SSH keys
```

### 服务器 `git pull` 报错冲突
说明服务器本地有未提交修改。先看看是不是误改了：
```bash
git status
git diff
```
- 如果是误改：`git stash` 暂存 / `git checkout -- .` 丢弃
- 如果是有意改的（不该）：把改动复制到本地仓库重新 commit

### `./deploy.sh` 报 `Permission denied`
```bash
chmod +x ~/kpop-server/deploy.sh
```

### `git pull` 时被问账号密码
说明用了 HTTPS clone 而不是 SSH。改成 SSH：
```bash
cd ~/kpop-server
git remote set-url origin git@github.com:lynnlxh0225/kpop-server.git
```

---

## 进阶（以后再说）

- **GitHub Actions 自动部署**：push 后自动 SSH 服务器执行 deploy.sh（需要配 Secrets）
- **多环境**：`main` 分支 → 生产；`dev` 分支 → 测试服务器
- **自动备份**：cron 每天把 `data/data.db` 上传到 GitHub Release 或 OSS
- **健康检查 / 监控**：UptimeRobot + 告警

需要哪一项时告诉 Claude，给你单独的实施步骤。

---

*文档版本：v1.0 · Git 工作流*
