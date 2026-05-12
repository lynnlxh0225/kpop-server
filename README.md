# K-pop 随舞管理器

集中管理 K-pop 随舞活动：歌曲、队伍、排练、路演，告别微信群信息漏接。

> 私有项目 · 用于和朋友们一起管理跳舞活动 · 当前版本 v2（好友 + 车主模型）

## 在线访问

- 临时地址：`http://47.93.9.199:8080`
- 正式域名（备案完成后）：`https://special-lifejourney.com`

## 技术栈

- **后端**：Node.js + Express + better-sqlite3 + JWT
- **前端**：原生 HTML/CSS/JS（单文件 SPA）
- **部署**：Nginx 反向代理 + PM2 进程管理
- **数据库**：SQLite（单文件，零运维）

## 本地开发

```bash
# 克隆仓库
git clone git@github.com:lynnlxh0225/kpop-server.git
cd kpop-server

# 安装依赖
npm install

# 复制环境变量模板
cp .env.example .env
# 编辑 .env，设置 JWT_SECRET 等

# 启动
node server.js
# 访问 http://localhost:3000，nginx 没配的话需要前端单独打开 public/index.html
```

## 服务器部署

第一次部署见 `docs/v2部署指南.md`。后续更新只需要：

```bash
# 本地：改完代码 push 到 GitHub
git add . && git commit -m "..." && git push

# 服务器：一键拉取并重启
ssh lynn@47.93.9.199
cd ~/kpop-server
./deploy.sh
```

## 仓库结构

```
.
├── server.js                 # 后端服务（单文件）
├── public/index.html         # 前端 SPA（单文件）
├── package.json              # 依赖清单
├── ecosystem.config.cjs      # PM2 配置
├── deploy.sh                 # 服务器一键部署脚本
├── .env.example              # 环境变量模板
└── docs/                     # 设计 + 部署文档
```

## API 速览

| 模块 | 端点 |
|------|------|
| 认证 | `POST /api/auth/register` `POST /api/auth/login` `GET /api/auth/me` |
| 好友 | `GET /api/friends` `POST /api/friend-requests` `POST /api/friend-requests/:id/accept` |
| 歌曲 | `GET /api/songs` `POST /api/songs` `PATCH /api/songs/:id` |
| 排练 | `POST /api/songs/:sid/rehearsals` `PUT /api/rehearsals/:id/my-attendance` |
| 路演 | `POST /api/songs/:sid/performances` `PUT /api/performances/:id/my-attendance` |

完整 28 个端点见 `server.js`。

## 数据模型

- **users**：用户表，每人一个邀请码
- **friendships**：好友关系（双向）
- **friend_requests**：好友申请
- **songs**：歌曲（每首有一个车主 `owner_id`）
- **song_members**：成员位置 + 状态（active/left）
- **rehearsals / performances**：排练 / 路演
- **rehearsal_attendance / performance_attendance**：出席状态

## 许可

私有项目，不对外开放。
