#!/usr/bin/env node

/**
 * Find ATS tenants for institutions whose websites we cannot read.
 *
 * 3,609 cap-exempt institutions have no discovered job feed — 2,230 because a
 * WAF refused us their homepage, 767 because the homepage had no findable
 * careers link, 612 because they are nonprofits we only just found addresses
 * for. Crawling harder does not fix the first group and an unblocker costs
 * money to try.
 *
 * The way around it: an institution's jobs do not live on its website. They
 * live on the vendor's host — myworkdayjobs.com, peopleadmin.com, csod.com —
 * which blocks nobody. Your radar already pulls 485 employers' feeds through
 * those hosts every six hours. So guess the tenant, probe the vendor, and the
 * blocked homepage stops mattering.
 *
 * DNS does the triage where it can. peopleadmin, csod and taleo return
 * NXDOMAIN for a nonsense tenant, which makes a 10ms lookup a real answer
 * instead of a 300ms request. workday and pageup resolve anything at all
 * (wildcard records), so those must be probed over HTTP.
 *
 * What this DOESN'T do: confirm the feed belongs to the institution. A
 * resolving host is a candidate, not a fact — harvard.csod.com could exist and
 * belong to someone else entirely. promote-employers.js does the authoritative
 * check, and it learned that lesson the expensive way when 120 "resolved"
 * employers turned out to be 52 boards, 44 of them a single beauty school.
 * Everything here is written as a candidate with its evidence attached.
 *
 * Usage:
 *   node radar/scripts/probe-tenants.js --limit 50
 *   node radar/scripts/probe-tenants.js --shard 0/8 --out shards/probe-0.json
 */

const dns = require('dns').promises;
const fsp = require('fs/promises');
const path = require('path');

const { tenantCandidates, PROVIDERS } = require('./lib/tenant-candidates.js');
// The authoritative Workday check, already written and already tested: it
// discovers the site name, counts real postings, and rejects shared
// multi-company boards — the failure that turned 120 "resolved" employers into
// 52 boards, 44 of them one beauty school.
const { probeWorkday } = require('./promote-employers.js');

const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'radar', 'data');
const DISCOVERY_PATH = path.join(DATA_DIR, 'ats-discovery.json');
const NONPROFIT_PATH = path.join(DATA_DIR, 'nonprofit-websites.json');
const EMPLOYERS_PATH = path.join(ROOT, 'radar', 'employers.json');
const OUT_PATH = path.join(DATA_DIR, 'tenant-probe.json');

const UA = 'veritas-research-radar/1.0 (personal research job search; contact via github.com/ChristianMangwanda/veritas-research-radar)';
const HTTP_TIMEOUT_MS = 8000;
const SAVE_EVERY = 100;

/* Concurrency is per-institution, not per-request: one worker owns an
 * institution and walks its candidates in order, so no vendor sees more than
 * WORKERS requests at once. ~140k probes across eight vendors is enough to
 * look like an attack if fired all at once, and getting Workday to blackhole
 * this project would cost far more than the half hour it saves. */
const WORKERS = 12;

const norm = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function resolves(hostname) {
  try {
    await dns.resolve4(hostname);
    return true;
  } catch (error) {
    if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') return false;
    return false; // SERVFAIL/timeouts: treat as absent, the probe is best-effort
  }
}

/** A live ATS board answers; a parked wildcard usually does not. */
async function httpAlive(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/json,*/*' },
      redirect: 'follow',
      signal: controller.signal
    });
    // 401/403 still means something is there — the wildcard hosts answer 404
    // or serve a generic parking page instead.
    if (response.status >= 500) return null;
    if (response.status === 404 || response.status === 410) return null;
    const body = (await response.text()).slice(0, 60000);
    return { status: response.status, url: response.url, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Weak corroboration only, and named as such: does the page mention the
 * institution at all? A board that never names its owner is not proof of
 * anything, which is exactly why promotion re-checks rather than trusting it. */
function pageMentions(body, name) {
  const hay = String(body || '').toLowerCase();
  const words = String(name).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 3 && !['university', 'college', 'institute', 'school', 'the', 'and', 'for', 'of'].includes(w));
  const hits = words.filter((w) => hay.includes(w));
  return { hits: hits.length, tokens: hits.slice(0, 3) };
}

