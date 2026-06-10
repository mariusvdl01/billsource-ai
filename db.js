// ═══════════════════════════════════════════
// DATABASE LAYER — PostgreSQL via pg
// Crash-safe: falls back to in-memory if DB
// is unreachable — server always starts
// ═══════════════════════════════════════════

let pool = null;
let useDb = false;

// ── In-memory fallback store ─────────────
const memUsers    = {};
const memSessions = {};

// ── Try to connect ───────────────────────
async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log('DB: in-memory mode (no DATABASE_URL)');
    return;
  }
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
      max: 5
    });
    // Test the connection
    await pool.query('SELECT 1');
    useDb = true;

    // Create tables
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

      CREATE TABLE IF NOT EXISTS prompt_access_log (
        id          BIGSERIAL PRIMARY KEY,
        user_email  TEXT        NOT NULL,
        plan        TEXT        NOT NULL,
        ip          TEXT,
        user_agent  TEXT,
        accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pal_email ON prompt_access_log(user_email);
      CREATE INDEX IF NOT EXISTS idx_pal_time  ON prompt_access_log(accessed_at);

      CREATE TABLE IF NOT EXISTS magic_tokens (
        token       TEXT PRIMARY KEY,
        email       TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_magic_email   ON magic_tokens(email);
      CREATE INDEX IF NOT EXISTS idx_magic_expires ON magic_tokens(expires_at);

      CREATE TABLE IF NOT EXISTS user_reports (
        id          SERIAL PRIMARY KEY,
        email       TEXT NOT NULL,
        name        TEXT NOT NULL,
        score       INTEGER,
        rating      TEXT,
        colour      TEXT,
        source_file TEXT,
        ratios_json TEXT,
        html_report TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_user_reports_email ON user_reports(email);

      CREATE TABLE IF NOT EXISTS user_files (
        id            SERIAL PRIMARY KEY,
        email         TEXT NOT NULL,
        name          TEXT NOT NULL,
        type          TEXT,
        size_bytes    INTEGER,
        content_b64   TEXT,
        analysis_json TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_user_files_email ON user_files(email);

      -- ── Operational dashboard tables ──
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login     TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled       BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_count     INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS billing_events (
        id          BIGSERIAL   PRIMARY KEY,
        email       TEXT        NOT NULL,
        event_type  TEXT        NOT NULL,  -- 'charge.success'|'subscription.create'|'subscription.disable'|'invoice.payment_failed'|'upgrade'|'downgrade'|'manual'
        plan_from   TEXT,
        plan_to     TEXT,
        amount_zar  NUMERIC(10,2),
        paystack_ref TEXT,
        paystack_event TEXT,
        notes       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_billing_email ON billing_events(email);
      CREATE INDEX IF NOT EXISTS idx_billing_type  ON billing_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_billing_at    ON billing_events(created_at);

      CREATE TABLE IF NOT EXISTS feature_usage_log (
        id          BIGSERIAL   PRIMARY KEY,
        email       TEXT        NOT NULL,
        feature     TEXT        NOT NULL,  -- 'engine/rate'|'engine/analyse'|'chat'|'file_upload'|'report_save'|'pdf_download'|'xlsx_parse'|'magic_link'
        plan        TEXT,
        metadata    JSONB,
        used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_fuse_email   ON feature_usage_log(email);
      CREATE INDEX IF NOT EXISTS idx_fuse_feature ON feature_usage_log(feature);
      CREATE INDEX IF NOT EXISTS idx_fuse_at      ON feature_usage_log(used_at);

      CREATE TABLE IF NOT EXISTS prompt_reviews (
        id          SERIAL      PRIMARY KEY,
        prompt_key  TEXT        NOT NULL UNIQUE,
        category    TEXT,
        last_used   TIMESTAMPTZ,
        use_count   INTEGER     NOT NULL DEFAULT 0,
        status      TEXT        NOT NULL DEFAULT 'active',  -- 'active'|'review'|'sunset'
        notes       TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    \`);
    console.log('DB: PostgreSQL connected and schema ready');

    pool.on('error', err => console.error('DB pool error:', err.message));

  } catch(err) {
    console.error('DB: Connection failed —', err.message);
    console.warn('DB: Falling back to in-memory mode — users will not persist');
    pool = null;
    useDb = false;
  }
}

// ── upsertUser ───────────────────────────
async function upsertUser(profile, defaultPlan = 'free') {
  const LIMITS = {free:10,student:100,professional:300,business:1000,enterprise:5000};
  const limit = LIMITS[defaultPlan] || 10;

  if (!useDb) {
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
  if (!useDb) return memUsers[email] || null;
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  return r.rows[0] || null;
}

// ── upgradePlan ──────────────────────────
async function upgradePlan(email, planName, messagesLimit) {
  if (!useDb) {
    if (memUsers[email]) {
      memUsers[email].plan = planName;
      memUsers[email].messages_limit = messagesLimit;
      memUsers[email].messages_used  = 0;
    }
    return;
  }
  await pool.query(`
    UPDATE users SET plan=$2,messages_limit=$3,messages_used=0,
      billing_cycle=NOW(),updated_at=NOW() WHERE email=$1
  `, [email, planName, messagesLimit]);
}

// ── downgradePlan ────────────────────────
async function downgradePlan(email) {
  if (!useDb) {
    if (memUsers[email]) { memUsers[email].plan='free'; memUsers[email].messages_limit=10; }
    return;
  }
  await pool.query(`UPDATE users SET plan='free',messages_limit=10,updated_at=NOW() WHERE email=$1`, [email]);
}

// ── incrementMessages ────────────────────
async function incrementMessages(email) {
  if (!useDb) {
    if (memUsers[email]) memUsers[email].messages_used++;
    const u = memUsers[email] || {messages_used:1,messages_limit:10};
    return {messages_used:u.messages_used, messages_limit:u.messages_limit};
  }
  const r = await pool.query(`
    UPDATE users SET messages_used=messages_used+1,updated_at=NOW()
    WHERE email=$1 RETURNING messages_used,messages_limit
  `, [email]);
  return r.rows[0];
}

// ── resetMonthlyUsage ────────────────────
async function resetMonthlyUsage() {
  if (!useDb) {
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
  if (!useDb) {
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
  if (!useDb) {
    const s = memSessions[sid];
    if (!s || s.expires < Date.now()) return null;
    const u = memUsers[s.email];
    if (!u) return null;
    return {...u, sid};
  }
  const r = await pool.query(`
    SELECT s.sid, u.* FROM sessions s
    JOIN users u ON u.email=s.user_email
    WHERE s.sid=$1 AND s.expires_at>NOW()
  `, [sid]);
  return r.rows[0] || null;
}

// ── deleteSession ────────────────────────
async function deleteSession(sid) {
  if (!useDb) { delete memSessions[sid]; return; }
  await pool.query('DELETE FROM sessions WHERE sid=$1', [sid]);
}

// ── cleanExpiredSessions ─────────────────
async function cleanExpiredSessions() {
  if (!useDb) {
    const now = Date.now();
    Object.keys(memSessions).forEach(sid => {
      if (memSessions[sid].expires < now) delete memSessions[sid];
    });
    return;
  }
  await pool.query('DELETE FROM sessions WHERE expires_at<NOW()');
}

// ── logPromptAccess ──────────────────────
async function logPromptAccess(email, plan, ip, userAgent) {
  if (!useDb) {
    // In-memory: just log to console — no persistence in fallback mode
    console.log(`PROMPT_ACCESS | ${email} | ${plan} | ${ip || 'unknown'}`);
    return;
  }
  try {
    await pool.query(
      `INSERT INTO prompt_access_log (user_email, plan, ip, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [email, plan, ip || null, userAgent || null]
    );
  } catch(err) {
    // Non-fatal — log the error but don't break the prompt response
    console.error('logPromptAccess error:', err.message);
  }
}

// ── getPromptAccessLog (admin use) ───────
async function getPromptAccessLog(limit = 100) {
  if (!useDb) return [];
  const r = await pool.query(
    `SELECT user_email, plan, ip, accessed_at
     FROM prompt_access_log
     ORDER BY accessed_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

// ── getOrCreateUser (magic link path) ────
// Like upsertUser but accepts {email, name, provider} instead of Google profile shape
async function getOrCreateUser({ email, name, provider }) {
  const profile = { email, name, picture: null, id: null };
  return upsertUser(profile, 'free');
}

// ── storeMagicToken ───────────────────────
const memMagicTokens = {};

async function storeMagicToken(email, token, expiresAt) {
  if (!useDb) {
    memMagicTokens[token] = { email, expiresAt };
    return;
  }
  // Clean expired tokens for this email first (housekeeping)
  await pool.query(
    `DELETE FROM magic_tokens WHERE email=$1 AND expires_at < NOW()`,
    [email]
  );
  await pool.query(
    `INSERT INTO magic_tokens (token, email, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET email=EXCLUDED.email, expires_at=EXCLUDED.expires_at`,
    [token, email, expiresAt]
  );
}

// ── verifyMagicToken ──────────────────────
// Returns email if valid and not expired, null otherwise. Deletes token on use.
async function verifyMagicToken(token) {
  if (!useDb) {
    const t = memMagicTokens[token];
    if (!t) return null;
    if (new Date() > t.expiresAt) { delete memMagicTokens[token]; return null; }
    delete memMagicTokens[token];
    return t.email;
  }
  const r = await pool.query(
    `DELETE FROM magic_tokens WHERE token=$1 AND expires_at > NOW() RETURNING email`,
    [token]
  );
  return r.rows[0]?.email || null;
}

// ── Reports ───────────────────────────────
const memReports = {};

async function saveReport(email, { name, score, rating, colour, sourceFile, ratiosJson, htmlReport }) {
  if (!useDb) {
    if (!memReports[email]) memReports[email] = [];
    const item = { id: Date.now(), email, name, score, rating, colour,
      source_file: sourceFile||null, ratios_json: ratiosJson||null,
      created_at: new Date().toISOString() };
    memReports[email].push(item);
    return item;
  }
  const r = await pool.query(
    `INSERT INTO user_reports(email,name,score,rating,colour,source_file,ratios_json,html_report)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id,name,score,rating,colour,source_file,created_at`,
    [email, name, score||null, rating||null, colour||null,
     sourceFile||null, ratiosJson||null, htmlReport||null]
  );
  return r.rows[0];
}

async function listReports(email) {
  if (!useDb) {
    return (memReports[email] || []).slice().reverse();
  }
  const r = await pool.query(
    `SELECT id,name,score,rating,colour,source_file,ratios_json,created_at
     FROM user_reports WHERE email=$1 ORDER BY created_at DESC LIMIT 100`,
    [email]
  );
  return r.rows;
}

async function getReport(email, id) {
  if (!useDb) {
    return (memReports[email] || []).find(r => r.id === Number(id)) || null;
  }
  const r = await pool.query(
    `SELECT * FROM user_reports WHERE id=$1 AND email=$2`,
    [id, email]
  );
  return r.rows[0] || null;
}

async function deleteReport(email, id) {
  if (!useDb) {
    if (memReports[email]) memReports[email] = memReports[email].filter(r => r.id !== Number(id));
    return;
  }
  await pool.query(`DELETE FROM user_reports WHERE id=$1 AND email=$2`, [id, email]);
}

// ── Files ─────────────────────────────────
const memFiles = {};

async function saveFile(email, { name, type, sizeBytes, contentB64, analysisJson }) {
  if (contentB64 && contentB64.length > 5_500_000) throw new Error('File too large (max ~4MB)');
  if (!useDb) {
    if (!memFiles[email]) memFiles[email] = [];
    const item = { id: Date.now(), name, type: type||null,
      size_bytes: sizeBytes||0, analysis_json: analysisJson||null,
      created_at: new Date().toISOString() };
    memFiles[email].push(item);
    return item;
  }
  const r = await pool.query(
    `INSERT INTO user_files(email,name,type,size_bytes,content_b64,analysis_json)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING id,name,type,size_bytes,created_at`,
    [email, name, type||null, sizeBytes||0, contentB64||null, analysisJson||null]
  );
  return r.rows[0];
}

async function listFiles(email) {
  if (!useDb) {
    return (memFiles[email] || []).slice().reverse();
  }
  const r = await pool.query(
    `SELECT id,name,type,size_bytes,analysis_json,created_at
     FROM user_files WHERE email=$1 ORDER BY created_at DESC LIMIT 100`,
    [email]
  );
  return r.rows;
}

async function deleteFile(email, id) {
  if (!useDb) {
    if (memFiles[email]) memFiles[email] = memFiles[email].filter(f => f.id !== Number(id));
    return;
  }
  await pool.query(`DELETE FROM user_files WHERE id=$1 AND email=$2`, [id, email]);
}

// ── Operational dashboard functions ──────────────────────────────

async function updateLastLogin(email) {
  if (!pool) return;
  await pool.query('UPDATE users SET last_login=NOW(), updated_at=NOW() WHERE email=$1', [email]);
}

async function setUserDisabled(email, disabled, reason='') {
  if (pool) {
    await pool.query(
      'UPDATE users SET disabled=$2, disabled_reason=$3, updated_at=NOW() WHERE email=$1',
      [email, disabled, reason || null]
    );
  } else if (memUsers[email]) {
    memUsers[email].disabled = disabled;
    memUsers[email].disabled_reason = reason;
  }
}

async function logBillingEvent(email, eventType, planFrom, planTo, amountZar, paystackRef, paystackEvent, notes) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO billing_events(email,event_type,plan_from,plan_to,amount_zar,paystack_ref,paystack_event,notes)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [email, eventType, planFrom||null, planTo||null, amountZar||null, paystackRef||null, paystackEvent||null, notes||null]
  );
}

async function logFeatureUse(email, feature, plan, metadata) {
  if (!pool) return;
  pool.query(
    `INSERT INTO feature_usage_log(email,feature,plan,metadata) VALUES($1,$2,$3,$4)`,
    [email, feature, plan||null, metadata ? JSON.stringify(metadata) : null]
  ).catch(() => {}); // fire-and-forget, non-blocking
}

async function incrementChatCount(email) {
  if (pool) {
    pool.query('UPDATE users SET chat_count=chat_count+1, updated_at=NOW() WHERE email=$1', [email])
      .catch(() => {});
  } else if (memUsers[email]) { memUsers[email].chat_count = (memUsers[email].chat_count||0)+1; }
}

async function getOperationalUsers(limit=200) {
  if (!pool) return Object.values(memUsers).slice(0, limit);
  const r = await pool.query(`
    SELECT u.email, u.name, u.avatar, u.plan, u.messages_used, u.messages_limit,
           u.chat_count, u.disabled, u.disabled_reason,
           u.billing_cycle, u.last_login, u.created_at, u.updated_at,
           COUNT(DISTINCT ur.id)::int AS report_count,
           COUNT(DISTINCT uf.id)::int AS file_count
    FROM users u
    LEFT JOIN user_reports ur ON ur.email = u.email
    LEFT JOIN user_files   uf ON uf.email = u.email
    GROUP BY u.email
    ORDER BY u.updated_at DESC NULLS LAST
    LIMIT $1
  `, [limit]);
  return r.rows;
}

async function getOperationalUserDetail(email) {
  if (!pool) return null;
  const [user, billing, features, reports, prompts] = await Promise.all([
    pool.query('SELECT * FROM users WHERE email=$1', [email]),
    pool.query('SELECT * FROM billing_events WHERE email=$1 ORDER BY created_at DESC LIMIT 50', [email]),
    pool.query(`SELECT feature, COUNT(*)::int as uses, MAX(used_at) as last_used
                FROM feature_usage_log WHERE email=$1
                GROUP BY feature ORDER BY uses DESC`, [email]),
    pool.query('SELECT id,name,score,colour,source_file,created_at FROM user_reports WHERE email=$1 ORDER BY created_at DESC LIMIT 20', [email]),
    pool.query(`SELECT prompt_key,plan,COUNT(*)::int as uses, MAX(accessed_at) as last_used
                FROM prompt_access_log WHERE user_email=$1
                GROUP BY prompt_key,plan ORDER BY uses DESC LIMIT 30`, [email]),
  ]);
  return {
    user:     user.rows[0] || null,
    billing:  billing.rows,
    features: features.rows,
    reports:  reports.rows,
    prompts:  prompts.rows,
  };
}

async function getPromptReviewList() {
  if (!pool) return [];
  // Join prompt_access_log counts with prompt_reviews table
  const r = await pool.query(`
    SELECT
      pal.prompt_key,
      COUNT(*)::int          AS total_uses,
      COUNT(DISTINCT pal.user_email)::int AS unique_users,
      MAX(pal.accessed_at)   AS last_used,
      pr.status,
      pr.notes,
      pr.updated_at          AS review_updated_at
    FROM prompt_access_log pal
    LEFT JOIN prompt_reviews pr ON pr.prompt_key = pal.prompt_key
    GROUP BY pal.prompt_key, pr.status, pr.notes, pr.updated_at
    ORDER BY total_uses DESC
  `);
  return r.rows;
}

async function setPromptStatus(promptKey, status, notes) {
  if (!pool) return;
  await pool.query(`
    INSERT INTO prompt_reviews(prompt_key, status, notes, updated_at)
    VALUES($1,$2,$3,NOW())
    ON CONFLICT(prompt_key) DO UPDATE SET status=$2, notes=$3, updated_at=NOW()
  `, [promptKey, status, notes||null]);
}

module.exports = {
  // Core
  initDb, getUser, upsertUser, getOrCreateUser,
  upgradePlan, downgradePlan, incrementMessages,
  resetMonthlyUsage,
  // Sessions
  createSession, getSession, deleteSession, cleanExpiredSessions,
  // Magic link
  storeMagicToken, verifyMagicToken,
  // Prompts
  logPromptAccess, getPromptAccessLog,
  // Reports
  saveReport, listReports, getReport, deleteReport,
  // Operational dashboard
  updateLastLogin, setUserDisabled, logBillingEvent, logFeatureUse,
  incrementChatCount, getOperationalUsers, getOperationalUserDetail,
  getPromptReviewList, setPromptStatus,
  // Files
  saveFile, listFiles, deleteFile,
  // Pool reference (used by server.js for direct queries if needed)
  get pool() { return pool; }
};
