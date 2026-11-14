'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const stableStringify = require('json-stable-stringify');
const { base58 } = require('@scure/base');
const { quoteHash } = require('@defuse-protocol/one-click-sdk-typescript');
const nacl = require('tweetnacl');
const {
    DESTINATION_ASSET,
    ORIGIN_ASSET,
    buildQuoteAuthorizationArgs,
    providerSignatureHash,
    verifyQuoteResponseWithManagerKeyForTesting,
} = require('./oneclick-quote-adapter');
const {
    buildPreparationEvidence,
    fetchTokenMetadata,
    stableVerifiedRepresentation,
} = require('./oneclick-checkout-preparation');
const { main, parseArguments } = require('./prepare-oneclick-checkout');

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const context = Object.freeze({
    tokenId: 'checkout',
    relayContractId: 'relay.near',
    associatedAccountId: 'checkout.relay.near',
    ownerAccountId: 'owner.near',
    quoteNonce: '0',
    relayStateBlockHash: '11111111111111111111111111111111',
});
const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const keyPair = nacl.sign.keyPair.fromSeed(seed);
const managerPublicKey = `ed25519:${base58.encode(keyPair.publicKey)}`;
const tokenMetadata = {
    [ORIGIN_ASSET]: {
        assetId: ORIGIN_ASSET,
        decimals: 24,
        blockchain: 'near',
        symbol: 'wNEAR',
        contractAddress: 'wrap.near',
    },
    [DESTINATION_ASSET]: {
        assetId: DESTINATION_ASSET,
        decimals: 18,
        blockchain: 'arb',
        symbol: 'ARB',
        contractAddress: '0x912ce59144191c1204e64559fe8253a0e49e6548',
    },
};

function signedFixture({ dry = false, memo, inactiveDeadline } = {}) {
    const request = {
        dry,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: ORIGIN_ASSET,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: DESTINATION_ASSET,
        amount: '100000000000000000000000',
        refundTo: context.associatedAccountId,
        refundType: 'ORIGIN_CHAIN',
        recipient: '0x1111111111111111111111111111111111111111',
        recipientType: 'DESTINATION_CHAIN',
        deadline: '2026-11-07T12:03:00.000Z',
    };
    const quote = {
        amountIn: request.amount,
        amountInFormatted: '0.1',
        amountInUsd: '0.1',
        minAmountIn: request.amount,
        amountOut: '2000000000000000000',
        amountOutFormatted: '2',
        amountOutUsd: '0.2',
        minAmountOut: '1980000000000000000',
    };
    if (!dry) {
        quote.depositAddress = 'deposit-fixture.sandbox';
        if (memo !== undefined) quote.depositMemo = memo;
        quote.deadline = '2026-11-07T12:03:00.000Z';
        quote.timeWhenInactive = inactiveDeadline || '2026-11-07T12:02:00.000Z';
        quote.timeEstimate = 20;
        quote.refundFee = '0';
        quote.withdrawFee = '0';
    }
    const response = {
        quoteRequest: {
            ...request,
            depositMode: 'SIMPLE',
            confidentiality: 'public',
            insured: false,
        },
        quote,
        timestamp: '2026-11-07T12:00:00.000Z',
        correlationId: 'local-preparation-test-fixture',
        signature: '',
    };
    const message = quoteHash(response);
    response.signature = `ed25519:${base58.encode(
        nacl.sign.detached(Buffer.from(message, 'utf8'), keyPair.secretKey),
    )}`;
    return { request, response };
}

function verifyFixture(options = {}) {
    const { request, response } = signedFixture(options);
    return {
        request,
        ...verifyQuoteResponseWithManagerKeyForTesting({
            request,
            context,
            providerResponse: response,
            managerPublicKey,
            now: NOW,
        }),
    };
}

test('dry preview is verified by the pinned SDK but cannot create authorization arguments', () => {
    const verified = verifyFixture({ dry: true });
    assert.equal(verified.conditions.quoteSignatureValid, true);
    assert.equal(verified.envelope.depositAddress, undefined);
    assert.throws(
        () => buildQuoteAuthorizationArgs(verified.envelope),
        { code: 'DRY_QUOTE_NOT_PREPARABLE' },
    );
});

test('dry response with a deposit address is rejected rather than normalized', () => {
    const { request, response } = signedFixture({ dry: true });
    response.quote.depositAddress = 'deposit-fixture.sandbox';
    assert.throws(
        () =>
            verifyQuoteResponseWithManagerKeyForTesting({
                request,
                context,
                providerResponse: response,
                managerPublicKey,
                now: NOW,
            }),
        { code: 'INVALID_INPUT_OR_RESPONSE' },
    );
});

test('non-dry quote is rejected after its signed inactivity deadline', () => {
    const { request, response } = signedFixture({
        inactiveDeadline: '2026-11-07T11:59:00.000Z',
    });
    assert.throws(
        () =>
            verifyQuoteResponseWithManagerKeyForTesting({
                request,
                context,
                providerResponse: response,
                managerPublicKey,
                now: NOW,
            }),
        { code: 'QUOTE_EXPIRED' },
    );
});

