// ═══════════════════════════════════════════════════════════════════
// BILLI RATING ENGINE — v1.0
// © 2026 AnyABEX (Pty) Ltd. All rights reserved.
//
// TRADE SECRET — CONFIDENTIAL
// This file contains proprietary formulas, weights, and thresholds
// that constitute the core IP of the Billi Business Associate
// Intelligence (BAI) platform.
//
// PROTECTION ARCHITECTURE:
//   - This module is NEVER imported by front-end code
//   - Proprietary constants (weights, thresholds, benchmarks) are
//     loaded at runtime from RATING_ENGINE_CONFIG env var only
//   - The env var is set in Railway Variables — never committed to Git
//   - .gitignore must include rating_engine_config.json
//   - API routes that call this engine require authentication
//     (Professional plan minimum) — no public exposure
//
// COMPONENTS:
//   1. Adizes Lifecycle Assessor       — stage classification + modifier
//   2. Financial Health Scorer         — OCF, FCF, DPO, ratios
//   3. Sector Performance Index        — gap/drift vs SA SMME benchmarks
//   4. Node Resilience Model           — network theory per business entity
//   5. Collision Detection Engine      — ecosystem friction risk
//   6. Digital Index                   — composite of all above
//   7. Remedy Generator                — sub-agent routing + action plan
// ═══════════════════════════════════════════════════════════════════

'use strict';

// ── Load proprietary config from env var (never from disk/Git) ──────────────
// In production: set RATING_ENGINE_CONFIG in Railway Variables as base64 JSON
// For local dev: set the env var manually — never commit the value
let _cfg = null;

function loadConfig() {
  if (_cfg) return _cfg;
  if (!process.env.RATING_ENGINE_CONFIG) {
    console.warn('RATING_ENGINE: RATING_ENGINE_CONFIG not set — using defaults');
    _cfg = _defaultConfig();
  } else {
    try {
      _cfg = JSON.parse(Buffer.from(process.env.RATING_ENGINE_CONFIG, 'base64').toString('utf8'));
      console.log('RATING_ENGINE: config loaded from env var');
    } catch (e) {
      console.error('RATING_ENGINE: failed to parse config —', e.message);
      _cfg = _defaultConfig();
    }
  }
  return _cfg;
}

