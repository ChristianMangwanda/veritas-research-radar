/**
 * Shared salary parser: turns pay language ("$60,000 - $80,000", "$19.23/hr",
 * "$120K–$150K") into a normalized annualized range. Used for both the Ashby
 * compensation field (structured, trusted) and free description text (untrusted,
 * ranges only — a lone "$5,000 relocation" must not read as a salary).
 */

const HOURS_PER_YEAR = 2080;
const ANNUAL_MIN = 10000;
const ANNUAL_MAX = 2000000;

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const SUF = String.raw`[kKmM]`;
const AMT = String.raw`\$\s*(${NUM})\s*(${SUF})?`;
const RANGE_RE = new RegExp(`${AMT}\\s*(?:-|–|—|to|through)\\s*\\$?\\s*(${NUM})\\s*(${SUF})?`, 'i');
const SINGLE_RE = new RegExp(AMT, 'i');

function scale(raw, suffix) {
  let n = parseFloat(String(raw).replace(/,/g, ''));
  const s = (suffix || '').toLowerCase();
  if (s === 'k') n *= 1000;
  else if (s === 'm') n *= 1000000;
  return n;
}

// Hourly if a rate keyword sits near the figure, or the numbers are simply too
// small to be annual salaries.
function isHourly(context, maxValue) {
  if (/\bper\s+hour\b|\/\s*h(ou)?r\b|\ban\s+hour\b|\bhourly\b|\bper\s+hr\b/i.test(context)) return true;
  return maxValue < 500;
}

function annualize(value, hourly) {
  return hourly ? value * HOURS_PER_YEAR : value;
}

function plausible(min, max) {
  return min >= ANNUAL_MIN && max <= ANNUAL_MAX && max >= min;
}

/**
 * @param {string} text
 * @param {{trusted?: boolean}} opts  trusted=true (a dedicated comp field) also
 *   accepts a single figure; untrusted free text requires a range.
 * @returns {{salary_min, salary_max, salary_period, salary_currency}|null}
 */
function parseSalary(text, { trusted = false } = {}) {
  const s = String(text || '');
  if (!s) return null;

  const range = s.match(RANGE_RE);
  if (range) {
    const lo = scale(range[1], range[2]);
    const hi = scale(range[3], range[4]);
    const context = s.slice(Math.max(0, range.index - 20), range.index + range[0].length + 20);
    const hourly = isHourly(context, Math.max(lo, hi));
    const min = Math.round(annualize(Math.min(lo, hi), hourly));
    const max = Math.round(annualize(Math.max(lo, hi), hourly));
    if (plausible(min, max)) {
      return { salary_min: min, salary_max: max, salary_period: hourly ? 'hour' : 'year', salary_currency: 'USD' };
    }
  }

  if (trusted) {
    const single = s.match(SINGLE_RE);
    if (single) {
      const value = scale(single[1], single[2]);
      const context = s.slice(Math.max(0, single.index - 20), single.index + single[0].length + 20);
      const hourly = isHourly(context, value);
      const annual = Math.round(annualize(value, hourly));
      if (plausible(annual, annual)) {
        return { salary_min: annual, salary_max: annual, salary_period: hourly ? 'hour' : 'year', salary_currency: 'USD' };
      }
    }
  }

  return null;
}

module.exports = { parseSalary };
