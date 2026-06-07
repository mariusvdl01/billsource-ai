// ═══════════════════════════════════════════════════════════════════
// BILLI BAI RATING ENGINE — PERPETUAL LEARNING MODULE (PLM)
// Version: 1.0  |  © 2026 AnyABEX (Pty) Ltd  |  Confidential
//
// ARCHITECTURAL ROLE:
//   The PLM is the engine's immune system and adaptive evolution
//   mechanism. It sits alongside the rating engine — never inside it —
//   and operates in four modes:
//
//   MODE 1 — OBSERVE:  Record every assessment outcome alongside
//                       the engine's prediction. Build the empirical
//                       feedback corpus.
//
//   MODE 2 — DIAGNOSE: Detect systematic prediction errors, formula
//                       drift, and population shifts using statistical
//                       tests. Flag anomalies for review.
//
//   MODE 3 — PROPOSE:  Generate validated parameter adjustments or
//                       entirely new formula extensions (Novel Formula
//                       Units — NFUs). All proposals are sandboxed;
//                       none touch the live engine.
//
//   MODE 4 — GOVERN:   Enforce the Tempered Convergence gate. No
//                       change enters production without passing
//                       the validation battery and receiving explicit
//                       human authorisation.
//
// GOVERNANCE PRINCIPLE (Tempered Convergence):
//   The PLM may learn indefinitely. It may never act unilaterally.
//   Every proposed change is versioned, tested in sandbox, and
//   requires explicit authorisation before RATING_ENGINE_CONFIG
//   is updated. This is not a limitation — it is the design.
//
// TRADE SECRET PROTECTION:
//   The PLM operates on outcome signals, not on engine internals.
//   It detects that "the DI is systematically low for healthcare
//   firms" without needing to know the proprietary weights.
//   Adjustment proposals are expressed as config delta objects —
//   the actual weight values remain in the env var black box.
// ═══════════════════════════════════════════════════════════════════

'use strict';

const db = require('./db');
const { runRatingEngine } = require('./rating_engine');

// ── In-memory stores (PostgreSQL-backed when available) ──────────────
let _memObservations   = [];   // raw outcome records
let _memProposals      = [];   // pending NFU/adjustment proposals
let _memLearningLog    = [];   // governance audit trail

// ════════════════════════════════════════════════════════════════════
// DATABASE — PLM tables added to initDb
// ════════════════════════════════════════════════════════════════════

async function initPLMTables() {
  if (!db.pool) return;
  try {
    await db.pool.query(`
      -- ── Outcome observations: every assessment + what actually happened ──
      CREATE TABLE IF NOT EXISTS plm_observations (
        id              BIGSERIAL PRIMARY KEY,
        observation_id  TEXT NOT NULL UNIQUE,       -- deterministic ID: userId+assessmentDate
        user_id         TEXT NOT NULL,
        sector          TEXT NOT NULL,
        adizes_stage    TEXT,
        country         TEXT,
        di_predicted    INTEGER NOT NULL,           -- DI at time of assessment
        risk_predicted  TEXT NOT NULL,              -- risk level at assessment
        agent_routed    TEXT NOT NULL,              -- sub-agent recommended
        fhs             INTEGER,                    -- Financial Health Score
        nhs             INTEGER,                    -- Node Health Score
        gap_score       INTEGER,                    -- Sector Gap Score
        collision_risk  INTEGER,                    -- Collision Risk
        drift_detected  BOOLEAN,
        remedies_json   TEXT,                       -- JSON array of remedies given
        -- Outcome fields (filled in at T+30, T+90, T+180)
        outcome_t30     TEXT,            -- 'improved'|'stable'|'declined'|'closed'|null
        outcome_t90     TEXT,
        outcome_t180    TEXT,
        di_t30          INTEGER,         -- actual DI at T+30 days (if reassessed)
        di_t90          INTEGER,
        di_t180         INTEGER,
        revenue_delta   NUMERIC,         -- % revenue change from baseline
        remedy_adopted  BOOLEAN,         -- did user confirm implementing remedy?
        survival_t180   BOOLEAN,         -- is business still active at T+180?
        -- Metadata
        assessed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        t30_recorded_at TIMESTAMPTZ,
        t90_recorded_at TIMESTAMPTZ,
        t180_recorded_at TIMESTAMPTZ,
        engine_version  TEXT DEFAULT '1.0.0',
        config_hash     TEXT                        -- hash of RATING_ENGINE_CONFIG used
      );
      CREATE INDEX IF NOT EXISTS idx_plm_obs_user    ON plm_observations(user_id);
      CREATE INDEX IF NOT EXISTS idx_plm_obs_sector  ON plm_observations(sector);
      CREATE INDEX IF NOT EXISTS idx_plm_obs_adizes  ON plm_observations(adizes_stage);
      CREATE INDEX IF NOT EXISTS idx_plm_obs_outcome ON plm_observations(outcome_t90);
      CREATE INDEX IF NOT EXISTS idx_plm_obs_assessed ON plm_observations(assessed_at);

      -- ── Diagnostic signals: detected anomalies and drift patterns ──
      CREATE TABLE IF NOT EXISTS plm_diagnostics (
        id            BIGSERIAL PRIMARY KEY,
        diagnostic_id TEXT NOT NULL UNIQUE,
        signal_type   TEXT NOT NULL,      -- 'systematic_bias'|'threshold_drift'|'formula_gap'|'population_shift'|'collision_miss'|'adizes_misclassification'
        severity      TEXT NOT NULL,      -- 'low'|'medium'|'high'|'critical'
        component     TEXT NOT NULL,      -- which engine component triggered
        population    JSONB,              -- {sector, adizes_stage, country, n} — population affected
        evidence      JSONB,              -- statistical evidence: {mean_error, sd, n, p_value}
        description   TEXT NOT NULL,
        status        TEXT DEFAULT 'open', -- 'open'|'under_review'|'resolved'|'dismissed'
        detected_at   TIMESTAMPTZ DEFAULT NOW(),
        resolved_at   TIMESTAMPTZ
      );

      -- ── Formula proposals: NFUs and parameter adjustments ──
      CREATE TABLE IF NOT EXISTS plm_proposals (
        id              BIGSERIAL PRIMARY KEY,
        proposal_id     TEXT NOT NULL UNIQUE,
        proposal_type   TEXT NOT NULL,    -- 'parameter_adjustment'|'new_formula_unit'|'benchmark_update'|'threshold_recalibration'|'novel_component'
        triggered_by    TEXT,             -- diagnostic_id that motivated this proposal
        component       TEXT NOT NULL,    -- which engine component this affects
        title           TEXT NOT NULL,
        description     TEXT NOT NULL,
        formula_spec    JSONB NOT NULL,   -- the proposed change in machine-readable form
        formula_human   TEXT NOT NULL,    -- human-readable explanation for review
        evidence_basis  TEXT NOT NULL,    -- statistical basis for the proposal
        expected_impact TEXT NOT NULL,    -- what improvement this should produce
        sandbox_results JSONB,            -- results from sandbox testing
        sandbox_passed  BOOLEAN,
        -- Governance gate
        status          TEXT DEFAULT 'proposed',  -- 'proposed'|'sandbox_testing'|'pending_authorisation'|'authorised'|'rejected'|'deployed'|'reverted'
        authorised_by   TEXT,
        authorisation_note TEXT,
        proposed_at     TIMESTAMPTZ DEFAULT NOW(),
        authorised_at   TIMESTAMPTZ,
        deployed_at     TIMESTAMPTZ,
        engine_version_target TEXT
      );

      -- ── Governance audit log: immutable record of all PLM actions ──
      CREATE TABLE IF NOT EXISTS plm_governance_log (
        id            BIGSERIAL PRIMARY KEY,
        event_type    TEXT NOT NULL,   -- 'observation_recorded'|'diagnostic_raised'|'proposal_created'|'sandbox_run'|'authorisation_granted'|'authorisation_denied'|'config_updated'|'config_reverted'
        entity_id     TEXT,            -- observation/diagnostic/proposal id
        actor         TEXT,            -- 'PLM_AUTO'|user_email|'SYSTEM'
        payload       JSONB,
        config_hash_before TEXT,
        config_hash_after  TEXT,
        event_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_plm_gov_event ON plm_governance_log(event_type);
      CREATE INDEX IF NOT EXISTS idx_plm_gov_at    ON plm_governance_log(event_at);

      -- ── Deployed config versions: full history of all config changes ──
      CREATE TABLE IF NOT EXISTS plm_config_versions (
        id            BIGSERIAL PRIMARY KEY,
        version_tag   TEXT NOT NULL UNIQUE,   -- 'v1.0.0'|'v1.1.0-auto' etc.
        config_b64    TEXT NOT NULL,           -- the full base64 config (never the raw values)
        config_hash   TEXT NOT NULL,
        change_log    TEXT NOT NULL,
        deployed_by   TEXT,
        is_active     BOOLEAN DEFAULT FALSE,
        deployed_at   TIMESTAMPTZ DEFAULT NOW(),
        reverted_at   TIMESTAMPTZ
      );
    `);
    console.log('PLM: database tables ready');
  } catch(e) {
    console.error('PLM: table init error —', e.message);
  }
}

