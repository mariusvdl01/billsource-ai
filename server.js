const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const querystring = require('querystring');

const PORT = process.env.PORT || 8080;
const ROOT = '/app';

// ═══════════════════════════════════════════
// CONFIGURATION — set in Railway Variables
// ═══════════════════════════════════════════
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET       = process.env.SESSION_SECRET || 'billsource-ai-2026-secret-key';
const BASE_URL             = process.env.BASE_URL || 'https://billsource.ai';
const FLOWISE_URL          = process.env.FLOWISE_URL || 'https://flowiseai-production-455f.up.railway.app';
const FLOWISE_CHATFLOW_ID  = process.env.FLOWISE_CHATFLOW_ID || '';
const PAYSTACK_SECRET_KEY  = process.env.PAYSTACK_SECRET_KEY || '';

// ── Billi Plan definitions ──────────────────
const PLANS = {
  free:         { messages: 10,   label: 'Free',         roles: ['bean_counter'] },
  student:      { messages: 100,  label: 'Student',      roles: ['bean_counter','deal_maker'] },
  professional: { messages: 300,  label: 'Professional', roles: ['bean_counter','rule_book'] },
  business:     { messages: 1000, label: 'Business',     roles: ['bean_counter','rule_book','brand_guru'] },
  enterprise:   { messages: 5000, label: 'Enterprise',   roles: ['bean_counter','rule_book','brand_guru','deal_maker','the_fixer'] }
};

// ── Paystack plan codes ─────────────────────
const PAYSTACK_PLANS = {
  student:      process.env.PAYSTACK_PLAN_STUDENT       || 'PLN_u5uxr8t2tf0p64z',
  professional: process.env.PAYSTACK_PLAN_PROFESSIONAL  || 'PLN_xep07lsxg5ug0di',
  business:     process.env.PAYSTACK_PLAN_BUSINESS      || 'PLN_6ckkyszhatwstzq',
  enterprise:   process.env.PAYSTACK_PLAN_ENTERPRISE    || 'PLN_7fri26iibfq1z34'
};

// ── Paystack plan code → tier reverse map ───
const PLAN_CODE_MAP = {
  'PLN_u5uxr8t2tf0p64z': 'student',
  'PLN_xep07lsxg5ug0di': 'professional',
  'PLN_6ckkyszhatwstzq': 'business',
  'PLN_7fri26iibfq1z34': 'enterprise'
};

// ── Merch prices in kobo (ZAR cents) ────────
const MERCH_PRICES = {
  'hoodie-sml':  54900,
  'hoodie-xl':   59900,
  'hoodie-3xl':  64900,
  'cap-black':   29900,
  'cap-white':   29900,
  'mug-330':     19900,
  'mug-470':     24900,
  'tee-sml':     29900,
  'tee-xl':      34900,
  'tee-3xl':     37900
};

// ═══════════════════════════════════════════
// SIMPLE IN-MEMORY SESSION STORE
// ═══════════════════════════════════════════
const sessions = {};
const users = {};

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sid = cookies['bs_session'];
  return sid && sessions[sid] ? { sid, data: sessions[sid] } : null;
}

function createSession(userData) {
  const sid = generateSessionId();
  sessions[sid] = { user: userData, created: Date.now() };
  return sid;
}

function parseCookies(cookieStr) {
  const out = {};
  cookieStr.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  });
  return out;
}

// ═══════════════════════════════════════════
// FILE SERVING
// ═══════════════════════════════════════════
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { serveFile(res, path.join(ROOT, 'index.html')); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}

// ═══════════════════════════════════════════
// GOOGLE OAUTH HELPERS
// ═══════════════════════════════════════════
const GOOGLE_AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

function buildGoogleAuthUrl(state) {
  const params = querystring.stringify({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent'
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

function httpsPost(urlStr, data, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    }).on('error', reject);
  });
}

