#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_REPO_ROOT,
  assertSupabaseTargetUrl,
  loadTargetManifest,
  projectRefFromMcpConfig,
  readJson
} = require('./lib/supabase-target.js');

function parseArgs(argv) {
  const options = {
    json: false,
    requireLink: false,
    requireUrl: false,
    root: DEFAULT_REPO_ROOT
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--require-link') options.requireLink = true;
    else if (arg === '--require-url') options.requireUrl = true;
    else if (arg === '--root') {
      index += 1;
      if (!argv[index]) throw new Error('--root requires a path');
      options.root = path.resolve(argv[index]);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function verifyRepository(options = {}, environment = process.env) {
  const root = path.resolve(options.root || DEFAULT_REPO_ROOT);
  const checks = [];
  let target;

  const add = (status, name, detail) => checks.push({ status, name, detail });
  const capture = (name, fn) => {
    try {
      const detail = fn();
      add('pass', name, detail);
      return detail;
    } catch (error) {
      add('fail', name, error.message);
      return undefined;
    }
  };

  try {
    target = loadTargetManifest(root);
    add('pass', 'target manifest', `${target.project_name} (${target.project_ref})`);
  } catch (error) {
    add('fail', 'target manifest', error.message);
  }

  if (!target) {
    return { ok: false, target: null, checks };
  }

  capture('MCP project ref', () => {
    const config = readJson(path.join(root, '.mcp.json'), '.mcp.json');
    const actual = projectRefFromMcpConfig(config);
    if (actual !== target.project_ref) {
      throw new Error(`MCP points to ${actual}; expected ${target.project_ref}`);
    }
    return actual;
  });

  capture('browser project URL', () => {
    const appPath = path.join(root, 'radar', 'public', 'app.js');
    const source = fs.readFileSync(appPath, 'utf8');
    const match = source.match(/\bconst\s+SUPABASE_URL\s*=\s*(['"])([^'"]+)\1\s*;/);
    if (!match) throw new Error('radar/public/app.js has no static SUPABASE_URL');
    return assertSupabaseTargetUrl(match[2], target);
  });

  // Supabase has two active CLI state layouts during its CLI rewrite. The
  // installed legacy command path uses supabase/.temp/project-ref, while the
  // current CLI writes .supabase/project.json. A disagreement in either known
  // marker is unsafe even if the other CLI generation would ignore it.
  let linkMarkers = 0;
  const legacyLinkPath = path.join(root, 'supabase', '.temp', 'project-ref');
  if (fs.existsSync(legacyLinkPath)) {
    linkMarkers += 1;
    capture('legacy CLI project link', () => {
      const actual = fs.readFileSync(legacyLinkPath, 'utf8').trim();
      if (actual !== target.project_ref) {
        throw new Error(`legacy CLI link is ${actual || '(empty)'}; expected ${target.project_ref}`);
      }
      return actual;
    });
  }

  const currentLinkPath = path.join(root, '.supabase', 'project.json');
  if (fs.existsSync(currentLinkPath)) {
    linkMarkers += 1;
    capture('current CLI project link', () => {
      const value = readJson(currentLinkPath, 'current Supabase CLI project link');
      // CLI 2.109+ records the parent project and active branch separately. A
      // preview branch can have the right project.ref but target another
      // database, so production verification must validate both identities.
      const structured = value.project && typeof value.project === 'object';
      const actual = value.project?.ref || value.ref || value.project_ref;
      const activeBranch = value.active_branch?.ref;
      if (actual !== target.project_ref) {
        throw new Error(`current CLI project is ${actual || '(missing)'}; expected ${target.project_ref}`);
      }
      if (structured && value.project.organization_id !== target.organization_id) {
        throw new Error(
          `current CLI organization is ${value.project.organization_id || '(missing)'}; expected ${target.organization_id}`
        );
      }
      if (structured && !activeBranch) {
        throw new Error('current CLI link has no active_branch.ref');
      }
      if (activeBranch && activeBranch !== target.project_ref) {
        throw new Error(`current CLI active branch is ${activeBranch}; expected ${target.project_ref}`);
      }
      if (structured && value.active_branch.is_default !== true) {
        throw new Error('current CLI active branch is not the default production branch');
      }
      return activeBranch ? `${actual} (active ${activeBranch})` : actual;
    });
  }

  if (linkMarkers === 0) {
    add(
      options.requireLink ? 'fail' : 'info',
      'CLI project link',
      'both supabase/.temp/project-ref and .supabase/project.json are absent; this checkout is not linked'
    );
  }

  const cachePath = path.join(root, 'supabase', '.temp', 'linked-project.json');
  if (fs.existsSync(cachePath)) {
    try {
      const cache = readJson(cachePath, 'Supabase linked-project cache');
      const cachedRef = cache.project_ref || cache.ref;
      if (cachedRef && cachedRef !== target.project_ref) {
        add('warn', 'CLI telemetry cache', `stale cache names ${cachedRef}; it is not the authoritative CLI link`);
      } else {
        add('pass', 'CLI telemetry cache', cachedRef || 'present without a project ref');
      }
    } catch (error) {
      add('warn', 'CLI telemetry cache', error.message);
    }
  } else {
    add('info', 'CLI telemetry cache', 'absent');
  }

  if (environment.SUPABASE_URL) {
    capture('SUPABASE_URL', () => assertSupabaseTargetUrl(environment.SUPABASE_URL, target));
  } else if (options.requireUrl) {
    add('fail', 'SUPABASE_URL', 'required but not set');
  } else {
    add('info', 'SUPABASE_URL', 'not set');
  }

  if (environment.SUPABASE_PROJECT_ID) {
    if (environment.SUPABASE_PROJECT_ID === target.project_ref) {
      add('pass', 'SUPABASE_PROJECT_ID', target.project_ref);
    } else {
      add('fail', 'SUPABASE_PROJECT_ID', `points to ${environment.SUPABASE_PROJECT_ID}; expected ${target.project_ref}`);
    }
  } else {
    add('info', 'SUPABASE_PROJECT_ID', 'not set');
  }

  for (const name of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROFILE', 'SUPABASE_WORKDIR', 'SUPABASE_DB_URL']) {
    let status = environment[name] ? 'warn' : 'info';
    if (options.requireLink && environment[name] && ['SUPABASE_WORKDIR', 'SUPABASE_DB_URL'].includes(name)) {
      status = 'fail';
    }
    add(status, `${name} override`, environment[name] ? 'set (value hidden)' : 'not set');
  }

  return {
    ok: !checks.some((check) => check.status === 'fail'),
    target: {
      account_alias: target.account_alias,
      organization_id: target.organization_id,
      project_name: target.project_name,
      project_ref: target.project_ref,
      project_url: target.project_url
    },
    checks
  };
}

function printResult(result, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const symbols = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' };
  for (const check of result.checks) {
    process.stdout.write(`[${symbols[check.status]}] ${check.name}: ${check.detail}\n`);
  }
  process.stdout.write(result.ok ? 'Supabase target verification passed.\n' : 'Supabase target verification failed.\n');
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  const result = verifyRepository(options);
  printResult(result, options.json);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, parseArgs, printResult, verifyRepository };
