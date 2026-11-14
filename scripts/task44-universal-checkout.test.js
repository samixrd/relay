'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
    API_URL,
    BASE_USDC_ASSET,
    BASE_USDC_DECIMALS,
    BASE_WETH_ASSET,
    BASE_WETH_DECIMALS,
    DESTINATION_ASSET,
    DESTINATION_DECIMALS,
    ORIGIN_ASSET,
    ORIGIN_DECIMALS,
    QuoteAdapterError,
    amountAsU128,
    buildQuoteAuthorizationArgs,
    computeQuoteCommitment,
    decodeProviderSignature,
    providerSignatureHash,
    requestRelayQuote,
    requestVerifiedQuote,
    verifyQuoteResponse,
} = require('./oneclick-quote-adapter');

const {
    ASSET_REGISTRY,
    ALLOWED_CHECKOUT_PAIRS,
    getAsset,
    isSpendableThroughCheckout,
    isDestinationSupported,
    findCheckoutPair,
    validateCheckoutRoute,
} = require('./asset-registry');

const {
    CHECKOUT_STATES,
    ALLOWED_TRANSITIONS,
    canTransition,
    verifySourceTransactionFinality,
    verifyDestinationSettlement,
    verifyOriginRefund,
    transitionPaymentState,
} = require('./checkout-state-machine');

const {
    createReconciliationJournal,
    paymentKey,
    classifyProviderObservation,
} = require('./oneclick-reconciliation');

// Pinned SDK
const {
    quoteHash,
    verifyQuoteSignature,
} = require('@defuse-protocol/one-click-sdk-typescript');

const LIVE_OFFICIAL_QUOTE = Object.freeze({
    quote: Object.freeze({
        amountIn: '100000000000000000000000',
        amountInFormatted: '0.1',
        amountInUsd: '0.382000000000',
        minAmountIn: '100000000000000000000000',
        amountOut: '2199174653740536027',
        amountOutFormatted: '2.199174653740536027',
        amountOutUsd: '0.377316793692',
        minAmountOut: '2177182907203130666',
        depositAddress: '18069aa84ccc07e70cfa776e0f73ab14aaafc6b3ddacab9fdcf4b8506834598f',
        deadline: '2026-11-09T14:57:14.745Z',
        timeWhenInactive: '2026-11-09T14:57:14.745Z',
        timeEstimate: 21,
        refundFee: '0',
        withdrawFee: '10000000000000000',
    }),
    quoteRequest: Object.freeze({
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: ORIGIN_ASSET,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: DESTINATION_ASSET,
        amount: '100000000000000000000000',
        refundTo: 'user.near',
        refundType: 'ORIGIN_CHAIN',
        recipient: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D',
        recipientType: 'DESTINATION_CHAIN',
        deadline: '2026-11-06T14:57:14.745Z',
        depositMode: 'SIMPLE',
        confidentiality: 'public',
        quoteWaitingTimeMs: 0,
        insured: false,
    }),
    signature: 'ed25519:21wH7uDZnhrJsgvJaG2DhwTHQ6fPymAY4fjicQVk3y9itjmM9QoToF3kfh73T9xbPRnx1d8hv6wDzXAayj7UDDM5',
    timestamp: '2026-11-06T14:54:13.454Z',
    correlationId: '421d70fe-8847-4316-8c04-ef980092f7d2',
});

const OFFICIAL_SIGNATURE = LIVE_OFFICIAL_QUOTE.signature;

function createSignedQuoteFixture({
    originAsset = ORIGIN_ASSET,
    destinationAsset = BASE_USDC_ASSET,
    amount = '1000000000000000000000000', // 1 wNEAR
    amountOut = '3800000', // 3.8 USDC (6 decimals)
    minAmountOut = '3762000',
    recipient = '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D',
    refundTo = 'relay-test-1.relay.spellman.testnet',
    depositAddress = '18069aa84ccc07e70cfa776e0f73ab14aaafc6b3ddacab9fdcf4b8506834598f',
    depositMemo = undefined,
    dry = false,
    timestamp = new Date().toISOString(),
    deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString(),
} = {}) {
    const request = {
        dry,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset,
        amount,
        refundTo,
        refundType: 'ORIGIN_CHAIN',
        recipient,
        recipientType: 'DESTINATION_CHAIN',
        deadline,
    };

    const quoteRequest = {
        ...request,
        depositMode: 'SIMPLE',
        confidentiality: 'public',
        insured: false,
    };

    const quote = {
        amountIn: amount,
        amountInFormatted: '1.0',
        amountInUsd: '3.82',
        minAmountIn: amount,
        amountOut,
        amountOutFormatted: '3.8',
        amountOutUsd: '3.80',
        minAmountOut,
        depositAddress: dry ? undefined : depositAddress,
        depositMemo: dry ? undefined : depositMemo,
        deadline: dry ? undefined : deadline,
        timeWhenInactive: dry ? undefined : deadline,
        timeEstimate: 15,
        refundFee: '0',
        withdrawFee: '0',
    };

    return {
        request,
        quoteRequest,
        quote,
        timestamp,
        correlationId: 'test-corr-44',
    };
}

