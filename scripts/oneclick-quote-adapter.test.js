'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { base58 } = require('@scure/base');
const { quoteHash } = require('@defuse-protocol/one-click-sdk-typescript');
const { defaultRpcUrl } = require('./request-oneclick-quote');
const {
    API_URL,
    AUTHORIZATION_DEPOSIT_HINT,
    DESTINATION_ASSET,
    ORIGIN_ASSET,
    SDK_VERSION,
    QuoteAdapterError,
    buildQuoteAuthorizationArgs,
    claimQuoteEnvelope,
    computeQuoteCommitment,
    decodeProviderSignature,
    fetchRelayQuoteContext,
    providerSignatureHash,
    requestRelayQuote,
    requestVerifiedQuote,
    verifyRelayQuoteAuthorization,
    verifyQuoteResponse,
} = require('./oneclick-quote-adapter');

test('quote CLI defaults to NEAR Testnet unless an RPC is explicitly configured', () => {
    assert.equal(defaultRpcUrl({}, {}), 'https://rpc.testnet.near.org');
    assert.equal(
        defaultRpcUrl({}, { NEAR_RPC_URL: 'https://rpc.mainnet.near.org' }),
        'https://rpc.mainnet.near.org',
    );
    assert.equal(
        defaultRpcUrl({ rpcurl: 'https://rpc.testnet.near.org' }, { NEAR_RPC_URL: 'https://rpc.mainnet.near.org' }),
        'https://rpc.testnet.near.org',
    );
});

