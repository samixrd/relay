'use strict';

const crypto = require('node:crypto');
const { base58 } = require('@scure/base');
const nacl = require('tweetnacl');

const NEAR_ACCOUNT_ID_RE = /^(([a-z0-9_-]+)\.)*[a-z0-9_-]+$/;
const IMPLICIT_ACCOUNT_ID_RE = /^[0-9a-f]{64}$/;
// NEP-413 specification tag: 2^31 + 413 = 2147484061 (0x8000019d)
const NEP413_TAG = 2147484061;

function failure(message, code = 'AUTH_ERROR') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function validateNearAccountId(accountId) {
    if (!accountId || typeof accountId !== 'string') return false;
    if (accountId.length < 2 || accountId.length > 64) return false;
    return NEAR_ACCOUNT_ID_RE.test(accountId) || IMPLICIT_ACCOUNT_ID_RE.test(accountId);
}

function validateAuthConfig(env = process.env) {
    const clientId = env.GOOGLE_CLIENT_ID ? env.GOOGLE_CLIENT_ID.trim() : null;
    const clientSecret = env.GOOGLE_CLIENT_SECRET ? env.GOOGLE_CLIENT_SECRET.trim() : null;
    const redirectUri = env.GOOGLE_REDIRECT_URI ? env.GOOGLE_REDIRECT_URI.trim() : null;

    const missing = [];
    if (!clientId) missing.push('GOOGLE_CLIENT_ID');
    if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
    if (!redirectUri) missing.push('GOOGLE_REDIRECT_URI');

    const configured = missing.length === 0;

    return {
        provider: 'google',
        configured,
        status: configured ? 'configured' : 'unconfigured',
        clientIdConfigured: Boolean(clientId),
        clientSecretConfigured: Boolean(clientSecret),
        redirectUriConfigured: Boolean(redirectUri),
        missing,
        requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
        onboardingArchitecture: {
            idp: 'Google OpenID Connect (OIDC) / OAuth 2.0 PKCE',
            nearAccountBinding: 'NEP-413 Cryptographic Signature & Account Ownership Proof',
            automatedCreationStatus: 'unavailable',
            flow: 'Web2 Recipient -> Google Sign-In (OIDC PKCE) -> Verified Identity -> Sign NEP-413 Challenge -> Creator Approval -> On-Chain Transfer',
        },
        documentation: 'To enable genuine Web2 Google onboarding, set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in the server-side .env file. Automated Google-to-NEAR custodial account creation is unconfigured; real NEAR Testnet account linking is used.',
        reason: configured ? null : `Google OAuth credentials are not configured in local .env (${missing.join(', ')} missing). No fake login is simulated.`,
    };
}

class OAuthTransactionStore {
    constructor(ttlMs = 15 * 60 * 1000) {
        this.ttlMs = ttlMs;
        this.transactions = new Map();
    }

    createTransaction({ claimSessionId, codeVerifier, nonce, recipientSub = null, clientIp = null }) {
        if (!claimSessionId) throw failure('Claim session ID required for OAuth transaction.');
        if (!codeVerifier) throw failure('Code verifier required for OAuth transaction.');
        const state = crypto.randomBytes(32).toString('hex');
        const now = Date.now();
        const tx = {
            state,
            claimSessionId,
            codeVerifier,
            nonce: nonce || crypto.randomBytes(16).toString('hex'),
            recipientSub,
            clientIp,
            createdAt: now,
            expiresAt: now + this.ttlMs,
        };
        this.transactions.set(state, tx);
        return tx;
    }

    getTransaction(state) {
        if (!state || typeof state !== 'string') return null;
        const tx = this.transactions.get(state);
        if (!tx) return null;
        if (Date.now() > tx.expiresAt) {
            this.transactions.delete(state);
            return null;
        }
        return tx;
    }

    consumeTransaction(state) {
        const tx = this.getTransaction(state);
        if (tx) {
            this.transactions.delete(state);
        }
        return tx;
    }

    clear() {
        this.transactions.clear();
    }
}

class ServerSessionStore {
    constructor(ttlMs = 24 * 60 * 60 * 1000) {
        this.ttlMs = ttlMs;
        this.sessions = new Map();
    }

