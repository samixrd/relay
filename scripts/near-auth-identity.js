'use strict';

/**
 * NEAR Auth (FastAuth) identity verification.
 *
 * Google sign-in happens inside the official FastAuth Auth0 tenant. The Auth0 ID
 * token proves who the user is; it never proves ownership of a NEAR account by
 * itself. The NEAR key is the MPC-derived ed25519 key for the token's `sub`
 * claim, derived by `v1.signer-prod.testnet` with predecessor
 * `fast-auth.testnet`. This module:
 *
 *   1. verifies the RS256 ID token against the tenant JWKS,
 *   2. checks issuer, audience, expiry, nonce/email claims,
 *   3. derives the deterministic FastAuth path,
 *   4. asks the MPC contract for that path's public key, and
 *   5. binds the claimed public key to the verified identity.
 *
 * Nothing here treats a Google identity as a signature. A transaction is only
 * authorized after the MPC key signs it and the signature is verified on-chain.
 */

const crypto = require('node:crypto');

const AUTH_DOMAIN = process.env.NEAR_AUTH_DOMAIN || 'login.testnet.fast-auth.com';
const AUTH_ISSUER = `https://${AUTH_DOMAIN}/`;
const AUTH_CLIENT_ID = process.env.NEAR_AUTH_CLIENT_ID || 'np8paqIpMWmNbzT4xAvOOapZBjsOpptl';
const AUTH_SIGNING_AUDIENCE = process.env.NEAR_AUTH_SIGNING_AUDIENCE || (process.env.NEAR_AUTH_CLIENT_ID ? process.env.NEAR_AUTH_CLIENT_ID : 'auth0.jwt.fast-auth.testnet');
const AUTH_GUARD_ID = `jwt#https://${AUTH_DOMAIN}/`;
const FAST_AUTH_CONTRACT_ID = 'fast-auth.testnet';
const MPC_CONTRACT_ID = 'v1.signer-prod.testnet';
const MPC_DOMAIN_ID = 1;
const DEFAULT_USER_PARENT = 'relay.spellman.testnet';
const DEFAULT_JWKS_URL = `https://${AUTH_DOMAIN}/.well-known/jwks.json`;
const MAX_ID_TOKEN_LENGTH = 16 * 1024;
const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

function failure(message, code = 'NEAR_AUTH_IDENTITY_ERROR') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function decodeJwtSegment(segment, label) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    } catch {
        throw failure(`NEAR Auth ID token has an invalid ${label} segment.`, 'ID_TOKEN_MALFORMED');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw failure(`NEAR Auth ID token ${label} must be a JSON object.`, 'ID_TOKEN_MALFORMED');
    }
    return parsed;
}

/**
 * Parses (but does not verify) a compact JWS. Exposed for tests and diagnostics.
 */
function decodeJwt(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_ID_TOKEN_LENGTH) {
        throw failure('NEAR Auth ID token is missing or too large.', 'ID_TOKEN_MISSING');
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        throw failure('NEAR Auth ID token must be a compact JWS.', 'ID_TOKEN_MALFORMED');
    }
    const header = decodeJwtSegment(parts[0], 'header');
    const claims = decodeJwtSegment(parts[1], 'payload');
    let signature;
    try {
        signature = Buffer.from(parts[2], 'base64url');
    } catch {
        throw failure('NEAR Auth ID token signature is not base64url.', 'ID_TOKEN_MALFORMED');
    }
    return {
        header,
        claims,
        signature,
        signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
        raw: token,
    };
}

function createJwksCache({ fetchImpl = globalThis.fetch, jwksUrl = DEFAULT_JWKS_URL, now = Date.now, ttlMs = JWKS_TTL_MS } = {}) {
    let keys = new Map();
    let fetchedAt = 0;
    let inflight = null;

    async function load(force = false) {
        if (!force && keys.size > 0 && now() - fetchedAt < ttlMs) return keys;
        if (inflight) return inflight;
        inflight = (async () => {
            let response;
            try {
                response = await fetchImpl(jwksUrl, {
                    headers: { accept: 'application/json' },
                });
            } catch (error) {
                throw failure(`Unable to reach the NEAR Auth JWKS endpoint: ${error.message}`, 'JWKS_UNAVAILABLE');
            }
            if (!response.ok) {
                throw failure(`NEAR Auth JWKS endpoint returned HTTP ${response.status}.`, 'JWKS_UNAVAILABLE');
            }
            let body;
            try {
                body = await response.json();
            } catch {
                throw failure('NEAR Auth JWKS endpoint returned invalid JSON.', 'JWKS_INVALID');
            }
            if (!body || !Array.isArray(body.keys)) {
                throw failure('NEAR Auth JWKS endpoint returned no keys.', 'JWKS_INVALID');
            }
            const next = new Map();
            for (const jwk of body.keys) {
                if (!jwk || typeof jwk !== 'object') continue;
                if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
                if (jwk.use && jwk.use !== 'sig') continue;
                if (jwk.alg && jwk.alg !== 'RS256') continue;
                if (!jwk.n || !jwk.e) continue;
                next.set(jwk.kid, jwk);
            }
            if (next.size === 0) {
                throw failure('NEAR Auth JWKS endpoint returned no usable RS256 keys.', 'JWKS_INVALID');
            }
            keys = next;
            fetchedAt = now();
            return keys;
        })();
        try {
            return await inflight;
        } finally {
            inflight = null;
        }
    }

    return {
        async get(kid) {
            let current = await load(false);
            if (!current.has(kid)) current = await load(true);
            return current.get(kid) || null;
        },
        clear() {
            keys = new Map();
            fetchedAt = 0;
        },
    };
}