async function exchangeCodeForTokens(code) {
  return httpsPost(GOOGLE_TOKEN_URL,
    querystring.stringify({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: `${BASE_URL}/auth/google/callback`,
      grant_type: 'authorization_code'
    }),
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
}

async function getGoogleUserInfo(accessToken) {
  return httpsGet(GOOGLE_USERINFO_URL, { Authorization: `Bearer ${accessToken}` });
}

// ═══════════════════════════════════════════
// USER MANAGEMENT
// ═══════════════════════════════════════════
function getOrCreateUser(googleProfile) {
  const email = googleProfile.email;
  if (!users[email]) {
    // Auto-detect student via .ac.za email
    const isStudent = email.toLowerCase().endsWith('.ac.za');
    const defaultPlan = isStudent ? 'student' : 'free';
    users[email] = {
      email,
      name: googleProfile.name,
      avatar: googleProfile.picture,
      googleId: googleProfile.id,
      plan: defaultPlan,
      messagesUsed: 0,
      messagesLimit: PLANS[defaultPlan].messages,
      createdAt: new Date().toISOString(),
      billingCycle: new Date().toISOString()
    };
    console.log(`New user: ${email} — plan: ${defaultPlan}`);
  } else {
    users[email].name = googleProfile.name;
    users[email].avatar = googleProfile.picture;
    console.log(`Returning user: ${email} — plan: ${users[email].plan}`);
  }
  return users[email];
}

function resetMonthlyUsage() {
  const now = new Date();
  Object.values(users).forEach(user => {
    const cycle = new Date(user.billingCycle);
    if ((now - cycle) / (1000 * 60 * 60 * 24) >= 30) {
      user.messagesUsed = 0;
      user.billingCycle = now.toISOString();
    }
  });
}
setInterval(resetMonthlyUsage, 60 * 60 * 1000);

// ═══════════════════════════════════════════
// PAYSTACK HELPERS
// ═══════════════════════════════════════════
function paystackRequest(method, endpoint, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const parsed = new URL('https://api.paystack.co' + endpoint);
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    };
    if (body) reqOpts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(reqOpts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function verifyPaystackSignature(body, signature) {
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(body)
    .digest('hex');
  return hash === signature;
}

function upgradeUser(email, planCode) {
  const planName = PLAN_CODE_MAP[planCode];
  if (!planName) { console.log(`Unknown plan code: ${planCode}`); return; }
  if (!users[email]) { console.log(`Unknown user: ${email}`); return; }
  users[email].plan = planName;
  users[email].messagesLimit = PLANS[planName].messages;
  users[email].messagesUsed = 0;
  users[email].billingCycle = new Date().toISOString();
  console.log(`Plan upgraded: ${email} → ${planName}`);
  // Update all active sessions for this user
  Object.values(sessions).forEach(s => {
    if (s.user && s.user.email === email) s.user = users[email];
  });
}

function downgradeUser(email) {
  if (!users[email]) return;
  users[email].plan = 'free';
  users[email].messagesLimit = PLANS.free.messages;
  console.log(`Plan downgraded: ${email} → free`);
  Object.values(sessions).forEach(s => {
    if (s.user && s.user.email === email) s.user = users[email];
  });
}

// ═══════════════════════════════════════════
// BODY PARSER
// ═══════════════════════════════════════════
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
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

  // ══════════════════════════════════════════
  // AUTH ROUTES
  // ══════════════════════════════════════════
  if (pathname === '/auth/google' && method === 'GET') {
    const state = crypto.randomBytes(16).toString('hex');
    res.writeHead(302, { Location: buildGoogleAuthUrl(state) });
    res.end(); return;
  }

  if (pathname === '/auth/google/callback' && method === 'GET') {
    const { code, error } = parsed.query;
    if (error || !code) { res.writeHead(302, { Location: '/?error=auth_failed' }); res.end(); return; }
    try {
      const tokens = await exchangeCodeForTokens(code);
      if (!tokens.access_token) throw new Error('No access token');
      const profile = await getGoogleUserInfo(tokens.access_token);
      const user = getOrCreateUser(profile);
      const sid = createSession(user);
      const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
      res.writeHead(302, {
        Location: '/app',
        'Set-Cookie': `bs_session=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expiry}`
      });
      res.end();
    } catch (err) {
      console.error('OAuth error:', err);
      res.writeHead(302, { Location: '/?error=auth_error' }); res.end();
    }
    return;
  }

  if (pathname === '/auth/logout' && method === 'GET') {
    const session = getSession(req);
    if (session) delete sessions[session.sid];
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': 'bs_session=; Path=/; HttpOnly; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    });
    res.end(); return;
  }

  // ══════════════════════════════════════════
  // API ROUTES
  // ══════════════════════════════════════════

  // Current user info
  if (pathname === '/api/me' && method === 'GET') {
    const session = getSession(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: false })); return;
    }
    const user = session.data.user;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      authenticated: true,
      user: {
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        plan: user.plan,
        planLabel: PLANS[user.plan]?.label || 'Free',
        messagesUsed: user.messagesUsed,
        messagesLimit: user.messagesLimit,
        messagesRemaining: Math.max(0, user.messagesLimit - user.messagesUsed)
      }
    })); return;
  }

  // Chat — enforces usage limits
  if (pathname === '/api/chat' && method === 'POST') {
    const session = getSession(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Please sign in to continue.' })); return;
    }
    const user = session.data.user;
    if (user.messagesUsed >= user.messagesLimit) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'limit_reached',
        message: `You have used all ${user.messagesLimit} messages on your ${PLANS[user.plan].label} plan. Please upgrade to continue.`,
        plan: user.plan
      })); return;
    }
    try {
      const body = await readBody(req);
      const { question } = JSON.parse(body);
      if (!question) throw new Error('No question');

      const flowiseResponse = await httpsPost(
        `${FLOWISE_URL}/api/v1/prediction/${FLOWISE_CHATFLOW_ID}`,
        JSON.stringify({ question }),
        { 'Content-Type': 'application/json' }
      );

      user.messagesUsed++;
      sessions[session.sid].user = user;
      users[user.email] = user;

      const answer =
        (typeof flowiseResponse === 'string' ? flowiseResponse : null) ||
        flowiseResponse.text || flowiseResponse.answer ||
        flowiseResponse.output || flowiseResponse.message ||
        flowiseResponse.result || flowiseResponse.response ||
        (Array.isArray(flowiseResponse.outputs) && flowiseResponse.outputs[0]?.text) ||
        'Billi is temporarily unavailable. Please try again.';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        answer,
        messagesUsed: user.messagesUsed,
        messagesRemaining: Math.max(0, user.messagesLimit - user.messagesUsed)
      }));
    } catch (err) {
      console.error('Chat error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Billi is temporarily unavailable. Please try again.' }));
    }
    return;
  }

  // ── Subscription checkout (modal Pay button) ──
  // Handles both /api/subscribe (new) and /api/pay/initialize (legacy)
  if ((pathname === '/api/subscribe' || pathname === '/api/pay/initialize') && method === 'POST') {
    const session = getSession(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Please sign in first.' })); return;
    }
    try {
      const body = await readBody(req);
      const { plan } = JSON.parse(body);
      const planCode = PAYSTACK_PLANS[plan];
      if (!planCode) throw new Error('Invalid plan: ' + plan);

      const user = session.data.user;

      // Student plan — enforce .ac.za email
      if (plan === 'student' && !user.email.toLowerCase().endsWith('.ac.za')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Student plan requires a .ac.za university email address.' }));
        return;
      }

      const result = await paystackRequest('POST', '/transaction/initialize', {
        email: user.email,
        amount: 0,
        plan: planCode,
        callback_url: `${BASE_URL}/payment/success?plan=${plan}`,
        metadata: { plan, user_email: user.email }
      });

      if (!result.data?.authorization_url) throw new Error(result.message || 'Paystack error');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: result.data.authorization_url }));
    } catch (err) {
      console.error('Subscribe error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Payment initialisation failed.' }));
    }
    return;
  }

  // ── Merch checkout ────────────────────────
  if (pathname === '/api/merch-checkout' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { item, size, email } = JSON.parse(body);
      const key = size ? `${item}-${size}` : item;
      const amount = MERCH_PRICES[key];
      if (!amount) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown item: ${key}` })); return;
      }
      if (!email) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Email required for merch checkout.' })); return;
      }
      const result = await paystackRequest('POST', '/transaction/initialize', {
        email,
        amount,
        callback_url: `${BASE_URL}/merch-success`,
        metadata: { item, size, order_type: 'merch' }
      });
      if (!result.data?.authorization_url) throw new Error(result.message || 'Paystack error');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: result.data.authorization_url }));
    } catch (err) {
      console.error('Merch checkout error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Checkout failed. Please try again.' }));
    }
    return;
  }

  // ── Paystack webhook ──────────────────────
  if ((pathname === '/webhook/paystack' || pathname === '/api/paystack-webhook') && method === 'POST') {
    const rawBody = await readBody(req);
    const signature = req.headers['x-paystack-signature'];
    if (!verifyPaystackSignature(rawBody, signature)) {
      res.writeHead(401); res.end('Invalid signature'); return;
    }
    try {
      const event = JSON.parse(rawBody);
      const email = event.data?.customer?.email;
      const planCode = event.data?.plan?.plan_code || '';

      switch (event.event) {
        case 'charge.success':
        case 'subscription.create':
          if (email && planCode) upgradeUser(email, planCode);
          break;
        case 'subscription.disable':
        case 'invoice.payment_failed':
          if (email) downgradeUser(email);
          break;
        case 'subscription.enable':
          if (email && planCode) upgradeUser(email, planCode);
          break;
      }
      console.log(`Webhook: ${event.event} — ${email}`);
    } catch (err) { console.error('Webhook parse error:', err); }
    res.writeHead(200); res.end('OK'); return;
  }

  // ── Payment success redirect ──────────────
  if (pathname === '/payment/success' && method === 'GET') {
    const { reference, plan } = parsed.query;
    // Verify and upgrade if not caught by webhook
    if (reference && PAYSTACK_SECRET_KEY) {
      try {
        const verify = await paystackRequest('GET', `/transaction/verify/${reference}`, null);
        if (verify.data?.status === 'success') {
          const email = verify.data.customer.email;
          const planCode = verify.data.plan?.plan_code;
          if (planCode) upgradeUser(email, planCode);
          // Update current session immediately
          const session = getSession(req);
          if (session && session.data.user.email === email) {
            session.data.user = users[email];
            sessions[session.sid] = session.data;
          }
        }
      } catch (err) { console.error('Verify error:', err.message); }
    }
    res.writeHead(302, { Location: '/app?payment=success' }); res.end(); return;
  }

  if (pathname === '/merch-success' && method === 'GET') {
    res.writeHead(302, { Location: '/?order=success' }); res.end(); return;
  }

  // ══════════════════════════════════════════
  // PROTECTED APP ROUTE
  // ══════════════════════════════════════════
  if (pathname === '/app' && method === 'GET') {
    const session = getSession(req);
    if (!session) { res.writeHead(302, { Location: '/auth/google' }); res.end(); return; }
    serveFile(res, path.join(ROOT, 'app.html')); return;
  }

  // ══════════════════════════════════════════
  // ANALYSIS & RATING ENGINE — Protected API
  // ══════════════════════════════════════════
  if (pathname === '/api/engine/analyse' && method === 'POST') {
    const session = getSession(req);
    if (!session) {
      res.writeHead(401, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Authentication required'})); return;
    }
    const user = session.data.user;
    const authorisedPlans = ['professional','business','enterprise'];
    if (!authorisedPlans.includes(user.plan)) {
      res.writeHead(403, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        error:'plan_required',
        message:'Financial analysis engine requires Professional plan or above.',
        upgrade: true
      })); return;
    }
    const apiToken = req.headers['x-engine-token'];
    const validToken = process.env.ENGINE_API_TOKEN;
    if (validToken && apiToken !== validToken) {
      res.writeHead(403, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Invalid engine token'})); return;
    }
    try {
      const body = await readBody(req);
      const input = JSON.parse(body);
      const result = runAnalysisEngine(input);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify(result));
    } catch(err) {
      console.error('Engine error:', err.message);
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Analysis engine error'}));
    }
    return;
  }

  // ══════════════════════════════════════════
  // STATIC FILE SERVING
  // ══════════════════════════════════════════
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!path.extname(filePath)) filePath += '.html';
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, filePath);
});

// ══════════════════════════════════════════
// PROPRIETARY ANALYSIS & RATING ENGINE
// ══════════════════════════════════════════
function runAnalysisEngine(data) {
  const {
    revenue, costOfSales, operatingExpenses, currentAssets,
    currentLiabilities, totalDebt, equity, accountsReceivable,
    accountsPayable, inventory, netProfit, annualRevenue
  } = data;

  const results = {};

  results.currentRatio  = currentAssets / currentLiabilities;
  results.quickRatio    = (currentAssets - inventory) / currentLiabilities;
  results.cashRatio     = (currentAssets - inventory - accountsReceivable) / currentLiabilities;

  const grossProfit = revenue - costOfSales;
  results.grossMargin     = (grossProfit / revenue) * 100;
  results.netMargin       = (netProfit / revenue) * 100;
  results.operatingMargin = ((grossProfit - operatingExpenses) / revenue) * 100;
  results.returnOnEquity  = (netProfit / equity) * 100;

  results.dso = (accountsReceivable / annualRevenue) * 365;
  results.dpo = (accountsPayable / costOfSales) * 365;
  results.cashConversionCycle = results.dso - results.dpo;

  results.debtToEquity = totalDebt / equity;
  results.debtToAssets = totalDebt / (totalDebt + equity);

  const weights = { liquidity: 0.30, profitability: 0.25, efficiency: 0.25, leverage: 0.20 };

  const liquidityScore = Math.min(100, Math.max(0,
    results.currentRatio >= 2   ? 100 :
    results.currentRatio >= 1.5 ? 80  :
    results.currentRatio >= 1.0 ? 60  :
    results.currentRatio >= 0.75? 40  : 20
  ));
  const profitabilityScore = Math.min(100, Math.max(0,
    results.netMargin >= 20 ? 100 :
    results.netMargin >= 10 ? 80  :
    results.netMargin >= 5  ? 60  :
    results.netMargin >= 0  ? 40  : 20
  ));
  const efficiencyScore = Math.min(100, Math.max(0,
    results.dso <= 30 ? 100 :
    results.dso <= 45 ? 80  :
    results.dso <= 60 ? 60  :
    results.dso <= 90 ? 40  : 20
  ));
  const leverageScore = Math.min(100, Math.max(0,
    results.debtToEquity <= 0.5 ? 100 :
    results.debtToEquity <= 1.0 ? 80  :
    results.debtToEquity <= 1.5 ? 60  :
    results.debtToEquity <= 2.0 ? 40  : 20
  ));

  results.nationalHealthScore = Math.round(
    (liquidityScore * weights.liquidity) +
    (profitabilityScore * weights.profitability) +
    (efficiencyScore * weights.efficiency) +
    (leverageScore * weights.leverage)
  );

  results.riskRating =
    results.nationalHealthScore >= 80 ? 'GREEN — Low Risk' :
    results.nationalHealthScore >= 60 ? 'AMBER — Moderate Risk' :
    results.nationalHealthScore >= 40 ? 'ORANGE — Elevated Risk' : 'RED — Critical Risk';

  results.riskColour =
    results.nationalHealthScore >= 80 ? 'green' :
    results.nationalHealthScore >= 60 ? 'amber' :
    results.nationalHealthScore >= 40 ? 'orange' : 'red';

  Object.keys(results).forEach(k => {
    if (typeof results[k] === 'number') results[k] = Math.round(results[k] * 100) / 100;
  });

  return {
    score: results.nationalHealthScore,
    rating: results.riskRating,
    colour: results.riskColour,
    ratios: results,
    generatedAt: new Date().toISOString(),
    version: '1.0.0'
  };
}

server.listen(PORT, () => {
  console.log(`BillSource AI running on port ${PORT}`);
  console.log(`Google OAuth : ${GOOGLE_CLIENT_ID     ? 'configured' : 'MISSING'}`);
  console.log(`Flowise      : ${FLOWISE_CHATFLOW_ID   ? 'configured' : 'MISSING'}`);
  console.log(`Paystack     : ${PAYSTACK_SECRET_KEY   ? 'configured' : 'not set'}`);
  console.log(`Plans        : student=${PAYSTACK_PLANS.student} professional=${PAYSTACK_PLANS.professional}`);
});