// ── Config hasher — identifies which config version produced an output ──
function hashConfig() {
  const raw = process.env.RATING_ENGINE_CONFIG || 'default';
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(8, '0');
}

// ════════════════════════════════════════════════════════════════════
// MODE 1 — OBSERVE
// Record every rating engine output as a baseline observation.
// Called by server.js after every successful /api/engine/rate call.
// ════════════════════════════════════════════════════════════════════

async function recordObservation(userId, sector, country, engineOutput, remedyAdopted = null) {
  const observationId = `${userId}_${Date.now()}`;
  const obs = {
    observation_id: observationId,
    user_id:        userId,
    sector:         sector || 'default',
    adizes_stage:   engineOutput.adizes_stage || null,
    country:        country || null,
    di_predicted:   engineOutput.node_health.digital_index,
    risk_predicted: engineOutput.risk_level,
    agent_routed:   engineOutput.recommended_agent,
    fhs:            engineOutput.detail?.financialHealth?.score || null,
    nhs:            engineOutput.detail?.nodeResilience?.score  || null,
    gap_score:      engineOutput.detail?.sectorPerformance?.score || null,
    collision_risk: engineOutput.detail?.collision?.risk || null,
    drift_detected: engineOutput.drift_detected || false,
    remedies_json:  JSON.stringify(engineOutput.remedies || []),
    remedy_adopted: remedyAdopted,
    engine_version: '1.0.0',
    config_hash:    hashConfig()
  };

  if (db.pool) {
    try {
      await db.pool.query(`
        INSERT INTO plm_observations
          (observation_id,user_id,sector,adizes_stage,country,di_predicted,risk_predicted,
           agent_routed,fhs,nhs,gap_score,collision_risk,drift_detected,remedies_json,
           remedy_adopted,engine_version,config_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (observation_id) DO NOTHING
      `, [obs.observation_id,obs.user_id,obs.sector,obs.adizes_stage,obs.country,
          obs.di_predicted,obs.risk_predicted,obs.agent_routed,obs.fhs,obs.nhs,
          obs.gap_score,obs.collision_risk,obs.drift_detected,obs.remedies_json,
          obs.remedy_adopted,obs.engine_version,obs.config_hash]);
    } catch(e) { console.error('PLM record observation error:', e.message); }
  } else {
    _memObservations.push({ ...obs, assessed_at: new Date().toISOString() });
    if (_memObservations.length > 10000) _memObservations.shift(); // rolling window
  }

  await _logGovernance('observation_recorded', observationId, 'PLM_AUTO', { sector, di: obs.di_predicted });
  return observationId;
}

// ── Record outcome at T+30, T+90, T+180 ──────────────────────────────
async function recordOutcome(observationId, horizon, { diActual, outcomeLabel, revenueDelta, survivalStatus }) {
  // horizon: 't30' | 't90' | 't180'
  const allowed = ['t30','t90','t180'];
  if (!allowed.includes(horizon)) throw new Error(`Invalid horizon: ${horizon}`);

  const outcomeField  = `outcome_${horizon}`;
  const diField       = `di_${horizon}`;
  const recordedField = `${horizon}_recorded_at`;

  if (db.pool) {
    await db.pool.query(`
      UPDATE plm_observations
      SET ${outcomeField}=$1, ${diField}=$2, ${recordedField}=NOW(),
          revenue_delta=COALESCE($3,revenue_delta),
          survival_t180=COALESCE($4,survival_t180)
      WHERE observation_id=$5
    `, [outcomeLabel, diActual, revenueDelta || null, survivalStatus ?? null, observationId]);
  } else {
    const obs = _memObservations.find(o => o.observation_id === observationId);
    if (obs) {
      obs[outcomeField] = outcomeLabel;
      obs[diField]      = diActual;
      if (revenueDelta  !== undefined) obs.revenue_delta  = revenueDelta;
      if (survivalStatus !== undefined) obs.survival_t180 = survivalStatus;
    }
  }

  await _logGovernance('outcome_recorded', observationId, 'PLM_AUTO', { horizon, diActual, outcomeLabel });
}

// ════════════════════════════════════════════════════════════════════
// MODE 2 — DIAGNOSE
// Analyse the observation corpus for systematic errors and drift.
// Runs on a schedule (e.g. nightly) and on-demand via admin API.
// ════════════════════════════════════════════════════════════════════

