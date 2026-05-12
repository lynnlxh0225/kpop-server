/**
 * K-pop 随舞管理器 后端 v2
 * 数据模型：好友 + 车主
 *
 * - 每个用户独立账号 + 邀请码
 * - 通过邀请链接注册：自动成为好友
 * - 已注册用户输入对方邀请码：发起好友申请，对方接受
 * - 歌曲有「车主」（创建者），只有车主能改歌曲/排练/路演信息
 * - 车主从自己的好友里挑成员加入歌曲
 * - 成员可以主动退出（保留历史出席记录，无法修改）
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");

const PORT = parseInt(process.env.PORT || "3000", 10);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const DB_PATH = process.env.DB_PATH || "./data/data.db";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

if (JWT_SECRET === "dev-only-change-me") {
  console.warn("⚠️  请在 .env 改 JWT_SECRET");
}

// ==================== 数据库 ====================
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT DEFAULT '👤',
    invite_code TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS friendships (
    user_a_id INTEGER NOT NULL,
    user_b_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_a_id, user_b_id),
    FOREIGN KEY (user_a_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (user_b_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (user_a_id < user_b_id)
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL,
    to_user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    message TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    responded_at INTEGER,
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_friend_req_to ON friend_requests(to_user_id, status);

  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    artist TEXT DEFAULT '',
    type TEXT DEFAULT 'new',
    notes TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS song_members (
    song_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    position TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    PRIMARY KEY (song_id, user_id),
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rehearsals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    time TEXT DEFAULT '',
    location TEXT DEFAULT '',
    outfit TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rehearsal_attendance (
    rehearsal_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'maybe',
    PRIMARY KEY (rehearsal_id, user_id),
    FOREIGN KEY (rehearsal_id) REFERENCES rehearsals(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS performances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    city TEXT DEFAULT '',
    date TEXT NOT NULL,
    time TEXT DEFAULT '',
    location TEXT DEFAULT '',
    outfit TEXT DEFAULT '',
    status TEXT DEFAULT 'planned',
    notes TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS performance_attendance (
    performance_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'maybe',
    PRIMARY KEY (performance_id, user_id),
    FOREIGN KEY (performance_id) REFERENCES performances(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);
console.log("✅ 数据库初始化完毕");

// ==================== 工具函数 ====================
function genCode(len = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function genUniqueInviteCode() {
  for (let i = 0; i < 10; i++) {
    const c = genCode(8);
    if (!db.prepare("SELECT 1 FROM users WHERE invite_code=?").get(c)) return c;
  }
  return genCode(10);
}
function now() { return Date.now(); }
function sign(uid) { return jwt.sign({ uid }, JWT_SECRET, { expiresIn: "30d" }); }
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, avatar: u.avatar };
}
function fullUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, avatar: u.avatar, invite_code: u.invite_code, created_at: u.created_at };
}
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || ""); }

function areFriends(uidA, uidB) {
  if (uidA === uidB) return false;
  const [a, b] = uidA < uidB ? [uidA, uidB] : [uidB, uidA];
  return !!db.prepare("SELECT 1 FROM friendships WHERE user_a_id=? AND user_b_id=?").get(a, b);
}
function addFriendship(uidA, uidB) {
  if (uidA === uidB) return;
  const [a, b] = uidA < uidB ? [uidA, uidB] : [uidB, uidA];
  try {
    db.prepare("INSERT INTO friendships (user_a_id, user_b_id, created_at) VALUES (?, ?, ?)")
      .run(a, b, now());
  } catch (e) {
    // duplicate -> 已是好友，忽略
  }
}
function removeFriendship(uidA, uidB) {
  const [a, b] = uidA < uidB ? [uidA, uidB] : [uidB, uidA];
  db.prepare("DELETE FROM friendships WHERE user_a_id=? AND user_b_id=?").run(a, b);
}

/** 用户是否能"看到"歌曲（车主、active成员、left成员）*/
function songAccess(songId, userId) {
  const song = db.prepare("SELECT * FROM songs WHERE id=?").get(songId);
  if (!song) return null;
  if (song.owner_id === userId) return { song, role: "owner" };
  const m = db.prepare("SELECT * FROM song_members WHERE song_id=? AND user_id=?").get(songId, userId);
  if (m) return { song, role: m.status === "active" ? "member" : "left" };
  return null;
}