    createSession(user) {
        if (!user || !user.sub) throw failure('Valid user with sub required for server session.');
        const sessionId = crypto.randomBytes(32).toString('hex');
        const now = Date.now();
        const session = {
            sessionId,
            sub: user.sub,
            email: user.email || null,
            emailVerified: user.emailVerified === true,
            name: user.name || null,
            picture: user.picture || null,
            createdAt: now,
            expiresAt: now + this.ttlMs,
        };
        this.sessions.set(sessionId, session);
        return session;
    }

    getSession(sessionId) {
        if (!sessionId || typeof sessionId !== 'string') return null;
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        if (Date.now() > session.expiresAt) {
            this.sessions.delete(sessionId);
            return null;
        }
        return session;
    }

    revokeSession(sessionId) {
        if (!sessionId) return false;
        return this.sessions.delete(sessionId);
    }

    clear() {
        this.sessions.clear();
    }
}

class ChallengeStore {
    constructor(ttlMs = 15 * 60 * 1000) {
        this.ttlMs = ttlMs;
        this.challenges = new Map();
    }

    createChallenge({ claimSessionId, recipientSub, tokenId, contractId = null, recipientAccountId, appOrigin = 'http://localhost:4173' }) {
        if (!claimSessionId || !recipientAccountId) {
            throw failure('claimSessionId and recipientAccountId are required for challenge.');
        }
        const challengeId = crypto.randomBytes(16).toString('hex');
        const nonceBytes = crypto.randomBytes(32);
        const nonceHex = nonceBytes.toString('hex');
        const now = Date.now();
        const expiresAt = now + this.ttlMs;
        const contractPart = contractId ? `\nContract: ${contractId}` : '';
        const message = `RELAY_OWNERSHIP_PROOF\nDomain: ${appOrigin}${contractPart}\nSession: ${claimSessionId}\nToken: ${tokenId}\nRecipient: ${recipientAccountId}\nSub: ${recipientSub || ''}\nNonce: ${nonceHex}\nExpires: ${expiresAt}`;

        const payload = {
            challengeId,
            claimSessionId,
            recipientSub: recipientSub || null,
            tokenId: tokenId || null,
            contractId: contractId || null,
            recipientAccountId,
            appOrigin,
            nonceHex,
            nonceBytes,
            message,
            issuedAt: now,
            expiresAt,
        };
        this.challenges.set(challengeId, payload);
        return payload;
    }

    getChallenge(challengeId) {
        if (!challengeId || typeof challengeId !== 'string') return null;
        const c = this.challenges.get(challengeId);
        if (!c) return null;
        if (Date.now() > c.expiresAt) {
            this.challenges.delete(challengeId);
            return null;
        }
        return c;
    }

    consumeChallenge(challengeId) {
        const c = this.getChallenge(challengeId);
        if (c) {
            this.challenges.delete(challengeId);
        }
        return c;
    }

    clear() {
        this.challenges.clear();
    }
}

const defaultOAuthTransactionStore = new OAuthTransactionStore();
const defaultServerSessionStore = new ServerSessionStore();
const defaultChallengeStore = new ChallengeStore();

function generatePkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function createOAuthStateToken(claimSessionId, secret, { codeVerifier = null, customNonce = null } = {}) {
    if (!claimSessionId) throw failure('Claim session ID required for OAuth state token.');
    const nonce = customNonce || crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const verifierStr = codeVerifier || '';
    const data = `${claimSessionId}:${nonce}:${timestamp}:${verifierStr}`;
    const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
    return Buffer.from(JSON.stringify({ claimSessionId, nonce, timestamp, verifier: verifierStr, sig })).toString('base64url');
}

