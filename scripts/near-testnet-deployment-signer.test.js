'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runReadOnlyPreflight } = require('./near-testnet-deployment-signer');

const TEST_SECRET = 'ed25519:test-only-secret-not-for-use';
const TEST_PUBLIC_KEY = 'ed25519:test-only-public-key';
const FIXED_PROTOCOL = {
    runtime_config: {
        storage_amount_per_byte: '10000000000000000000',
        transaction_costs: {
            action_creation_config: {
                create_account_cost: { execution: '1', send_not_sir: '1' },
                transfer_cost: { execution: '1', send_not_sir: '1' },
                add_key_cost: { full_access_cost: { execution: '1', send_not_sir: '1' } },
                deploy_contract_cost: { execution: '1', send_not_sir: '1' },
                deploy_contract_cost_per_byte: { execution: '1', send_not_sir: '1' },
                function_call_cost: { execution: '1', send_not_sir: '1' },
                function_call_cost_per_byte: { execution: '1', send_not_sir: '1' },
            },
            action_receipt_creation_config: { execution: '1', send_not_sir: '1' },
            storage_usage_config: {
                num_bytes_account: 100,
                num_extra_bytes_record: 40,
            },
        },
        wasm_config: { limit_config: { max_gas_burnt: '1000000000000000' } },
    },
};

function fakeSdk({ chainId = 'testnet', key = TEST_PUBLIC_KEY, permission = { FullAccess: {} } } = {}) {
    const provider = {
        async viewNodeStatus() {
            return { chain_id: chainId };
        },
        async viewBlock() {
            return { header: { height: 123 } };
        },
        async viewAccount({ accountId }) {
            if (accountId === 'relay.spellman.testnet') {
                const error = new Error('account missing');
                error.name = 'AccountDoesNotExistError';
                throw error;
            }
            return { amount: 10n ** 24n, locked: 0n, storage_usage: 100 };
        },
        async viewAccessKeyList() {
            return {
                keys: [{ public_key: key, access_key: { permission } }],
            };
        },
        async experimental_protocolConfig() {
            return FIXED_PROTOCOL;
        },
        async viewGasPrice() {
            return { gas_price: 100000000n };
        },
    };
    class Account {
        constructor() {
            this.signAndSendTransaction = async () => {
                throw new Error('transaction submission must not be used by preflight');
            };
        }
    }
    return {
        KeyPairSigner: {
            fromSecretKey(secret) {
                assert.equal(secret, TEST_SECRET);
                return { async getPublicKey() { return { toString: () => TEST_PUBLIC_KEY }; } };
            },
        },
        JsonRpcProvider: class {
            constructor() {
                return provider;
            }
        },
        Account,
    };
}

function options({ env = {}, sdk = fakeSdk(), readFile } = {}) {
    const envText = Object.entries({
        NEAR_ACCOUNT_ID: 'spellman.testnet',
        NEAR_NETWORK: 'testnet',
        NEAR_PRIVATE_KEY: TEST_SECRET,
        ...env,
    }).map(([key, value]) => `${key}=${value}`).join('\n');
    return {
        rootDir: 'unused-by-test',
        readFile: readFile || (() => envText),
        sdk,
        inspectArtifacts: () => ({
            contract: { bytes: 10, path: 'contract.wasm', matchesAuditedHash: true },
            controller: { bytes: 5, path: 'controller.wasm', matchesAuditedHash: true },
            fingerprint: {
                activeFeatures: ['default'],
                sandboxCheckoutDispatchEnabled: false,
                defaultFeaturesOnly: true,
            },
        }),
    };
}

test('read-only preflight requires Testnet FullAccess and returns no signing or submission handle', async () => {
    const report = await runReadOnlyPreflight(options());
    assert.equal(report.network.reported, 'testnet');
    assert.equal(report.deployer.publicKey, TEST_PUBLIC_KEY);
    assert.equal(report.deployer.fullAccessKeyMatch, true);
    assert.equal(report.target.exists, false);
    assert.equal(report.transactionSubmissionPerformed, false);
    assert.equal(report.transactionSubmissionExposed, false);
    assert.equal('signer' in report, false);
});

test('rejects a wrong RPC network before account reads', async () => {
    await assert.rejects(
        runReadOnlyPreflight(options({ sdk: fakeSdk({ chainId: 'mainnet' }) })),
        /did not identify itself as Testnet/,
    );
});

test('rejects a derived key that is not an on-chain FullAccess key', async () => {
    await assert.rejects(
        runReadOnlyPreflight(options({ sdk: fakeSdk({ key: 'ed25519:another-key' }) })),
        /does not match a FullAccess key/,
    );
});

test('rejects a matching key with function-call-only permission', async () => {
    await assert.rejects(
        runReadOnlyPreflight(options({ sdk: fakeSdk({ permission: { FunctionCall: {} } }) })),
        /does not match a FullAccess key/,
    );
});

test('reports missing private key without exposing other .env contents', async () => {
    await assert.rejects(
        runReadOnlyPreflight(options({
            readFile: () => 'NEAR_ACCOUNT_ID=spellman.testnet\nBASE_SEPOLIA_PRIVATE_KEY=hidden-value',
        })),
        error => {
            assert.match(error.message, /NEAR_PRIVATE_KEY is missing/);
            assert.equal(error.message.includes('hidden-value'), false);
            return true;
        },
    );
});

test('sanitizes key-loading errors that contain the private key', async () => {
    const sdk = fakeSdk();
    sdk.KeyPairSigner.fromSecretKey = () => {
        throw new Error(`bad key: ${TEST_SECRET}`);
    };
    await assert.rejects(
        runReadOnlyPreflight(options({ sdk })),
        error => {
            assert.match(error.message, /could not be loaded by the official NEAR SDK/);
            assert.equal(error.message.includes(TEST_SECRET), false);
            return true;
        },
    );
});