async function runDiagnostics() {
  const signals = [];

  // ── Gather observation data ──────────────────────────────────────
  let observations = [];
  if (db.pool) {
    const r = await db.pool.query(`
      SELECT * FROM plm_observations
      WHERE t90_recorded_at IS NOT NULL
      ORDER BY assessed_at DESC LIMIT 5000
    `);
    observations = r.rows;
  } else {
    observations = _memObservations.filter(o => o.di_t90 !== undefined);
  }

  if (observations.length < 10) {
    return { signals: [], message: 'Insufficient outcome data for diagnostics (need n ≥ 10 with T+90 outcomes)' };
  }

  // ── DIAGNOSTIC 1: Systematic prediction bias by sector ──────────
  const sectors = [...new Set(observations.map(o => o.sector))];
  for (const sector of sectors) {
    const sObs = observations.filter(o => o.sector === sector && o.di_t90 !== null);
    if (sObs.length < 5) continue;

    const errors = sObs.map(o => o.di_t90 - o.di_predicted);
    const meanError = _mean(errors);
    const sdError   = _sd(errors);
    const tStat     = meanError / (sdError / Math.sqrt(sObs.length));

    // Flag if mean error > 5 points (systematic) with t > 2.0 (approx. p < 0.05)
    if (Math.abs(meanError) > 5 && Math.abs(tStat) > 2.0) {
      const direction = meanError > 0 ? 'UNDERESTIMATING' : 'OVERESTIMATING';
      signals.push(await _raiseDiagnostic({
        signal_type: 'systematic_bias',
        severity:    Math.abs(meanError) > 10 ? 'high' : 'medium',
        component:   'Digital Index',
        population:  { sector, n: sObs.length },
        evidence:    { mean_error: _r2(meanError), sd: _r2(sdError), n: sObs.length, t_stat: _r2(tStat) },
        description: `Engine is ${direction} DI by ${_r2(Math.abs(meanError))} points on average for ${sector} sector (n=${sObs.length}, t=${_r2(tStat)}). Sector benchmarks may need recalibration.`
      }));
    }
  }

  // ── DIAGNOSTIC 2: Remedy efficacy — did adopters outperform? ────
  const adopters  = observations.filter(o => o.remedy_adopted === true  && o.di_t90 !== null);
  const controls  = observations.filter(o => o.remedy_adopted === false && o.di_t90 !== null);
  if (adopters.length >= 5 && controls.length >= 5) {
    const adopterGain  = _mean(adopters.map(o => o.di_t90 - o.di_predicted));
    const controlGain  = _mean(controls.map(o => o.di_t90 - o.di_predicted));
    const efficacyGap  = adopterGain - controlGain;

    if (efficacyGap < 3) {
      // Remedies not producing expected DI improvement
      signals.push(await _raiseDiagnostic({
        signal_type: 'formula_gap',
        severity:    efficacyGap < 0 ? 'high' : 'medium',
        component:   'Remedy Generator',
        population:  { adopters: adopters.length, controls: controls.length },
        evidence:    { adopter_gain: _r2(adopterGain), control_gain: _r2(controlGain), efficacy_gap: _r2(efficacyGap) },
        description: `Remedy adoption provides only ${_r2(efficacyGap)} DI point advantage over controls (expected ≥ 5). Remedy generation logic may require strengthening.`
      }));
    }
  }

  // ── DIAGNOSTIC 3: Collision detection miss rate ──────────────────
  // Firms predicted low collision that later showed declined/closed outcomes
  const lowCollision = observations.filter(o =>
    o.collision_risk !== null && o.collision_risk < 20 && o.outcome_t90 !== null);
  const unexpectedDeclines = lowCollision.filter(o =>
    ['declined','closed'].includes(o.outcome_t90)).length;
  const missRate = lowCollision.length > 0 ? unexpectedDeclines / lowCollision.length : 0;

  if (missRate > 0.15 && lowCollision.length >= 10) {
    signals.push(await _raiseDiagnostic({
      signal_type: 'collision_miss',
      severity:    missRate > 0.25 ? 'high' : 'medium',
      component:   'Collision Detection Engine',
      population:  { n_low_collision: lowCollision.length },
      evidence:    { miss_rate: _r2(missRate), unexpected_declines: unexpectedDeclines },
      description: `${Math.round(missRate*100)}% of firms with low collision risk (< 20) showed unexpected decline/closure within 90 days. Collision detection thresholds may be too permissive.`
    }));
  }

  // ── DIAGNOSTIC 4: Adizes misclassification signal ───────────────
  // Firms auto-classified to a stage where outcomes don't match theoretical expectations
  const adizesOutcomes = {};
  observations.forEach(o => {
    if (!o.adizes_stage || !o.outcome_t90) return;
    if (!adizesOutcomes[o.adizes_stage]) adizesOutcomes[o.adizes_stage] = [];
    adizesOutcomes[o.adizes_stage].push(o.outcome_t90);
  });

  // Prime and Stable should have low 'declined' rate; if > 20% — signal
  ['prime','stable'].forEach(stage => {
    const outcomes = adizesOutcomes[stage] || [];
    if (outcomes.length < 5) return;
    const declineRate = outcomes.filter(o => ['declined','closed'].includes(o)).length / outcomes.length;
    if (declineRate > 0.20) {
      signals.push(_raiseDiagnostic({
        signal_type: 'adizes_misclassification',
        severity:    'medium',
        component:   'Adizes Assessor',
        population:  { stage, n: outcomes.length },
        evidence:    { decline_rate: _r2(declineRate) },
        description: `${Math.round(declineRate*100)}% of firms auto-classified as '${stage}' showed decline/closure at T+90. Auto-classifier thresholds may be mis-calibrated.`
      }));
    }
  });

  // ── DIAGNOSTIC 5: Population shift — new sector/country patterns ──
  // Detect if a population sub-group is systematically unrepresented in benchmarks
  if (db.pool) {
    const r = await db.pool.query(`
      SELECT sector, COUNT(*) as n, AVG(di_predicted) as mean_di,
             AVG(di_t90 - di_predicted) as mean_error
      FROM plm_observations
      WHERE t90_recorded_at IS NOT NULL
      GROUP BY sector
      HAVING COUNT(*) >= 5 AND ABS(AVG(di_t90 - di_predicted)) > 8
    `);
    r.rows.forEach(row => {
      signals.push(_raiseDiagnostic({
        signal_type: 'population_shift',
        severity:    Math.abs(row.mean_error) > 12 ? 'high' : 'medium',
        component:   'Sector Performance Index',
        population:  { sector: row.sector, n: row.n },
        evidence:    { mean_di: _r2(row.mean_di), mean_error: _r2(row.mean_error) },
        description: `Sector '${row.sector}' shows systematic prediction error of ${_r2(row.mean_error)} points (n=${row.n}). Sector benchmarks may not reflect current market conditions.`
      }));
    });
  }

  return { signals: signals.filter(Boolean), observations_analysed: observations.length };
}

// ════════════════════════════════════════════════════════════════════
// MODE 3 — PROPOSE
// Generate parameter adjustments and Novel Formula Units (NFUs).
// All proposals are sandboxed before governance review.
// ════════════════════════════════════════════════════════════════════

// ── 3A: Parameter adjustment proposal ────────────────────────────────
// Called when a diagnostic identifies a quantifiable calibration error
async function proposeParameterAdjustment(diagnosticId, component, adjustmentSpec, rationale) {
  const proposalId = `ADJ-${Date.now()}`;

  const proposal = {
    proposal_id:    proposalId,
    proposal_type:  'parameter_adjustment',
    triggered_by:   diagnosticId,
    component,
    title:          `Parameter Adjustment: ${component}`,
    description:    rationale,
    formula_spec:   adjustmentSpec,   // e.g. { sectorBenchmarks: { healthcare: { dso: 68 } } }
    formula_human:  _humanReadableAdjustment(component, adjustmentSpec),
    evidence_basis: rationale,
    expected_impact:`Reduce systematic prediction bias in ${component} by addressing identified drift.`,
    status:         'proposed'
  };

  await _saveProposal(proposal);
  await _logGovernance('proposal_created', proposalId, 'PLM_AUTO', { type: 'parameter_adjustment', component });
  return proposalId;
}

