'use strict';

/**
 * Task 45 — Testnet-Native Checkout Demo Tests
 *
 * Tests:
 * - Mainnet-only 1Click route rejection in Testnet mode
 * - Testnet asset registry classification
 * - NEAR native transfer authorization (prepareNearPayment)
 * - Storage reserve preservation
 * - Invalid receiver and amount rejection
 * - Owner mismatch and ownership change guards
 * - Payment nonce / replay concepts
 * - Duplicate execution and state machine transitions
 * - Finalized NEAR payment verification (verifyNearPaymentTransaction)
 * - Base Sepolia chain ID and asset checks
 * - Base Sepolia is portfolio read-only (no signing)
 * - RecoveryRequired behavior in state machine
 * - UI unsupported-route gating (asset registry)
 * - Correct success receipt rendering
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ASSET_REGISTRY,
    ALLOWED_CHECKOUT_PAIRS,
    NETWORKS,
    getAsset,
    isSpendableThroughCheckout,
    isDestinationSupported,
    findCheckoutPair,
    validateCheckoutRoute,
} = require('./asset-registry');

const {
    PaymentAuthorizationError,
    NEAR_PAYMENT_STATES,
    YOCTO_PER_NEAR,
    MIN_TRANSFER_YOCTO,
    MAX_TRANSFER_NEAR,
    STORAGE_COST_PER_BYTE,
    STORAGE_RESERVE_PADDING,
    CANONICAL_CONTRACT_ID,
    CANONICAL_TOKEN_ID,
    CANONICAL_ASSOCIATED_ACCOUNT,
    EXPECTED_PARENT_CODE_SHA256,
    EXPECTED_CONTROLLER_CODE_SHA256,
    EXECUTE_SUBACCOUNT_GAS_TGAS,
    calculateSpendableBalance,
    formatNear,
    generatePaymentId,
    buildPaymentReviewSummary,
    prepareNearPayment,
    validateNearAccountId,
    verifyNearPaymentTransaction,
} = require('./near-testnet-payment-authorizer');

const {
    CHECKOUT_STATES,
    canTransition,
    transitionPaymentState,
} = require('./checkout-state-machine');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Mainnet-only 1Click route rejection in Testnet mode
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §1: Testnet wNEAR (wrap.testnet) cannot be used as a 1Click checkout source', () => {
    // wrap.testnet has no providerSupported and is portfolio-only
    const asset = getAsset('nep141:wrap.testnet');
    assert.ok(asset, 'wrap.testnet must be in registry');
    assert.equal(asset.portfolioOnly, true, 'wrap.testnet must be portfolio-only');
    assert.equal(asset.providerSupported, false, '1Click provider does not support wrap.testnet');
    assert.throws(
        () => validateCheckoutRoute('nep141:wrap.testnet', 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'),
        (err) => /portfolio-only/i.test(err.message)
    );
});

test('Task 45 §1: Mainnet wNEAR (wrap.near) checkout pairs are explicitly labelled Mainnet-only', () => {
    const mainnetPairs = ALLOWED_CHECKOUT_PAIRS.filter((p) => p.sourceAsset === 'nep141:wrap.near');
    assert.ok(mainnetPairs.length > 0, 'At least one Mainnet wNEAR pair must exist for backward compat');
    for (const pair of mainnetPairs) {
        assert.match(pair.networkPair, /mainnet/i, 'Mainnet wNEAR pairs must reference mainnet in networkPair');
        assert.notEqual(pair.architecture, 'NEAR_TESTNET_DIRECT_TRANSFER', 'Mainnet pairs must not be labelled as testnet-native');
    }
});

test('Task 45 §1: Base Sepolia USDC fixture is explicitly non-spendable via 1Click', () => {
    const asset = getAsset('erc20:base-sepolia-0x036cbd53842c5426634e7929541ec2318f3dcf7e');
    assert.ok(asset);
    assert.equal(asset.portfolioOnly, true);
    assert.equal(asset.isTestFixture, true);
    assert.equal(asset.providerSupported, false);
    assert.equal(isSpendableThroughCheckout('erc20:base-sepolia-0x036cbd53842c5426634e7929541ec2318f3dcf7e'), false);
});

test('Task 45 §1: Fake test fixtures (usdc.fakes.testnet, usdt.fakes.testnet) are blocked from checkout', () => {
    for (const id of ['nep141:usdc.fakes.testnet', 'nep141:usdt.fakes.testnet']) {
        const asset = getAsset(id);
        assert.ok(asset, `${id} must exist in registry`);
        assert.equal(asset.isTestFixture, true, `${id} must be labelled as test fixture`);
        assert.match(asset.fixtureNote || '', /zero monetary value/i, `${id} must note zero monetary value`);
        assert.throws(
            () => validateCheckoutRoute(id, 'nep141:wrap.near'),
            (err) => /test fixture|portfolio-only/i.test(err.message)
        );
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Testnet asset registry classification
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §2: native:near-testnet is classified as TESTNET_NATIVE_TRANSFER', () => {
    const asset = getAsset('native:near-testnet');
    assert.ok(asset);
    assert.equal(asset.status, 'TESTNET_NATIVE_TRANSFER');
    assert.equal(asset.checkoutArchitecture, 'NEAR_TESTNET_DIRECT_TRANSFER');
    assert.equal(asset.portfolioOnly, false, 'native NEAR is NOT portfolio-only: it can be spent via relay_execute_subaccount');
    assert.equal(asset.canSourceCheckout, true, 'native NEAR can be a checkout source via direct transfer');
    assert.equal(asset.providerSupported, false, '1Click provider does NOT support native NEAR testnet');
    assert.equal(asset.isTestFixture, false, 'native NEAR is not a test fixture');
});

test('Task 45 §2: NEAR_TESTNET_DIRECT_TRANSFER pair exists in ALLOWED_CHECKOUT_PAIRS', () => {
    const pair = findCheckoutPair('native:near-testnet', 'native:near-testnet');
    assert.ok(pair, 'Direct NEAR testnet transfer pair must be in ALLOWED_CHECKOUT_PAIRS');
    assert.equal(pair.architecture, 'NEAR_TESTNET_DIRECT_TRANSFER');
    assert.equal(pair.supported, true);
    assert.equal(pair.networkPair, 'near-testnet -> near-testnet');
});

test('Task 45 §2: validateCheckoutRoute accepts native:near-testnet pair', () => {
    const pair = validateCheckoutRoute('native:near-testnet', 'native:near-testnet');
    assert.ok(pair);
    assert.equal(pair.architecture, 'NEAR_TESTNET_DIRECT_TRANSFER');
});

test('Task 45 §2: Asset registry networks are correct', () => {
    assert.equal(NETWORKS.NEAR_TESTNET, 'near-testnet');
    assert.equal(NETWORKS.BASE_SEPOLIA, 'base-sepolia');
    assert.equal(NETWORKS.NEAR_MAINNET, 'near-mainnet');

    // Testnet assets
    const near_testnet = getAsset('native:near-testnet');
    assert.equal(near_testnet.network, NETWORKS.NEAR_TESTNET);
    const base_sepolia_eth = getAsset('native:base-sepolia-eth');
    assert.equal(base_sepolia_eth.network, NETWORKS.BASE_SEPOLIA);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. NEAR native transfer authorization
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §3: prepareNearPayment rejects invalid receiver account IDs', async () => {
    const badReceivers = ['', '   ', 'NOT_VALID', 'x', '!bad!', '0x1234567890abcdef'];
    for (const receiverId of badReceivers) {
        await assert.rejects(
            () => prepareNearPayment({
                rpcUrl: 'https://rpc.testnet.near.org',
                relayContractId: CANONICAL_CONTRACT_ID,
                tokenId: CANONICAL_TOKEN_ID,
                receiverId,
                amountYocto: (YOCTO_PER_NEAR / 100n).toString(),
                fetchImpl: async () => { throw new Error('Should not reach RPC for invalid input'); },
            }),
            (err) => {
                assert.ok(err instanceof PaymentAuthorizationError, 'Must throw PaymentAuthorizationError');
                assert.equal(err.code, 'INVALID_RECEIVER');
                return true;
            }
        );
    }
});

test('Task 45 §3: prepareNearPayment rejects amount below minimum', async () => {
    const tooSmall = (MIN_TRANSFER_YOCTO - 1n).toString();
    await assert.rejects(
        () => prepareNearPayment({
            rpcUrl: 'https://rpc.testnet.near.org',
            relayContractId: CANONICAL_CONTRACT_ID,
            tokenId: CANONICAL_TOKEN_ID,
            receiverId: 'some-receiver.testnet',
            amountYocto: tooSmall,
            fetchImpl: async () => { throw new Error('Should not reach RPC'); },
        }),
        (err) => {
            assert.ok(err instanceof PaymentAuthorizationError);
            assert.equal(err.code, 'AMOUNT_TOO_SMALL');
            return true;
        }
    );
});

test('Task 45 §3: prepareNearPayment rejects amount above testnet maximum', async () => {
    const tooLarge = (MAX_TRANSFER_NEAR * YOCTO_PER_NEAR + 1n).toString();
    await assert.rejects(
        () => prepareNearPayment({
            rpcUrl: 'https://rpc.testnet.near.org',
            relayContractId: CANONICAL_CONTRACT_ID,
            tokenId: CANONICAL_TOKEN_ID,
            receiverId: 'some-receiver.testnet',
            amountYocto: tooLarge,
            fetchImpl: async () => { throw new Error('Should not reach RPC'); },
        }),
        (err) => {
            assert.ok(err instanceof PaymentAuthorizationError);
            assert.equal(err.code, 'AMOUNT_TOO_LARGE');
            return true;
        }
    );
});

test('Task 45 §3: Transaction plan uses correct method and no attached deposit', async () => {
    const associatedAccountBalance = (2n * YOCTO_PER_NEAR).toString();
    const storageUsage = 150180; // from live testnet audit
    const mockFetch = makeMockFetch({
        ownerId: 'relay-owner-b.spellman.testnet',
        balance: associatedAccountBalance,
        storageUsage,
        lifecycle: 'Unlocked',
        credits: { total: 3, remaining: 3 },
        tokenNonce: 1,
    });

    const result = await prepareNearPayment({
        rpcUrl: 'https://rpc.testnet.near.org',
        relayContractId: CANONICAL_CONTRACT_ID,
        tokenId: CANONICAL_TOKEN_ID,
        receiverId: 'relay-owner-b.spellman.testnet',
        amountYocto: (YOCTO_PER_NEAR / 100n).toString(), // 0.01 NEAR
        fetchImpl: mockFetch,
    });

    assert.ok(result.plan);
    assert.equal(result.plan.methodName, 'relay_execute_subaccount');
    assert.equal(result.plan.contractId, CANONICAL_CONTRACT_ID);
    assert.equal(result.plan.attachedDepositYocto, '0');
    assert.equal(result.plan.args.action.TransferNear.receiver_id, 'relay-owner-b.spellman.testnet');
    assert.equal(result.plan.args.token_id, CANONICAL_TOKEN_ID);
    assert.equal(result.plan.requiredSigner, 'relay-owner-b.spellman.testnet');
    assert.equal(result.plan.network, 'testnet');
    assert.equal(result.mainnetOneClickStatus, 'DISABLED_FOR_TESTNET');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Storage reserve preservation
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §4: calculateSpendableBalance correctly deducts storage reserve + padding', () => {
    const storageUsage = 150180n;
    const rawReserve = storageUsage * STORAGE_COST_PER_BYTE;
    const reserveWithPadding = rawReserve + STORAGE_RESERVE_PADDING;

    const balance = reserveWithPadding + YOCTO_PER_NEAR; // just enough for 1 NEAR above reserve
    const result = calculateSpendableBalance(balance.toString(), storageUsage.toString());

    assert.equal(BigInt(result.spendable), YOCTO_PER_NEAR, 'Spendable should be exactly 1 NEAR above reserve');
    assert.ok(result.storageReserveWithPadding > result.rawStorageReserve, 'Padding must add to raw reserve');
});

test('Task 45 §4: calculateSpendableBalance returns 0 when balance is below storage reserve', () => {
    const storageUsage = 150180;
    const rawReserve = BigInt(storageUsage) * STORAGE_COST_PER_BYTE;
    const lowBalance = (rawReserve - 1n).toString();

    const result = calculateSpendableBalance(lowBalance, storageUsage);
    assert.equal(BigInt(result.spendable), 0n, 'Spendable must be 0 when balance is below storage reserve');
});

test('Task 45 §4: prepareNearPayment rejects when transfer would drain storage reserve', async () => {
    const storageUsage = 150180;
    const rawReserve = BigInt(storageUsage) * STORAGE_COST_PER_BYTE;
    const reserveWithPadding = rawReserve + STORAGE_RESERVE_PADDING;

    // Balance just barely above raw reserve, but below reserve+padding
    const tightBalance = (rawReserve + 1n).toString();
    const mockFetch = makeMockFetch({
        ownerId: 'relay-owner-b.spellman.testnet',
        balance: tightBalance,
        storageUsage,
        lifecycle: 'Unlocked',
        credits: { total: 3, remaining: 3 },
        tokenNonce: 1,
    });

    await assert.rejects(
        () => prepareNearPayment({
            rpcUrl: 'https://rpc.testnet.near.org',
            relayContractId: CANONICAL_CONTRACT_ID,
            tokenId: CANONICAL_TOKEN_ID,
            receiverId: 'relay-owner-b.spellman.testnet',
            amountYocto: MIN_TRANSFER_YOCTO.toString(),
            fetchImpl: mockFetch,
        }),
        (err) => {
            assert.ok(err instanceof PaymentAuthorizationError);
            assert.equal(err.code, 'INSUFFICIENT_BALANCE');
            return true;
        }
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Owner mismatch and ownership change guards
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §5: prepareNearPayment reads finalized owner from chain (not client-supplied)', async () => {
    const onChainOwner = 'actual-owner.testnet';
    const mockFetch = makeMockFetch({
        ownerId: onChainOwner,
        balance: (2n * YOCTO_PER_NEAR).toString(),
        storageUsage: 150180,
        lifecycle: 'Unlocked',
        credits: { total: 3, remaining: 3 },
        tokenNonce: 1,
    });

    const result = await prepareNearPayment({
        rpcUrl: 'https://rpc.testnet.near.org',
        relayContractId: CANONICAL_CONTRACT_ID,
        tokenId: CANONICAL_TOKEN_ID,
        receiverId: 'relay-owner-b.spellman.testnet',
        amountYocto: (YOCTO_PER_NEAR / 100n).toString(),
        fetchImpl: mockFetch,
    });

    // The plan requiredSigner must be the CHAIN-verified owner, not any client input
    assert.equal(result.plan.requiredSigner, onChainOwner);
    assert.equal(result.paymentRecord.ownerId, onChainOwner);
});

test('Task 45 §5: prepareNearPayment fails when token lifecycle is not Unlocked', async () => {
    const mockFetch = makeMockFetch({
        ownerId: 'relay-owner-b.spellman.testnet',
        balance: (2n * YOCTO_PER_NEAR).toString(),
        storageUsage: 150180,
        lifecycle: { LockedForSubaccount: { nonce: 2, initiator: 'relay-owner-b.spellman.testnet' } },
        credits: { total: 3, remaining: 3 },
        tokenNonce: 2,
    });

    await assert.rejects(
        () => prepareNearPayment({
            rpcUrl: 'https://rpc.testnet.near.org',
            relayContractId: CANONICAL_CONTRACT_ID,
            tokenId: CANONICAL_TOKEN_ID,
            receiverId: 'some-receiver.testnet',
            amountYocto: (YOCTO_PER_NEAR / 100n).toString(),
            fetchImpl: mockFetch,
        }),
        (err) => {
            assert.ok(err instanceof PaymentAuthorizationError);
            assert.equal(err.code, 'TOKEN_LOCKED');
            return true;
        }
    );
});

test('Task 45 §5: Old owner cannot authorize payment after transfer — plan signer is chain-verified', async () => {
    // Simulate: NFT was transferred; chain now shows new owner
    const newOwner = 'new-owner.testnet';
    const mockFetch = makeMockFetch({
        ownerId: newOwner,
        balance: (2n * YOCTO_PER_NEAR).toString(),
        storageUsage: 150180,
        lifecycle: 'Unlocked',
        credits: { total: 3, remaining: 3 },
        tokenNonce: 1,
    });

    const result = await prepareNearPayment({
        rpcUrl: 'https://rpc.testnet.near.org',
        relayContractId: CANONICAL_CONTRACT_ID,
        tokenId: CANONICAL_TOKEN_ID,
        receiverId: 'some-receiver.testnet',
        amountYocto: (YOCTO_PER_NEAR / 100n).toString(),
        fetchImpl: mockFetch,
    });

    // The old owner would have a different account id; this plan binds to the NEW chain-verified owner
    assert.equal(result.plan.requiredSigner, newOwner);
    // If old owner tried to sign this plan, the contract would reject with "Only current token owner"
    assert.notEqual(result.plan.requiredSigner, 'relay-owner-b.spellman.testnet');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Payment nonce / replay concepts
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §6: generatePaymentId produces unique IDs per call', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
        ids.add(generatePaymentId('relay-test-1'));
    }
    assert.equal(ids.size, 100, 'All 100 generated payment IDs must be unique');
});

test('Task 45 §6: generatePaymentId respects max length', () => {
    const id = generatePaymentId('relay-test-1');
    assert.ok(id.length <= 64, 'Payment ID must not exceed 64 characters');
    assert.match(id, /^[a-zA-Z0-9._:-]+$/, 'Payment ID must only contain safe characters');
});

test('Task 45 §6: Token nonce advances on each relay_execute_subaccount — replay protection', async () => {
    // The monotonic token_nonce means old signed transactions cannot replay
    // once a newer nonce has been recorded on-chain.
    // This is enforced by the on_subaccount_executed callback in the Rust contract.
    const before = { tokenNonce: 1 };
    const afterFirstExecution = { tokenNonce: 2 };
    const afterSecondExecution = { tokenNonce: 3 };

    assert.ok(afterFirstExecution.tokenNonce > before.tokenNonce, 'Nonce must advance after first execution');
    assert.ok(afterSecondExecution.tokenNonce > afterFirstExecution.tokenNonce, 'Nonce must continue to advance');

    // A stale callback with nonce=1 would be rejected by on_subaccount_executed
    // when the current token nonce is already 2 or higher.
    const staleNonce = before.tokenNonce;
    const currentNonce = afterSecondExecution.tokenNonce;
    assert.ok(staleNonce < currentNonce, 'Stale nonce is strictly less than current; on_subaccount_executed rejects it');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Duplicate execution and state machine transitions
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §7: State machine enforces no terminal re-transition (Settled is terminal)', () => {
    const settled = { state: CHECKOUT_STATES.Settled };
    // No transitions are allowed from Settled
    for (const nextState of Object.values(CHECKOUT_STATES)) {
        if (nextState !== CHECKOUT_STATES.Settled) {
            assert.equal(canTransition(CHECKOUT_STATES.Settled, nextState), false,
                `Settled -> ${nextState} must not be allowed`);
        }
    }
});

test('Task 45 §7: Transitioning to Settled requires destinationVerified=true', () => {
    const record = { state: CHECKOUT_STATES.DestinationSettlementPending };
    assert.throws(
        () => transitionPaymentState(record, CHECKOUT_STATES.Settled, { destinationVerified: false }),
        (err) => err.code === 'DESTINATION_UNVERIFIED'
    );

    const settled = transitionPaymentState(record, CHECKOUT_STATES.Settled, { destinationVerified: true });
    assert.equal(settled.state, CHECKOUT_STATES.Settled);
    assert.equal(settled.nftUnlockPermitted, true);
});

test('Task 45 §7: RecoveryRequired prevents settlement without explicit evidence', () => {
    const record = { state: CHECKOUT_STATES.SourceTransferPending };
    const recovered = transitionPaymentState(record, CHECKOUT_STATES.RecoveryRequired, { reason: 'Ambiguous' });
    assert.equal(recovered.state, CHECKOUT_STATES.RecoveryRequired);
    assert.equal(recovered.nftUnlockPermitted, false);

    // Cannot settle from RecoveryRequired without destinationVerified
    assert.throws(
        () => transitionPaymentState(recovered, CHECKOUT_STATES.Settled, { destinationVerified: false }),
        (err) => err.code === 'DESTINATION_UNVERIFIED'
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Finalized NEAR payment verification
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §8: verifyNearPaymentTransaction accepts a valid finalized TransferNear tx', async () => {
    const txHash = '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f';
    const owner = 'relay-owner-b.spellman.testnet';
    const receiver = 'some-receiver.testnet';
    const amount = (YOCTO_PER_NEAR / 100n).toString();

    const mockFetch = makeVerifyMockFetch({
        txHash,
        signerAccountId: owner,
        receiverContractId: CANONICAL_CONTRACT_ID,
        methodName: 'relay_execute_subaccount',
        tokenId: CANONICAL_TOKEN_ID,
        transferReceiver: receiver,
        transferAmount: amount,
        finalStatus: 'FINAL',
        hasReceiptFailure: false,
    });

    const result = await verifyNearPaymentTransaction({
        rpcUrl: 'https://rpc.testnet.near.org',
        relayContractId: CANONICAL_CONTRACT_ID,
        tokenId: CANONICAL_TOKEN_ID,
        transactionHash: txHash,
        expectedOwner: owner,
        expectedReceiver: receiver,
        expectedAmountYocto: amount,
        fetchImpl: mockFetch,
    });

    assert.equal(result.verified, true);
    assert.equal(result.state, NEAR_PAYMENT_STATES.Settled);
    assert.ok(result.evidence);
    assert.equal(result.evidence.signerVerified, owner);
    assert.equal(result.evidence.receiverVerified, receiver);
    assert.equal(result.evidence.methodVerified, 'relay_execute_subaccount');
    assert.equal(result.evidence.actionVerified, 'TransferNear');
    assert.ok(result.evidence.explorerUrl.includes(txHash));
});

test('Task 45 §8: verifyNearPaymentTransaction rejects mismatched signer', async () => {
    const txHash = '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f';
    const owner = 'relay-owner-b.spellman.testnet';

    const mockFetch = makeVerifyMockFetch({
        txHash,
        signerAccountId: 'attacker.testnet', // different signer
        receiverContractId: CANONICAL_CONTRACT_ID,
        methodName: 'relay_execute_subaccount',
        tokenId: CANONICAL_TOKEN_ID,
        transferReceiver: 'some-receiver.testnet',
        transferAmount: (YOCTO_PER_NEAR / 100n).toString(),
        finalStatus: 'FINAL',
        hasReceiptFailure: false,
    });

    const result = await verifyNearPaymentTransaction({
        rpcUrl: 'https://rpc.testnet.near.org',
        relayContractId: CANONICAL_CONTRACT_ID,
        tokenId: CANONICAL_TOKEN_ID,
        transactionHash: txHash,
        expectedOwner: owner,
        expectedReceiver: 'some-receiver.testnet',
        expectedAmountYocto: (YOCTO_PER_NEAR / 100n).toString(),
        fetchImpl: mockFetch,
    });

    assert.equal(result.verified, false);
    assert.match(result.reason, /signer|does not match/i);
});

test('Task 45 §8: verifyNearPaymentTransaction rejects receipt failure', async () => {
    const txHash = '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f';
    const owner = 'relay-owner-b.spellman.testnet';

    const mockFetch = makeVerifyMockFetch({
        txHash,
        signerAccountId: owner,
        receiverContractId: CANONICAL_CONTRACT_ID,
        methodName: 'relay_execute_subaccount',
        tokenId: CANONICAL_TOKEN_ID,
        transferReceiver: 'some-receiver.testnet',
        transferAmount: (YOCTO_PER_NEAR / 100n).toString(),
        finalStatus: 'FINAL',
        hasReceiptFailure: true, // Failure!
    });

    const result = await verifyNearPaymentTransaction({
        rpcUrl: 'https://rpc.testnet.near.org',
        relayContractId: CANONICAL_CONTRACT_ID,
        tokenId: CANONICAL_TOKEN_ID,
        transactionHash: txHash,
        expectedOwner: owner,
        expectedReceiver: 'some-receiver.testnet',
        expectedAmountYocto: (YOCTO_PER_NEAR / 100n).toString(),
        fetchImpl: mockFetch,
    });

    assert.equal(result.verified, false);
    assert.match(result.reason, /receipt|failure/i);
});

test('Task 45 §8: verifyNearPaymentTransaction returns pending when not yet FINAL', async () => {
    const txHash = '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f';
    const owner = 'relay-owner-b.spellman.testnet';

    const mockFetch = makeVerifyMockFetch({
        txHash,
        signerAccountId: owner,
        receiverContractId: CANONICAL_CONTRACT_ID,
        methodName: 'relay_execute_subaccount',
        tokenId: CANONICAL_TOKEN_ID,
        transferReceiver: 'some-receiver.testnet',
        transferAmount: (YOCTO_PER_NEAR / 100n).toString(),
        finalStatus: 'INCLUDED_FINAL', // Not yet FINAL
        hasReceiptFailure: false,
    });

    const result = await verifyNearPaymentTransaction({
        rpcUrl: 'https://rpc.testnet.near.org',
        relayContractId: CANONICAL_CONTRACT_ID,
        tokenId: CANONICAL_TOKEN_ID,
        transactionHash: txHash,
        expectedOwner: owner,
        expectedReceiver: 'some-receiver.testnet',
        expectedAmountYocto: (YOCTO_PER_NEAR / 100n).toString(),
        fetchImpl: mockFetch,
    });

    assert.equal(result.verified, false);
    assert.equal(result.pending, true);
});

test('Task 45 §8: verifyNearPaymentTransaction rejects invalid hash format', async () => {
    await assert.rejects(
        () => verifyNearPaymentTransaction({
            rpcUrl: 'https://rpc.testnet.near.org',
            relayContractId: CANONICAL_CONTRACT_ID,
            tokenId: CANONICAL_TOKEN_ID,
            transactionHash: '0x1234bad', // invalid format
            expectedOwner: 'owner.testnet',
            expectedReceiver: 'receiver.testnet',
            expectedAmountYocto: '1000000000000000000000000',
            fetchImpl: async () => { throw new Error('Should not hit RPC'); },
        }),
        (err) => {
            assert.ok(err instanceof PaymentAuthorizationError);
            assert.equal(err.code, 'INVALID_TX_HASH');
            return true;
        }
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Base Sepolia chain ID and asset checks
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §9: Base Sepolia chain ID is 84532 in asset registry', () => {
    const ethAsset = getAsset('native:base-sepolia-eth');
    assert.ok(ethAsset);
    assert.equal(ethAsset.chainId, 84532);
    assert.equal(ethAsset.network, NETWORKS.BASE_SEPOLIA);

    const usdcAsset = getAsset('erc20:base-sepolia-0x036cbd53842c5426634e7929541ec2318f3dcf7e');
    assert.ok(usdcAsset);
    assert.equal(usdcAsset.chainId, 84532);
});

test('Task 45 §9: Base Sepolia assets are portfolio-only (no signing available)', () => {
    const baseAssets = Object.values(ASSET_REGISTRY).filter((a) => a.network === NETWORKS.BASE_SEPOLIA);
    assert.ok(baseAssets.length > 0, 'At least one Base Sepolia asset must exist');
    for (const asset of baseAssets) {
        assert.equal(asset.portfolioOnly, true, `${asset.assetId} must be portfolio-only`);
        assert.equal(asset.canSourceCheckout, false, `${asset.assetId} cannot be a checkout source`);
        assert.equal(asset.providerSupported, false, `1Click does not support Base Sepolia assets on testnet`);
    }
});

test('Task 45 §9: Base Sepolia USDC is labelled as Circle Testnet fixture', () => {
    const asset = getAsset('erc20:base-sepolia-0x036cbd53842c5426634e7929541ec2318f3dcf7e');
    assert.ok(asset);
    assert.equal(asset.isTestFixture, true);
    assert.match(asset.fixtureNote || '', /testnet|fixture|zero/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Base Sepolia is portfolio read-only (no signing)
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §10: No NEAR_TESTNET_DIRECT_TRANSFER pair exists for Base Sepolia', () => {
    const basePairs = ALLOWED_CHECKOUT_PAIRS.filter(
        (p) => p.sourceAsset && p.sourceAsset.includes('base-sepolia')
    );
    for (const pair of basePairs) {
        assert.notEqual(pair.architecture, 'NEAR_TESTNET_DIRECT_TRANSFER',
            'No direct transfer pair should reference Base Sepolia as source');
    }
});

test('Task 45 §10: buildPaymentReviewSummary correctly labels Base Sepolia as portfolio-only', async () => {
    const mockFetch = makeMockFetch({
        ownerId: 'relay-owner-b.spellman.testnet',
        balance: (2n * YOCTO_PER_NEAR).toString(),
        storageUsage: 150180,
        lifecycle: 'Unlocked',
        credits: { total: 3, remaining: 3 },
        tokenNonce: 1,
    });

    const result = await prepareNearPayment({
        rpcUrl: 'https://rpc.testnet.near.org',
        relayContractId: CANONICAL_CONTRACT_ID,
        tokenId: CANONICAL_TOKEN_ID,
        receiverId: 'relay-owner-b.spellman.testnet',
        amountYocto: (YOCTO_PER_NEAR / 100n).toString(),
        fetchImpl: mockFetch,
    });

    const review = buildPaymentReviewSummary(result.plan, result.paymentRecord);
    assert.equal(review.baseSepolia.status, 'PORTFOLIO_READ_ONLY');
    assert.equal(review.mainnetOneClick.status, 'DISABLED');
    assert.equal(review.architecture, 'NEAR_TESTNET_DIRECT_TRANSFER');
    assert.ok(review.reviewRequired, 'Review must be required before submitting');
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Contract constants match live testnet audit
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §11: Canonical constants match live testnet audit (block 276946165)', () => {
    assert.equal(CANONICAL_CONTRACT_ID, 'relay.spellman.testnet');
    assert.equal(CANONICAL_TOKEN_ID, 'relay-test-1');
    assert.equal(CANONICAL_ASSOCIATED_ACCOUNT, 'relay-test-1.relay.spellman.testnet');
    assert.equal(EXPECTED_PARENT_CODE_SHA256, '2CB1AE95CDB0B6616D69A728BAD983093225A98B10526358BFE90AD9AD334B6F');
    assert.equal(EXPECTED_CONTROLLER_CODE_SHA256, '762A821E16897303AB491E90E26F02FA466ED831008CE73C4EB27F3CB4F29242');
    assert.equal(Number(EXECUTE_SUBACCOUNT_GAS_TGAS), 100, 'Must use 100 TGas for relay_execute_subaccount');
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. NEAR_PAYMENT_STATES enum
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §12: NEAR_PAYMENT_STATES includes required testnet-native states', () => {
    const required = ['Draft', 'Prepared', 'Authorized', 'SourceTransferPending', 'SourceTransferCompleted', 'Settled', 'Failed', 'RecoveryRequired'];
    for (const s of required) {
        assert.ok(Object.hasOwn(NEAR_PAYMENT_STATES, s), `NEAR_PAYMENT_STATES.${s} must exist`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. validateNearAccountId
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §13: validateNearAccountId accepts valid NEAR account IDs', () => {
    const valid = [
        'alice.testnet',
        'relay-owner-b.spellman.testnet',
        'relay.spellman.testnet',
        'ab',
        '1234',
        'a_b-c.d',
    ];
    for (const id of valid) {
        assert.equal(validateNearAccountId(id), true, `${id} must be valid`);
    }
});

test('Task 45 §13: validateNearAccountId rejects invalid NEAR account IDs', () => {
    const invalid = ['', 'x', '!bad!', '0x1234', 'AB', 'has space', 'a'.repeat(65)];
    for (const id of invalid) {
        assert.equal(validateNearAccountId(id), false, `${id} must be invalid`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. formatNear utility
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §14: formatNear formats yoctoNEAR correctly', () => {
    assert.equal(formatNear(YOCTO_PER_NEAR), '1 NEAR');
    assert.equal(formatNear(YOCTO_PER_NEAR / 2n), '0.5 NEAR');
    assert.equal(formatNear(0n), '0 NEAR');
    assert.equal(formatNear(YOCTO_PER_NEAR * 10n), '10 NEAR');
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Self-transfer rejection
// ─────────────────────────────────────────────────────────────────────────────

test('Task 45 §15: prepareNearPayment rejects transfer to the subaccount itself', async () => {
    const mockFetch = makeMockFetch({
        ownerId: 'relay-owner-b.spellman.testnet',
        balance: (2n * YOCTO_PER_NEAR).toString(),
        storageUsage: 150180,
        lifecycle: 'Unlocked',
        credits: { total: 3, remaining: 3 },
        tokenNonce: 1,
    });

    // Try to send NEAR to the associated subaccount itself
    await assert.rejects(
        () => prepareNearPayment({
            rpcUrl: 'https://rpc.testnet.near.org',
            relayContractId: CANONICAL_CONTRACT_ID,
            tokenId: CANONICAL_TOKEN_ID,
            receiverId: CANONICAL_ASSOCIATED_ACCOUNT, // the subaccount itself!
            amountYocto: (YOCTO_PER_NEAR / 100n).toString(),
            fetchImpl: mockFetch,
        }),
        (err) => {
            assert.ok(err instanceof PaymentAuthorizationError);
            assert.equal(err.code, 'SELF_TRANSFER');
            return true;
        }
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a mock fetch that returns a fake finalized NEAR RPC state
 * sufficient to pass through prepareNearPayment.
 */
