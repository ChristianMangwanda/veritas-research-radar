'use strict';

/**
 * Load the repo-root .env into process.env, for scripts a human runs by hand.
 *
 * Deliberately NOT done inside lib/supabase.js. supabaseEnv() reads the
 * environment and only the environment, because refresh.js ends its sync by
 * deleting every row it did not just write — a run that silently picked up
 * credentials from a file on disk could mutate production while its author
 * believed they were working offline. Scripts that genuinely want the
 * convenience call this first and say so.
 *
 * Existing environment variables always win, so CI (which sets them properly)
 * is unaffected by whatever happens to be in a developer's file.
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.resolve(__dirname, '../../../.env');

function loadEnvFile(file = ENV_PATH) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];   // no .env is normal — CI has none
  }
  const loaded = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (process.env[name]) continue;              // the environment wins
    const value = rawValue.trim().replace(/^["']|["']$/g, '');
    if (!value) continue;
    process.env[name] = value;
    loaded.push(name);
  }
  return loaded;
}

module.exports = { loadEnvFile, ENV_PATH };