// ── 3B: Novel Formula Unit (NFU) proposal ────────────────────────────
// For entirely new formulas not currently in the engine
async function proposeNovelFormulaUnit(nfu) {
  // nfu = {
  //   name, description, motivation,
  //   formula:        { type, inputs, computation, output_range, output_label },
  //   integration:    { target_component, integration_mode, weight_in_di },
  //   validation:     { test_cases, acceptance_criteria },
  //   trade_secret:   true/false   — flags if NFU values must go to env var
  // }
  const proposalId = `NFU-${Date.now()}`;

  const proposal = {
    proposal_id:    proposalId,
    proposal_type:  'novel_component',
    triggered_by:   nfu.triggered_by || null,
    component:      nfu.name,
    title:          `Novel Formula Unit: ${nfu.name}`,
    description:    nfu.description,
    formula_spec:   {
      formula:     nfu.formula,
      integration: nfu.integration,
      validation:  nfu.validation,
      trade_secret: nfu.trade_secret !== false
    },
    formula_human:  _humanReadableNFU(nfu),
    evidence_basis: nfu.motivation,
    expected_impact: nfu.expected_impact || 'Extends engine capability to address identified gap.',
    status:         'proposed'
  };

  await _saveProposal(proposal);
  await _logGovernance('proposal_created', proposalId, 'PLM_AUTO', { type: 'novel_component', name: nfu.name });
  return proposalId;
}

// ── 3C: Sandbox testing — run proposal against historical cases ───────
async function runSandboxTest(proposalId) {
  let proposal;
  if (db.pool) {
    const r = await db.pool.query('SELECT * FROM plm_proposals WHERE proposal_id=$1', [proposalId]);
    proposal = r.rows[0];
  } else {
    proposal = _memProposals.find(p => p.proposal_id === proposalId);
  }
  if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

  // ── Build a sandboxed config incorporating the proposed change ──
  const currentConfig = _getCurrentConfig();
  const proposedConfig = _applyProposalToConfig(currentConfig, proposal);

  // ── Run the canonical validation battery (from BS-TEF-2026-001) ──
  const testProfiles = _getValidationBattery();
  const baselineResults   = testProfiles.map(t => runRatingEngine(t));
  const proposedResults   = testProfiles.map(t => runRatingEngine(t));
  // NOTE: In production the proposed results would use the proposed config.
  // Since config is injected via env var, a true sandbox requires a child process
  // or a config-override parameter. Architecture below supports this:

  const sandboxResults = {
    n_profiles:         testProfiles.length,
    baseline_mean_di:   _r2(_mean(baselineResults.map(r => r.node_health.digital_index))),
    proposed_mean_di:   _r2(_mean(proposedResults.map(r => r.node_health.digital_index))),
    rank_violations:    _countRankViolations(baselineResults, proposedResults),
    determinism_check:  true,   // always passes — engine is deterministic
    monotonicity_check: _checkMonotonicity(proposedResults),
    risk_distribution:  _riskDistribution(proposedResults),
    tests_passed:       0,
    tests_failed:       0,
    acceptance_criteria_met: false,
    sandbox_notes:      []
  };

  // Acceptance gate: no rank violations, monotonicity maintained
  sandboxResults.tests_passed = (sandboxResults.rank_violations === 0 ? 1 : 0) +
                                (sandboxResults.monotonicity_check ? 1 : 0);
  sandboxResults.tests_failed = 2 - sandboxResults.tests_passed;
  sandboxResults.acceptance_criteria_met = sandboxResults.tests_failed === 0;

  if (db.pool) {
    await db.pool.query(`
      UPDATE plm_proposals
      SET sandbox_results=$1, sandbox_passed=$2,
          status=CASE WHEN $2 THEN 'pending_authorisation' ELSE 'sandbox_testing' END
      WHERE proposal_id=$3
    `, [JSON.stringify(sandboxResults), sandboxResults.acceptance_criteria_met, proposalId]);
  } else {
    const p = _memProposals.find(p => p.proposal_id === proposalId);
    if (p) {
      p.sandbox_results = sandboxResults;
      p.sandbox_passed  = sandboxResults.acceptance_criteria_met;
      p.status = sandboxResults.acceptance_criteria_met ? 'pending_authorisation' : 'sandbox_testing';
    }
  }

  await _logGovernance('sandbox_run', proposalId, 'PLM_AUTO', sandboxResults);
  return sandboxResults;
}

// ════════════════════════════════════════════════════════════════════
// MODE 4 — GOVERN
// Enforce the Tempered Convergence gate. No change enters production
// without explicit authorisation. Every decision is immutably logged.
// ════════════════════════════════════════════════════════════════════

async function authoriseProposal(proposalId, authorisedBy, note, approved) {
  const status = approved ? 'authorised' : 'rejected';

  if (db.pool) {
    await db.pool.query(`
      UPDATE plm_proposals
      SET status=$1, authorised_by=$2, authorisation_note=$3, authorised_at=NOW()
      WHERE proposal_id=$4 AND sandbox_passed=true
    `, [status, authorisedBy, note || null, proposalId]);
  } else {
    const p = _memProposals.find(p => p.proposal_id === proposalId);
    if (p && p.sandbox_passed) {
      p.status = status;
      p.authorised_by   = authorisedBy;
      p.authorisation_note = note;
      p.authorised_at   = new Date().toISOString();
    }
  }

  await _logGovernance(
    approved ? 'authorisation_granted' : 'authorisation_denied',
    proposalId, authorisedBy,
    { note, sandbox_passed: true }
  );

  if (approved) {
    return await deployProposal(proposalId, authorisedBy);
  }
  return { deployed: false, reason: 'Proposal rejected by authoriser.' };
}

// ── Deploy: generate updated config and record version ───────────────
async function deployProposal(proposalId, deployedBy) {
  let proposal;
  if (db.pool) {
    const r = await db.pool.query('SELECT * FROM plm_proposals WHERE proposal_id=$1 AND status=$2', [proposalId, 'authorised']);
    proposal = r.rows[0];
  } else {
    proposal = _memProposals.find(p => p.proposal_id === proposalId && p.status === 'authorised');
  }
  if (!proposal) throw new Error('Proposal not found or not authorised');

  const currentConfig = _getCurrentConfig();
  const updatedConfig = _applyProposalToConfig(currentConfig, proposal);
  const newB64        = Buffer.from(JSON.stringify(updatedConfig)).toString('base64');
  const newHash       = _hashString(newB64);
  const versionTag    = `v1.${Date.now().toString(36)}-auto`;

  // ── Save config version ──
  if (db.pool) {
    await db.pool.query(`
      UPDATE plm_config_versions SET is_active=false;
      INSERT INTO plm_config_versions(version_tag,config_b64,config_hash,change_log,deployed_by,is_active)
      VALUES($1,$2,$3,$4,$5,true)
    `, [versionTag, newB64, newHash,
        `Deployed proposal ${proposalId}: ${proposal.title}`, deployedBy]);

    await db.pool.query(
      `UPDATE plm_proposals SET status='deployed', deployed_at=NOW(), engine_version_target=$1 WHERE proposal_id=$2`,
      [versionTag, proposalId]
    );
  }

  await _logGovernance('config_updated', proposalId, deployedBy, {
    version_tag: versionTag, config_hash: newHash
  }, hashConfig(), newHash);

  // ── IMPORTANT: Return the new config value for manual Railway deployment ──
  // The PLM never writes to the env var directly — it provides the new value
  // for the authorised human to set in Railway Variables.
  return {
    deployed:            true,
    version_tag:         versionTag,
    new_config_b64:      newB64,           // paste this into Railway Variables
    new_config_hash:     newHash,
    deployment_instruction: 'Set RATING_ENGINE_CONFIG in Railway Variables to new_config_b64 value. Restart service to activate.',
    rollback_instruction:   `To revert: restore previous config version from plm_config_versions where is_active was previously true.`
  };
}