const NOW = Date.parse('2026-11-06T14:55:00.000Z');
const context = Object.freeze({
    tokenId: 'user',
    relayContractId: 'near',
    associatedAccountId: 'user.near',
    ownerAccountId: 'owner.near',
    quoteNonce: '0',
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
            depositAddress: '18069aa84ccc07e70cfa776e0f73ab14aaafc6b3ddacab9fdcf4b8506834598f',
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

function verify(providerResponse = liveSignedQuote(), overrides = {}) {
    return verifyQuoteResponse({
        request: overrides.request || request,
        context: overrides.context || context,
        providerResponse,
        now: overrides.now ?? NOW,
    });
}

function assertAdapterError(promise, code) {
    return assert.rejects(promise, (error) => {
        assert.ok(error instanceof QuoteAdapterError);
        assert.equal(error.code, code);
        return true;
    });
}

function rpcResponse(value) {
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
}

function relayRpcFetch({ owner = context.ownerAccountId, nonce = '0', binding = {} } = {}) {
    return async (_url, options) => {
        const requestBody = JSON.parse(options.body);
        const { method_name: methodName } = requestBody.params;
        if (methodName === 'nft_total_supply') return rpcResponse('0');
        if (methodName === 'nft_token') {
            return rpcResponse({ owner_id: owner });
        }
        if (methodName === 'relay_account_binding') {
            return rpcResponse({
                account_id: context.associatedAccountId,
                is_verified: true,
                ...binding,
            });
        }
        if (methodName === 'relay_quote_nonce') return rpcResponse(nonce);
        throw new Error(`Unexpected view method ${methodName}`);
    };
}

function authorizedQuoteRecord() {
    const verified = verify();
    const args = buildQuoteAuthorizationArgs(verified.envelope);
    return {
        token_id: context.tokenId,
        parent_contract_id: context.relayContractId,
        associated_account_id: context.associatedAccountId,
        owner_at_authorization: context.ownerAccountId,
        nonce: context.quoteNonce,
        ...args.quote,
        account_binding_verified: true,
        created_block_height: '123',
        created_timestamp: '456',
        deposit_dispatch_status: 'Disabled',
        status: 'Prepared',
    };
}

test('verifies a valid live quote signature with the pinned official SDK', () => {
    const result = verify();
    assert.equal(SDK_VERSION, '0.1.26');
    assert.deepEqual(result.conditions, {
        httpRequestSucceeded: null,
        quoteSignatureValid: true,
        requestResponseBound: true,
        quoteAvailable: true,
        quoteUnexpired: true,
    });
});

test('exports the exact SDK-signed canonical payload and raw signature for contract verification', () => {
    const response = liveSignedQuote();
    const verified = verify(response);
    const args = buildQuoteAuthorizationArgs(verified.envelope);
    const digest = base58.encode(
        createHash('sha256').update(args.quote.provider_signed_payload, 'utf8').digest(),
    );
    assert.equal(digest, quoteHash(response));
    assert.deepEqual(
        args.quote.provider_signature,
        Array.from(decodeProviderSignature(response.signature)),
    );
});

test('rejects an invalid quote signature', () => {
    const response = liveSignedQuote();
    response.signature = `ed25519:${base58.encode(Buffer.alloc(64, 1))}`;
    assert.throws(() => verify(response), { code: 'INVALID_SIGNATURE' });
});

test('rejects a missing signature', () => {
    const response = liveSignedQuote();
    delete response.signature;
    assert.throws(() => verify(response), { code: 'INVALID_INPUT_OR_RESPONSE' });
});

test('rejects a modified signed amount', () => {
    const response = liveSignedQuote();
    response.quote.amountOut = '2199174653740536028';
    assert.throws(() => verify(response), { code: 'INVALID_SIGNATURE' });
});

test('rejects a modified signed deposit address', () => {
    const response = liveSignedQuote();
    response.quote.depositAddress = 'another-deposit-address';
    assert.throws(() => verify(response), { code: 'INVALID_SIGNATURE' });
});

test('rejects a modified signed deposit memo', () => {
    const response = liveSignedQuote();
    response.quote.depositMemo = 'attacker-selected-memo';
    assert.throws(() => verify(response), { code: 'INVALID_SIGNATURE' });
});

test('rejects a destination asset that differs from the original request', () => {
    const response = liveSignedQuote();
    response.quoteRequest.destinationAsset = ORIGIN_ASSET;
    assert.throws(() => verify(response), { code: 'REQUEST_RESPONSE_MISMATCH' });
});

test('rejects a recipient that differs from the original request', () => {
    const response = liveSignedQuote();
    response.quoteRequest.recipient = '0x1111111111111111111111111111111111111111';
    assert.throws(() => verify(response), { code: 'REQUEST_RESPONSE_MISMATCH' });
});

test('rejects a refund policy that differs from the original request', () => {
    const response = liveSignedQuote();
    response.quoteRequest.refundType = 'INTENTS';
    assert.throws(() => verify(response), { code: 'REQUEST_RESPONSE_MISMATCH' });
});

test('rejects unsupported unsigned provider deposit-mode fields', () => {
    const response = liveSignedQuote();
    response.quoteRequest.depositMode = 'INTENTS';
    assert.throws(() => verify(response), { code: 'REQUEST_RESPONSE_MISMATCH' });
});

test('rejects an expired signed quote and reports the separate condition results', () => {
    assert.throws(
        () => verify(liveSignedQuote(), { now: Date.parse('2026-11-10T00:00:00.000Z') }),
        (error) => {
            assert.equal(error.code, 'QUOTE_EXPIRED');
            assert.equal(error.conditions.quoteSignatureValid, true);
            assert.equal(error.conditions.requestResponseBound, true);
            assert.equal(error.conditions.quoteAvailable, true);
            assert.equal(error.conditions.quoteUnexpired, false);
            return true;
        },
    );
});

test('rejects a missing deposit address', () => {
    const response = liveSignedQuote();
    delete response.quote.depositAddress;
    assert.throws(() => verify(response), { code: 'INVALID_INPUT_OR_RESPONSE' });
});

test('rejects an envelope bound to the wrong RELAY token ID', () => {
    const envelope = verify().envelope;
    assert.throws(
        () =>
            claimQuoteEnvelope(envelope, {
                ...context,
                tokenId: 'different-token',
                associatedAccountId: 'different-token.near',
            }),
        { code: 'ENVELOPE_CONTEXT_MISMATCH' },
    );
});

test('rejects an envelope bound to the wrong canonical account', () => {
    const envelope = verify().envelope;
    assert.throws(
        () =>
            claimQuoteEnvelope(envelope, {
                ...context,
                relayContractId: 'different.near',
                associatedAccountId: 'user.different.near',
            }),
        { code: 'ENVELOPE_CONTEXT_MISMATCH' },
    );
});

test('rejects an envelope bound to the wrong quote nonce', () => {
    const envelope = verify().envelope;
    assert.throws(
        () => claimQuoteEnvelope(envelope, { ...context, quoteNonce: '1' }),
        { code: 'ENVELOPE_CONTEXT_MISMATCH' },
    );
});

test('rejects an envelope bound to the wrong owner context', () => {
    const envelope = verify().envelope;
    assert.throws(
        () => claimQuoteEnvelope(envelope, { ...context, ownerAccountId: 'alice.near' }),
        { code: 'ENVELOPE_CONTEXT_MISMATCH' },
    );
});

test('rejects reusing a quote envelope or quote within this process', () => {
    const first = verify().envelope;
    const second = verify().envelope;
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.providerQuoteResponse.quote), true);
    assert.equal(claimQuoteEnvelope(first, context, NOW), first);
    assert.throws(
        () => claimQuoteEnvelope(first, context, NOW),
        { code: 'ENVELOPE_REUSED' },
    );
    assert.throws(
        () => claimQuoteEnvelope(second, context, NOW),
        { code: 'QUOTE_REUSED' },
    );
    const serializedCopy = JSON.parse(JSON.stringify(verify().envelope));
    assert.throws(
        () => buildQuoteAuthorizationArgs(serializedCopy),
        { code: 'UNISSUED_ENVELOPE' },
    );
});

