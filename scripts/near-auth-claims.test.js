'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createNearAuthClaimStore } = require('./near-auth-claims');

function temporaryStore() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-claims-'));
    const filePath = path.join(directory, 'claims.json');
    const store = createNearAuthClaimStore({ filePath, secret: 'a-test-secret-that-is-long-enough' });
    return { store, filePath, directory };
}

test('creates a claim, stores only an email hash, and verifies the recipient', () => {
    const { store, filePath, directory } = temporaryStore();
    const claim = store.create({
        tokenId: 'relay-1',
        contractId: 'relay.spellman.testnet',
        ownerAccountId: 'u-abc.relay.spellman.testnet',
        ownerSub: 'google-oauth2|owner',
        recipientEmail: 'Friend@Example.com',
    });

    assert.equal(claim.status, 'open');
    assert.match(claim.emailMasked, /^f\*+@example\.com$/);
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes('Friend@Example.com'), false);
    assert.equal(raw.includes('friend@example.com'), false);

    assert.throws(
        () => store.verifyRecipient(claim.id, {
            sub: 'google-oauth2|stranger',
            email: 'stranger@example.com',
            accountId: 'u-stranger.relay.spellman.testnet',
        }),
        /not issued to your verified email/i,
    );

    const ready = store.verifyRecipient(claim.id, {
        sub: 'google-oauth2|friend',
        email: 'friend@example.com',
        accountId: 'u-friend.relay.spellman.testnet',
    });
    assert.equal(ready.status, 'ready');
    assert.equal(store.get(claim.id).recipientAccountId, 'u-friend.relay.spellman.testnet');

    const claimed = store.markClaimed(claim.id, 'HASH');
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.transactionHash, 'HASH');

    fs.rmSync(directory, { recursive: true, force: true });
});

test('reloads claims from disk and enforces owner cancellation', () => {
    const { store, filePath, directory } = temporaryStore();
    const claim = store.create({
        tokenId: 'relay-2',
        contractId: 'relay.spellman.testnet',
        ownerAccountId: 'u-abc.relay.spellman.testnet',
        ownerSub: 'google-oauth2|owner',
        recipientEmail: 'friend@example.com',
    });

    const reloaded = createNearAuthClaimStore({
        filePath,
        secret: 'a-test-secret-that-is-long-enough',
    });
    assert.equal(reloaded.get(claim.id).tokenId, 'relay-2');
    assert.deepEqual(reloaded.listForOwner('google-oauth2|owner').map((entry) => entry.id), [claim.id]);
    assert.throws(() => reloaded.cancel(claim.id, 'google-oauth2|other'), /Only the claim creator/i);
    assert.equal(reloaded.cancel(claim.id, 'google-oauth2|owner').status, 'cancelled');

    fs.rmSync(directory, { recursive: true, force: true });
});

test('tracks a claim created by a wallet identity and completes it for that wallet', () => {
    const { store, directory } = temporaryStore();
    const claim = store.create({
        tokenId: 'obelisk',
        contractId: 'relay.spellman.testnet',
        ownerAccountId: 'spellman.testnet',
        ownerSub: 'wallet:spellman.testnet',
        recipientEmail: 'friend@example.com',
    });

    // A wallet-owned card keeps the wallet subject as the creator, so the
    // Google MPC key can never be mistaken for the claim owner.
    assert.equal(store.ownerHasClaim(store.get(claim.id), 'wallet:spellman.testnet'), true);
    assert.equal(store.ownerHasClaim(store.get(claim.id), 'google-oauth2|owner'), false);
    assert.deepEqual(store.listForOwner('wallet:spellman.testnet').map((entry) => entry.id), [claim.id]);

    const ready = store.verifyRecipient(claim.id, {
        sub: 'google-oauth2|friend',
        email: 'friend@example.com',
        accountId: 'u-friend.relay.spellman.testnet',
    });
    assert.equal(ready.status, 'ready');

    const completed = store.markClaimed(claim.id, 'WALLET_TX_HASH');
    assert.equal(completed.status, 'claimed');
    assert.equal(completed.transactionHash, 'WALLET_TX_HASH');

    fs.rmSync(directory, { recursive: true, force: true });
});
