/**
 * Deadline parser: pulls an application close date out of posting text. Anchored
 * on an explicit cue ("Close Date", "apply by", "application deadline") so a
 * random date in the body isn't mistaken for a deadline, and it deliberately
 * ignores "review of applications begins…" (a start signal, not a hard cutoff).
 * Returns an ISO date (YYYY-MM-DD) or null.
 */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

const CUE = /(close\s+date|closing\s+date|application\s+deadline|deadline\s+to\s+apply|apply\s+by|apply\s+before|applications?\s+(?:due|close|must\s+be\s+received))/i;

function toIso(year, month, day) {
  let y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (y < 100) y += 2000;
  // Bound the year so OCR-ish noise ("07/16/1999") and typos don't slip through.
  if (y < 2024 || y > 2031 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseDeadline(text) {
  const s = String(text || '');
  if (!s) return null;
  const cue = s.match(CUE);
  if (!cue) return null;
  // Only look at the span right after the cue — "Close Date: 07/21/2026".
  const window = s.slice(cue.index, cue.index + cue[0].length + 40);

  let m = window.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) return toIso(m[3], m[1], m[2]);

  m = window.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (m) {
    const mm = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mm) return toIso(m[3], mm, m[2]);
  }

  m = window.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (m) {
    const mm = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mm) return toIso(m[3], mm, m[1]);
  }

  return null;
}

module.exports = { parseDeadline };
