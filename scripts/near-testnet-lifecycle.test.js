'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    DEFAULT_TEST_TOKEN_ID,
    runLifecyclePreflight,
    buildExecutionPlan,
    executeLifecycle,
} = require('./near-testnet-lifecycle');

const TEST_SECRET = 'ed25519:test-only-secret-not-for-use';
const TEST_PUBLIC_KEY = 'ed25519:8QXvCPJuc1LkRkaBYCbqMZEyXLwLxgvxBWJ8Dfm1Q2X5';
const EXPECTED_CONTRACT_SHA256 = '2CB1AE95CDB0B6616D69A728BAD983093225A98B10526358BFE90AD9AD334B6F';
const EXPECTED_CONTROLLER_SHA256 = '762A821E16897303AB491E90E26F02FA466ED831008CE73C4EB27F3CB4F29242';

function mockProvider(overrides = {}) {
    return {
        async viewNodeStatus() {
            return { chain_id: overrides.chainId || 'testnet' };
        },
        async viewAccount({ accountId }) {
            if (overrides.missingAccounts?.includes(accountId)) {
                const err = new Error('Account does not exist');
                err.name = 'AccountDoesNotExistError';
                throw err;
            }
            if (accountId === 'spellman.testnet') {
                return { amount: overrides.deployerBalance || 3000000000000000000000000n }; // 3 NEAR
            }
            if (accountId === 'relay.spellman.testnet') {
                return {
                    amount: 7000000000000000000000000n,
                    code_hash: overrides.contractCodeHash || '41U5jJKhr1gwCrBwZ3LQPAeE6zEAbgmSr6R96d8BnkkW',
                };
            }
            if (accountId === overrides.subaccountId) {
                return {
                    amount: 1749930000000000000000000n,
                    code_hash: '2n8mQ4bWzG...',
                    storage_usage: 155000,
                };
            }
            return { amount: 1000000000000000000000000n };
        },
        async viewAccessKeyList({ accountId }) {
            if (overrides.keysNoFullAccess) {
                return { keys: [{ public_key: TEST_PUBLIC_KEY, access_key: { permission: 'FunctionCall' } }] };
            }
            return { keys: [{ public_key: TEST_PUBLIC_KEY, access_key: { permission: 'FullAccess' } }] };
        },
        async sendJsonRpc(method, params) {
            if (method === 'query' && params.request_type === 'call_function') {
                const { method_name, args_base64 } = params;
                const args = JSON.parse(Buffer.from(args_base64, 'base64').toString('utf8'));
                if (method_name === 'nft_metadata') {
                    return { result: Buffer.from(JSON.stringify({ name: 'RELAY', spec: 'nft-1.0.0' })) };
                }
                if (method_name === 'get_controller_code_len') {
                    return { result: Buffer.from(JSON.stringify(149993)) };
                }
                if (method_name === 'get_provision_minimum_deposit') {
                    return { result: Buffer.from(JSON.stringify('1749930000000000000000000')) };
                }
                if (method_name === 'nft_token') {
                    if (overrides.tokenCollision && args.token_id === overrides.collidingTokenId) {
                        return { result: Buffer.from(JSON.stringify({ token_id: args.token_id, owner_id: 'other.testnet' })) };
                    }
                    return { result: Buffer.from(JSON.stringify(null)) };
                }
                if (method_name === 'relay_canonical_account_id') {
                    return { result: Buffer.from(JSON.stringify(`${args.token_id}.relay.spellman.testnet`)) };
                }
                if (method_name === 'relay_account_binding') {
                    return { result: Buffer.from(JSON.stringify({ account_id: `${args.token_id}.relay.spellman.testnet`, is_verified: overrides.isVerified ?? false })) };
                }
                if (method_name === 'relay_provisioning_state') {
                    return { result: Buffer.from(JSON.stringify(overrides.provisioningState || 'Completed')) };
                }
                if (method_name === 'token_lifecycle') {
                    return { result: Buffer.from(JSON.stringify('Unlocked')) };
                }
                if (method_name === 'get_controller_state') {
                    return { result: Buffer.from(JSON.stringify(['relay.spellman.testnet', args.token_id || DEFAULT_TEST_TOKEN_ID])) };
                }
                if (method_name === 'get_native_balance') {
                    return { result: Buffer.from(JSON.stringify('1749930000000000000000000')) };
                }
            }
            throw new Error(`Unhandled mock RPC query: ${method} ${JSON.stringify(params)}`);
        },
    };
}