function verifyOAuthStateToken(stateToken, secret, maxAgeMs = 15 * 60 * 1000, transactionStore = defaultOAuthTransactionStore) {
    if (!stateToken || typeof stateToken !== 'string') {
        throw failure('OAuth state token is missing.', 'MISSING_OAUTH_STATE');
    }

    // First check opaque server transaction store
    if (transactionStore) {
        const tx = transactionStore.getTransaction(stateToken);
        if (tx) {
            return {
                valid: true,
                claimSessionId: tx.claimSessionId,
                nonce: tx.nonce,
                codeVerifier: tx.codeVerifier,
                opaque: true,
            };
        }
    }

    // Fallback for HMAC token (testing / backward compatibility)
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(stateToken, 'base64url').toString('utf8'));
    } catch {
        throw failure('OAuth state token is malformed.', 'MALFORMED_OAUTH_STATE');
    }

    const { claimSessionId, nonce, timestamp, verifier = '', sig } = parsed;
    if (!claimSessionId || !nonce || !timestamp || !sig) {
        throw failure('OAuth state token is missing required envelope fields.', 'INVALID_OAUTH_STATE');
    }

    if (!secret) throw failure('Secret required to verify HMAC state token.', 'MISSING_SECRET');

    const expectedSig = crypto.createHmac('sha256', secret).update(`${claimSessionId}:${nonce}:${timestamp}:${verifier}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
        throw failure('OAuth state token signature mismatch.', 'INVALID_OAUTH_STATE_SIGNATURE');
    }

    if (Date.now() - timestamp > maxAgeMs) {
        throw failure('OAuth state token has expired.', 'EXPIRED_OAUTH_STATE');
    }

    return {
        valid: true,
        claimSessionId,
        nonce,
        codeVerifier: verifier || null,
        opaque: false,
    };
}

function createGoogleAuthUrl(env = process.env, claimSessionId, secret, {
    customVerifier = null,
    customNonce = null,
    transactionStore = defaultOAuthTransactionStore,
} = {}) {
    const config = validateAuthConfig(env);
    if (!config.configured) {
        throw failure(`Google OAuth cannot be initiated: ${config.reason}`, 'OAUTH_UNCONFIGURED');
    }

    const pkce = generatePkcePair();
    const codeVerifier = customVerifier || pkce.verifier;
    const codeChallenge = customVerifier
        ? crypto.createHash('sha256').update(customVerifier).digest('base64url')
        : pkce.challenge;

    const nonce = customNonce || crypto.randomBytes(16).toString('hex');

    let state;
    if (transactionStore) {
        const tx = transactionStore.createTransaction({
            claimSessionId,
            codeVerifier,
            nonce,
        });
        state = tx.state;
    } else {
        state = createOAuthStateToken(claimSessionId, secret || 'default-secret-fallback', { codeVerifier, customNonce: nonce });
    }

    const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID.trim(),
        redirect_uri: env.GOOGLE_REDIRECT_URI.trim(),
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'online',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
    });

    return {
        url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
        state,
        codeVerifier,
        nonce,
    };
}

async function exchangeAuthorizationCode({
    code,
    codeVerifier,
    env = process.env,
    fetchImpl = fetch,
}) {
    if (!code || typeof code !== 'string') throw failure('Missing authorization code.', 'MISSING_AUTH_CODE');
    if (!codeVerifier || typeof codeVerifier !== 'string') throw failure('Missing PKCE code verifier.', 'MISSING_CODE_VERIFIER');

    const config = validateAuthConfig(env);
    if (!config.configured) {
        throw failure(`Google OAuth cannot exchange code: ${config.reason}`, 'OAUTH_UNCONFIGURED');
    }

    const bodyParams = new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID.trim(),
        client_secret: env.GOOGLE_CLIENT_SECRET.trim(),
        redirect_uri: env.GOOGLE_REDIRECT_URI.trim(),
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
    });

    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
        },
        body: bodyParams.toString(),
    });

    if (!response.ok) {
        let errBody = '';
        try { errBody = await response.text(); } catch {}
        throw failure(`Google token exchange failed (${response.status}): ${errBody}`, 'TOKEN_EXCHANGE_FAILED');
    }

    const tokenData = await response.json();
    if (!tokenData.id_token) {
        throw failure('Google token response did not contain an id_token.', 'MISSING_ID_TOKEN');
    }

    return tokenData;
}

function parseJwtUnverified(tokenStr) {
    if (!tokenStr || typeof tokenStr !== 'string') throw failure('JWT string required.', 'INVALID_JWT');
    const parts = tokenStr.split('.');
    if (parts.length < 2) throw failure('Malformed JWT token.', 'MALFORMED_JWT');

    try {
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return { header, payload, signature: parts[2] || '' };
    } catch {
        throw failure('Failed to decode JWT base64url segments.', 'MALFORMED_JWT_JSON');
    }
}

async function verifyGoogleIdToken({
    idToken,
    clientId,
    expectedNonce = null,
    fetchImpl = fetch,
    now = Date.now,
}) {
    if (!idToken || typeof idToken !== 'string') throw failure('Missing id_token.', 'MISSING_ID_TOKEN');
    if (!clientId || typeof clientId !== 'string') throw failure('Expected Google client ID required.', 'MISSING_CLIENT_ID');

    const parsed = parseJwtUnverified(idToken);
    const { payload, header } = parsed;

    if (header.alg !== 'RS256') {
        throw failure(`Unsupported JWT algorithm: ${header.alg}`, 'UNSUPPORTED_ALGORITHM');
    }

    // 1. Issuer verification
    const validIssuers = ['https://accounts.google.com', 'accounts.google.com'];
    if (!validIssuers.includes(payload.iss)) {
        throw failure(`Invalid token issuer: ${payload.iss}`, 'INVALID_ISSUER');
    }

    // 2. Audience verification
    if (payload.aud !== clientId) {
        throw failure(`Token audience ${payload.aud} does not match expected client ID ${clientId}`, 'INVALID_AUDIENCE');
    }

    // 2b. Authorized party (azp) verification if present
    if (payload.azp && payload.azp !== clientId) {
        throw failure(`Token azp ${payload.azp} does not match expected client ID ${clientId}`, 'INVALID_AZP');
    }

    // 3. Expiration verification
    const currentTimeSec = Math.floor(now() / 1000);
    if (typeof payload.exp !== 'number' || currentTimeSec > payload.exp) {
        throw failure('Google id_token has expired.', 'EXPIRED_ID_TOKEN');
    }

    // 3b. Issued-at (iat) verification
    if (typeof payload.iat === 'number' && payload.iat > currentTimeSec + 300) {
        throw failure('Google id_token issued in the future.', 'INVALID_IAT');
    }

    // 4. Nonce verification if expected
    if (expectedNonce && payload.nonce !== expectedNonce) {
        throw failure(`Token nonce ${payload.nonce} does not match expected nonce ${expectedNonce}`, 'NONCE_MISMATCH');
    }

    // 5. Subject verification
    if (!payload.sub || typeof payload.sub !== 'string') {
        throw failure('Google id_token missing sub claim.', 'MISSING_SUB');
    }

    // Optional online validation check via Google tokeninfo
    try {
        const checkRes = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
        if (checkRes.ok) {
            const checkData = await checkRes.json();
            if (checkData.aud !== clientId || checkData.sub !== payload.sub) {
                throw failure('Online tokeninfo mismatch.', 'TOKENINFO_MISMATCH');
            }
        }
    } catch (e) {
        // Fallback offline validation check
    }

    return {
        valid: true,
        user: {
            sub: payload.sub,
            email: payload.email || null,
            emailVerified: Boolean(payload.email_verified),
            name: payload.name || null,
            picture: payload.picture || null,
        },
    };
}

function createSessionCookiePayload(user, secret, ttlSeconds = 86400) {
    if (!user || !user.sub) throw failure('Valid user profile required for session cookie.');
    const createdAt = Date.now();
    const expiresAt = createdAt + (ttlSeconds * 1000);
    const emailVerified = user.emailVerified === true;
    const data = `${user.sub}:${user.email || ''}:${user.name || ''}:${emailVerified ? '1' : '0'}:${createdAt}:${expiresAt}`;
    const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');

    return Buffer.from(JSON.stringify({
        sub: user.sub,
        email: user.email || null,
        emailVerified,
        name: user.name || null,
        createdAt,
        expiresAt,
        sig,
    })).toString('base64url');
}

function verifySessionCookiePayload(cookieValue, secret, now = Date.now) {
    if (!cookieValue || typeof cookieValue !== 'string') return null;
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(cookieValue, 'base64url').toString('utf8'));
    } catch {
        return null;
    }

    const { sub, email, emailVerified, name, createdAt, expiresAt, sig } = parsed;
    if (!sub || !createdAt || !expiresAt || !sig) return null;

    if (now() > expiresAt) return null;

    const data = `${sub}:${email || ''}:${name || ''}:${emailVerified === true ? '1' : '0'}:${createdAt}:${expiresAt}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
        return null;
    }

    return {
        sub,
        email: email || null,
        emailVerified: emailVerified === true,
        name: name || null,
        expiresAt,
    };
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
        const [k, v] = part.split('=').map((s) => s.trim());
        if (k && v !== undefined) cookies[k] = decodeURIComponent(v);
    }
    return cookies;
}

