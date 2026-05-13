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
const crypto = require("crypto");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const multer = require("multer");

const PORT = parseInt(process.env.PORT || "3000", 10);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const DB_PATH = process.env.DB_PATH || "./data/data.db";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// AI 服务（默认 DeepSeek，OpenAI 兼容协议；可改成通义/Kimi/智谱 等同协议服务）
const AI_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.AI_API_KEY || "";
const AI_BASE_URL = process.env.AI_BASE_URL || "https://api.deepseek.com";
const AI_MODEL = process.env.AI_MODEL || "deepseek-chat";
// 视觉模型（多模态：看截图）。智谱 glm-4v-flash 免费、glm-4.5v 付费但便宜
const AI_VISION_MODEL = process.env.AI_VISION_MODEL || "glm-4v-flash";

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
    calendar_token TEXT,
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
    position_slots TEXT NOT NULL DEFAULT '[]',
    private INTEGER NOT NULL DEFAULT 0,
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
    outfit_images TEXT NOT NULL DEFAULT '[]',
    status TEXT DEFAULT 'planned',
    notes TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  );

  -- 每个成员对每场路演的个人穿搭
  CREATE TABLE IF NOT EXISTS performance_outfits (
    performance_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (performance_id, user_id),
    FOREIGN KEY (performance_id) REFERENCES performances(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS performance_attendance (
    performance_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'maybe',
    PRIMARY KEY (performance_id, user_id),
    FOREIGN KEY (performance_id) REFERENCES performances(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- 待确认队列：AI 从微信群消息解析出来的排练/路演候选
  CREATE TABLE IF NOT EXISTS pending_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,         -- 是谁粘贴的
    kind TEXT NOT NULL,               -- 'rehearsal' | 'performance'
    song_id INTEGER,                  -- AI 猜测或用户指定的关联歌曲，可为 NULL
    data TEXT NOT NULL,               -- JSON 序列化：date/time/location/outfit/notes/attendance...
    raw_text TEXT NOT NULL DEFAULT '',-- 原始聊天片段（截断后存储，方便追溯）
    ai_note TEXT NOT NULL DEFAULT '', -- AI 自己的解析说明 / 不确定之处
    status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | rejected
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pending_user_status ON pending_items(user_id, status);
`);
// 老版本数据库迁移：songs 表加 position_slots / private 列
try {
  const sCols = db.prepare("PRAGMA table_info(songs)").all();
  if (!sCols.some((c) => c.name === "position_slots")) {
    db.exec("ALTER TABLE songs ADD COLUMN position_slots TEXT NOT NULL DEFAULT '[]'");
    console.log("🔧 已为旧 songs 表补 position_slots 列");
  }
  if (!sCols.some((c) => c.name === "private")) {
    db.exec("ALTER TABLE songs ADD COLUMN private INTEGER NOT NULL DEFAULT 0");
    console.log("🔧 已为旧 songs 表补 private 列");
  }
} catch (e) {
  console.error("songs 迁移失败：", e.message);
}

// 老版本数据库迁移：performances 表加 outfit_images 列
try {
  const cols = db.prepare("PRAGMA table_info(performances)").all();
  if (!cols.some((c) => c.name === "outfit_images")) {
    db.exec("ALTER TABLE performances ADD COLUMN outfit_images TEXT NOT NULL DEFAULT '[]'");
    console.log("🔧 已为旧 performances 表补 outfit_images 列");
  }
} catch (e) {
  console.error("迁移失败：", e.message);
}

// 老 users 表加 calendar_token 列（如果还没有）
try {
  const uCols = db.prepare("PRAGMA table_info(users)").all();
  if (!uCols.some((c) => c.name === "calendar_token")) {
    db.exec("ALTER TABLE users ADD COLUMN calendar_token TEXT");
    console.log("🔧 已为旧 users 表补 calendar_token 列");
  }
} catch (e) {
  console.error("users 迁移失败：", e.message);
}

// 路演 status 枚举迁移：旧 planned/confirmed/canceled → 新 pending_submit/approved/no_show（done 保留）
try {
  const r1 = db.prepare("UPDATE performances SET status='pending_submit' WHERE status='planned'").run();
  const r2 = db.prepare("UPDATE performances SET status='approved'       WHERE status='confirmed'").run();
  const r3 = db.prepare("UPDATE performances SET status='no_show'        WHERE status='canceled'").run();
  const total = r1.changes + r2.changes + r3.changes;
  if (total) console.log(`🔧 路演状态迁移：planned→pending_submit ${r1.changes} 条 / confirmed→approved ${r2.changes} 条 / canceled→no_show ${r3.changes} 条`);
} catch (e) {
  console.error("状态迁移失败：", e.message);
}

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

// ===== 日历订阅相关 =====
function genCalendarToken() {
  // 32 字节 → 43 字符 base64url，URL-safe
  return crypto.randomBytes(32).toString("base64url");
}
function getOrCreateCalToken(userId) {
  const u = db.prepare("SELECT calendar_token FROM users WHERE id=?").get(userId);
  if (u && u.calendar_token) return u.calendar_token;
  const tok = genCalendarToken();
  db.prepare("UPDATE users SET calendar_token=? WHERE id=?").run(tok, userId);
  return tok;
}
// ics 文本字段转义：反斜杠 / 分号 / 逗号 / 换行
function escapeIcs(s) {
  if (s == null) return "";
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}
// "17:20" / "17:20-22:00" / "14:00 - 17:00" → { start:"1720", end:"2200" } 或 null
function parseEventTime(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim();
  const range = s.match(/^(\d{1,2})[:：](\d{2})\s*[-~到至]\s*(\d{1,2})[:：](\d{2})$/);
  if (range) {
    return {
      start: range[1].padStart(2, "0") + range[2],
      end:   range[3].padStart(2, "0") + range[4],
    };
  }
  const one = s.match(/^(\d{1,2})[:：](\d{2})$/);
  if (one) {
    return { start: one[1].padStart(2, "0") + one[2], end: null };
  }
  return null; // 自由文本，无法解析 → 当全天事件
}
// 把 "2026-05-17" + "1720" 拼成 floating time "20260517T172000"（不带 Z，让客户端按本地时区显示）
function fmtFloatingDT(dateStr, hhmm) {
  const ymd = (dateStr || "").replace(/-/g, "").slice(0, 8);
  if (!ymd || ymd.length !== 8) return null;
  return ymd + "T" + (hhmm || "0000") + "00";
}
// "2026-05-17" → "20260517"
function fmtDate(dateStr) { return (dateStr || "").replace(/-/g, "").slice(0, 8); }
// 当前 UTC 时间戳 DTSTAMP "20260512T034500Z"
function fmtUtcNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
// 长行折行（RFC 5545: 建议 ≤75 字节）
function foldIcsLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < line.length) {
    parts.push((i === 0 ? "" : " ") + line.slice(i, i + 74));
    i += 74;
  }
  return parts.join("\r\n");
}
// 生成完整 ics 字符串：当前用户在所有可见歌曲里、出席不为 no/状态不为 no_show 的排练 + 路演
function buildIcsFor(userId) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!user) return null;

  // 用户能看到的歌曲（owner + active member；left 不算）
  const songs = db.prepare(`
    SELECT s.id, s.title, s.artist, u.name AS owner_name
    FROM songs s
    JOIN users u ON u.id = s.owner_id
    WHERE s.owner_id=? OR EXISTS (
      SELECT 1 FROM song_members sm WHERE sm.song_id=s.id AND sm.user_id=? AND sm.status='active'
    )
  `).all(userId, userId);

  const lines = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//kpop-server//CN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  lines.push("X-WR-CALNAME:" + escapeIcs(`${user.name} 的 K-pop 日程`));
  lines.push("X-WR-TIMEZONE:Asia/Shanghai");
  lines.push("X-PUBLISHED-TTL:PT1H");

  const stamp = fmtUtcNow();

  for (const song of songs) {
    // 排练
    const rehs = db.prepare("SELECT * FROM rehearsals WHERE song_id=? ORDER BY date").all(song.id);
    for (const r of rehs) {
      // 看我的出席
      const a = db.prepare("SELECT status FROM rehearsal_attendance WHERE rehearsal_id=? AND user_id=?").get(r.id, userId);
      if (a && a.status === "no") continue; // 明确不来的不进日历
      const myStat = a ? a.status : "maybe";
      const evt = makeEvent({
        uid: `reh-${r.id}@kpop.special-lifejourney.com`,
        stamp,
        date: r.date,
        time: r.time,
        title: `📅 ${song.title} 排练`,
        location: r.location,
        description: [
          `🎵 ${song.title}${song.artist ? " · " + song.artist : ""}`,
          `🚗 车主：${song.owner_name}`,
          r.outfit ? `👗 服装：${r.outfit}` : null,
          `我的出席：${myStat === "yes" ? "✓ 来" : "? 待定"}`,
          r.notes ? `📝 ${r.notes}` : null,
        ].filter(Boolean).join("\n"),
      });
      lines.push(...evt);
    }
    // 路演
    const perfs = db.prepare("SELECT * FROM performances WHERE song_id=? ORDER BY date").all(song.id);
    for (const p of perfs) {
      if (p.status === "no_show") continue; // 未演出的不进日历
      const a = db.prepare("SELECT status FROM performance_attendance WHERE performance_id=? AND user_id=?").get(p.id, userId);
      if (a && a.status === "no") continue;
      const myStat = a ? a.status : "maybe";
      const statusLabel = {
        pending_submit: "待投稿", submitted: "已投稿",
        approved: "已通过", done: "已演完",
      }[p.status] || p.status;
      const evt = makeEvent({
        uid: `perf-${p.id}@kpop.special-lifejourney.com`,
        stamp,
        date: p.date,
        time: p.time,
        title: `🎤 ${p.name}（${song.title}）`,
        location: [p.city, p.location].filter(Boolean).join(" · "),
        description: [
          `🎵 ${song.title}${song.artist ? " · " + song.artist : ""}`,
          `🚗 车主：${song.owner_name}`,
          `📋 状态：${statusLabel}`,
          p.outfit ? `👗 装搭：${p.outfit}` : null,
          `我的出席：${myStat === "yes" ? "✓ 参演" : "? 待定"}`,
          p.notes ? `📝 ${p.notes}` : null,
        ].filter(Boolean).join("\n"),
      });
      lines.push(...evt);
    }
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

function makeEvent({ uid, stamp, date, time, title, location, description }) {
  const parsed = parseEventTime(time);
  const out = ["BEGIN:VEVENT"];
  out.push("UID:" + uid);
  out.push("DTSTAMP:" + stamp);
  if (parsed && parsed.start) {
    const start = fmtFloatingDT(date, parsed.start);
    const end = fmtFloatingDT(date, parsed.end || addOneHour(parsed.start));
    if (start) out.push("DTSTART:" + start);
    if (end)   out.push("DTEND:"   + end);
  } else {
    // 全天事件：DTSTART;VALUE=DATE:YYYYMMDD ；DTEND 是次日（按 RFC 5545 半开区间）
    const d = fmtDate(date);
    if (d) {
      out.push("DTSTART;VALUE=DATE:" + d);
      out.push("DTEND;VALUE=DATE:" + nextDay(d));
    }
    if (time) description = `🕑 时间：${time}\n` + description;
  }
  out.push("SUMMARY:" + escapeIcs(title));
  if (location) out.push("LOCATION:" + escapeIcs(location));
  if (description) out.push("DESCRIPTION:" + escapeIcs(description));
  out.push("END:VEVENT");
  return out;
}

function addOneHour(hhmm) {
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = hhmm.slice(2, 4);
  return String((h + 1) % 24).padStart(2, "0") + m;
}
function nextDay(yyyymmdd) {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const t = new Date(Date.UTC(y, m, d + 1));
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}`;
}

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

// ==================== 上传 ====================
// 文件存到 public/uploads/，nginx 已经在 location / 把整个 public/ 当静态根目录，
// 所以 /uploads/xxx.jpg 会被 nginx 直接命中文件、不走 Node。
const UPLOAD_DIR = path.resolve(__dirname, "public/uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// 兜底：本地开发没有 nginx 时让 Node 也能出图
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d" }));

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
]);
const uploader = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".jpg").toLowerCase().replace(/[^a-z0-9.]/g, "");
      const stamp = Date.now().toString(36);
      const rand = crypto.randomBytes(4).toString("hex");
      cb(null, `u${req.userId || "x"}-${stamp}-${rand}${ext.length > 1 ? ext : ".jpg"}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 12 },  // 单文件 20MB，单次最多 12 张
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error(`不支持的图片格式：${file.mimetype}（接受 jpg/png/webp/gif/heic）`));
    }
    cb(null, true);
  },
});

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

// 拿当前用户的日历订阅 token + URL（没有就生成）
app.get("/api/auth/calendar-url", authRequired, (req, res) => {
  const token = getOrCreateCalToken(req.userId);
  // 同时返回 webcal:// 和 https:// 两种，前端可自己挑
  // 协议留空让前端拼，后端只给 token 和 path
  res.json({ token, path: `/api/cal/${token}.ics` });
});

// 重置日历 token（旧链接立即失效）
app.post("/api/auth/regenerate-calendar-token", authRequired, (req, res) => {
  const token = genCalendarToken();
  db.prepare("UPDATE users SET calendar_token=? WHERE id=?").run(token, req.userId);
  res.json({ token, path: `/api/cal/${token}.ics` });
});

// 公开的 ics 拉取（靠 token 认证，无需登录）
// 限流：每个 token 每分钟最多 30 次（iOS 默认每小时拉 1 次，足够宽松）
const calLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => `cal-${req.params.token || req.ip}`,
  message: "rate limited",
});
app.get("/api/cal/:token.ics", calLimiter, (req, res) => {
  const token = req.params.token;
  if (!token || token.length < 20) return res.status(400).type("text").send("invalid token");
  const u = db.prepare("SELECT id FROM users WHERE calendar_token=?").get(token);
  if (!u) return res.status(404).type("text").send("calendar not found");
  const ics = buildIcsFor(u.id);
  if (!ics) return res.status(500).type("text").send("calendar build failed");
  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Cache-Control", "no-cache");
  res.send(ics);
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

// 查好友跳的舞 —— 隐私敏感字段已过滤
app.get("/api/friends/:userId/songs", authRequired, (req, res) => {
  const friendId = parseInt(req.params.userId, 10);
  if (!friendId) return res.status(400).json({ error: "参数错误" });
  if (friendId === req.userId) return res.status(400).json({ error: "不能查自己" });
  if (!areFriends(req.userId, friendId)) return res.status(403).json({ error: "你们不是好友" });

  const friend = db.prepare("SELECT id, name, avatar FROM users WHERE id=?").get(friendId);
  if (!friend) return res.status(404).json({ error: "用户不存在" });

  // 该好友作为车主 或 song_members 任一状态（含 left）的非私密歌曲
  const rows = db.prepare(`
    SELECT s.*,
      CASE WHEN s.owner_id=? THEN 'owner'
           WHEN sm.user_id=? AND sm.status='active' THEN 'active'
           WHEN sm.user_id=? AND sm.status='left' THEN 'left'
      END AS friend_role,
      sm.position AS friend_position,
      sm.joined_at AS friend_joined_at,
      sm.left_at AS friend_left_at
    FROM songs s
    LEFT JOIN song_members sm ON sm.song_id=s.id AND sm.user_id=?
    WHERE s.private=0 AND (s.owner_id=? OR sm.user_id=?)
    ORDER BY s.created_at DESC
  `).all(friendId, friendId, friendId, friendId, friendId, friendId);

  const today = new Date().toISOString().slice(0, 10);

  const songs = rows.map((s) => {
    // 队伍统计
    const activeCount = db.prepare("SELECT COUNT(*) AS c FROM song_members WHERE song_id=? AND status='active'").get(s.id).c;
    const ownerActive = db.prepare("SELECT 1 FROM song_members WHERE song_id=? AND user_id=? AND status='active'").get(s.id, s.owner_id) ? 1 : 0;
    const teamSize = activeCount + (ownerActive ? 0 : 1); // 车主有可能没在 song_members 表（兜底）

    let slots = [];
    try { slots = JSON.parse(s.position_slots || "[]"); } catch {}

    // 未来排练：仅返回数字 + 最近一场日期
    const futureReh = db.prepare(`
      SELECT date FROM rehearsals WHERE song_id=? AND date >= ? ORDER BY date ASC
    `).all(s.id, today);
    // 未来路演：数字 + 最近一场日期
    const futurePerf = db.prepare(`
      SELECT date FROM performances WHERE song_id=? AND date >= ? AND status != 'no_show' ORDER BY date ASC
    `).all(s.id, today);

    // 已完成路演：仅返回 name + city + date（不返回 attendance、location、outfit）
    const donePerf = db.prepare(`
      SELECT name, city, date FROM performances WHERE song_id=? AND status='done' AND date < ? ORDER BY date DESC
    `).all(s.id, today);

    // 我（当前用户）也在这首歌？
    const myOverlap = db.prepare(`
      SELECT 1 FROM song_members WHERE song_id=? AND user_id=? AND status='active'
    `).get(s.id, req.userId) || s.owner_id === req.userId;

    const owner = publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(s.owner_id));

    return {
      id: s.id,
      title: s.title,
      artist: s.artist,
      type: s.type,
      owner,
      friend_role: s.friend_role,
      friend_position: s.friend_position || "",
      friend_joined_at: s.friend_joined_at,
      friend_left_at: s.friend_left_at,
      team_size: teamSize,
      slot_count: slots.length,
      upcoming_rehearsals: {
        count: futureReh.length,
        next_date: futureReh[0] && futureReh[0].date || null,
      },
      upcoming_performances: {
        count: futurePerf.length,
        next_date: futurePerf[0] && futurePerf[0].date || null,
      },
      completed_performances: donePerf, // [{name, city, date}]
      is_overlap: !!myOverlap,
    };
  });

  res.json({ friend, songs });
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
    try { s.position_slots = JSON.parse(s.position_slots || "[]"); } catch { s.position_slots = []; }
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
      // outfit_images 反序列化
      try { p.outfit_images = JSON.parse(p.outfit_images || "[]"); } catch { p.outfit_images = []; }
      // 每人穿搭
      const outfits = db.prepare(`
        SELECT po.user_id, po.notes, po.images, po.updated_at, u.name, u.avatar
        FROM performance_outfits po
        JOIN users u ON u.id = po.user_id
        WHERE po.performance_id=?
      `).all(p.id);
      p.member_outfits = outfits.map((o) => {
        let imgs = [];
        try { imgs = JSON.parse(o.images || "[]"); } catch {}
        return { user_id: o.user_id, name: o.name, avatar: o.avatar, notes: o.notes || "", images: imgs, updated_at: o.updated_at };
      });
    }
  }
  res.json({ songs });
});

app.post("/api/songs", authRequired, (req, res) => {
  const { title, artist, type, notes, position_slots, private: priv } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "请填写歌曲名" });
  const slotsJson = JSON.stringify(sanitizePositionSlots(position_slots));
  const r = db.prepare(`
    INSERT INTO songs (owner_id, title, artist, type, notes, position_slots, private, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.userId, title.trim(), artist || "", type || "new", notes || "", slotsJson, priv ? 1 : 0, now());
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
  const { title, artist, type, notes, position_slots, private: priv } = req.body || {};
  const slotsJson = position_slots !== undefined
    ? JSON.stringify(sanitizePositionSlots(position_slots))
    : s.position_slots;
  const newPriv = priv === undefined ? s.private : (priv ? 1 : 0);
  db.prepare("UPDATE songs SET title=?, artist=?, type=?, notes=?, position_slots=?, private=? WHERE id=?").run(
    title !== undefined ? title : s.title,
    artist !== undefined ? artist : s.artist,
    type !== undefined ? type : s.type,
    notes !== undefined ? notes : s.notes,
    slotsJson,
    newPriv,
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

  // 队伍是总权限：移除时连带清空该 user 在该 song 所有排练 / 路演的出席 + 个人穿搭
  const tx = db.transaction(() => {
    const r = db.prepare("UPDATE song_members SET status='left', left_at=? WHERE song_id=? AND user_id=? AND status='active'")
      .run(now(), songId, uid);
    if (r.changes === 0) return { ok: false };
    // 删该 user 在这首歌所有排练的出席
    db.prepare(`
      DELETE FROM rehearsal_attendance
      WHERE user_id=? AND rehearsal_id IN (SELECT id FROM rehearsals WHERE song_id=?)
    `).run(uid, songId);
    // 删该 user 在这首歌所有路演的出席
    db.prepare(`
      DELETE FROM performance_attendance
      WHERE user_id=? AND performance_id IN (SELECT id FROM performances WHERE song_id=?)
    `).run(uid, songId);
    // 顺便清掉个人穿搭（外键 ON DELETE CASCADE 不会触发因为没删 user，主动删）
    db.prepare(`
      DELETE FROM performance_outfits
      WHERE user_id=? AND performance_id IN (SELECT id FROM performances WHERE song_id=?)
    `).run(uid, songId);
    return { ok: true };
  });
  const result = tx();
  if (!result.ok) return res.status(404).json({ error: "成员不在歌曲中" });
  res.json({ ok: true });
});

// 车主在单次排练里把某人踢出（不影响他在队伍里）
app.delete("/api/rehearsals/:id/attendance/:uid", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const uid = parseInt(req.params.uid, 10);
  const r = db.prepare("SELECT * FROM rehearsals WHERE id=?").get(id);
  if (!r) return res.status(404).json({ error: "排练不存在" });
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(r.song_id);
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可操作" });
  if (uid === s.owner_id) return res.status(400).json({ error: "不能把车主从自己的排练里踢出" });
  db.prepare("DELETE FROM rehearsal_attendance WHERE rehearsal_id=? AND user_id=?").run(id, uid);
  res.json({ ok: true });
});

