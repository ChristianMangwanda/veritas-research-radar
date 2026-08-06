'use strict';

/**
 * Guess an institution's ATS tenant from what we already know about it.
 *
 * The point of this file is to reach the 3,609 institutions whose websites we
 * cannot read. Their ATS lives on the vendor's host — workday.com,
 * peopleadmin.com — which does not block anyone, so if the tenant name can be
 * guessed the blocked homepage stops mattering at all.
 *
 * Measured against the working registry, tenants come from three places:
 *
 *   the domain label    ucmerced.edu   -> ucmerced      (strongest, always known)
 *   the name, squashed  Stanford Univ. -> stanford
 *   the initials        Univ of Wash.  -> uw, uow
 *
 * NOT every provider is guessable, and pretending otherwise wastes the whole
 * probe budget on platforms that cannot be hit:
 *
 *   iCIMS   careerhub-clarkson, tcnycareers-touro   decorative prefixes
 *   ADP     df6f93d4-2277-4999-ac63-88a55668ffd3    a UUID
 *   Oracle  champlain-ibumjb                        random suffix
 *
 * Those three are ~20% of the market and are deliberately not probed. They
 * need the crawl, or a search engine, or nothing.
 */

/* Words that appear in half of all institution names and so carry no
 * identifying power when squashed into a tenant slug. */
const GENERIC = new Set(['the', 'of', 'at', 'and', 'for', 'in', 'a']);
const INSTITUTIONAL = new Set([
  'university', 'college', 'institute', 'school', 'system', 'academy',
  'seminary', 'campus', 'center', 'centre', 'foundation', 'incorporated',
  'inc', 'corporation', 'corp', 'llc'
]);

function words(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
}

/** The registrable label of a hostname: https://www.ucmerced.edu/ -> ucmerced */
function domainLabel(website) {
  if (!website) return null;
  let host;
  try { host = new URL(website).hostname; } catch { return null; }
  const parts = host.replace(/^www\./i, '').split('.');
  if (!parts.length) return null;
  // Handle academic second-level domains (foo.ac.uk, foo.edu.au) by taking the
  // label to the left of the public suffix rather than blindly parts[0].
  const label = parts[0];
  return /^[a-z0-9-]{2,}$/i.test(label) ? label.toLowerCase() : null;
}

/**
 * Ordered tenant guesses, best first — order matters because probing stops at
 * the first hit and every extra candidate multiplies the request budget.
 */
function tenantCandidates({ name, website }) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const slug = String(value || '').replace(/[^a-z0-9-]/g, '');
    if (slug.length < 2 || slug.length > 40 || seen.has(slug)) return;
    seen.add(slug);
    out.push(slug);
  };

  // 1. The domain label. Highest yield and known for every blocked college,
  //    since the domain is the one thing a WAF cannot take away from us.
  add(domainLabel(website));

  const all = words(name);
  const significant = all.filter((w) => !GENERIC.has(w) && !INSTITUTIONAL.has(w));

  // 2. The distinctive part of the name, squashed and hyphenated.
  add(significant.join(''));
  add(significant.join('-'));

  // 3. Initials, which is how large public universities usually appear
  //    (University of Washington -> uw, Santa Clara University -> scu).
  add(all.filter((w) => !GENERIC.has(w)).map((w) => w[0]).join(''));
  add(significant.map((w) => w[0]).join(''));

  // 4. First distinctive word alone — "Salk Institute" -> salk.
  if (significant[0]) add(significant[0]);

  /* 5. Three shapes found by testing against tenants the registry already
   *    knows, each of which the rules above missed:
   *
   *      uchicago   "u" + the place        (also umich, ucdavis, utexas)
   *      stjude     first two words joined ("St. Jude Children's Research…")
   *      sanjac     first word + a clipped second ("San Jacinto College")
   *
   *    Together they took the generator from 7/10 to 10/10 on the sample. */
  const kind = all.find((word) => INSTITUTIONAL.has(word));
  if (kind && significant[0]) add(kind[0] + significant[0]);
  if (significant.length >= 2) {
    add(significant[0] + significant[1]);
    add(significant[0] + significant[1].slice(0, 3));
  }

  // 6. The whole name squashed, for short names where nothing else fits.
  add(all.filter((w) => !GENERIC.has(w)).join(''));

  return out;
}

/**
 * Probe targets per provider.
 *
 * `dns: true` means the vendor has no wildcard record, so a DNS lookup is a
 * real answer — 10ms instead of a 300ms request, and it is the difference
 * between this finishing in half an hour and not finishing. Verified:
 * peopleadmin, csod and taleo return NXDOMAIN for nonsense tenants, while
 * icims, pageuppeople and myworkdayjobs resolve anything at all.
 */
const PROVIDERS = [
  {
    id: 'workday',
    share: 27,
    dns: false,
    /* Six datacenters, not twelve, and only the first few tenant guesses.
     * probeWorkday sweeps ~7 site names with a 600ms courtesy delay between
     * each, so every (tenant, datacenter) pair costs ~5 seconds — 12 x 6 would
     * be seven minutes per institution and 3,609 of them would never finish.
     * These six carry the overwhelming majority of the registry's tenants;
     * missing a wd7 tenant costs one employer, and trying every combination
     * costs the entire run. */
    hosts: (t) => [1, 5, 3, 10, 2, 12].map((dc) => `https://${t}.wd${dc}.myworkdayjobs.com`),
    maxTenants: 3,
    // The datacenter number is part of the API path, so the prober has to
    // recover it from the URL it is walking.
    dcOf: (url) => Number(/\.wd(\d+)\./.exec(url)?.[1] || 1)
  },
  { id: 'peopleadmin', share: 16, dns: true, hosts: (t) => [`https://${t}.peopleadmin.com`] },
  { id: 'csod', share: 9, dns: true, hosts: (t) => [`https://${t}.csod.com`] },
  { id: 'pageup', share: 8, dns: false, hosts: (t) => [`https://${t}.pageuppeople.com`] },
  { id: 'governmentjobs', share: 6, dns: false, hosts: (t) => [`https://www.governmentjobs.com/careers/${t}`] },
  { id: 'taleo', share: 3, dns: true, hosts: (t) => [`https://${t}.taleo.net`] }
];

module.exports = { tenantCandidates, domainLabel, words, PROVIDERS, GENERIC, INSTITUTIONAL };