function serializeCookie(name, value, {
    maxAge = 86400,
    httpOnly = true,
    sameSite = 'Lax',
    path = '/',
    secure = false,
} = {}) {
    let str = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    if (maxAge !== undefined) str += `; Max-Age=${Math.floor(maxAge)}`;
    if (path) str += `; Path=${path}`;
    if (httpOnly) str += '; HttpOnly';
    if (sameSite) str += `; SameSite=${sameSite}`;
    if (secure) str += '; Secure';
    return str;
}

function createOwnershipChallenge({ sessionId, nearAccountId, secret }) {
    if (!sessionId || !nearAccountId || !secret) {
        throw failure('sessionId, nearAccountId, and secret are required for ownership challenge.');
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const message = `RELAY_LINK_ACCOUNT:${sessionId}:${nearAccountId}:${nonce}:${timestamp}`;
    const sig = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return {
        message,
        nonce,
        timestamp,
        challengeToken: Buffer.from(JSON.stringify({ message, nonce, timestamp, sig })).toString('base64url'),
    };
}

function verifyOwnershipChallenge({ challengeToken, secret, maxAgeMs = 15 * 60 * 1000 }) {
    if (!challengeToken || typeof challengeToken !== 'string') return false;
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(challengeToken, 'base64url').toString('utf8'));
    } catch {
        return false;
    }

    const { message, nonce, timestamp, sig } = parsed;
    if (!message || !nonce || !timestamp || !sig) return false;

    if (Date.now() - timestamp > maxAgeMs) return false;

    const expectedSig = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'));
}

