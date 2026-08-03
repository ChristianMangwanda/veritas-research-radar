/**
 * Application-pipeline helpers — shared by the dashboard (script tag, no
 * build step) and node tests (require()), same pattern as scoring.js.
 *
 * The pipeline view groups jobs the user has actually acted on (applied,
 * emailed the lab, or further along) by stage. Stage membership is decided
 * here so the ordering, the stats bar, and the tests all agree on one
 * definition. Shortlist and visa-check are deliberately NOT pipeline
 * stages: they are intent and pre-application gating, which belong in the
 * radar view where the decision to apply gets made.
 */

(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;

  // In-flight stages, display order: most consequential first, waiting last.
  const PIPELINE_STAGES = ['offer', 'interview', 'applied', 'emailed_lab'];

  // Terminal outcomes, collapsed below the in-flight groups.
  const PIPELINE_TERMINAL = ['rejected', 'withdrawn'];

  const PIPELINE_SET = new Set([...PIPELINE_STAGES, ...PIPELINE_TERMINAL]);

  // Whole days since an ISO timestamp; null when absent/unparseable so
  // callers can skip the chip instead of rendering "NaNd".
  function daysSince(iso, now) {
    const then = Date.parse(iso || '');
    if (!Number.isFinite(then)) return null;
    const reference = Number.isFinite(now) ? now : Date.now();
    return Math.max(0, Math.floor((reference - then) / 86400000));
  }

  // Group jobs by pipeline stage. In-flight groups sort oldest-updated first
  // (the application most in need of a follow-up tops its group); terminal
  // groups newest first (recent outcomes are the relevant ones). Stages with
  // no jobs are omitted.
  function groupPipeline(jobs, triageMap) {
    const triage = triageMap || {};
    const byStage = new Map();
    for (const job of jobs || []) {
      const status = triage[job.id]?.status;
      if (!PIPELINE_SET.has(status)) continue;
      if (!byStage.has(status)) byStage.set(status, []);
      byStage.get(status).push(job);
    }
    const updatedAt = (job) => String(triage[job.id]?.updated_at || '');
    const groups = [];
    for (const stage of PIPELINE_STAGES) {
      const list = byStage.get(stage);
      if (!list) continue;
      list.sort((a, b) => updatedAt(a) < updatedAt(b) ? -1 : updatedAt(a) > updatedAt(b) ? 1 : 0);
      groups.push({ stage, terminal: false, jobs: list });
    }
    for (const stage of PIPELINE_TERMINAL) {
      const list = byStage.get(stage);
      if (!list) continue;
      list.sort((a, b) => updatedAt(a) > updatedAt(b) ? -1 : updatedAt(a) < updatedAt(b) ? 1 : 0);
      groups.push({ stage, terminal: true, jobs: list });
    }
    return groups;
  }

  // Last-write-wins per job by updated_at — merges a remote triage map into a
  // local one without losing either side's newer edits. Ties keep local
  // (strict >), so a device never discards its own record for an equal echo.
  function mergeTriage(local, remote) {
    const merged = { ...(local || {}) };
    for (const [jobId, record] of Object.entries(remote || {})) {
      const current = merged[jobId];
      if (!current || String(record.updated_at || '') > String(current.updated_at || '')) {
        merged[jobId] = record;
      }
    }
    return merged;
  }

  const RadarPipeline = {
    PIPELINE_STAGES,
    PIPELINE_TERMINAL,
    PIPELINE_SET,
    daysSince,
    groupPipeline,
    mergeTriage
  };

  root.RadarPipeline = RadarPipeline;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RadarPipeline;
  }
})();
