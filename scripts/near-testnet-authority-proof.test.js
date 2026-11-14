'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ASSOCIATED_ACCOUNT_ID,
    AUTHORIZATION_GAS,
    CALLBACK_GAS,
    CONSERVATIVE_EXPIRY_THRESHOLD,
    CONTRACT_ACCOUNT_ID,
    DEFAULT_OWNER_B_ACCOUNT_ID,
    EXPECTED_KEY_NONCE,
    EXPECTED_KEY_PUBLIC_KEY,
    LAST_SNAPSHOT_BLOCK_HEIGHT,
    OWNER_A_ACCOUNT_ID,
    PROBE_AMOUNT_YOCTO,
    PROBE_DEPOSIT,
    STORAGE_COST_PER_BYTE,
    SUBACCOUNT_DISPATCH_GAS,
    TOKEN_ID,
    TRANSACTION_VALIDITY_PERIOD,
    UNRESOLVED_TX_HASHES,
    YOCTO_PER_NEAR,
    assertSafetyGates,
    buildParentExecuteArgs,
    buildProbeAction,
    calculateSpendableBalance,
    checkExpiryThreshold,
    formatNear,
    generateProofPlan,
    parseArguments,
    runAuthorityProof,
    validateTestnetStatus,
} = require('./near-testnet-authority-proof');

function makeValidSnapshot(overrides = {}) {
    const base = {
        block: {
            height: CONSERVATIVE_EXPIRY_THRESHOLD + 10n,
            hash: 'mock-final-block-hash',
        },
        parent: {
            accountId: CONTRACT_ACCOUNT_ID,
            views: {
                nft_token: {
                    token_id: TOKEN_ID,
                    owner_id: DEFAULT_OWNER_B_ACCOUNT_ID,
                    approved_account_ids: {},
                },
                relay_account_binding: {
                    account_id: ASSOCIATED_ACCOUNT_ID,
                    is_verified: true,
                },
                relay_provisioning_state: 'Completed',
                relay_credits: { total: 3, remaining: 3 },
                token_lifecycle: 'Unlocked',
                token_nonce: '1',
                relay_active_quote_authorization: null,
            },
        },
        associatedAccount: {
            accountId: ASSOCIATED_ACCOUNT_ID,
            amountYocto: '1749930000000000000000000', // 1.74993 NEAR
            storageUsageBytes: 150180, // 1.5018 NEAR reserve
        },
        ownerB: {
            accountId: DEFAULT_OWNER_B_ACCOUNT_ID,
            keys: [{
                public_key: EXPECTED_KEY_PUBLIC_KEY,
                access_key: {
                    nonce: EXPECTED_KEY_NONCE,
                    permission: 'FullAccess',
                },
            }],
        },
    };

    return {
        ...base,
        ...overrides,
        block: { ...base.block, ...overrides.block },
        parent: {
            ...base.parent,
            ...overrides.parent,
            views: { ...base.parent.views, ...overrides.parent?.views },
        },
        associatedAccount: { ...base.associatedAccount, ...overrides.associatedAccount },
        ownerB: { ...base.ownerB, ...overrides.ownerB },
    };
}

test('validateTestnetStatus accepts testnet and rejects other chains', () => {
    assert.equal(validateTestnetStatus({ chain_id: 'testnet' }), true);
    assert.throws(() => validateTestnetStatus({ chain_id: 'mainnet' }), /expected testnet/);
    assert.throws(() => validateTestnetStatus({ chain_id: 'localnet' }), /expected testnet/);
    assert.throws(() => validateTestnetStatus(null), /expected testnet/);
});

test('checkExpiryThreshold correctly detects unexpired vs expired blocks', () => {
    const threshold = 276880235n;

    // Height below threshold: must NOT be expired, must compute remaining blocks
    const unexpired = checkExpiryThreshold(276795424n, threshold);
    assert.equal(unexpired.expired, false);
    assert.equal(unexpired.currentHeight, 276795424n);
    assert.equal(unexpired.blocksRemaining, 84811n);

    // Height at threshold: expired
    const atThreshold = checkExpiryThreshold(276880235n, threshold);
    assert.equal(atThreshold.expired, true);
    assert.equal(atThreshold.blocksRemaining, 0n);

    // Height above threshold: expired
    const aboveThreshold = checkExpiryThreshold(276880300n, threshold);
    assert.equal(aboveThreshold.expired, true);
    assert.equal(aboveThreshold.blocksRemaining, 0n);
});

test('calculateSpendableBalance computes exact storage reserve and spendable balance', () => {
    const subaccountBalance = 1749930000000000000000000n; // 1.74993 NEAR
    const storageBytes = 150180n;
    const spendable = calculateSpendableBalance(subaccountBalance, storageBytes);

    // Storage reserve = 150180 * 10^19 = 1.5018 NEAR
    assert.equal(spendable.storageReserve, 1501800000000000000000000n);
    assert.equal(spendable.availableBalance, 248130000000000000000000n); // 0.24813 NEAR
    assert.ok(spendable.availableBalance > PROBE_AMOUNT_YOCTO); // 0.24813 > 0.01 NEAR
});