// 车主在单次路演里把某人踢出（不影响他在队伍里）
app.delete("/api/performances/:id/attendance/:uid", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const uid = parseInt(req.params.uid, 10);
  const p = db.prepare("SELECT * FROM performances WHERE id=?").get(id);
  if (!p) return res.status(404).json({ error: "路演不存在" });
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(p.song_id);
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可操作" });
  if (uid === s.owner_id) return res.status(400).json({ error: "不能把车主从自己的路演里踢出" });
  // 同时清掉该人在这场的个人穿搭
  db.prepare("DELETE FROM performance_attendance WHERE performance_id=? AND user_id=?").run(id, uid);
  db.prepare("DELETE FROM performance_outfits WHERE performance_id=? AND user_id=?").run(id, uid);
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
function sanitizePositionSlots(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  return arr
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => {
      if (!s || s.length > 40) return false;
      const k = s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 30);
}

function sanitizeImagesArr(arr) {
  if (!Array.isArray(arr)) return [];
  // 只保留我们自己 /uploads/ 下的 URL，防止存外部链接被滥用
  return arr
    .filter((u) => typeof u === "string" && /^\/uploads\/[\w.-]+$/.test(u))
    .slice(0, 24); // 单条最多 24 张
}

app.post("/api/songs/:sid/performances", authRequired, (req, res) => {
  const s = getSongOrFail(req, res); if (!s) return;
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可添加路演" });
  const { name, city, date, time, location, outfit, outfit_images, status, notes, attendance } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "请填写活动名" });
  if (!date) return res.status(400).json({ error: "请填写日期" });
  const imgs = JSON.stringify(sanitizeImagesArr(outfit_images));
  const r = db.prepare(`
    INSERT INTO performances (song_id, name, city, date, time, location, outfit, outfit_images, status, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(s.id, name.trim(), city || "", date, time || "", location || "", outfit || "", imgs, status || "pending_submit", notes || "", now());
  saveAttendance("performance", r.lastInsertRowid, attendance || [], s.id);
  res.json({ id: r.lastInsertRowid });
});

app.patch("/api/performances/:id", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = db.prepare("SELECT * FROM performances WHERE id=?").get(id);
  if (!p) return res.status(404).json({ error: "路演不存在" });
  const s = db.prepare("SELECT * FROM songs WHERE id=?").get(p.song_id);
  if (s.owner_id !== req.userId) return res.status(403).json({ error: "仅车主可修改" });
  const { name, city, date, time, location, outfit, outfit_images, status, notes, attendance } = req.body || {};
  const imgs = outfit_images !== undefined ? JSON.stringify(sanitizeImagesArr(outfit_images)) : p.outfit_images;
  db.prepare(`UPDATE performances SET name=?, city=?, date=?, time=?, location=?, outfit=?, outfit_images=?, status=?, notes=? WHERE id=?`).run(
    name !== undefined ? name : p.name,
    city !== undefined ? city : p.city,
    date !== undefined ? date : p.date,
    time !== undefined ? time : p.time,
    location !== undefined ? location : p.location,
    outfit !== undefined ? outfit : p.outfit,
    imgs,
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

// 个人穿搭：active 成员 / 车主可读写自己那行
app.put("/api/performances/:id/my-outfit", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = db.prepare("SELECT * FROM performances WHERE id=?").get(id);
  if (!p) return res.status(404).json({ error: "路演不存在" });
  const access = songAccess(p.song_id, req.userId);
  if (!access || access.role === "left") return res.status(403).json({ error: "已退出歌曲，无权操作" });
  const { notes, images } = req.body || {};
  const imgs = JSON.stringify(sanitizeImagesArr(images));
  const text = (notes || "").toString().slice(0, 1000);
  db.prepare(`INSERT INTO performance_outfits (performance_id, user_id, notes, images, updated_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(performance_id, user_id) DO UPDATE SET notes=excluded.notes, images=excluded.images, updated_at=excluded.updated_at`)
    .run(id, req.userId, text, imgs, now());
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

// ==================== AI 解析（微信群消息整理） ====================
async function callAI(messages, opts = {}) {
  if (!AI_API_KEY) {
    const err = new Error("后端未配置 AI key（DEEPSEEK_API_KEY / AI_API_KEY），无法解析");
    err.statusCode = 503;
    throw err;
  }
  // 智谱 GLM-4V 系列不支持 system 角色：把 system 文本合并到第一条 user 消息里
  let actualMessages = messages;
  if (opts.mergeSystemIntoUser) {
    const sysTexts = messages.filter((m) => m.role === "system").map((m) => typeof m.content === "string" ? m.content : "").filter(Boolean);
    const userMsgs = messages.filter((m) => m.role !== "system");
    if (sysTexts.length && userMsgs.length) {
      const sysJoined = sysTexts.join("\n\n");
      const first = userMsgs[0];
      if (typeof first.content === "string") {
        first.content = sysJoined + "\n\n" + first.content;
      } else if (Array.isArray(first.content)) {
        // 多模态：找到 text 节点把 system 拼到它前面（保持图片在前的顺序）
        let textIdx = first.content.findIndex((c) => c.type === "text");
        if (textIdx >= 0) {
          const oldText = first.content[textIdx].text || "";
          first.content[textIdx] = { type: "text", text: sysJoined + "\n\n" + oldText };
        } else {
          first.content.push({ type: "text", text: sysJoined });
        }
      }
      actualMessages = userMsgs;
    }
  }
  const body = {
    model: opts.model || AI_MODEL,
    messages: actualMessages,
    temperature: opts.temperature != null ? opts.temperature : 0.1,
    max_tokens: opts.maxTokens || 4000,
  };
  // 视觉模型多数不支持 response_format，所以做开关
  if (opts.jsonMode !== false) {
    body.response_format = { type: "json_object" };
  }
  // 调用前打印请求摘要（不打印图片 base64，太长）
  const imgCount = actualMessages.reduce((acc, m) => {
    if (Array.isArray(m.content)) return acc + m.content.filter((c) => c.type === "image_url").length;
    return acc;
  }, 0);
  const rolesStr = actualMessages.map((m) => m.role).join(",");
  console.log(`[AI 调用] model=${body.model} url=${AI_BASE_URL} jsonMode=${opts.jsonMode !== false} msgs=${actualMessages.length} imgs=${imgCount} roles=[${rolesStr}] temp=${body.temperature}`);

  let res;
  try {
    res = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("AI 网络错误：" + e.message);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 同时打印请求摘要，便于排查
    const reqDump = JSON.stringify({
      model: body.model,
      msg_count: actualMessages.length,
      first_role: actualMessages[0] && actualMessages[0].role,
      first_content_type: Array.isArray(actualMessages[0] && actualMessages[0].content) ? "array" : "string",
      first_content_blocks: Array.isArray(actualMessages[0] && actualMessages[0].content)
        ? actualMessages[0].content.map((c) => c.type)
        : null,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      has_response_format: !!body.response_format,
    });
    console.error(`[AI 错误] status=${res.status} req=${reqDump}`);
    console.error(`[AI 错误] body=${text.slice(0, 1500)}`);
    const err = new Error(`AI 服务返回 ${res.status}：${text.slice(0, 400)}`);
    err.statusCode = 502;
    throw err;
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) {
    console.error("[AI 错误] 返回结构异常:", JSON.stringify(data).slice(0, 500));
    throw new Error("AI 返回内容为空");
  }
  return content;
}

// 防御性 JSON 提取：先 JSON.parse，失败的话用正则抽 {...} 再 parse
function extractJson(raw) {
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch {}
  // 去掉 markdown code fence
  const fenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(fenced); } catch {}
  // 抽第一个 { 到最后一个 } 之间的子串
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) {
    const sub = raw.slice(a, b + 1);
    try { return JSON.parse(sub); } catch {}
  }
  return null;
}

function buildParseMessages({ user, friends, songs, text, hintSongId }) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const weekDay = "日一二三四五六"[today.getDay()];

  const people = [
    { id: user.id, name: user.name, self: true },
    ...friends.map((f) => ({ id: f.id, name: f.name })),
  ];
  const peopleText = people
    .map((p) => `- id=${p.id} 名字="${p.name}"${p.self ? "（当前用户自己）" : ""}`)
    .join("\n");

  const songsText = songs.length
    ? songs.map((s) => `- id=${s.id} 歌名="${s.title}"${s.artist ? ` 组合="${s.artist}"` : ""}`).join("\n")
    : "（当前用户作为车主的歌曲列表为空）";

  const hintLine = hintSongId
    ? `用户提示：这段聊天主要在讨论 id=${hintSongId} 这首歌；如无明确反证请把所有 item 关联到这首歌。`
    : "用户未指定关联歌曲。请你根据聊天内容把每条 item 关联到上面歌曲列表里的 id；判断不出时 song_id 留 null。";

  const systemPrompt = `你是 K-pop 翻跳团队的微信群消息整理助手。任务：从用户粘贴的群聊文本里识别所有「排练（rehearsal）」和「路演（performance）」安排，输出严格 JSON。

== 输出规则（务必严格遵守）==
1. 只输出 JSON，不要 markdown 代码块、不要解释文字。
2. 顶层结构：{"items": [...]}, items 是数组（可以为空）。
3. 每个 item 必填字段：
   - kind: "rehearsal" 或 "performance"
   - song_id: 整数或 null（必须来自给定的歌曲列表）
   - song_title_guess: 字符串，你认为对应的歌名（便于人工核对）
   - date: "YYYY-MM-DD"。相对日期（明天/后天/周六/这周五）必须基于今天换算成绝对日期
   - time: "HH:MM"（24 小时制）或 ""
   - location: 字符串（地点）
   - outfit: 字符串（服装/穿搭，没说就 ""）
   - notes: 字符串（其他备注）
   - attendance: 数组，每项 {"user_id": 整数, "name": 字符串, "status": "yes"|"no"|"maybe"}
   - ai_note: 字符串，简要说明你的解析依据 / 不确定之处（中文，不超过 60 字）
4. kind="performance" 额外字段：
   - name: 活动名（必填，从聊天里抽取，没明说就用"xx 路演"或场地名）
   - city: 城市，没说就 ""
5. attendance 里只能引用上面"成员列表"提供的 user_id 和 name；群里出现但不在列表里的人忽略；没有明确出席态度的人不要列。
6. 出席态度推断：
   - "我去/我来/我到/+1/收到/好的/没问题" → yes
   - "我不去/去不了/请假/不能来/没空" → no
   - "我看看/再说/可能/不一定" → maybe
7. 同一事件多次改动（先 7 点又改 8 点）→ 只输出最终版本。
8. 没有任何排练/路演相关内容时输出 {"items": []}。
9. 不要凭空生成日期；如果聊天里没提到具体日期，跳过这条。`;

  const userPrompt = `== 上下文 ==
今天日期：${todayStr}（周${weekDay}）
当前用户：id=${user.id} 名字="${user.name}"

成员列表（attendance 仅能引用这里的人）：
${peopleText}

可关联的歌曲列表（song_id 只能从这里选，否则 null）：
${songsText}

${hintLine}

== 聊天记录开始 ==
${text}
== 聊天记录结束 ==

按系统提示输出 JSON。`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

// AI 调用花钱 + 怕被刷，加限流：每用户每分钟最多 6 次
const parseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => `parse-${req.userId || req.ip}`,
  message: { error: "解析太频繁了，等 1 分钟再试" },
});

// 粘贴聊天记录 → 调 AI → 写入 pending_items
app.post("/api/parse", authRequired, parseLimiter, async (req, res) => {
  const { text, song_id: hintRaw } = req.body || {};
  if (!text || !text.toString().trim()) return res.status(400).json({ error: "请粘贴聊天记录" });
  if (text.length > 50000) return res.status(400).json({ error: "聊天记录太长（上限 5 万字）" });

  const hintSongId = hintRaw ? parseInt(hintRaw, 10) || null : null;
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.userId);
  const friends = db.prepare(`
    SELECT u.id, u.name FROM friendships f
    JOIN users u ON u.id = (CASE WHEN f.user_a_id=? THEN f.user_b_id ELSE f.user_a_id END)
    WHERE f.user_a_id=? OR f.user_b_id=?
  `).all(req.userId, req.userId, req.userId);
  const ownedSongs = db.prepare("SELECT id, title, artist FROM songs WHERE owner_id=?").all(req.userId);
  if (ownedSongs.length === 0) {
    return res.status(400).json({ error: "你还不是任何歌曲的车主，请先新建一首歌再整理消息" });
  }

  let raw;
  try {
    const messages = buildParseMessages({ user, friends, songs: ownedSongs, text: text.toString(), hintSongId });
    raw = await callAI(messages);
  } catch (e) {
    console.error("[parse] AI 调用失败:", e.message);
    return res.status(e.statusCode || 502).json({ error: e.message || "AI 调用失败" });
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    console.error("[parse] AI 输出非 JSON:", raw.slice(0, 500));
    return res.status(502).json({ error: "AI 输出不是合法 JSON，请重试" });
  }

  const items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
  const validSongIds = new Set(ownedSongs.map((s) => s.id));
  const validUserIds = new Set([user.id, ...friends.map((f) => f.id)]);

  const insertStmt = db.prepare(`
    INSERT INTO pending_items (user_id, kind, song_id, data, raw_text, ai_note, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const created = [];
  const tx = db.transaction((arr) => {
    for (const it of arr) {
      const kind = it.kind === "performance" ? "performance" : "rehearsal";
      if (!it.date) continue;
      const songId = validSongIds.has(it.song_id) ? it.song_id : (hintSongId && validSongIds.has(hintSongId) ? hintSongId : null);
      const att = Array.isArray(it.attendance)
        ? it.attendance.filter((a) => a && validUserIds.has(a.user_id) && ["yes", "no", "maybe"].includes(a.status))
        : [];
      const data = {
        kind,
        song_id: songId,
        song_title_guess: (it.song_title_guess || "").toString().slice(0, 100),
        date: (it.date || "").toString().slice(0, 20),
        time: (it.time || "").toString().slice(0, 10),
        location: (it.location || "").toString().slice(0, 200),
        outfit: (it.outfit || "").toString().slice(0, 200),
        notes: (it.notes || "").toString().slice(0, 500),
        attendance: att,
      };
      if (kind === "performance") {
        data.name = (it.name || it.song_title_guess || "未命名活动").toString().slice(0, 100);
        data.city = (it.city || "").toString().slice(0, 50);
      }
      const r = insertStmt.run(
        req.userId, kind, songId,
        JSON.stringify(data),
        text.toString().slice(0, 5000),
        (it.ai_note || "").toString().slice(0, 500),
        now()
      );
      created.push({ id: r.lastInsertRowid, kind, ...data });
    }
  });
  tx(items);

  res.json({ created, count: created.length });
});

// ===== 截图 → 多模态 AI 识别 =====
function imagePathFromUrl(url) {
  // 接受 "/uploads/xxx.jpg" 这种形式，必须是我们自己的
  if (typeof url !== "string") return null;
  const m = url.match(/^\/uploads\/([\w.-]+)$/);
  if (!m) return null;
  return path.join(UPLOAD_DIR, m[1]);
}
function imageToDataUrl(filepath) {
  if (!fs.existsSync(filepath)) return null;
  const ext = (path.extname(filepath) || ".jpg").toLowerCase().slice(1);
  const mime = ext === "png" ? "image/png"
             : ext === "webp" ? "image/webp"
             : ext === "gif" ? "image/gif"
             : ext === "heic" ? "image/heic"
             : "image/jpeg";
  const buf = fs.readFileSync(filepath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function buildVisionMessages({ user, friends, songs, hintSongId }) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const weekDay = "日一二三四五六"[today.getDay()];

  const people = [
    { id: user.id, name: user.name, self: true },
    ...friends.map((f) => ({ id: f.id, name: f.name })),
  ];
  const peopleText = people
    .map((p) => `- id=${p.id} 名字="${p.name}"${p.self ? "（当前用户自己）" : ""}`)
    .join("\n");

  const songsText = songs.length
    ? songs.map((s) => `- id=${s.id} 歌名="${s.title}"${s.artist ? ` 组合="${s.artist}"` : ""}`).join("\n")
    : "（用户作为车主的歌曲列表为空）";

  const hintLine = hintSongId
    ? `用户提示：这些截图主要在讨论 id=${hintSongId} 这首歌；如无明确反证就关联到这首歌。`
    : "用户未指定关联歌曲。请根据截图判断每条 item 关联到上面歌曲列表里的 id；判断不出时 song_id 留 null。";

  // 系统提示和 buildParseMessages 类似，但说明输入是聊天截图
  const systemPrompt = `你是 K-pop 翻跳团队的微信群消息整理助手。任务：用户上传了若干张微信群聊截图，请识别出所有「排练（rehearsal）」和「路演（performance）」安排，输出严格 JSON。

== 输出规则（务必严格遵守）==
1. 只输出 JSON 对象，不要 markdown 代码块、不要解释文字。
2. 顶层结构：{"items": [...]}, items 是数组（可以为空）。
3. 每个 item 必填字段：
   - kind: "rehearsal" 或 "performance"
   - song_id: 整数或 null（必须来自给定的歌曲列表）
   - song_title_guess: 字符串，你认为对应的歌名
   - date: "YYYY-MM-DD"。相对日期（明天/后天/周六）必须基于今天换算成绝对日期
   - time: "HH:MM"（24 小时制）或 ""
   - location: 字符串（地点）
   - outfit: 字符串
   - notes: 字符串
   - attendance: 数组，每项 {"user_id": 整数, "name": 字符串, "status": "yes"|"no"|"maybe"}
   - ai_note: 字符串，简要说明依据或不确定之处（中文，不超过 60 字）
4. kind="performance" 额外字段：name（活动名，必填）、city（城市）
5. attendance 只能引用上面"成员列表"里的 user_id 和 name；截图里有但列表里没有的人忽略。
6. 出席态度推断："我去/+1/收到"→yes；"不去/请假"→no；"看看/再说"→maybe
7. 同事件多次改动只输出最终版。
8. 没有任何排练/路演内容时输出 {"items": []}。
9. 截图里看不清的字段留空字符串。`;

  const userText = `== 上下文 ==
今天日期：${todayStr}（周${weekDay}）
当前用户：id=${user.id} 名字="${user.name}"

成员列表（attendance 仅能引用这里的人）：
${peopleText}

可关联的歌曲列表（song_id 只能从这里选，或 null）：
${songsText}

${hintLine}

接下来是若干张微信群聊截图，请识别其中的排练 / 路演信息，按系统提示输出 JSON。`;

  return { systemPrompt, userText };
}

const parseImgLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => `parse-img-${req.userId || req.ip}`,
  message: { error: "识别太频繁了，等 1 分钟再试" },
});

app.post("/api/parse-images", authRequired, parseImgLimiter, async (req, res) => {
  const { image_urls, song_id: hintRaw } = req.body || {};
  if (!Array.isArray(image_urls) || image_urls.length === 0) {
    return res.status(400).json({ error: "请先上传至少一张截图" });
  }
  if (image_urls.length > 8) {
    return res.status(400).json({ error: "一次最多 8 张截图" });
  }

  const hintSongId = hintRaw ? parseInt(hintRaw, 10) || null : null;
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.userId);
  const friends = db.prepare(`
    SELECT u.id, u.name FROM friendships f
    JOIN users u ON u.id = (CASE WHEN f.user_a_id=? THEN f.user_b_id ELSE f.user_a_id END)
    WHERE f.user_a_id=? OR f.user_b_id=?
  `).all(req.userId, req.userId, req.userId);
  const ownedSongs = db.prepare("SELECT id, title, artist FROM songs WHERE owner_id=?").all(req.userId);
  if (ownedSongs.length === 0) {
    return res.status(400).json({ error: "你还不是任何歌曲的车主，请先新建一首歌再上传截图" });
  }

  // 读所有图片转 base64 data URL
  const dataUrls = [];
  for (const u of image_urls) {
    const fp = imagePathFromUrl(u);
    if (!fp) return res.status(400).json({ error: `非法图片地址：${u}` });
    const du = imageToDataUrl(fp);
    if (!du) return res.status(400).json({ error: `图片不存在：${u}` });
    dataUrls.push(du);
  }

  const { systemPrompt, userText } = buildVisionMessages({ user, friends, songs: ownedSongs, hintSongId });

  // 多模态 messages：智谱官方示例图片在前、文字在后；system 会被合并到 user 文本前面
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        ...dataUrls.map((u) => ({ type: "image_url", image_url: { url: u } })),
        { type: "text", text: userText },
      ],
    },
  ];

  let raw;
  try {
    raw = await callAI(messages, {
      model: AI_VISION_MODEL,
      jsonMode: false,
      maxTokens: 4000,
      temperature: 0.3,
      mergeSystemIntoUser: true,  // 智谱 GLM-4V 不支持 system 角色
    });
  } catch (e) {
    console.error("[parse-images] AI 调用失败:", e.message);
    return res.status(e.statusCode || 502).json({ error: e.message || "AI 调用失败" });
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    console.error("[parse-images] AI 输出非 JSON:", raw.slice(0, 500));
    return res.status(502).json({ error: "AI 输出不是合法 JSON，请重试或换张清晰的图" });
  }

  const items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
  const validSongIds = new Set(ownedSongs.map((s) => s.id));
  const validUserIds = new Set([user.id, ...friends.map((f) => f.id)]);

  const insertStmt = db.prepare(`
    INSERT INTO pending_items (user_id, kind, song_id, data, raw_text, ai_note, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const created = [];
  const raw_text_marker = `[截图识别] ${image_urls.join(" ")}`;
  const tx = db.transaction((arr) => {
    for (const it of arr) {
      const kind = it.kind === "performance" ? "performance" : "rehearsal";
      if (!it.date) continue;
      const songId = validSongIds.has(it.song_id) ? it.song_id : (hintSongId && validSongIds.has(hintSongId) ? hintSongId : null);
      const att = Array.isArray(it.attendance)
        ? it.attendance.filter((a) => a && validUserIds.has(a.user_id) && ["yes", "no", "maybe"].includes(a.status))
        : [];
      const data = {
        kind,
        song_id: songId,
        song_title_guess: (it.song_title_guess || "").toString().slice(0, 100),
        date: (it.date || "").toString().slice(0, 20),
        time: (it.time || "").toString().slice(0, 10),
        location: (it.location || "").toString().slice(0, 200),
        outfit: (it.outfit || "").toString().slice(0, 200),
        notes: (it.notes || "").toString().slice(0, 500),
        attendance: att,
      };
      if (kind === "performance") {
        data.name = (it.name || it.song_title_guess || "未命名活动").toString().slice(0, 100);
        data.city = (it.city || "").toString().slice(0, 50);
      }
      const r = insertStmt.run(
        req.userId, kind, songId,
        JSON.stringify(data),
        raw_text_marker.slice(0, 5000),
        (it.ai_note || "").toString().slice(0, 500),
        now()
      );
      created.push({ id: r.lastInsertRowid, kind, ...data });
    }
  });
  tx(items);

  res.json({ created, count: created.length });
});

// 我的待确认列表
app.get("/api/pending", authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT pi.*, s.title AS song_title, s.artist AS song_artist
    FROM pending_items pi
    LEFT JOIN songs s ON s.id = pi.song_id
    WHERE pi.user_id = ? AND pi.status = 'pending'
    ORDER BY pi.created_at DESC
  `).all(req.userId);
  const items = rows.map((r) => {
    let data = {};
    try { data = JSON.parse(r.data); } catch {}
    return {
      id: r.id,
      kind: r.kind,
      song_id: r.song_id,
      song_title: r.song_title,
      song_artist: r.song_artist,
      ai_note: r.ai_note,
      created_at: r.created_at,
      data,
    };
  });
  res.json({ items });
});

