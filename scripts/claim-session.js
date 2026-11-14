'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_SECONDS = 86400; // 24 hours
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// In-memory replay tracking and ephemeral fallback secret
let defaultEphemeralSecret = null;
const claimedSessions = new Set();

function failure(message, code = 'CLAIM_SESSION_ERROR') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function getSessionSecret() {
    if (process.env.CLAIM_SESSION_SECRET && process.env.CLAIM_SESSION_SECRET.length >= 16) {
        return process.env.CLAIM_SESSION_SECRET;
    }
    if (!defaultEphemeralSecret) {
        defaultEphemeralSecret = crypto.randomBytes(32).toString('hex');
    }
    return defaultEphemeralSecret;
}

function validatePublicAppUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return {
            valid: false,
            url: null,
            isLocalhost: false,
            isShareable: false,
            reason: 'PUBLIC_APP_URL is not configured.',
        };
    }

    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return {
            valid: false,
            url: null,
            isLocalhost: false,
            isShareable: false,
            reason: 'PUBLIC_APP_URL is not a valid URL.',
        };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return {
            valid: false,
            url: null,
            isLocalhost: false,
            isShareable: false,
            reason: 'PUBLIC_APP_URL must use https: or http: protocol.',
        };
    }

    if (parsed.username || parsed.password) {
        return {
            valid: false,
            url: null,
            isLocalhost: false,
            isShareable: false,
            reason: 'PUBLIC_APP_URL must not contain embedded credentials.',
        };
    }

    const host = parsed.hostname.toLowerCase();
    const isLocalhost = LOCAL_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal');
    const isShareable = !isLocalhost && parsed.protocol === 'https:';

    const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, '')}`;
    return {
        valid: true,
        url: normalized,
        isLocalhost,
        isShareable,
        reason: isShareable ? null : (isLocalhost ? 'Localhost cannot be shared with friends on different devices.' : 'Public cross-device sharing requires an HTTPS URL.'),
    };
}

/**
 * Normalizes a recipient email for exact-match binding. The plain-text email is
 * never placed inside the signed session envelope; only a SHA-256 hash is.
 * This prevents a forwarded invitation link from leaking the recipient address.
 */
function normalizeRecipientEmail(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') throw failure('Intended recipient email must be a string.', 'INVALID_RECIPIENT_EMAIL');
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 254 || !EMAIL_RE.test(normalized)) {
        throw failure('Intended recipient email is not valid.', 'INVALID_RECIPIENT_EMAIL');
    }
    return normalized;
}

function hashRecipientEmail(email) {
    if (!email) return null;
    return crypto.createHash('sha256').update(`relay-claim-email:${email}`).digest('hex');
}

function computeSessionSignature(payloadObj, secret) {
    let serialized = `${payloadObj.sessionId}:${payloadObj.tokenId}:${payloadObj.expectedOwner}:${payloadObj.expiresAt}:${payloadObj.intendedRecipient || ''}`;
    // Appended only for email-bound invitations, so pre-existing session tokens
    // created before Task 47 continue to verify with their original signature.
    if (payloadObj.intendedRecipientEmailHash) {
        serialized += `:emailhash:${payloadObj.intendedRecipientEmailHash}`;
    }
    return crypto.createHmac('sha256', secret).update(serialized).digest('hex');
}

/**
 * Derives the creator-only approval capability. It is returned once to the
 * creator when the invitation is created, stored server-side in the claim
 * journal, and deliberately excluded from the claim URL and the signed
 * recipient session token.
 */
function deriveOwnerApprovalToken(sessionId, secretKey = null) {
    if (!sessionId || typeof sessionId !== 'string') {
        throw failure('Session ID is required to derive an owner approval token.', 'MISSING_SESSION_ID');
    }
    const secret = secretKey || getSessionSecret();
    return crypto.createHmac('sha256', secret).update(`relay-owner-approval:${sessionId}`).digest('hex');
}

function timingSafeHexEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    } catch {
        return false;
    }
}

function createClaimSession({
    tokenId,
    expectedOwner,
    intendedRecipient = null,
    intendedRecipientEmail = null,
    publicAppUrl = null,
    localFallbackOrigin = 'http://127.0.0.1:4173',
    ttlSeconds = DEFAULT_TTL_SECONDS,
    secretKey = null,
    journal = null,
}) {
    if (!tokenId || typeof tokenId !== 'string') throw failure('Token ID is required to create a claim session.');
    if (!expectedOwner || typeof expectedOwner !== 'string') throw failure('Expected owner is required to bind a claim session.');

    const normalizedEmail = normalizeRecipientEmail(intendedRecipientEmail);
    const emailHash = hashRecipientEmail(normalizedEmail);

    const secret = secretKey || getSessionSecret();
    const sessionId = crypto.randomBytes(16).toString('hex');
    const createdAt = Date.now();
    const expiresAt = createdAt + (Math.max(60, ttlSeconds) * 1000);

    const payload = {
        sessionId,
        tokenId,
        expectedOwner,
        intendedRecipient: intendedRecipient || null,
        createdAt,
        expiresAt,
    };
    if (emailHash) payload.intendedRecipientEmailHash = emailHash;

    const signature = computeSessionSignature(payload, secret);
    payload.signature = signature;

    const sessionToken = Buffer.from(JSON.stringify(payload)).toString('base64url');

    const publicStatus = validatePublicAppUrl(publicAppUrl);
    const baseUrl = (publicStatus.valid && publicStatus.isShareable) ? publicStatus.url : (publicStatus.url || localFallbackOrigin);

    // Legacy-compatible claim hash. The Task 47 router parses this form and
    // renders the full claim experience at the same URL.
    const claimUrl = `${baseUrl}/#claim=${encodeURIComponent(tokenId)}&session=${encodeURIComponent(sessionToken)}`;

    const sessionObj = {
        sessionId,
        sessionToken,
        claimUrl,
        tokenId,
        expectedOwner,
        intendedRecipient: payload.intendedRecipient,
        intendedRecipientEmail: normalizedEmail,
        intendedRecipientEmailHash: emailHash,
        ownerApprovalToken: deriveOwnerApprovalToken(sessionId, secret),
        delivery: normalizedEmail ? 'invite-link-only' : 'open-link',
        emailDelivery: 'not-implemented',
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        ttlSeconds,
        isCrossDeviceShareable: publicStatus.isShareable,
        publicAppUrl: publicStatus.url,
        warning: publicStatus.isShareable ? null : (publicStatus.reason || 'Local link only. Configure PUBLIC_APP_URL with an HTTPS domain to share with friends across devices.'),
    };

    return sessionObj;
}