test('rejects claiming an envelope after either quote deadline', () => {
    const envelope = verify().envelope;
    assert.throws(
        () => claimQuoteEnvelope(envelope, context, Date.parse('2026-11-10T00:00:00.000Z')),
        { code: 'QUOTE_EXPIRED' },
    );
});

test('rejects an unexpected provider response structure', () => {
    assert.throws(() => verify({ quote: [], quoteRequest: {} }), {
        code: 'INVALID_INPUT_OR_RESPONSE',
    });
});

test('rejects a zero or malformed amount before contacting the provider', async () => {
    for (const amount of ['0', '-1', '1.2', '01']) {
        await assertAdapterError(
            requestVerifiedQuote({
                request: { ...request, amount },
                context,
                fetchImpl: async () => {
                    throw new Error('fetch must not be called for invalid amounts');
                },
                now: () => NOW,
            }),
            'INVALID_REQUEST',
        );
    }
});

test('rejects an impossible ISO deadline before contacting the provider', async () => {
    await assertAdapterError(
        requestVerifiedQuote({
            request: { ...request, deadline: '2026-02-30T12:00:00.000Z' },
            context,
            fetchImpl: async () => {
                throw new Error('fetch must not be called for invalid deadlines');
            },
            now: () => NOW,
        }),
        'INVALID_REQUEST',
    );
});

test('rejects unsupported assets and refund-account substitution before contacting provider', async () => {
    for (const invalidRequest of [
        { ...request, destinationAsset: 'nep141:unsupported.omft.near' },
        { ...request, refundTo: 'other.near' },
    ]) {
        await assertAdapterError(
            requestVerifiedQuote({
                request: invalidRequest,
                context,
                fetchImpl: async () => {
                    throw new Error('fetch must not be called for an unsupported request');
                },
                now: () => NOW,
            }),
            'INVALID_REQUEST',
        );
    }
});

test('reports HTTP success separately from a malformed API response', async () => {
    await assert.rejects(
        requestVerifiedQuote({
            request,
            context,
            fetchImpl: async (url, options) => {
                assert.equal(url, API_URL);
                assert.equal(options.method, 'POST');
                return { ok: true, status: 201, json: async () => ({ malformed: true }) };
            },
            now: () => NOW,
        }),
        (error) => {
            assert.equal(error.code, 'INVALID_INPUT_OR_RESPONSE');
            assert.equal(error.conditions.httpRequestSucceeded, true);
            return true;
        },
    );
});

test('reports provider HTTP errors without treating them as quotes', async () => {
    await assert.rejects(
        requestVerifiedQuote({
            request,
            context,
            fetchImpl: async () => ({ ok: false, status: 503 }),
            now: () => NOW,
        }),
        (error) => {
            assert.equal(error.code, 'PROVIDER_HTTP_ERROR');
            assert.equal(error.conditions.httpRequestSucceeded, true);
            assert.equal(error.conditions.quoteSignatureValid, false);
            return true;
        },
    );
});