// ── Default config — safe-to-publish PLACEHOLDER values only ─────────────────
// Real values must be set in RATING_ENGINE_CONFIG env var.
// These defaults produce a functional but non-proprietary result.
function _defaultConfig() {
  return {
    // ── Node Health Score weights (α, β, γ) ──
    // Real values loaded from env. Placeholders sum to 1.0.
    nodeHealth: {
      alpha: 0.34,   // Cash Flow Score weight
      beta:  0.33,   // DPO Score weight
      gamma: 0.33    // Relationship/Quality Score weight
    },

    // ── Adizes stage modifiers ──
    // Each stage applies a multiplier to the Node Health Score
    // Real stage thresholds and modifiers loaded from env
    adizes: {
      stages: {
        courtship:    { modifier: 0.85, riskBias: 'high'   },
        infancy:      { modifier: 0.80, riskBias: 'high'   },
        go_go:        { modifier: 1.05, riskBias: 'medium' },
        adolescence:  { modifier: 0.90, riskBias: 'medium' },
        prime:        { modifier: 1.10, riskBias: 'low'    },
        stable:       { modifier: 1.00, riskBias: 'low'    },
        aristocracy:  { modifier: 0.90, riskBias: 'medium' },
        salem_city:   { modifier: 0.75, riskBias: 'high'   },
        bureaucracy:  { modifier: 0.65, riskBias: 'critical'},
        dead:         { modifier: 0.50, riskBias: 'critical'}
      },
      // Classifier thresholds — real values in env
      classifiers: {
        revenueGrowthThreshold:  0.15,
        cashBurnMonths:           6,
        teamSizeInflection:      10,
        dsoInflectionPrime:      30,
        grossMarginPrime:        0.45
      }
    },

    // ── SA SMME Sector Benchmarks ──
    // Real per-sector values loaded from env
    // Structure: { sectorKey: { grossMargin, netMargin, dso, dpo, currentRatio, debtToEquity } }
    sectorBenchmarks: {
      default: {
        grossMargin:   0.38,
        netMargin:     0.08,
        dso:           35,
        dpo:           28,
        currentRatio:  1.6,
        debtToEquity:  0.9
      },
      retail: {
        grossMargin:   0.32, netMargin: 0.05, dso: 15,
        dpo: 30, currentRatio: 1.4, debtToEquity: 1.1
      },
      services: {
        grossMargin:   0.55, netMargin: 0.12, dso: 45,
        dpo: 20, currentRatio: 1.8, debtToEquity: 0.6
      },
      manufacturing: {
        grossMargin:   0.28, netMargin: 0.06, dso: 42,
        dpo: 35, currentRatio: 1.7, debtToEquity: 1.2
      },
      construction: {
        grossMargin:   0.22, netMargin: 0.04, dso: 55,
        dpo: 40, currentRatio: 1.3, debtToEquity: 1.5
      },
      healthcare: {
        grossMargin:   0.48, netMargin: 0.10, dso: 62,
        dpo: 22, currentRatio: 1.9, debtToEquity: 0.8
      },
      technology: {
        grossMargin:   0.65, netMargin: 0.14, dso: 38,
        dpo: 18, currentRatio: 2.1, debtToEquity: 0.5
      },
      agriculture: {
        grossMargin:   0.25, netMargin: 0.05, dso: 30,
        dpo: 45, currentRatio: 1.5, debtToEquity: 1.3
      },
      hospitality: {
        grossMargin:   0.35, netMargin: 0.06, dso: 10,
        dpo: 25, currentRatio: 0.9, debtToEquity: 1.8
      }
    },

    // ── Digital Index component weights ──
    // These five weights must sum to 1.0
    digitalIndex: {
      wFinancialHealth:    0.30,
      wNodeResilience:     0.25,
      wSectorGap:          0.20,
      wCollisionRisk:      0.15,
      wAdizesModifier:     0.10
    },

    // ── Collision Detection thresholds ──
    collision: {
      frictionThresholdDays:   7,   // payment delay beyond DPO triggers friction
      cascadeDepth:            2,   // how many hops to propagate risk
      concentrationLimit:      0.4, // single counterparty > 40% = high risk
      minTransactionsForScore: 3    // need at least 3 transactions for reliable score
    },

    // ── Risk level thresholds for Digital Index (0–100) ──
    riskThresholds: {
      low:      75,
      moderate: 55,
      elevated: 35
      // below elevated = critical
    }
  };
}

// ════════════════════════════════════════════════════════════════════
// COMPONENT 1 — ADIZES LIFECYCLE ASSESSOR
// Classifies business into one of 10 Adizes stages based on
// financial signals, then returns a stage modifier for the engine.
// ════════════════════════════════════════════════════════════════════

function assessAdizesStage(data, providedStage) {
  const cfg = loadConfig();

  // If caller provides a stage (e.g. from user self-assessment), use it
  if (providedStage && cfg.adizes.stages[providedStage]) {
    return {
      stage:    providedStage,
      modifier: cfg.adizes.stages[providedStage].modifier,
      riskBias: cfg.adizes.stages[providedStage].riskBias,
      source:   'provided'
    };
  }

  // Auto-classify from financial signals
  const { revenue, annualRevenue, netProfit, grossMargin,
          currentRatio, debtToEquity, dso, revenueGrowthRate,
          employeeCount, yearsInOperation } = data;

  const c = cfg.adizes.classifiers;
  const gm = grossMargin || 0;
  const cr = currentRatio || 1;
  const dte = debtToEquity || 1;
  const growth = revenueGrowthRate || 0;
  const years = yearsInOperation || 0;
  const employees = employeeCount || 1;

  let stage;

  if (years < 1 && revenue < 50000) {
    stage = 'courtship';
  } else if (years < 2 && revenue < 200000 && growth > c.revenueGrowthThreshold) {
    stage = 'infancy';
  } else if (growth > c.revenueGrowthThreshold && cr < 1.2 && employees < c.teamSizeInflection) {
    stage = 'go_go';
  } else if (growth > 0 && gm < c.grossMarginPrime && dte > 1.0) {
    stage = 'adolescence';
  } else if (gm >= c.grossMarginPrime && cr >= 1.5 && dso <= c.dsoInflectionPrime && netProfit > 0) {
    stage = 'prime';
  } else if (gm >= 0.35 && cr >= 1.3 && growth < 0.05 && netProfit > 0) {
    stage = 'stable';
  } else if (growth < 0.02 && gm >= 0.30 && cr >= 1.0 && dte > 0.8) {
    stage = 'aristocracy';
  } else if (netProfit < 0 && cr >= 0.8 && dte > 1.2) {
    stage = 'salem_city';
  } else if (netProfit < 0 && cr < 0.8) {
    stage = 'bureaucracy';
  } else {
    stage = 'stable'; // default to stable for ambiguous profiles
  }

  return {
    stage,
    modifier: cfg.adizes.stages[stage].modifier,
    riskBias: cfg.adizes.stages[stage].riskBias,
    source:   'auto-classified'
  };
}

