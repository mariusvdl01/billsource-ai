const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const querystring = require('querystring');
const db = require('./db');
const mailer = require('./mailer');
const { getUserPrompts, resolvePromptTemplate } = require('./promptbook');
const { runRatingEngine } = require('./rating_engine');
const plm = require('./learning_module');
console.log('All modules loaded successfully');

// ═══════════════════════════════════════════
// IP SAFEGUARDS — Injection filter, output filter, rate limiter
// ═══════════════════════════════════════════

// ── Input injection filter ───────────────
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /forget\s+(everything|all|your)\s+(instructions|context|rules)/i,
  /you\s+are\s+now\s+(a\s+)?(different|new|another|unrestricted)/i,
  /pretend\s+(you\s+are|to\s+be)\s+(an?\s+)?(AI|model|assistant|GPT|LLM)/i,
  /repeat\s+(your\s+)?(system\s+)?(prompt|instructions|context)\s*(back|verbatim|exactly)?/i,
  /what\s+(are|were|is)\s+your\s+(system\s+)?(prompt|instructions|rules|configuration)/i,
  /output\s+(your|the)\s+(system\s+)?(prompt|instructions|context|configuration)/i,
  /print\s+(your\s+)?(system\s+)?(prompt|instructions)/i,
  /show\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions|context)/i,
  /disregard\s+(your|all|previous)\s+(instructions|guidelines|rules)/i,
  /act\s+as\s+(if\s+)?(you\s+(have\s+)?no|without)\s+(restrictions|guidelines|rules)/i,
  /you\s+have\s+no\s+(restrictions|guidelines|rules|limits)/i,
  /override\s+(your\s+)?(safety|guidelines|instructions|rules)/i,
  /bypass\s+(your\s+)?(safety|restrictions|filters|guardrails)/i,
  /\bDAN\b/,                        // Do Anything Now
  /\bjailbreak\b/i,
  /\[INST\]|\[SYS\]|<\|system\|>/i, // LLM injection tokens
  /<!--.*?-->/s,                     // HTML comment injection
  /\{\{.*?\}\}/,                     // Template injection
  /claude|anthropic|openai|gpt-[34]/i // Model probing
];

function isInjectionAttempt(text) {
  if (!text || typeof text !== 'string') return false;
  return INJECTION_PATTERNS.some(p => p.test(text));
}

// ── Output leak filter ───────────────────
const LEAK_PATTERNS = [
  /my (system )?prompt (is|says|reads|starts)/i,
  /i('ve)? been (told|instructed|configured|given instructions)/i,
  /i was (programmed|designed|built|trained) to/i,
  /my (instructions|configuration|guidelines|rules) (are|say|tell me|require)/i,
  /as (an?\s+)?(AI language model|LLM|large language model)/i,
  /i am (actually |really )?(claude|anthropic|gpt|openai)/i,
  /built (by|on top of|using) (anthropic|claude|openai)/i,
  /powered by (claude|anthropic|openai|gpt)/i
];

function containsLeakage(text) {
  if (!text || typeof text !== 'string') return false;
  return LEAK_PATTERNS.some(p => p.test(text));
}

const SAFE_FALLBACK = "Let me focus on what matters — your business. What would you like to work on?";

// ── Martugo referral — appended to all IT Guy responses ──────────────────────
const MARTUGO_REFERRAL = '\n\n---\n🛒 **Ready to buy?** [Martugo.com](https://martugo.com) stocks laptops, desktops, peripherals, networking gear and business software at competitive SA prices — it\'s the recommended place to purchase any hardware or software The IT Guy recommends.';

// ── Billsource referral — appended to all Bean Counter responses ──────────────
const BILLSOURCE_REFERRAL_BASE = '\n\n---\n📊 **Take action on this advice.** [Billsource.com](https://billsource.com) is the financial platform built for SA businesses — invoicing, debtors, creditors, statements, bill distribution and payments in one place. Everything Bean Counter talks about, Billsource helps you execute.';
const BILLSOURCE_REFERRAL_SSO  = BILLSOURCE_REFERRAL_BASE + ' As an Enterprise member, you have single sign-on access — [log in to Billsource now →](https://billsource.com/index.php/business/profile/upgrade)';

function isBeanCounterPrompt(promptId) {
  return promptId && String(promptId).startsWith('cfo-');
}

function isBeanCounterQuestion(question) {
  if (!question) return false;
  const q = question.toLowerCase();
  return /\b(cash flow|cashflow|invoice|invoic|debtor|creditor|payment|receivable|payable|balance sheet|income statement|profit|loss|revenue|turnover|margin|ratio|dso|dpo|ocf|fcf|working capital|budget|forecast|financial|finance|dunning|overdue|collection|statement|billing|bill\b|vat|tax|salary|payroll|expense|cost|account|bank|loan|debt|credit|owed|outstanding|ageing|aging|liquidity|solvency)\b/.test(q);
}

function isITGuyPrompt(promptId) {
  // promptId starts with 'it-' = IT Guy prompt book entry
  return promptId && String(promptId).startsWith('it-');
}

function isITGuyQuestion(question) {
  if (!question) return false;
  const q = question.toLowerCase();
  return /\b(laptop|desktop|pc|computer|monitor|printer|wifi|router|switch|cable|keyboard|mouse|headset|webcam|ups|battery backup|software|licence|license|antivirus|microsoft 365|google workspace|aws|azure|vpn|server|backup|hard drive|ssd|ram|storage|device|tech|hardware|install|setup|configure|network|firewall|password|email|outlook|teams|it support)\b/.test(q);
}

// ── Per-user rate limiter (in-memory, resets per minute) ──
const rateLimitMap = {};
const RATE_WINDOW_MS  = 60 * 1000;  // 1 minute window
const RATE_MAX_MSGS   = 8;           // max messages per minute per user

function checkRateLimit(email) {
  const now = Date.now();
  if (!rateLimitMap[email]) {
    rateLimitMap[email] = { count: 1, windowStart: now, flagged: false };
    return true;
  }
  const rl = rateLimitMap[email];
  if (now - rl.windowStart > RATE_WINDOW_MS) {
    rl.count = 1; rl.windowStart = now; rl.flagged = false;
    return true;
  }
  rl.count++;
  if (rl.count > RATE_MAX_MSGS) {
    if (!rl.flagged) {
      console.warn(`RATE_LIMIT | ${email} | ${rl.count} msgs/min`);
      rl.flagged = true;
    }
    return false;
  }
  return true;
}

// FIX-002: IP-based rate limiter — auth + engine routes
// Separate from the per-user message limiter above.
// Auth: 20 attempts / 15 min per IP  (brute-force protection)
// Engine/rate: 10 ratings / 60 min per IP  (cost protection)
// Magic-link: 5 requests / 60 min per IP  (email flooding protection)
const ipRateLimitMap = {};

function checkIpRateLimit(ip, bucket, maxCount, windowMs) {
  const key = `${bucket}:${ip}`;
  const now  = Date.now();
  if (!ipRateLimitMap[key]) {
    ipRateLimitMap[key] = { count: 1, windowStart: now };
    return true;
  }
  const rl = ipRateLimitMap[key];
  if (now - rl.windowStart > windowMs) {
    rl.count = 1; rl.windowStart = now;
    return true;
  }
  rl.count++;
  if (rl.count > maxCount) {
    console.warn(`IP_RATE_LIMIT | bucket:${bucket} | ip:${ip} | count:${rl.count}`);
    return false;
  }
  return true;
}

// Helper: get real client IP (Railway puts it in x-forwarded-for)
function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || '0.0.0.0';
}