function serializeNep413Payload({ message, recipient, nonce, callbackUrl = null }) {
    if (typeof message !== 'string') throw failure('NEP-413 message must be a string.');
    if (typeof recipient !== 'string') throw failure('NEP-413 recipient must be an account ID string.');

    let nonceBytes;
    if (Buffer.isBuffer(nonce) || nonce instanceof Uint8Array) {
        nonceBytes = Buffer.from(nonce);
    } else if (typeof nonce === 'string') {
        nonceBytes = Buffer.from(nonce, 'hex');
    } else if (Array.isArray(nonce)) {
        nonceBytes = Buffer.from(nonce);
    }
    if (!nonceBytes || nonceBytes.length !== 32) {
        throw failure('NEP-413 nonce must be exactly 32 bytes.');
    }

    const messageBytes = Buffer.from(message, 'utf8');
    const recipientBytes = Buffer.from(recipient, 'utf8');

    const tagBuf = Buffer.alloc(4);
    tagBuf.writeUInt32LE(NEP413_TAG, 0);

    const msgLenBuf = Buffer.alloc(4);
    msgLenBuf.writeUInt32LE(messageBytes.length, 0);

    const recLenBuf = Buffer.alloc(4);
    recLenBuf.writeUInt32LE(recipientBytes.length, 0);

    let callbackBuf;
    if (callbackUrl && typeof callbackUrl === 'string') {
        const cbBytes = Buffer.from(callbackUrl, 'utf8');
        const cbLenBuf = Buffer.alloc(4);
        cbLenBuf.writeUInt32LE(cbBytes.length, 0);
        callbackBuf = Buffer.concat([Buffer.from([1]), cbLenBuf, cbBytes]);
    } else {
        callbackBuf = Buffer.from([0]);
    }

    // NEP-413 Payload field order: message, nonce, recipient, callback_url
    // Prefixed by Borsh-serialized 4-byte LE tag: 2^31 + 413 = 2147484061
    const borshPayload = Buffer.concat([
        tagBuf,
        msgLenBuf,
        messageBytes,
        nonceBytes,
        recLenBuf,
        recipientBytes,
        callbackBuf,
    ]);

    const hash = crypto.createHash('sha256').update(borshPayload).digest();
    return {
        tag: NEP413_TAG,
        tagBytes: tagBuf,
        borshPayload,
        hash,
        hashHex: hash.toString('hex'),
    };
}

function decodeNearPublicKey(rawPublicKey) {
    if (!rawPublicKey || typeof rawPublicKey !== 'string') {
        throw failure('Invalid public key format.', 'INVALID_PUBLIC_KEY');
    }
    const parts = rawPublicKey.split(':');
    let curve = 'ed25519';
    let b58Str = rawPublicKey;
    if (parts.length === 2) {
        curve = parts[0].toLowerCase();
        b58Str = parts[1];
    }
    if (curve !== 'ed25519') {
        throw failure(`Unsupported public key curve: ${curve}. Only ed25519 is supported.`, 'UNSUPPORTED_CURVE');
    }
    let decoded;
    try {
        decoded = base58.decode(b58Str);
    } catch {
        throw failure('Public key is not valid base58.', 'INVALID_BASE58_KEY');
    }
    if (decoded.length !== 32) {
        throw failure(`Invalid public key byte length: ${decoded.length}, expected 32.`, 'INVALID_PUBLIC_KEY_LENGTH');
    }
    return Buffer.from(decoded);
}

