'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    ASSOCIATED_ACCOUNT_ID,
    CONTRACT_ACCOUNT_ID,
    DEFAULT_OWNER_B_ACCOUNT_ID,
    OWNER_A_ACCOUNT_ID,
    TOKEN_ID,
    assertAuthorizationProbe,
    assertHandoffState,
    assertPreTransferState,
    assertTransactionSucceeded,
    buildAccountCreationActions,
    buildAuthorizationAction,
    buildTransferAction,
    buildTransferArguments,
    parseArguments,
    runTransferLifecycle,
    saveOwnerBCredentials,
    submitOnce,
    updateEnvText,
    validateDistinctOwners,
    validateTestnetStatus,
} = require('./near-testnet-transfer-lifecycle');

const OWNER_A_PUBLIC_KEY = 'ed25519:owner-a-public-key';
const OWNER_B_PUBLIC_KEY = 'ed25519:owner-b-public-key';
const PARENT_HASH = '2CB1AE95CDB0B6616D69A728BAD983093225A98B10526358BFE90AD9AD334B6F';
const CONTROLLER_HASH = '762A821E16897303AB491E90E26F02FA466ED831008CE73C4EB27F3CB4F29242';

function makeSnapshot(ownerId = OWNER_A_ACCOUNT_ID, nonce = '1') {
    return {
        block: { height: 100, hash: 'final-block-hash' },
        parent: {
            accountId: CONTRACT_ACCOUNT_ID,
            codeHash: 'on-chain-parent-hash',
            runtimeCode: { bytes: 514876, sha256: PARENT_HASH },
            views: {
                nft_token: { token_id: TOKEN_ID, owner_id: ownerId, approved_account_ids: {} },
                nft_total_supply: '1',
                relay_account_binding: { account_id: ASSOCIATED_ACCOUNT_ID, is_verified: true },
                relay_provisioning_state: 'Completed',
                relay_credits: { total: 3, remaining: 3 },
                token_lifecycle: 'Unlocked',
                token_nonce: nonce,
                relay_payment: null,
                relay_quote_nonce: '0',
                relay_active_quote_authorization: null,
            },
        },
        associatedAccount: {
            accountId: ASSOCIATED_ACCOUNT_ID,
            amountYocto: '1749930000000000000000000',
            lockedYocto: '0',
            storageUsageBytes: 150180,
            codeHash: 'on-chain-controller-hash',
            runtimeCode: { bytes: 149993, sha256: CONTROLLER_HASH },
            accessKeyCount: 0,
            controllerState: [CONTRACT_ACCOUNT_ID, TOKEN_ID],
        },
    };
}

function mockProvider() {
    const calls = [];
    return {
        calls,
        async viewNodeStatus() { return { chain_id: 'testnet' }; },
        async viewAccount({ accountId }) {
            if (accountId === OWNER_A_ACCOUNT_ID) return { amount: '6000000000000000000000000' };
            if (accountId === DEFAULT_OWNER_B_ACCOUNT_ID) return { amount: '100000000000000000000000' };
            throw new Error('Unexpected account view');
        },
        async viewBlock() { return { header: { height: 100, hash: 'final-block-hash' } }; },
        async viewGasPrice() { return { gas_price: '100000000' }; },
        async viewAccessKeyList({ accountId }) {
            return {
                keys: [{
                    public_key: accountId === OWNER_A_ACCOUNT_ID ? OWNER_A_PUBLIC_KEY : OWNER_B_PUBLIC_KEY,
                    access_key: { permission: 'FullAccess' },
                }],
            };
        },
        async sendJsonRpc(method, params) {
            calls.push({ method, params });
            if (method !== 'query') throw new Error('Unexpected RPC method');
            const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString('utf8'));
            const snapshot = makeSnapshot();
            const result = {
                nft_token: snapshot.parent.views.nft_token,
                nft_total_supply: snapshot.parent.views.nft_total_supply,
                relay_account_binding: snapshot.parent.views.relay_account_binding,
                relay_provisioning_state: snapshot.parent.views.relay_provisioning_state,
                relay_credits: snapshot.parent.views.relay_credits,
                token_lifecycle: snapshot.parent.views.token_lifecycle,
                token_nonce: snapshot.parent.views.token_nonce,
                relay_payment: null,
                relay_quote_nonce: '0',
                relay_active_quote_authorization: null,
                get_controller_state: [CONTRACT_ACCOUNT_ID, TOKEN_ID],
            }[params.method_name];
            assert.ok(result !== undefined, `Unexpected view method ${params.method_name}`);
            return { result: Buffer.from(JSON.stringify(result)) };
        },
        baseEncode: bytes => Buffer.from(bytes).toString('hex'),
        async sendTransactionUntil() {
            throw new Error('Dry-run must not submit a transaction');
        },
    };
}