// ==================== Express ====================
const app = express();
// nginx 反向代理在前面，信任 X-Forwarded-For（让 rate-limit 拿到真实 IP）
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: CORS_ORIGIN }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: "请求过于频繁" } });

function authRequired(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "未登录" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch {
    return res.status(401).json({ error: "登录已过期" });
  }
}

// ==================== 健康检查 ====================
app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ==================== 认证 ====================
app.post("/api/auth/register", authLimiter, (req, res) => {
  const { email, password, name, avatar, inviteCode } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: "邮箱格式不正确" });
  if (!password || password.length < 6) return res.status(400).json({ error: "密码至少 6 位" });
  if (!name || !name.trim()) return res.status(400).json({ error: "请填写昵称" });

  // 邀请码校验（可选）
  let inviter = null;
  if (inviteCode && inviteCode.trim()) {
    inviter = db.prepare("SELECT * FROM users WHERE invite_code=?").get(inviteCode.trim().toUpperCase());
    if (!inviter) return res.status(400).json({ error: "邀请码无效" });
  }

  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) {
    return res.status(409).json({ error: "邮箱已被注册" });
  }

  const pwHash = bcrypt.hashSync(password, 10);
  const myInvite = genUniqueInviteCode();
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, name, avatar, invite_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(email, pwHash, name.trim(), avatar || "👤", myInvite, now());
  const userId = result.lastInsertRowid;

  // 通过邀请链接注册 → 自动成为好友
  if (inviter) addFriendship(userId, inviter.id);

  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  res.json({
    token: sign(userId),
    user: fullUser(user),
    autoFriend: inviter ? publicUser(inviter) : null,
  });
});

app.post("/api/auth/login", authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "请填写邮箱和密码" });
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "邮箱或密码错误" });
  }
  res.json({ token: sign(user.id), user: fullUser(user) });
});

app.get("/api/auth/me", authRequired, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  res.json({ user: fullUser(user) });
});

app.patch("/api/auth/me", authRequired, (req, res) => {
  const { name, avatar } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.userId);
  const newName = (name || user.name).toString().trim();
  const newAvatar = avatar || user.avatar;
  db.prepare("UPDATE users SET name=?, avatar=? WHERE id=?").run(newName, newAvatar, req.userId);
  const u2 = db.prepare("SELECT * FROM users WHERE id=?").get(req.userId);
  res.json({ user: fullUser(u2) });
});

app.post("/api/auth/regenerate-invite", authRequired, (req, res) => {
  const code = genUniqueInviteCode();
  db.prepare("UPDATE users SET invite_code=? WHERE id=?").run(code, req.userId);
  res.json({ invite_code: code });
});

// ==================== 好友 ====================
app.get("/api/friends", authRequired, (req, res) => {
  const friends = db.prepare(`
    SELECT u.id, u.name, u.avatar, f.created_at AS friended_at
    FROM friendships f
    JOIN users u ON u.id = (CASE WHEN f.user_a_id=? THEN f.user_b_id ELSE f.user_a_id END)
    WHERE f.user_a_id=? OR f.user_b_id=?
    ORDER BY f.created_at DESC
  `).all(req.userId, req.userId, req.userId);
  res.json({ friends });
});

app.delete("/api/friends/:userId", authRequired, (req, res) => {
  const otherId = parseInt(req.params.userId, 10);
  if (!otherId) return res.status(400).json({ error: "参数错误" });
  removeFriendship(req.userId, otherId);
  res.json({ ok: true });
});

// 获取好友申请：incoming（待我处理） + outgoing（我发出的待对方处理）
app.get("/api/friend-requests", authRequired, (req, res) => {
  const incoming = db.prepare(`
    SELECT fr.*, u.name AS from_name, u.avatar AS from_avatar
    FROM friend_requests fr
    JOIN users u ON u.id = fr.from_user_id
    WHERE fr.to_user_id=? AND fr.status='pending'
    ORDER BY fr.created_at DESC
  `).all(req.userId);
  const outgoing = db.prepare(`
    SELECT fr.*, u.name AS to_name, u.avatar AS to_avatar
    FROM friend_requests fr
    JOIN users u ON u.id = fr.to_user_id
    WHERE fr.from_user_id=? AND fr.status='pending'
    ORDER BY fr.created_at DESC
  `).all(req.userId);
  res.json({ incoming, outgoing });
});

