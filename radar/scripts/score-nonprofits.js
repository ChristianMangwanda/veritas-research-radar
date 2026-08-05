#!/usr/bin/env node

/**
 * Rank the 14,414 nonprofits in the cap-exempt directory by whether they are
 * plausibly research EMPLOYERS, using IRS master-file fields the enrichment
 * pipeline downloads and then throws away.
 *
 * Why this exists: every one of those 14,414 carries an NTEE code in H/U/V,
 * which looks like the statutory "nonprofit research organization" category
 * and is not — the pool contains a railroad museum, an apple growers' society
 * and 1,189 health-fundraising arms. The next step in this project is paying
 * an API to find a website for each of them, so ranking first is the
 * difference between paying for a few thousand real research institutes and
 * paying for fourteen thousand mostly-nothing.
 *
 * The join is on EIN, which every directory nonprofit has, so there is no
 * fuzzy name matching here and no false pairs.
 *
 * Usage:
 *   node radar/scripts/score-nonprofits.js              # download (cached) + score
 *   node radar/scripts/score-nonprofits.js --offline    # use the cache only
 *   node radar/scripts/score-nonprofits.js --dry-run    # report, write nothing
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const { csvRecords, columnIndex } = require('./lib/csv.js');
const { downloadToFile } = require('./enrich.js');
const { scoreNonprofit } = require('./lib/nonprofit-score.js');

const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'radar', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'enrichment-cache');
const DIRECTORY_PATH = path.join(DATA_DIR, 'cap-exempt-directory.json');
const OUT_PATH = path.join(DATA_DIR, 'nonprofit-ranking.json');

const IRS_FILES = ['eo1.csv', 'eo2.csv', 'eo3.csv', 'eo4.csv'];

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Index the master file by EIN, keeping only the EINs the directory actually
 * asks about. The four files are ~1.9M rows; holding all of them costs
 * hundreds of MB for no reason when the question is about 14,414 of them.
 */