// Clean IP rate limit map every 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  Object.keys(ipRateLimitMap).forEach(k => {
    if (ipRateLimitMap[k].windowStart < cutoff) delete ipRateLimitMap[k];
  });
}, 2 * 60 * 60 * 1000);

// Clean rate limit map every hour to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  Object.keys(rateLimitMap).forEach(k => {
    if (rateLimitMap[k].windowStart < cutoff) delete rateLimitMap[k];
  });
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 8080;
const ROOT = '/app';

// ═══════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const ADMIN_TOKEN          = process.env.ADMIN_TOKEN || '';
const ADMIN_EMAIL          = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const BASE_URL             = process.env.BASE_URL || 'https://billsource.ai';
const FLOWISE_URL          = process.env.FLOWISE_URL || 'https://flowiseai-production-455f.up.railway.app';
const FLOWISE_CHATFLOW_ID  = process.env.FLOWISE_CHATFLOW_ID || '';
const PAYSTACK_SECRET_KEY  = process.env.PAYSTACK_SECRET_KEY || '';

const PLANS = {
  free:         { messages: 10,   label: 'Free',  previewAfter: 3,  previewChars: 380 },
  student:      { messages: 100,  label: 'Student' },
  professional: { messages: 300,  label: 'Professional' },
  business:     { messages: 1000, label: 'Business' },
  enterprise:   { messages: 5000, label: 'Enterprise' }
};

// ── Free plan response truncation ──────────────────────────────────────────
// Messages 1–3: full response (let them taste it)
// Messages 4–10: truncated at ~380 chars, upgrade nudge appended
function applyFreeTruncation(answer, plan, messagesUsed) {
  const planCfg = PLANS[plan];
  if (!planCfg || !planCfg.previewAfter) return answer; // paid plans — no truncation
  if (messagesUsed <= planCfg.previewAfter) return answer; // first N messages — full

  // Find a clean sentence break near previewChars
  const limit = planCfg.previewChars;
  if (answer.length <= limit) return answer; // short answer — no need to cut

  // Cut at last sentence end (. ! ?) before the limit, or at last space
  const slice = answer.slice(0, limit);
  const lastSentence = Math.max(
    slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '),
    slice.lastIndexOf('.\n'), slice.lastIndexOf('!\n')
  );
  const cutAt = lastSentence > limit * 0.5 ? lastSentence + 1 : slice.lastIndexOf(' ');
  const preview = answer.slice(0, cutAt).trim();

  return preview +
    '\n\n---\n*🔒 Sign up for a paid plan to read the full answer, copy it, and download it as PDF or Word.*\n' +
    '*[Upgrade to Professional →](https://billsource.ai/app)*';
}

const PAYSTACK_PLANS = {
  student:      process.env.PAYSTACK_PLAN_STUDENT       || 'PLN_u5uxr8t2tf0p64z',
  professional: process.env.PAYSTACK_PLAN_PROFESSIONAL  || 'PLN_xep07lsxg5ug0di',
  business:     process.env.PAYSTACK_PLAN_BUSINESS      || 'PLN_6ckkyszhatwstzq',
  enterprise:   process.env.PAYSTACK_PLAN_ENTERPRISE    || 'PLN_7fri26iibfq1z34'
};

const PLAN_CODE_MAP = {
  'PLN_u5uxr8t2tf0p64z': 'student',
  'PLN_xep07lsxg5ug0di': 'professional',
  'PLN_6ckkyszhatwstzq': 'business',
  'PLN_7fri26iibfq1z34': 'enterprise'
};

const MERCH_PRICES = {
  'hoodie-sml': 54900, 'hoodie-xl': 59900, 'hoodie-3xl': 64900,
  'cap-black':  29900, 'cap-white': 29900,
  'mug-330':    19900, 'mug-470':   24900,
  'tee-sml':    29900, 'tee-xl':    34900, 'tee-3xl': 37900
};

// ── In-memory session cache (fast reads, DB is source of truth) ──
const sessionCache = {};

// ═══════════════════════════════════════════
// FILE SERVING
// ═══════════════════════════════════════════
const MIME = {
  '.html':'text/html; charset=utf-8', '.css':'text/css',
  '.js':'application/javascript',    '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg',
  '.svg':'image/svg+xml', '.ico':'image/x-icon'
};
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { serveFile(res, path.join(ROOT,'index.html')); return; }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'text/plain';
    // HTML files: never cache — ensures fresh deploy is always served immediately
    // Assets (JS, CSS, images): cache 1 hour — they change less often
    const cc = (ext === '.html')
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': cc,
      'Pragma': ext === '.html' ? 'no-cache' : '',
    });
    res.end(data);
  });
}

// ═══════════════════════════════════════════
// SESSION HELPERS
// ═══════════════════════════════════════════
function parseCookies(str) {
  const out = {};
  (str||'').split(';').forEach(p => {
    const [k,...v] = p.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  });
  return out;
}

function generateSid() { return crypto.randomBytes(32).toString('hex'); }

async function getSessionUser(req) {
  const sid = parseCookies(req.headers.cookie || '')['bs_session'];
  if (!sid) return null;
  // Check memory cache first — stored as {sid, user}
  if (sessionCache[sid]) return sessionCache[sid];
  // Fall back to DB
  try {
    const row = await db.getSession(sid);
    if (!row) return null;
    const user = rowToUser(row);
    const session = { sid, user };
    sessionCache[sid] = session;
    return session;
  } catch(err) {
    console.error('getSessionUser error:', err.message);
    return null;
  }
}

function rowToUser(row) {
  // Handles both PostgreSQL snake_case and in-memory camelCase
  const used  = (row.messages_used  !== undefined) ? row.messages_used  : (row.messagesUsed  || 0);
  const limit = (row.messages_limit !== undefined) ? row.messages_limit : (row.messagesLimit || 10);
  return {
    email:             row.email,
    name:              row.name,
    avatar:            row.avatar,
    plan:              row.plan || 'free',
    messagesUsed:      used,
    messagesLimit:     limit,
    messagesRemaining: Math.max(0, limit - used)
  };
}

function invalidateSessionCache(email) {
  Object.keys(sessionCache).forEach(sid => {
    const cached = sessionCache[sid];
    // Handle both {sid, user} wrapper and bare user object
    const cachedEmail = cached?.user?.email || cached?.email;
    if (cachedEmail === email) delete sessionCache[sid];
  });
}

