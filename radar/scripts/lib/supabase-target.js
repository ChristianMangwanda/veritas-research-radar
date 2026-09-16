'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_TARGET_VALUE = require('../../../supabase/target.json');

function readJson(filePath, label = filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error.message}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse ${label}: ${error.message}`);
  }
}

function expectedProjectOrigin(projectRef) {
  if (!PROJECT_REF_PATTERN.test(String(projectRef || ''))) {
    throw new Error('Supabase target project_ref must be 20 lowercase letters or digits');
  }
  return `https://${projectRef}.supabase.co`;
}

function assertSupabaseTargetUrl(rawUrl, target) {
  const projectRef = typeof target === 'string' ? target : target?.project_ref;
  const expectedOrigin = expectedProjectOrigin(projectRef);

  if (!rawUrl) {
    throw new Error('SUPABASE_URL is required');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('SUPABASE_URL must be a valid URL');
  }

  const hasUnexpectedParts = parsed.username
    || parsed.password
    || parsed.port
    || (parsed.pathname && parsed.pathname !== '/')
    || parsed.search
    || parsed.hash;

  if (parsed.protocol !== 'https:' || parsed.origin !== expectedOrigin || hasUnexpectedParts) {
    throw new Error(`SUPABASE_URL must target exactly ${expectedOrigin}`);
  }

  return expectedOrigin;
}

function normalizeSupabaseUserId(value, name = 'RADAR_OWNER_USER_ID') {
  const userId = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(userId) || userId === NIL_UUID) {
    throw new Error(`${name} must be a valid user UUID`);
  }
  return userId;
}

function validateTargetManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Supabase target manifest must be a JSON object');
  }
  if (value.schema_version !== 1) {
    throw new Error('Unsupported Supabase target manifest schema_version');
  }

  for (const key of ['purpose', 'account_alias', 'organization_id', 'project_name', 'project_ref', 'project_url']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      throw new Error(`Supabase target manifest is missing ${key}`);
    }
  }

  if (!PROJECT_REF_PATTERN.test(value.organization_id)) {
    throw new Error('Supabase target organization_id must be 20 lowercase letters or digits');
  }

  const normalizedUrl = assertSupabaseTargetUrl(value.project_url, value.project_ref);
  if (value.project_url !== normalizedUrl) {
    throw new Error(`Supabase target project_url must be exactly ${normalizedUrl}`);
  }

  return Object.freeze({ ...value });
}

function loadTargetManifest(repoRoot = DEFAULT_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  if (resolvedRoot === DEFAULT_REPO_ROOT) {
    return validateTargetManifest(DEFAULT_TARGET_VALUE);
  }
  const filePath = path.join(resolvedRoot, 'supabase', 'target.json');
  return validateTargetManifest(readJson(filePath, 'Supabase target manifest'));
}

function projectRefFromMcpConfig(config) {
  const rawUrl = config?.mcpServers?.supabase?.url;
  if (typeof rawUrl !== 'string') {
    throw new Error('.mcp.json is missing mcpServers.supabase.url');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('.mcp.json Supabase URL is invalid');
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'mcp.supabase.com' || parsed.pathname !== '/mcp') {
    throw new Error('.mcp.json must use the hosted Supabase MCP endpoint');
  }

  const projectRef = parsed.searchParams.get('project_ref');
  if (!PROJECT_REF_PATTERN.test(String(projectRef || ''))) {
    throw new Error('.mcp.json is missing a valid project_ref');
  }
  return projectRef;
}

module.exports = {
  DEFAULT_REPO_ROOT,
  PROJECT_REF_PATTERN,
  assertSupabaseTargetUrl,
  expectedProjectOrigin,
  loadTargetManifest,
  normalizeSupabaseUserId,
  projectRefFromMcpConfig,
  readJson,
  validateTargetManifest
};
