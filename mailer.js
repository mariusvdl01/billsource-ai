// ═══════════════════════════════════════════
// MAILER — Resend API (HTTPS, works on Railway)
// Railway vars needed:
//   RESEND_API_KEY   re_xxxxxxxxxxxx
//   MAIL_FROM        Billi <billi@billsource.ai>
//   MAIL_OWNER       marius@billsource.co.za
// Get free key at resend.com — 3,000 emails/mo free
// ═══════════════════════════════════════════

const https = require('https');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM      = process.env.MAIL_FROM      || 'Billi <onboarding@resend.dev>';
const MAIL_OWNER     = process.env.MAIL_OWNER     || 'marius@billsource.co.za';
const BASE_URL       = process.env.BASE_URL        || 'https://billsource.ai';

function resendPost(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(d));
        } else {
          reject(new Error(`Resend ${res.statusCode}: ${d}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Merch order — notify owner + confirm to customer ──
async function sendMerchOrderEmails({ customerEmail, item, size, amount, reference }) {
  if (!RESEND_API_KEY) { console.log('RESEND_API_KEY not set — skipping emails'); return; }

  const itemLabel   = formatItem(item, size);
  const amountLabel = `R${(amount/100).toFixed(2)}`;
  const orderDate   = new Date().toLocaleString('en-ZA', {timeZone:'Africa/Johannesburg'});

  // Email to Marius
  await resendPost({
    from:    MAIL_FROM,
    to:      [MAIL_OWNER],
    subject: `🛒 New Billi merch order — ${itemLabel}`,
    html: `
      <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#F59E0B;padding:20px 24px;border-radius:10px 10px 0 0">
          <h2 style="color:#fff;margin:0;font-size:20px">New Merch Order</h2>
        </div>
        <div style="background:#fff;padding:24px;border:1px solid #eee;border-radius:0 0 10px 10px">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#666;width:140px">Product</td>
                <td style="padding:8px 0;font-weight:700">${itemLabel}</td></tr>
            <tr><td style="padding:8px 0;color:#666">Amount</td>
                <td style="padding:8px 0;font-weight:700;color:#F59E0B">${amountLabel}</td></tr>
            <tr><td style="padding:8px 0;color:#666">Customer</td>
                <td style="padding:8px 0">${customerEmail}</td></tr>
            <tr><td style="padding:8px 0;color:#666">Reference</td>
                <td style="padding:8px 0;font-family:monospace;font-size:13px">${reference}</td></tr>
            <tr><td style="padding:8px 0;color:#666">Date</td>
                <td style="padding:8px 0">${orderDate}</td></tr>
          </table>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
          <p style="margin:0;color:#666;font-size:13px">
            <strong>Action required:</strong> Fulfill this order and email
            <a href="mailto:${customerEmail}">${customerEmail}</a> with tracking/delivery details.
          </p>
          <p style="margin:12px 0 0;font-size:12px;color:#999">
            Ref: ${reference} &nbsp;·&nbsp;
            <a href="https://dashboard.paystack.com/#/transactions">Paystack Dashboard</a>
          </p>
        </div>
      </div>`
  });

  // Confirmation to customer
  await resendPost({
    from:    MAIL_FROM,
    to:      [customerEmail],
    subject: `Order confirmed — ${itemLabel} 🧡`,
    html: `
      <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#F59E0B;padding:20px 24px;border-radius:10px 10px 0 0;text-align:center">
          <div style="font-size:48px">🧡</div>
          <h2 style="color:#fff;margin:8px 0 0;font-size:20px">Order Confirmed!</h2>
        </div>
        <div style="background:#fff;padding:24px;border:1px solid #eee;border-radius:0 0 10px 10px">
          <p style="color:#333;font-size:15px;margin:0 0 16px">
            Thanks for your Billi merch order. We've got it and we're on it.
          </p>
          <div style="background:#fef9f0;border:1px solid #F59E0B;border-radius:8px;padding:16px;margin-bottom:20px">
            <div style="font-weight:700;color:#92400E;margin-bottom:4px">${itemLabel}</div>
            <div style="color:#666;font-size:13px">Amount paid: ${amountLabel}</div>
            <div style="color:#999;font-size:12px;margin-top:4px">Ref: ${reference}</div>
          </div>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 16px">
            We'll send delivery details and tracking as soon as your order ships.
            Most orders ship within 3–5 business days.
          </p>
          <p style="color:#555;font-size:14px;margin:0 0 20px">
            Questions? <a href="mailto:support@billsource.ai" style="color:#F59E0B">support@billsource.ai</a>
          </p>
          <div style="text-align:center;margin-top:24px">
            <a href="${BASE_URL}/app"
               style="background:#F59E0B;color:#fff;padding:12px 28px;border-radius:8px;
                      text-decoration:none;font-weight:700;font-size:14px;display:inline-block">
              Chat with Billi →
            </a>
          </div>
          <p style="color:#999;font-size:11px;text-align:center;margin:20px 0 0">
            BillSource · Billi AI · billsource.ai
          </p>
        </div>
      </div>`
  });

  console.log(`Merch emails sent: ${MAIL_OWNER} + ${customerEmail} — ${itemLabel}`);
}

// ── Plan upgrade confirmation ──
async function sendPlanUpgradeEmail({ customerEmail, planName, messagesLimit }) {
  if (!RESEND_API_KEY) return;

  const planEmoji = {student:'🎓',professional:'💼',business:'🚀',enterprise:'⚡'}[planName] || '✅';

  await resendPost({
    from:    MAIL_FROM,
    to:      [customerEmail],
    subject: `${planEmoji} You're on the ${capitalize(planName)} plan`,
    html: `
      <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#F59E0B;padding:20px 24px;border-radius:10px 10px 0 0;text-align:center">
          <div style="font-size:48px">${planEmoji}</div>
          <h2 style="color:#fff;margin:8px 0 0">You're upgraded!</h2>
        </div>
        <div style="background:#fff;padding:24px;border:1px solid #eee;border-radius:0 0 10px 10px">
          <p style="font-size:15px;color:#333;margin:0 0 16px">
            Your Billi <strong>${capitalize(planName)}</strong> plan is now active.
          </p>
          <div style="background:#fef9f0;border:1px solid #F59E0B;border-radius:8px;padding:16px;margin-bottom:20px">
            <div style="font-weight:700;color:#92400E">${capitalize(planName)} Plan</div>
            <div style="color:#666;font-size:13px;margin-top:4px">${messagesLimit} messages per month</div>
          </div>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 20px">
            Your full associate team is ready. Ask Billi anything about money, marketing,
            sales, compliance or operations.
          </p>
          <div style="text-align:center">
            <a href="${BASE_URL}/app"
               style="background:#F59E0B;color:#fff;padding:12px 28px;border-radius:8px;
                      text-decoration:none;font-weight:700;font-size:14px;display:inline-block">
              Open Billi →
            </a>
          </div>
        </div>
      </div>`
  });

  console.log(`Plan upgrade email sent: ${customerEmail} → ${planName}`);
}

