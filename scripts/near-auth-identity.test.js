'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
    AUTH_CLIENT_ID,
    AUTH_ISSUER,
    createJwksCache,
    deriveFastAuthPath,
    deriveUserAccountId,
    verifyNearAuthIdentity,
} = require('./near-auth-identity');

function base64url(value) {
    return Buffer.from(value).toString('base64url');
}

function createSigner(kid = 'test-key-1') {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
    return {
        kid,
        jwk,
        sign(claims, headerOverrides = {}) {
            const header = { alg: 'RS256', typ: 'JWT', kid, ...headerOverrides };
            const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
            const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
            return `${signingInput}.${signature.toString('base64url')}`;
        },
    };
}

function claimsFor(sub = 'google-oauth2|1234567890', overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    return {
        iss: AUTH_ISSUER,
        aud: AUTH_CLIENT_ID,
        sub,
        email: 'Ada@Example.com',
        email_verified: true,
        name: 'Ada Lovelace',
        iat: now - 30,
        exp: now + 3600,
        ...overrides,
    };
}

function jwksFor(signer) {
    return {
        async get(kid) {
            return kid === signer.kid ? signer.jwk : null;
        },
    };
}

function fakeMpc(publicKey) {
    const calls = [];
    return {
        calls,
        async callFunction(input) {
            calls.push(input);
            return publicKey;
        },
    };
}

test('verifies a signed RS256 ID token and binds the MPC key to the identity', async () => {
    const signer = createSigner();
    const publicKey = 'ed25519:8QXQ2X5sCwY5oRb8fW7gZ2Ck5sXf3nF1uK8m4V6zY7wD';
    const mpc = fakeMpc(publicKey);
    const token = signer.sign(claimsFor('google-oauth2|987654'));

    const identity = await verifyNearAuthIdentity({
        idToken: token,
        publicKey,
        parentAccountId: 'relay.spellman.testnet',
        jwks: jwksFor(signer),
        callFunction: mpc.callFunction,
    });

    assert.equal(identity.email, 'ada@example.com');
    assert.equal(identity.emailVerified, true);
    assert.equal(identity.sub, 'google-oauth2|987654');
    assert.equal(identity.path, deriveFastAuthPath('google-oauth2|987654'));
    assert.equal(identity.accountId, deriveUserAccountId('google-oauth2|987654', 'relay.spellman.testnet'));
    assert.match(identity.accountId, /^u-[0-9a-f]{16}\.relay\.spellman\.testnet$/);
    assert.equal(mpc.calls.length, 1);
    assert.deepEqual(mpc.calls[0].args, {
        path: identity.path,
        predecessor: 'fast-auth.testnet',
        domain_id: 1,
    });
});

test('rejects a tampered ID token', async () => {
    const signer = createSigner();
    const token = signer.sign(claimsFor());
    const [header, payload, signature] = token.split('.');
    const tamperedClaims = { ...claimsFor('google-oauth2|attacker') };
    const tampered = `${header}.${base64url(JSON.stringify(tamperedClaims))}.${signature}`;

    await assert.rejects(
        verifyNearAuthIdentity({
            idToken: tampered,
            publicKey: 'ed25519:8QXQ2X5sCwY5oRb8fW7gZ2Ck5sXf3nF1uK8m4V6zY7wD',
            jwks: jwksFor(signer),
            callFunction: fakeMpc('ed25519:8QXQ2X5sCwY5oRb8fW7gZ2Ck5sXf3nF1uK8m4V6zY7wD').callFunction,
        }),
        /signature is invalid/i,
    );
});

test('rejects expired, wrong-audience, and unverified-email tokens', async () => {
    const signer = createSigner();
    const publicKey = 'ed25519:8QXQ2X5sCwY5oRb8fW7gZ2Ck5sXf3nF1uK8m4V6zY7wD';
    const run = (claims) => verifyNearAuthIdentity({
        idToken: signer.sign(claims),
        publicKey,
        jwks: jwksFor(signer),
        callFunction: fakeMpc(publicKey).callFunction,
    });

    await assert.rejects(run(claimsFor(undefined, { exp: Math.floor(Date.now() / 1000) - 120 })), /expired/i);
    await assert.rejects(run(claimsFor(undefined, { aud: 'some-other-client' })), /audience/i);
    await assert.rejects(run(claimsFor(undefined, { email_verified: false })), /not verified/i);
    await assert.rejects(run(claimsFor(undefined, { email: '' })), /email address/i);
});

test('rejects a client-supplied key that is not the MPC key for the identity', async () => {
    const signer = createSigner();
    const derived = 'ed25519:8QXQ2X5sCwY5oRb8fW7gZ2Ck5sXf3nF1uK8m4V6zY7wD';
    const claimed = 'ed25519:5B7vX9bQmZ4k8rTn2cW1yF6hJ3pLsD7gA9eU2iQ4mN6';
    await assert.rejects(
        verifyNearAuthIdentity({
            idToken: signer.sign(claimsFor()),
            publicKey: claimed,
            jwks: jwksFor(signer),
            callFunction: fakeMpc(derived).callFunction,
        }),
        /not the MPC key/i,
    );
});

test('account derivation is deterministic and distinct per subject', () => {
    const a = deriveUserAccountId('google-oauth2|1', 'relay.spellman.testnet');
    const b = deriveUserAccountId('google-oauth2|2', 'relay.spellman.testnet');
    assert.equal(a, deriveUserAccountId('google-oauth2|1', 'relay.spellman.testnet'));
    assert.notEqual(a, b);
    assert.equal(deriveFastAuthPath('google-oauth2|1'), 'jwt#https://login.testnet.fast-auth.com/#google-oauth2|1');
});

test('JWKS cache refetches once for an unknown key id', async () => {
    const first = createSigner('key-a');
    const second = createSigner('key-b');
    let fetches = 0;
    const fetchImpl = async () => {
        fetches += 1;
        return {
            ok: true,
            async json() {
                return { keys: fetches === 1 ? [first.jwk] : [first.jwk, second.jwk] };
            },
        };
    };
    const cache = createJwksCache({ fetchImpl, now: () => 1000 });
    assert.equal((await cache.get('key-a')).kid, 'key-a');
    assert.equal((await cache.get('key-b')).kid, 'key-b');
    assert.equal(fetches, 2);
    assert.equal((await cache.get('key-b')).kid, 'key-b');
    assert.equal(fetches, 2);
});
