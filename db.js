// ═══════════════════════════════════════════
// DATABASE LAYER — PostgreSQL via pg
// Railway: add a Postgres service, copy
// DATABASE_URL into your app's variables
// ═══════════════════════════════════════════
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

// ── Schema bootstrap ─────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email           TEXT PRIMARY KEY,
      name            TEXT,
      avatar          TEXT,
      google_id       TEXT,
      plan            TEXT    NOT NULL DEFAULT 'free',
      messages_used   INTEGER NOT NULL DEFAULT 0,
      messages_limit  INTEGER NOT NULL DEFAULT 10,
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

    CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(user_email);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
  console.log('DB: schema ready');
}

// ── User operations ──────────────────────
async function getUser(email) {
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  return r.rows[0] || null;
}

async function upsertUser(profile, defaultPlan = 'free') {
  const limit = parseInt(process.env[`PLAN_LIMIT_${defaultPlan.toUpperCase()}`]) || 10;
  const r = await pool.query(`
    INSERT INTO users (email, name, avatar, google_id, plan, messages_limit, billing_cycle)
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (email) DO UPDATE SET
      name       = EXCLUDED.name,
      avatar     = EXCLUDED.avatar,
      updated_at = NOW()
    RETURNING *
  `, [profile.email, profile.name, profile.picture, profile.id, defaultPlan, limit]);
  return r.rows[0];
}

async function upgradePlan(email, planName, messagesLimit) {
  await pool.query(`
    UPDATE users SET
      plan           = $2,
      messages_limit = $3,
      messages_used  = 0,
      billing_cycle  = NOW(),
      updated_at     = NOW()
    WHERE email = $1
  `, [email, planName, messagesLimit]);
}

async function downgradePlan(email) {
  await pool.query(`
    UPDATE users SET
      plan           = 'free',
      messages_limit = 10,
      updated_at     = NOW()
    WHERE email = $1
  `, [email]);
}

async function incrementMessages(email) {
  const r = await pool.query(`
    UPDATE users SET
      messages_used = messages_used + 1,
      updated_at    = NOW()
    WHERE email = $1
    RETURNING messages_used, messages_limit
  `, [email]);
  return r.rows[0];
}

async function resetMonthlyUsage() {
  const r = await pool.query(`
    UPDATE users SET
      messages_used = 0,
      billing_cycle = NOW(),
      updated_at    = NOW()
    WHERE billing_cycle < NOW() - INTERVAL '30 days'
    RETURNING email
  `);
  if (r.rowCount > 0) console.log(`DB: reset ${r.rowCount} users monthly usage`);
}

// ── Session operations ───────────────────
async function createSession(sid, email) {
  await pool.query(`
    INSERT INTO sessions (sid, user_email, expires_at)
    VALUES ($1, $2, NOW() + INTERVAL '7 days')
    ON CONFLICT (sid) DO UPDATE SET expires_at = NOW() + INTERVAL '7 days'
  `, [sid, email]);
}

async function getSession(sid) {
  const r = await pool.query(`
    SELECT s.sid, u.*
    FROM sessions s
    JOIN users u ON u.email = s.user_email
    WHERE s.sid = $1
      AND s.expires_at > NOW()
  `, [sid]);
  return r.rows[0] || null;
}

async function deleteSession(sid) {
  await pool.query('DELETE FROM sessions WHERE sid=$1', [sid]);
}

async function cleanExpiredSessions() {
  const r = await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  if (r.rowCount > 0) console.log(`DB: cleaned ${r.rowCount} expired sessions`);
}

module.exports = {
  initDb,
  getUser, upsertUser, upgradePlan, downgradePlan,
  incrementMessages, resetMonthlyUsage,
  createSession, getSession, deleteSession, cleanExpiredSessions
};
