/**
 * Minimal CSV helpers shared by the DOL importer and the enrichment pipeline.
 */

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

/**
 * True when `text` ends inside an unterminated quoted field. The "" escape is
 * two quote characters, so simple toggling tracks the final state correctly.
 */
function endsInsideQuotes(text) {
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') quoted = !quoted;
  }
  return quoted;
}

/**
 * Yields one parsed record per logical CSV row from an async iterable of
 * physical lines (e.g. a readline interface). Physical lines that end inside
 * an unterminated quoted field are rejoined with '\n' until the quotes
 * balance, so a quoted field containing newlines parses as one record
 * instead of mis-splitting into shifted rows. Blank lines are skipped.
 */
async function* csvRecords(lines) {
  let pending = null;
  for await (const line of lines) {
    pending = pending === null ? line : `${pending}\n${line}`;
    if (endsInsideQuotes(pending)) continue;
    if (pending !== '') yield parseCsvLine(pending);
    pending = null;
  }
  // A trailing unbalanced quote means a truncated file; parse what we have
  // rather than silently dropping the final record.
  if (pending !== null && pending !== '') yield parseCsvLine(pending);
}

/**
 * Parses full CSV text into an array of records, honoring quoted fields that
 * contain commas, escaped quotes, and newlines. Blank lines are skipped.
 */
function parseCsv(text) {
  const records = [];
  let fields = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(current);
      current = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      if (fields.length > 0 || current !== '') {
        fields.push(current);
        records.push(fields);
      }
      fields = [];
      current = '';
    } else {
      current += char;
    }
  }
  if (fields.length > 0 || current !== '') {
    fields.push(current);
    records.push(fields);
  }
  return records;
}

function columnIndex(headers, candidates) {
  const normalized = headers.map((header) => header.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''));
  for (const candidate of candidates) {
    const index = normalized.indexOf(candidate);
    if (index >= 0) return index;
  }
  return -1;
}

module.exports = { parseCsvLine, parseCsv, csvRecords, columnIndex };