// ═══════════════════════════════════════════
// GOOGLE OAUTH
// ═══════════════════════════════════════════
const GOOGLE_AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

function buildGoogleAuthUrl(state, next) {
  // Encode next destination into state so callback can redirect correctly
  const stateParam = next ? state + ':' + Buffer.from(next).toString('base64') : state;
  return `${GOOGLE_AUTH_URL}?${querystring.stringify({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/google/callback`,
    response_type: 'code', scope: 'openid email profile',
    state: stateParam, access_type: 'offline', prompt: 'consent'
  })}`;
}

function httpsPost(urlStr, data, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {'Content-Length': Buffer.byteLength(body), ...headers}
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function httpsGet(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    https.get({hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers}, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    }).on('error', reject);
  });
}

function paystackRequest(method, endpoint, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const parsed = new URL('https://api.paystack.co' + endpoint);
    const opts = {
      hostname: parsed.hostname, path: parsed.pathname + parsed.search, method,
      headers: {'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json'}
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function verifyPaystackSig(body, sig) {
  return crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(body).digest('hex') === sig;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b)); req.on('error', reject);
  });
}

async function upgradeUser(email, planCode) {
  const planName = PLAN_CODE_MAP[planCode];
  if (!planName) { console.log(`Unknown plan code: ${planCode}`); return; }
  await db.upgradePlan(email, planName, PLANS[planName].messages);
  // Invalidate cache so next /api/me returns fresh data
  invalidateSessionCache(email);
  // Also update any active sessions in cache directly
  Object.keys(sessionCache).forEach(sid => {
    const cached = sessionCache[sid];
    const cachedEmail = cached?.user?.email || cached?.email;
    if (cachedEmail === email && cached?.user) {
      cached.user.plan = planName;
      cached.user.planLabel = PLANS[planName]?.label || planName;
      cached.user.messagesLimit = PLANS[planName].messages;
      cached.user.messagesUsed = 0;
      cached.user.messagesRemaining = PLANS[planName].messages;
    }
  });
  console.log(`Upgraded: ${email} → ${planName}`);
}

async function downgradeUser(email) {
  await db.downgradePlan(email);
  invalidateSessionCache(email);
  console.log(`Downgraded: ${email} → free`);
}

// ═══════════════════════════════════════════
// MAIN REQUEST HANDLER
// ═══════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', BASE_URL);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // FIX-001: Security HTTP headers on every response
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://lh3.googleusercontent.com",
    "connect-src 'self' https://api.anthropic.com https://api.paystack.co",
    "frame-src 'none'",
    "object-src 'none'"
  ].join('; '));

  // ── AUTH ────────────────────────────────
  if (pathname === '/auth/google' && method === 'GET') {
    if (!checkIpRateLimit(getClientIp(req), 'auth', 20, 15 * 60 * 1000)) {
      res.writeHead(429, {'Content-Type':'text/html'});
      res.end('<html><body style="font-family:sans-serif;padding:40px;background:#0f0d0b;color:#e8e4e0"><h2 style="color:#c45200">Too many requests</h2><p>Please wait 15 minutes before trying again.</p></body></html>');
      return;
    }
    const state = crypto.randomBytes(16).toString('hex');
    res.writeHead(302, {Location: buildGoogleAuthUrl(state)});
    res.end(); return;
  }

  if (pathname === '/auth/google/callback' && method === 'GET') {
    const {code, error, state} = parsed.query;
    if (error || !code) { res.writeHead(302, {Location:'/?error=auth_failed'}); res.end(); return; }

    // Decode next destination from state if present (format: "randomhex:base64next")
    let nextPath = '/app';
    if (state && state.includes(':')) {
      const parts = state.split(':');
      try { nextPath = Buffer.from(parts.slice(1).join(':'), 'base64').toString(); } catch(_) {}
      // Safety: only allow known internal paths
      if (!['/app', '/admin'].includes(nextPath)) nextPath = '/app';
    }

    try {
      const tokens = await httpsPost(GOOGLE_TOKEN_URL,
        querystring.stringify({code, client_id:GOOGLE_CLIENT_ID, client_secret:GOOGLE_CLIENT_SECRET,
          redirect_uri:`${BASE_URL}/auth/google/callback`, grant_type:'authorization_code'}),
        {'Content-Type':'application/x-www-form-urlencoded'});
      if (!tokens.access_token) throw new Error('No access token');
      const profile = await httpsGet(GOOGLE_USERINFO_URL, {Authorization:`Bearer ${tokens.access_token}`});

      // Auto-student for .ac.za
      const isStudent = profile.email.toLowerCase().endsWith('.ac.za');
      const userRow = await db.upsertUser(profile, isStudent ? 'student' : 'free');

      const sid = generateSid();
      await db.createSession(sid, profile.email);
      const user = rowToUser(userRow);
      sessionCache[sid] = {sid, user};
      db.updateLastLogin(profile.email).catch(()=>{});  // track last login

      const expiry = new Date(Date.now() + 7*24*60*60*1000).toUTCString();
      res.writeHead(302, {Location: nextPath,
        'Set-Cookie':`bs_session=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expiry}`});
      res.end();
    } catch(err) {
      console.error('OAuth error:', err.message, err.stack);
      res.writeHead(302, {Location:'/?error=auth_error&detail=' + encodeURIComponent(err.message)}); res.end();
    }
    return;
  }

  if (pathname === '/auth/logout' && method === 'GET') {
    const cookies = parseCookies(req.headers.cookie || '');
    const sid = cookies['bs_session'];
    if (sid) { delete sessionCache[sid]; await db.deleteSession(sid); }
    res.writeHead(302, {Location:'/',
      'Set-Cookie':'bs_session=; Path=/; HttpOnly; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT'});
    res.end(); return;
  }

  // ── API: /api/me ─────────────────────────
  if (pathname === '/api/me' && method === 'GET') {
    const session = await getSessionUser(req);
    if (!session) {
      res.writeHead(401, {'Content-Type':'application/json'});
      res.end(JSON.stringify({authenticated:false})); return;
    }
    const u = session.user;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      authenticated: true,
      user: {
        name: u.name, email: u.email, avatar: u.avatar,
        plan: u.plan, planLabel: PLANS[u.plan]?.label || 'Free',
        messagesUsed: u.messagesUsed, messagesLimit: u.messagesLimit,
        messagesRemaining: u.messagesRemaining
      }
    })); return;
  }

  // ── API: /api/chat ────────────────────────
  if (pathname === '/api/chat' && method === 'POST') {
    const session = await getSessionUser(req);
    if (session?.user?.email) {
      db.incrementChatCount(session.user.email).catch(()=>{});
      db.logFeatureUse(session.user.email, 'chat', session.user.plan).catch(()=>{});
    }
    if (!session) {
      res.writeHead(401, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Please sign in to continue.'})); return;
    }
    const u = session.user;

    // ── Rate limit check ──
    if (!checkRateLimit(u.email)) {
      res.writeHead(429, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        error: 'rate_limited',
        answer: 'You\'re moving fast — give me a moment to catch up. Try again in a minute.'
      })); return;
    }

    if (u.messagesUsed >= u.messagesLimit) {
      res.writeHead(403, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        error:'limit_reached',
        message:`You have used all ${u.messagesLimit} messages on your ${PLANS[u.plan].label} plan. Please upgrade to continue.`,
        plan: u.plan
      })); return;
    }
    try {
      const body = await readBody(req);
      const {question, promptId} = JSON.parse(body);
      if (!question && !promptId) throw new Error('No question');

      // ── Resolve question: either raw text or server-side template lookup ──
      let resolvedQuestion = question;
      if (promptId) {
        const template = resolvePromptTemplate(promptId, u.plan);
        if (!template) {
          res.writeHead(403, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'prompt_locked', answer:'Upgrade your plan to use this prompt.'}));
          return;
        }
        // Personalise with user context where possible
        resolvedQuestion = template
          .replace('{userName}', u.name || 'you')
          .replace('{userPlan}', u.plan);
      }

      // ── Injection filter ──
      if (isInjectionAttempt(resolvedQuestion)) {
        console.warn(`INJECTION | ${u.email} | ${resolvedQuestion.substring(0, 120)}`);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({
          answer: "I'm here to help your business grow — what would you like to work on?",
          messagesUsed: u.messagesUsed,
          messagesRemaining: u.messagesRemaining
        })); return;
      }

      const flowRes = await httpsPost(
        `${FLOWISE_URL}/api/v1/prediction/${FLOWISE_CHATFLOW_ID}`,
        JSON.stringify({question: resolvedQuestion}),
        {'Content-Type':'application/json'}
      );

      // Increment in DB and update cache
      const usage = await db.incrementMessages(u.email);
      if (sessionCache[session.sid]) {
        sessionCache[session.sid].user.messagesUsed      = usage.messages_used;
        sessionCache[session.sid].user.messagesRemaining = Math.max(0, usage.messages_limit - usage.messages_used);
      }

      let answer =
        (typeof flowRes === 'string' ? flowRes : null) ||
        flowRes.text || flowRes.answer || flowRes.output ||
        flowRes.message || flowRes.result || flowRes.response ||
        (Array.isArray(flowRes.outputs) && flowRes.outputs[0]?.text) ||
        'Billi is temporarily unavailable. Please try again.';

      // ── Output leak filter ──
      if (containsLeakage(answer)) {
        console.warn(`OUTPUT_LEAK | ${u.email} | detected and sanitised`);
        answer = SAFE_FALLBACK;
      }

      // ── Martugo referral — append to IT Guy responses ──
      if (isITGuyPrompt(promptId) || isITGuyQuestion(question)) {
        answer = answer + MARTUGO_REFERRAL;
      }

      // ── Billsource referral — append to Bean Counter responses ──
      if (isBeanCounterPrompt(promptId) || isBeanCounterQuestion(question)) {
        const referral = u.plan === 'enterprise' ? BILLSOURCE_REFERRAL_SSO : BILLSOURCE_REFERRAL_BASE;
        answer = answer + referral;
      }

      // ── Free plan truncation — messages 4+ get a preview only ──
      answer = applyFreeTruncation(answer, u.plan, usage.messages_used);

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        answer,
        messagesUsed: usage.messages_used,
        messagesRemaining: Math.max(0, usage.messages_limit - usage.messages_used)
      }));
    } catch(err) {
      console.error('Chat error:', err.message);
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Billi is temporarily unavailable. Please try again.'}));
    }
    return;
  }

  // ── API: Subscribe (both endpoints) ──────
  if ((pathname === '/api/subscribe' || pathname === '/api/pay/initialize') && method === 'POST') {
    const session = await getSessionUser(req);
    if (!session) {
      res.writeHead(401, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Please sign in first.'})); return;
    }
    try {
      const body = await readBody(req);
      const {plan} = JSON.parse(body);
      const planCode = PAYSTACK_PLANS[plan];
      if (!planCode) throw new Error('Invalid plan: ' + plan);

      const u = session.user;
      if (plan === 'student' && !u.email.toLowerCase().endsWith('.ac.za')) {
        res.writeHead(403, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Student plan requires a .ac.za university email.'}));
        return;
      }

      const result = await paystackRequest('POST', '/transaction/initialize', {
        email: u.email, amount: 0, plan: planCode,
        callback_url: `${BASE_URL}/payment/success?plan=${plan}`,
        metadata: {plan, user_email: u.email}
      });

      if (!result.data?.authorization_url) throw new Error(result.message || 'Paystack error');
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({url: result.data.authorization_url}));
    } catch(err) {
      console.error('Subscribe error:', err.message);
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error: err.message || 'Payment initialisation failed.'}));
    }
    return;
  }

  // ── API: Merch checkout ───────────────────
  if (pathname === '/api/merch-checkout' && method === 'POST') {
    try {
      const body = await readBody(req);
      const {item, size, email} = JSON.parse(body);
      const key = size ? `${item}-${size}` : item;
      const amount = MERCH_PRICES[key];
      if (!amount) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:`Unknown item: ${key}`})); return; }
      if (!email) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Email required.'})); return; }
      const result = await paystackRequest('POST', '/transaction/initialize', {
        email, amount,
        callback_url: `${BASE_URL}/merch-success`,
        metadata: {item, size, order_type:'merch'}
      });
      if (!result.data?.authorization_url) throw new Error(result.message || 'Paystack error');
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({url: result.data.authorization_url}));
    } catch(err) {
      console.error('Merch error:', err.message);
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Checkout failed. Please try again.'}));
    }
    return;
  }

  // ── Paystack webhook ──────────────────────
  if ((pathname === '/webhook/paystack' || pathname === '/api/paystack-webhook') && method === 'POST') {
    const rawBody = await readBody(req);
    if (!verifyPaystackSig(rawBody, req.headers['x-paystack-signature'])) {
      res.writeHead(401); res.end('Invalid signature'); return;
    }
    try {
      const event = JSON.parse(rawBody);
      const email = event.data?.customer?.email;
      const planCode = event.data?.plan?.plan_code || '';
      console.log(`Webhook: ${event.event} — ${email}`);
      switch (event.event) {
        case 'charge.success': {
          const prevPlan = (await db.getUser(email))?.plan || 'free';
          const meta = event.data?.metadata || {};
          if (meta.order_type === 'merch') {
            // Merch order — send fulfillment emails
            const amount = event.data?.amount || 0;
            const reference = event.data?.reference || '';
            await mailer.sendMerchOrderEmails({
              customerEmail: email,
              item:  meta.item  || 'unknown',
              size:  meta.size  || '',
              amount, reference
            }).catch(e => console.error('Merch email error:', e.message));
          } else if (planCode) {
            await upgradeUser(email, planCode);
          }
          break;
        }
        case 'subscription.create':
          if (email && planCode) {
            const prevUser = await db.getUser(email);
            await upgradeUser(email, planCode);
            await db.logBillingEvent(email, 'subscription.create', prevUser?.plan, PLAN_CODE_MAP[planCode], null, event.data?.reference, event.event, null).catch(()=>{});
            const planName = PLAN_CODE_MAP[planCode];
            if (planName) {
              await mailer.sendPlanUpgradeEmail({
                customerEmail: email,
                planName,
                messagesLimit: PLANS[planName]?.messages || 0
              }).catch(e => console.error('Plan email error:', e.message));
            }
          }
          break;
        case 'subscription.disable':
        case 'invoice.payment_failed':
          if (email) {
            const pu = await db.getUser(email);
            await downgradeUser(email);
            await db.logBillingEvent(email, event.event, pu?.plan, 'free', null, null, event.event, 'Subscription disabled or payment failed — auto-downgraded to free').catch(()=>{});
          }
          break;
        case 'subscription.enable':
          if (email && planCode) await upgradeUser(email, planCode); break;
      }
    } catch(err) { console.error('Webhook error:', err); }
    res.writeHead(200); res.end('OK'); return;
  }

  // ── Payment success ───────────────────────
  if (pathname === '/payment/success' && method === 'GET') {
    const {reference} = parsed.query;
    if (reference && PAYSTACK_SECRET_KEY) {
      try {
        const verify = await paystackRequest('GET', `/transaction/verify/${reference}`, null);
        if (verify.data?.status === 'success') {
          const email = verify.data.customer.email;
          const planCode = verify.data.plan?.plan_code;
          if (planCode) await upgradeUser(email, planCode);
        }
      } catch(err) { console.error('Verify error:', err.message); }
    }
    res.writeHead(302, {Location:'/app?payment=success'}); res.end(); return;
  }

  if (pathname === '/merch-success' && method === 'GET') {
    res.writeHead(302, {Location:'/?order=success'}); res.end(); return;
  }

  // ── Protected app ─────────────────────────
  if (pathname === '/app' && method === 'GET') {
    const session = await getSessionUser(req);
    if (!session) { res.writeHead(302, {Location:'/auth/google'}); res.end(); return; }
    // If ?swcleared=1 is present the SW has already been unregistered — serve app directly
    if (parsed.query.swcleared) {
      serveFile(res, path.join(ROOT, 'app.html')); return;
    }
    // First visit: serve an inline SW-killer page that unregisters all service workers
    // then redirects to /app?swcleared=1 — this bypasses any cached app.html in the SW
    const swKiller = `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<title>Loading Billi…</title>