async function indexIrsByEin(filePath, wanted, index) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let idx = null;
  let rows = 0;
  for await (const row of csvRecords(rl)) {
    if (!idx) {
      idx = {
        ein: columnIndex(row, ['EIN']),
        name: columnIndex(row, ['NAME']),
        subsection: columnIndex(row, ['SUBSECTION']),
        foundation: columnIndex(row, ['FOUNDATION']),
        ntee: columnIndex(row, ['NTEE_CD']),
        state: columnIndex(row, ['STATE']),
        city: columnIndex(row, ['CITY']),
        asset: columnIndex(row, ['ASSET_AMT']),
        income: columnIndex(row, ['INCOME_AMT']),
        revenue: columnIndex(row, ['REVENUE_AMT'])
      };
      // The four fields this script exists for. If the IRS reshapes the file,
      // fail loudly rather than silently scoring everything as tiny.
      for (const key of ['ein', 'foundation', 'revenue', 'asset']) {
        if (idx[key] < 0) throw new Error(`${path.basename(filePath)}: no ${key.toUpperCase()} column — IRS layout changed`);
      }
      continue;
    }
    rows += 1;
    const ein = digits(row[idx.ein]);
    if (!ein || !wanted.has(ein)) continue;
    index.set(ein, {
      name: String(row[idx.name] || '').trim(),
      subsection: String(row[idx.subsection] || '').trim(),
      foundation: String(row[idx.foundation] || '').trim(),
      ntee_cd: String(row[idx.ntee] || '').trim(),
      state: String(row[idx.state] || '').trim(),
      city: String(row[idx.city] || '').trim(),
      asset_amt: Number(row[idx.asset]) || 0,
      income_amt: Number(row[idx.income]) || 0,
      revenue_amt: Number(row[idx.revenue]) || 0
    });
  }
  return rows;
}

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes('--offline');
  const dryRun = argv.includes('--dry-run');

  const directory = JSON.parse(await fsp.readFile(DIRECTORY_PATH, 'utf8'));
  const entries = directory.entries;
  const nonprofits = Object.entries(entries).filter(([, e]) => e.kind !== 'ipeds' && e.ein);
  console.log(`directory: ${Object.keys(entries).length} entries · ${nonprofits.length} nonprofits with an EIN`);

  const wanted = new Set(nonprofits.map(([, e]) => digits(e.ein)));
  await fsp.mkdir(CACHE_DIR, { recursive: true });

  const irs = new Map();
  let scanned = 0;
  for (const file of IRS_FILES) {
    const dest = path.join(CACHE_DIR, file);
    try {
      const download = await downloadToFile(`https://www.irs.gov/pub/irs-soi/${file}`, dest, { offline });
      if (!download) continue;
      console.log(`IRS ${file}: ${download.cached ? 'cache' : 'downloaded'} (${Math.round(download.bytes / 1048576)}MB)`);
      scanned += await indexIrsByEin(dest, wanted, irs);
    } catch (error) {
      // One regional file missing degrades coverage; it must not lose the rest.
      console.warn(`IRS ${file}: ${error.message}`);
    }
  }
  console.log(`scanned ${scanned.toLocaleString()} master-file rows · matched ${irs.size.toLocaleString()} of ${wanted.size.toLocaleString()} EINs`);

  if (!irs.size) {
    console.error('No IRS rows matched. Refusing to write a ranking that would call every organisation tiny.');
    return 1;
  }

  const ranked = [];
  const tiers = {};
  const excluded = {};
  for (const [key, entry] of nonprofits) {
    const row = irs.get(digits(entry.ein)) || null;
    const verdict = scoreNonprofit(entry, row);
    tiers[verdict.tier] = (tiers[verdict.tier] || 0) + 1;
    if (verdict.excluded) excluded[verdict.excluded] = (excluded[verdict.excluded] || 0) + 1;
    ranked.push({
      key,
      name: entry.name,
      ein: entry.ein,
      website: entry.website || null,
      ntee_cd: row?.ntee_cd || entry.ntee_cd || null,
      state: row?.state || null,
      revenue_amt: row?.revenue_amt ?? null,
      asset_amt: row?.asset_amt ?? null,
      foundation: row?.foundation || null,
      uscis_approvals_3y: entry.uscis_approvals_3y || 0,
      dol_certified_3y: entry.dol_certified_3y || 0,
      score: verdict.score,
      tier: verdict.tier,
      excluded: verdict.excluded,
      /* Full evidence for anything still in contention, and for exclusions
       * (where the reason IS the decision and someone will want to argue with
       * it). The 8,000 'unlikely' rows carry the same three no-op reasons each
       * and were most of an 8.7MB file, so they keep the score and drop the
       * ledger — re-running the script reproduces it in a minute. */
      reasons: verdict.tier === 'unlikely' ? undefined : verdict.reasons
    });
  }
  ranked.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));

  const order = ['proven', 'strong', 'possible', 'unlikely', 'excluded'];
  console.log('\ntier distribution:');
  for (const tier of order) {
    if (tiers[tier]) console.log(`  ${String(tiers[tier]).padStart(6)}  ${tier}`);
  }
  if (Object.keys(excluded).length) {
    console.log('\nexcluded because:');
    for (const [reason, count] of Object.entries(excluded).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(6)}  ${reason}`);
    }
  }

  const lookupPool = ranked.filter((r) => r.tier !== 'excluded' && r.tier !== 'unlikely' && !r.website);
  console.log(`\nworth a website lookup (proven+strong+possible, no website yet): ${lookupPool.length.toLocaleString()}`);
  console.log('top of the list:');
  for (const row of ranked.filter((r) => !r.website).slice(0, 10)) {
    const money = row.revenue_amt ? `$${Math.round(row.revenue_amt / 1e6)}M` : '—';
    console.log(`  ${String(row.score).padStart(3)} ${row.tier.padEnd(9)} ${money.padStart(6)}  ${row.name.slice(0, 48)}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written');
    return 0;
  }

  await fsp.writeFile(OUT_PATH, `${JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    irs_rows_matched: irs.size,
    tiers,
    excluded,
    lookup_pool: lookupPool.length,
    organizations: ranked
  }, null, 1)}\n`, 'utf8');
  console.log(`\nwrote ${path.relative(process.cwd(), OUT_PATH)}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