function decodeNearSignature(rawSignature) {
    if (!rawSignature || typeof rawSignature !== 'string') {
        throw failure('Invalid signature format.', 'INVALID_SIGNATURE');
    }
    let sigStr = rawSignature;
    if (sigStr.startsWith('ed25519:')) sigStr = sigStr.slice('ed25519:'.length);

    let bytes = null;
    try {
        bytes = Buffer.from(base58.decode(sigStr));
    } catch {}

    if (!bytes || bytes.length !== 64) {
        try {
            const b64 = Buffer.from(sigStr, 'base64');
            if (b64.length === 64) bytes = b64;
        } catch {}
    }

    if (!bytes || bytes.length !== 64) {
        try {
            const hx = Buffer.from(sigStr, 'hex');
            if (hx.length === 64) bytes = hx;
        } catch {}
    }

    if (!bytes || bytes.length !== 64) {
        throw failure(`Invalid signature byte length: ${bytes ? bytes.length : 0}, expected 64.`, 'INVALID_SIGNATURE_LENGTH');
    }
    return bytes;
}

async function verifyNep413Signature({
    challenge,
    signature,
    publicKey,
    recipientAccountId,
    nearRpcUrl = null,
    fetchImpl = fetch,
    expectedTokenId = null,
    expectedContractId = null,
    expectedAppOrigin = null,
}) {
    if (!challenge) throw failure('Missing NEP-413 challenge.', 'MISSING_CHALLENGE');
    if (Date.now() > challenge.expiresAt) {
        throw failure('NEP-413 challenge has expired.', 'EXPIRED_CHALLENGE');
    }
    if (challenge.recipientAccountId !== recipientAccountId && challenge.recipient !== recipientAccountId) {
        throw failure(`Challenge recipient does not match linking account '${recipientAccountId}'.`, 'RECIPIENT_MISMATCH');
    }
    if (expectedTokenId && challenge.tokenId && challenge.tokenId !== expectedTokenId) {
        throw failure(`Challenge token '${challenge.tokenId}' does not match expected token '${expectedTokenId}'.`, 'TOKEN_MISMATCH');
    }
    if (expectedContractId && challenge.contractId && challenge.contractId !== expectedContractId) {
        throw failure(`Challenge contract '${challenge.contractId}' does not match expected contract '${expectedContractId}'.`, 'CONTRACT_MISMATCH');
    }
    if (expectedAppOrigin && challenge.appOrigin && challenge.appOrigin !== expectedAppOrigin) {
        throw failure(`Challenge origin '${challenge.appOrigin}' does not match expected origin '${expectedAppOrigin}'.`, 'ORIGIN_MISMATCH');
    }

    const pubKeyBytes = decodeNearPublicKey(publicKey);
    const sigBytes = decodeNearSignature(signature);
    const canonicalPubKey = `ed25519:${base58.encode(pubKeyBytes)}`;

    // Query on-chain access keys to verify that publicKey is authorized for recipientAccountId
    if (nearRpcUrl) {
        const rpcPayload = {
            jsonrpc: '2.0',
            id: 'view_access_keys',
            method: 'query',
            params: {
                request_type: 'view_access_key_list',
                account_id: recipientAccountId,
                finality: 'final',
            },
        };
        const candidateUrls = Array.from(new Set([
            nearRpcUrl,
            'https://rpc.testnet.near.org',
            'https://test.rpc.fastnear.com',
        ].filter(Boolean)));

        let rpcJson = null;
        let lastStatus = null;
        for (const url of candidateUrls) {
            try {
                const rpcRes = await fetchImpl(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(rpcPayload),
                });
                if (rpcRes.ok) {
                    const parsed = await rpcRes.json();
                    if (!parsed.error) {
                        rpcJson = parsed;
                        break;
                    }
                } else {
                    lastStatus = rpcRes.status;
                }
            } catch {
                // Try next endpoint on network failure
            }
        }
        if (!rpcJson && lastStatus === 429) {
            await new Promise((resolve) => setTimeout(resolve, 800));
            for (const url of ['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com']) {
                try {
                    const rpcRes = await fetchImpl(url, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(rpcPayload),
                    });
                    if (rpcRes.ok) {
                        const parsed = await rpcRes.json();
                        if (!parsed.error) {
                            rpcJson = parsed;
                            break;
                        }
                    } else {
                        lastStatus = rpcRes.status;
                    }
                } catch {}
            }
        }
        if (!rpcJson) {
            throw failure(`NEAR RPC error checking access keys (${lastStatus || 500}).`, 'RPC_ERROR');
        }
        if (rpcJson.error) {
            throw failure(`Failed to query account access keys: ${rpcJson.error.message || JSON.stringify(rpcJson.error)}`, 'ACCOUNT_KEY_QUERY_FAILED');
        }
        const keys = rpcJson.result?.keys || [];
        const matchingKey = keys.find((k) => k.public_key === canonicalPubKey);
        if (!matchingKey) {
            throw failure(`Public key ${canonicalPubKey} is not authorized for account ${recipientAccountId} on NEAR Testnet.`, 'PUBLIC_KEY_NOT_AUTHORIZED');
        }
        // NEP-413 specification strictly requires a FullAccess key
        if (matchingKey.access_key?.permission !== 'FullAccess') {
            throw failure(`Public key ${canonicalPubKey} for account ${recipientAccountId} is not a FullAccess key. NEP-413 requires a FullAccess key (found: ${JSON.stringify(matchingKey.access_key?.permission)}).`, 'FULL_ACCESS_KEY_REQUIRED');
        }
    }

    // Verify signature over the NEP-413 payload
    const { hash } = serializeNep413Payload({
        message: challenge.message,
        recipient: challenge.recipientAccountId || challenge.recipient,
        nonce: challenge.nonceBytes || Buffer.from(challenge.nonceHex, 'hex'),
        callbackUrl: challenge.callbackUrl || null,
    });

    const isValid = nacl.sign.detached.verify(hash, sigBytes, pubKeyBytes);
    if (!isValid) {
        throw failure('Cryptographic signature verification failed. Recipient account ownership could not be verified.', 'INVALID_SIGNATURE');
    }

    return {
        verified: true,
        accountId: recipientAccountId,
        publicKey: canonicalPubKey,
    };
}