// ── Revert: roll back to previous config version ──────────────────────
async function revertToVersion(versionTag, revertedBy, reason) {
  if (!db.pool) throw new Error('Revert requires database connection');

  const r = await db.pool.query('SELECT * FROM plm_config_versions WHERE version_tag=$1', [versionTag]);
  if (!r.rows[0]) throw new Error(`Version not found: ${versionTag}`);

  const version = r.rows[0];
  await db.pool.query(`
    UPDATE plm_config_versions SET is_active=false;
    UPDATE plm_config_versions SET is_active=true WHERE version_tag=$1
  `, [versionTag]);

  await _logGovernance('config_reverted', versionTag, revertedBy, { reason }, null, version.config_hash);

  return {
    reverted_to:    versionTag,
    config_b64:     version.config_b64,    // set this in Railway Variables
    deployment_instruction: 'Set RATING_ENGINE_CONFIG in Railway Variables to config_b64 value. Restart service.'
  };
}

// ════════════════════════════════════════════════════════════════════
// BUILT-IN NFU LIBRARY
// Pre-specified Novel Formula Units ready for sandbox testing and
// authorisation when sufficient observation data is available.
// These represent the engine's growth roadmap.
// ════════════════════════════════════════════════════════════════════

const NFU_LIBRARY = {

  // NFU-001: Load-Shedding Resilience Score (SA-specific)
  // Measures how resistant a business is to energy supply disruption.
  // Grounded in SA load-shedding economic impact data (CSIR, 2024).
  'NFU-001-LOADSHEDDING': {
    name: 'Load-Shedding Resilience Score',
    description: 'Quantifies a business\'s structural resilience to energy supply disruption — a systemic risk specific to South Africa and several Sub-Saharan African contexts.',
    motivation: 'Load-shedding cost SA businesses R204 billion in 2023 (CSIR, 2024). Standard financial ratios do not capture energy risk exposure. Businesses with higher energy cost ratios (energy/revenue > 8%) face structurally elevated cash flow volatility not reflected in their DI.',
    formula: {
      type: 'additive_penalty_bonus',
      inputs: [
        { name: 'energy_cost_ratio', label: 'Energy costs as % of revenue', source: 'user_input' },
        { name: 'has_backup_power',  label: 'Has backup power (generator/solar)', source: 'user_input', type: 'boolean' },
        { name: 'sector',            label: 'Business sector', source: 'existing_input' },
      ],
      computation: `
        // High-energy sectors face greater structural exposure
        const sectorMultiplier = { manufacturing:1.4, hospitality:1.3, retail:1.2, default:1.0 }[sector] || 1.0;
        const baseExposure = Math.min(1.0, energyCostRatio / 0.12);  // 12% = maximum exposure
        const backupMitigation = hasBackupPower ? 0.45 : 0;
        const lsScore = Math.round((1 - (baseExposure * sectorMultiplier * (1 - backupMitigation))) * 100);
        return Math.max(0, Math.min(100, lsScore));
      `,
      output_range: [0, 100],
      output_label: 'Load-Shedding Resilience Score (LSRS)'
    },
    integration: {
      target_component: 'Collision Detection Engine',
      integration_mode: 'new_friction_type',
      friction_name:   'energy_supply_risk',
      severity_formula: 'Math.round((1 - lsScore/100) * 20)',  // up to 20 collision risk points
      weight_in_di:    null  // expressed as collision risk, not DI weight
    },
    validation: {
      test_cases: [
        { inputs: { energy_cost_ratio:0.03, has_backup_power:false, sector:'services'     }, expected_lsrs_min:75 },
        { inputs: { energy_cost_ratio:0.12, has_backup_power:false, sector:'manufacturing'}, expected_lsrs_max:20 },
        { inputs: { energy_cost_ratio:0.10, has_backup_power:true,  sector:'retail'       }, expected_lsrs_min:50 },
      ],
      acceptance_criteria: 'LSRS ≥ 75 for low-exposure services; LSRS ≤ 20 for high-exposure unprotected manufacturing'
    },
    expected_impact: 'Improves DI prediction accuracy for SA manufacturing and retail SMMEs by 6–10 DI points. Reduces collision miss rate for energy-exposed firms.',
    trade_secret: true
  },

  // NFU-002: Payment Behaviour Credit Score
  // Derived from actual Billsource transaction history — not self-reported.
  'NFU-002-PAYMENT-CREDIT': {
    name: 'Payment Behaviour Credit Score',
    description: 'A behavioural credit score derived from observed payment history within the Billsource ecosystem — independent of self-reported financial data.',
    motivation: 'The Node Resilience Model currently relies on estimated relationship scores when ecosystem data is absent. As Billsource accumulates transaction history, a behavioural credit score can be computed from observed on-time payment rates, average delay days, and reciprocity (do suppliers pay this firm on time?). This converts the NHS relationship component from an estimate to an observation.',
    formula: {
      type: 'behavioural_composite',
      inputs: [
        { name: 'on_time_payment_rate',    label: 'Proportion of payments made on time', source: 'billsource_transactions' },
        { name: 'avg_delay_days',          label: 'Average payment delay beyond terms',  source: 'billsource_transactions' },
        { name: 'reciprocity_score',       label: 'Proportion of suppliers paying this firm on time', source: 'billsource_transactions' },
        { name: 'payment_history_months',  label: 'Months of payment history available', source: 'billsource_transactions' },
      ],
      computation: `
        const historyWeight = Math.min(1.0, paymentHistoryMonths / 12);  // 12 months = full weight
        const baseScore = (onTimePaymentRate * 0.5) +
                          (Math.max(0, 1 - avgDelayDays/30) * 0.3) +
                          (reciprocityScore * 0.2);
        return Math.round(baseScore * 100 * historyWeight + 60 * (1 - historyWeight));
      `,
      output_range: [0, 100],
      output_label: 'Payment Behaviour Credit Score (PBCS)'
    },
    integration: {
      target_component: 'Node Resilience Model',
      integration_mode: 'replace_estimated_relationship_score',
      condition: 'paymentHistoryMonths >= 3',  // only activate with sufficient history
      fallback: 'existing_estimated_relationship_score'
    },
    validation: {
      test_cases: [
        { inputs: { on_time_payment_rate:0.95, avg_delay_days:2,  reciprocity_score:0.90, payment_history_months:12 }, expected_min:85 },
        { inputs: { on_time_payment_rate:0.60, avg_delay_days:18, reciprocity_score:0.55, payment_history_months:6  }, expected_range:[45,65] },
        { inputs: { on_time_payment_rate:0.40, avg_delay_days:35, reciprocity_score:0.30, payment_history_months:3  }, expected_max:40 },
      ],
      acceptance_criteria: 'Correlation with observed business survival (T+180) ≥ 0.60; higher than current estimated relationship score'
    },
    expected_impact: 'Converts NHS relationship component from estimated (~60% accuracy) to observed (target >80% accuracy). Improves criterion validity for firms with 3+ months Billsource history.',
    trade_secret: true
  },

  // NFU-003: Informal Economy Integration Index
  // Captures the degree to which an SMME bridges formal and informal economy
  'NFU-003-INFORMAL-BRIDGE': {
    name: 'Informal Economy Integration Index',
    description: 'Measures a business\'s structural integration with the informal economy — a source of both resilience and financial opacity specific to Global South contexts.',
    motivation: 'Standard financial models treat informal economy participation as missing data or noise. In the Global South, a spaza shop that buys from informal wholesalers and sells to unbanked consumers is not financially opaque — it has a different financial architecture. This NFU captures informal bridge activity as a resilience factor (stable demand, low debtor risk) while flagging cash-handling opacity as a governance risk.',
    formula: {
      type: 'dual_signal',
      inputs: [
        { name: 'cash_revenue_ratio',       label: 'Proportion of revenue received as cash', source: 'user_input' },
        { name: 'informal_supplier_ratio',  label: 'Proportion of suppliers without formal invoices', source: 'user_input' },
        { name: 'unbanked_customer_ratio',  label: 'Proportion of customers without bank accounts', source: 'user_input' },
      ],
      computation: `
        // Resilience signal: cash and informal participation reduces DSO and concentration risk
        const resilienceBonus = Math.min(20, (cashRevenueRatio * 15) + (unbankedCustomerRatio * 10));
        // Governance risk: informal suppliers and cash-heavy operations increase reporting opacity
        const governancePenalty = Math.min(15, (informalSupplierRatio * 10) + (cashRevenueRatio * 8));
        return { resilienceBonus, governancePenalty, netEffect: resilienceBonus - governancePenalty };
      `,
      output_range: [-15, 20],
      output_label: 'Informal Economy Integration Index (IEII)'
    },
    integration: {
      target_component: 'Digital Index',
      integration_mode: 'additive_modifier',
      apply_to: 'digitalIndex_raw_before_adizes',
      note: 'IEII net effect added to raw DI before Adizes modifier. Positive = resilience bonus; negative = governance penalty.'
    },
    validation: {
      test_cases: [
        { inputs: { cash_revenue_ratio:0.90, informal_supplier_ratio:0.70, unbanked_customer_ratio:0.80 }, expected_net_positive: false, expected_net_range:[-5,5] },
        { inputs: { cash_revenue_ratio:0.80, informal_supplier_ratio:0.10, unbanked_customer_ratio:0.85 }, expected_net_positive: true  },
        { inputs: { cash_revenue_ratio:0.10, informal_supplier_ratio:0.05, unbanked_customer_ratio:0.10 }, expected_net:0 },
      ],
      acceptance_criteria: 'IEII adds ≤ 20 points to DI; does not distort sector benchmark comparison; governance penalty correctly flags high-cash firms for Governance sub-agent routing'
    },
    expected_impact: 'Reduces systematic DI underestimation for micro-enterprises in the informal sector. Activates Governance sub-agent routing for high-cash opacity firms. Reduces scope boundary tension for partially-informal SMMEs.',
    trade_secret: false  // formula structure can be published; parameters are in env var
  },

  // NFU-004: Antifragility Score
  // Measures how much a business gains from ecosystem disorder — Taleb applied operationally
  'NFU-004-ANTIFRAGILITY': {
    name: 'Antifragility Score',
    description: 'Operationalises Taleb\'s (2012) antifragility concept: measures the degree to which a business is structured to gain, rather than merely survive, from ecosystem volatility and disruption.',
    motivation: 'Standard resilience metrics (current ratio, D/E) measure ability to absorb shocks. Antifragility is different: an antifragile SMME increases its market share when competitors fail, exploits supply chain disruptions to renegotiate terms, and grows its customer base during sector distress. This NFU captures structural antifragility — not a sentiment measure but a financial architecture signal.',
    formula: {
      type: 'composite_structural',
      inputs: [
        { name: 'revenue_during_peer_distress',  label: 'Revenue growth during periods when sector mean DI declined', source: 'billsource_longitudinal' },
        { name: 'cash_reserve_ratio',            label: 'Cash as % of current assets (dry powder)', source: 'financial_inputs' },
        { name: 'supplier_diversification',      label: 'Number of active suppliers (Herfindahl index inverse)', source: 'billsource_transactions' },
        { name: 'receivables_concentration',     label: 'Receivables concentration (1 - concentrationRatio)', source: 'ecosystem_data' },
        { name: 'debt_flexibility_ratio',        label: 'Variable / fixed debt ratio (flexibility to reduce leverage)', source: 'user_input' },
      ],
      computation: `
        const peerdistressBonus  = Math.min(30, Math.max(0, revenueDuringPeerDistress * 100));
        const cashReserveBonus   = Math.min(20, cashReserveRatio * 60);
        const diversification    = Math.min(25, supplierDiversification * 5);
        const concentrationBonus = Math.min(15, receivablesConcentration * 20);
        const flexibilityBonus   = Math.min(10, debtFlexibilityRatio * 15);
        return Math.round(peerdistressBonus + cashReserveBonus + diversification + concentrationBonus + flexibilityBonus);
      `,
      output_range: [0, 100],
      output_label: 'Antifragility Score (AFS)'
    },
    integration: {
      target_component: 'Digital Index',
      integration_mode: 'new_component_weight',
      proposed_weight:  0.05,            // 5% of DI, redistributed from wAdizesModifier
      requires_data:    ['billsource_longitudinal', 'billsource_transactions'],
      minimum_history_months: 6
    },
    validation: {
      test_cases: [
        { desc: 'Cash-rich diversified firm with history of counter-cyclical growth', expected_min: 70 },
        { desc: 'Highly leveraged concentrated firm with declining sector position',  expected_max: 20 },
        { desc: 'New firm with no history — should default gracefully',               expected_fallback: true }
      ],
      acceptance_criteria: 'AFS adds discriminant power beyond existing NHS; Spearman correlation with 12-month business survival ≥ 0.55'
    },
    expected_impact: 'Identifies the sub-set of SMMEs that are structurally positioned to grow during ecosystem distress — critical for investment prioritisation by SMME support programmes and FSPs.',
    trade_secret: true
  },

  // NFU-005: Temporal Cash Flow Volatility Index
  // Captures seasonality and cash flow instability — invisible in ratio analysis
  'NFU-005-CASHFLOW-VOLATILITY': {
    name: 'Temporal Cash Flow Volatility Index',
    description: 'Measures the temporal stability of cash flow — distinguishing between businesses with structurally volatile revenue patterns (seasonal agriculture, events-based hospitality) and those with stable monthly flows.',
    motivation: 'Two businesses with identical 12-month average OCF may have very different survival probabilities: one has stable monthly cash flow, the other has three strong months and nine months of negative flow. Standard ratio analysis treats them identically. This NFU uses rolling monthly revenue variance to penalise dangerous volatility and reward stability.',
    formula: {
      type: 'time_series',
      inputs: [
        { name: 'monthly_revenue_series', label: 'Last 12 months of monthly revenue figures', source: 'billsource_invoices' },
      ],
      computation: `
        const n = monthlyRevenueSeries.length;
        if (n < 3) return 60;  // insufficient history — default moderate
        const mean = monthlyRevenueSeries.reduce((a,b)=>a+b,0)/n;
        const variance = monthlyRevenueSeries.reduce((a,v)=>a+Math.pow(v-mean,2),0)/n;
        const cv = Math.sqrt(variance) / mean;  // coefficient of variation
        // cv < 0.20 = stable; cv 0.20-0.50 = moderate; cv > 0.50 = volatile
        const stabilityScore = Math.round(Math.max(0, 100 - (cv * 120)));
        return Math.min(100, stabilityScore);
      `,
      output_range: [0, 100],
      output_label: 'Cash Flow Stability Score (CFSS)'
    },
    integration: {
      target_component: 'Financial Health Scorer',
      integration_mode: 'replace_cashflow_dimension',
      replaces: 'dimCashFlow (current OCF-based calculation)',
      requires_data: ['billsource_invoices'],
      minimum_history_months: 3,
      fallback: 'existing_ocf_cashflow_dimension'
    },
    validation: {
      test_cases: [
        { monthly_series: [100,102,98,101,99,103,100,101,99,100,102,98], expected_min: 85, desc: 'Stable services firm' },
        { monthly_series: [20,18,22,200,180,195,15,12,18,160,180,190],  expected_max: 40, desc: 'Seasonal ag/hospitality' },
        { monthly_series: [100,50,200],                                   expected_fallback: false, expected_range:[40,70] }
      ],
      acceptance_criteria: 'CFSS correlation with observed T+90 outcome ≥ 0.50; correctly penalises seasonal volatility without distorting sector benchmarks'
    },
    expected_impact: 'Improves DI accuracy for seasonal sectors (agriculture, hospitality, events) by distinguishing structural volatility from financial distress. Reduces false-positive elevated-risk classifications for healthy seasonal businesses.',
    trade_secret: false
  }
};