test('buildProbeAction constructs valid positive transfer and rejects invalid inputs', () => {
    const action = buildProbeAction(DEFAULT_OWNER_B_ACCOUNT_ID, PROBE_AMOUNT_YOCTO);
    assert.deepEqual(action, {
        TransferNear: {
            receiver_id: 'relay-owner-b.spellman.testnet',
            amount: '10000000000000000000000',
        },
    });

    // Zero amount must be rejected
    assert.throws(() => buildProbeAction(DEFAULT_OWNER_B_ACCOUNT_ID, 0n), /strictly greater than zero/);
    // Negative amount must be rejected
    assert.throws(() => buildProbeAction(DEFAULT_OWNER_B_ACCOUNT_ID, -100n), /strictly greater than zero/);
    // Receiver cannot be subaccount itself
    assert.throws(() => buildProbeAction(ASSOCIATED_ACCOUNT_ID, PROBE_AMOUNT_YOCTO), /Receiver cannot be the subaccount itself/);
    // Empty receiver rejected
    assert.throws(() => buildProbeAction('', PROBE_AMOUNT_YOCTO), /non-empty string/);
});

test('assertSafetyGates validates all gates on compliant snapshot', () => {
    const snapshot = makeValidSnapshot();
    const result = assertSafetyGates(snapshot, { enforceExpiry: true });
    assert.equal(result.passed, true);
    assert.equal(result.issues.length, 0);
});

test('assertSafetyGates fails when current block is below conservative expiry threshold', () => {
    const snapshot = makeValidSnapshot({
        block: { height: 276795424n, hash: 'xSE1hiAcbwx8t3Tz8e9f6hXWCKWyFQG3Tv2GDqqeMmB' },
    });
    const result = assertSafetyGates(snapshot, { enforceExpiry: true });
    assert.equal(result.passed, false);
    assert.ok(result.issues.some(i => i.gate === 'EXPIRY_THRESHOLD_GATE'));
    assert.match(result.issues[0].error, /Conservative expiry threshold not reached/);
});

test('assertSafetyGates fails when Owner B key nonce differs from snapshot', () => {
    const snapshot = makeValidSnapshot({
        ownerB: {
            accountId: DEFAULT_OWNER_B_ACCOUNT_ID,
            keys: [{
                public_key: EXPECTED_KEY_PUBLIC_KEY,
                access_key: {
                    nonce: 276787880000001n, // changed nonce
                    permission: 'FullAccess',
                },
            }],
        },
    });
    const result = assertSafetyGates(snapshot, { enforceExpiry: false });
    assert.equal(result.passed, false);
    assert.ok(result.issues.some(i => i.gate === 'SIGNER_NONCE_GATE'));
});

test('assertSafetyGates fails when token owner is Owner A instead of Owner B', () => {
    const snapshot = makeValidSnapshot({
        parent: {
            views: {
                nft_token: {
                    token_id: TOKEN_ID,
                    owner_id: OWNER_A_ACCOUNT_ID, // wrong owner
                    approved_account_ids: {},
                },
            },
        },
    });
    const result = assertSafetyGates(snapshot, { enforceExpiry: false });
    assert.equal(result.passed, false);
    assert.ok(result.issues.some(i => i.gate === 'OWNERSHIP_GATE'));
});

test('assertSafetyGates fails when token lifecycle is locked', () => {
    const snapshot = makeValidSnapshot({
        parent: {
            views: {
                token_lifecycle: {
                    LockedForSubaccount: {
                        nonce: 2,
                        initiator: DEFAULT_OWNER_B_ACCOUNT_ID,
                    },
                },
            },
        },
    });
    const result = assertSafetyGates(snapshot, { enforceExpiry: false });
    assert.equal(result.passed, false);
    assert.ok(result.issues.some(i => i.gate === 'LIFECYCLE_GATE'));
});

test('assertSafetyGates fails when subaccount available balance is insufficient for storage reserve', () => {
    const snapshot = makeValidSnapshot({
        associatedAccount: {
            accountId: ASSOCIATED_ACCOUNT_ID,
            amountYocto: '1501800000000000000000000', // exactly 1.5018 NEAR (0 spendable balance)
            storageUsageBytes: 150180,
        },
    });
    const result = assertSafetyGates(snapshot, { enforceExpiry: false });
    assert.equal(result.passed, false);
    assert.ok(result.issues.some(i => i.gate === 'SUBACCOUNT_BALANCE_GATE'));
});

test('assertSafetyGates fails when credits are degraded', () => {
    const snapshot = makeValidSnapshot({
        parent: {
            views: {
                relay_credits: { total: 3, remaining: 2 }, // degraded credits
            },
        },
    });
    const result = assertSafetyGates(snapshot, { enforceExpiry: false });
    assert.equal(result.passed, false);
    assert.ok(result.issues.some(i => i.gate === 'CREDITS_GATE'));
});

