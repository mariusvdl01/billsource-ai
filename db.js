// ═══════════════════════════════════════════
// DATABASE LAYER — PostgreSQL via pg
// Falls back to in-memory if DATABASE_URL
// is not set (safe for dev / first deploy)
// ═══════════════════════════════════════════

const USE_DB = !!process.env.DATABASE_URL;
let pool = null;

if (USE_DB) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// ── In-memory fallback store ─────────────
const memUsers    = {};
const memSessions = {};

// ── Schema bootstrap ─────────────────────
async function initDb() {
  if (!USE_DB) { console.log('DB: in-memory mode'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email           TEXT PRIMARY KEY,
      name            TEXT,
      avatar          TEXT,
      google_id       TEXT,
      plan            TEXT        NOT NULL DEFAULT 'free',
      messages_used   INTEGER     NOT NULL DEFAULT 0,
      messages_limit  INTEGER     NOT NULL DEFAULT 10,
      billing_cycle   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid         TEXT PRIMARY KEY,
      user_email  TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_email   ON sessions(user_email);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
  console.log('DB: PostgreSQL schema ready');
}

// ── upsertUser ───────────────────────────
async function upsertUser(profile, defaultPlan = 'free') {
  const PLAN_LIMITS = {free:10,student:100,professional:300,business:1000,enterprise:5000};
  const limit = PLAN_LIMITS[defaultPlan] || 10;

  if (!USE_DB) {
    if (!memUsers[profile.email]) {
      memUsers[profile.email] = {
        email: profile.email, name: profile.name,
        avatar: profile.picture, google_id: profile.id,
        plan: defaultPlan, messages_used: 0,
        messages_limit: limit, billing_cycle: new Date().toISOString()
      };
    } else {
      memUsers[profile.email].name   = profile.name;
      memUsers[profile.email].avatar = profile.picture;
    }
    return memUsers[profile.email];
  }

  const r = await pool.query(`
    INSERT INTO users (email,name,avatar,google_id,plan,messages_limit,billing_cycle)
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (email) DO UPDATE SET
      name=EXCLUDED.name, avatar=EXCLUDED.avatar, updated_at=NOW()
    RETURNING *
  `, [profile.email, profile.name, profile.picture, profile.id, defaultPlan, limit]);
  return r.rows[0];
}

// ── getUser ──────────────────────────────
async function getUser(email) {
  if (!USE_DB) return memUsers[email] || null;
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  return r.rows[0] || null;
}

// ── upgradePlan ──────────────────────────
async function upgradePlan(email, planName, messagesLimit) {
  if (!USE_DB) {
    if (memUsers[email]) {
      memUsers[email].plan = planName;
      memUsers[email].messages_limit = messagesLimit;
      memUsers[email].messages_used  = 0;
    }
    return;
  }
  await pool.query(`
    UPDATE users SET plan=$2,messages_limit=$3,messages_used=0,
      billing_cycle=NOW(),updated_at=NOW()
    WHERE email=$1
  `, [email, planName, messagesLimit]);
}

// ── downgradePlan ────────────────────────
async function downgradePlan(email) {
  if (!USE_DB) {
    if (memUsers[email]) { memUsers[email].plan='free'; memUsers[email].messages_limit=10; }
    return;
  }
  await pool.query(`
    UPDATE users SET plan='free',messages_limit=10,updated_at=NOW() WHERE email=$1
  `, [email]);
}

// ── incrementMessages ────────────────────
async function incrementMessages(email) {
  if (!USE_DB) {
    if (memUsers[email]) memUsers[email].messages_used++;
    const u = memUsers[email] || {messages_used:1, messages_limit:10};
    return {messages_used: u.messages_used, messages_limit: u.messages_limit};
  }
  const r = await pool.query(`
    UPDATE users SET messages_used=messages_used+1,updated_at=NOW()
    WHERE email=$1
    RETURNING messages_used,messages_limit
  `, [email]);
  return r.rows[0];
}

// ── resetMonthlyUsage ────────────────────
async function resetMonthlyUsage() {
  if (!USE_DB) {
    const cutoff = Date.now() - 30*24*60*60*1000;
    Object.values(memUsers).forEach(u => {
      if (new Date(u.billing_cycle).getTime() < cutoff) {
        u.messages_used = 0; u.billing_cycle = new Date().toISOString();
      }
    });
    return;
  }
  await pool.query(`
    UPDATE users SET messages_used=0,billing_cycle=NOW(),updated_at=NOW()
    WHERE billing_cycle < NOW() - INTERVAL '30 days'
  `);
}

// ── createSession ────────────────────────
async function createSession(sid, email) {
  if (!USE_DB) {
    memSessions[sid] = {email, expires: Date.now() + 7*24*60*60*1000};
    return;
  }
  await pool.query(`
    INSERT INTO sessions (sid,user_email,expires_at)
    VALUES ($1,$2,NOW()+INTERVAL '7 days')
    ON CONFLICT (sid) DO UPDATE SET expires_at=NOW()+INTERVAL '7 days'
  `, [sid, email]);
}

// ── getSession ───────────────────────────
async function getSession(sid) {
  if (!USE_DB) {
    const s = memSessions[sid];
    if (!s || s.expires < Date.now()) return null;
    const u = memUsers[s.email];
    if (!u) return null;
    return { ...u, sid };
  }
  const r = await pool.query(`
    SELECT s.sid, u.*
    FROM sessions s JOIN users u ON u.email=s.user_email
    WHERE s.sid=$1 AND s.expires_at>NOW()
  `, [sid]);
  return r.rows[0] || null;
}

// ── deleteSession ────────────────────────
async function deleteSession(sid) {
  if (!USE_DB) { delete memSessions[sid]; return; }
  await pool.query('DELETE FROM sessions WHERE sid=$1', [sid]);
}

// ── cleanExpiredSessions ─────────────────
async function cleanExpiredSessions() {
  if (!USE_DB) {
    const now = Date.now();
    Object.keys(memSessions).forEach(sid => {
      if (memSessions[sid].expires < now) delete memSessions[sid];
    });
    return;
  }
  await pool.query('DELETE FROM sessions WHERE expires_at<NOW()');
}

module.exports = {
  initDb, getUser, upsertUser,
  upgradePlan, downgradePlan, incrementMessages,
  resetMonthlyUsage, createSession, getSession,
  deleteSession, cleanExpiredSessions
};