// ════════════════════════════════════════════════════════════════════
// COMPONENT 2 — FINANCIAL HEALTH SCORER
// Calculates OCF, FCF, and all standard ratios.
// Returns a normalised Financial Health Score (0–100).
// ════════════════════════════════════════════════════════════════════

function scoreFinancialHealth(data) {
  const {
    revenue, costOfSales, operatingExpenses, netProfit,
    currentAssets, currentLiabilities, accountsReceivable,
    accountsPayable, inventory, totalDebt, equity,
    annualRevenue, nonCashExpenses, capex, workingCapitalChange
  } = data;

  const ratios = {};

  // ── Standard ratios ──
  ratios.grossMargin    = ((revenue - costOfSales) / revenue) * 100;
  ratios.netMargin      = (netProfit / revenue) * 100;
  ratios.operatingMargin= (((revenue - costOfSales) - operatingExpenses) / revenue) * 100;
  ratios.currentRatio   = currentAssets / currentLiabilities;
  ratios.quickRatio     = (currentAssets - inventory) / currentLiabilities;
  ratios.debtToEquity   = totalDebt / equity;
  ratios.returnOnEquity = (netProfit / equity) * 100;
  // DSO and DPO must use annual figures — annualRevenue is always annual;
  // costOfSales passed in may be monthly, so annualise it if it looks monthly
  const annualCoS = costOfSales * 12 < annualRevenue
    ? costOfSales * 12   // monthly CoS detected — annualise
    : costOfSales;       // already annual (or close enough)
  ratios.dso            = (accountsReceivable / annualRevenue) * 365;
  ratios.dpo            = (accountsPayable    / annualCoS)     * 365;
  ratios.cashConversionCycle = ratios.dso - ratios.dpo;

  // ── OCF — Operating Cash Flow ──
  // OCF = Net Income + Non-cash Expenses + Changes in Working Capital
  const nce = nonCashExpenses || (netProfit * 0.08); // estimate if not provided
  const wcc = workingCapitalChange || (-(accountsReceivable - accountsPayable));
  ratios.ocf = netProfit + nce + wcc;

  // ── FCF — Free Cash Flow ──
  // FCF = OCF - Capital Expenditures
  const capexVal = capex || (annualRevenue * 0.03); // estimate 3% of revenue if not provided
  ratios.fcf = ratios.ocf - capexVal;

  // ── Normalised Financial Health Score (0–100) ──
  // Five dimensions, each 0–100, then weighted average
  const dimLiquidity    = _scale(ratios.currentRatio,   0.5, 2.5,  0, 100);
  const dimProfitability= _scale(ratios.netMargin,      -20,  25,  0, 100);
  const dimEfficiency   = _scale(ratios.dso,            90,   15,  0, 100); // inverted — lower is better
  const dimLeverage     = _scale(ratios.debtToEquity,   3.0, 0.2,  0, 100); // inverted
  const dimCashFlow     = ratios.ocf > 0 ? Math.min(100, 50 + (ratios.ocf / (annualRevenue * 0.01))) : Math.max(0, 50 + (ratios.ocf / (annualRevenue * 0.01)));

  const financialHealthScore = Math.round(
    dimLiquidity     * 0.25 +
    dimProfitability * 0.30 +
    dimEfficiency    * 0.20 +
    dimLeverage      * 0.15 +
    dimCashFlow      * 0.10
  );

  return {
    ratios:              _roundAll(ratios),
    financialHealthScore: Math.min(100, Math.max(0, financialHealthScore)),
    dimensions: {
      liquidity:     Math.round(dimLiquidity),
      profitability: Math.round(dimProfitability),
      efficiency:    Math.round(dimEfficiency),
      leverage:      Math.round(dimLeverage),
      cashFlow:      Math.round(Math.min(100, Math.max(0, dimCashFlow)))
    }
  };
}

