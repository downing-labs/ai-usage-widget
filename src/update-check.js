'use strict';

/**
 * Update checking. Pure helpers (unit-tested) plus one small fetch wrapper.
 * We only ever ask GitHub for the latest published release and compare version
 * numbers; nothing is downloaded or installed automatically.
 */

const OWNER = 'downing-labs';
const REPO = 'ai-usage-widget';
const LATEST_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const REQUEST_TIMEOUT_MS = 10000;

// "v1.2.3" / "1.2.3" / "1.2.3-rc.1" -> { core: [1,2,3], pre: 'rc.1' | '' } or null.
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(text || '').trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

function comparePre(a, b) {
  // A release outranks any pre-release of the same core version.
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d) return d < 0 ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1; // numeric identifiers sort before text ones
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

// True only when `remote` is strictly newer than `local`. Unparseable input is never "newer".
function isNewerVersion(remote, local) {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (r.core[i] !== l.core[i]) return r.core[i] > l.core[i];
  }
  return comparePre(r.pre, l.pre) > 0;
}

// Returns { version, url } when a newer release exists, or null. Throws on network/HTTP problems
// so the caller can log them; a 404 (private repo, or no releases yet) counts as "nothing newer".
async function checkForUpdate(currentVersion, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(LATEST_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `${REPO}/${currentVersion}` },
      signal: controller.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
    const release = await res.json();
    const tag = release && release.tag_name;
    if (release && !release.draft && !release.prerelease && isNewerVersion(tag, currentVersion)) {
      return { version: String(tag).replace(/^v/, ''), url: release.html_url || RELEASES_PAGE };
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { parseVersion, isNewerVersion, checkForUpdate, RELEASES_PAGE };