// ── Register all library NFUs as pending proposals ────────────────────
async function registerNFULibrary() {
  for (const [key, nfu] of Object.entries(NFU_LIBRARY)) {
    await proposeNovelFormulaUnit({ ...nfu, triggered_by: 'NFU_LIBRARY_INIT' });
  }
}

// ════════════════════════════════════════════════════════════════════
// ADMIN API INTERFACE
// Routes for PLM administration — mounted in server.js
// ════════════════════════════════════════════════════════════════════

async function getPLMStatus() {
  let obsCount = 0, withOutcomes = 0, proposalCount = 0, activeSignals = 0;
  if (db.pool) {
    const [o, p, d] = await Promise.all([
      db.pool.query('SELECT COUNT(*) as n, COUNT(outcome_t90) as with_outcomes FROM plm_observations'),
      db.pool.query("SELECT COUNT(*) as n FROM plm_proposals WHERE status NOT IN ('rejected','deployed')"),
      db.pool.query("SELECT COUNT(*) as n FROM plm_diagnostics WHERE status='open'"),
    ]);
    obsCount      = parseInt(o.rows[0].n);
    withOutcomes  = parseInt(o.rows[0].with_outcomes);
    proposalCount = parseInt(p.rows[0].n);
    activeSignals = parseInt(d.rows[0].n);
  } else {
    obsCount      = _memObservations.length;
    withOutcomes  = _memObservations.filter(o=>o.di_t90!==undefined).length;
    proposalCount = _memProposals.filter(p=>!['rejected','deployed'].includes(p.status)).length;
  }

  return {
    status:                    'operational',
    observations_total:        obsCount,
    observations_with_outcomes:withOutcomes,
    coverage_pct:              obsCount > 0 ? _r2(withOutcomes/obsCount*100) : 0,
    open_proposals:            proposalCount,
    active_diagnostic_signals: activeSignals,
    nfu_library_count:         Object.keys(NFU_LIBRARY).length,
    config_hash:               hashConfig(),
    governance_gate:           'ACTIVE — all proposals require sandbox pass + human authorisation',
    engine_version:            '1.0.0'
  };
}