function formatItem(item, size) {
  const names = {hoodie:'Billi Hoodie',cap:'Billi Cap',mug:'Billi Mug',tee:'Billi Tee'};
  const sizes  = {sml:'S/M/L',xl:'XL/XXL','3xl':'3XL',black:'Black',white:'White','330':'330ml','470':'470ml'};
  return `${names[item]||item}${size?' — '+(sizes[size]||size):''}`;
}

// ── Magic link login email ──
async function sendMagicLink({ email, magicUrl }) {
  if (!RESEND_API_KEY) {
    console.log(`RESEND_API_KEY not set — magic link for ${email}: ${magicUrl}`);
    return;
  }

  await resendPost({
    from:    MAIL_FROM,
    to:      [email],
    subject: 'Your Billi sign-in link',
    html: `
      <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#C45200;padding:20px 24px;border-radius:10px 10px 0 0;text-align:center">
          <div style="font-size:48px">🔐</div>
          <h2 style="color:#fff;margin:8px 0 0;font-size:20px">Sign in to Billi</h2>
        </div>
        <div style="background:#fff;padding:28px 24px;border:1px solid #eee;border-radius:0 0 10px 10px">
          <p style="color:#333;font-size:15px;margin:0 0 8px">
            Click the button below to sign in to your Billi account.
          </p>
          <p style="color:#666;font-size:13px;margin:0 0 28px">
            No password needed — one click and you're in.
          </p>
          <div style="text-align:center;margin-bottom:28px">
            <a href="${magicUrl}"
               style="background:#C45200;color:#fff;padding:14px 36px;border-radius:8px;
                      text-decoration:none;font-weight:700;font-size:15px;display:inline-block;
                      letter-spacing:0.01em">
              Sign in to Billi →
            </a>
          </div>
          <div style="background:#fef9f0;border:1px solid #f0d9c8;border-radius:8px;
                      padding:14px 16px;margin-bottom:20px">
            <p style="margin:0;font-size:12px;color:#92400E;line-height:1.6">
              <strong>This link expires in 30 minutes</strong> and can only be used once.
              If you did not request this, you can safely ignore this email — no account changes were made.
            </p>
          </div>
          <p style="color:#999;font-size:12px;margin:0 0 4px">
            If the button above does not work, copy and paste this URL into your browser:
          </p>
          <p style="color:#C45200;font-size:11px;word-break:break-all;margin:0 0 24px;
                    font-family:monospace">
            ${magicUrl}
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:0 0 16px"/>
          <p style="color:#999;font-size:11px;text-align:center;margin:0">
            Billi · Business Associate Intelligence · 
            <a href="${BASE_URL}" style="color:#C45200;text-decoration:none">billsource.ai</a>
          </p>
        </div>
      </div>`
  });

  console.log(`Magic link email sent: ${email}`);
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase()+s.slice(1) : s; }

module.exports = { sendMerchOrderEmails, sendPlanUpgradeEmail, sendMagicLink };
