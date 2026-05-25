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
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'billsource-ai-2026-secret-key';
const BASE_URL = process.env.BASE_URL || 'https://billsource.ai';
const FLOWISE_URL = process.env.FLOWISE_URL || 'https://flowiseai-production-455f.up.railway.app';
const FLOWISE_CHATFLOW_ID = process.env.FLOWISE_CHATFLOW_ID || '';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';

// Plan limits
const PLANS = {
  free:     { messages: 10,    label: 'Free' },
  solo:     { messages: 500,   label: 'Solo' },
  team:     { messages: 2000,  label: 'Team' },
  business: { messages: 10000, label: 'Business' }
};

// ═══════════════════════════════════════════
// SIMPLE IN-MEMORY SESSION STORE
// (replace with Redis or DB for production)
// ═══════════════════════════════════════════
const sessions = {};
const users = {}; // email -> user data

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
    if (err) {
      serveFile(res, path.join(ROOT, 'index.html'));
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}

// ═══════════════════════════════════════════
// GOOGLE OAUTH HELPERS
// ═══════════════════════════════════════════
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
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
    users[email] = {
      email,
      name: googleProfile.name,
      avatar: googleProfile.picture,
      googleId: googleProfile.id,
      plan: 'free',
      messagesUsed: 0,
      messagesLimit: PLANS.free.messages,
      createdAt: new Date().toISOString(),
      billingCycle: new Date().toISOString()
    };
    console.log(`New user: ${email}`);
  }
  return users[email];
}

function resetMonthlyUsage() {
  const now = new Date();
  Object.values(users).forEach(user => {
    const cycle = new Date(user.billingCycle);
    const daysDiff = (now - cycle) / (1000 * 60 * 60 * 24);
    if (daysDiff >= 30) {
      user.messagesUsed = 0;
      user.billingCycle = now.toISOString();
    }
  });
}
setInterval(resetMonthlyUsage, 60 * 60 * 1000); // check hourly

// ═══════════════════════════════════════════
// PAYSTACK HELPERS
// ═══════════════════════════════════════════
const PAYSTACK_PLANS = {
  solo:     process.env.PAYSTACK_PLAN_SOLO     || '',
  team:     process.env.PAYSTACK_PLAN_TEAM     || '',
  business: process.env.PAYSTACK_PLAN_BUSINESS || ''
};