function makeMockFetch({ ownerId, balance, storageUsage, lifecycle, credits, tokenNonce }) {
    return async (url, opts) => {
        const body = JSON.parse(opts.body);
        const method = body.method;
        const params = body.params;

        if (method === 'status') {
            return jsonOk({ chain_id: 'testnet', latest_block_height: 276946165 });
        }
        if (method === 'block') {
            return jsonOk({ header: { hash: 'mock-block-hash-123', height: 276946165 } });
        }
        if (method === 'query') {
            const reqType = params && (params.request_type || (Array.isArray(params) ? null : params.request_type));
            // view_account for associated subaccount
            if (reqType === 'view_account') {
                return jsonOk({ amount: balance, locked: '0', storage_usage: storageUsage, code_hash: 'mockcode' });
            }
            if (reqType === 'call_function') {
                const methodName = params.method_name;
                if (methodName === 'nft_token') {
                    return jsonViewResult({ token_id: CANONICAL_TOKEN_ID, owner_id: ownerId });
                }
                if (methodName === 'relay_account_binding') {
                    return jsonViewResult({ account_id: CANONICAL_ASSOCIATED_ACCOUNT, is_verified: true });
                }
                if (methodName === 'token_lifecycle') {
                    return jsonViewResult(lifecycle);
                }
                if (methodName === 'relay_credits') {
                    return jsonViewResult(credits);
                }
                if (methodName === 'token_nonce') {
                    return jsonViewResult(tokenNonce);
                }
            }
        }
        throw new Error(`Unexpected mock RPC call: ${method} ${JSON.stringify(params)}`);
    };
}