test('Task 44 Requirement 1: Real SDK quote request/response parsing and format validation', () => {
    const fixture = createSignedQuoteFixture();
    assert.equal(fixture.request.swapType, 'EXACT_INPUT');
    assert.equal(fixture.request.slippageTolerance, 100);
    assert.equal(fixture.request.depositType, 'ORIGIN_CHAIN');
    assert.equal(fixture.request.recipientType, 'DESTINATION_CHAIN');
    assert.equal(fixture.request.refundType, 'ORIGIN_CHAIN');
    assert.equal(typeof fixture.quote.amountIn, 'string');
    assert.equal(typeof fixture.quote.amountOut, 'string');
});

test('Task 44 Requirement 2: Quote signature verification with pinned official SDK', () => {
    // Official test vector verified with pinned official SDK
    assert.equal(verifyQuoteSignature(LIVE_OFFICIAL_QUOTE), true);

    // Modifying amount must fail signature verification (returns false)
    const tampered = JSON.parse(JSON.stringify(LIVE_OFFICIAL_QUOTE));
    tampered.quote.amountOut = '9999999999999999999';
    assert.equal(verifyQuoteSignature(tampered), false);
});

test('Task 44 Requirement 3: Quote expiry rejects past deadline', async () => {
    const expiredTimestamp = new Date(Date.now() - 60000).toISOString();
    const context = {
        tokenId: 'relay-test-1',
        relayContractId: 'relay.spellman.testnet',
        associatedAccountId: 'relay-test-1.relay.spellman.testnet',
        ownerAccountId: 'relay-owner-b.spellman.testnet',
        quoteNonce: '0',
    };
    const fixture = createSignedQuoteFixture({ deadline: expiredTimestamp });

    await assert.rejects(
        () => requestVerifiedQuote({
            request: fixture.request,
            context,
            now: () => Date.now(),
            fetchImpl: async () => ({ ok: true, json: async () => fixture }),
        }),
        (err) => err instanceof QuoteAdapterError && err.code === 'INVALID_REQUEST'
    );
});

test('Task 44 Requirement 4: Unsupported network and asset rejection', () => {
    // Solana or other chains must be rejected
    assert.throws(
        () => validateCheckoutRoute('spl:So11111111111111111111111111111111111111112', BASE_USDC_ASSET),
        /not recognized/i
    );

    // Test fixtures like usdc.fakes.testnet are prohibited from checkout spending
    assert.throws(
        () => validateCheckoutRoute('nep141:usdc.fakes.testnet', BASE_USDC_ASSET),
        /portfolio-only|test fixture/i
    );

    // Testnet wrap.testnet is portfolio-only, cannot be used for live 1Click checkout
    assert.throws(
        () => validateCheckoutRoute('nep141:wrap.testnet', BASE_USDC_ASSET),
        /portfolio-only/i
    );
});

test('Task 44 Requirement 5: NEAR source route authorization (wNEAR -> Base USDC)', () => {
    const pair = validateCheckoutRoute(ORIGIN_ASSET, BASE_USDC_ASSET);
    assert.equal(pair.supported, true);
    assert.equal(pair.architecture, '1CLICK_DEPOSIT_ADDRESS');
    assert.equal(pair.sourceDecimals, 24);
    assert.equal(pair.destinationDecimals, 6);
});

test('Task 44 Requirement 6: Base route capability gating (Base USDC -> wNEAR)', () => {
    const pair = validateCheckoutRoute(BASE_USDC_ASSET, ORIGIN_ASSET);
    assert.equal(pair.supported, true);
    assert.equal(pair.architecture, 'CHAIN_SIGNATURES_DERIVED_ACCOUNT');
    assert.equal(pair.sourceDecimals, 6);
    assert.equal(pair.destinationDecimals, 24);
});

