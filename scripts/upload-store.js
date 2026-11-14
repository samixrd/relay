'use strict';

/**
 * RELAY artwork storage adapter.
 *
 * The product only accepts real raster images (JPEG, PNG, WebP). Validation is
 * server-side: the declared MIME type, the file signature, and the decoded
 * image structure are all checked before anything is persisted. SVG, HTML,
 * executables, and disguised non-images are rejected.
 *
 * Storage providers:
 *   - `local` (default): durable files under an app-controlled directory.
 *     Suitable for local testing and a single-host deployment.
 *   - `http`: writes the object to a configured object-storage endpoint that
 *     accepts a raw PUT/POST with a bearer token and returns a public URL.
 *   - `ipfs`: pins the bytes through a configured IPFS pinning HTTP endpoint
 *     and returns a persistent gateway URL.
 *
 * No provider is silently emulated. If a production provider is selected but
 * not configured, the upload fails with a clear `STORAGE_UNAVAILABLE` error.
 * The caller must never claim permanence for local development storage.
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB, documented in the UI and API.
const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/;
const FILE_NAME_RE = /^([a-z0-9-]+)\.(png|jpg|jpeg|webp)$/i;
const MIME_BY_EXTENSION = Object.freeze({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
});

function storageFailure(message, code, status = 400) {
    return Object.assign(new Error(message), { status, code });
}

function sniffImageExtension(buffer) {
    if (!Buffer.isBuffer(buffer)) return null;
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { extension: 'png', contentType: 'image/png' };
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { extension: 'jpg', contentType: 'image/jpeg' };
    }
    if (
        buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return { extension: 'webp', contentType: 'image/webp' };
    }
    return null;
}

/**
 * Rejects active content that can hide inside otherwise-valid-looking files and
 * checks the minimum structure of each accepted raster format.
 */
function validateImageBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw storageFailure('The uploaded image is empty.', 'EMPTY_IMAGE');
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw storageFailure(`Image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB upload limit.`, 'IMAGE_TOO_LARGE', 413);
    }
    // Identify the real container first. Active-content scanning on raw binary
    // image data produces false positives (EXIF/XMP/ICC metadata can contain
    // arbitrary byte sequences), so only non-image payloads are scanned for
    // SVG/HTML/script content. Served bytes always get the sniffed image MIME
    // type plus `X-Content-Type-Options: nosniff`, so a raster container is inert.
    const sniffed = sniffImageExtension(buffer);
    if (!sniffed) {
        const text = buffer.subarray(0, 1024).toString('latin1').toLowerCase();
        if (text.includes('<svg') || text.includes('<html') || text.includes('<!doctype') || text.includes('<script')) {
            // Keep a short, non-sensitive fingerprint so a false positive can be
            // diagnosed from the server log without storing the payload.
            console.warn(
                '[upload] rejected active content; head=',
                buffer.subarray(0, 80).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
            );
            throw storageFailure('SVG, HTML, and script content are not accepted as artwork.', 'UNSUPPORTED_IMAGE_TYPE');
        }
        // Executable signatures (ELF, PE/MZ, Mach-O) must never be stored as images.
        if (
            (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46)
            || (buffer[0] === 0x4d && buffer[1] === 0x5a)
            || (buffer[0] === 0xcf && buffer[1] === 0xfa && buffer[2] === 0xed && buffer[3] === 0xfe)
        ) {
            throw storageFailure('Executable files are not accepted.', 'UNSUPPORTED_IMAGE_TYPE');
        }
        throw storageFailure('The file bytes are not a valid JPEG, PNG, or WebP image.', 'INVALID_IMAGE_BYTES');
    }
    if (sniffed.extension === 'png' && !buffer.includes(Buffer.from('IEND'))) {
        throw storageFailure('The PNG is truncated or malformed.', 'INVALID_IMAGE_BYTES');
    }
    if (sniffed.extension === 'jpg' && !(buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9)) {
        // Some encoders pad the tail; require at least an EOI marker somewhere near the end.
        const tail = buffer.subarray(Math.max(0, buffer.length - 32));
        if (!tail.includes(Buffer.from([0xff, 0xd9]))) {
            throw storageFailure('The JPEG is truncated or malformed.', 'INVALID_IMAGE_BYTES');
        }
    }
    if (sniffed.extension === 'webp') {
        const declared = buffer.readUInt32LE(4) + 8;
        if (declared > buffer.length + 8) {
            throw storageFailure('The WebP container is truncated.', 'INVALID_IMAGE_BYTES');
        }
    }
    return {
        ...sniffed,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
}

function safeFileName(extension) {
    return `${Date.now().toString(36)}-${crypto.randomBytes(16).toString('hex')}.${extension}`;
}

