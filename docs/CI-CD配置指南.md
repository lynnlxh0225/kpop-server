# CI/CD 自动部署一次性配置指南

> 配置完成后，每次 Claude push 代码到 GitHub，会自动 SSH 你的服务器跑 `./deploy.sh`，约 30 秒后线上更新。

## 配置流程总览

```
1. 生成专用 SSH 密钥（在 Mac 本机）
2. 公钥加到服务器
3. 私钥加到 GitHub Secrets
4. 推送 workflow 文件触发首次部署
```

---

## Step 1：生成专用 SSH 密钥（Mac 本机）

打开 Mac 本机终端，执行：

```bash
# 生成一对密钥，专门用于 CI/CD 自动部署
ssh-keygen -t ed25519 -f ~/.ssh/kpop-deploy -N "" -C "github-actions-kpop"
```

会生成两个文件：
- `~/.ssh/kpop-deploy` ← **私钥**（绝对不能泄露，等下放 GitHub Secrets）
- `~/.ssh/kpop-deploy.pub` ← **公钥**（要放到服务器）

---

## Step 2：把**公钥**加到服务器

```bash
# 一行命令：把公钥追加到服务器的 authorized_keys
cat ~/.ssh/kpop-deploy.pub | ssh lynn@47.93.9.199 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

会提示输 lynn 密码，输入后回车。

**验证**：

```bash
# 用新密钥测试 SSH（应该免密直接登录成功）
ssh -i ~/.ssh/kpop-deploy lynn@47.93.9.199 "echo '✅ SSH 密钥认证成功'"
```

如果看到 `✅ SSH 密钥认证成功`，配置 OK。

---

## Step 3：把**私钥**加到 GitHub Secrets

### 3.1 先在 Mac 终端显示私钥

```bash
cat ~/.ssh/kpop-deploy
```

输出形如：

```
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAAB...省略很多行...
-----END OPENSSH PRIVATE KEY-----
```

**完整复制**（包括首尾的 `-----BEGIN/END` 行）。

### 3.2 添加到 GitHub Secrets

1. 浏览器打开 [https://github.com/lynnlxh0225/kpop-server/settings/secrets/actions](https://github.com/lynnlxh0225/kpop-server/settings/secrets/actions)

2. 点 **New repository secret**，依次添加 **3 个 secret**：

   **第 1 个：**
   - Name: `SSH_HOST`
   - Secret: `47.93.9.199`
   - 点 Add secret

   **第 2 个：**
   - Name: `SSH_USER`
   - Secret: `lynn`
   - 点 Add secret

   **第 3 个：**
   - Name: `SSH_PRIVATE_KEY`
   - Secret: 粘贴整段私钥（包括 BEGIN/END 行）
   - 点 Add secret

   完成后页面应该列出 3 个 secret。⚠️ Secret 一旦保存就**无法再查看内容**（GitHub 安全策略），只能更新或删除。

---

## Step 4：推送 workflow 触发首次自动部署

回到 Mac 终端：

```bash
cd ~/code/kpop-server
git add .github/workflows/deploy.yml docs/CI-CD配置指南.md
git commit -m "ci: 加自动部署 workflow"
git push
```

push 后立即打开 [https://github.com/lynnlxh0225/kpop-server/actions](https://github.com/lynnlxh0225/kpop-server/actions)，应该看到一个正在跑的 workflow，标题就是你的 commit 信息。

点进去看实时日志，最后应该是绿色 ✅：

```
🎉 已部署到生产环境，刷新浏览器查看效果
```

---

## 之后的日常工作流

### 改功能

直接和 Claude 对话：

```
你：「加一个拍摄计划模块」
Claude：[编辑代码] [自动 commit + push]
       「已推送 commit abc1234，约 30 秒后线上更新，刷新浏览器查看」
GitHub Actions：自动执行 deploy.sh
你：30 秒后刷新 http://47.93.9.199:8080 看效果
```

### 回滚 bug

```
你：「刚才那个改动有问题，回滚」
Claude：[git revert HEAD] [push]
       「已回滚到上一版本，约 30 秒后生效」
GitHub Actions：自动部署回滚版本
```

或者：

```
你：「回到 abc1234 那个版本」
Claude：[git revert <range>] [push]
```

---

## 故障排查

### GitHub Actions 红色 ❌

打开 [Actions 页面](https://github.com/lynnlxh0225/kpop-server/actions) → 点失败那次 → 看日志最后一行。常见原因：

| 报错关键词 | 原因 | 解决 |
|----------|------|-----|
| `Permission denied (publickey)` | 公钥没加到服务器，或私钥不对 | 重新做 Step 2，验证用 Step 2 末尾的 `ssh -i` 测试 |
| `Host key verification failed` | SSH 密钥首次连接 | 在服务器删 `~/.ssh/known_hosts`，重试 |
| `Permission denied` (no public key) | SSH_USER 错或服务器拒绝 | 检查 GitHub Secret 里的 SSH_USER 是不是 `lynn` |
| `command not found: pm2` | 服务器 nvm/pm2 不在 workflow 的 PATH | 已在 deploy.yml 第 `export PATH` 行处理；如还有问题告诉 Claude |
| `./deploy.sh: Permission denied` | deploy.sh 没执行权限 | SSH 服务器 `chmod +x ~/kpop-server/deploy.sh` |
| 卡在 SSH connect 步骤超时 | 网络问题 / IP 错 | 检查 SSH_HOST=`47.93.9.199`，服务器防火墙允许 SSH |

### 想手动触发部署（不改代码）

[Actions 页面](https://github.com/lynnlxh0225/kpop-server/actions) → 左侧选 `自动部署到生产服务器` → 点 **Run workflow** → 选 main → 点 **Run workflow** 按钮。

---

## 安全说明

- ✅ 私钥**只在 GitHub Actions 临时虚拟机里使用**，跑完即销毁
- ✅ Secret 在 GitHub 服务器上**加密存储**，连 GitHub 员工都看不到
- ✅ Workflow 日志中 secret 会被自动屏蔽成 `***`
- ✅ 这个密钥**只有服务器一个权限**，泄漏了重新生成即可，影响范围有限
- ⚠️ 但仍要妥善保护本机 `~/.ssh/kpop-deploy` 文件（如果 Mac 被窃，密钥也会泄漏）

---

*文档版本：v1.0 · CI/CD 自动部署*
