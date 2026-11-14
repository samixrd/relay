'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAccountLinkStore } = require('./account-links');

function temporaryStore() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-links-'));
    const filePath = path.join(directory, 'account-links.json');
    const store = createAccountLinkStore({ filePath });
    return { store, filePath, directory };
}

test('links a wallet to a Google subject and lists only that subject', () => {
    const { store, directory } = temporaryStore();

    const linked = store.link({
        sub: 'google-oauth2|owner',
        accountId: 'spellman.testnet',
        publicKey: 'ed25519:8QXv',
        providerId: 'meteor-wallet',
    });
    assert.equal(linked.accountId, 'spellman.testnet');
    assert.equal(linked.publicKey, 'ed25519:8QXv');

    assert.deepEqual(store.accountsFor('google-oauth2|owner'), ['spellman.testnet']);
    assert.deepEqual(store.accountsFor('google-oauth2|other'), []);
    assert.equal(store.isLinked('google-oauth2|owner', 'spellman.testnet'), true);
    assert.equal(store.isLinked('google-oauth2|other', 'spellman.testnet'), false);

    fs.rmSync(directory, { recursive: true, force: true });
});

test('persists links to disk and reloads them', () => {
    const { store, filePath, directory } = temporaryStore();
    store.link({ sub: 'google-oauth2|owner', accountId: 'spellman.testnet' });
    store.link({ sub: 'google-oauth2|owner', accountId: 'relay-owner-b.spellman.testnet' });

    const reloaded = createAccountLinkStore({ filePath });
    assert.deepEqual(
        reloaded.listFor('google-oauth2|owner').map((entry) => entry.accountId).sort(),
        ['relay-owner-b.spellman.testnet', 'spellman.testnet'],
    );

    fs.rmSync(directory, { recursive: true, force: true });
});

test('unlink removes only the requested link', () => {
    const { store, directory } = temporaryStore();
    store.link({ sub: 'google-oauth2|owner', accountId: 'spellman.testnet' });
    store.link({ sub: 'google-oauth2|owner', accountId: 'second.testnet' });

    assert.equal(store.unlink('google-oauth2|owner', 'spellman.testnet'), true);
    assert.deepEqual(store.accountsFor('google-oauth2|owner'), ['second.testnet']);
    assert.equal(store.unlink('google-oauth2|owner', 'missing.testnet'), false);

    fs.rmSync(directory, { recursive: true, force: true });
});

test('rejects links without a Google subject or wallet account', () => {
    const { store, directory } = temporaryStore();
    assert.throws(() => store.link({ sub: '', accountId: 'spellman.testnet' }), /Google identity/i);
    assert.throws(() => store.link({ sub: 'google-oauth2|owner', accountId: '' }), /wallet account/i);
    fs.rmSync(directory, { recursive: true, force: true });
});
