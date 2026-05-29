// ═══════════════════════════════════════════
// PROMPT BOOK — Server-side protected IP
// Served via /api/prompts — authenticated only
// Never exposed in client HTML or JS
// ═══════════════════════════════════════════

const PROMPT_BOOK = {
  cfo: {
    label: 'Bean Counter',
    plans: ['free','student','professional','business','enterprise'],
    sections: [
      {
        heading: 'BEAN COUNTER — CASH FLOW & FINANCIAL HEALTH',
        prompts: [
          { title: 'Monthly cash flow health check', text: 'Analyse my business cash flow position and flag any gaps or risks for the next 30 days.' },
          { title: '12 key financial ratios report', text: 'Give me a complete analysis of the 12 most important financial ratios for my business health.' },
          { title: 'Days Sales Outstanding review', text: 'Calculate and interpret my DSO and tell me what it means for my cash flow cycle.' },
          { title: 'Working capital optimisation', text: 'How can I optimise my working capital to improve cash flow without taking on more debt?' },
        ]
      },
      {
        heading: 'BEAN COUNTER — DEBT COLLECTION & DUNNING',
        prompts: [
          { title: '30-day overdue dunning letter', text: 'Draft a professional but firm dunning letter for an account that is 30 days overdue.' },
          { title: '60-day escalation notice', text: 'Draft a formal escalation notice for a debtor 60 days overdue referencing legal consequences.' },
          { title: 'Final demand before legal action', text: 'Write a final demand letter for a 90-day overdue account before referring to attorneys, compliant with South African debt collection law.' },
          { title: 'Debtor ageing analysis guide', text: 'Walk me through how to prepare and interpret a debtor ageing analysis.' },
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
          { title: 'POPIA compliance checklist', text: 'Give me a POPIA compliance checklist for a small South African business that collects customer data.' },
          { title: 'NCA credit provider obligations', text: 'What are my obligations under the National Credit Act if I extend credit terms to my customers?' },
          { title: 'B-BBEE scorecard basics', text: 'Explain the B-BBEE scorecard elements that apply to a small business and how to improve my level.' },
          { title: 'CIPC compliance requirements', text: 'What annual CIPC filings and obligations does my (Pty) Ltd company need to comply with?' },
          { title: 'Employment contract essentials', text: 'What must be included in a South African employment contract to comply with the BCEA?' },
          { title: 'King IV for SMEs', text: 'Summarise the King IV governance principles that are most relevant and applicable to an SME.' },
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
          { title: '90-day content calendar', text: 'Build me a 90-day social media content calendar for a South African B2B service business.' },
          { title: 'Brand positioning statement', text: 'Help me write a brand positioning statement for my business that differentiates me in the SA market.' },
          { title: 'Google Ads campaign brief', text: 'Write a Google Ads campaign brief for my business targeting South African SME decision-makers.' },
          { title: 'Customer acquisition strategy', text: 'What are the most cost-effective customer acquisition channels for a South African SME in my sector?' },
          { title: 'Social media audit', text: 'Audit my social media presence and give me a priority action list to improve engagement and reach.' },
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
          { title: 'Sales proposal template', text: 'Write a professional sales proposal template for a South African B2B service business.' },
          { title: 'Objection handling guide', text: 'Give me responses to the 5 most common sales objections in the South African market.' },
          { title: 'Pipeline review framework', text: 'How should I structure a weekly pipeline review to improve my close rate?' },
          { title: 'Pricing strategy review', text: 'Help me review my pricing strategy and identify whether I am underpricing my services.' },
          { title: 'Client retention playbook', text: 'Build me a client retention playbook for my top 10 accounts.' },
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
          { title: 'One-page SOP template', text: 'Write a one-page SOP template for my most repeated business process.' },
          { title: 'Supplier risk assessment', text: 'Help me assess the risk of my current supplier dependencies and identify single points of failure.' },
          { title: 'Business continuity plan', text: 'Help me draft a basic business continuity plan covering load shedding, key person risk, and supplier failure.' },
          { title: 'Vendor negotiation framework', text: 'Give me a vendor negotiation framework and talking points for renegotiating my top 3 supplier contracts.' },
          { title: 'Process automation audit', text: 'Audit my business processes and identify which ones could be automated to save time and reduce errors.' },
        ]
      }
    ]
  },
  tech: {
    label: 'Tech Advisor',
    plans: ['professional','business','enterprise'],
    sections: [
      {
        heading: 'TECH ADVISOR — SYSTEMS & DIGITAL',
        prompts: [
          { title: 'Software stack review', text: 'Review my current business software stack and identify gaps, redundancies or better alternatives.' },
          { title: 'EBPP implementation guide', text: 'What do I need to implement electronic bill presentment and payment for my customers?' },
          { title: 'Data backup strategy', text: 'Design a simple but effective data backup and recovery strategy for a small SA business.' },
          { title: 'CRM selection guide', text: 'Help me select the right CRM system for a South African SME with a team of under 10 people.' },
        ]
      }
    ]
  }
};

const PLAN_HIERARCHY = ['free','student','professional','business','enterprise'];

function getUserPrompts(userPlan) {
  const planIdx = PLAN_HIERARCHY.indexOf(userPlan);
  const result = [];
  for (const [role, data] of Object.entries(PROMPT_BOOK)) {
    const minPlan = data.plans[0];
    const minIdx = PLAN_HIERARCHY.indexOf(minPlan);
    const unlocked = planIdx >= minIdx;
    result.push({
      role,
      label: data.label,
      unlocked,
      sections: data.sections.map(s => ({
        heading: s.heading,
        prompts: unlocked ? s.prompts : s.prompts.map(p => ({
          title: p.title,
          text: null,        // ← text never sent if locked
          locked: true
        }))
      }))
    });
  }
  return result;
}

module.exports = { getUserPrompts };