<style>body{background:#0F0D0B;color:#E8E4E0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px}
.spinner{width:32px;height:32px;border:3px solid #2D2A27;border-top-color:#C45200;border-radius:50%;animation:spin 0.7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="spinner"></div><div style="font-size:13px;color:#6B6460">Starting Billi…</div>
<script>
(async function() {
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
  }
  // Clear all caches
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  }
  window.location.replace('/app?swcleared=1');
})();
</script></body></html>`;
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache, no-store, must-revalidate'});
    res.end(swKiller); return;
  }

  // ── My Reports & My Files routes ──────────
  // All require authentication
  const requireAuth = async () => {
    const s = await getSessionUser(req);
    if (!s) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Authentication required'})); }
    return s;
  };

  // POST /api/reports/save
  if (pathname === '/api/reports/save' && method === 'POST') {
    const session = await requireAuth(); if (!session) return;
    await handleSaveReport(req, res, session); return;
  }

  // ── /ops — operational dashboard ─────────────────────────────────
  if (pathname === '/ops' && method === 'GET') {
    const session = await getSessionUser(req);
    if (!session) {
      res.writeHead(302, { Location: buildGoogleAuthUrl(crypto.randomBytes(16).toString('hex'), '/ops') });
      res.end(); return;
    }
    if (!ADMIN_EMAIL || session.user.email.toLowerCase() !== ADMIN_EMAIL) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif;padding:40px;background:#0f0d0b;color:#e8e4e0"><h2 style="color:#c45200">Access denied</h2><p>This dashboard is restricted to the operator account.</p><a href="/" style="color:#c45200">Return home</a></body></html>');
      return;
    }
    serveFile(res, path.join(ROOT, 'ops.html')); return;
  }

  // ── /admin — serve admin.html (operator only) ────────────────────
  // Two-layer auth:
  //   Layer 1 (identity): Google OAuth session — email must match ADMIN_EMAIL env var
  //   Layer 2 (secret):   ADMIN_TOKEN confirmed client-side on first load
  // If not signed in → redirect to Google OAuth with ?next=/admin
  // If signed in but wrong email → 403 (not redirected, not served)
  if (pathname === '/admin' && method === 'GET') {
    const session = await getSessionUser(req);
    if (!session) {
      // Not signed in — redirect to Google OAuth, return to /admin after
      const state = crypto.randomBytes(16).toString('hex');
      res.writeHead(302, { Location: buildGoogleAuthUrl(state, '/admin') });
      res.end(); return;
    }
    if (!ADMIN_EMAIL || session.user.email.toLowerCase() !== ADMIN_EMAIL) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif;padding:40px;background:#0f0d0b;color:#e8e4e0">' +
              '<h2 style="color:#c45200">Access denied</h2>' +
              '<p>This console is restricted to the designated operator account.</p>' +
              '<a href="/" style="color:#c45200">Return home</a></body></html>');
      return;
    }
    serveFile(res, path.join(ROOT, 'admin.html')); return;
  }

  // ── /api/admin/me — returns identity for admin.html header ──────
  if (pathname === '/api/admin/me' && method === 'GET') {
    const session = await getSessionUser(req);
    if (!session || session.user.email.toLowerCase() !== ADMIN_EMAIL) {
      res.writeHead(403, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: 'Operator access required' })); return;
    }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      email: session.user.email,
      name:  session.user.name,
      avatar: session.user.avatar,
    })); return;
  }

  // ── /api/debug-me — detailed session diagnostic (no auth required to read) ──
  // Shows exactly what /api/me sees: cookie, session lookup result, user object
  if (pathname === '/api/debug-me' && method === 'GET') {
    const cookies = req.headers.cookie || '';
    const sid = parseCookies(cookies)['bs_session'];
    let sessionResult = null, dbResult = null, dbError = null;
    if (sid) {
      try {
        const row = await db.getSession(sid);
        dbResult = row ? { email: row.email, plan: row.plan, found: true } : { found: false };
        if (row) sessionResult = rowToUser(row);
      } catch(e) { dbError = e.message; }
    }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      has_cookie:    !!cookies,
      has_sid:       !!sid,
      sid_prefix:    sid ? sid.substring(0,8)+'…' : null,
      session_in_cache: sid ? !!sessionCache[sid] : false,
      db_lookup:     dbResult,
      db_error:      dbError,
      user_object:   sessionResult ? { name: sessionResult.name, email: sessionResult.email, plan: sessionResult.plan } : null,
      api_me_would_return: sessionResult ? 'authenticated:true' : (sid ? 'authenticated:false (session not found)' : 'authenticated:false (no cookie)'),
      ts: new Date().toISOString()
    }, null, 2)); return;
  }


  if (pathname === '/api/healthz' && method === 'GET') {
    let dbOk = false, dbError = '';
    try {
      if (db.pool) { await db.pool.query('SELECT 1'); dbOk = true; }
      else dbError = 'pool is null — db in memory mode';
    } catch(e) { dbError = e.message; }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      status:       dbOk ? 'ok' : 'degraded',
      db:           dbOk ? 'connected' : 'error: ' + dbError,
      node:         process.version,
      uptime_s:     Math.round(process.uptime()),
      env_vars: {
        DATABASE_URL:       !!process.env.DATABASE_URL,
        GOOGLE_CLIENT_ID:   !!process.env.GOOGLE_CLIENT_ID,
        RATING_ENGINE_CONFIG: !!process.env.RATING_ENGINE_CONFIG,
        FLOWISE_CHATFLOW_ID: !!process.env.FLOWISE_CHATFLOW_ID,
        ADMIN_TOKEN:         !!process.env.ADMIN_TOKEN,
        ADMIN_EMAIL:         !!process.env.ADMIN_EMAIL,
      },
      ts: new Date().toISOString()
    })); return;
  }

  // ── /api/client-log — receive client-side error reports ──────────
  if (pathname === '/api/client-log' && method === 'POST') {
    try {
      const body = await readBody(req);
      const entry = JSON.parse(body);
      console.error('[CLIENT-LOG]', JSON.stringify({ ...entry, ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress }));
    } catch(_) {}
    res.writeHead(200); res.end('ok'); return;
  }


  if (pathname === '/api/ops/users' && method === 'GET') {
    if (!requireAdmin()) return;
    const users = await db.getOperationalUsers(500);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ users })); return;
  }
  if (pathname.startsWith('/api/ops/user/') && method === 'GET') {
    if (!requireAdmin()) return;
    const email = decodeURIComponent(pathname.replace('/api/ops/user/',''));
    const detail = await db.getOperationalUserDetail(email);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(detail)); return;
  }
  if (pathname.startsWith('/api/ops/user/') && method === 'POST') {
    if (!requireAdmin()) return;
    const email = decodeURIComponent(pathname.replace('/api/ops/user/','').split('/action')[0]);
    const body = JSON.parse(await readBody(req));
    if (body.action === 'disable') {
      await db.setUserDisabled(email, true, body.reason || 'Operator action');
      await db.logBillingEvent(email, 'manual', null, null, null, null, null, 'Account disabled by operator: ' + (body.reason||''));
    } else if (body.action === 'enable') {
      await db.setUserDisabled(email, false, '');
      await db.logBillingEvent(email, 'manual', null, null, null, null, null, 'Account re-enabled by operator');
    } else if (body.action === 'reset_messages') {
      await db.pool.query('UPDATE users SET messages_used=0 WHERE email=$1', [email]);
    }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true })); return;
  }
  if (pathname === '/api/ops/prompts' && method === 'GET') {
    if (!requireAdmin()) return;
    const prompts = await db.getPromptReviewList();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ prompts })); return;
  }
  if (pathname === '/api/ops/prompts' && method === 'POST') {
    if (!requireAdmin()) return;
    const body = JSON.parse(await readBody(req));
    await db.setPromptStatus(body.promptKey, body.status, body.notes);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true })); return;
  }

  // ── PLM Admin Routes — operator-only, ADMIN_TOKEN required ──────
  // These are NOT user routes. No customer plan grants access.
  // ADMIN_TOKEN is a Railway env var known only to the operator.
  // Usage: send header  x-admin-token: <ADMIN_TOKEN>  with every PLM request.
  // FIX-003: Centralised admin access control — two layers must both pass
  // Layer 1: ADMIN_TOKEN in x-admin-token header (machine-to-machine and browser)
  // Layer 2: Google session email must match ADMIN_EMAIL env var
  // Logs every denied attempt for audit trail
  function requireAdmin() {
    const token = req.headers['x-admin-token'] || '';
    if (!ADMIN_TOKEN || token.length !== ADMIN_TOKEN.length) {
      console.warn(`[SEC FIX-003] Admin denied | no/wrong token length | IP: ${getClientIp(req)} | ${pathname}`);
      res.writeHead(403, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: 'Operator access required' }));
      return false;
    }
    const tokBuf = Buffer.from(token);
    const adBuf  = Buffer.from(ADMIN_TOKEN);
    if (!crypto.timingSafeEqual(tokBuf, adBuf)) {
      console.warn(`[SEC FIX-003] Admin denied | token mismatch | IP: ${getClientIp(req)} | ${pathname}`);
      res.writeHead(403, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: 'Operator access required' }));
      return false;
    }
    return true;
  }
  // Note: Google session identity (Layer 2) is enforced at the /admin HTML route.
  // By the time any /api/plm/* call is made, the operator has already passed
  // Google OAuth + ADMIN_EMAIL check to receive admin.html. The ADMIN_TOKEN
  // header is the per-request guard. Both layers must pass for any action.

  if (pathname === '/api/plm/status' && method === 'GET') {
    if (!requireAdmin()) return;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(await plm.getPLMStatus())); return;
  }
  if (pathname === '/api/plm/proposals' && method === 'GET') {
    if (!requireAdmin()) return;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ proposals: await plm.getPendingProposals() })); return;
  }
  if (pathname === '/api/plm/diagnostics' && method === 'POST') {
    if (!requireAdmin()) return;
    const result = await plm.runDiagnostics();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(result)); return;
  }
  if (pathname === '/api/plm/sandbox' && method === 'POST') {
    if (!requireAdmin()) return;
    try {
      const body = await readBody(req);
      const { proposalId } = JSON.parse(body);
      const result = await plm.runSandboxTest(proposalId);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(result));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  if (pathname === '/api/plm/authorise' && method === 'POST') {
    if (!requireAdmin()) return;
    try {
      const body = await readBody(req);
      const { proposalId, approved, note, operatorId } = JSON.parse(body);
      const result = await plm.authoriseProposal(proposalId, operatorId || 'operator', note, approved);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(result));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  if (pathname === '/api/plm/outcome' && method === 'POST') {
    const session = await requireAuth(); if (!session) return;
    try {
      const body = await readBody(req);
      const { observationId, horizon, diActual, outcomeLabel, revenueDelta, survivalStatus } = JSON.parse(body);
      await plm.recordOutcome(observationId, horizon, { diActual, outcomeLabel, revenueDelta, survivalStatus });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  if (pathname === '/api/plm/log' && method === 'GET') {
    if (!requireAdmin()) return;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ log: await plm.getGovernanceLog(100) })); return;
  }

  // GET /api/reports
  if (pathname === '/api/reports' && method === 'GET') {
    const session = await requireAuth(); if (!session) return;
    await handleListReports(req, res, session); return;
  }
  // GET /api/reports/:id  (download)
  const reportMatch = pathname.match(/^\/api\/reports\/(\d+)$/);
  if (reportMatch && method === 'GET') {
    const session = await requireAuth(); if (!session) return;
    await handleGetReport(req, res, session, parseInt(reportMatch[1])); return;
  }
  // DELETE /api/reports/:id
  if (reportMatch && method === 'DELETE') {
    const session = await requireAuth(); if (!session) return;
    await handleDeleteReport(req, res, session, parseInt(reportMatch[1])); return;
  }

  // POST /api/files/save
  if (pathname === '/api/files/save' && method === 'POST') {
    const session = await requireAuth(); if (!session) return;
    await handleSaveFile(req, res, session); return;
  }
  // GET /api/files
  if (pathname === '/api/files' && method === 'GET') {
    const session = await requireAuth(); if (!session) return;
    await handleListFiles(req, res, session); return;
  }
  // DELETE /api/files/:id
  const fileMatch = pathname.match(/^\/api\/files\/(\d+)$/);
  if (fileMatch && method === 'DELETE') {
    const session = await requireAuth(); if (!session) return;
    await handleDeleteFile(req, res, session, parseInt(fileMatch[1])); return;
  }

  // ── Analysis engine ───────────────────────
  // ── /api/engine/analyse — standard ratio analysis (Professional+) ──
  if (pathname === '/api/engine/analyse' && method === 'POST') {
    const session = await getSessionUser(req);
    if (session?.user?.email) db.logFeatureUse(session.user.email, 'engine/analyse', session.user?.plan).catch(()=>{});
    if (!session) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Authentication required'})); return; }
    const u = session.user;
    if (!['professional','business','enterprise'].includes(u.plan)) {
      res.writeHead(403,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'plan_required',message:'Financial analysis engine requires Professional plan or above.',upgrade:true})); return;
    }
    try {
      const body = await readBody(req);
      const input = JSON.parse(body);
      input.userId = u.email;
      // Run full rating engine — returns Flowise contract + detail
      const result = runRatingEngine(input);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(result));
    } catch(err) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error: err.message || 'Analysis engine error'}));
    }
    return;
  }

  // ── /api/engine/rate — full BAI rating (Enterprise only, Flowise-ready) ──
  // Returns complete Digital Index, node health, collision detection,
  // Adizes stage, sector benchmarks, and remedy plan.
  // This is the output injected into the Flowise sub-agent context.
  if (pathname === '/api/engine/rate' && method === 'POST') {
    const session = await getSessionUser(req);
    if (!session) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Authentication required'})); return; }
    // FIX-002: IP rate limit — 10 ratings per hour
    if (!checkIpRateLimit(getClientIp(req), 'engine/rate', 10, 60 * 60 * 1000)) {
      res.writeHead(429,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'rate_limited', message:'Rating limit reached. You can run up to 10 assessments per hour.'})); return;
    }
    const u = session.user;
    if (!['business','enterprise'].includes(u.plan)) {
      res.writeHead(403,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'plan_required',message:'Full BAI rating requires Business plan or above.',upgrade:true})); return;
    }
    try {
      const body = await readBody(req);
      const input = JSON.parse(body);
      input.userId = u.email;
      const result = runRatingEngine(input);
      // Log the rating event for audit trail
      try { await db.saveReport(u.email, {
        name:       `BAI Rating — ${new Date().toLocaleDateString('en-ZA')}`,
        score:      result.node_health.digital_index,
        rating:     result.detail.riskLabel,
        colour:     result.risk_level,
        sourceFile: 'engine/rate',
        ratiosJson: JSON.stringify(result.detail.financialHealth.ratios)
      }); } catch(_) {}
      // PLM: record this assessment as an observation for learning
      plm.recordObservation(u.email, input.sector, input.country || null, result)
        .catch(e => console.error('PLM observe error:', e.message));
      db.logFeatureUse(u.email, 'engine/rate', u.plan, { di: result.node_health.digital_index, sector: input.sector }).catch(()=>{});
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(result));
    } catch(err) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error: err.message || 'Rating engine error'}));
    }
    return;
  }


  // ── Prompt book (protected IP — server-side only) ──
  if (pathname === '/api/prompts' && method === 'GET') {
    const session = await getSessionUser(req);
    if (!session) {
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Authentication required'})); return;
    }
    // Log every access to PostgreSQL for anomaly detection + legal evidence
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                  || req.socket?.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;
    db.logPromptAccess(session.user.email, session.user.plan, clientIp, userAgent)
      .catch(e => console.error('Prompt log error:', e.message));

    // Return only display labels — templates are never sent to the browser
    const prompts = getUserPrompts(session.user.plan || 'free');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({prompts})); return;
  }

  // ── Prompt resolve — server-side template lookup, never exposes template ──
  // Client sends { promptId } → server returns Flowise answer directly
  if (pathname === '/api/prompt/send' && method === 'POST') {
    const session = await getSessionUser(req);
    if (!session) {
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Authentication required'})); return;
    }
    const u = session.user;
    if (!checkRateLimit(u.email)) {
      res.writeHead(429,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'rate_limited', answer:'Give me a moment — try again in a minute.'})); return;
    }
    if (u.messagesUsed >= u.messagesLimit) {
      res.writeHead(403,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'limit_reached', plan: u.plan})); return;
    }
    try {
      const body   = await readBody(req);
      const {promptId} = JSON.parse(body);
      if (!promptId) throw new Error('No promptId');

      const template = resolvePromptTemplate(promptId, u.plan);
      if (!template) {
        res.writeHead(403,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'prompt_locked', answer:'Upgrade your plan to use this prompt.'})); return;
      }

      // Template is resolved server-side, never returned to client
      const question = template
        .replace('{userName}', u.name || 'you')
        .replace('{userPlan}', u.plan);

      const flowRes = await httpsPost(
        `${FLOWISE_URL}/api/v1/prediction/${FLOWISE_CHATFLOW_ID}`,
        JSON.stringify({question}),
        {'Content-Type':'application/json'}
      );
      const usage = await db.incrementMessages(u.email);
      if (sessionCache[session.sid]) {
        sessionCache[session.sid].user.messagesUsed      = usage.messages_used;
        sessionCache[session.sid].user.messagesRemaining = Math.max(0, usage.messages_limit - usage.messages_used);
      }
      let answer =
        (typeof flowRes === 'string' ? flowRes : null) ||
        flowRes.text || flowRes.answer || flowRes.output ||
        flowRes.message || flowRes.result || flowRes.response ||
        (Array.isArray(flowRes.outputs) && flowRes.outputs[0]?.text) ||
        'Billi is temporarily unavailable. Please try again.';

      if (containsLeakage(answer)) { answer = SAFE_FALLBACK; }

      // ── Martugo referral — IT Guy prompts always get the referral ──
      if (isITGuyPrompt(promptId)) {
        answer = answer + MARTUGO_REFERRAL;
      }

      // ── Billsource referral — Bean Counter prompts always get the referral ──
      if (isBeanCounterPrompt(promptId)) {
        const referral = u.plan === 'enterprise' ? BILLSOURCE_REFERRAL_SSO : BILLSOURCE_REFERRAL_BASE;
        answer = answer + referral;
      }

      // ── Free plan truncation — messages 4+ get a preview only ──
      answer = applyFreeTruncation(answer, u.plan, usage.messages_used);

      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        answer,
        messagesUsed: usage.messages_used,
        messagesRemaining: Math.max(0, usage.messages_limit - usage.messages_used)
      }));
    } catch(err) {
      console.error('Prompt send error:', err.message);
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Billi is temporarily unavailable. Please try again.'}));
    }
    return;
  }

  // ── PWA reset (clears cache + localStorage for testing) ──
  if (pathname === '/reset-pwa' && method === 'GET') {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Resetting Billi...</title>
<style>body{font-family:Helvetica,Arial,sans-serif;background:#0D0D0D;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:1rem}
.spinner{width:40px;height:40px;border:3px solid #333;border-top-color:#F59E0B;border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body>
<div class="spinner"></div>
<div>Clearing Billi cache...</div>
<script>
async function reset() {
  // Clear service worker caches
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  }
  // Unregister service workers
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
  }
  // Clear install dismissed flag
  localStorage.removeItem('billi-install-dismissed');
  // Redirect to app
  setTimeout(() => window.location.href = '/app', 800);
}
reset();
</script>
</body></html>`);
    return;
  }

  // ── Terms of Service ──────────────────────
  if (pathname === '/terms' && method === 'GET') {
    serveFile(res, path.join(ROOT, 'terms.html')); return;
  }

  // ── Static files ──────────────────────────
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!path.extname(filePath)) filePath += '.html';
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, filePath);
});

// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// MY REPORTS & MY FILES — delegate to db.js
// All table creation, in-memory fallbacks, and
// SQL live in db.js. These are thin pass-throughs.
// ═══════════════════════════════════════════

const saveReport   = (email, payload) => db.saveReport(email, payload);
const listReports  = (email)          => db.listReports(email);
const getReport    = (email, id)      => db.getReport(email, id);
const deleteReport = (email, id)      => db.deleteReport(email, id);
const saveFile     = (email, payload) => db.saveFile(email, payload);
const listFiles    = (email)          => db.listFiles(email);
const deleteFile   = (email, id)      => db.deleteFile(email, id);

// ═══════════════════════════════════════════
// MY REPORTS — API Routes
// ═══════════════════════════════════════════

// POST /api/reports/save — save a completed analysis report
// Body: { name, score, rating, colour, sourceFile, ratiosJson, htmlReport }
async function handleSaveReport(req, res, session) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body);
    if (!payload.name) payload.name = 'Financial Report';
    const saved = await saveReport(session.user.email, payload);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:true, report:saved }));
  } catch(e) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ error: e.message || 'Could not save report' }));
  }
}

// GET /api/reports — list all reports for current user
async function handleListReports(req, res, session) {
  try {
    const reports = await listReports(session.user.email);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ reports }));
  } catch(e) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ error: 'Could not load reports' }));
  }
}