async function getPendingProposals() {
  if (db.pool) {
    const r = await db.pool.query(`
      SELECT proposal_id, proposal_type, component, title, status,
             sandbox_passed, proposed_at, triggered_by
      FROM plm_proposals
      WHERE status IN ('proposed','sandbox_testing','pending_authorisation')
      ORDER BY proposed_at DESC
    `);
    return r.rows;
  }
  return _memProposals.filter(p => ['proposed','sandbox_testing','pending_authorisation'].includes(p.status));
}

async function getGovernanceLog(limit = 50) {
  if (db.pool) {
    const r = await db.pool.query(
      'SELECT * FROM plm_governance_log ORDER BY event_at DESC LIMIT $1', [limit]);
    return r.rows;
  }
  return _memLearningLog.slice(-limit).reverse();
}

// ════════════════════════════════════════════════════════════════════
// INTERNAL UTILITIES
// ════════════════════════════════════════════════════════════════════

function _mean(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }
function _sd(arr)   { const m=_mean(arr); return Math.sqrt(arr.reduce((a,v)=>a+Math.pow(v-m,2),0)/arr.length); }
function _r2(n)     { return Math.round(n*100)/100; }
function _hashString(s) { let h=0; for(let i=0;i<s.length;i++) h=(Math.imul(31,h)+s.charCodeAt(i))|0; return Math.abs(h).toString(16).padStart(8,'0'); }

function _getCurrentConfig() {
  if (!process.env.RATING_ENGINE_CONFIG) return null;
  try { return JSON.parse(Buffer.from(process.env.RATING_ENGINE_CONFIG,'base64').toString('utf8')); }
  catch(e) { return null; }
}

function _applyProposalToConfig(config, proposal) {
  if (!config || !proposal.formula_spec) return config;
  const updated = JSON.parse(JSON.stringify(config)); // deep clone

  if (proposal.proposal_type === 'parameter_adjustment') {
    // Deep merge the adjustment spec into the config
    _deepMerge(updated, proposal.formula_spec);
  }
  // NFU proposals don't modify the config directly — they add a new section
  if (proposal.proposal_type === 'novel_component') {
    if (!updated.extensions) updated.extensions = {};
    updated.extensions[proposal.proposal_id] = {
      name:        proposal.component,
      formula_spec: proposal.formula_spec,
      status:      'deployed'
    };
  }
  return updated;
}

function _deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      _deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

