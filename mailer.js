// ═══════════════════════════════════════════
// MAILER — nodemailer via Gmail SMTP
// Railway vars needed:
//   MAIL_USER     marius@billsource.co.za (or Gmail)
//   MAIL_PASS     Gmail App Password (16 chars)
//   MAIL_OWNER    marius@billsource.co.za
// ═══════════════════════════════════════════
const nodemailer = require('nodemailer');

const MAIL_USER  = process.env.MAIL_USER  || '';
const MAIL_PASS  = process.env.MAIL_PASS  || '';
const MAIL_OWNER = process.env.MAIL_OWNER || 'marius@billsource.co.za';
const BASE_URL   = process.env.BASE_URL   || 'https://billsource.ai';

let transporter = null;

function getTransporter() {
  if (!MAIL_USER || !MAIL_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: MAIL_USER, pass: MAIL_PASS }
    });
  }
  return transporter;
}

// ── Merch order — notify owner + confirm to customer ──
async function sendMerchOrderEmails({ customerEmail, item, size, amount, reference }) {
  const t = getTransporter();
  if (!t) { console.log('Mailer not configured — skipping emails'); return; }

  const itemLabel = formatItem(item, size);
  const amountLabel = `R${(amount/100).toFixed(2)}`;
  const orderDate = new Date().toLocaleString('en-ZA', {timeZone:'Africa/Johannesburg'});

  // ── Email to Marius ──────────────────────
  await t.sendMail({
    from: `Billi Orders <${MAIL_USER}>`,
    to: MAIL_OWNER,
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
            <strong>Action required:</strong> Fulfill this order and email the customer 
            at <a href="mailto:${customerEmail}">${customerEmail}</a> with tracking/delivery details.
          </p>
          <p style="margin:12px 0 0;font-size:12px;color:#999">
            Verify payment: <a href="https://dashboard.paystack.com/#/transactions">Paystack Dashboard</a>
            &nbsp;·&nbsp; Ref: ${reference}
          </p>
        </div>
      </div>
    `
  });

  // ── Confirmation to customer ─────────────
  await t.sendMail({
    from: `Billi by BillSource <${MAIL_USER}>`,
    to: customerEmail,
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
            We'll send you delivery details and tracking as soon as your order ships. 
            Most orders ship within 3–5 business days.
          </p>
          <p style="color:#555;font-size:14px;margin:0 0 20px">
            Questions? Reply to this email or contact 
            <a href="mailto:support@billsource.ai" style="color:#F59E0B">support@billsource.ai</a>
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
      </div>
    `
  });

  console.log(`Merch emails sent: owner + ${customerEmail} — ${itemLabel}`);
}

// ── Plan upgrade confirmation to customer ──
async function sendPlanUpgradeEmail({ customerEmail, planName, messagesLimit }) {
  const t = getTransporter();
  if (!t) return;

  const planEmoji = {
    student:'🎓', professional:'💼', business:'🚀', enterprise:'⚡'
  }[planName] || '✅';

  await t.sendMail({
    from: `Billi by BillSource <${MAIL_USER}>`,
    to: customerEmail,
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
            Your full associate team is ready. Ask Billi anything — money, marketing, 
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
      </div>
    `
  });

  console.log(`Plan upgrade email sent: ${customerEmail} → ${planName}`);
}

function formatItem(item, size) {
  const names = {hoodie:'Billi Hoodie', cap:'Billi Cap', mug:'Billi Mug', tee:'Billi Tee'};
  const sizes = {sml:'S/M/L', xl:'XL/XXL', '3xl':'3XL', black:'Black', white:'White', '330':'330ml', '470':'470ml'};
  return `${names[item] || item}${size ? ' — ' + (sizes[size] || size) : ''}`;
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

module.exports = { sendMerchOrderEmails, sendPlanUpgradeEmail };
