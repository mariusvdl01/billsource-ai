// ═══════════════════════════════════════════════════════
// PROMPT MANAGER — server-side only, never served to browser
//
// IP PROTECTION — Option A (env var black box):
//   PROMPT_BOOK_DATA env var holds the full prompt book as
//   base64-encoded JSON. Template text never touches the repo.
//   Set in Railway: Settings → Variables → PROMPT_BOOK_DATA
//
// Fallback: if env var missing, loads from hardcoded data below.
//   Remove hardcoded data after setting the env var in Railway.
// ═══════════════════════════════════════════════════════

'use strict';

// ── Load from env var (black box mode) ───────────────────
let PROMPT_BOOK = null;

if (process.env.PROMPT_BOOK_DATA) {
  try {
    PROMPT_BOOK = JSON.parse(
      Buffer.from(process.env.PROMPT_BOOK_DATA, 'base64').toString('utf8')
    );
    console.log('PROMPT_BOOK: loaded from PROMPT_BOOK_DATA env var (' +
      Object.keys(PROMPT_BOOK).length + ' roles)');
  } catch(err) {
    console.error('PROMPT_BOOK: failed to decode PROMPT_BOOK_DATA:', err.message);
    PROMPT_BOOK = null;
  }
}

// ── Fallback: hardcoded (remove once env var is set) ─────
if (!PROMPT_BOOK) {
  console.warn('PROMPT_BOOK: PROMPT_BOOK_DATA env var not set — using hardcoded fallback');

PROMPT_BOOK = {
  cfo: {
    label: 'Bean Counter',
    plans: ['free','student','professional','business','enterprise'],
    sections: [
      {
        heading: 'BEAN COUNTER — CASH FLOW & FINANCIAL HEALTH',
        prompts: [
          { id:'cfo-cf-01', display:'Monthly cash flow health check',      template:'Analyse my business cash flow position and flag any gaps or risks for the next 30 days.' },
          { id:'cfo-cf-02', display:'12 key financial ratios report',       template:'Give me a complete analysis of the 12 most important financial ratios for my business health.' },
          { id:'cfo-cf-03', display:'Days Sales Outstanding review',        template:'Calculate and interpret my DSO and tell me what it means for my cash flow cycle.' },
          { id:'cfo-cf-04', display:'Working capital optimisation', hint:'Cash flow without new debt',         template:'How can I optimise my working capital to improve cash flow without taking on more debt?' },
        ]
      },
      {
        heading: 'BEAN COUNTER — DEBT COLLECTION & DUNNING',
        prompts: [
          { id:'cfo-dc-01', display:'30-day overdue dunning letter', hint:'30-day overdue reminder',        template:'Draft a professional but firm dunning letter for an account that is 30 days overdue.' },
          { id:'cfo-dc-02', display:'60-day escalation notice', hint:'60-day escalation notice',             template:'Draft a formal escalation notice for a debtor 60 days overdue referencing legal consequences.' },
          { id:'cfo-dc-03', display:'Final demand before legal action',     template:'Write a final demand letter for a 90-day overdue account before referring to attorneys, compliant with South African debt collection law.' },
          { id:'cfo-dc-04', display:'Debtor ageing analysis guide', hint:'Debtor ageing explained',         template:'Walk me through how to prepare and interpret a debtor ageing analysis.' },
        ]
      }
    ]
  },

  cgo: {
    label: 'The Rule Book',
    plans: ['professional','business','enterprise'],
    sections: [
      {
        heading: 'THE RULE BOOK — COMPLIANCE & REGULATION',
        prompts: [
          { id:'cgo-co-01', display:'POPIA compliance checklist', hint:'SA data protection checklist',           template:'Give me a POPIA compliance checklist for a small South African business that collects customer data.' },
          { id:'cgo-co-02', display:'NCA credit provider obligations',      template:'What are my obligations under the National Credit Act if I extend credit terms to my customers?' },
          { id:'cgo-co-03', display:'B-BBEE scorecard basics',              template:'Explain the B-BBEE scorecard elements that apply to a small business and how to improve my level.' },
          { id:'cgo-co-04', display:'CIPC compliance requirements',         template:'What annual CIPC filings and obligations does my (Pty) Ltd company need to comply with?' },
          { id:'cgo-co-05', display:'Employment contract essentials', hint:'Employment contract must-haves',       template:'What must be included in a South African employment contract to comply with the BCEA?' },
          { id:'cgo-co-06', display:'King IV for SMEs',                     template:'Summarise the King IV governance principles that are most relevant and applicable to an SME.' },
        ]
      }
    ]
  },

  cmo: {
    label: 'Brand Guru',
    plans: ['business','enterprise'],
    sections: [
      {
        heading: 'BRAND GURU — MARKETING & BRAND',
        prompts: [
          { id:'cmo-br-01', display:'90-day content calendar', hint:'90-day content plan',              template:'Build me a 90-day social media content calendar for a South African B2B service business.' },
          { id:'cmo-br-02', display:'Brand positioning statement', hint:'Stand out in your market',          template:'Help me write a brand positioning statement for my business that differentiates me in the SA market.' },
          { id:'cmo-br-03', display:'Google Ads campaign brief',            template:'Write a Google Ads campaign brief for my business targeting South African SME decision-makers.' },
          { id:'cmo-br-04', display:'Customer acquisition strategy',        template:'What are the most cost-effective customer acquisition channels for a South African SME in my sector?' },
          { id:'cmo-br-05', display:'Social media audit',                   template:'Audit my social media presence and give me a priority action list to improve engagement and reach.' },
        ]
      }
    ]
  },

  cso: {
    label: 'Deal Maker',
    plans: ['enterprise'],
    sections: [
      {
        heading: 'DEAL MAKER — SALES & PIPELINE',
        prompts: [
          { id:'cso-sl-01', display:'Sales proposal template', hint:'B2B proposal template',              template:'Write a professional sales proposal template for a South African B2B service business.' },
          { id:'cso-sl-02', display:'Objection handling guide', hint:'SA sales objection guide',             template:'Give me responses to the 5 most common sales objections in the South African market.' },
          { id:'cso-sl-03', display:'Pipeline review framework',            template:'How should I structure a weekly pipeline review to improve my close rate?' },
          { id:'cso-sl-04', display:'Pricing strategy review', hint:'Are you underpricing?',              template:'Help me review my pricing strategy and identify whether I am underpricing my services.' },
          { id:'cso-sl-05', display:'Client retention playbook',            template:'Build me a client retention playbook for my top 10 accounts.' },
        ]
      }
    ]
  },

  coo: {
    label: 'The Fixer',
    plans: ['enterprise'],
    sections: [
      {
        heading: 'THE FIXER — OPERATIONS',
        prompts: [
          { id:'coo-op-01', display:'One-page SOP template', hint:'SOP template',                template:'Write a one-page SOP template for my most repeated business process.' },
          { id:'coo-op-02', display:'Supplier risk assessment',             template:'Help me assess the risk of my current supplier dependencies and identify single points of failure.' },
          { id:'coo-op-03', display:'Business continuity plan', hint:'Continuity planning guide',             template:'Help me draft a basic business continuity plan covering load shedding, key person risk, and supplier failure.' },
          { id:'coo-op-04', display:'Vendor negotiation framework',         template:'Give me a vendor negotiation framework and talking points for renegotiating my top 3 supplier contracts.' },
          { id:'coo-op-05', display:'Process automation audit',             template:'Audit my business processes and identify which ones could be automated to save time and reduce errors.' },
        ]
      }
    ]
  },

  // ═══════════════════════════════════════════
  // THE IT GUY — 1st, 2nd & 3rd Line Support
  // 1st line: free, student, professional, business, enterprise
  // 2nd line: professional, business, enterprise
  // 3rd line: enterprise only
  // ═══════════════════════════════════════════
  tech: {
    label: 'The IT Guy',
    plans: ['free','student','professional','business','enterprise'],
    sections: [

      // ── 1ST LINE ─────────────────────────
      {
        heading: 'THE IT GUY — 1ST LINE SUPPORT',
        minPlan: 'free',
        prompts: [
          { id:'it-1l-01', display:'I forgot my password',                  template:'I forgot my Windows password and cannot log in. Walk me through how to reset it step by step for my version of Windows.' },
          { id:'it-1l-02', display:'My account is locked',                  template:'My computer account is locked and I cannot get in. What are the steps to unlock it, and why does this happen?' },
          { id:'it-1l-03', display:'Windows Hello not working',             template:'My fingerprint and PIN have stopped working on Windows Hello. How do I reset them without losing my files?' },
          { id:'it-1l-04', display:'Outlook connection error', hint:'Email connection troubleshooter',              template:'Outlook is showing a connection error and I cannot send or receive email. Give me a step-by-step troubleshooting checklist.' },
          { id:'it-1l-05', display:'Computer is very slow',                 template:'My computer takes ages to start up and is slow during the day. Give me a prioritised list of things to check and fix.' },
          { id:'it-1l-06', display:'Printer not working',                   template:'The office printer is not printing and my document is stuck in the queue. Walk me through how to fix this.' },
          { id:'it-1l-07', display:'No internet connection',                template:'My WiFi shows connected but nothing will load. Help me diagnose and fix the internet connection step by step.' },
          { id:'it-1l-08', display:'USB drive not recognised',              template:'My USB drive is not showing up on my computer. What should I check and how do I fix it?' },
          { id:'it-1l-09', display:'Second monitor stopped working',        template:'My second monitor stopped working after a Windows update. How do I get it working again?' },
          { id:'it-1l-10', display:'Microsoft Teams keeps crashing',        template:'Microsoft Teams crashes every time I open it. What are the steps to fix this without reinstalling Windows?' },
        ]
      },

      // ── 2ND LINE ─────────────────────────
      {
        heading: 'THE IT GUY — 2ND LINE SUPPORT',
        minPlan: 'professional',
        prompts: [
          { id:'it-2l-01', display:'Create a Microsoft 365 account',        template:'Walk me through how to create a new Microsoft 365 account for a new employee, including licence assignment, MFA setup, and email configuration.' },
          { id:'it-2l-02', display:'Set up Google Workspace user',          template:'How do I set up a new user on Google Workspace with access to Gmail, Drive, and Meet, including group assignment and calendar setup?' },
          { id:'it-2l-03', display:'Create an AWS account for my team',     template:'Guide me through creating a new AWS IAM user for my development team with the right permissions, MFA, and billing alerts.' },
          { id:'it-2l-04', display:'Set up VPN for a remote employee',      template:'How do I set up VPN access for a remote staff member? Walk me through the process including client install, credentials, and testing.' },
          { id:'it-2l-05', display:'Software licence audit', hint:'Cut your software bill',                template:'We have exceeded our software licence count. Help me audit our licences, identify inactive users, and decide whether to reclaim or upgrade.' },
          { id:'it-2l-06', display:'Manage Active Directory users',         template:'I need to move a user to a different OU and update their group memberships in Active Directory. Walk me through the steps.' },
          { id:'it-2l-07', display:'Create a shared mailbox',               template:'How do I create a shared mailbox in Microsoft 365 for a team so everyone receives the same emails, with the right delegate permissions?' },
          { id:'it-2l-08', display:'Enrol a laptop into Intune MDM',        template:'Walk me through enrolling a new Windows laptop into our Microsoft Intune MDM policy, including compliance and app deployment.' },
          { id:'it-2l-09', display:'Verify server backups ran',             template:'How do I check that our server backups ran successfully last night and what does a successful backup log look like?' },
          { id:'it-2l-10', display:'Open a firewall port safely',           template:'A developer needs a port opened on our firewall to an external API. Walk me through how to do this safely with proper logging and a rollback plan.' },
        ]
      },

      // ── 3RD LINE ─────────────────────────
      {
        heading: 'THE IT GUY — 3RD LINE & AI-ASSISTED',
        minPlan: 'enterprise',
        prompts: [
          { id:'it-3l-01', display:'Write a Claude prompt for coding',      template:'Help me write an optimised Claude prompt to build a Python function that reads a CSV and inserts records into a SQL database, including error handling and edge cases.' },
          { id:'it-3l-02', display:'Turn a feature request into requirements', template:'I have a new feature request from the business. Help me turn it into structured technical requirements with functional specs, acceptance criteria, and edge cases.' },
          { id:'it-3l-03', display:'Claude prompt for architecture review', template:'Write a Claude prompt I can use to get a full architecture review of our Node.js and PostgreSQL SaaS product, including scalability risks and security recommendations.' },
          { id:'it-3l-04', display:'Generate UI/UX design guidelines',      template:'Write a Claude prompt to generate a complete UI/UX design system for our internal business app, covering colour, typography, components, and accessibility.' },
          { id:'it-3l-05', display:'Claude prompt for code review',         template:'Give me a Claude prompt to review my pull request for security vulnerabilities and performance issues, with output structured as a prioritised findings report.' },
          { id:'it-3l-06', display:'Design an API integration',             template:'Write a Claude prompt to help design a third-party API integration covering authentication, error handling, retry logic, idempotency, and a test plan.' },
          { id:'it-3l-07', display:'Design a multi-tenant database schema', template:'Write a Claude prompt to design a PostgreSQL database schema for a multi-tenant SaaS application with row-level security and a migration plan.' },
          { id:'it-3l-08', display:'Write a GitHub Actions CI/CD pipeline', template:'Help me write a Claude prompt to build a GitHub Actions pipeline for our Node.js app covering lint, test, Docker build, and deployment to our hosting platform.' },
          { id:'it-3l-09', display:'Diagnose a production memory leak',     template:'Write a Claude prompt to help diagnose a memory leak in our Express.js production API, including heap profiling approach and potential fixes.' },
          { id:'it-3l-10', display:'What device should I buy?',             template:'Help me select the right computer or device for my role. Ask me about my daily tasks, whether I am fixed-desk or mobile, my budget, and any specific software I use, then give me a specific recommendation with brand and model.' },
        ]
      },

      // ── TECH SELECTION GUIDE ─────────────────
      // Available on all plans — helps users choose personal technology
      {
        heading: 'THE IT GUY — PERSONAL TECHNOLOGY GUIDE',
        minPlan: 'student',
        prompts: [
          { id:'it-ts-01', display:'Which laptop suits a business owner?',    hint:'For the business owner on the move',     template:'I am a business owner who travels frequently and needs to stay connected. I use email, video calls, and presentations. What laptop should I buy, what specifications do I need, and what brands are recommended in South Africa?' },
          { id:'it-ts-02', display:'Best setup for a fixed office desk?',     hint:'Fixed desk setup guide',             template:'I work at a fixed desk all day using Microsoft Office and accounting software. Should I buy a desktop PC or a laptop, and what monitor, keyboard and mouse setup do you recommend?' },
          { id:'it-ts-03', display:'Tech for a sales rep on the road?',       hint:'For reps who live on the road',     template:'I am in sales and spend most of my time at client sites doing demos and presentations. What lightweight laptop with long battery life should I buy, and do I need a mobile data solution?' },
          { id:'it-ts-04', display:'What does a developer need?',             hint:'Developer hardware guide',            template:'I am a software developer who runs Docker containers, multiple development environments, and compiles code regularly. What computer should I buy — PC or Mac — and what specifications do I need?' },
          { id:'it-ts-05', display:'Hardware for graphic design and video?',  hint:'Design and video hardware guide',  template:'I do graphic design and video editing using Adobe Premiere and Photoshop. What hardware do I need, what GPU is recommended, and what display specifications matter for accurate colours?' },
          { id:'it-ts-06', display:'Best device for working from home?',      hint:'Home office setup guide',       template:'I work from home full-time using Microsoft Teams, Google Workspace, and cloud tools. What laptop and home office peripherals — monitor, webcam, headset — do you recommend?' },
          { id:'it-ts-07', display:'Rugged devices for warehouse or field?',  hint:'For warehouse and field teams',   template:'Our team works in a warehouse or field environment and needs devices that can handle rough conditions and barcode scanning. What rugged tablets or devices do you recommend for South African businesses?' },
          { id:'it-ts-08', display:'Affordable tech for interns and students?', hint:'Affordable options for new hires',   template:'We are hiring interns who need basic computing for research, documents, and email. What affordable laptop or Chromebook do you recommend, and what are the minimum specifications?' },
          { id:'it-ts-09', display:'Compare PC vs Mac for my business?',      hint:'PC or Mac — which is right for you?',       template:'Help me decide between a Windows PC and a Mac for my business. Compare them on cost, software compatibility, support, and long-term value for a South African SME.' },
          { id:'it-ts-10', display:'Build a full office tech bundle?',         hint:'Full office tech bundle guide',             template:'I am setting up a new office for 5 people. What complete technology bundle do I need — computers, monitors, printers, networking, phones, and accessories — and what is a realistic budget in South African rand?' },
        ]
      }
    ]
  }
};

}