test('non-dry preparation retains exact memo-bearing quote and keeps dispatch disabled', () => {
    const verified = verifyFixture({ memo: 'memo-fixture' });
    const authorizationArgs = buildQuoteAuthorizationArgs(verified.envelope);
    const rawProviderResponseText = JSON.stringify(
        verified.envelope.providerQuoteResponse,
    );
    const evidence = buildPreparationEvidence({
        result: {
            conditions: verified.conditions,
            envelope: verified.envelope,
            authorizationArgs,
            rawProviderResponseText,
            rawProviderResponseBase64: Buffer.from(rawProviderResponseText).toString('base64'),
        },
        tokenMetadata,
        request: verified.request,
    });
    assert.equal(evidence.evidenceKind, 'NON_DRY_QUOTE');
    assert.equal(evidence.providerQuoteVerified, true);
    assert.equal(evidence.rawProviderResponseText, rawProviderResponseText);
    assert.equal(evidence.preparation.onChainStateAfterOwnerAuthorization, 'Prepared');
    assert.equal(evidence.preparation.depositDispatchStatus, 'Disabled');
    assert.match(
        evidence.preparation.depositDispatchReason,
        /Production dispatch remains disabled/,
    );
    assert.equal(evidence.verifiedFields.quoteHash, verified.envelope.providerQuoteHash);
    assert.equal(
        evidence.verifiedFields.signatureDigest,
        providerSignatureHash(verified.envelope.providerSignature),
    );
    assert.equal(
        evidence.stableVerifiedRepresentation,
        stableVerifiedRepresentation(verified.envelope),
    );
});

test('token selection uses exact IDs and validates current decimals and chain metadata', async () => {
    const metadata = await fetchTokenMetadata({
        fetchImpl: async (url, options) => {
            assert.equal(url, 'https://1click.chaindefuser.com/v0/tokens');
            assert.equal(options.method, 'GET');
            return {
                ok: true,
                json: async () => Object.values(tokenMetadata),
            };
        },
    });
    assert.equal(metadata[ORIGIN_ASSET].decimals, 24);
    assert.equal(metadata[DESTINATION_ASSET].decimals, 18);

    await assert.rejects(
        fetchTokenMetadata({
            fetchImpl: async () => ({
                ok: true,
                json: async () => [
                    ...Object.values(tokenMetadata),
                    { ...tokenMetadata[ORIGIN_ASSET] },
                ],
            }),
        }),
        /exactly one current token entry/,
    );
});

test('CLI defaults to dry and requires an explicit switch for a deposit-address quote', () => {
    const args = [
        '--token-id', 'checkout',
        '--relay-contract', 'relay.near',
        '--recipient', '0x1111111111111111111111111111111111111111',
        '--amount', '100000000000000000000000',
        '--origin-asset', ORIGIN_ASSET,
        '--destination-asset', DESTINATION_ASSET,
        '--rpc-url', 'https://rpc.testnet.near.org',
    ];
    assert.equal(parseArguments(args).nonDry, false);
    assert.equal(parseArguments([...args, '--non-dry']).nonDry, true);
    assert.throws(() => parseArguments([...args, '--send', 'true']), /unexpected options/);
});

test('checkout preparation reads the documented ONECLICK_JWT variable', async () => {
    const args = [
        '--token-id', 'checkout',
        '--relay-contract', 'relay.near',
        '--recipient', '0x1111111111111111111111111111111111111111',
        '--amount', '100000000000000000000000',
        '--origin-asset', ORIGIN_ASSET,
        '--destination-asset', DESTINATION_ASSET,
        '--rpc-url', 'https://rpc.testnet.near.org',
    ];
    const original = process.env.ONECLICK_JWT;
    process.env.ONECLICK_JWT = 'test-secret';
    const outputPath = require('node:path').join(require('node:os').tmpdir(), `relay-preparation-${process.pid}-${Date.now()}.json`);
    try {
        let received;
        await main([...args, '--output', outputPath], {
            fetchTokenMetadata: async () => tokenMetadata,
            requestRelayQuote: async (input) => {
                received = input;
                const verified = verifyFixture({ dry: true });
                return {
                    ...verified,
                    authorizationArgs: null,
                    rawProviderResponseText: JSON.stringify(verified.envelope.providerQuoteResponse),
                    rawProviderResponseBase64: Buffer.from(JSON.stringify(verified.envelope.providerQuoteResponse)).toString('base64'),
                };
            },
        });
        assert.equal(received.apiKey, 'test-secret');
    } finally {
        if (original === undefined) delete process.env.ONECLICK_JWT;
        else process.env.ONECLICK_JWT = original;
        await require('node:fs/promises').rm(outputPath, { force: true });
    }
});

test('deterministic evidence does not depend on object insertion order', () => {
    const verified = verifyFixture();
    const one = stableVerifiedRepresentation(verified.envelope);
    const reordered = {
        ...verified.envelope,
        quoteRequest: Object.fromEntries(
            Object.entries(verified.envelope.quoteRequest).reverse(),
        ),
    };
    assert.equal(
        stableStringify(JSON.parse(one)),
        stableStringify(JSON.parse(stableVerifiedRepresentation(reordered))),
    );
});