// ════════════════════════════════════════════════════════════════════
// COMPONENT 3 — SECTOR PERFORMANCE INDEX
// Compares each ratio against SA SMME sector benchmarks.
// Returns gap scores and a drift flag.
// ════════════════════════════════════════════════════════════════════

function scoreSectorPerformance(ratios, sector) {
  const cfg = loadConfig();
  const bench = cfg.sectorBenchmarks[sector] || cfg.sectorBenchmarks.default;

  const gaps = {};

  // Gap = (actual - benchmark) / benchmark * 100  → positive = above benchmark
  gaps.grossMarginGap = ((ratios.grossMargin / 100) - bench.grossMargin) / bench.grossMargin * 100;
  gaps.netMarginGap   = ((ratios.netMargin   / 100) - bench.netMargin)   / bench.netMargin   * 100;
  gaps.dsoGap         = (bench.dso - ratios.dso) / bench.dso * 100;    // inverted: lower DSO = positive gap
  gaps.dpoGap         = (ratios.dpo - bench.dpo) / bench.dpo * 100;    // higher DPO = positive gap
  gaps.currentRatioGap= (ratios.currentRatio - bench.currentRatio) / bench.currentRatio * 100;
  gaps.leverageGap    = (bench.debtToEquity - ratios.debtToEquity)  / bench.debtToEquity * 100; // inverted

  // Weighted gap score (0–100): average of clamped gap contributions
  const gapScore = Math.round(
    _clamp(50 + gaps.grossMarginGap * 0.5,  0, 100) * 0.20 +
    _clamp(50 + gaps.netMarginGap   * 0.5,  0, 100) * 0.25 +
    _clamp(50 + gaps.dsoGap         * 0.3,  0, 100) * 0.20 +
    _clamp(50 + gaps.dpoGap         * 0.2,  0, 100) * 0.10 +
    _clamp(50 + gaps.currentRatioGap* 0.3,  0, 100) * 0.15 +
    _clamp(50 + gaps.leverageGap    * 0.3,  0, 100) * 0.10
  );

  // Drift detection: > 2 dimensions below benchmark by >20% = drift flagged
  const belowBenchmark = Object.values(gaps).filter(g => g < -20).length;
  const driftDetected  = belowBenchmark >= 2;

  return {
    benchmark:     bench,
    gaps:          _roundAll(gaps),
    gapScore:      Math.min(100, Math.max(0, gapScore)),
    driftDetected,
    dimensionsBelow: belowBenchmark,
    sector:        sector || 'default'
  };
}

// ════════════════════════════════════════════════════════════════════
// COMPONENT 4 — NODE RESILIENCE MODEL
// Applies network theory to model business health as a node in the
// Billsource ecosystem. Uses the proprietary Node Health Score formula:
//   NHS = α*(Cash Flow Score) + β*(DPO Score) + γ*(Relationship Score)
// ════════════════════════════════════════════════════════════════════

function scoreNodeResilience(data, ratios, ecosystemData) {
  const cfg = loadConfig();
  const { alpha, beta, gamma } = cfg.nodeHealth;

  // ── Cash Flow Score (0–100) ──
  // Based on OCF positivity and FCF adequacy
  const ocfScore  = ratios.ocf > 0
    ? Math.min(100, 50 + (ratios.ocf / ((data.annualRevenue || 1) * 0.005)))
    : Math.max(0,   50 + (ratios.ocf / ((data.annualRevenue || 1) * 0.005)));

  // ── DPO Score (0–100) ──
  // Higher DPO relative to DSO = more resilient (collecting before paying)
  const dpoNetScore = ratios.dpo - ratios.dso; // positive = resilient
  const dpoScore    = _clamp(50 + (dpoNetScore * 1.2), 0, 100);

  // ── Relationship / Quality Score (0–100) ──
  // Derived from ecosystem data: counterparty concentration, payment history
  let relationshipScore = 60; // default if no ecosystem data
  if (ecosystemData) {
    const { participantCount, avgPaymentDelayDays, concentrationRatio,
            onTimePaymentRate } = ecosystemData;

    const concentrationPenalty = concentrationRatio > cfg.collision.concentrationLimit
      ? (concentrationRatio - cfg.collision.concentrationLimit) * 100
      : 0;
    const delayPenalty     = Math.max(0, (avgPaymentDelayDays || 0) * 2);
    const onTimeBenefit    = (onTimePaymentRate || 0.7) * 40;
    const networkBenefit   = Math.min(20, (participantCount || 1) * 2);

    relationshipScore = _clamp(
      60 + onTimeBenefit + networkBenefit - concentrationPenalty - delayPenalty,
      0, 100
    );
  }

  // ── Node Health Score — the proprietary formula ──
  const nodeHealthScore = Math.round(
    alpha * _clamp(ocfScore,          0, 100) +
    beta  * _clamp(dpoScore,          0, 100) +
    gamma * _clamp(relationshipScore, 0, 100)
  );

  // ── Node classification ──
  const nodeStatus = nodeHealthScore >= 70 ? 'healthy'
    : nodeHealthScore >= 50               ? 'watch'
    : nodeHealthScore >= 30               ? 'stressed'
    :                                       'failing';

  return {
    nodeHealthScore:   Math.min(100, Math.max(0, nodeHealthScore)),
    nodeStatus,
    components: {
      cashFlowScore:      Math.round(_clamp(ocfScore,          0, 100)),
      dpoScore:           Math.round(_clamp(dpoScore,          0, 100)),
      relationshipScore:  Math.round(_clamp(relationshipScore, 0, 100))
    },
    weights: { alpha, beta, gamma }  // weights exposed in output for transparency
    // NOTE: actual weight VALUES come from env var — not hardcoded here
  };
}