function mockSdk(provider) {
    return {
        JsonRpcProvider: class { constructor() { return provider; } },
        KeyPairSigner: {
            fromSecretKey(secret) {
                return {
                    async getPublicKey() {
                        return { toString: () => secret === 'owner-a-secret' ? OWNER_A_PUBLIC_KEY : OWNER_B_PUBLIC_KEY };
                    },
                };
            },
        },
        Account: class {
            constructor(accountId) { this.accountId = accountId; }
            async createSignedTransaction() {
                throw new Error('Dry-run must not create signed transactions');
            }
        },
        actions: {
            functionCall(methodName, args, gas, deposit) {
                return { kind: 'functionCall', methodName, args, gas, deposit };
            },
            createAccount() { return { kind: 'createAccount' }; },
            transfer(amount) { return { kind: 'transfer', amount }; },
            addFullAccessKey(publicKey) { return { kind: 'addFullAccessKey', publicKey }; },
        },
        PublicKey: { from: publicKey => publicKey },
    };
}

test('Owner A and Owner B identities must be independent', () => {
    assert.equal(validateDistinctOwners(OWNER_A_ACCOUNT_ID, DEFAULT_OWNER_B_ACCOUNT_ID), true);
    assert.throws(() => validateDistinctOwners(OWNER_A_ACCOUNT_ID, OWNER_A_ACCOUNT_ID), /distinct/);
    assert.throws(() => buildTransferArguments(OWNER_A_ACCOUNT_ID), /distinct/);
});

test('network validation accepts Testnet and rejects other networks', () => {
    assert.equal(validateTestnetStatus({ chain_id: 'testnet' }), undefined);
    assert.throws(() => validateTestnetStatus({ chain_id: 'mainnet' }), /expected testnet/);
});

test('direct transfer arguments and action use the required token, receiver, deposit and gas', () => {
    const sdk = mockSdk({});
    assert.deepEqual(buildTransferArguments(DEFAULT_OWNER_B_ACCOUNT_ID), {
        token_id: TOKEN_ID,
        receiver_id: DEFAULT_OWNER_B_ACCOUNT_ID,
        approval_id: null,
        memo: null,
    });
    const action = buildTransferAction(sdk, DEFAULT_OWNER_B_ACCOUNT_ID);
    assert.equal(action.methodName, 'nft_transfer');
    assert.equal(action.deposit, 1n);
    assert.equal(action.gas, 30n * 10n ** 12n);
});

test('Owner B account transaction creates, funds, and adds only its own FullAccess key', () => {
    const actions = buildAccountCreationActions(mockSdk({}), OWNER_B_PUBLIC_KEY);
    assert.deepEqual(actions.map(action => action.kind), ['createAccount', 'transfer', 'addFullAccessKey']);
    assert.equal(actions[1].amount, 10n ** 23n);
    assert.equal(actions[2].publicKey, OWNER_B_PUBLIC_KEY);
});

