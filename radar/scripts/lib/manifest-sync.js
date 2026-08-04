'use strict';

/**
 * Keeps radar/data/resumes/manifest.json in step with the files on disk.
 *
 * The rule this enforces: a resume file that exists is a variant that ranks.
 * Before this, a newly dropped resume was silently ignored — the manifest was
 * non-empty and valid, so the scaffold never re-ran and the build cheerfully
 * reported the old variant count. Silence is the worst failure mode here,
 * because nothing in the dashboard looks wrong.
 *
 * A file going missing is NOT treated as a deletion: the variant is reported
 * and skipped for this build, so a moved/renamed file degrades to "one
 * variant less" instead of failing the whole profile.
 */

const path = require('path');

const RESUME_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx'];

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'variant';
}

function isResumeFile(name) {
  return !name.startsWith('.') && RESUME_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

function labelFromFile(file) {
  return path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ').trim() || 'Resume';
}

function uniqueId(base, taken) {
  let id = base;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${base.slice(0, 21)}-${suffix}`;
    suffix += 1;
  }
  return id;
}

/**
 * @param {object|null} manifest  parsed manifest.json (null/invalid -> rebuilt)
 * @param {string[]} filesOnDisk  raw directory listing
 * @returns {{manifest: object, added: object[], missing: object[], changed: boolean}}
 *   `added` entries carry intent '' — the caller fills it (model-inferred,
 *   falling back to the label) so validation always has something to pass on.
 */
function syncManifest(manifest, filesOnDisk) {
  const base = manifest && Array.isArray(manifest.variants)
    ? { ...manifest, schema_version: 1, variants: [...manifest.variants] }
    : { schema_version: 1, variants: [] };

  const files = filesOnDisk.filter(isResumeFile).sort();
  const registered = new Set(base.variants.map((variant) => variant && variant.file));
  const taken = new Set(base.variants.map((variant) => variant && variant.id).filter(Boolean));

  const added = [];
  for (const file of files) {
    if (registered.has(file)) continue;
    const variant = {
      id: uniqueId(slugify(file), taken),
      label: labelFromFile(file),
      file,
      intent: '',
      intent_source: 'auto'
    };
    taken.add(variant.id);
    base.variants.push(variant);
    added.push(variant);
  }

  const onDisk = new Set(files);
  const missing = base.variants.filter((variant) => variant && !onDisk.has(variant.file));

  return { manifest: base, added, missing, changed: added.length > 0 };
}

module.exports = { syncManifest, slugify, isResumeFile, labelFromFile, RESUME_EXTENSIONS };