function verifyRs256Jwt({ token, jwks, now = Date.now, audience = AUTH_CLIENT_ID, issuer = AUTH_ISSUER }) {
    const decoded = decodeJwt(token);
    const { header, claims, signature, signingInput } = decoded;

    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
        throw failure('NEAR Auth ID token must be RS256 with a key id.', 'ID_TOKEN_ALGORITHM');
    }

    return (async () => {
        const jwk = await jwks.get(header.kid);
        if (!jwk) {
            throw failure('NEAR Auth ID token was signed by an unknown key.', 'ID_TOKEN_KEY_UNKNOWN');
        }
        let publicKey;
        try {
            publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        } catch {
            throw failure('NEAR Auth JWKS key is not a valid RSA public key.', 'JWKS_INVALID');
        }
        const valid = crypto.verify('RSA-SHA256', signingInput, publicKey, signature);
        if (!valid) {
            throw failure('NEAR Auth ID token signature is invalid.', 'ID_TOKEN_SIGNATURE');
        }
        validateClaims(claims, { now, audience, issuer });
        return claims;
    })();
}

function numericDate(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validateClaims(claims, { now = Date.now, audience = AUTH_CLIENT_ID, issuer = AUTH_ISSUER } = {}) {
    if (claims.iss !== issuer) {
        throw failure(`NEAR Auth ID token issuer must be ${issuer}.`, 'ID_TOKEN_ISSUER');
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) {
        throw failure('NEAR Auth ID token audience does not match the FastAuth client.', 'ID_TOKEN_AUDIENCE');
    }
    const seconds = Math.floor(now() / 1000);
    const exp = numericDate(claims.exp);
    if (exp === null || exp + CLOCK_SKEW_SECONDS < seconds) {
        throw failure('NEAR Auth ID token has expired.', 'ID_TOKEN_EXPIRED');
    }
    const iat = numericDate(claims.iat);
    if (iat !== null && iat - CLOCK_SKEW_SECONDS > seconds) {
        throw failure('NEAR Auth ID token was issued in the future.', 'ID_TOKEN_IAT');
    }
    const nbf = numericDate(claims.nbf);
    if (nbf !== null && nbf - CLOCK_SKEW_SECONDS > seconds) {
        throw failure('NEAR Auth ID token is not valid yet.', 'ID_TOKEN_NBF');
    }
    if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 256) {
        throw failure('NEAR Auth ID token has no usable subject.', 'ID_TOKEN_SUBJECT');
    }
    if (claims.azp && claims.azp !== audience) {
        throw failure('NEAR Auth ID token authorized party does not match.', 'ID_TOKEN_AZP');
    }
    return claims;
}

function normalizeEmail(value) {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    if (email.length < 3 || email.length > 254) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email;
}

/**
 * Converts verified claims into the RELAY identity. Email is only exposed when
 * the provider marked it verified.
 */
function identityFromClaims(claims) {
    const email = normalizeEmail(claims.email);
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
    if (!email) {
        throw failure('NEAR Auth did not return an email address. Enable the email scope for the FastAuth client.', 'IDENTITY_EMAIL_MISSING');
    }
    if (!emailVerified) {
        throw failure('NEAR Auth email address is not verified.', 'IDENTITY_EMAIL_UNVERIFIED');
    }
    return {
        sub: claims.sub,
        email,
        emailVerified: true,
        name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 128) : null,
        picture: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : null,
        issuer: claims.iss,
        authDomain: AUTH_DOMAIN,
    };
}

function deriveFastAuthPath(sub) {
    if (typeof sub !== 'string' || sub.length === 0 || sub.length > 256) {
        throw failure('A verified subject is required to derive the FastAuth path.', 'IDENTITY_SUBJECT');
    }
    if (sub.includes('#')) {
        throw failure('Verified subject contains an illegal delimiter.', 'IDENTITY_SUBJECT');
    }
    return `${AUTH_GUARD_ID}#${sub}`;
}