test('reports provider unavailability separately from timeout', async () => {
    await assertAdapterError(
        requestVerifiedQuote({
            request,
            context,
            fetchImpl: async () => {
                throw new Error('connection refused');
            },
            now: () => NOW,
        }),
        'PROVIDER_UNAVAILABLE',
    );
});

test('reports malformed JSON after successful HTTP as unavailable quote data', async () => {
    await assertAdapterError(
        requestVerifiedQuote({
            request,
            context,
            fetchImpl: async () => ({
                ok: true,
                status: 201,
                json: async () => {
                    throw new SyntaxError('invalid JSON');
                },
            }),
            now: () => NOW,
        }),
        'MALFORMED_RESPONSE',
    );
});

test('reports an API timeout without accepting a quote', async () => {
    await assert.rejects(
        requestVerifiedQuote({
            request,
            context,
            timeoutMs: 5,
            fetchImpl: (_url, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () =>
                        reject(new Error('aborted')),
                    );
                }),
            now: () => NOW,
        }),
        (error) => {
            assert.equal(error.code, 'PROVIDER_TIMEOUT');
            assert.equal(error.conditions.httpRequestSucceeded, false);
            return true;
        },
    );
});

test('returns a frozen, context-bound envelope only after a successful HTTP quote verification', async () => {
    const result = await requestVerifiedQuote({
        request,
        context,
        fetchImpl: async () => ({
            ok: true,
            status: 201,
            json: async () => liveSignedQuote(),
        }),
        now: () => NOW,
    });
    assert.deepEqual(result.conditions, {
        httpRequestSucceeded: true,
        quoteSignatureValid: true,
        requestResponseBound: true,
        quoteAvailable: true,
        quoteUnexpired: true,
    });
    assert.equal(result.envelope.relay.tokenId, context.tokenId);
    assert.equal(result.envelope.tokenId, context.tokenId);
    assert.equal(result.envelope.associatedAccountId, context.associatedAccountId);
    assert.equal(result.envelope.ownerAtQuote, context.ownerAccountId);
    assert.equal(result.envelope.relay.associatedAccountId, context.associatedAccountId);
    assert.equal(result.envelope.quoteNonce, context.quoteNonce);
    assert.equal(result.envelope.sdkVersion, '0.1.26');
    assert.equal(
        result.envelope.providerSignatureHash,
        providerSignatureHash(result.envelope.providerSignature),
    );
});

test('canonical signature identity is the decoded Ed25519 byte string', () => {
    const response = liveSignedQuote();
    const unprefixed = {
        ...response,
        signature: response.signature.slice('ed25519:'.length),
    };
    assert.equal(verify(response).conditions.quoteSignatureValid, true);
    assert.equal(verify(unprefixed).conditions.quoteSignatureValid, true);
    assert.deepEqual(
        decodeProviderSignature(response.signature),
        decodeProviderSignature(unprefixed.signature),
    );
    assert.equal(
        providerSignatureHash(response.signature),
        providerSignatureHash(unprefixed.signature),
    );
    assert.equal(
        buildQuoteAuthorizationArgs(verify(response).envelope).quote.provider_signature_hash,
        buildQuoteAuthorizationArgs(verify(unprefixed).envelope).quote.provider_signature_hash,
    );
});

test('canonical signature parsing rejects malformed Base58, prefix, length, and signature values', () => {
    for (const signature of [
        '',
        'ed25519:ed25519:abc',
        'ED25519:abc',
        'ed25519:0',
        base58.encode(Buffer.alloc(63, 1)),
    ]) {
        assert.throws(() => decodeProviderSignature(signature));
    }

    const malformed = liveSignedQuote();
    malformed.signature = base58.encode(Buffer.alloc(64, 0));
    assertAdapterError(
        Promise.resolve().then(() => verify(malformed)),
        'INVALID_SIGNATURE',
    );

    for (const signature of [
        'ed25519:0',
        'ed25519:ed25519:abc',
        base58.encode(Buffer.alloc(63, 1)),
    ]) {
        const malformedEncoding = liveSignedQuote();
        malformedEncoding.signature = signature;
        assert.throws(
            () => verify(malformedEncoding),
            { code: 'INVALID_INPUT_OR_RESPONSE' },
        );
    }
});