test('generateProofPlan produces complete deterministic plan without state change', () => {
    const snapshot = makeValidSnapshot({
        block: { height: 276795424n, hash: 'xSE1hiAcbwx8t3Tz8e9f6hXWCKWyFQG3Tv2GDqqeMmB' },
    });
    const plan = generateProofPlan(snapshot);

    assert.equal(plan.status, 'PREPARED_READ_ONLY_PLAN');
    assert.equal(plan.authorityProbe.contractId, CONTRACT_ACCOUNT_ID);
    assert.equal(plan.authorityProbe.signerId, DEFAULT_OWNER_B_ACCOUNT_ID);
    assert.equal(plan.authorityProbe.methodName, 'relay_execute_subaccount');
    assert.deepEqual(plan.authorityProbe.args, {
        token_id: TOKEN_ID,
        action: {
            TransferNear: {
                receiver_id: DEFAULT_OWNER_B_ACCOUNT_ID,
                amount: PROBE_AMOUNT_YOCTO.toString(),
            },
        },
    });
    assert.equal(plan.authorityProbe.attachedDepositNear, '0');
    assert.equal(plan.authorityProbe.attachedGasTGas, 100);

    // Verify rejection check simulation details
    assert.equal(plan.rejectionCheck.unauthorizedCaller, OWNER_A_ACCOUNT_ID);
    assert.match(plan.rejectionCheck.expectedResult, /Only current token owner/);

    // Verify projected state transitions
    const projections = plan.stateInvariantsAndProjections;
    assert.equal(projections.token.currentOwner, DEFAULT_OWNER_B_ACCOUNT_ID);
    assert.equal(projections.token.currentTokenNonce, '1');
    assert.equal(projections.token.projectedTokenNonce, '2');
    assert.equal(projections.token.credits.consumed, 0);

    // Verify subaccount balance projections
    assert.equal(projections.subaccount.storageReserveNear, '1.5018');
    assert.equal(projections.subaccount.before.balanceNear, '1.74993');
    assert.equal(projections.subaccount.before.spendableNear, '0.24813');
    assert.equal(projections.subaccount.projected.balanceNear, '1.73993');
    assert.equal(projections.subaccount.projected.spendableNear, '0.23813');
    assert.equal(projections.subaccount.projected.storageReservePreserved, true);
    assert.equal(projections.recipient.grossTransferReceivedNear, '0.01');

    // Verify unresolved transaction details in plan
    assert.equal(plan.unresolvedTransactions.validityPeriodBlocks, 86400);
    assert.equal(plan.unresolvedTransactions.conservativeExpiryThreshold, '276880235');
    assert.equal(plan.unresolvedTransactions.blocksRemaining, '84811');
    assert.equal(plan.unresolvedTransactions.expired, false);
});

test('runAuthorityProof in default mode returns plan and submits no transactions', async () => {
    const snapshot = makeValidSnapshot({
        block: { height: 276795424n, hash: 'final-hash' },
    });
    const result = await runAuthorityProof({ snapshot });
    assert.equal(result.status, 'PREPARED_READ_ONLY_PLAN');
    assert.equal(result.authorityProbe.signerId, DEFAULT_OWNER_B_ACCOUNT_ID);
});

test('runAuthorityProof refuses execution if conservative expiry threshold is not reached', async () => {
    const snapshot = makeValidSnapshot({
        block: { height: 276795424n, hash: 'final-hash' },
    });
    await assert.rejects(
        () => runAuthorityProof({
            snapshot,
            execute: true,
            explicitApproval: true,
        }),
        /EXPIRY_THRESHOLD_GATE/
    );
});

test('runAuthorityProof refuses execution if explicit user approval flag is missing', async () => {
    const snapshot = makeValidSnapshot({
        block: { height: CONSERVATIVE_EXPIRY_THRESHOLD + 1n, hash: 'final-hash' },
    });
    await assert.rejects(
        () => runAuthorityProof({
            snapshot,
            execute: true,
            explicitApproval: false,
        }),
        /Missing required explicit user approval flag/
    );
});

test('runAuthorityProof halts execution under Task 34F non-submitting safety rule', async () => {
    const snapshot = makeValidSnapshot({
        block: { height: CONSERVATIVE_EXPIRY_THRESHOLD + 100n, hash: 'final-hash' },
    });
    await assert.rejects(
        () => runAuthorityProof({
            snapshot,
            execute: true,
            explicitApproval: true,
        }),
        /EXECUTION_HALTED: Task 34F is strictly a non-submitting preparation/
    );
});

test('parseArguments parses command-line flags accurately', () => {
    const defaultArgs = parseArguments([]);
    assert.equal(defaultArgs.plan, true);
    assert.equal(defaultArgs.execute, false);

    const dryArgs = parseArguments(['--dry-run']);
    assert.equal(dryArgs.plan, true);
    assert.equal(dryArgs.dryRun, true);
    assert.equal(dryArgs.execute, false);

    const execArgs = parseArguments(['--execute', '--yes-i-understand-testnet-transactions-are-real']);
    assert.equal(execArgs.execute, true);
    assert.equal(execArgs.explicitApproval, true);

    const rpcArgs = parseArguments(['--rpc-url', 'https://custom.rpc']);
    assert.equal(rpcArgs.rpcUrl, 'https://custom.rpc');

    assert.throws(() => parseArguments(['--unsupported-flag']), /Unknown command-line option/);
});