// 用对方邀请码发起好友申请
app.post("/api/friend-requests", authRequired, (req, res) => {
  const { code, message } = req.body || {};
  if (!code) return res.status(400).json({ error: "请填写邀请码" });
  const target = db.prepare("SELECT * FROM users WHERE invite_code=?").get(code.trim().toUpperCase());
  if (!target) return res.status(404).json({ error: "邀请码无效" });
  if (target.id === req.userId) return res.status(400).json({ error: "不能添加自己" });
  if (areFriends(req.userId, target.id)) return res.status(409).json({ error: "你们已经是好友了" });
  // 已有 pending 请求？
  const existing = db.prepare(`
    SELECT * FROM friend_requests
    WHERE from_user_id=? AND to_user_id=? AND status='pending'
  `).get(req.userId, target.id);
  if (existing) return res.status(409).json({ error: "已发送过申请，等待对方处理" });
  // 对方先发过来，反向 pending？直接接受变成好友
  const reverse = db.prepare(`
    SELECT * FROM friend_requests
    WHERE from_user_id=? AND to_user_id=? AND status='pending'
  `).get(target.id, req.userId);
  if (reverse) {
    db.prepare("UPDATE friend_requests SET status='accepted', responded_at=? WHERE id=?")
      .run(now(), reverse.id);
    addFriendship(req.userId, target.id);
    return res.json({ accepted: true, friend: publicUser(target) });
  }
  db.prepare(`
    INSERT INTO friend_requests (from_user_id, to_user_id, status, message, created_at)
    VALUES (?, ?, 'pending', ?, ?)
  `).run(req.userId, target.id, (message || "").toString().slice(0, 200), now());
  res.json({ sent: true, target: publicUser(target) });
});

app.post("/api/friend-requests/:id/accept", authRequired, (req, res) => {
  const reqId = parseInt(req.params.id, 10);
  const r = db.prepare("SELECT * FROM friend_requests WHERE id=?").get(reqId);
  if (!r) return res.status(404).json({ error: "申请不存在" });
  if (r.to_user_id !== req.userId) return res.status(403).json({ error: "无权操作" });
  if (r.status !== "pending") return res.status(400).json({ error: "申请已处理" });
  db.prepare("UPDATE friend_requests SET status='accepted', responded_at=? WHERE id=?")
    .run(now(), reqId);
  addFriendship(r.from_user_id, r.to_user_id);
  res.json({ ok: true });
});

app.post("/api/friend-requests/:id/reject", authRequired, (req, res) => {
  const reqId = parseInt(req.params.id, 10);
  const r = db.prepare("SELECT * FROM friend_requests WHERE id=?").get(reqId);
  if (!r) return res.status(404).json({ error: "申请不存在" });
  if (r.to_user_id !== req.userId) return res.status(403).json({ error: "无权操作" });
  if (r.status !== "pending") return res.status(400).json({ error: "申请已处理" });
  db.prepare("UPDATE friend_requests SET status='rejected', responded_at=? WHERE id=?")
    .run(now(), reqId);
  res.json({ ok: true });
});

// 用邀请码查询用户信息（用于显示对方信息）
app.get("/api/users/by-code/:code", authRequired, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE invite_code=?").get(req.params.code.toUpperCase());
  if (!u) return res.status(404).json({ error: "邀请码无效" });
  res.json({ user: publicUser(u) });
});

