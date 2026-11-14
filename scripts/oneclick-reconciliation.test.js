'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    DESTINATION_ASSET,
    ORIGIN_ASSET,
    buildQuoteAuthorizationArgs,
    verifyQuoteResponse,
} = require('./oneclick-quote-adapter');
const {
    classifyProviderObservation,
    createReconciliationJournal,
    fetchOneClickStatus,
    paymentKey,
    pollPaymentStatus,
} = require('./oneclick-reconciliation');

const context = Object.freeze({
    tokenId: 'user',
    relayContractId: 'near',
    associatedAccountId: 'user.near',
    ownerAccountId: 'owner.near',
    quoteNonce: '0',
    relayStateBlockHash: '11111111111111111111111111111111',
});
const request = Object.freeze({
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
});

function liveSignedQuote() {
    return {
        quote: {
            amountIn: '100000000000000000000000',
            amountInFormatted: '0.1',
            amountInUsd: '0.382000000000',
            minAmountIn: '100000000000000000000000',
            amountOut: '2199174653740536027',
            amountOutFormatted: '2.199174653740536027',
            amountOutUsd: '0.377316793692',
            minAmountOut: '2177182907203130666',
            depositAddress:
                '18069aa84ccc07e70cfa776e0f73ab14aaafc6b3ddacab9fdcf4b8506834598f',
            deadline: '2026-11-09T14:57:14.745Z',
            timeWhenInactive: '2026-11-09T14:57:14.745Z',
            timeEstimate: 21,
            refundFee: '0',
            withdrawFee: '10000000000000000',
        },
        quoteRequest: {
            ...request,
            depositMode: 'SIMPLE',
            confidentiality: 'public',
            quoteWaitingTimeMs: 0,
            insured: false,
        },
        signature:
            'ed25519:21wH7uDZnhrJsgvJaG2DhwTHQ6fPymAY4fjicQVk3y9itjmM9QoToF3kfh73T9xbPRnx1d8hv6wDzXAayj7UDDM5',
        timestamp: '2026-11-06T14:54:13.454Z',
        correlationId: '421d70fe-8847-4316-8c04-ef980092f7d2',
    };
}