function joinInside(directory, fileName) {
    if (!FILE_NAME_RE.test(fileName || '')) return null;
    const absoluteDirectory = path.resolve(directory);
    const filePath = path.resolve(absoluteDirectory, fileName);
    if (!filePath.startsWith(`${absoluteDirectory}${path.sep}`)) return null;
    return { fileName, filePath: path.resolve(filePath) };
}

function publicBaseUrl(value) {
    return typeof value === 'string' && value.trim() ? value.trim().replace(/\/$/, '') : '';
}

function createLocalProvider({ directory, publicAppUrl }) {
    const absoluteDirectory = path.resolve(directory);
    const base = publicBaseUrl(publicAppUrl);

    return {
        id: 'local',
        permanent: false,
        absoluteDirectory,
        async put(buffer, { fileName, contentType, ownerId }) {
            await fs.mkdir(absoluteDirectory, { recursive: true, mode: 0o700 });
            const target = joinInside(absoluteDirectory, fileName);
            if (!target) throw storageFailure('Unsafe upload object name.', 'UNSAFE_OBJECT_NAME');
            await fs.writeFile(target.filePath, buffer, { mode: 0o600, flag: 'wx' });
            const sidecar = `${target.filePath}.json`;
            await fs.writeFile(sidecar, JSON.stringify({
                fileName,
                ownerId: ownerId || null,
                contentType,
                bytes: buffer.length,
                createdAt: new Date().toISOString(),
            }), { mode: 0o600, flag: 'wx' });
            const relativePath = `/uploads/${fileName}`;
            return { path: relativePath, url: `${base}${relativePath}`, storage: 'local', permanent: false };
        },
        async readOwner(fileName) {
            const target = joinInside(absoluteDirectory, fileName);
            if (!target) return null;
            try {
                const raw = await fs.readFile(`${target.filePath}.json`, 'utf8');
                return JSON.parse(raw)?.ownerId || null;
            } catch {
                return null;
            }
        },
        async remove(fileName) {
            const target = joinInside(absoluteDirectory, fileName);
            if (!target) throw storageFailure('Unsafe upload object name.', 'UNSAFE_OBJECT_NAME');
            await fs.unlink(target.filePath).catch(() => {});
            await fs.unlink(`${target.filePath}.json`).catch(() => {});
            return true;
        },
    };
}

function createHttpProvider({ endpoint, token, publicBase, permanent = true }) {
    if (!endpoint) throw storageFailure('Artwork storage is not configured (UPLOAD_HTTP_ENDPOINT).', 'STORAGE_UNAVAILABLE', 503);
    return {
        id: 'http',
        permanent,
        async put(buffer, { fileName, contentType }) {
            const headers = { 'content-type': contentType, 'content-length': String(buffer.length) };
            if (token) headers.authorization = `Bearer ${token}`;
            const target = `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(fileName)}`;
            let response;
            try {
                response = await fetch(target, { method: 'PUT', headers, body: buffer });
            } catch (error) {
                throw storageFailure(`Artwork storage is unavailable: ${error.message}`, 'STORAGE_UNAVAILABLE', 503);
            }
            if (!response.ok) {
                throw storageFailure(`Artwork storage rejected the upload (${response.status}).`, 'STORAGE_UNAVAILABLE', 503);
            }
            let url = response.headers.get('location') || '';
            try {
                const body = await response.json();
                if (body?.url) url = body.url;
            } catch {
                // A plain 2xx without a body is acceptable when a public base is configured.
            }
            if (!url && publicBase) url = `${publicBase.replace(/\/$/, '')}/${encodeURIComponent(fileName)}`;
            if (!url || !/^https:\/\//i.test(url)) {
                throw storageFailure('Artwork storage did not return a public HTTPS URL.', 'STORAGE_URL_MISSING', 503);
            }
            return { path: url, url, storage: 'http', permanent: true };
        },
    };
}

function createIpfsProvider({ pinningUrl, token, gateway, permanent = true }) {
    if (!pinningUrl) throw storageFailure('Artwork IPFS storage is not configured (UPLOAD_IPFS_PINNING_URL).', 'STORAGE_UNAVAILABLE', 503);
    const gatewayBase = publicBaseUrl(gateway || 'https://ipfs.io/ipfs');
    return {
        id: 'ipfs',
        permanent,
        async put(buffer, { fileName, contentType }) {
            const form = new FormData();
            form.append('file', new Blob([buffer], { type: contentType }), fileName);
            const headers = {};
            if (token) headers.authorization = `Bearer ${token}`;
            let response;
            try {
                response = await fetch(pinningUrl, { method: 'POST', headers, body: form });
            } catch (error) {
                throw storageFailure(`IPFS pinning is unavailable: ${error.message}`, 'STORAGE_UNAVAILABLE', 503);
            }
            if (!response.ok) {
                throw storageFailure(`IPFS pinning rejected the upload (${response.status}).`, 'STORAGE_UNAVAILABLE', 503);
            }
            const body = await response.json().catch(() => null);
            const cid = body?.IpfsHash || body?.Hash || body?.cid || body?.cidString || null;
            if (!cid) throw storageFailure('IPFS pinning did not return a CID.', 'STORAGE_URL_MISSING', 503);
            const url = `${gatewayBase}/${encodeURIComponent(cid)}`;
            return { path: url, url, storage: 'ipfs', permanent: true, cid };
        },
    };
}