function verifyClaimSession(sessionToken, {
    currentTokenOwner = null,
    requestedTokenId = null,
    secretKey = null,
    journal = null,
    nowMs = Date.now(),
} = {}) {
    if (!sessionToken || typeof sessionToken !== 'string') {
        throw failure('Claim session token is missing or malformed.', 'MISSING_SESSION_TOKEN');
    }

    let payload;
    try {
        const json = Buffer.from(sessionToken, 'base64url').toString('utf8');
        payload = JSON.parse(json);
    } catch {
        throw failure('Claim session token could not be parsed.', 'MALFORMED_SESSION_TOKEN');
    }

    if (!payload.sessionId || !payload.tokenId || !payload.expectedOwner || !payload.expiresAt || !payload.signature) {
        throw failure('Claim session token is missing required envelope fields.', 'INVALID_SESSION_ENVELOPE');
    }

    // 1. Replay check
    if (claimedSessions.has(payload.sessionId)) {
        throw failure('This claim session has already been claimed and cannot be reused.', 'SESSION_REPLAYED');
    }

    if (journal && typeof journal.getSession === 'function') {
        const entry = journal.getSession(payload.sessionId);
        if (entry) {
            if (entry.state === 'TRANSFER_FINALIZED') {
                throw failure('This claim session has already been claimed and cannot be reused.', 'SESSION_REPLAYED');
            }
            if (entry.state === 'CANCELLED') {
                throw failure(`Claim session has been cancelled: ${entry.cancellationReason || ''}`, 'SESSION_CANCELLED');
            }
        }
    }

    // 2. Signature verification
    const secret = secretKey || getSessionSecret();
    const expectedSig = computeSessionSignature(payload, secret);
    if (!crypto.timingSafeEqual(Buffer.from(payload.signature, 'hex'), Buffer.from(expectedSig, 'hex'))) {
        throw failure('Claim session signature verification failed.', 'INVALID_SESSION_SIGNATURE');
    }

    // 3. Expiration check
    if (nowMs > payload.expiresAt) {
        const expiredAgoSec = Math.round((nowMs - payload.expiresAt) / 1000);
        throw failure(`Claim session expired ${expiredAgoSec} seconds ago. Request a fresh claim link from the creator.`, 'SESSION_EXPIRED');
    }

    // 4. Token substitution prevention
    if (requestedTokenId && requestedTokenId !== payload.tokenId) {
        throw failure(`Claim session token was created for ${payload.tokenId}, but loaded for ${requestedTokenId}. Token substitution rejected.`, 'TOKEN_SUBSTITUTION_REJECTED');
    }

    // 5. Ownership binding check
    if (currentTokenOwner && currentTokenOwner !== payload.expectedOwner) {
        throw failure(`NFT owner has changed since this claim session was created (creator was ${payload.expectedOwner}, current owner is ${currentTokenOwner}). Session invalidated.`, 'OWNER_MISMATCH');
    }

    return {
        valid: true,
        sessionId: payload.sessionId,
        tokenId: payload.tokenId,
        expectedOwner: payload.expectedOwner,
        intendedRecipient: payload.intendedRecipient,
        intendedRecipientEmailHash: payload.intendedRecipientEmailHash || null,
        createdAt: new Date(payload.createdAt).toISOString(),
        expiresAt: new Date(payload.expiresAt).toISOString(),
    };
}

function markSessionClaimed(sessionId, { finalizedOwner = null, journal = null } = {}) {
    if (sessionId && typeof sessionId === 'string') {
        claimedSessions.add(sessionId);
        if (journal && typeof journal.recordTransferFinalized === 'function') {
            journal.recordTransferFinalized(sessionId, finalizedOwner).catch(() => {});
        }
    }
}

function resetClaimedSessionsForTesting() {
    claimedSessions.clear();
}

module.exports = {
    DEFAULT_TTL_SECONDS,
    createClaimSession,
    deriveOwnerApprovalToken,
    hashRecipientEmail,
    markSessionClaimed,
    normalizeRecipientEmail,
    resetClaimedSessionsForTesting,
    timingSafeHexEqual,
    validatePublicAppUrl,
    verifyClaimSession,
};