async function probeInstitution(entry) {
  const candidates = tenantCandidates(entry);
  const attempted = [];
  for (const provider of PROVIDERS) {
    // Expensive providers get fewer guesses — see maxTenants on the Workday entry.
    const tenants = provider.maxTenants ? candidates.slice(0, provider.maxTenants) : candidates;
    for (const tenant of tenants) {
      for (const url of provider.hosts(tenant)) {
        let hostname;
        try { hostname = new URL(url).hostname; } catch { continue; }

        /* Workday cannot be probed at its hostname. Both a real tenant and
         * pure nonsense answer HTTP 406 with an empty body, so the bare host
         * "confirmed" all 40 institutions in the first test — a 100% hit rate
         * that was 100% false. Only the jobs API distinguishes them. */
        if (provider.id === 'workday') {
          attempted.push(`workday:${tenant}/wd${provider.dcOf(url)}`);
          const hit = await probeWorkday(tenant, provider.dcOf(url), null, entry.name);
          if (!hit || hit.mismatch || !hit.total_jobs) continue;
          return {
            provider: 'workday',
            tenant,
            url: `https://${hit.host}/${hit.site}`,
            workday_site: hit.site,
            total_jobs: hit.total_jobs,
            confidence: 'feed_verified',
            probes_used: attempted.length
          };
        }

        if (provider.dns) {
          attempted.push(`dns:${hostname}`);
          if (!await resolves(hostname)) continue;
        }
        const alive = await httpAlive(url);
        attempted.push(`http:${url}`);
        if (!alive) continue;
        const mention = pageMentions(alive.body, entry.name);
        return {
          provider: provider.id,
          tenant,
          url: alive.url,
          http_status: alive.status,
          name_tokens_on_page: mention.tokens,
          name_token_hits: mention.hits,
          // The honest label: found by guessing, not by reading their site.
          confidence: mention.hits >= 2 ? 'corroborated' : (provider.dns ? 'dns_exact' : 'weak'),
          probes_used: attempted.length
        };
      }
    }
  }
  return { provider: null, probes_used: attempted.length };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const limit = arg('--limit') ? Number(arg('--limit')) : null;
  const outPath = arg('--out') ? path.resolve(arg('--out')) : OUT_PATH;
  let shardIndex = 0;
  let shardCount = 1;
  if (arg('--shard')) {
    [shardIndex, shardCount] = arg('--shard').split('/').map(Number);
    if (!(shardCount > 0) || !(shardIndex >= 0 && shardIndex < shardCount)) {
      console.error('--shard must look like I/N with 0 <= I < N');
      return 1;
    }
  }

  const discovery = JSON.parse(await fsp.readFile(DISCOVERY_PATH, 'utf8')).employers;
  const employers = JSON.parse(await fsp.readFile(EMPLOYERS_PATH, 'utf8'));
  const registry = Array.isArray(employers) ? employers : (employers.employers || []);
  const have = new Set(registry.map((e) => norm(e.name)));

  const pool = [];
  for (const entry of Object.values(discovery)) {
    if ((entry.ats || []).length) continue;      // already has a feed
    if (have.has(norm(entry.name))) continue;    // already in the registry
    pool.push({ name: entry.name, website: entry.website || null, origin: 'college' });
  }
  try {
    const nonprofits = JSON.parse(await fsp.readFile(NONPROFIT_PATH, 'utf8')).websites || {};
    for (const record of Object.values(nonprofits)) {
      if (!record.website || have.has(norm(record.name))) continue;
      pool.push({ name: record.name, website: record.website, origin: 'nonprofit' });
    }
  } catch { /* nonprofit websites are optional input */ }

  let todo = pool;
  if (limit) todo = todo.slice(0, limit);
  const total = todo.length;
  if (shardCount > 1) todo = todo.filter((_, i) => i % shardCount === shardIndex);

  console.log(`pool ${total} · shard ${shardIndex}/${shardCount} · this worker: ${todo.length} · ${WORKERS} concurrent`);

  const results = {};
  let done = 0;
  let found = 0;
  const byProvider = {};

  const save = async () => {
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, `${JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      shard: shardCount > 1 ? `${shardIndex}/${shardCount}` : null,
      found,
      by_provider: byProvider,
      candidates: results
    }, null, 1)}\n`, 'utf8');
  };

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(WORKERS, todo.length) }, async () => {
    while (next < todo.length) {
      const entry = todo[next];
      next += 1;
      let hit = null;
      try { hit = await probeInstitution(entry); } catch { hit = null; }
      done += 1;
      if (hit?.provider) {
        found += 1;
        byProvider[hit.provider] = (byProvider[hit.provider] || 0) + 1;
        results[norm(entry.name)] = { name: entry.name, website: entry.website, origin: entry.origin, ...hit };
      }
      if (done % SAVE_EVERY === 0) {
        await save();
        console.log(`  ${done}/${todo.length} probed · ${found} candidates · ${JSON.stringify(byProvider)}`);
      }
    }
  }));

  await save();
  console.log(`\ncandidates found: ${found} of ${todo.length} (${(100 * found / Math.max(1, todo.length)).toFixed(1)}%)`);
  console.log(`by provider: ${JSON.stringify(byProvider)}`);
  const corroborated = Object.values(results).filter((r) => r.confidence === 'corroborated').length;
  console.log(`corroborated by name on the page: ${corroborated} · needing promotion's check: ${found - corroborated}`);
  console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
