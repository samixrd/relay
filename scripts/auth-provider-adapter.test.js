'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createGoogleAuthUrl,
    createOAuthStateToken,
    validateAuthConfig,
    validateNearAccountId,
    validateRecipientAccountResolution,
    verifyOAuthStateToken,
} = require('./auth-provider-adapter');

const TEST_SECRET = 'auth-adapter-secret-key-32-chars!';

test('validateAuthConfig identifies missing credentials and provides honest status', () => {
    // Missing credentials
    const unconfigured = validateAuthConfig({});
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.status, 'unconfigured');
    assert.deepEqual(unconfigured.missing, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']);
    assert.match(unconfigured.reason, /No fake login is simulated/);

    // Configured credentials
    const configured = validateAuthConfig({
        GOOGLE_CLIENT_ID: 'mock-client-id.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'mock-secret',
        GOOGLE_REDIRECT_URI: 'https://relay.app/api/auth/callback',
    });
    assert.equal(configured.configured, true);
    assert.equal(configured.status, 'configured');
    assert.equal(configured.missing.length, 0);
    assert.equal(configured.reason, null);
});

test('createGoogleAuthUrl throws when credentials are not configured', () => {
    assert.throws(
        () => createGoogleAuthUrl({}, 'session-123', TEST_SECRET),
        /Google OAuth cannot be initiated/
    );
});