function registration({ mutateRpc = () => null } = {}) {
    const providerQuoteResponse = liveSignedQuote();
    const { envelope } = verifyQuoteResponse({
        request,
        context,
        providerResponse: providerQuoteResponse,
        now: Date.parse(providerQuoteResponse.timestamp),
    });
    const authorizationArgs = buildQuoteAuthorizationArgs(envelope);
    const paymentRecord = {
        token_id: context.tokenId,
        associated_account_id: context.associatedAccountId,
        owner_at_dispatch: context.ownerAccountId,
        source_ft_contract: 'wrap.near',
        receiver_id: envelope.depositAddress,
        amount: envelope.sourceAmount,
        nonce: 1,
        payment_id: `prepared-${authorizationArgs.quote.commitment_hash.slice(0, 16)}`,
        deadline: authorizationArgs.quote.provider_quote_deadline,
        transfer_call: false,
        resolved_amount_used: null,
        token_transfer_status: 'TokenTransferCompleted',
        checkout_status: 'SourceTransferCompleted',
        commitment_hash: authorizationArgs.quote.commitment_hash,
    };
    const authorization = {
        token_id: context.tokenId,
        parent_contract_id: context.relayContractId,
        associated_account_id: context.associatedAccountId,
        owner_at_authorization: context.ownerAccountId,
        nonce: context.quoteNonce,
        provider_signature_hash: authorizationArgs.quote.provider_signature_hash,
        commitment_hash: authorizationArgs.quote.commitment_hash,
        account_binding_verified: true,
        source_asset: authorizationArgs.quote.source_asset,
        source_decimals: authorizationArgs.quote.source_decimals,
        deposit_type: authorizationArgs.quote.deposit_type,
        source_amount: authorizationArgs.quote.source_amount,
        destination_asset: authorizationArgs.quote.destination_asset,
        destination_decimals: authorizationArgs.quote.destination_decimals,
        expected_output: authorizationArgs.quote.expected_output,
        minimum_output: authorizationArgs.quote.minimum_output,
        recipient: authorizationArgs.quote.recipient,
        deposit_address: authorizationArgs.quote.deposit_address,
        deposit_memo: authorizationArgs.quote.deposit_memo,
        refund_address: authorizationArgs.quote.refund_address,
        refund_type: authorizationArgs.quote.refund_type,
        request_deadline: authorizationArgs.quote.request_deadline,
        provider_quote_deadline: authorizationArgs.quote.provider_quote_deadline,
        provider_inactive_deadline: authorizationArgs.quote.provider_inactive_deadline,
        created_block_height: '1',
        created_timestamp: '1793976853454000000',
        deposit_dispatch_status: 'SourceTransferCompleted',
        status: 'Consumed',
    };
    const rpcFetchImpl = async (_url, options) => {
        const { method_name: methodName } = JSON.parse(options.body).params;
        const values = {
            nft_total_supply: '0',
            relay_payment: paymentRecord,
            relay_quote_authorization: authorization,
            nft_token: { owner_id: context.ownerAccountId },
            relay_account_binding: {
                account_id: context.associatedAccountId,
                is_verified: true,
            },
            is_token_locked: true,
        };
        const value = mutateRpc(methodName, values[methodName]) ?? values[methodName];
        if (value === undefined) throw new Error(`Unexpected view method ${methodName}`);
        return {
            ok: true,
            status: 200,
            json: async () => ({
                jsonrpc: '2.0',
                id: 'relay-quote-adapter',
                result: {
                    result: [...Buffer.from(JSON.stringify(value), 'utf8')],
                    block_hash: '11111111111111111111111111111111',
                },
            }),
        };
    };
    return {
        context,
        request,
        providerQuoteResponse,
        authorizationArgs,
        rpcUrl: 'http://127.0.0.1:3030',
        rpcFetchImpl,
    };
}

function statusResponse(input, status = 'PROCESSING') {
    return {
        correlationId: 'status-request-123',
        quoteResponse: input.providerQuoteResponse,
        status,
        updatedAt: '2026-11-08T10:00:00.000Z',
        swapDetails: {
            intentHashes: [],
            nearTxHashes: [],
            originChainTxHashes: [],
            destinationChainTxHashes: [],
        },
    };
}

async function temporaryJournal(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-reconciliation-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return path.join(directory, 'payments.jsonl');
}

test('persists quote-bound provider observations across restart without unlocking or terminal settlement', async (t) => {
    const filePath = await temporaryJournal(t);
    const input = registration();
    const first = await createReconciliationJournal({
        filePath,
        now: () => Date.parse('2026-11-08T10:00:00.000Z'),
    });
    const registered = await first.registerPayment(input);
    assert.equal(registered.sourceTransferSupported, true);
    assert.equal(registered.sourceCallbackSucceeded, true);
    assert.equal(registered.sourceEvidenceVerified, false);
    assert.equal(registered.phase, 'SOURCE_DEPOSIT_FINALITY_UNVERIFIED');
    assert.equal(registered.nftUnlockPermitted, false);
    assert.equal(registered.destinationVerification.supported, false);
    assert.equal(registered.refundVerification.supported, false);
    assert.match(registered.sourceLimitation, /No finalized NEAR transaction\/receipt evidence/);

    const successStatus = statusResponse(input, 'SUCCESS');
    successStatus.swapDetails.destinationChainTxHashes = [
        { hash: 'unverified-provider-reported-hash', explorerUrl: 'https://example.invalid/tx' },
    ];
    const observed = await first.observeProviderStatus(registered.id, successStatus);
    assert.equal(observed.providerObservations.length, 1);
    assert.equal(observed.phase, 'SOURCE_DEPOSIT_FINALITY_UNVERIFIED');
    assert.equal(observed.providerPhase, 'DESTINATION_SETTLEMENT_PENDING');
    assert.equal(observed.terminalOutcomeVerified, false);
    assert.equal(observed.nftUnlockPermitted, false);
    assert.equal(observed.providerStatusAuthenticated, false);
    assert.equal(observed.providerObservations[0].statusResponseAuthenticated, false);

    const restarted = await createReconciliationJournal({ filePath });
    const recovered = restarted.getPayment(registered.id);
    assert.equal(recovered.providerObservations[0].status, 'SUCCESS');
    assert.equal(recovered.phase, 'SOURCE_DEPOSIT_FINALITY_UNVERIFIED');
    assert.equal(recovered.providerPhase, 'DESTINATION_SETTLEMENT_PENDING');
    assert.equal(recovered.nftUnlockPermitted, false);
    assert.equal(restarted.listUnresolvedPayments().length, 1);
});