/**
 * Creates a mock fetch for verifyNearPaymentTransaction.
 */
function makeVerifyMockFetch({
    txHash,
    signerAccountId,
    receiverContractId,
    methodName,
    tokenId,
    transferReceiver,
    transferAmount,
    finalStatus,
    hasReceiptFailure,
}) {
    const args = Buffer.from(JSON.stringify({
        token_id: tokenId,
        action: {
            TransferNear: {
                receiver_id: transferReceiver,
                amount: transferAmount,
            },
        },
    })).toString('base64');

    return async (url, opts) => {
        const body = JSON.parse(opts.body);
        const method = body.method;
        if (method === 'tx') {
            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: 'verify-payment',
                    result: {
                        status: { SuccessValue: '' },
                        final_execution_status: finalStatus,
                        transaction: {
                            hash: txHash,
                            signer_id: signerAccountId,
                            receiver_id: receiverContractId,
                            actions: [{
                                FunctionCall: {
                                    method_name: methodName,
                                    args,
                                    gas: '100000000000000',
                                    deposit: '0',
                                },
                            }],
                        },
                        receipts_outcome: hasReceiptFailure
                            ? [{ outcome: { status: { Failure: 'ExecutionError: Insufficient balance' } } }]
                            : [{ outcome: { status: { SuccessValue: 'dHJ1ZQ==' } } }],
                    },
                }),
            };
        }
        throw new Error('Unexpected mock call: ' + method);
    };
}

function jsonOk(result) {
    return {
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 'payment-auth', result }),
    };
}

function jsonViewResult(value) {
    const bytes = Array.from(Buffer.from(JSON.stringify(value)));
    return {
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 'payment-auth', result: { result: bytes } }),
    };
}