// ════════════════════════════════════════════════════════════════════
// COMPONENT 5 — COLLISION DETECTION ENGINE
// Detects ecosystem friction risk from transaction patterns.
// A "collision" occurs when payment delays cascade through the
// node network, creating liquidity risk for connected businesses.
// ════════════════════════════════════════════════════════════════════

function detectCollisions(data, ratios, ecosystemData) {
  const cfg = loadConfig();
  const thresholds = cfg.collision;

  // ── Friction indicators ──
  const frictions = [];
  let collisionRisk = 0;

  // 1. Payment delay friction: DSO significantly exceeds DPO
  const paymentGap = ratios.dso - ratios.dpo;
  if (paymentGap > thresholds.frictionThresholdDays) {
    const severity = Math.min(40, paymentGap * 0.8);
    collisionRisk += severity;
    frictions.push({
      type:     'payment_gap',
      severity: Math.round(severity),
      detail:   `Collecting ${Math.round(ratios.dso)}d but paying ${Math.round(ratios.dpo)}d — ${Math.round(paymentGap)}d gap`
    });
  }

  // 2. Liquidity compression: current ratio falling toward 1.0
  if (ratios.currentRatio < 1.2) {
    const severity = Math.min(25, (1.2 - ratios.currentRatio) * 60);
    collisionRisk += severity;
    frictions.push({
      type:     'liquidity_compression',
      severity: Math.round(severity),
      detail:   `Current ratio ${ratios.currentRatio.toFixed(2)} — approaching liquidity constraint`
    });
  }

  // 3. Concentration risk: single counterparty dominates receivables
  if (ecosystemData && ecosystemData.concentrationRatio > thresholds.concentrationLimit) {
    const excess    = ecosystemData.concentrationRatio - thresholds.concentrationLimit;
    const severity  = Math.min(30, excess * 80);
    collisionRisk  += severity;
    frictions.push({
      type:     'concentration_risk',
      severity: Math.round(severity),
      detail:   `${Math.round(ecosystemData.concentrationRatio * 100)}% revenue from single counterparty — cascade risk`
    });
  }

  // 4. Leverage amplification: high debt amplifies any collision
  if (ratios.debtToEquity > 1.5) {
    const severity = Math.min(20, (ratios.debtToEquity - 1.5) * 15);
    collisionRisk += severity;
    frictions.push({
      type:     'leverage_amplification',
      severity: Math.round(severity),
      detail:   `Debt/equity ${ratios.debtToEquity.toFixed(1)} — leverage amplifies ecosystem shocks`
    });
  }

  // 5. OCF negative: node becomes a drain on the ecosystem
  if (ratios.ocf < 0) {
    const severity = Math.min(25, Math.abs(ratios.ocf) / ((data.annualRevenue || 1) * 0.002));
    collisionRisk += severity;
    frictions.push({
      type:     'negative_ocf',
      severity: Math.round(severity),
      detail:   `Negative operating cash flow — node drawing from ecosystem reserves`
    });
  }

  collisionRisk = Math.min(100, Math.round(collisionRisk));

  // Collision risk is inverted for the Digital Index (high risk = low score)
  const collisionScore = 100 - collisionRisk;

  return {
    collisionRisk,
    collisionScore,
    frictions,
    cascadeRisk: collisionRisk > 60 ? 'high' : collisionRisk > 35 ? 'medium' : 'low'
  };
}