async function paystackInitialize(email, planCode, amount) {
  const data = JSON.stringify({
    email,
    amount: amount * 100, // kobo/cents
    plan: planCode,
    callback_url: `${BASE_URL}/payment/success`,
    metadata: { email }
  });
  return httpsPost(
    'https://api.paystack.co/transaction/initialize',
    data,
    {
      'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    }
  );
}

function verifyPaystackSignature(body, signature) {
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(body)
    .digest('hex');
  return hash === signature;
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

  // ── CORS for API routes ──
  res.setHeader('Access-Control-Allow-Origin', BASE_URL);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ══════════════════════════════════════════
  // AUTH ROUTES
  // ══════════════════════════════════════════

  // Start Google OAuth
  if (pathname === '/auth/google' && method === 'GET') {
    const state = crypto.randomBytes(16).toString('hex');
    const authUrl = buildGoogleAuthUrl(state);
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // Google OAuth callback
  if (pathname === '/auth/google/callback' && method === 'GET') {
    const { code, error } = parsed.query;
    if (error || !code) {
      res.writeHead(302, { Location: '/?error=auth_failed' });
      res.end();
      return;
    }
    try {
      const tokens = await exchangeCodeForTokens(code);
      if (!tokens.access_token) throw new Error('No access token');
      const profile = await getGoogleUserInfo(tokens.access_token);
      const user = getOrCreateUser(profile);
      const sid = createSession(user);
      const cookieExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
      res.writeHead(302, {
        Location: '/app',
        'Set-Cookie': `bs_session=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${cookieExpiry}`
      });
      res.end();
    } catch (err) {
      console.error('OAuth error:', err);
      res.writeHead(302, { Location: '/?error=auth_error' });
      res.end();
    }
    return;
  }

  // Logout
  if (pathname === '/auth/logout' && method === 'GET') {
    const session = getSession(req);
    if (session) delete sessions[session.sid];
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': 'bs_session=; Path=/; HttpOnly; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    });
    res.end();
    return;
  }

  // ══════════════════════════════════════════
  // API ROUTES
  // ══════════════════════════════════════════

  // Get current user
  if (pathname === '/api/me' && method === 'GET') {
    const session = getSession(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: false }));
      return;
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
        messagesUsed: user.messagesUsed,
        messagesLimit: user.messagesLimit,
        messagesRemaining: Math.max(0, user.messagesLimit - user.messagesUsed)
      }
    }));
    return;
  }

  // Chat with Billi — enforces usage limits
  if (pathname === '/api/chat' && method === 'POST') {
    const session = getSession(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Please sign in to continue.' }));
      return;
    }
    const user = session.data.user;
    if (user.messagesUsed >= user.messagesLimit) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'limit_reached',
        message: `You have used all ${user.messagesLimit} messages on your ${PLANS[user.plan].label} plan. Please upgrade to continue.`,
        plan: user.plan
      }));
      return;
    }
    try {
      const body = await readBody(req);
      const { question } = JSON.parse(body);
      if (!question) throw new Error('No question provided');

      // Call Flowise
      const flowiseResponse = await httpsPost(
        `${FLOWISE_URL}/api/v1/prediction/${FLOWISE_CHATFLOW_ID}`,
        JSON.stringify({ question }),
        { 'Content-Type': 'application/json' }
      );

      console.log('Flowise response keys:', Object.keys(flowiseResponse || {}));
      console.log('Flowise response sample:', JSON.stringify(flowiseResponse).slice(0, 400));

      // Increment usage
      user.messagesUsed++;
      sessions[session.sid].user = user;
      users[user.email] = user;

      // Handle all known Flowise response formats
      const answer =
        (typeof flowiseResponse === 'string' ? flowiseResponse : null) ||
        flowiseResponse.text ||
        flowiseResponse.answer ||
        flowiseResponse.output ||
        flowiseResponse.message ||
        flowiseResponse.result ||
        flowiseResponse.response ||
        (Array.isArray(flowiseResponse.outputs) && flowiseResponse.outputs[0] && flowiseResponse.outputs[0].text) ||
        null;
      const finalAnswer = answer || 'Billi received your question but could not generate a response. Please check the Flowise agent is running and try again.';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        answer: finalAnswer,
        messagesUsed: user.messagesUsed,
        messagesRemaining: Math.max(0, user.messagesLimit - user.messagesUsed)
      }));
    } catch (err) {
      console.error('Chat error:', err.message, err.stack);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Billi is temporarily unavailable. Please try again.', detail: err.message }));
    }
    return;
  }

  // Initialize Paystack payment
  if (pathname === '/api/pay/initialize' && method === 'POST') {
    const session = getSession(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Please sign in first.' }));
      return;
    }
    try {
      const body = await readBody(req);
      const { plan } = JSON.parse(body);
      const planMap = { solo: 19900, team: 49900, business: 99900 }; // in cents
      const amount = planMap[plan];
      if (!amount) throw new Error('Invalid plan');
      const user = session.data.user;
      const result = await paystackInitialize(user.email, PAYSTACK_PLANS[plan], amount / 100);
      if (!result.data?.authorization_url) throw new Error('Paystack error');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: result.data.authorization_url }));
    } catch (err) {
      console.error('Payment error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payment initialization failed.' }));
    }
    return;
  }

  // Paystack webhook — activates plan after payment
  if (pathname === '/webhook/paystack' && method === 'POST') {
    const rawBody = await readBody(req);
    const signature = req.headers['x-paystack-signature'];
    if (!verifyPaystackSignature(rawBody, signature)) {
      res.writeHead(401); res.end('Invalid signature'); return;
    }
    try {
      const event = JSON.parse(rawBody);
      if (event.event === 'charge.success' || event.event === 'subscription.create') {
        const email = event.data.customer.email;
        const planCode = event.data.plan?.plan_code || '';
        let planName = 'solo';
        if (planCode === PAYSTACK_PLANS.team) planName = 'team';
        if (planCode === PAYSTACK_PLANS.business) planName = 'business';
        if (users[email]) {
          users[email].plan = planName;
          users[email].messagesLimit = PLANS[planName].messages;
          users[email].messagesUsed = 0;
          console.log(`Plan activated: ${email} -> ${planName}`);
        }
      }
    } catch (err) { console.error('Webhook error:', err); }
    res.writeHead(200); res.end('OK');
    return;
  }

  // Payment success redirect
  if (pathname === '/payment/success' && method === 'GET') {
    res.writeHead(302, { Location: '/app?payment=success' });
    res.end();
    return;
  }

  // ══════════════════════════════════════════
  // PROTECTED APP ROUTE
  // ══════════════════════════════════════════
  if (pathname === '/app' && method === 'GET') {
    const session = getSession(req);
    if (!session) {
      res.writeHead(302, { Location: '/auth/google' });
      res.end();
      return;
    }
    serveFile(res, path.join(ROOT, 'app.html'));
    return;
  }

  // ══════════════════════════════════════════
  // STATIC FILE SERVING
  // ══════════════════════════════════════════
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);

  // Add .html if no extension
  if (!path.extname(filePath)) filePath += '.html';

  // Security: prevent directory traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  serveFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`BillSource AI running on port ${PORT}`);
  console.log(`Google OAuth: ${GOOGLE_CLIENT_ID ? 'configured' : 'MISSING'}`);
  console.log(`Flowise: ${FLOWISE_CHATFLOW_ID ? 'configured' : 'MISSING - set FLOWISE_CHATFLOW_ID'}`);
  console.log(`Paystack: ${PAYSTACK_SECRET_KEY ? 'configured' : 'not configured yet'}`);
});
