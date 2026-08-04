'use strict';

/**
 * Is profile.json older than the resume files it was built from?
 *
 * mtime-based on purpose: a false positive (touched but unchanged file) costs
 * one all-cached rebuild — seconds, no model call — and self-heals because the
 * rebuild rewrites profile.json, refreshing its mtime. Content hashing here
 * would mean parsing PDFs on every check.
 *
 * Dotfiles are excluded: .extract-cache.json lives in the resumes dir and is
 * written mid-build, and .DS_Store churns on any Finder visit.
 */

const fs = require('fs');
const path = require('path');

function newestResumeMtime(resumesDir) {
  let newest = null;
  let names;
  try {
    names = fs.readdirSync(resumesDir);
  } catch {
    return null; // no resumes dir -> nothing to be stale against
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(resumesDir, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}

// -> { stale: boolean, reason: string }
function profileFreshness(resumesDir, profilePath) {
  const newest = newestResumeMtime(resumesDir);
  if (newest === null) return { stale: false, reason: 'no_resumes' };
  let profileStat;
  try {
    profileStat = fs.statSync(profilePath);
  } catch {
    return { stale: true, reason: 'no_profile' };
  }
  return profileStat.mtimeMs >= newest
    ? { stale: false, reason: 'fresh' }
    : { stale: true, reason: 'resumes_changed' };
}

module.exports = { profileFreshness, newestResumeMtime };