// ════════════════════════════════════════════════════════════════════
// COMPONENT 6 — DIGITAL INDEX (COMPOSITE)
// Combines all five component scores into a single Digital Index.
// This is the master score used for risk classification, sub-agent
// routing, and remedy generation.
// ════════════════════════════════════════════════════════════════════

function computeDigitalIndex(financialHealthScore, nodeHealthScore,
                              gapScore, collisionScore, adizesModifier) {
  const cfg = loadConfig();
  const w   = cfg.digitalIndex;

  const rawIndex = (
    financialHealthScore * w.wFinancialHealth +
    nodeHealthScore      * w.wNodeResilience  +
    gapScore             * w.wSectorGap       +
    collisionScore       * w.wCollisionRisk   +
    50                   * w.wAdizesModifier  // base 50 before Adizes modifier applied
  );

  // Apply Adizes stage modifier (multiplicative on top of weighted sum)
  const modifiedIndex = rawIndex * adizesModifier;
  const digitalIndex  = Math.round(Math.min(100, Math.max(0, modifiedIndex)));

  const t = cfg.riskThresholds;
  const riskLevel = digitalIndex >= t.low      ? 'low'
    : digitalIndex >= t.moderate               ? 'moderate'
    : digitalIndex >= t.elevated               ? 'elevated'
    :                                             'critical';

  const riskLabel = {
    low:      'LOW RISK — Healthy node',
    moderate: 'MODERATE RISK — Watch required',
    elevated: 'ELEVATED RISK — Intervention recommended',
    critical: 'CRITICAL RISK — Immediate action required'
  }[riskLevel];

  return { digitalIndex, riskLevel, riskLabel };
}

// ════════════════════════════════════════════════════════════════════
// COMPONENT 7 — REMEDY GENERATOR
// Routes to the correct sub-agent and generates prioritised remedies.
// ════════════════════════════════════════════════════════════════════