test('finalized transfer and callback evidence distinguishes success from failure', () => {
    const success = assertTransactionSucceeded({
        transaction: { hash: 'success-hash' },
        status: { SuccessValue: '' },
        receipts_outcome: [{ id: 'receipt-ok', outcome: { status: { SuccessValue: '' } } }],
    }, 'transfer');
    assert.equal(success.succeeded, true);
    const failure = assertTransactionSucceeded({
        transaction: { hash: 'failure-hash' },
        status: { Failure: { error_message: 'rejected' } },
        receipts_outcome: [{ id: 'receipt-failed', outcome: { status: { Failure: {} } } }],
    }, 'transfer');
    assert.equal(failure.succeeded, false);
    assert.equal(failure.failed, true);
});

test('ambiguous transaction without a hash fails closed', () => {
    assert.throws(() => assertTransactionSucceeded({}, 'transfer'), /ambiguous/);
});

test('pre-transfer lifecycle locks and incomplete bindings are rejected', () => {
    assert.doesNotThrow(() => assertPreTransferState(makeSnapshot(), DEFAULT_OWNER_B_ACCOUNT_ID));
    const locked = makeSnapshot();
    locked.parent.views.token_lifecycle = { LockedForSubaccount: { nonce: 2, initiator: OWNER_A_ACCOUNT_ID } };
    assert.throws(() => assertPreTransferState(locked, DEFAULT_OWNER_B_ACCOUNT_ID), /prerequisites/);
    const unverified = makeSnapshot();
    unverified.parent.views.relay_account_binding.is_verified = false;
    assert.throws(() => assertPreTransferState(unverified, DEFAULT_OWNER_B_ACCOUNT_ID), /prerequisites/);
});

test('ownership handoff preserves binding, credits, and associated account state', () => {
    const before = makeSnapshot();
    const after = makeSnapshot(DEFAULT_OWNER_B_ACCOUNT_ID, '2');
    assert.doesNotThrow(() => assertHandoffState(before, after, DEFAULT_OWNER_B_ACCOUNT_ID));
    after.associatedAccount.amountYocto = '1';
    assert.throws(() => assertHandoffState(before, after, DEFAULT_OWNER_B_ACCOUNT_ID), /balance/);
});

test('old-owner rejection and new-owner acceptance are asserted from transaction outcomes', () => {
    assert.equal(assertAuthorizationProbe({ failed: true, succeeded: false }, false, 'old owner'), true);
    assert.equal(assertAuthorizationProbe({ failed: false, succeeded: true }, true, 'new owner'), true);
    assert.throws(() => assertAuthorizationProbe({ failed: false, succeeded: true }, false, 'old owner'), /unexpectedly succeeded/);
    assert.throws(() => assertAuthorizationProbe({ failed: true, succeeded: false }, true, 'new owner'), /not accepted/);
    assert.throws(() => assertAuthorizationProbe({
        ambiguous: true,
        transactionHash: 'pending-hash',
    }, true, 'new owner'), /ambiguous.*pending-hash/);
});

test('authorization operation is a zero-value associated-account transfer', () => {
    const action = buildAuthorizationAction(mockSdk({}), DEFAULT_OWNER_B_ACCOUNT_ID);
    assert.equal(action.methodName, 'relay_execute_subaccount');
    assert.deepEqual(action.args.action, {
        TransferNear: { receiver_id: DEFAULT_OWNER_B_ACCOUNT_ID, amount: '0' },
    });
    assert.equal(action.deposit, 0n);
});

test('dry-run reads finalized state but does not create or submit transactions', async () => {
    const provider = mockProvider();
    let snapshots = 0;
    const result = await runTransferLifecycle({
        dryRun: true,
        env: {
            NEAR_ACCOUNT_ID: OWNER_A_ACCOUNT_ID,
            NEAR_NETWORK: 'testnet',
            NEAR_PRIVATE_KEY: 'owner-a-secret',
            OWNER_B_ACCOUNT_ID: DEFAULT_OWNER_B_ACCOUNT_ID,
            OWNER_B_PRIVATE_KEY: 'owner-b-secret',
            RELAY_CONTRACT_ID: CONTRACT_ACCOUNT_ID,
        },
        provider,
        sdk: mockSdk(provider),
        ownerBAccountExists: true,
        readSnapshot: async () => {
            snapshots += 1;
            return makeSnapshot();
        },
    });
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.transfer.submitted, false);
    assert.equal(result.authorizationProbe.submitted, false);
    assert.equal(snapshots, 1);
});