// 修改一条待确认项（字段或换关联歌曲）
app.patch("/api/pending/:id", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = db.prepare("SELECT * FROM pending_items WHERE id=?").get(id);
  if (!item) return res.status(404).json({ error: "待确认项不存在" });
  if (item.user_id !== req.userId) return res.status(403).json({ error: "无权操作" });
  if (item.status !== "pending") return res.status(400).json({ error: "已处理，无法修改" });
  const updates = [];
  const args = [];
  if (req.body && req.body.data && typeof req.body.data === "object") {
    updates.push("data=?");
    args.push(JSON.stringify(req.body.data));
  }
  if (req.body && req.body.song_id !== undefined) {
    if (req.body.song_id === null) {
      updates.push("song_id=NULL");
    } else {
      const sid = parseInt(req.body.song_id, 10);
      const owned = db.prepare("SELECT 1 FROM songs WHERE id=? AND owner_id=?").get(sid, req.userId);
      if (!owned) return res.status(400).json({ error: "歌曲不存在或你不是车主" });
      updates.push("song_id=?");
      args.push(sid);
    }
  }
  if (updates.length === 0) return res.json({ ok: true });
  args.push(id);
  db.prepare(`UPDATE pending_items SET ${updates.join(", ")} WHERE id=?`).run(...args);
  res.json({ ok: true });
});

