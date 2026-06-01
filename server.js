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
const BASE_URL             = process.env.BASE_URL || 'https://billsource.ai';
const FLOWISE_URL          = process.env.FLOWISE_URL || 'https://flowiseai-production-455f.up.railway.app';
const FLOWISE_CHATFLOW_ID  = process.env.FLOWISE_CHATFLOW_ID || '';
const PAYSTACK_SECRET_KEY  = process.env.PAYSTACK_SECRET_KEY || '';

const PLANS = {
  free:         { messages: 10,   label: 'Free' },
  student:      { messages: 100,  label: 'Student' },
  professional: { messages: 300,  label: 'Professional' },
  business:     { messages: 1000, label: 'Business' },
  enterprise:   { messages: 5000, label: 'Enterprise' }
};

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
    res.writeHead(200, {'Content-Type': MIME[path.extname(filePath)] || 'text/plain'});
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

function buildGoogleAuthUrl(state) {
  return `${GOOGLE_AUTH_URL}?${querystring.stringify({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/google/callback`,
    response_type: 'code', scope: 'openid email profile',
    state, access_type: 'offline', prompt: 'consent'
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

  // ── AUTH ────────────────────────────────
  if (pathname === '/auth/google' && method === 'GET') {
    const state = crypto.randomBytes(16).toString('hex');
    res.writeHead(302, {Location: buildGoogleAuthUrl(state)});
    res.end(); return;
  }

  if (pathname === '/auth/google/callback' && method === 'GET') {
    const {code, error} = parsed.query;
    if (error || !code) { res.writeHead(302, {Location:'/?error=auth_failed'}); res.end(); return; }
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

      const expiry = new Date(Date.now() + 7*24*60*60*1000).toUTCString();
      res.writeHead(302, {Location:'/app',
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
            await upgradeUser(email, planCode);
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
          if (email) await downgradeUser(email); break;
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
    serveFile(res, path.join(ROOT, 'app.html')); return;
  }

  // ── Analysis engine ───────────────────────
  if (pathname === '/api/engine/analyse' && method === 'POST') {
    const session = await getSessionUser(req);
    if (!session) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Authentication required'})); return; }
    const u = session.user;
    if (!['professional','business','enterprise'].includes(u.plan)) {
      res.writeHead(403,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'plan_required',message:'Financial analysis engine requires Professional plan or above.',upgrade:true})); return;
    }
    const apiToken = req.headers['x-engine-token'];
    const validToken = process.env.ENGINE_API_TOKEN;
    if (validToken && apiToken !== validToken) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Invalid engine token'})); return; }
    try {
      const body = await readBody(req);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(runAnalysisEngine(JSON.parse(body))));
    } catch(err) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Analysis engine error'}));
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
// ANALYSIS ENGINE (unchanged)
// ═══════════════════════════════════════════
function runAnalysisEngine(data) {
  const {revenue,costOfSales,operatingExpenses,currentAssets,currentLiabilities,
         totalDebt,equity,accountsReceivable,accountsPayable,inventory,netProfit,annualRevenue} = data;
  const r = {};
  r.currentRatio  = currentAssets/currentLiabilities;
  r.quickRatio    = (currentAssets-inventory)/currentLiabilities;
  r.cashRatio     = (currentAssets-inventory-accountsReceivable)/currentLiabilities;
  const gp = revenue-costOfSales;
  r.grossMargin     = (gp/revenue)*100;
  r.netMargin       = (netProfit/revenue)*100;
  r.operatingMargin = ((gp-operatingExpenses)/revenue)*100;
  r.returnOnEquity  = (netProfit/equity)*100;
  r.dso = (accountsReceivable/annualRevenue)*365;
  r.dpo = (accountsPayable/costOfSales)*365;
  r.cashConversionCycle = r.dso-r.dpo;
  r.debtToEquity = totalDebt/equity;
  r.debtToAssets = totalDebt/(totalDebt+equity);
  const w = {liquidity:0.30,profitability:0.25,efficiency:0.25,leverage:0.20};
  const liq  = Math.min(100,Math.max(0,r.currentRatio>=2?100:r.currentRatio>=1.5?80:r.currentRatio>=1?60:r.currentRatio>=0.75?40:20));
  const prof = Math.min(100,Math.max(0,r.netMargin>=20?100:r.netMargin>=10?80:r.netMargin>=5?60:r.netMargin>=0?40:20));
  const eff  = Math.min(100,Math.max(0,r.dso<=30?100:r.dso<=45?80:r.dso<=60?60:r.dso<=90?40:20));
  const lev  = Math.min(100,Math.max(0,r.debtToEquity<=0.5?100:r.debtToEquity<=1?80:r.debtToEquity<=1.5?60:r.debtToEquity<=2?40:20));
  r.nationalHealthScore = Math.round(liq*w.liquidity+prof*w.profitability+eff*w.efficiency+lev*w.leverage);
  r.riskRating = r.nationalHealthScore>=80?'GREEN — Low Risk':r.nationalHealthScore>=60?'AMBER — Moderate Risk':r.nationalHealthScore>=40?'ORANGE — Elevated Risk':'RED — Critical Risk';
  r.riskColour = r.nationalHealthScore>=80?'green':r.nationalHealthScore>=60?'amber':r.nationalHealthScore>=40?'orange':'red';
  Object.keys(r).forEach(k=>{if(typeof r[k]==='number')r[k]=Math.round(r[k]*100)/100;});
  return {score:r.nationalHealthScore,rating:r.riskRating,colour:r.riskColour,ratios:r,generatedAt:new Date().toISOString(),version:'1.0.0'};
}

// ═══════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════
async function start() {
  if (process.env.DATABASE_URL) {
    await db.initDb();
    setInterval(db.resetMonthlyUsage, 60*60*1000);       // hourly usage reset check
    setInterval(db.cleanExpiredSessions, 6*60*60*1000);  // 6hr session cleanup
  } else {
    console.warn('WARNING: DATABASE_URL not set — users will not persist across deploys');
  }

  server.listen(PORT, () => {
    console.log(`BillSource AI on port ${PORT}`);
    console.log(`DB       : ${process.env.DATABASE_URL ? 'PostgreSQL' : 'NO DATABASE — in-memory only'}`);
    console.log(`OAuth    : ${GOOGLE_CLIENT_ID     ? 'OK' : 'MISSING'}`);
    console.log(`Flowise  : ${FLOWISE_CHATFLOW_ID  ? 'OK' : 'MISSING'}`);
    console.log(`Paystack : ${PAYSTACK_SECRET_KEY  ? 'OK' : 'not set'}`);
  });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
