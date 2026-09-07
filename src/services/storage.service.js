const fs = require('fs/promises');
const path = require('path');
const logger = require('../config/logger');

/**
 * File storage backed by a Railway volume.
 *
 * Railway sets RAILWAY_VOLUME_MOUNT_PATH automatically on any service with a
 * volume attached. STORAGE_PATH overrides it (useful locally or on other
 * hosts); otherwise we fall back to ./uploads so `npm run dev` works with no
 * configuration at all.
 *
 * Files are served back through GET /api/files/* (see files.routes.js), which
 * checks authentication and ownership. That is deliberate: KYC documents are
 * government ID images and must not sit behind a guessable public URL the way
 * they did on Supabase's getPublicUrl().
 */
const ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH
  || process.env.STORAGE_PATH
  || path.join(process.cwd(), 'uploads');

const URL_PREFIX = '/api/files';

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg':  '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
  'image/gif':  '.gif',
};

const MIME_BY_EXT = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
};

/**
 * Resolve a caller-supplied storage path inside ROOT, refusing anything that
 * escapes it (`../`, absolute paths, null bytes).
 */
function resolveInRoot(storagePath) {
  const raw = String(storagePath || '').replace(/\0/g, '');
  if (!raw.trim()) throw new Error('Storage path is required');

  // Reject anything anchored outside the volume rather than quietly rewriting
  // it: leading slash (/etc/passwd), Windows drive letter (C:\...), UNC (\\host).
  if (/^([/\\]|[A-Za-z]:)/.test(raw)) {
    throw new Error('Invalid storage path');
  }

  const full = path.resolve(ROOT, raw);
  const rootWithSep = path.resolve(ROOT) + path.sep;
  if (full !== path.resolve(ROOT) && !full.startsWith(rootWithSep)) {
    throw new Error('Invalid storage path');
  }
  return full;
}

/** Content type for a stored file, from its extension. */
function contentTypeFor(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Write a file and return the URL to serve it from.
 *
 * The extension comes from the mimetype, so `uploadFile('kyc/<id>/front', buf,
 * 'image/png')` stores `kyc/<id>/front.png` and returns
 * `/api/files/kyc/<id>/front.png`. Re-uploading in a different format removes
 * the old sibling so a stale `front.jpg` can't linger next to a new
 * `front.png`.
 */
async function uploadFile(storagePath, buffer, mimetype) {
  const ext = EXT_BY_MIME[String(mimetype || '').toLowerCase()];
  if (!ext) {
    throw Object.assign(
      new Error(`Unsupported file type "${mimetype}". Upload a JPEG, PNG, WebP, or GIF image.`),
      { status: 400 }
    );
  }

  const relative = `${String(storagePath).replace(/^\/+/, '')}${ext}`;
  const full = resolveInRoot(relative);

  await fs.mkdir(path.dirname(full), { recursive: true });

  // Drop same-name files with a different extension from a previous upload
  await removeSiblings(full);

  try {
    await fs.writeFile(full, buffer);
  } catch (err) {
    logger.error(`[storage] write failed for ${relative}: ${err.message}`);
    throw new Error(
      `Could not save the file. If this keeps happening, check that a Railway volume is mounted at ${ROOT}.`
    );
  }

  return `${URL_PREFIX}/${relative}`;
}

/** Remove files sharing a basename but with a different extension. */
async function removeSiblings(fullPath) {
  const dir = path.dirname(fullPath);
  const base = path.basename(fullPath, path.extname(fullPath));
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // directory is new — nothing to clean
  }
  await Promise.all(
    entries
      .filter(name => path.basename(name, path.extname(name)) === base
        && path.join(dir, name) !== fullPath)
      .map(name => fs.unlink(path.join(dir, name)).catch(() => {}))
  );
}

/**
 * Delete a stored file. Accepts either the raw storage path or the
 * `/api/files/...` URL that uploadFile returned. Missing files are not an
 * error — deleting something already gone is the desired end state.
 */
async function deleteFile(storagePath) {
  // Values here come from our own DB, so normalising the stored URL form
  // ("/api/files/kyc/…") back to a relative path is safe — resolveInRoot
  // still enforces containment on whatever is left.
  const relative = String(storagePath || '')
    .replace(`${URL_PREFIX}/`, '')
    .replace(/^\/+/, '');
  const full = resolveInRoot(relative);
  try {
    await fs.unlink(full);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error(`[storage] delete failed for ${relative}: ${err.message}`);
      throw new Error(`Storage delete failed: ${err.message}`);
    }
  }
}

/**
 * Read a stored file for serving. Returns null when it doesn't exist so the
 * route can answer 404 rather than 500.
 */
async function readFile(storagePath) {
  const full = resolveInRoot(storagePath);
  try {
    const buffer = await fs.readFile(full);
    return { buffer, contentType: contentTypeFor(full) };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
    throw err;
  }
}

/** Where files are being written — surfaced by the health check. */
function storageRoot() {
  return ROOT;
}

/** True when ROOT exists and is writable. */
async function isWritable() {
  try {
    await fs.mkdir(ROOT, { recursive: true });
    const probe = path.join(ROOT, '.write-probe');
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

module.exports = { uploadFile, deleteFile, readFile, storageRoot, isWritable };