// 确认 → 写进真正的 rehearsals / performances 表
app.post("/api/pending/:id/confirm", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = db.prepare("SELECT * FROM pending_items WHERE id=?").get(id);
  if (!item) return res.status(404).json({ error: "待确认项不存在" });
  if (item.user_id !== req.userId) return res.status(403).json({ error: "无权操作" });
  if (item.status !== "pending") return res.status(400).json({ error: "已处理" });

  let data;
  try { data = JSON.parse(item.data); } catch { data = {}; }
  if (req.body && req.body.data && typeof req.body.data === "object") {
    data = { ...data, ...req.body.data };
  }
  let songId = item.song_id;
  if (req.body && req.body.song_id !== undefined && req.body.song_id !== null) {
    songId = parseInt(req.body.song_id, 10);
  }
  if (!songId) return res.status(400).json({ error: "请先选择关联歌曲" });
  const song = db.prepare("SELECT * FROM songs WHERE id=?").get(songId);
  if (!song) return res.status(404).json({ error: "歌曲不存在" });
  if (song.owner_id !== req.userId) return res.status(403).json({ error: "你不是这首歌的车主" });
  if (!data.date) return res.status(400).json({ error: "日期不能为空" });

  let newId;
  if (item.kind === "rehearsal") {
    const r = db.prepare(`
      INSERT INTO rehearsals (song_id, date, time, location, outfit, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(songId, data.date, data.time || "", data.location || "", data.outfit || "", data.notes || "", now());
    newId = r.lastInsertRowid;
    saveAttendance("rehearsal", newId, data.attendance || [], songId);
  } else {
    if (!data.name) return res.status(400).json({ error: "路演活动名不能为空" });
    const r = db.prepare(`
      INSERT INTO performances (song_id, name, city, date, time, location, outfit, status, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(songId, data.name, data.city || "", data.date, data.time || "", data.location || "", data.outfit || "", "pending_submit", data.notes || "", now());
    newId = r.lastInsertRowid;
    saveAttendance("performance", newId, data.attendance || [], songId);
  }

  db.prepare("UPDATE pending_items SET status='confirmed', resolved_at=?, song_id=? WHERE id=?")
    .run(now(), songId, id);

  res.json({ ok: true, kind: item.kind, id: newId, song_id: songId });
});

// 拒绝（不入库，标记 rejected）
app.delete("/api/pending/:id", authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = db.prepare("SELECT * FROM pending_items WHERE id=?").get(id);
  if (!item) return res.status(404).json({ error: "待确认项不存在" });
  if (item.user_id !== req.userId) return res.status(403).json({ error: "无权操作" });
  db.prepare("UPDATE pending_items SET status='rejected', resolved_at=? WHERE id=?")
    .run(now(), id);
  res.json({ ok: true });
});

