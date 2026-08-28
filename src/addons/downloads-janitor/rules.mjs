import path from 'node:path';

/**
 * Categorisation, age bucketing, and pattern matching (spec §6.2).
 *
 * Everything here is pure: no filesystem access, no config reads. That keeps it directly
 * testable and keeps the decision of *what* a file is separate from the decision of what
 * to do about it.
 */

export const DEFAULT_CATEGORIES = {
  images: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp'],
  video: ['mp4', 'mkv', 'webm', '3gp', 'mov', 'avi'],
  audio: ['mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav', 'aac'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub', 'csv', 'md'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst'],
  apk: ['apk', 'apks', 'xapk', 'apkm', 'obb']
};

export const OTHER = 'other';

export const AGE_BUCKETS = ['<7d', '7-30d', '30-90d', '>90d'];

/**
 * Build an extension -> category lookup from the defaults plus the user's overrides.
 * A user mapping wins: `{"ebooks": ["epub"]}` moves epub out of documents rather than
 * listing it in both.
 */
export function buildCategoryMap(overrides = {}) {
  const map = new Map();
  for (const [category, exts] of Object.entries(DEFAULT_CATEGORIES)) {
    for (const ext of exts) map.set(ext.toLowerCase(), category);
  }
  for (const [category, exts] of Object.entries(overrides)) {
    if (!Array.isArray(exts)) continue;
    for (const ext of exts) map.set(String(ext).toLowerCase().replace(/^\./, ''), category);
  }
  return map;
}

/** All category names currently in play, so a summary can report zeroes too. */
export function categoryNames(overrides = {}) {
  return [...new Set([...Object.keys(DEFAULT_CATEGORIES), ...Object.keys(overrides), OTHER])];
}

/**
 * `foo.tar.gz` is an archive, not whatever `.gz` alone would suggest, so multi-part
 * archive extensions are checked before the plain last-extension lookup.
 */
export function categorize(filename, categoryMap) {
  const name = path.basename(filename).toLowerCase();
  if (/\.tar(\.[a-z0-9]+)?$/.test(name)) return categoryMap.get('tar') ?? 'archives';
  const ext = path.extname(name).slice(1);
  if (!ext) return OTHER;
  return categoryMap.get(ext) ?? OTHER;
}

export function ageBucket(mtimeMs, now = Date.now()) {
  const days = (now - mtimeMs) / 86_400_000;
  if (days < 7) return '<7d';
  if (days < 30) return '7-30d';
  if (days < 90) return '30-90d';
  return '>90d';
}

/**
 * Translate a shell-style glob into a RegExp.
 *
 * Matching is case-insensitive on purpose: /storage/emulated/0 is case-insensitive-ish
 * (spec §2), so a `protect: ["*.PDF"]` that failed to match `invoice.pdf` would be a
 * safety hole rather than a curiosity.
 */
export function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i');
}

/**
 * A pattern containing a slash is matched against the path relative to the root;
 * otherwise against the basename, which is what a user writing `invoice*` means.
 */
export function matchesPattern(pattern, relPath) {
  const re = globToRegExp(pattern);
  return String(pattern).includes('/') ? re.test(relPath) : re.test(path.basename(relPath));
}

export function matchesAny(patterns, relPath) {
  return (patterns ?? []).some((p) => matchesPattern(p, relPath));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${bytes < 0 ? '-' : ''}${rounded} ${units[unit]}`;
}