// ==================== 歌曲 ====================
// 我能看到的所有歌曲（车主 + active 成员 + left 成员）
app.get("/api/songs", authRequired, (req, res) => {
  const songs = db.prepare(`
    SELECT s.*,
      CASE WHEN s.owner_id=? THEN 'owner'
           WHEN sm.status='active' THEN 'member'
           WHEN sm.status='left' THEN 'left'
      END AS my_role
    FROM songs s
    LEFT JOIN song_members sm ON sm.song_id=s.id AND sm.user_id=?
    WHERE s.owner_id=? OR sm.user_id=?
    ORDER BY s.created_at DESC
  `).all(req.userId, req.userId, req.userId, req.userId);

  // 给每首歌附加队伍 / 排练 / 路演 简要信息
  for (const s of songs) {
    s.owner = publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(s.owner_id));
    s.team = db.prepare(`
      SELECT sm.user_id, sm.position, sm.status, sm.joined_at, sm.left_at,
             u.name, u.avatar
      FROM song_members sm
      JOIN users u ON u.id = sm.user_id
      WHERE sm.song_id=?
      ORDER BY sm.joined_at ASC
    `).all(s.id);
    s.rehearsals = db.prepare("SELECT * FROM rehearsals WHERE song_id=? ORDER BY date ASC").all(s.id);
    for (const r of s.rehearsals) {
      r.attendance = db.prepare(`
        SELECT ra.user_id, ra.status, u.name, u.avatar
        FROM rehearsal_attendance ra
        JOIN users u ON u.id = ra.user_id
        WHERE ra.rehearsal_id=?
      `).all(r.id);
    }
    s.performances = db.prepare("SELECT * FROM performances WHERE song_id=? ORDER BY date ASC").all(s.id);
    for (const p of s.performances) {
      p.attendance = db.prepare(`
        SELECT pa.user_id, pa.status, u.name, u.avatar
        FROM performance_attendance pa
        JOIN users u ON u.id = pa.user_id
        WHERE pa.performance_id=?
      `).all(p.id);
    }
  }
  res.json({ songs });
});

app.post("/api/songs", authRequired, (req, res) => {
  const { title, artist, type, notes } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "请填写歌曲名" });
  const r = db.prepare(`
    INSERT INTO songs (owner_id, title, artist, type, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.userId, title.trim(), artist || "", type || "new", notes || "", now());
  // 车主默认也是成员之一（未填位置），方便后续设置
  db.prepare(`
    INSERT INTO song_members (song_id, user_id, position, status, joined_at)
    VALUES (?, ?, '', 'active', ?)
  `).run(r.lastInsertRowid, req.userId, now());
  const song = db.prepare("SELECT * FROM songs WHERE id=?").get(r.lastInsertRowid);
  res.json({ song });
});

// 修改歌曲基本信息（仅车主）
app.patch("/api/songs/:id", authRequired, (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(songId);
  if (!s) return res.status(404).json({ error: "歌曲不存在" });
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可修改" });
  const { title, artist, type, notes } = req.body || {};
  db.prepare("UPDATE songs SET title=?, artist=?, type=?, notes=? WHERE id=?").run(
    title !== undefined ? title : s.title,
    artist !== undefined ? artist : s.artist,
    type !== undefined ? type : s.type,
    notes !== undefined ? notes : s.notes,
    songId
  );
  res.json({ ok: true });
});

// 删除歌曲（仅车主）
app.delete("/api/songs/:id", authRequired, (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(songId);
  if (!s) return res.status(404).json({ error: "歌曲不存在" });
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可删除" });
  db.prepare("DELETE FROM songs WHERE id=?").run(songId);
  res.json({ ok: true });
});

// 添加成员（仅车主，且必须是车主的好友）
app.post("/api/songs/:id/members", authRequired, (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(songId);
  if (!s) return res.status(404).json({ error: "歌曲不存在" });
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可添加成员" });
  const { user_id, position } = req.body || {};
  const targetId = parseInt(user_id, 10);
  if (!targetId) return res.status(400).json({ error: "参数错误" });
  if (targetId === req.userId) return res.status(400).json({ error: "车主已是成员" });
  if (!areFriends(req.userId, targetId)) return res.status(403).json({ error: "对方不是你的好友" });
  // 是否已是成员？
  const existing = db.prepare("SELECT * FROM song_members WHERE song_id=? AND user_id=?").get(songId, targetId);
  if (existing && existing.status === "active") return res.status(409).json({ error: "对方已是成员" });
  if (existing && existing.status === "left") {
    // 重新加入：把 left 改回 active
    db.prepare("UPDATE song_members SET status='active', position=?, joined_at=?, left_at=NULL WHERE song_id=? AND user_id=?")
      .run(position || "", now(), songId, targetId);
  } else {
    db.prepare(`INSERT INTO song_members (song_id, user_id, position, status, joined_at) VALUES (?, ?, ?, 'active', ?)`)
      .run(songId, targetId, position || "", now());
  }
  res.json({ ok: true });
});

// 修改成员位置（仅车主）
app.put("/api/songs/:id/members/:uid/position", authRequired, (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const uid = parseInt(req.params.uid, 10);
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(songId);
  if (!s) return res.status(404).json({ error: "歌曲不存在" });
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可修改" });
  const { position } = req.body || {};
  const r = db.prepare("UPDATE song_members SET position=? WHERE song_id=? AND user_id=? AND status='active'")
    .run(position || "", songId, uid);
  if (r.changes === 0) return res.status(404).json({ error: "成员不存在" });
  res.json({ ok: true });
});

// 移除成员：车主可移除任何人；本人可自己退出。被移除/退出 = status -> left
app.delete("/api/songs/:id/members/:uid", authRequired, (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const uid = parseInt(req.params.uid, 10);
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(songId);
  if (!s) return res.status(404).json({ error: "歌曲不存在" });
  if (uid === s.owner_id) return res.status(400).json({ error: "车主不能离开自己的歌曲" });
  const canRemove = req.userId === s.owner_id || req.userId === uid;
  if (!canRemove) return res.status(403).json({ error: "无权操作" });
  const r = db.prepare("UPDATE song_members SET status='left', left_at=? WHERE song_id=? AND user_id=? AND status='active'")
    .run(now(), songId, uid);
  if (r.changes === 0) return res.status(404).json({ error: "成员不在歌曲中" });
  res.json({ ok: true });
});

// ==================== 排练 ====================
function getSongOrFail(req, res) {
  const songId = parseInt(req.params.sid || req.params.id, 10);
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(songId);
  if (!s) { res.status(404).json({ error: "歌曲不存在" }); return null; }
  return s;
}

app.post("/api/songs/:sid/rehearsals", authRequired, (req, res) => {
  const s = getSongOrFail(req, res); if (!s) return;
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可添加排练" });
  const { date, time, location, outfit, notes, attendance } = req.body || {};
  if (!date) return res.status(400).json({ error: "请填写日期" });
  const r = db.prepare(`
    INSERT INTO rehearsals (song_id, date, time, location, outfit, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(s.id, date, time || "", location || "", outfit || "", notes || "", now());
  saveAttendance("rehearsal", r.lastInsertRowid, attendance || [], s.id);
  res.json({ id: r.lastInsertRowid });
});