// ── Build TEMPLATE_MAP from whichever source loaded ──────────
// Flat id→template lookup in server memory — never serialised to clients
const PLAN_HIERARCHY = ['free','student','professional','business','enterprise'];
const TEMPLATE_MAP = {};
for (const [, data] of Object.entries(PROMPT_BOOK)) {
  for (const section of data.sections) {
    for (const p of section.prompts) {
      TEMPLATE_MAP[p.id] = {
        template:    p.template,
        minPlan:     section.minPlan || data.plans[0],
        roleMinPlan: data.plans[0]
      };
    }
  }
}
console.log('PROMPT_BOOK: TEMPLATE_MAP built —', Object.keys(TEMPLATE_MAP).length, 'prompts indexed');

// ── resolvePromptTemplate ────────────────────────────────────
function resolvePromptTemplate(promptId, userPlan) {
  const entry = TEMPLATE_MAP[promptId];
  if (!entry) return null;
  const planIdx    = PLAN_HIERARCHY.indexOf(userPlan);
  const minPlanIdx = PLAN_HIERARCHY.indexOf(entry.minPlan);
  if (planIdx < 0 || planIdx < minPlanIdx) return null;
  return entry.template;
}

// ── getUserPrompts ───────────────────────────────────────────
// Returns display labels + hints only — template text never leaves server
function getUserPrompts(userPlan) {
  const planIdx = PLAN_HIERARCHY.indexOf(userPlan);
  const result = [];
  for (const [role, data] of Object.entries(PROMPT_BOOK)) {
    const roleMinIdx   = PLAN_HIERARCHY.indexOf(data.plans[0]);
    const roleUnlocked = planIdx >= roleMinIdx;
    const sections = data.sections.map(section => {
      const sectionMinPlan  = section.minPlan || data.plans[0];
      const sectionMinIdx   = PLAN_HIERARCHY.indexOf(sectionMinPlan);
      const sectionUnlocked = planIdx >= sectionMinIdx;
      return {
        heading:      section.heading,
        locked:       !sectionUnlocked,
        requiredPlan: sectionUnlocked ? null : sectionMinPlan,
        prompts: section.prompts.map(p => ({
          id:     p.id,
          title:  p.display,
          hint:   p.hint || null,
          text:   null,           // always null — template never sent to browser
          locked: !sectionUnlocked
        }))
      };
    });
    result.push({ role, label: data.label, unlocked: roleUnlocked, sections });
  }
  return result;
}

module.exports = { getUserPrompts, resolvePromptTemplate };