test('submission uses one signing/broadcast attempt with finality and no retries', async () => {
    let signed = 0;
    let broadcast = 0;
    const account = {
        accountId: OWNER_A_ACCOUNT_ID,
        async createSignedTransaction() {
            signed += 1;
            return { transaction: { encode: () => Buffer.from('tx') } };
        },
    };
    const provider = {
        baseEncode: () => 'tx-hash',
        async sendJsonRpc(method, params) {
            assert.equal(method, 'send_tx');
            assert.equal(params.wait_until, 'FINAL');
            assert.equal(typeof params.signed_tx_base64, 'string');
            broadcast += 1;
            return { transaction: { hash: 'tx-hash' }, status: { SuccessValue: '' }, receipts_outcome: [] };
        },
    };
    const sdk = {
        encodeTransaction: signed => signed.transaction.encode(),
        base64Encode: value => Buffer.from(value).toString('base64'),
    };
    const result = await submitOnce(account, provider, CONTRACT_ACCOUNT_ID, [], 'test', null, sdk);
    assert.equal(result.succeeded, true);
    assert.equal(signed, 1);
    assert.equal(broadcast, 1);
});

test('environment updates preserve other variables and replace only selected entries', () => {
    const updated = updateEnvText(
        'NEAR_PRIVATE_KEY=owner-a-secret\nAPP_PORT=4173\nOWNER_B_ACCOUNT_ID=old.testnet\n',
        { OWNER_B_ACCOUNT_ID: DEFAULT_OWNER_B_ACCOUNT_ID, OWNER_B_PRIVATE_KEY: 'owner-b-secret' },
    );
    assert.match(updated, /NEAR_PRIVATE_KEY=owner-a-secret/);
    assert.match(updated, /APP_PORT=4173/);
    assert.match(updated, /OWNER_B_ACCOUNT_ID=relay-owner-b\.spellman\.testnet/);
    assert.match(updated, /OWNER_B_PRIVATE_KEY=owner-b-secret/);
    assert.equal((updated.match(/OWNER_B_ACCOUNT_ID=/g) || []).length, 1);
});

test('credential save refuses unignored .env and applies secure permissions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-owner-b-'));
    const envPath = path.join(directory, '.env');
    try {
        fs.writeFileSync(envPath, 'KEEP=value\n', { mode: 0o600 });
        assert.throws(() => saveOwnerBCredentials(
            envPath,
            DEFAULT_OWNER_B_ACCOUNT_ID,
            'owner-b-secret',
            { rootDir: directory, assertEnvIgnored: () => { throw new Error('not ignored'); } },
        ), /not ignored/);
        assert.equal(fs.readFileSync(envPath, 'utf8'), 'KEEP=value\n');

        let restricted = false;
        saveOwnerBCredentials(envPath, DEFAULT_OWNER_B_ACCOUNT_ID, 'owner-b-secret', {
            rootDir: directory,
            assertEnvIgnored: () => {},
            restrictPermissions: () => { restricted = true; },
        });
        const saved = fs.readFileSync(envPath, 'utf8');
        assert.match(saved, /KEEP=value/);
        assert.match(saved, /OWNER_B_ACCOUNT_ID=relay-owner-b\.spellman\.testnet/);
        assert.equal(saved.includes('owner-b-secret'), true);
        assert.equal(restricted, true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('CLI forbids combined execution and dry-run modes', () => {
    assert.throws(() => parseArguments(['--execute', '--dry-run']), /either/);
    assert.deepEqual(parseArguments(['--prepare-owner-b', '--dry-run']), {
        prepareOwnerB: true,
        dryRun: true,
        execute: false,
        resumeOwnerBAuthorization: false,
    });
    assert.deepEqual(parseArguments(['--resume-owner-b-authorization', '--execute']), {
        prepareOwnerB: false,
        dryRun: false,
        execute: true,
        resumeOwnerBAuthorization: true,
    });
});