app.patch("/api/rehearsals/:id", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare("SELECT * FROM rehearsals WHERE id=?").get(id);
  if (!r) return res.status(404).json({ error: "排练不存在" });
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(r.song_id);
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可修改" });
  const { date, time, location, outfit, notes, attendance } = req.body || {};
  db.prepare("UPDATE rehearsals SET date=?, time=?, location=?, outfit=?, notes=? WHERE id=?").run(
    date !== undefined ? date : r.date,
    time !== undefined ? time : r.time,
    location !== undefined ? location : r.location,
    outfit !== undefined ? outfit : r.outfit,
    notes !== undefined ? notes : r.notes,
    id
  );
  if (Array.isArray(attendance)) saveAttendance("rehearsal", id, attendance, s.id);
  res.json({ ok: true });
});

app.delete("/api/rehearsals/:id", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare("SELECT * FROM rehearsals WHERE id=?").get(id);
  if (!r) return res.status(404).json({ error: "排练不存在" });
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(r.song_id);
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可删除" });
  db.prepare("DELETE FROM rehearsals WHERE id=?").run(id);
  res.json({ ok: true });
});

// 改自己的出席状态（任何 active 成员都可以）
app.put("/api/rehearsals/:id/my-attendance", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare("SELECT * FROM rehearsals WHERE id=?").get(id);
  if (!r) return res.status(404).json({ error: "排练不存在" });
  const access = songAccess(r.song_id, req.userId);
  if (!access || access.role === "left") return res.status(403).json({ error: "无权操作" });
  const { status } = req.body || {};
  if (!["yes", "maybe", "no"].includes(status)) return res.status(400).json({ error: "status 不合法" });
  db.prepare(`INSERT INTO rehearsal_attendance (rehearsal_id, user_id, status) VALUES (?, ?, ?)
              ON CONFLICT(rehearsal_id, user_id) DO UPDATE SET status=excluded.status`)
    .run(id, req.userId, status);
  res.json({ ok: true });
});

