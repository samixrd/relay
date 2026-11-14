'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createClaimSession,
    markSessionClaimed,
    resetClaimedSessionsForTesting,
    validatePublicAppUrl,
    verifyClaimSession,
} = require('./claim-session');

const FIXED_SECRET = 'super-secret-test-key-32-characters-long!';

test('validatePublicAppUrl identifies localhost and public https domains', () => {
    // Unconfigured
    const unconfigured = validatePublicAppUrl(null);
    assert.equal(unconfigured.valid, false);
    assert.equal(unconfigured.isShareable, false);

    // Localhost
    const local = validatePublicAppUrl('http://localhost:4173');
    assert.equal(local.valid, true);
    assert.equal(local.isLocalhost, true);
    assert.equal(local.isShareable, false);
    assert.match(local.reason, /Localhost cannot be shared/);

    const ipLocal = validatePublicAppUrl('http://127.0.0.1:4173');
    assert.equal(ipLocal.isLocalhost, true);
    assert.equal(ipLocal.isShareable, false);

    // Public HTTPS domain
    const publicApp = validatePublicAppUrl('https://relay.myproject.org');
    assert.equal(publicApp.valid, true);
    assert.equal(publicApp.isLocalhost, false);
    assert.equal(publicApp.isShareable, true);
    assert.equal(publicApp.reason, null);

    // Embedded credentials rejected
    const creds = validatePublicAppUrl('https://user:pass@relay.app');
    assert.equal(creds.valid, false);
    assert.match(creds.reason, /must not contain embedded credentials/);
});

test('createClaimSession generates signed URL with expiry and context', () => {
    const session = createClaimSession({
        tokenId: 'relay-test-1',
        expectedOwner: 'relay-owner-b.spellman.testnet',
        publicAppUrl: 'https://claim.relay.network',
        ttlSeconds: 3600,
        secretKey: FIXED_SECRET,
    });

    assert.ok(session.sessionId);
    assert.ok(session.sessionToken);
    assert.equal(session.tokenId, 'relay-test-1');
    assert.equal(session.expectedOwner, 'relay-owner-b.spellman.testnet');
    assert.equal(session.isCrossDeviceShareable, true);
    assert.match(session.claimUrl, /^https:\/\/claim\.relay\.network\/#claim=relay-test-1&session=/);
    assert.equal(session.warning, null);
});

test('createClaimSession shows warning when PUBLIC_APP_URL is localhost', () => {
    const session = createClaimSession({
        tokenId: 'relay-test-1',
        expectedOwner: 'relay-owner-b.spellman.testnet',
        publicAppUrl: 'http://localhost:4173',
        secretKey: FIXED_SECRET,
    });

    assert.equal(session.isCrossDeviceShareable, false);
    assert.match(session.warning, /Localhost cannot be shared/);
    assert.match(session.claimUrl, /^http:\/\/localhost:4173\/#claim=relay-test-1&session=/);
});

test('verifyClaimSession validates valid session and rejects tampered or expired tokens', () => {
    resetClaimedSessionsForTesting();

    const session = createClaimSession({
        tokenId: 'relay-test-1',
        expectedOwner: 'relay-owner-b.spellman.testnet',
        ttlSeconds: 300,
        secretKey: FIXED_SECRET,
    });

    // Valid check
    const verified = verifyClaimSession(session.sessionToken, {
        currentTokenOwner: 'relay-owner-b.spellman.testnet',
        requestedTokenId: 'relay-test-1',
        secretKey: FIXED_SECRET,
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.tokenId, 'relay-test-1');
    assert.equal(verified.expectedOwner, 'relay-owner-b.spellman.testnet');

    // Token substitution rejected
    assert.throws(
        () => verifyClaimSession(session.sessionToken, {
            currentTokenOwner: 'relay-owner-b.spellman.testnet',
            requestedTokenId: 'other-token-id',
            secretKey: FIXED_SECRET,
        }),
        /Token substitution rejected/
    );

    // Ownership mismatch rejected
    assert.throws(
        () => verifyClaimSession(session.sessionToken, {
            currentTokenOwner: 'new-owner.testnet',
            requestedTokenId: 'relay-test-1',
            secretKey: FIXED_SECRET,
        }),
        /NFT owner has changed since this claim session was created/
    );

    // Expired session rejected
    const expiredFutureTime = Date.now() + (400 * 1000);
    assert.throws(
        () => verifyClaimSession(session.sessionToken, {
            currentTokenOwner: 'relay-owner-b.spellman.testnet',
            requestedTokenId: 'relay-test-1',
            secretKey: FIXED_SECRET,
            nowMs: expiredFutureTime,
        }),
        /Claim session expired/
    );

    // Tampered token rejected
    assert.throws(
        () => verifyClaimSession(session.sessionToken, {
            currentTokenOwner: 'relay-owner-b.spellman.testnet',
            requestedTokenId: 'relay-test-1',
            secretKey: 'different-secret-key-123456789012',
        }),
        /signature verification failed/
    );
});

test('verifyClaimSession prevents replay of claimed sessions', () => {
    resetClaimedSessionsForTesting();

    const session = createClaimSession({
        tokenId: 'relay-test-1',
        expectedOwner: 'relay-owner-b.spellman.testnet',
        secretKey: FIXED_SECRET,
    });

    // Mark as claimed
    markSessionClaimed(session.sessionId);

    // Replay check fails
    assert.throws(
        () => verifyClaimSession(session.sessionToken, {
            currentTokenOwner: 'relay-owner-b.spellman.testnet',
            requestedTokenId: 'relay-test-1',
            secretKey: FIXED_SECRET,
        }),
        /already been claimed and cannot be reused/
    );
});