test('createGoogleAuthUrl builds valid Google authorization URL when configured', () => {
    const env = {
        GOOGLE_CLIENT_ID: '12345.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_REDIRECT_URI: 'https://relay.app/api/auth/callback',
    };
    const result = createGoogleAuthUrl(env, 'session-123', TEST_SECRET);
    assert.ok(result.url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
    assert.ok(result.url.includes('client_id=12345.apps.googleusercontent.com'));
    assert.ok(result.url.includes('redirect_uri=https%3A%2F%2Frelay.app%2Fapi%2Fauth%2Fcallback'));
    assert.ok(result.state);
    // CRITICAL: PKCE verifier must NOT be exposed in browser-visible URL
    assert.equal(result.url.includes(result.codeVerifier), false, 'PKCE verifier must not appear in the URL');
});

test('OAuth state token generation and verification protects against tampering', () => {
    const stateToken = createOAuthStateToken('session-456', TEST_SECRET);
    assert.ok(stateToken);

    // Valid check
    const verified = verifyOAuthStateToken(stateToken, TEST_SECRET);
    assert.equal(verified.valid, true);
    assert.equal(verified.claimSessionId, 'session-456');

    // Wrong secret rejected
    assert.throws(
        () => verifyOAuthStateToken(stateToken, 'wrong-secret-key-that-does-not-match'),
        /signature mismatch/
    );

    // Malformed token rejected
    assert.throws(
        () => verifyOAuthStateToken('not-valid-base64', TEST_SECRET),
        /malformed/
    );
});

test('validateNearAccountId validates named and implicit account identifiers', () => {
    assert.equal(validateNearAccountId('alice.testnet'), true);
    assert.equal(validateNearAccountId('relay-test-1.relay.spellman.testnet'), true);
    assert.equal(validateNearAccountId('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), true);

    // Invalid identifiers
    assert.equal(validateNearAccountId(''), false);
    assert.equal(validateNearAccountId('Alice.testnet'), false); // uppercase invalid
    assert.equal(validateNearAccountId('bad@account'), false);
    assert.equal(validateNearAccountId('a'), false); // too short
});

test('validateRecipientAccountResolution rejects unprovisioned or invalid recipient accounts', () => {
    // Missing recipient account
    const missing = validateRecipientAccountResolution({
        resolvedNearAccountId: null,
    });
    assert.equal(missing.ready, false);
    assert.equal(missing.status, 'MISSING_RECIPIENT_ACCOUNT');

    // Invalid format
    const invalid = validateRecipientAccountResolution({
        resolvedNearAccountId: 'INVALID_CAPS.testnet',
    });
    assert.equal(invalid.ready, false);
    assert.equal(invalid.status, 'INVALID_ACCOUNT_FORMAT');

    // Account not yet provisioned on-chain
    const unprovisioned = validateRecipientAccountResolution({
        resolvedNearAccountId: 'friend.testnet',
        accountExistsOnChain: false,
    });
    assert.equal(unprovisioned.ready, false);
    assert.equal(unprovisioned.status, 'ACCOUNT_NOT_PROVISIONED');
    assert.match(unprovisioned.message, /does not yet exist on NEAR Testnet/);

    // Fully verified and ready
    const ready = validateRecipientAccountResolution({
        resolvedNearAccountId: 'friend.testnet',
        accountExistsOnChain: true,
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.status, 'READY_FOR_TRANSFER');
    assert.equal(ready.recipientAccountId, 'friend.testnet');
});

test('generatePkcePair creates valid verifier and challenge', () => {
    const { generatePkcePair } = require('./auth-provider-adapter');
    const { verifier, challenge } = generatePkcePair();
    assert.ok(verifier && verifier.length >= 43);
    assert.ok(challenge && challenge.length >= 43);
});

test('verifyGoogleIdToken verifies issuer, audience, expiry, and nonce', async () => {
    const { verifyGoogleIdToken } = require('./auth-provider-adapter');
    const clientId = 'my-client-id.apps.googleusercontent.com';

    // Helper to forge a test JWT
    function forgeJwt(header, payload) {
        const h = Buffer.from(JSON.stringify(header)).toString('base64url');
        const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return `${h}.${p}.dummy_signature`;
    }

    const validPayload = {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-sub-12345',
        email: 'friend@example.com',
        email_verified: true,
        name: 'Friend User',
        nonce: 'test-nonce-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
    };

    // Valid token
    const validJwt = forgeJwt({ alg: 'RS256', typ: 'JWT' }, validPayload);
    const mockFetch = async () => ({ ok: true, json: async () => ({ aud: clientId, sub: 'google-sub-12345' }) });
    const verified = await verifyGoogleIdToken({
        idToken: validJwt,
        clientId,
        expectedNonce: 'test-nonce-1',
        fetchImpl: mockFetch,
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.user.sub, 'google-sub-12345');
    assert.equal(verified.user.email, 'friend@example.com');

    // Mismatched audience
    await assert.rejects(
        verifyGoogleIdToken({ idToken: validJwt, clientId: 'wrong-client-id', fetchImpl: mockFetch }),
        /audience/
    );

    // Expired token
    const expiredPayload = { ...validPayload, exp: Math.floor(Date.now() / 1000) - 100 };
    const expiredJwt = forgeJwt({ alg: 'RS256', typ: 'JWT' }, expiredPayload);
    await assert.rejects(
        verifyGoogleIdToken({ idToken: expiredJwt, clientId, fetchImpl: mockFetch }),
        /expired/
    );

    // Mismatched nonce
    await assert.rejects(
        verifyGoogleIdToken({ idToken: validJwt, clientId, expectedNonce: 'different-nonce', fetchImpl: mockFetch }),
        /nonce/
    );
});

test('session cookie serialization, parsing, and tamper verification', () => {
    const {
        createSessionCookiePayload,
        parseCookies,
        serializeCookie,
        verifySessionCookiePayload,
    } = require('./auth-provider-adapter');

    const user = { sub: 'user-999', email: 'test@example.com', name: 'Test User' };
    const payload = createSessionCookiePayload(user, TEST_SECRET, 3600);
    assert.ok(payload);

    // Serialize to cookie string
    const cookieStr = serializeCookie('relay_auth_session', payload, { maxAge: 3600, secure: true });
    assert.ok(cookieStr.includes('relay_auth_session='));
    assert.ok(cookieStr.includes('HttpOnly'));
    assert.ok(cookieStr.includes('SameSite=Lax'));

    // Parse cookie string
    const parsed = parseCookies(cookieStr);
    assert.equal(parsed.relay_auth_session, payload);

    // Verify valid session cookie
    const verified = verifySessionCookiePayload(payload, TEST_SECRET);
    assert.equal(verified.sub, 'user-999');
    assert.equal(verified.email, 'test@example.com');

    // Tampered session cookie
    assert.equal(verifySessionCookiePayload(payload, 'wrong-secret'), null);
    assert.equal(verifySessionCookiePayload('tampered', TEST_SECRET), null);
});

test('ownership challenge generation and verification', () => {
    const { createOwnershipChallenge, verifyOwnershipChallenge } = require('./auth-provider-adapter');
    const challenge = createOwnershipChallenge({
        sessionId: 'session-789',
        nearAccountId: 'recipient.testnet',
        secret: TEST_SECRET,
    });
    assert.ok(challenge.challengeToken);
    assert.ok(challenge.message.includes('recipient.testnet'));

    const verified = verifyOwnershipChallenge({
        challengeToken: challenge.challengeToken,
        secret: TEST_SECRET,
    });
    assert.equal(verified, true);

    const wrong = verifyOwnershipChallenge({
        challengeToken: challenge.challengeToken,
        secret: 'wrong-secret',
    });
    assert.equal(wrong, false);
});

test('OAuthTransactionStore creates, retrieves, and atomically consumes transactions', () => {
    const { OAuthTransactionStore } = require('./auth-provider-adapter');
    const store = new OAuthTransactionStore(60000);
    const tx = store.createTransaction({
        claimSessionId: 'cs-1',
        codeVerifier: 'verifier-12345678901234567890123456789012',
        nonce: 'nonce-1',
    });
    assert.ok(tx.state);
    assert.equal(tx.claimSessionId, 'cs-1');

    // Retrieved
    const retrieved = store.getTransaction(tx.state);
    assert.equal(retrieved.codeVerifier, 'verifier-12345678901234567890123456789012');

    // Consumed atomically
    const consumed = store.consumeTransaction(tx.state);
    assert.equal(consumed.state, tx.state);

    // Cannot be consumed twice (replay prevention)
    assert.equal(store.consumeTransaction(tx.state), null);
    assert.equal(store.getTransaction(tx.state), null);
});

test('ServerSessionStore manages server sessions with revocation', () => {
    const { ServerSessionStore } = require('./auth-provider-adapter');
    const store = new ServerSessionStore(3600000);
    const session = store.createSession({ sub: 'google-sub-abc', email: 'alice@example.com' });
    assert.ok(session.sessionId);

    // Retrieve
    const active = store.getSession(session.sessionId);
    assert.equal(active.sub, 'google-sub-abc');

    // Revoke
    store.revokeSession(session.sessionId);
    assert.equal(store.getSession(session.sessionId), null);
});

test('NEP-413 challenge creation, payload serialization, and cryptographic verification', async () => {
    const {
        ChallengeStore,
        decodeNearPublicKey,
        serializeNep413Payload,
        verifyNep413Signature,
    } = require('./auth-provider-adapter');
    const nacl = require('tweetnacl');
    const { base58 } = require('@scure/base');

    const keyPair = nacl.sign.keyPair();
    const pubKeyBase58 = `ed25519:${base58.encode(keyPair.publicKey)}`;

    const store = new ChallengeStore(60000);
    const challenge = store.createChallenge({
        claimSessionId: 'sess-100',
        recipientSub: 'sub-xyz',
        tokenId: 'relay-test-1',
        recipientAccountId: 'alice.testnet',
        appOrigin: 'https://relay.app',
    });
    assert.ok(challenge.challengeId);
    assert.ok(challenge.nonceHex);

    // Compute NEP-413 payload hash
    const { hash } = serializeNep413Payload({
        message: challenge.message,
        recipient: challenge.recipientAccountId,
        nonce: challenge.nonceBytes,
    });

    // Sign with recipient's Ed25519 secret key
    const sigBytes = nacl.sign.detached(hash, keyPair.secretKey);
    const sigBase58 = base58.encode(sigBytes);

    // Mock RPC returning the active public key
    const mockRpcFetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                keys: [{ public_key: pubKeyBase58, access_key: { permission: 'FullAccess' } }],
            },
        }),
    });

    // 1. Valid verification
    const verified = await verifyNep413Signature({
        challenge,
        signature: sigBase58,
        publicKey: pubKeyBase58,
        recipientAccountId: 'alice.testnet',
        nearRpcUrl: 'https://rpc.testnet.near.org',
        fetchImpl: mockRpcFetch,
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.accountId, 'alice.testnet');

    // 2. Reject wrong recipient account
    await assert.rejects(
        verifyNep413Signature({
            challenge,
            signature: sigBase58,
            publicKey: pubKeyBase58,
            recipientAccountId: 'mallory.testnet',
            fetchImpl: mockRpcFetch,
        }),
        /does not match/
    );

    // 3. Reject public key not authorized on account
    const unauthFetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                keys: [{ public_key: 'ed25519:otherKey1111111111111111111111111111111111111', access_key: { permission: 'FullAccess' } }],
            },
        }),
    });
    await assert.rejects(
        verifyNep413Signature({
            challenge,
            signature: sigBase58,
            publicKey: pubKeyBase58,
            recipientAccountId: 'alice.testnet',
            nearRpcUrl: 'https://rpc.testnet.near.org',
            fetchImpl: unauthFetch,
        }),
        /not authorized/
    );

    // 4. Reject tampered signature
    const badSig = base58.encode(Buffer.alloc(64, 9));
    await assert.rejects(
        verifyNep413Signature({
            challenge,
            signature: badSig,
            publicKey: pubKeyBase58,
            recipientAccountId: 'alice.testnet',
            nearRpcUrl: 'https://rpc.testnet.near.org',
            fetchImpl: mockRpcFetch,
        }),
        /verification failed/
    );

    // 5. Reject expired challenge
    const expiredChallenge = { ...challenge, expiresAt: Date.now() - 1000 };
    await assert.rejects(
        verifyNep413Signature({
            challenge: expiredChallenge,
            signature: sigBase58,
            publicKey: pubKeyBase58,
            recipientAccountId: 'alice.testnet',
            fetchImpl: mockRpcFetch,
        }),
        /expired/
    );

    // 6. Reject FunctionCall key (NEP-413 Full Access Key requirement)
    const functionCallFetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                keys: [{
                    public_key: pubKeyBase58,
                    access_key: {
                        nonce: 1,
                        permission: {
                            FunctionCall: {
                                allowance: '1000000',
                                receiver_id: 'relay.spellman.testnet',
                                method_names: [],
                            },
                        },
                    },
                }],
            },
        }),
    });
    await assert.rejects(
        verifyNep413Signature({
            challenge,
            signature: sigBase58,
            publicKey: pubKeyBase58,
            recipientAccountId: 'alice.testnet',
            nearRpcUrl: 'https://rpc.testnet.near.org',
            fetchImpl: functionCallFetch,
        }),
        { code: 'FULL_ACCESS_KEY_REQUIRED' }
    );
});

