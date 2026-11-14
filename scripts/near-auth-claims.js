'use strict';

/**
 * Email-bound friend claims for the NEAR Auth product path.
 *
 * The owner creates a claim for an email address. The email is stored only as
 * an HMAC, so the journal does not leak addresses at rest. The recipient must
 * sign in through NEAR Auth and the server must verify the same email before the
 * claim becomes `ready`. The owner then approves the real `nft_transfer`.
 *
 * This mirrors the existing RELAY claim semantics: a verified email identifies
 * the intended recipient; it never grants ownership by itself, and it is never
 * treated as a NEAR signature.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLAIM_ID_RE = /^[a-f0-9]{32}$/;

function failure(message, code = 'NEAR_AUTH_CLAIM_ERROR') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeEmail(value) {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email;
}

function maskEmail(email) {
    const [local, domain] = email.split('@');
    const visible = local.slice(0, 1);
    return `${visible}${'*'.repeat(Math.max(2, Math.min(10, local.length - 1)))}@${domain}`;
}

function createNearAuthClaimStore({
    filePath = path.join(__dirname, '..', 'data', 'near-auth-claims.json'),
    secret,
    now = Date.now,
    ttlMs = DEFAULT_TTL_MS,
} = {}) {
    if (typeof secret !== 'string' || secret.length < 16) {
        throw failure('A claim secret of at least 16 characters is required.', 'CLAIM_SECRET');
    }
    const claims = new Map();
    let loaded = false;

    function load() {
        if (loaded) return;
        loaded = true;
        let text;
        try {
            text = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw failure('The claim journal is not valid JSON.', 'CLAIM_JOURNAL');
        }
        for (const entry of Array.isArray(parsed?.claims) ? parsed.claims : []) {
            if (entry && CLAIM_ID_RE.test(entry.id)) claims.set(entry.id, entry);
        }
    }

    function persist() {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const body = JSON.stringify({
            version: 1,
            claims: [...claims.values()].sort((a, b) => a.createdAt - b.createdAt),
        }, null, 2);
        const temporary = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        fs.writeFileSync(temporary, body, { mode: 0o600 });
        fs.renameSync(temporary, filePath);
    }

    function emailHash(email) {
        return crypto.createHmac('sha256', secret).update(`near-auth-claim:${email}`).digest('hex');
    }

    function expired(entry) {
        return now() > entry.expiresAt;
    }

    function create({ tokenId, contractId, ownerAccountId, ownerSub, recipientEmail }) {
        load();
        const email = normalizeEmail(recipientEmail);
        if (!email) throw failure('A valid recipient email is required.', 'CLAIM_EMAIL');
        if (typeof tokenId !== 'string' || !tokenId) throw failure('A token ID is required.', 'CLAIM_TOKEN');
        if (typeof ownerAccountId !== 'string' || !ownerAccountId) throw failure('An owner account is required.', 'CLAIM_OWNER');
        if (typeof ownerSub !== 'string' || !ownerSub) throw failure('An owner identity is required.', 'CLAIM_OWNER');
        const entry = {
            id: crypto.randomBytes(16).toString('hex'),
            tokenId,
            contractId,
            ownerAccountId,
            ownerSub,
            emailHash: emailHash(email),
            emailMasked: maskEmail(email),
            status: 'open',
            recipientSub: null,
            recipientAccountId: null,
            transactionHash: null,
            createdAt: now(),
            expiresAt: now() + ttlMs,
            verifiedAt: null,
            claimedAt: null,
        };
        claims.set(entry.id, entry);
        persist();
        return publicClaim(entry);
    }

    function get(id) {
        load();
        if (!CLAIM_ID_RE.test(id || '')) return null;
        const entry = claims.get(id);
        if (!entry) return null;
        if (expired(entry) && entry.status !== 'claimed') {
            entry.status = 'expired';
        }
        return entry;
    }

    function publicClaim(entry) {
        if (!entry) return null;
        return {
            id: entry.id,
            tokenId: entry.tokenId,
            contractId: entry.contractId,
            emailMasked: entry.emailMasked,
            status: expired(entry) && entry.status !== 'claimed' ? 'expired' : entry.status,
            createdAt: entry.createdAt,
            expiresAt: entry.expiresAt,
            verifiedAt: entry.verifiedAt,
            claimedAt: entry.claimedAt,
            transactionHash: entry.transactionHash,
        };
    }

    function listForOwner(ownerSub) {
        load();
        return [...claims.values()]
            .filter((entry) => entry.ownerSub === ownerSub)
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(publicClaim);
    }

    function verifyRecipient(id, { sub, email, accountId }) {
        load();
        const entry = get(id);
        if (!entry) throw failure('Claim not found.', 'CLAIM_NOT_FOUND');
        if (entry.status === 'expired' || expired(entry)) throw failure('Claim has expired.', 'CLAIM_EXPIRED');
        if (entry.status === 'claimed') throw failure('Claim has already been completed.', 'CLAIM_CLAIMED');
        const normalized = normalizeEmail(email);
        if (!normalized || emailHash(normalized) !== entry.emailHash) {
            throw failure('This claim was not issued to your verified email.', 'CLAIM_EMAIL_MISMATCH');
        }
        if (typeof sub !== 'string' || !sub) throw failure('A verified identity is required.', 'CLAIM_IDENTITY');
        entry.recipientSub = sub;
        entry.recipientAccountId = accountId;
        entry.status = 'ready';
        entry.verifiedAt = now();
        persist();
        return publicClaim(entry);
    }

    function ownerHasClaim(entry, ownerSub) {
        return Boolean(entry && ownerSub && entry.ownerSub === ownerSub);
    }

    function markClaimed(id, transactionHash) {
        load();
        const entry = get(id);
        if (!entry) throw failure('Claim not found.', 'CLAIM_NOT_FOUND');
        entry.status = 'claimed';
        entry.claimedAt = now();
        entry.transactionHash = transactionHash || null;
        persist();
        return publicClaim(entry);
    }

    function cancel(id, ownerSub) {
        load();
        const entry = get(id);
        if (!entry) throw failure('Claim not found.', 'CLAIM_NOT_FOUND');
        if (!ownerHasClaim(entry, ownerSub)) throw failure('Only the claim creator can cancel it.', 'CLAIM_OWNER');
        if (entry.status === 'claimed') throw failure('A completed claim cannot be cancelled.', 'CLAIM_CLAIMED');
        entry.status = 'cancelled';
        persist();
        return publicClaim(entry);
    }

    return {
        create,
        get,
        listForOwner,
        markClaimed,
        ownerHasClaim,
        publicClaim,
        verifyRecipient,
        cancel,
        clear() {
            claims.clear();
            loaded = true;
        },
    };
}

module.exports = {
    CLAIM_ID_RE,
    createNearAuthClaimStore,
    maskEmail,
    normalizeEmail,
};