function deriveUserAccountId(sub, parentAccountId = DEFAULT_USER_PARENT) {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(parentAccountId || '')) {
        throw failure('RELAY user account parent is not a valid NEAR account ID.', 'IDENTITY_PARENT');
    }
    const digest = crypto.createHash('sha256').update(deriveFastAuthPath(sub), 'utf8').digest('hex');
    const accountId = `u-${digest.slice(0, 16)}.${parentAccountId}`;
    if (accountId.length > 64) {
        throw failure('Derived user account ID exceeds the NEAR 64-character limit.', 'IDENTITY_PARENT');
    }
    return accountId;
}

function normalizeNearPublicKey(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(ed25519|secp256k1):([1-9A-HJ-NP-Za-km-z]{32,})$/);
    if (!match) return null;
    return `${match[1]}:${match[2]}`;
}

/**
 * Asks the MPC contract for the derived public key of a FastAuth path.
 * `callFunction` mirrors near-api-js provider semantics so tests can inject it.
 */
async function viewDerivedPublicKey({ callFunction, mpcContractId = MPC_CONTRACT_ID, path, fastAuthContractId = FAST_AUTH_CONTRACT_ID }) {
    if (typeof callFunction !== 'function') {
        throw failure('MPC view function is unavailable.', 'MPC_UNAVAILABLE');
    }
    let value;
    try {
        value = await callFunction({
            contractId: mpcContractId,
            methodName: 'derived_public_key',
            args: {
                path,
                predecessor: fastAuthContractId,
                domain_id: MPC_DOMAIN_ID,
            },
        });
    } catch (error) {
        throw failure(`MPC derived_public_key lookup failed: ${error.message}`, 'MPC_UNAVAILABLE');
    }
    const key = normalizeNearPublicKey(typeof value === 'string' ? value : value?.public_key);
    if (!key) {
        throw failure('MPC contract did not return a valid ed25519 public key.', 'MPC_KEY_INVALID');
    }
    if (!key.startsWith('ed25519:')) {
        throw failure('MPC returned a non-ed25519 key for a FastAuth eddsa path.', 'MPC_KEY_INVALID');
    }
    return key;
}

/**
 * Verifies the identity token, derives the user's account, and proves that the
 * MPC contract owns the claimed public key for this identity.
 */
async function verifyNearAuthIdentity({
    idToken,
    publicKey,
    parentAccountId = DEFAULT_USER_PARENT,
    jwks,
    callFunction,
    now = Date.now,
    mpcContractId = MPC_CONTRACT_ID,
    fastAuthContractId = FAST_AUTH_CONTRACT_ID,
    audience = AUTH_CLIENT_ID,
    issuer = AUTH_ISSUER,
} = {}) {
    if (!jwks) throw failure('A JWKS cache is required.', 'IDENTITY_CONFIGURATION');
    const normalizedKey = normalizeNearPublicKey(publicKey);
    if (!normalizedKey) {
        throw failure('A valid NEAR ed25519 public key is required.', 'IDENTITY_PUBLIC_KEY');
    }
    if (!normalizedKey.startsWith('ed25519:')) {
        throw failure('NEAR Auth login requires an ed25519 key.', 'IDENTITY_PUBLIC_KEY');
    }
    const claims = await verifyRs256Jwt({ token: idToken, jwks, now, audience, issuer });
    const identity = identityFromClaims(claims);
    const path = deriveFastAuthPath(identity.sub);
    const derivedKey = await viewDerivedPublicKey({
        callFunction,
        mpcContractId,
        path,
        fastAuthContractId,
    });
    if (derivedKey !== normalizedKey) {
        throw failure('The supplied public key is not the MPC key for this verified identity.', 'IDENTITY_KEY_MISMATCH');
    }
    const accountId = deriveUserAccountId(identity.sub, parentAccountId);
    return {
        ...identity,
        path,
        publicKey: derivedKey,
        accountId,
        mpcContractId,
        fastAuthContractId,
        guardId: AUTH_GUARD_ID,
        signingAudience: AUTH_SIGNING_AUDIENCE,
        idTokenExpiresAt: numericDate(claims.exp) * 1000,
    };
}

module.exports = {
    AUTH_CLIENT_ID,
    AUTH_DOMAIN,
    AUTH_GUARD_ID,
    AUTH_ISSUER,
    AUTH_SIGNING_AUDIENCE,
    DEFAULT_JWKS_URL,
    DEFAULT_USER_PARENT,
    FAST_AUTH_CONTRACT_ID,
    MPC_CONTRACT_ID,
    MPC_DOMAIN_ID,
    createJwksCache,
    decodeJwt,
    deriveFastAuthPath,
    deriveUserAccountId,
    identityFromClaims,
    normalizeEmail,
    normalizeNearPublicKey,
    validateClaims,
    verifyNearAuthIdentity,
    verifyRs256Jwt,
    viewDerivedPublicKey,
};