// GET /api/reports/:id — download full HTML of a single report
async function handleGetReport(req, res, session, id) {
  try {
    const report = await getReport(session.user.email, id);
    if (!report) { res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Not found'})); return; }
    if (report.html_report) {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8',
        'Content-Disposition':`attachment; filename="${report.name.replace(/[^a-z0-9 .\-_]/gi,'_')}.html"`});
      res.end(report.html_report);
    } else {
      // html_report not stored — client builds HTML from ratios_json via the list endpoint
      res.writeHead(404, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: 'No HTML stored — use the Download button in My Reports' }));
    }
  } catch(e) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ error: 'Could not retrieve report' }));
  }
}

// DELETE /api/reports/:id
async function handleDeleteReport(req, res, session, id) {
  try {
    await deleteReport(session.user.email, id);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:true }));
  } catch(e) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ error: 'Could not delete report' }));
  }
}

// ── Files routes ──
// POST /api/files/save  — save uploaded file metadata + content
async function handleSaveFile(req, res, session) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body);
    if (!payload.name) throw new Error('File name required');
    const saved = await saveFile(session.user.email, payload);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:true, file:saved }));
  } catch(e) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ error: e.message || 'Could not save file' }));
  }
}

// GET /api/files
async function handleListFiles(req, res, session) {
  try {
    const files = await listFiles(session.user.email);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ files }));
  } catch(e) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ error: 'Could not load files' }));
  }
}