function validateRecipientAccountResolution({
    authenticatedGoogleSub = null,
    resolvedNearAccountId = null,
    accountExistsOnChain = false,
}) {
    if (!resolvedNearAccountId) {
        return {
            ready: false,
            recipientAccountId: null,
            status: 'MISSING_RECIPIENT_ACCOUNT',
            message: 'A valid NEAR recipient account ID has not been resolved for this recipient.',
        };
    }

    if (!validateNearAccountId(resolvedNearAccountId)) {
        return {
            ready: false,
            recipientAccountId: resolvedNearAccountId,
            status: 'INVALID_ACCOUNT_FORMAT',
            message: `The resolved recipient account '${resolvedNearAccountId}' is not a valid NEAR account ID.`,
        };
    }

    if (!accountExistsOnChain) {
        return {
            ready: false,
            recipientAccountId: resolvedNearAccountId,
            status: 'ACCOUNT_NOT_PROVISIONED',
            message: `Recipient account '${resolvedNearAccountId}' is valid format but does not yet exist on NEAR Testnet. Provision account via faucet/wallet before transferring NFT.`,
        };
    }

    return {
        ready: true,
        recipientAccountId: resolvedNearAccountId,
        status: 'READY_FOR_TRANSFER',
        message: `Recipient account '${resolvedNearAccountId}' is verified on NEAR Testnet. Ready for NFT ownership transfer.`,
    };
}

module.exports = {
    ChallengeStore,
    OAuthTransactionStore,
    ServerSessionStore,
    createGoogleAuthUrl,
    createOAuthStateToken,
    createOwnershipChallenge,
    createSessionCookiePayload,
    decodeNearPublicKey,
    decodeNearSignature,
    defaultChallengeStore,
    defaultOAuthTransactionStore,
    defaultServerSessionStore,
    exchangeAuthorizationCode,
    generatePkcePair,
    parseCookies,
    serializeCookie,
    serializeNep413Payload,
    validateAuthConfig,
    validateNearAccountId,
    validateRecipientAccountResolution,
    verifyGoogleIdToken,
    verifyNep413Signature,
    verifyOAuthStateToken,
    verifyOwnershipChallenge,
    verifySessionCookiePayload,
};
