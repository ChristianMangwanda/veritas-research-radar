'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertSupabaseTargetUrl,
  validateTargetManifest
} = require('../radar/scripts/lib/supabase-target.js');
const { parseArgs, verifyRepository } = require('../radar/scripts/verify-supabase-target.js');

const TARGET = {
  schema_version: 1,
  purpose: 'production',
  account_alias: 'test-account',
  organization_id: 'fumzfqcbsigsveqwupxf',
  project_name: 'veritas-radar',
  project_ref: 'nawbdsujjysugaisczta',
  project_url: 'https://nawbdsujjysugaisczta.supabase.co'
};

function writeFixture({
  link,
  currentLink,
  currentActiveBranch = currentLink,
  currentBranchIsDefault = currentActiveBranch === currentLink,
  currentOrganizationId = TARGET.organization_id,
  cacheRef = TARGET.project_ref,
  mcpRef = TARGET.project_ref
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veritas-target-test-'));
  fs.mkdirSync(path.join(root, 'supabase', '.temp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'radar', 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'supabase', 'target.json'), `${JSON.stringify(TARGET)}\n`);
  fs.writeFileSync(path.join(root, '.mcp.json'), `${JSON.stringify({
    mcpServers: {
      supabase: { url: `https://mcp.supabase.com/mcp?project_ref=${mcpRef}` }
    }
  })}\n`);
  fs.writeFileSync(
    path.join(root, 'radar', 'public', 'app.js'),
    `const SUPABASE_URL = '${TARGET.project_url}';\n`
  );
  if (link !== undefined) {
    fs.writeFileSync(path.join(root, 'supabase', '.temp', 'project-ref'), `${link}\n`);
  }
  if (currentLink !== undefined) {
    fs.mkdirSync(path.join(root, '.supabase'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.supabase', 'project.json'),
      `${JSON.stringify({
        project: {
          ref: currentLink,
          name: TARGET.project_name,
          organization_id: currentOrganizationId,
          organization_slug: 'test-org'
        },
        active_branch: {
          ref: currentActiveBranch,
          name: currentBranchIsDefault ? 'Production' : 'Preview',
          is_default: currentBranchIsDefault
        },
        fetchedAt: '2026-08-30T00:00:00.000Z',
        versions: {}
      })}\n`
    );
  }
  if (cacheRef !== null) {
    fs.writeFileSync(path.join(root, 'supabase', '.temp', 'linked-project.json'), `${JSON.stringify({ project_ref: cacheRef })}\n`);
  }
  return root;
}

function withFixture(options, run) {
  const root = writeFixture(options);
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testTargetUrl() {
  assert.strictEqual(assertSupabaseTargetUrl(TARGET.project_url, TARGET), TARGET.project_url);
  assert.throws(
    () => assertSupabaseTargetUrl('https://cmvhimireghzpyzxzyjs.supabase.co', TARGET),
    /must target exactly/
  );
  assert.throws(
    () => assertSupabaseTargetUrl(`${TARGET.project_url}/rest/v1`, TARGET),
    /must target exactly/
  );
  assert.throws(() => assertSupabaseTargetUrl('', TARGET), /required/);
}

function testManifestValidation() {
  assert.strictEqual(validateTargetManifest(TARGET).project_ref, TARGET.project_ref);
  assert.throws(
    () => validateTargetManifest({ ...TARGET, project_url: 'https://example.com' }),
    /must target exactly/
  );
  assert.throws(
    () => validateTargetManifest({ ...TARGET, schema_version: 2 }),
    /schema_version/
  );
}

function testRepositoryVerification() {
  withFixture({ cacheRef: 'cmvhimireghzpyzxzyjs' }, (root) => {
    const result = verifyRepository({ root }, {});
    assert.strictEqual(result.ok, true, 'an absent link and stale telemetry cache are non-authoritative');
    assert(result.checks.some((check) => check.status === 'warn' && check.name === 'CLI telemetry cache'));
  });

  withFixture({ link: TARGET.project_ref }, (root) => {
    const result = verifyRepository(
      { root, requireLink: true, requireUrl: true },
      { SUPABASE_URL: TARGET.project_url, SUPABASE_PROJECT_ID: TARGET.project_ref }
    );
    assert.strictEqual(result.ok, true);
  });

  withFixture({ currentLink: TARGET.project_ref }, (root) => {
    const result = verifyRepository({ root, requireLink: true }, {});
    assert.strictEqual(result.ok, true, 'the current CLI project.json link is recognized');
  });

  withFixture({ currentLink: TARGET.project_ref, currentActiveBranch: 'previewbranchref00001' }, (root) => {
    const result = verifyRepository({ root, requireLink: true }, {});
    assert.strictEqual(result.ok, false, 'a preview branch cannot satisfy the production target');
    assert(result.checks.some((check) => (
      check.name === 'current CLI project link'
      && check.status === 'fail'
      && /active branch/.test(check.detail)
    )));
  });

  withFixture({
    currentLink: TARGET.project_ref,
    currentActiveBranch: TARGET.project_ref,
    currentBranchIsDefault: false
  }, (root) => {
    const result = verifyRepository({ root, requireLink: true }, {});
    assert.strictEqual(result.ok, false, 'production operations require the default branch');
  });

  withFixture({ currentLink: TARGET.project_ref, currentOrganizationId: 'wrongorganizationid00' }, (root) => {
    const result = verifyRepository({ root, requireLink: true }, {});
    assert.strictEqual(result.ok, false, 'the linked project must belong to the pinned organization');
  });

  withFixture({ link: TARGET.project_ref, currentLink: 'cmvhimireghzpyzxzyjs' }, (root) => {
    const result = verifyRepository({ root, requireLink: true }, {});
    assert.strictEqual(result.ok, false, 'conflicting legacy/current link markers fail closed');
  });

  withFixture({ link: TARGET.project_ref }, (root) => {
    const result = verifyRepository(
      { root, requireLink: true },
      { SUPABASE_DB_URL: 'value-is-intentionally-hidden' }
    );
    assert.strictEqual(result.ok, false, 'a direct database URL can bypass the verified CLI link');
    const check = result.checks.find((item) => item.name === 'SUPABASE_DB_URL override');
    assert.strictEqual(check.status, 'fail');
    assert(!JSON.stringify(result).includes('value-is-intentionally-hidden'));
  });

  withFixture({}, (root) => {
    const result = verifyRepository({ root, requireLink: true }, {});
    assert.strictEqual(result.ok, false);
    assert(result.checks.some((check) => check.status === 'fail' && check.name === 'CLI project link'));
  });

  withFixture({ link: 'cmvhimireghzpyzxzyjs' }, (root) => {
    const result = verifyRepository({ root }, {});
    assert.strictEqual(result.ok, false);
  });

  withFixture({}, (root) => {
    const result = verifyRepository(
      { root, requireUrl: true },
      { SUPABASE_URL: 'https://cmvhimireghzpyzxzyjs.supabase.co' }
    );
    assert.strictEqual(result.ok, false);
    assert(result.checks.some((check) => check.name === 'SUPABASE_URL' && check.status === 'fail'));
  });

  withFixture({}, (root) => {
    fs.writeFileSync(
      path.join(root, 'radar', 'public', 'app.js'),
      "const SUPABASE_URL = 'https://cmvhimireghzpyzxzyjs.supabase.co';\n"
    );
    const result = verifyRepository({ root }, {});
    assert.strictEqual(result.ok, false);
    assert(result.checks.some((check) => check.name === 'browser project URL' && check.status === 'fail'));
  });
}

function testArguments() {
  assert.deepStrictEqual(parseArgs(['--require-link', '--require-url', '--json']).requireLink, true);
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
  assert.throws(() => parseArgs(['--root']), /requires a path/);
}

function testOwnerRlsMigration() {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'radar', 'supabase', 'owner-rls.sql'),
    'utf8'
  );

  assert.match(sql, /if profile_count <> 1 then/i);
  assert.match(sql, /if owner_count <> 1 or not owner_matches_profile then/i);
  assert.match(sql, /create schema if not exists radar_private/i);
  assert.doesNotMatch(sql, /create or replace function public\.is_radar_owner/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(
    sql,
    /revoke all on function radar_private\.is_radar_owner\(\) from public, anon, authenticated, service_role/i
  );
  assert.match(
    sql,
    /grant execute on function radar_private\.is_radar_owner\(\) to authenticated/i
  );
  assert.match(
    sql,
    /revoke all on table public\.radar_owners from public, anon, authenticated, service_role/i
  );
  assert.doesNotMatch(sql, /\b(?:using|with check)\s*\(\s*true\s*\)/i);

  const createdPolicies = [...sql.matchAll(/create policy "([^"]+)"/gi)].map((match) => match[1]);
  assert(createdPolicies.length > 0, 'owner migration must create RLS policies');
  for (const policy of createdPolicies) {
    assert(
      sql.includes(`drop policy if exists "${policy}"`),
      `owner migration must be safe to rerun: missing drop for ${policy}`
    );
  }

  const policyStatements = [...sql.matchAll(/create policy "[^"]+"[\s\S]*?;/gi)];
  assert.strictEqual(policyStatements.length, createdPolicies.length);
  for (const [statement] of policyStatements) {
    assert.match(statement, /\(select radar_private\.is_radar_owner\(\)\)/i);
  }
}

function testBootstrapCannotDowngradeOwnerRls() {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'radar', 'supabase', 'auth.sql'),
    'utf8'
  );

  assert.match(
    sql,
    /if pg_catalog\.to_regclass\('public\.radar_owners'\) is not null then[\s\S]*?raise exception/i
  );
  assert.doesNotMatch(sql, /\b(?:using|with check)\s*\(\s*true\s*\)/i);

  const policyStatements = [...sql.matchAll(/create policy "[^"]+"[\s\S]*?;/gi)];
  assert(policyStatements.length > 0, 'bootstrap must create transitional RLS policies');
  for (const [statement] of policyStatements) {
    assert.match(
      statement,
      /pg_catalog\.to_regclass\('public\.radar_owners'\) is null/i,
      'every bootstrap policy must disable itself after owner RLS is installed'
    );
  }

  assert.match(
    sql,
    /grant select, insert, update on public\.profile_documents to service_role/i
  );
  assert.match(
    sql,
    /grant select, insert, update, delete on public\.match_cache to service_role/i
  );
  assert.match(sql, /grant select, insert, update on public\.triage to service_role/i);
  assert.match(sql, /grant select, insert, update on public\.user_state to service_role/i);
}

function testPublicSchemaGrants() {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'radar', 'supabase', 'schema.sql'),
    'utf8'
  );

  assert.match(sql, /grant select on public\.jobs to anon, authenticated/i);
  assert.match(sql, /grant select on public\.refresh_runs to anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on public\.jobs to service_role/i);
  assert.match(sql, /grant select, insert on public\.refresh_runs to service_role/i);
  assert.match(
    sql,
    /grant usage, select on sequence public\.refresh_runs_id_seq to service_role/i
  );
}

function main() {
  testTargetUrl();
  testManifestValidation();
  testRepositoryVerification();
  testArguments();
  testOwnerRlsMigration();
  testBootstrapCannotDowngradeOwnerRls();
  testPublicSchemaGrants();
  console.log('Supabase target tests passed');
}

main();