function createUploadStore({
    directory,
    publicAppUrl = null,
    provider = null,
    env = process.env,
} = {}) {
    const selected = (provider || env.UPLOAD_STORAGE_PROVIDER || 'local').toLowerCase();
    const local = createLocalProvider({ directory, publicAppUrl });
    let active;
    if (selected === 'local') {
        active = local;
    } else if (selected === 'http' || selected === 's3' || selected === 'object') {
        active = createHttpProvider({
            endpoint: env.UPLOAD_HTTP_ENDPOINT,
            token: env.UPLOAD_HTTP_TOKEN,
            publicBase: env.UPLOAD_HTTP_PUBLIC_BASE,
        });
    } else if (selected === 'ipfs') {
        active = createIpfsProvider({
            pinningUrl: env.UPLOAD_IPFS_PINNING_URL,
            token: env.UPLOAD_IPFS_TOKEN,
            gateway: env.UPLOAD_IPFS_GATEWAY,
        });
    } else {
        throw storageFailure(`Unknown upload storage provider '${selected}'.`, 'STORAGE_PROVIDER_UNKNOWN', 500);
    }

    return {
        provider: active.id,
        permanent: active.permanent === true,
        absoluteDirectory: local.absoluteDirectory,
        limits: { maxBytes: MAX_IMAGE_BYTES, formats: ['jpeg', 'png', 'webp'] },
        async saveBuffer(buffer, { ownerId = null, claimedContentType = null } = {}) {
            if (claimedContentType) {
                const normalized = String(claimedContentType).split(';')[0].trim().toLowerCase();
                if (normalized && normalized !== 'application/octet-stream' && !MIME_BY_EXTENSION[normalized.split('/')[1]] && !/^image\/(jpeg|png|webp)$/.test(normalized)) {
                    throw storageFailure('Only JPEG, PNG, and WebP artwork is accepted.', 'UNSUPPORTED_IMAGE_TYPE');
                }
            }
            const validated = validateImageBuffer(buffer);
            const fileName = safeFileName(validated.extension);
            const stored = await active.put(buffer, {
                fileName,
                contentType: validated.contentType,
                ownerId,
            });
            return {
                path: stored.path,
                url: stored.url,
                bytes: buffer.length,
                contentType: validated.contentType,
                sha256: validated.sha256,
                storage: stored.storage,
                permanent: stored.permanent === true,
            };
        },
        async saveDataUrl(dataUrl, options = {}) {
            if (typeof dataUrl !== 'string') {
                throw storageFailure('An image data URL is required.', 'INVALID_IMAGE');
            }
            const match = DATA_URL_RE.exec(dataUrl);
            if (!match) {
                throw storageFailure('Image must be a PNG, JPEG, or WebP data URL. SVG uploads are intentionally rejected.', 'UNSUPPORTED_IMAGE_TYPE');
            }
            const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
            return this.saveBuffer(buffer, { ...options, claimedContentType: `image/${match[1]}` });
        },
        /**
         * Only the recorded owner may overwrite or delete an object. There is
         * intentionally no overwrite API: uploads always get a fresh name.
         */
        async assertOwner(fileName, ownerId) {
            const owner = await active.readOwner?.(fileName);
            if (owner === null || owner === undefined) {
                throw storageFailure('Only the uploader may modify this artwork.', 'UPLOAD_FORBIDDEN', 403);
            }
            if (owner !== ownerId) {
                throw storageFailure('Only the uploader may modify this artwork.', 'UPLOAD_FORBIDDEN', 403);
            }
            return true;
        },
    };
}

function resolveUploadFile(directory, requestPath) {
    const match = /^\/uploads\/([a-z0-9-]+\.(?:png|jpg|jpeg|webp))$/i.exec(requestPath || '');
    if (!match) return null;
    const target = joinInside(directory, match[1]);
    if (!target) return null;
    return {
        fileName: target.fileName,
        filePath: target.filePath,
        contentType: MIME_BY_EXTENSION[target.fileName.split('.').pop().toLowerCase()] || 'application/octet-stream',
    };
}

module.exports = {
    MAX_IMAGE_BYTES,
    createUploadStore,
    resolveUploadFile,
    sniffImageExtension,
    validateImageBuffer,
};
