'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createConfig, loadEnvFile, parseEnvText, publicConfig } = require('./app-config');

test('accepts verified public endpoints and leaves contract/credentials optional', () => {
    const config = createConfig({});
    assert.equal(config.valid, true);
    assert.equal(config.near.rpcUrl, 'https://rpc.testnet.near.org/');
    assert.equal(config.near.signerContractId, 'v1.signer-prod.testnet');
    assert.equal(config.near.relayContractId, '');
    assert.equal(Object.hasOwn(config, 'baseSepolia'), false);
    assert.equal(Object.hasOwn(config, 'oneClick'), false);
});

test('rejects mismatched networks and any non-Testnet configuration', () => {
    const config = createConfig({
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_URL: 'https://rpc.mainnet.near.org',
    });
    assert.equal(config.valid, false);
    assert.match(config.errors.join(' '), /does not match NEAR_NETWORK/);

    const mainnet = createConfig({ NEAR_NETWORK: 'mainnet' });
    assert.equal(mainnet.valid, false);
    assert.match(mainnet.errors.join(' '), /must be testnet/);
});

test('allows HTTP only for a local NEAR RPC and rejects unencrypted remote endpoints', () => {
    assert.equal(createConfig({ NEAR_RPC_URL: 'http://127.0.0.1:3030' }).valid, true);
    const config = createConfig({ NEAR_RPC_URL: 'http://169.254.169.254/latest/meta-data' });
    assert.equal(config.valid, false);
    assert.match(config.errors.join(' '), /HTTP only for a local loopback endpoint/);
});

test('validates the explorer for NEAR Testnet', () => {
    const config = createConfig({});
    assert.equal(config.near.explorerBaseUrl, 'https://testnet.nearblocks.io');
    const mismatch = createConfig({ NEAR_EXPLORER_BASE_URL: 'https://nearblocks.io' });
    assert.equal(mismatch.valid, false);
    assert.match(mismatch.errors.join(' '), /NEAR_EXPLORER_BASE_URL does not match/);
});

test('public browser configuration contains no RPC URLs or server credentials', () => {
    const config = createConfig({
        RELAY_CONTRACT_ID: 'relay.testnet',
        NEAR_AUTH_SPONSOR_PRIVATE_KEY: 'ed25519:server-only-secret',
    });
    const serialized = JSON.stringify(publicConfig(config));
    assert.equal(serialized.includes('server-only-secret'), false);
    assert.equal(serialized.includes('rpc.testnet.near.org'), false);
    assert.equal(serialized.includes('NEAR_AUTH_SPONSOR_PRIVATE_KEY'), false);
    assert.equal(serialized.includes('relay.testnet'), true);
});

test('environment parser handles comments and quotes, and loading never overwrites existing values', () => {
    assert.deepEqual(parseEnvText('A=one\nB="two words"\n# note\nC=three # comment'), {
        A: 'one',
        B: 'two words',
        C: 'three',
    });
    const target = { A: 'preserved' };
    const loaded = loadEnvFile('ignored', target, () => Buffer.from('A=changed\nB=new'));
    assert.equal(loaded, true);
    assert.deepEqual(target, { A: 'preserved', B: 'new' });
    assert.equal(loadEnvFile('missing', {}, () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }), false);
    assert.throws(() => parseEnvText('not valid'), /line 1/);
});