function mockSdk(provider) {
    return {
        JsonRpcProvider: class {
            constructor() { return provider; }
        },
        KeyPairSigner: {
            fromSecretKey(key) {
                return {
                    async getPublicKey() {
                        return { toString: () => TEST_PUBLIC_KEY };
                    },
                };
            },
        },
        Account: class {
            constructor(id) { this.id = id; }
            async signAndSendTransaction() {
                return {
                    transaction: { hash: 'mock-tx-hash-123' },
                    receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }],
                };
            }
        },
        actions: {
            functionCall(methodName, args, gas, deposit) {
                return { methodName, args, gas, deposit };
            },
        },
    };
}

function mockEnv(extra = {}) {
    return Object.entries({
        NEAR_NETWORK: 'testnet',
        NEAR_ACCOUNT_ID: 'spellman.testnet',
        RELAY_CONTRACT_ID: 'relay.spellman.testnet',
        NEAR_PRIVATE_KEY: TEST_SECRET,
        ...extra,
    }).map(([k, v]) => `${k}=${v}`).join('\n');
}

function mockReadFile(envStr = mockEnv()) {
    const fs = require('node:fs');
    return (filePath) => {
        if (filePath.endsWith('.env')) return envStr;
        return fs.readFileSync(filePath);
    };
}

test('preflight passes with valid configuration and reports complete plan without submitting transactions', async () => {
    const provider = mockProvider({
        missingAccounts: ['relay-test-available.relay.spellman.testnet'],
    });
    const sdk = mockSdk(provider);

    const preflight = await runLifecyclePreflight({
        tokenId: 'relay-test-available',
        sdk,
        readFile: mockReadFile(),
    });
    assert.equal(preflight.network, 'testnet');
    assert.equal(preflight.token.tokenId, 'relay-test-available');
    assert.equal(preflight.token.canonicalSubaccountId, 'relay-test-available.relay.spellman.testnet');
    assert.equal(preflight.token.tokenCollision, false);
    assert.equal(preflight.finances.provisionDepositNear, '1.74993');
    assert.equal(preflight.finances.mintDepositNear, '0.01');

    const plan = buildExecutionPlan(preflight);
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0].action, 'relay_mint');
    assert.equal(plan.steps[0].depositNear, '0.01');
    assert.equal(plan.steps[1].action, 'relay_provision_subaccount');
    assert.equal(plan.steps[1].depositNear, '1.74993');
});

test('preflight detects token collision and aborts before plan execution', async () => {
    const provider = mockProvider({
        tokenCollision: true,
        collidingTokenId: 'colliding-token',
    });
    const sdk = mockSdk(provider);

    await assert.rejects(
        runLifecyclePreflight({
            tokenId: 'colliding-token',
            sdk,
            readFile: mockReadFile(),
        }),
        /Token collision: token_id "colliding-token" already exists/,
    );
});

test('preflight aborts if canonical subaccount already exists on chain', async () => {
    const provider = mockProvider({
        missingAccounts: [], // Nothing missing -> subaccount exists!
    });
    const sdk = mockSdk(provider);

    await assert.rejects(
        runLifecyclePreflight({
            tokenId: 'existing-subaccount',
            sdk,
            readFile: mockReadFile(),
        }),
        /already exists on Testnet/,
    );
});

test('preflight fails closed if deployer has insufficient balance', async () => {
    const provider = mockProvider({
        missingAccounts: ['relay-test-1.relay.spellman.testnet'],
        deployerBalance: 100000000000000000000000n, // 0.1 NEAR (insufficient for 1.75 NEAR)
    });
    const sdk = mockSdk(provider);

    await assert.rejects(
        runLifecyclePreflight({
            sdk,
            readFile: mockReadFile(),
        }),
        /Insufficient liquid balance/,
    );
});

test('execution requires explicit user approval flag', async () => {
    await assert.rejects(
        executeLifecycle({ approved: false }),
        /Explicit user approval is required before state-changing execution/,
    );
});