function generateRemedies(components) {
  const { financialHealth, nodeResilience, sectorPerformance,
          collision, adizes, digitalIndex } = components;

  const remedies = [];
  const agentScores = { CFO: 0, CMO: 0, CSO: 0, COO: 0, Governance: 0, IT: 0 };

  // ── Financial Health signals → CFO ──
  if (financialHealth.ratios.dso > 45) {
    remedies.push({ priority: 1, agent: 'CFO', action: 'Reduce debtor days below 30 — implement 30-day payment terms and automated dunning', metric: `DSO: ${Math.round(financialHealth.ratios.dso)}d` });
    agentScores.CFO += 30;
  }
  if (financialHealth.ratios.ocf < 0) {
    remedies.push({ priority: 1, agent: 'CFO', action: 'Operating cash flow is negative — review cost structure and accelerate collections', metric: `OCF: R${Math.round(financialHealth.ratios.ocf).toLocaleString('en-ZA')}` });
    agentScores.CFO += 35;
  }
  if (financialHealth.ratios.grossMargin < 30) {
    remedies.push({ priority: 2, agent: 'CFO', action: 'Gross margin below 30% — review pricing and cost of sales', metric: `Gross margin: ${Math.round(financialHealth.ratios.grossMargin)}%` });
    agentScores.CFO += 20;
  }
  if (financialHealth.ratios.currentRatio < 1.2) {
    remedies.push({ priority: 1, agent: 'CFO', action: 'Liquidity risk — current ratio below 1.2. Review short-term obligations and consider Invoice Factoring', metric: `Current ratio: ${financialHealth.ratios.currentRatio.toFixed(2)}` });
    agentScores.CFO += 25;
  }

  // ── Sector gap signals → CMO ──
  if (sectorPerformance.gaps.grossMarginGap < -15) {
    remedies.push({ priority: 2, agent: 'CMO', action: `Gross margin ${Math.abs(Math.round(sectorPerformance.gaps.grossMarginGap))}% below sector — review pricing strategy and value proposition`, metric: `Sector benchmark: ${Math.round(sectorPerformance.benchmark.grossMargin * 100)}%` });
    agentScores.CMO += 25;
  }
  if (sectorPerformance.driftDetected) {
    remedies.push({ priority: 2, agent: 'CMO', action: `Performance drift detected across ${sectorPerformance.dimensionsBelow} dimensions — strategic review needed`, metric: `${sectorPerformance.dimensionsBelow} metrics below sector` });
    agentScores.CMO += 20; agentScores.CSO += 15;
  }

  // ── Collision signals → COO ──
  collision.frictions.forEach(f => {
    if (f.type === 'payment_gap') {
      remedies.push({ priority: 1, agent: 'COO', action: 'Tighten debtor terms to 30 days and negotiate 45-day terms with top 3 suppliers', metric: f.detail });
      agentScores.COO += 25;
    }
    if (f.type === 'concentration_risk') {
      remedies.push({ priority: 1, agent: 'CSO', action: 'Reduce revenue concentration — diversify client base to below 40% single-client dependency', metric: f.detail });
      agentScores.CSO += 30;
    }
  });

  // ── Node resilience signals → COO / CSO ──
  if (nodeResilience.nodeStatus === 'stressed' || nodeResilience.nodeStatus === 'failing') {
    remedies.push({ priority: 1, agent: 'COO', action: 'Node health critical — review operational efficiency, supplier terms, and payment cycles', metric: `Node: ${nodeResilience.nodeStatus}` });
    agentScores.COO += 20;
  }

  // ── Adizes stage signals → Governance ──
  if (['bureaucracy', 'salem_city', 'dead'].includes(adizes.stage)) {
    remedies.push({ priority: 1, agent: 'Governance', action: `Business in ${adizes.stage.replace('_',' ')} stage — consider Business Rescue consultation`, metric: `Adizes: ${adizes.stage}` });
    agentScores.Governance += 35;
  }
  if (adizes.stage === 'adolescence') {
    remedies.push({ priority: 2, agent: 'Governance', action: 'Adolescence stage — formalise governance structures before scaling further', metric: 'Adizes: adolescence' });
    agentScores.Governance += 20;
  }

  // ── Leverage signals → CFO / Governance ──
  if (financialHealth.ratios.debtToEquity > 2.0) {
    remedies.push({ priority: 1, agent: 'CFO', action: 'High leverage — debt restructuring required. Review long-term debt facilities', metric: `D/E: ${financialHealth.ratios.debtToEquity.toFixed(1)}` });
    agentScores.CFO += 20; agentScores.Governance += 10;
  }

  // ── Sort remedies by priority ──
  remedies.sort((a, b) => a.priority - b.priority);

  // ── Determine primary recommended agent ──
  const recommendedAgent = Object.entries(agentScores)
    .sort(([,a],[,b]) => b - a)[0][0];

  return { remedies: remedies.slice(0, 6), recommendedAgent, agentScores };
}

// ════════════════════════════════════════════════════════════════════
// MASTER ENTRY POINT — runRatingEngine()
// Orchestrates all 7 components and returns the full rating output.
// This is the only function imported by server.js
// ════════════════════════════════════════════════════════════════════

