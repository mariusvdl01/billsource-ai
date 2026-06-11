'use strict';

// promptbook.js — reads prompt data from PROMPT_BOOK_DATA env var
// PROMPT_BOOK_DATA is a base64-encoded JSON array of prompt objects:
// [{ id, title, plan, template, category }, ...]
// This keeps prompt templates server-side only — never sent to browser.

let _prompts = null;

function _load() {
  if (_prompts) return _prompts;
  try {
    const raw = process.env.PROMPT_BOOK_DATA;
    if (!raw) { _prompts = []; return _prompts; }
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    _prompts = JSON.parse(decoded);
  } catch(e) {
    console.warn('promptbook: could not load PROMPT_BOOK_DATA —', e.message);
    _prompts = [];
  }
  return _prompts;
}

const PLAN_ORDER = ['free','student','professional','business','enterprise'];

function planRank(plan) {
  const idx = PLAN_ORDER.indexOf(plan);
  return idx >= 0 ? idx : 0;
}

// Returns display-safe prompt list for a given plan (no templates)
function getUserPrompts(plan) {
  const prompts = _load();
  const rank = planRank(plan);
  return prompts
    .filter(p => planRank(p.plan || 'free') <= rank)
    .map(p => ({
      id:       p.id,
      title:    p.title,
      category: p.category || 'general',
      plan:     p.plan || 'free',
      locked:   false,
    }));
}

// Returns server-side template for a prompt ID (null if locked for this plan)
function resolvePromptTemplate(promptId, plan) {
  const prompts = _load();
  const prompt  = prompts.find(p => p.id === promptId);
  if (!prompt) return null;
  if (planRank(plan) < planRank(prompt.plan || 'free')) return null;
  return prompt.template || prompt.title || null;
}

module.exports = { getUserPrompts, resolvePromptTemplate };