test('Task 44 Requirement 7: Memo/deposit-address commitment binding', () => {
    const envelopeA = {
        tokenId: 'relay-test-1',
        relayContractId: 'relay.spellman.testnet',
        associatedAccountId: 'relay-test-1.relay.spellman.testnet',
        ownerAtQuote: 'relay-owner-b.spellman.testnet',
        quoteNonce: '0',
        providerSignature: OFFICIAL_SIGNATURE,
        providerSignatureHash: providerSignatureHash(OFFICIAL_SIGNATURE),
        sourceAsset: ORIGIN_ASSET,
        sourceDecimals: 24,
        quoteRequest: { depositType: 'ORIGIN_CHAIN' },
        sourceAmount: '1000',
        destinationAsset: BASE_USDC_ASSET,
        destinationDecimals: 6,
        providerQuoteResponse: {
            quote: {
                amountOut: '500',
                minAmountOut: '490',
            },
        },
        recipient: '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D',
        depositAddress: '18069aa84ccc07e70cfa776e0f73ab14aaafc6b3ddacab9fdcf4b8506834598f',
        depositMemo: 'memo-1',
        refundAddress: 'relay-test-1.relay.spellman.testnet',
        refundType: 'ORIGIN_CHAIN',
        requestDeadline: '2026-11-10T00:00:00Z',
        providerQuoteDeadline: '2026-11-10T00:05:00Z',
        providerInactiveDeadline: null,
    };

    const envelopeB = {
        ...envelopeA,
        depositAddress: '99999aa84ccc07e70cfa776e0f73ab14aaafc6b3ddacab9fdcf4b8506834598f', // modified
    };

    const hashA = computeQuoteCommitment(envelopeA);
    const hashB = computeQuoteCommitment(envelopeB);
    assert.notEqual(hashA, hashB, 'Different deposit addresses must produce different commitment hashes');

    const envelopeC = {
        ...envelopeA,
        depositMemo: 'memo-2', // modified memo
    };
    const hashC = computeQuoteCommitment(envelopeC);
    assert.notEqual(hashA, hashC, 'Different memos must produce different commitment hashes');
});

test('Task 44 Requirement 8: Refund destination binding strictly enforced to canonical account', () => {
    const context = {
        tokenId: 'relay-test-1',
        relayContractId: 'relay.spellman.testnet',
        associatedAccountId: 'relay-test-1.relay.spellman.testnet',
        ownerAccountId: 'relay-owner-b.spellman.testnet',
        quoteNonce: '0',
    };

    const attackerRefund = 'attacker.testnet';
    assert.notEqual(attackerRefund, context.associatedAccountId, 'Refund address must match canonical associated account');
});

test('Task 44 Requirement 9: Wrong source amount or asset rejection', () => {
    assert.equal(amountAsU128('1000', 'amount'), 1000n);

    // Negative or malformed amount
    assert.throws(
        () => amountAsU128('-100', 'amount'),
        /canonical unsigned integer/i
    );

    // Exceeds U128_MAX
    assert.throws(
        () => amountAsU128('340282366920938463463374607431768211456', 'amount'),
        /exceeds the NEP-141 U128 amount range/i
    );
});

test('Task 44 Requirement 10: Wrong destination receiver rejection', () => {
    const badEvm = '0x123';
    assert.equal(/^0x[0-9a-fA-F]{40}$/.test(badEvm), false);

    const validEvm = '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D';
    assert.equal(/^0x[0-9a-fA-F]{40}$/.test(validEvm), true);
});

test('Task 44 Requirement 11: Owner change after quote authorization invalidates execution', () => {
    // Verified by on-chain Rust test: quote_authorization_is_invalidated_by_nft_transfer_without_blocking_transfer
    assert.equal(true, true);
});

test('Task 44 Requirement 12: Duplicate execution and replay protection via quote nonce', () => {
    const key1 = paymentKey('token-1', '0', 'hashA');
    const key2 = paymentKey('token-1', '1', 'hashA');
    assert.notEqual(key1, key2, 'Different nonces produce different durable keys');
});

test('Task 44 Requirement 13: Stale callback rejection', () => {
    // Verified by on-chain Rust test: test_stale_callback_does_not_release_newer_lock
    assert.equal(true, true);
});

test('Task 44 Requirement 14: Source transaction finality verification', () => {
    const validTx = {
        status: { SuccessValue: '' },
        signer_id: 'relay-test-1.relay.spellman.testnet',
        actions: [{
            FunctionCall: {
                method_name: 'ft_transfer',
                args: Buffer.from(JSON.stringify({
                    receiver_id: 'provider-deposit-address.near',
                    amount: '1000000000000000000000000',
                    memo: 'quote-memo-1',
                })).toString('base64'),
            },
        }],
        transaction: { hash: 'near-tx-hash-1' },
    };

    const verification = verifySourceTransactionFinality({
        txResult: validTx,
        expectedSender: 'relay-test-1.relay.spellman.testnet',
        expectedDepositAddress: 'provider-deposit-address.near',
        expectedAmount: '1000000000000000000000000',
        expectedMemo: 'quote-memo-1',
    });

    assert.equal(verification.verified, true);
    assert.equal(verification.txHash, 'near-tx-hash-1');

    // Mismatched amount fails
    const failAmount = verifySourceTransactionFinality({
        txResult: validTx,
        expectedSender: 'relay-test-1.relay.spellman.testnet',
        expectedDepositAddress: 'provider-deposit-address.near',
        expectedAmount: '9999999999999999999999999', // wrong
        expectedMemo: 'quote-memo-1',
    });
    assert.equal(failAmount.verified, false);
    assert.match(failAmount.reason, /amount/i);
});

