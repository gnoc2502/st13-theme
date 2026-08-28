/**
 * Bunny Storage helper — production only.
 *
 * Not used by the local prototype (which serves files from disk).
 * BE dev should import this from server.js when replacing /files/* with CDN.
 *
 * Usage:
 *   const { uploadToBunny, deleteFromBunny, cdnUrl } = require('./bunny');
 *   await uploadToBunny('themes/dragon_ball/v3/bundle.zip', buffer, 'application/zip');
 *   const publicUrl = cdnUrl('themes/dragon_ball/v3/bundle.zip');
 */

const STORAGE = process.env.BUNNY_STORAGE_ENDPOINT || 'https://sg.storage.bunnycdn.com';
const ZONE = process.env.BUNNY_STORAGE_ZONE;
const KEY = process.env.BUNNY_STORAGE_KEY;
const PULL_ZONE_URL = process.env.BUNNY_PULL_ZONE_URL;

function assertConfigured() {
  if (!ZONE || !KEY || !PULL_ZONE_URL) {
    throw new Error(
      'Bunny not configured. Set BUNNY_STORAGE_ZONE, BUNNY_STORAGE_KEY, BUNNY_PULL_ZONE_URL in .env',
    );
  }
}

/** Upload buffer to Bunny Storage at the given path. Retries 3 times on 5xx. */
async function uploadToBunny(path, buffer, contentType, attempt = 1) {
  assertConfigured();
  const url = `${STORAGE}/${ZONE}/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { AccessKey: KEY, 'Content-Type': contentType },
    body: buffer,
  });
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  if (res.status >= 500 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 500 * attempt));
    return uploadToBunny(path, buffer, contentType, attempt + 1);
  }
  throw new Error(`Bunny PUT ${path} failed: ${res.status} ${body}`);
}

/** Delete file. Idempotent — 404 is treated as success. */
async function deleteFromBunny(path) {
  assertConfigured();
  const url = `${STORAGE}/${ZONE}/${path}`;
  const res = await fetch(url, { method: 'DELETE', headers: { AccessKey: KEY } });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Bunny DELETE ${path} failed: ${res.status}`);
  }
}

/** List directory contents. Returns array of { ObjectName, Length, LastChanged, IsDirectory, ... }. */
async function listBunny(dir) {
  assertConfigured();
  const url = `${STORAGE}/${ZONE}/${dir.endsWith('/') ? dir : dir + '/'}`;
  const res = await fetch(url, { headers: { AccessKey: KEY } });
  if (!res.ok) throw new Error(`Bunny LIST ${dir} failed: ${res.status}`);
  return res.json();
}

/** Compose the public CDN URL for a stored path. */
function cdnUrl(path) {
  assertConfigured();
  return `${PULL_ZONE_URL}/${path}`;
}

/** Delete old bundle versions per retention policy (keep last N). */
async function purgeOldVersions(themeId, currentVersion, keep = 3) {
  const cutoff = currentVersion - keep;
  for (let v = 1; v <= cutoff; v++) {
    const base = `themes/${themeId}/v${v}`;
    await Promise.all([
      deleteFromBunny(`${base}/bundle.zip`).catch(() => {}),
      deleteFromBunny(`${base}/preview.webp`).catch(() => {}),
      deleteFromBunny(`${base}/preview.png`).catch(() => {}),
      deleteFromBunny(`${base}/preview.jpg`).catch(() => {}),
    ]);
  }
}

module.exports = { uploadToBunny, deleteFromBunny, listBunny, cdnUrl, purgeOldVersions };