test('reads owner, canonical account, verification, and quote nonce from RELAY view methods', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push(JSON.parse(options.body).params);
        return relayRpcFetch()(url, options);
    };
    const state = await fetchRelayQuoteContext({
        rpcUrl: 'http://127.0.0.1:3030',
        relayContractId: context.relayContractId,
        tokenId: context.tokenId,
        fetchImpl,
    });
    assert.deepEqual(state, {
        ...context,
        relayStateBlockHash: '11111111111111111111111111111111',
    });
    assert.equal(calls[0].finality, 'final');
    assert.equal(calls.length, 4);
    assert.ok(calls.slice(1).every((call) => call.block_id === state.relayStateBlockHash));
});

test('rejects an unverified or noncanonical RELAY account binding', async () => {
    await assert.rejects(
        fetchRelayQuoteContext({
            rpcUrl: 'http://127.0.0.1:3030',
            relayContractId: context.relayContractId,
            tokenId: context.tokenId,
            fetchImpl: relayRpcFetch({ binding: { is_verified: false } }),
        }),
        { code: 'INVALID_RELAY_STATE' },
    );
    await assert.rejects(
        fetchRelayQuoteContext({
            rpcUrl: 'http://127.0.0.1:3030',
            relayContractId: context.relayContractId,
            tokenId: context.tokenId,
            fetchImpl: relayRpcFetch({ binding: { account_id: 'other.near' } }),
        }),
        { code: 'INVALID_RELAY_STATE' },
    );
});

test('requestRelayQuote derives RELAY context and creates exact authorization arguments', async () => {
    let providerUrl;
    const result = await requestRelayQuote({
        request,
        relayContractId: context.relayContractId,
        tokenId: context.tokenId,
        rpcUrl: 'http://127.0.0.1:3030',
        apiBaseUrl: 'https://1click.chaindefuser.com/',
        rpcFetchImpl: relayRpcFetch(),
        providerFetchImpl: async (url) => {
            providerUrl = url;
            return {
                ok: true,
                status: 201,
                json: async () => liveSignedQuote(),
            };
        },
        now: () => NOW,
    });
    assert.equal(providerUrl, API_URL);
    assert.equal(result.envelope.ownerAtQuote, context.ownerAccountId);
    assert.equal(result.authorizationArgs.expected_nonce, '0');
    assert.equal(result.authorizationDepositHint, AUTHORIZATION_DEPOSIT_HINT);
    assert.equal(result.envelope.relayStateBlockHash, '11111111111111111111111111111111');
    assert.equal(
        result.authorizationArgs.quote.commitment_hash,
        computeQuoteCommitment(result.envelope),
    );
    assert.equal(result.authorizationArgs.quote.refund_address, context.associatedAccountId);
});

test('commitment serialization matches the contract length-prefixed hash format', () => {
    const envelope = {
        tokenId: 'quote-token',
        relayContractId: 'alice',
        associatedAccountId: 'quote-token.alice',
        ownerAtQuote: 'bob',
        quoteNonce: '0',
        providerQuoteResponse: {
            quote: {
                amountOut: '50',
                minAmountOut: '45',
            },
        },
        providerSignature: base58.encode(Buffer.alloc(64, 0x61)),
        sourceAsset: ORIGIN_ASSET,
        sourceDecimals: 24,
        quoteRequest: { depositType: 'ORIGIN_CHAIN' },
        sourceAmount: '100',
        destinationAsset: DESTINATION_ASSET,
        destinationDecimals: 18,
        recipient: '0x1111111111111111111111111111111111111111',
        depositAddress: '0x2222222222222222222222222222222222222222',
        depositMemo: 'memo-1',
        refundAddress: 'quote-token.alice',
        refundType: 'ORIGIN_CHAIN',
        requestDeadline: '1970-01-01T00:01:40.000Z',
        providerQuoteDeadline: '1970-01-01T00:03:20.000Z',
        providerInactiveDeadline: null,
    };
    assert.equal(
        computeQuoteCommitment(envelope),
        'e1af92db5b61e4fa8042940911c9d375c9fd4f6566fced54c4483745a56c6998',
    );
});