function runRatingEngine(input) {
  const {
    // Required
    userId, userType = 'business', assessmentDate,
    revenue, costOfSales, operatingExpenses, netProfit,
    currentAssets, currentLiabilities, accountsReceivable,
    accountsPayable, inventory, totalDebt, equity, annualRevenue,
    // Optional — enriches accuracy
    nonCashExpenses, capex, workingCapitalChange,
    revenueGrowthRate, employeeCount, yearsInOperation,
    sector = 'default', adizesStage,
    // Optional — ecosystem context (from Billsource transaction data)
    ecosystemData
  } = input;

  // ── Validate required fields ──
  const required = { revenue, costOfSales, operatingExpenses, netProfit,
    currentAssets, currentLiabilities, accountsReceivable,
    accountsPayable, inventory, totalDebt, equity, annualRevenue };

  const missing = Object.entries(required)
    .filter(([, v]) => v === undefined || v === null || isNaN(Number(v)))
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }

  const numericInput = {
    revenue:               Number(revenue),
    costOfSales:           Number(costOfSales),
    operatingExpenses:     Number(operatingExpenses),
    netProfit:             Number(netProfit),
    currentAssets:         Number(currentAssets),
    currentLiabilities:    Number(currentLiabilities),
    accountsReceivable:    Number(accountsReceivable),
    accountsPayable:       Number(accountsPayable),
    inventory:             Number(inventory),
    totalDebt:             Number(totalDebt),
    equity:                Number(equity),
    annualRevenue:         Number(annualRevenue),
    nonCashExpenses:       nonCashExpenses ? Number(nonCashExpenses) : null,
    capex:                 capex           ? Number(capex)           : null,
    workingCapitalChange:  workingCapitalChange ? Number(workingCapitalChange) : null,
    revenueGrowthRate:     revenueGrowthRate    ? Number(revenueGrowthRate)    : null,
    employeeCount:         employeeCount        ? Number(employeeCount)        : null,
    yearsInOperation:      yearsInOperation     ? Number(yearsInOperation)     : null
  };

  // ── Run all 7 components ──
  const adizes          = assessAdizesStage(numericInput, adizesStage);
  const financialHealth = scoreFinancialHealth(numericInput);
  const sectorPerf      = scoreSectorPerformance(financialHealth.ratios, sector);
  const nodeResilience  = scoreNodeResilience(numericInput, financialHealth.ratios, ecosystemData || null);
  const collision       = detectCollisions(numericInput, financialHealth.ratios, ecosystemData || null);
  const { digitalIndex, riskLevel, riskLabel } = computeDigitalIndex(
    financialHealth.financialHealthScore,
    nodeResilience.nodeHealthScore,
    sectorPerf.gapScore,
    collision.collisionScore,
    adizes.modifier
  );
  const { remedies, recommendedAgent, agentScores } = generateRemedies({
    financialHealth, nodeResilience, sectorPerformance: sectorPerf,
    collision, adizes, digitalIndex: { digitalIndex, riskLevel }
  });

  // ── Build output contract (matches Flowise input schema in brief) ──
  return {
    // Meta
    userId:          userId || null,
    userType,
    assessmentDate:  assessmentDate || new Date().toISOString(),
    sector,
    version:         '1.0.0',
    generatedAt:     new Date().toISOString(),

    // Flowise contract fields (from brief §7.5)
    adizes_stage:    adizes.stage,
    financial_scores: {
      ocf:              financialHealth.ratios.ocf,
      fcf:              financialHealth.ratios.fcf,
      dpo:              financialHealth.ratios.dpo,
      current_ratio:    financialHealth.ratios.currentRatio,
      sector_benchmark: sectorPerf.benchmark.grossMargin,
      gap_percentage:   Math.round(sectorPerf.gaps.grossMarginGap)
    },
    node_health: {
      resilience_score: nodeResilience.nodeHealthScore,
      collision_risk:   collision.collisionRisk,
      digital_index:    digitalIndex
    },
    risk_level:          riskLevel,
    drift_detected:      sectorPerf.driftDetected,
    recommended_agent:   recommendedAgent,
    remedies:            remedies.map(r => r.action),

    // Extended output — full detail for authenticated users
    detail: {
      digitalIndex,
      riskLabel,
      adizes,
      financialHealth: {
        score:      financialHealth.financialHealthScore,
        dimensions: financialHealth.dimensions,
        ratios:     financialHealth.ratios
      },
      sectorPerformance: {
        score:          sectorPerf.gapScore,
        driftDetected:  sectorPerf.driftDetected,
        dimensionsBelow:sectorPerf.dimensionsBelow,
        gaps:           sectorPerf.gaps,
        benchmark:      sectorPerf.benchmark,
        sector:         sectorPerf.sector
      },
      nodeResilience: {
        score:      nodeResilience.nodeHealthScore,
        status:     nodeResilience.nodeStatus,
        components: nodeResilience.components
      },
      collision: {
        risk:       collision.collisionRisk,
        cascadeRisk:collision.cascadeRisk,
        frictions:  collision.frictions
      },
      remedyDetail:      remedies,
      agentScores
    }
  };
}

// ── Utility functions ─────────────────────────────────────────────

// Linear scale: map value from [inMin,inMax] to [outMin,outMax]
function _scale(value, inMin, inMax, outMin, outMax) {
  const clamped = Math.min(Math.max(value, Math.min(inMin, inMax)), Math.max(inMin, inMax));
  const t = (clamped - inMin) / (inMax - inMin);
  return _clamp(outMin + t * (outMax - outMin), outMin, outMax);
}

function _clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function _roundAll(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v;
  }
  return out;
}

// ── Exports — only the entry point and config loader ─────────────
module.exports = {
  runRatingEngine,
  loadConfig   // exposed for admin diagnostic only — not for routes
};