// ==================== 路演 ====================
app.post("/api/songs/:sid/performances", authRequired, (req, res) => {
  const s = getSongOrFail(req, res); if (!s) return;
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可添加路演" });
  const { name, city, date, time, location, outfit, status, notes, attendance } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "请填写活动名" });
  if (!date) return res.status(400).json({ error: "请填写日期" });
  const r = db.prepare(`
    INSERT INTO performances (song_id, name, city, date, time, location, outfit, status, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(s.id, name.trim(), city || "", date, time || "", location || "", outfit || "", status || "planned", notes || "", now());
  saveAttendance("performance", r.lastInsertRowid, attendance || [], s.id);
  res.json({ id: r.lastInsertRowid });
});

app.patch("/api/performances/:id", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = db.prepare("SELECT * FROM performances WHERE id=?").get(id);
  if (!p) return res.status(404).json({ error: "路演不存在" });
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(p.song_id);
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可修改" });
  const { name, city, date, time, location, outfit, status, notes, attendance } = req.body || {};
  db.prepare(`UPDATE performances SET name=?, city=?, date=?, time=?, location=?, outfit=?, status=?, notes=? WHERE id=?`).run(
    name !== undefined ? name : p.name,
    city !== undefined ? city : p.city,
    date !== undefined ? date : p.date,
    time !== undefined ? time : p.time,
    location !== undefined ? location : p.location,
    outfit !== undefined ? outfit : p.outfit,
    status !== undefined ? status : p.status,
    notes !== undefined ? notes : p.notes,
    id
  );
  if (Array.isArray(attendance)) saveAttendance("performance", id, attendance, s.id);
  res.json({ ok: true });
});

app.delete("/api/performances/:id", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = db.prepare("SELECT * FROM performances WHERE id=?").get(id);
  if (!p) return res.status(404).json({ error: "路演不存在" });
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(p.song_id);
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可删除" });
  db.prepare("DELETE FROM performances WHERE id=?").run(id);
  res.json({ ok: true });
});

app.put("/api/performances/:id/my-attendance", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = db.prepare("SELECT * FROM performances WHERE id=?").get(id);
  if (!p) return res.status(404).json({ error: "路演不存在" });
  const access = songAccess(p.song_id, req.userId);
  if (!access || access.role === "left") return res.status(403).json({ error: "无权操作" });
  const { status } = req.body || {};
  if (!["yes", "maybe", "no"].includes(status)) return res.status(400).json({ error: "status 不合法" });
  db.prepare(`INSERT INTO performance_attendance (performance_id, user_id, status) VALUES (?, ?, ?)
              ON CONFLICT(performance_id, user_id) DO UPDATE SET status=excluded.status`)
    .run(id, req.userId, status);
  res.json({ ok: true });
});

// ==================== 工具：批量保存出席 ====================
function saveAttendance(kind, refId, items, songId) {
  const tbl = kind === "rehearsal" ? "rehearsal_attendance" : "performance_attendance";
  const col = kind === "rehearsal" ? "rehearsal_id" : "performance_id";
  // 仅允许 active 成员或车主
  const activeIds = new Set(db.prepare(`
    SELECT user_id FROM song_members WHERE song_id=? AND status='active'
  `).all(songId).map(r => r.user_id));
  const owner = db.prepare("SELECT owner_id FROM songs WHERE id=?").get(songId);
  if (owner) activeIds.add(owner.owner_id);

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ${tbl} WHERE ${col}=?`).run(refId);
    const ins = db.prepare(`INSERT INTO ${tbl} (${col}, user_id, status) VALUES (?, ?, ?)`);
    for (const a of items) {
      const uid = parseInt(a.user_id, 10);
      if (!uid || !activeIds.has(uid)) continue;
      const status = ["yes", "maybe", "no"].includes(a.status) ? a.status : "maybe";
      ins.run(refId, uid, status);
    }
  });
  tx();
}

// ==================== 错误处理 ====================
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "服务器内部错误" });
});
app.use("/api/*", (req, res) => res.status(404).json({ error: "API 不存在" }));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`🚀 K-pop server v2 running on http://127.0.0.1:${PORT}`);
});