test('verifies an active on-chain authorization against the provider quote and current RELAY state', async () => {
    const record = authorizedQuoteRecord();
    const fetchImpl = async (_url, options) => {
        const { method_name: methodName } = JSON.parse(options.body).params;
        if (methodName === 'relay_active_quote_authorization') return rpcResponse(record);
        return relayRpcFetch({ nonce: '1' })(_url, options);
    };
    const result = await verifyRelayQuoteAuthorization({
        request,
        providerResponse: liveSignedQuote(),
        relayContractId: context.relayContractId,
        tokenId: context.tokenId,
        rpcUrl: 'http://127.0.0.1:3030',
        rpcFetchImpl: fetchImpl,
        now: () => NOW,
    });
    assert.equal(result.conditions.quoteSignatureValid, true);
    assert.equal(result.conditions.relayStateVerified, true);
    assert.equal(result.authorization.status, 'Prepared');
});

test('rejects on-chain readback that is not a disabled-dispatch preparation', async () => {
    const record = authorizedQuoteRecord();
    record.deposit_dispatch_status = 'Enabled';
    const fetchImpl = async (_url, options) => {
        const { method_name: methodName } = JSON.parse(options.body).params;
        if (methodName === 'relay_active_quote_authorization') return rpcResponse(record);
        return relayRpcFetch({ nonce: '1' })(_url, options);
    };
    await assert.rejects(
        verifyRelayQuoteAuthorization({
            request,
            providerResponse: liveSignedQuote(),
            relayContractId: context.relayContractId,
            tokenId: context.tokenId,
            rpcUrl: 'http://127.0.0.1:3030',
            rpcFetchImpl: fetchImpl,
            now: () => NOW,
        }),
        { code: 'ONCHAIN_AUTHORIZATION_MISMATCH' },
    );
});

test('rejects a stale authorization after RELAY ownership or nonce changes', async () => {
    const record = authorizedQuoteRecord();
    const makeFetch = (owner, nonce) => async (_url, options) => {
        const { method_name: methodName } = JSON.parse(options.body).params;
        if (methodName === 'relay_active_quote_authorization') return rpcResponse(record);
        return relayRpcFetch({ owner, nonce })(_url, options);
    };
    for (const fetchImpl of [
        makeFetch('next-owner.near', '1'),
        makeFetch(context.ownerAccountId, '2'),
    ]) {
        await assert.rejects(
            verifyRelayQuoteAuthorization({
                request,
                providerResponse: liveSignedQuote(),
                relayContractId: context.relayContractId,
                tokenId: context.tokenId,
                rpcUrl: 'http://127.0.0.1:3030',
                rpcFetchImpl: fetchImpl,
                now: () => NOW,
            }),
            { code: 'ONCHAIN_AUTHORIZATION_MISMATCH' },
        );
    }
});

test('rejects malformed or unavailable RELAY RPC state', async () => {
    await assert.rejects(
        fetchRelayQuoteContext({
            rpcUrl: 'http://127.0.0.1:3030',
            relayContractId: context.relayContractId,
            tokenId: context.tokenId,
            fetchImpl: async () => ({ ok: false, status: 503 }),
        }),
        { code: 'RELAY_RPC_HTTP_ERROR' },
    );
    await assert.rejects(
        fetchRelayQuoteContext({
            rpcUrl: 'http://127.0.0.1:3030',
            relayContractId: context.relayContractId,
            tokenId: context.tokenId,
            fetchImpl: async () => rpcResponse({ not: 'a token' }),
        }),
        { code: 'INVALID_RELAY_STATE' },
    );
    await assert.rejects(
        fetchRelayQuoteContext({
            rpcUrl: 'http://127.0.0.1:3030',
            relayContractId: context.relayContractId,
            tokenId: context.tokenId,
            timeoutMs: 5,
            fetchImpl: (_url, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () =>
                        reject(new Error('aborted')),
                    );
                }),
        }),
        { code: 'RELAY_RPC_TIMEOUT' },
    );
});