test('NEP-413 protocol specification: exact tag, little-endian prefix, Borsh payload field order, and deterministic test vectors', () => {
    const { serializeNep413Payload } = require('./auth-provider-adapter');
    const crypto = require('node:crypto');

    // 1. Tag value verification: 2^31 + 413 = 2147484061 (0x8000019d)
    const expectedTag = 2147484061;
    const expectedTagHex = '9d010080'; // 4-byte little endian

    // 2. Deterministic test vector without callbackUrl
    const vector1 = serializeNep413Payload({
        message: 'relay-ownership-challenge',
        recipient: 'relay.spellman.testnet',
        nonce: Buffer.alloc(32, 1),
        callbackUrl: null,
    });

    assert.equal(vector1.tag, expectedTag);
    assert.equal(vector1.tagBytes.toString('hex'), expectedTagHex);
    assert.equal(vector1.borshPayload.length, 92);
    assert.equal(
        vector1.borshPayload.toString('hex'),
        '9d0100801900000072656c61792d6f776e6572736869702d6368616c6c656e676501010101010101010101010101010101010101010101010101010101010101011600000072656c61792e7370656c6c6d616e2e746573746e657400'
    );
    assert.equal(
        vector1.hashHex,
        '776d1ca101b048e5f1f7e4675cfcbac3b71850cbcfc1137ac8c7c475c51babde'
    );

    // Verify field order: tag (0..4), message len (4..8), message (8..33), nonce (33..65), recipient len (65..69), recipient (69..91), callback (91..92)
    assert.equal(vector1.borshPayload.subarray(0, 4).toString('hex'), '9d010080'); // tag
    assert.equal(vector1.borshPayload.readUInt32LE(4), 25); // message length
    assert.equal(vector1.borshPayload.subarray(8, 33).toString('utf8'), 'relay-ownership-challenge');
    assert.equal(vector1.borshPayload.subarray(33, 65).toString('hex'), Buffer.alloc(32, 1).toString('hex')); // nonce
    assert.equal(vector1.borshPayload.readUInt32LE(65), 22); // recipient length
    assert.equal(vector1.borshPayload.subarray(69, 91).toString('utf8'), 'relay.spellman.testnet');
    assert.equal(vector1.borshPayload.subarray(91, 92).toString('hex'), '00'); // callback None

    // 3. Deterministic test vector with callbackUrl
    const vector2 = serializeNep413Payload({
        message: 'relay-ownership-challenge',
        recipient: 'relay.spellman.testnet',
        nonce: Buffer.alloc(32, 1),
        callbackUrl: 'https://relay.app/callback',
    });
    assert.equal(vector2.borshPayload.length, 122);
    assert.equal(
        vector2.borshPayload.toString('hex'),
        '9d0100801900000072656c61792d6f776e6572736869702d6368616c6c656e676501010101010101010101010101010101010101010101010101010101010101011600000072656c61792e7370656c6c6d616e2e746573746e6574011a00000068747470733a2f2f72656c61792e6170702f63616c6c6261636b'
    );
    assert.equal(
        vector2.hashHex,
        '63fc899c57b0127616ee79185c08704ce005306b725ff47faa1d160e2b31782c'
    );

    // 4. Nonce length enforcement: must be exactly 32 bytes
    assert.throws(() => {
        serializeNep413Payload({
            message: 'test',
            recipient: 'alice.testnet',
            nonce: Buffer.alloc(16, 1), // 16 bytes is invalid
        });
    }, /exactly 32 bytes/);

    assert.throws(() => {
        serializeNep413Payload({
            message: 'test',
            recipient: 'alice.testnet',
            nonce: Buffer.alloc(33, 1), // 33 bytes is invalid
        });
    }, /exactly 32 bytes/);
});