test('duplicate status observations are idempotent and all provider outcomes stay unverified', async (t) => {
    const filePath = await temporaryJournal(t);
    const input = registration();
    const journal = await createReconciliationJournal({
        filePath,
        now: () => Date.parse('2026-11-08T10:00:00.000Z'),
    });
    const record = await journal.registerPayment(input);
    const response = statusResponse(input, 'REFUNDED');
    const first = await journal.observeProviderStatus(record.id, response);
    const duplicate = await journal.observeProviderStatus(record.id, response);
    assert.equal(first.providerObservations.length, 1);
    assert.equal(duplicate.providerObservations.length, 1);
    assert.equal(duplicate.phase, 'SOURCE_DEPOSIT_FINALITY_UNVERIFIED');
    assert.equal(duplicate.providerPhase, 'REFUND_PENDING');
    assert.equal(duplicate.terminalOutcomeVerified, false);
    assert.equal(duplicate.nftUnlockPermitted, false);

    for (const status of ['KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'FAILED']) {
        const freshPath = await temporaryJournal(t);
        const isolated = await createReconciliationJournal({ filePath: freshPath });
        const freshRecord = await isolated.registerPayment(input);
        const result = await isolated.observeProviderStatus(
            freshRecord.id,
            statusResponse(input, status),
        );
        assert.equal(result.terminalOutcomeVerified, false, status);
        assert.equal(result.nftUnlockPermitted, false, status);
        assert.equal(result.phase, 'SOURCE_DEPOSIT_FINALITY_UNVERIFIED', status);
    }
});

test('older provider observations persist without overwriting newer source or provider evidence', async (t) => {
    const filePath = await temporaryJournal(t);
    const input = registration();
    const journal = await createReconciliationJournal({ filePath });
    const record = await journal.registerPayment(input);
    const newer = statusResponse(input, 'SUCCESS');
    newer.updatedAt = '2026-11-08T10:02:00.000Z';
    const first = await journal.observeProviderStatus(record.id, newer);
    assert.equal(first.phase, 'SOURCE_DEPOSIT_FINALITY_UNVERIFIED');
    assert.equal(first.providerPhase, 'DESTINATION_SETTLEMENT_PENDING');

    const older = statusResponse(input, 'PROCESSING');
    older.updatedAt = '2026-11-08T10:01:00.000Z';
    const result = await journal.observeProviderStatus(record.id, older);
    assert.equal(result.phase, 'SOURCE_DEPOSIT_FINALITY_UNVERIFIED');
    assert.equal(result.providerPhase, 'DESTINATION_SETTLEMENT_PENDING');
    assert.equal(result.providerObservations.length, 2);
    assert.equal(result.providerObservations[1].stale, true);

    const restarted = await createReconciliationJournal({ filePath });
    const recovered = restarted.getPayment(record.id);
    assert.equal(recovered.phase, 'SOURCE_DEPOSIT_FINALITY_UNVERIFIED');
    assert.equal(recovered.providerPhase, 'DESTINATION_SETTLEMENT_PENDING');
    assert.equal(recovered.providerObservations[1].stale, true);
    assert.equal(recovered.nftUnlockPermitted, false);
});

test('mismatched quote response is recorded as a conflict and quarantines the payment', async (t) => {
    const filePath = await temporaryJournal(t);
    const input = registration();
    const journal = await createReconciliationJournal({ filePath });
    const record = await journal.registerPayment(input);
    const altered = statusResponse(input, 'SUCCESS');
    altered.quoteResponse = structuredClone(input.providerQuoteResponse);
    altered.quoteResponse.quote.depositAddress = 'attacker.near';

    await assert.rejects(journal.observeProviderStatus(record.id, altered));
    const after = journal.getPayment(record.id);
    assert.equal(after.phase, 'RECOVERY_REQUIRED');
    assert.equal(after.conflicts.length, 1);
    assert.equal(after.nftUnlockPermitted, false);
});

test('conflicting terminal provider statuses quarantine without treating either as truth', async (t) => {
    const filePath = await temporaryJournal(t);
    const input = registration();
    const journal = await createReconciliationJournal({ filePath });
    const record = await journal.registerPayment(input);

    await journal.observeProviderStatus(record.id, statusResponse(input, 'SUCCESS'));
    const conflicted = await journal.observeProviderStatus(
        record.id,
        statusResponse(input, 'REFUNDED'),
    );
    assert.equal(conflicted.phase, 'RECOVERY_REQUIRED');
    assert.equal(conflicted.conflicts.length, 1);
    assert.equal(conflicted.terminalOutcomeVerified, false);
    assert.equal(conflicted.nftUnlockPermitted, false);
});

test('rejects a finalized RELAY view that is unlocked, has a changed owner, or altered authorization', async (t) => {
    for (const mutateRpc of [
        (method, value) => (method === 'is_token_locked' ? false : value),
        (method, value) =>
            method === 'nft_token' ? { owner_id: 'attacker.near' } : value,
        (method, value) =>
            method === 'relay_quote_authorization'
                ? { ...value, refund_address: 'attacker.near' }
                : value,
        (method, value) =>
            method === 'relay_payment' ? { ...value, amount: '1' } : value,
    ]) {
        const filePath = await temporaryJournal(t);
        const journal = await createReconciliationJournal({ filePath });
        await assert.rejects(journal.registerPayment(registration({ mutateRpc })));
        assert.equal(journal.listUnresolvedPayments().length, 0);
    }
});

test('rejects a payment record that does not identify the authorized wrap.near token', async (t) => {
    const filePath = await temporaryJournal(t);
    const input = registration({
        mutateRpc(method, value) {
            return method === 'relay_payment'
                ? { ...value, source_ft_contract: 'attacker-token.near' }
                : null;
        },
    });
    const journal = await createReconciliationJournal({ filePath });
    await assert.rejects(journal.registerPayment(input), /does not match the exact authorized quote/);
    assert.equal(journal.listUnresolvedPayments().length, 0);
});

test('callback ambiguity remains recovery-required and locked in the finalized snapshot', async (t) => {
    const filePath = await temporaryJournal(t);
    const input = registration({
        mutateRpc(method, value) {
            if (method === 'relay_payment') {
                return {
                    ...value,
                    checkout_status: 'RecoveryRequired',
                    token_transfer_status: 'RecoveryRequired',
                };
            }
            if (method === 'relay_quote_authorization') {
                return {
                    ...value,
                    status: 'RecoveryRequired',
                    deposit_dispatch_status: 'Dispatched',
                };
            }
            return null;
        },
    });
    const journal = await createReconciliationJournal({ filePath });
    const record = await journal.registerPayment(input);
    assert.equal(record.phase, 'RECOVERY_REQUIRED');
    assert.equal(record.nftUnlockPermitted, false);
    assert.equal(record.sourceEvidenceVerified, false);
});

test('payment replay under a different token or quote nonce has a distinct durable key', () => {
    const commitment = 'a'.repeat(64);
    assert.notEqual(paymentKey('token-a', '1', commitment), paymentKey('token-b', '1', commitment));
    assert.notEqual(paymentKey('token-a', '1', commitment), paymentKey('token-a', '2', commitment));
});

test('provider statuses are mapped to nonterminal observation states', () => {
    assert.equal(classifyProviderObservation('KNOWN_DEPOSIT_TX'), 'PROVIDER_DEPOSIT_UNCONFIRMED');
    assert.equal(classifyProviderObservation('PENDING_DEPOSIT'), 'PROVIDER_DEPOSIT_UNCONFIRMED');
    assert.equal(classifyProviderObservation('INCOMPLETE_DEPOSIT'), 'PROVIDER_DEPOSIT_UNCONFIRMED');
    assert.equal(classifyProviderObservation('PROCESSING'), 'PROVIDER_PROCESSING_UNVERIFIED');
    assert.equal(classifyProviderObservation('SUCCESS'), 'DESTINATION_SETTLEMENT_PENDING');
    assert.equal(classifyProviderObservation('REFUNDED'), 'REFUND_PENDING');
    assert.equal(classifyProviderObservation('FAILED'), 'PROVIDER_FAILURE_UNVERIFIED');
    assert.throws(() => classifyProviderObservation('UNKNOWN'), /Unsupported/);
});

test('provider and RPC outages are retried boundedly and never record failure as settlement', async (t) => {
    const filePath = await temporaryJournal(t);
    const input = registration();
    const journal = await createReconciliationJournal({ filePath });
    const record = await journal.registerPayment(input);
    let attempts = 0;
    await assert.rejects(
        pollPaymentStatus({
            journal,
            paymentId: record.id,
            maxAttempts: 3,
            fetchStatus: async () => {
                attempts += 1;
                const error = new Error('RPC unavailable');
                error.transient = true;
                throw error;
            },
            delay: async () => {},
        }),
        /RPC unavailable/,
    );
    assert.equal(attempts, 3);
    const after = journal.getPayment(record.id);
    assert.equal(after.pollFailures.length, 1);
    assert.equal(after.phase, 'SOURCE_DEPOSIT_FINALITY_UNVERIFIED');
    assert.equal(after.terminalOutcomeVerified, false);
    assert.equal(after.nftUnlockPermitted, false);
});

test('status fetcher requires credentials and binds exact address and optional memo', async () => {
    await assert.rejects(
        fetchOneClickStatus({ depositAddress: 'deposit.near', apiKey: '' }),
        /API key/,
    );
    let requestUrl;
    let requestOptions;
    const result = await fetchOneClickStatus({
        depositAddress: 'deposit.near',
        depositMemo: 'memo-7',
        apiKey: 'fixture-only',
        fetchImpl: async (url, options) => {
            requestUrl = new URL(url);
            requestOptions = options;
            return { ok: true, status: 200, json: async () => ({ status: 'PROCESSING' }) };
        },
    });
    assert.equal(requestUrl.searchParams.get('depositAddress'), 'deposit.near');
    assert.equal(requestUrl.searchParams.get('depositMemo'), 'memo-7');
    assert.equal(requestOptions.headers.Authorization, 'Bearer fixture-only');
    assert.equal(result.status, 'PROCESSING');
});

test('incomplete journal tail fails closed instead of silently losing recovery history', async (t) => {
    const filePath = await temporaryJournal(t);
    await fs.writeFile(filePath, '{"type":"REGISTER"');
    await assert.rejects(createReconciliationJournal({ filePath }), /incomplete event/);
});