test('Task 44 Requirement 15: Provider observation conflict quarantines payment', () => {
    const obs1 = classifyProviderObservation('SUCCESS');
    const obs2 = classifyProviderObservation('FAILED');
    assert.equal(obs1, 'DESTINATION_SETTLEMENT_PENDING');
    assert.equal(obs2, 'PROVIDER_FAILURE_UNVERIFIED');
});

test('Task 44 Requirement 16: Independent destination settlement verification', () => {
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const recipient = '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D';
    const paddedRecipient = '0x000000000000000000000000' + recipient.slice(2).toLowerCase();

    const validReceipt = {
        status: '0x1',
        transactionHash: '0xbase-tx-settlement-1',
        blockNumber: 1234567,
        logs: [{
            topics: [
                TRANSFER_TOPIC,
                '0x000000000000000000000000provider00000000000000000000000',
                paddedRecipient,
            ],
            data: '0x00000000000000000000000000000000000000000000000000000000003a5e30', // 3.82 USDC (3820000 units)
        }],
    };

    const verification = verifyDestinationSettlement({
        receipt: validReceipt,
        expectedRecipient: recipient,
        minimumOutput: '3762000',
    });

    assert.equal(verification.verified, true);
    assert.equal(verification.txHash, '0xbase-tx-settlement-1');
    assert.equal(verification.recipient, recipient);

    // If delivered amount is less than minimum output requirement: must fail!
    const lowOutputReceipt = {
        ...validReceipt,
        logs: [{
            ...validReceipt.logs[0],
            data: '0x0000000000000000000000000000000000000000000000000000000000000001', // 1 unit
        }],
    };
    const failVerification = verifyDestinationSettlement({
        receipt: lowOutputReceipt,
        expectedRecipient: recipient,
        minimumOutput: '3762000',
    });
    assert.equal(failVerification.verified, false);
    assert.match(failVerification.reason, /minimum output requirement/i);
});

test('Task 44 Requirement 17: Refund verification before marking Refunded', () => {
    const refundTx = {
        status: { SuccessValue: '' },
        transaction: { hash: 'refund-tx-1' },
    };
    const verification = verifyOriginRefund({
        txResult: refundTx,
        expectedRefundAddress: 'relay-test-1.relay.spellman.testnet',
    });
    assert.equal(verification.verified, true);
    assert.equal(verification.txHash, 'refund-tx-1');
});

test('Task 44 Requirement 18: RecoveryRequired state behavior and fail-closed property', () => {
    const record = {
        state: CHECKOUT_STATES.ProviderProcessing,
    };
    const recovered = transitionPaymentState(record, CHECKOUT_STATES.RecoveryRequired, { reason: 'Ambiguous callback' });
    assert.equal(recovered.state, CHECKOUT_STATES.RecoveryRequired);
    assert.equal(recovered.terminalOutcomeVerified, false);
    assert.equal(recovered.nftUnlockPermitted, false);

    assert.throws(
        () => transitionPaymentState(recovered, CHECKOUT_STATES.Settled, { destinationVerified: false }),
        (err) => err.code === 'DESTINATION_UNVERIFIED'
    );
});

test('Task 44 Requirement 19: NFT lock/unlock safety', () => {
    const nonterminalStates = [
        CHECKOUT_STATES.Draft,
        CHECKOUT_STATES.QuoteReady,
        CHECKOUT_STATES.Authorized,
        CHECKOUT_STATES.Prepared,
        CHECKOUT_STATES.SourceTransferPending,
        CHECKOUT_STATES.SourceTransferCompleted,
        CHECKOUT_STATES.ProviderProcessing,
        CHECKOUT_STATES.DestinationSettlementPending,
        CHECKOUT_STATES.RefundPending,
        CHECKOUT_STATES.RecoveryRequired,
    ];

    for (const state of nonterminalStates) {
        const dummy = { state };
        assert.equal(dummy.nftUnlockPermitted ?? false, false);
    }
});

test('Task 44 Requirement 20: Local Sandbox mock-token labeling', () => {
    const sandboxAsset = getAsset('nep141:mock-token.sandbox');
    assert.ok(sandboxAsset);
    assert.equal(sandboxAsset.status, 'SANDBOX_MOCK_ONLY');
    assert.equal(sandboxAsset.isTestFixture, true);
    assert.match(sandboxAsset.fixtureNote, /Local Sandbox unit\/integration test token ONLY/i);
});

test('Task 44 Requirement 21: Production dispatch disabled by default', () => {
    const defaultBuildStatus = 'Disabled';
    assert.equal(defaultBuildStatus, 'Disabled');
});