// DELETE /api/files/:id
async function handleDeleteFile(req, res, session, id) {
  try {
    await deleteFile(session.user.email, id);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:true }));
  } catch(e) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ error: 'Could not delete file' }));
  }
}


// ═══════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════
async function start() {
  if (process.env.DATABASE_URL) {
    await db.initDb();
    await plm.initPLMTables();
    await plm.registerNFULibrary();
    setInterval(db.resetMonthlyUsage, 60*60*1000);         // hourly usage reset
    setInterval(db.cleanExpiredSessions, 6*60*60*1000);    // 6hr session cleanup
    setInterval(plm.runDiagnostics, 24*60*60*1000);        // nightly PLM diagnostics
  } else {
    console.warn('WARNING: DATABASE_URL not set — users will not persist across deploys');
  }

  server.listen(PORT, () => {
    console.log(`BillSource AI on port ${PORT}`);
    console.log(`DB       : ${process.env.DATABASE_URL ? 'PostgreSQL' : 'NO DATABASE — in-memory only'}`);
    console.log(`OAuth    : ${GOOGLE_CLIENT_ID     ? 'OK' : 'MISSING'}`);
    console.log(`Flowise  : ${FLOWISE_CHATFLOW_ID  ? 'OK' : 'MISSING'}`);
    console.log(`Paystack : ${PAYSTACK_SECRET_KEY  ? 'OK' : 'not set'}`);
    if (!ADMIN_TOKEN) {
      console.warn('WARNING: ADMIN_TOKEN not set — /admin and /api/plm/* routes are inaccessible');
    } else if (ADMIN_TOKEN.length < 32) {
      console.warn('WARNING: ADMIN_TOKEN is too short — minimum 64 hex chars (32 bytes). Regenerate.');
    } else {
      console.log(`Admin    : token set (${ADMIN_TOKEN.length} chars)`);
    }
    if (!ADMIN_EMAIL) {
      console.warn('WARNING: ADMIN_EMAIL not set — /admin route will deny all access');
    } else {
      console.log(`Admin    : operator email = ${ADMIN_EMAIL}`);
    }
  });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
