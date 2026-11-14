'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { KeyPair, PublicKey, actions, createTransaction, encodeTransaction } = require('near-api-js');

const {
    AUTH_GUARD_ID,
    AUTH_ISSUER,
    AUTH_SIGNING_AUDIENCE,
} = require('./near-auth-identity');
const {
    SponsorBudget,
    createNearAuthRelayer,
    extractAuthSignature,
    outcomeFailed,
    transactionBytes,
    validateSignatureRequest,
    verifyUserSignature,
} = require('./near-auth-relayer');

function fakeJwt(claims) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'kid' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.signature`;
}

function signingRequest(overrides = {}) {
    const bytes = [1, 2, 3, 4];
    const now = Math.floor(Date.now() / 1000);
    return {
        guardId: AUTH_GUARD_ID,
        verifyPayload: fakeJwt({
            iss: AUTH_ISSUER,
            aud: AUTH_SIGNING_AUDIENCE,
            sub: 'google-oauth2|123',
            exp: now + 600,
            fatxn: bytes,
            ...overrides.claims,
        }),
        signPayload: overrides.signPayload || bytes,
    };
}

test('accepts a well-formed Auth0 signing request bound to the payload', () => {
    const request = signingRequest();
    const result = validateSignatureRequest(request);
    assert.equal(result.sub, 'google-oauth2|123');
    assert.deepEqual([...result.payload], [1, 2, 3, 4]);
});

test('rejects a signing request for a different transaction, guard, audience, or expired token', () => {
    assert.throws(
        () => validateSignatureRequest({ ...signingRequest(), signPayload: [1, 2, 3, 5] }),
        /does not match/i,
    );
    assert.throws(
        () => validateSignatureRequest({ ...signingRequest(), guardId: 'jwt#https://evil.example/' }),
        /unexpected Auth0 guard/i,
    );
    assert.throws(
        () => validateSignatureRequest(signingRequest({ claims: { aud: 'other-service' } })),
        /audience is unexpected/i,
    );
    assert.throws(
        () => validateSignatureRequest(signingRequest({ claims: { iss: 'https://evil.example/' } })),
        /issuer is unexpected/i,
    );
    assert.throws(
        () => validateSignatureRequest(signingRequest({ claims: { exp: 1 } })),
        /expired/i,
    );
});

test('verifies an ed25519 MPC signature over the exact transaction bytes', () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const transaction = createTransaction(
        'u-abc.relay.spellman.testnet',
        keyPair.getPublicKey(),
        'relay.spellman.testnet',
        1n,
        [actions.functionCall('relay_use_credit', { token_id: 'relay-1' }, 30n * 10n ** 12n, 0n)],
        Buffer.alloc(32, 9),
    );
    const bytes = transactionBytes(transaction);
    const digest = crypto.createHash('sha256').update(bytes).digest();
    const signature = keyPair.sign(digest).signature;

    assert.equal(
        verifyUserSignature({
            bytes,
            signature: Buffer.from(signature),
            publicKey: keyPair.getPublicKey().toString(),
        }),
        true,
    );

    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(
        () => verifyUserSignature({
            bytes: tampered,
            signature: Buffer.from(signature),
            publicKey: keyPair.getPublicKey().toString(),
        }),
        /does not verify/i,
    );
});

test('extracts the EdDSA signature from FastAuth receipt outcomes', () => {
    const signature = Array.from({ length: 64 }, (_, index) => index % 256);
    const success = Buffer.from(JSON.stringify({ scheme: 'EdDSA', signature })).toString('base64');
    const result = {
        receipts_outcome: [
            { outcome: { status: { SuccessValue: '' } } },
            { outcome: { status: { SuccessValue: success } } },
        ],
    };
    const recovered = extractAuthSignature(result);
    assert.ok(Buffer.isBuffer(recovered));
    assert.deepEqual([...recovered], signature);
});

test('detects failed outcomes and non-final status', () => {
    assert.equal(outcomeFailed({ final_execution_status: 'FINAL', receipts_outcome: [] }), false);
    assert.equal(outcomeFailed({
        final_execution_status: 'FINAL',
        receipts_outcome: [{ outcome: { status: { Failure: { ActionError: {} } } } }],
    }), true);
    assert.equal(outcomeFailed({ final_execution_status: 'EXECUTED_OPTIMISTIC', receipts_outcome: [] }), false);
});

test('transaction bytes round-trip through the near-api-js decoder', () => {
    const { decodeTransaction } = require('near-api-js');
    const keyPair = KeyPair.fromRandom('ed25519');
    const transaction = createTransaction(
        'u-abc.relay.spellman.testnet',
        PublicKey.from(keyPair.getPublicKey().toString()),
        'relay.spellman.testnet',
        7n,
        [actions.transfer(1n)],
        Buffer.alloc(32, 3),
    );
    const encoded = transactionBytes(transaction);
    const decoded = decodeTransaction(encoded);
    assert.equal(decoded.signerId, 'u-abc.relay.spellman.testnet');
    assert.equal(decoded.nonce, 7n);
    assert.deepEqual(Buffer.from(encodeTransaction(decoded)), encoded);
});

test('prepareTransaction decodes the base58 block hash to exactly 32 bytes', async () => {
    // Regression: NEAR RPC returns header.hash as base58. Decoding it as
    // base64 produced 33 bytes and every Google-mode transaction failed with
    // "Array length 33 does not match schema length 32 at value.blockHash".
    const signerKey = KeyPair.fromRandom('ed25519');
    const sponsorKey = KeyPair.fromRandom('ed25519');
    const relayer = createNearAuthRelayer({
        sponsorAccountId: 'relay.spellman.testnet',
        sponsorPrivateKey: sponsorKey.toString(),
        provider: {
            viewAccessKey: async () => ({ nonce: 7 }),
            viewBlock: async () => ({ header: { hash: 'FfRdDQa8SEmFQXDkEzXPbQkasKULNT89GmdEY8i6uxY2' } }),
        },
    });
    const prepared = await relayer.prepareTransaction({
        signerId: 'u-abc.relay.spellman.testnet',
        publicKey: signerKey.getPublicKey().toString(),
        receiverId: 'relay.spellman.testnet',
        actionList: [actions.transfer(1n)],
    });
    assert.equal(prepared.transaction.blockHash.length, 32);
    assert.ok(prepared.bytes.length > 0);
});

test('sponsor account is built with a near-api-js v7 Signer, not a bare KeyPair', () => {
    // near-api-js v7 calls `signer.signTransaction(...)`; passing the KeyPair
    // itself made every sponsored transaction (including the first Google
    // login's account creation) fail with
    // "TypeError: signer.signTransaction is not a function".
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'near-auth-relayer.js'), 'utf8');
    assert.match(source, /new KeyPairSigner\(sponsorKey\)/);
    assert.doesNotMatch(source, /new Account\([^)]*,\s*sponsorKey\)/);
});

test('sponsor budget enforces hourly and per-account limits', () => {
    let clock = 1_000_000;
    const budget = new SponsorBudget({
        hourlyLimitYocto: 100n,
        accountLimitYocto: 80n,
        now: () => clock,
    });
    budget.assertCanSpend('u-a', 50n);
    budget.record('u-a', 50n);
    assert.throws(() => budget.assertCanSpend('u-a', 40n), /onboarding limit/i);
    assert.throws(() => budget.assertCanSpend('u-b', 60n), /hourly budget/i);
    clock += 60 * 60 * 1000 + 1;
    budget.assertCanSpend('u-b', 60n);
});