test('verifyGoogleIdToken checks azp and iat claims', async () => {
    const { verifyGoogleIdToken } = require('./auth-provider-adapter');
    const clientId = 'my-client-id.apps.googleusercontent.com';

    function forgeJwt(header, payload) {
        const h = Buffer.from(JSON.stringify(header)).toString('base64url');
        const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return `${h}.${p}.dummy_signature`;
    }

    const validPayload = {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-sub-12345',
        email: 'friend@example.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000) - 10,
    };
    const mockFetch = async () => ({ ok: true, json: async () => ({ aud: clientId, sub: 'google-sub-12345' }) });

    // Valid with matching azp
    const jwtWithAzp = forgeJwt({ alg: 'RS256' }, { ...validPayload, azp: clientId });
    const verified = await verifyGoogleIdToken({ idToken: jwtWithAzp, clientId, fetchImpl: mockFetch });
    assert.equal(verified.valid, true);

    // Reject mismatched azp
    const jwtWithBadAzp = forgeJwt({ alg: 'RS256' }, { ...validPayload, azp: 'attacker-client-id' });
    await assert.rejects(
        verifyGoogleIdToken({ idToken: jwtWithBadAzp, clientId, fetchImpl: mockFetch }),
        /azp/
    );

    // Reject future iat
    const jwtWithFutureIat = forgeJwt({ alg: 'RS256' }, { ...validPayload, iat: Math.floor(Date.now() / 1000) + 1000 });
    await assert.rejects(
        verifyGoogleIdToken({ idToken: jwtWithFutureIat, clientId, fetchImpl: mockFetch }),
        /future/
    );
});