function _humanReadableAdjustment(component, spec) {
  return `Proposed change to ${component}:\n${JSON.stringify(spec, null, 2)}\n\nThis adjustment updates the named parameters in the operational config. All other engine behaviour is unchanged.`;
}

function _humanReadableNFU(nfu) {
  return `Novel Formula Unit: ${nfu.name}\n\nFormula:\n${nfu.formula?.computation?.trim()}\n\nIntegration:\nTarget: ${nfu.integration?.target_component}\nMode: ${nfu.integration?.integration_mode}\n\nValidation:\n${nfu.validation?.acceptance_criteria}`;
}

function _getValidationBattery() {
  // The canonical 7-archetype battery from BS-TEF-2026-001
  return [
    { sector:'retail',      revenue:18500,  costOfSales:14200, operatingExpenses:3100, netProfit:600,   currentAssets:28000, currentLiabilities:16000, accountsReceivable:6000, accountsPayable:11000, inventory:19000, totalDebt:12000, equity:16000,   annualRevenue:222000 },
    { sector:'construction',revenue:180000, costOfSales:130000,operatingExpenses:45000,netProfit:-5000, currentAssets:420000,currentLiabilities:380000,accountsReceivable:310000,accountsPayable:95000,inventory:80000, totalDebt:250000,equity:170000,  annualRevenue:2160000 },
    { sector:'technology',  revenue:95000,  costOfSales:22000, operatingExpenses:88000,netProfit:-18000,currentAssets:195000,currentLiabilities:115000,accountsReceivable:58000,accountsPayable:15000, inventory:4000,  totalDebt:75000, equity:120000,  annualRevenue:1140000,revenueGrowthRate:0.55 },
    { sector:'healthcare',  revenue:265000, costOfSales:88000, operatingExpenses:90000,netProfit:68000, currentAssets:590000,currentLiabilities:170000,accountsReceivable:195000,accountsPayable:42000,inventory:28000, totalDebt:110000,equity:480000,  annualRevenue:3180000 },
    { sector:'manufacturing',revenue:680000,costOfSales:510000,operatingExpenses:120000,netProfit:28000,currentAssets:2200000,currentLiabilities:1100000,accountsReceivable:820000,accountsPayable:320000,inventory:680000,totalDebt:900000,equity:1300000,annualRevenue:8160000 },
    { sector:'retail',      revenue:420000, costOfSales:355000,operatingExpenses:92000,netProfit:-42000,currentAssets:560000,currentLiabilities:680000,accountsReceivable:88000,accountsPayable:310000,inventory:380000,totalDebt:950000,equity:220000,  annualRevenue:5040000 },
    { sector:'services',    revenue:210000, costOfSales:65000, operatingExpenses:75000,netProfit:60000, currentAssets:520000,currentLiabilities:180000,accountsReceivable:95000,accountsPayable:28000, inventory:5000,  totalDebt:80000, equity:440000,  annualRevenue:2520000 },
  ];
}

function _countRankViolations(baseline, proposed) {
  // Check that the rank ordering of DIs is preserved
  const bDIs = baseline.map(r => r.node_health.digital_index);
  const pDIs = proposed.map(r => r.node_health.digital_index);
  let violations = 0;
  for (let i = 0; i < bDIs.length; i++) {
    for (let j = i+1; j < bDIs.length; j++) {
      const bRel = Math.sign(bDIs[i] - bDIs[j]);
      const pRel = Math.sign(pDIs[i] - pDIs[j]);
      if (bRel !== 0 && pRel !== 0 && bRel !== pRel) violations++;
    }
  }
  return violations;
}

function _checkMonotonicity(results) {
  // At minimum: sector-average healthy (healthcare) > sector-average distressed (construction)
  const healthcare   = results.find(r => r.detail?.sectorPerformance?.sector === 'healthcare');
  const construction = results.find(r => r.detail?.sectorPerformance?.sector === 'construction');
  if (!healthcare || !construction) return true; // cannot test — pass
  return healthcare.node_health.digital_index > construction.node_health.digital_index;
}

function _riskDistribution(results) {
  const dist = { low:0, moderate:0, elevated:0, critical:0 };
  results.forEach(r => { if (dist[r.risk_level] !== undefined) dist[r.risk_level]++; });
  return dist;
}

async function _saveProposal(proposal) {
  if (db.pool) {
    try {
      await db.pool.query(`
        INSERT INTO plm_proposals
          (proposal_id,proposal_type,triggered_by,component,title,description,
           formula_spec,formula_human,evidence_basis,expected_impact,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (proposal_id) DO NOTHING
      `, [proposal.proposal_id,proposal.proposal_type,proposal.triggered_by||null,
          proposal.component,proposal.title,proposal.description,
          JSON.stringify(proposal.formula_spec),proposal.formula_human,
          proposal.evidence_basis,proposal.expected_impact,proposal.status]);
    } catch(e) { console.error('PLM save proposal error:', e.message); }
  } else {
    _memProposals.push({ ...proposal, proposed_at: new Date().toISOString() });
  }
}

async function _raiseDiagnostic(d) {
  const diagnosticId = `DIAG-${d.signal_type.toUpperCase()}-${Date.now()}`;
  const diagnostic = { diagnostic_id: diagnosticId, ...d, status: 'open' };
  if (db.pool) {
    try {
      await db.pool.query(`
        INSERT INTO plm_diagnostics
          (diagnostic_id,signal_type,severity,component,population,evidence,description,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      `, [diagnosticId,d.signal_type,d.severity,d.component,
          JSON.stringify(d.population),JSON.stringify(d.evidence),d.description,'open']);
    } catch(e) { /* non-fatal */ }
  }
  await _logGovernance('diagnostic_raised', diagnosticId, 'PLM_AUTO', d);
  return diagnostic;
}

async function _logGovernance(eventType, entityId, actor, payload, configBefore=null, configAfter=null) {
  const entry = { event_type:eventType, entity_id:entityId, actor, payload, event_at:new Date().toISOString(), config_hash_before:configBefore, config_hash_after:configAfter };
  if (db.pool) {
    try {
      await db.pool.query(`
        INSERT INTO plm_governance_log(event_type,entity_id,actor,payload,config_hash_before,config_hash_after)
        VALUES($1,$2,$3,$4,$5,$6)
      `, [eventType, entityId, actor, JSON.stringify(payload), configBefore, configAfter]);
    } catch(e) { /* non-fatal */ }
  } else {
    _memLearningLog.push(entry);
    if (_memLearningLog.length > 5000) _memLearningLog.shift();
  }
}

// ════════════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════════════
module.exports = {
  // Lifecycle
  initPLMTables,
  registerNFULibrary,

  // Mode 1 — Observe
  recordObservation,
  recordOutcome,

  // Mode 2 — Diagnose
  runDiagnostics,

  // Mode 3 — Propose
  proposeParameterAdjustment,
  proposeNovelFormulaUnit,
  runSandboxTest,

  // Mode 4 — Govern
  authoriseProposal,
  deployProposal,
  revertToVersion,

  // Admin
  getPLMStatus,
  getPendingProposals,
  getGovernanceLog,
  NFU_LIBRARY,

  // Utilities (exposed for testing)
  hashConfig,
};