// ==================== 文件上传 ====================
// 限流：单用户每分钟最多 20 次上传
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => `upload-${req.userId || req.ip}`,
  message: { error: "上传太频繁，稍等一下" },
});

app.post("/api/upload", authRequired, uploadLimiter, (req, res) => {
  uploader.array("files", 12)(req, res, (err) => {
    if (err) {
      // multer 错误细分
      let msg = err && err.message ? err.message : "上传失败";
      if (err.code === "LIMIT_FILE_SIZE") msg = "单张图片不能超过 20MB（建议在客户端压缩后再传）";
      if (err.code === "LIMIT_FILE_COUNT") msg = "一次最多 12 张";
      if (err.code === "LIMIT_UNEXPECTED_FILE") msg = "字段名不对，应该是 files";
      console.error("[upload] 错误:", err.code || "(no code)", err.message);
      return res.status(400).json({ error: msg });
    }
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: "没收到文件，请检查是否选了图" });
    const urls = files.map((f) => `/uploads/${f.filename}`);
    res.json({ urls });
  });
});

// ==================== 错误处理 ====================
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "服务器内部错误" });
});
app.use("/api/*", (req, res) => res.status(404).json({ error: "API 不存在" }));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`🚀 K-pop server v2 running on http://127.0.0.1:${PORT}`);
});
