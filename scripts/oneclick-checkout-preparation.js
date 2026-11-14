'use strict';

const stableStringify = require('json-stable-stringify');
const {
    DESTINATION_ASSET,
    DESTINATION_DECIMALS,
    ORIGIN_ASSET,
    ORIGIN_DECIMALS,
    TOKEN_API_URL,
} = require('./oneclick-quote-adapter');

const EXPECTED_TOKEN_METADATA = Object.freeze({
    [ORIGIN_ASSET]: Object.freeze({ blockchain: 'near', decimals: ORIGIN_DECIMALS }),
    [DESTINATION_ASSET]: Object.freeze({ blockchain: 'arb', decimals: DESTINATION_DECIMALS }),
});

async function fetchTokenMetadata({ fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('No fetch implementation is available');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(TOKEN_API_URL, {
            method: 'GET',
            signal: controller.signal,
        });
        if (!response || !response.ok) {
            throw new Error(`1Click token endpoint returned HTTP ${response ? response.status : 'unknown'}`);
        }
        const tokens = await response.json();
        if (!Array.isArray(tokens)) throw new TypeError('1Click token response must be an array');
        const selected = {};
        for (const assetId of Object.keys(EXPECTED_TOKEN_METADATA)) {
            const matches = tokens.filter((token) => token && token.assetId === assetId);
            if (matches.length !== 1) {
                throw new Error(`Expected exactly one current token entry for ${assetId}`);
            }
            const token = matches[0];
            const expected = EXPECTED_TOKEN_METADATA[assetId];
            if (
                !Number.isInteger(token.decimals) ||
                token.decimals !== expected.decimals ||
                token.blockchain !== expected.blockchain
            ) {
                throw new Error(`Current token metadata does not match the RELAY allowlist for ${assetId}`);
            }
            selected[assetId] = Object.freeze({
                assetId,
                decimals: token.decimals,
                blockchain: token.blockchain,
                symbol: token.symbol,
                contractAddress: token.contractAddress ?? null,
            });
        }
        return Object.freeze(selected);
    } finally {
        clearTimeout(timer);
    }
}

function stableVerifiedRepresentation(envelope) {
    const quote = envelope.providerQuoteResponse.quote;
    const signedRequestFields = [
        'dry',
        'swapType',
        'slippageTolerance',
        'originAsset',
        'depositType',
        'destinationAsset',
        'amount',
        'refundTo',
        'refundType',
        'recipient',
        'recipientType',
        'deadline',
    ];
    const signedQuoteFields = envelope.dry
        ? [
              'amountIn',
              'amountInFormatted',
              'amountInUsd',
              'minAmountIn',
              'amountOut',
              'amountOutFormatted',
              'amountOutUsd',
              'minAmountOut',
          ]
        : [
              'amountIn',
              'amountInFormatted',
              'amountInUsd',
              'minAmountIn',
              'amountOut',
              'amountOutFormatted',
              'amountOutUsd',
              'minAmountOut',
              'depositAddress',
              'depositMemo',
              'deadline',
              'timeWhenInactive',
              'timeEstimate',
              'refundFee',
              'withdrawFee',
          ];
    const pick = (source, fields) =>
        Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));
    return stableStringify({
        sdkVersion: envelope.sdkVersion,
        quoteHash: envelope.providerQuoteHash,
        signatureDigest: envelope.providerSignatureHash,
        tokenId: envelope.tokenId,
        relayContractId: envelope.relayContractId,
        associatedAccountId: envelope.associatedAccountId,
        ownerAtQuote: envelope.ownerAtQuote,
        quoteNonce: envelope.quoteNonce,
        relayStateBlockHash: envelope.relayStateBlockHash,
        tokenDecimals: {
            source: envelope.sourceDecimals,
            destination: envelope.destinationDecimals,
        },
        request: pick(envelope.quoteRequest, signedRequestFields),
        quote: pick(quote, signedQuoteFields),
        signedTimestamp: envelope.quoteTimestamp,
    });
}

function buildPreparationEvidence({ result, tokenMetadata, request }) {
    const envelope = result.envelope;
    return Object.freeze({
        schemaVersion: 1,
        evidenceKind: envelope.dry ? 'DRY_RUN_PREVIEW' : 'NON_DRY_QUOTE',
        providerQuoteVerified: result.conditions.quoteSignatureValid === true,
        requestBound: result.conditions.requestResponseBound === true,
        quoteAvailable: result.conditions.quoteAvailable === true,
        quoteUnexpired: result.conditions.quoteUnexpired === true,
        sdkVersion: envelope.sdkVersion,
        relayContext: {
            tokenId: envelope.tokenId,
            relayContractId: envelope.relayContractId,
            associatedAccountId: envelope.associatedAccountId,
            ownerAtQuote: envelope.ownerAtQuote,
            quoteNonce: envelope.quoteNonce,
            stateBlockHash: envelope.relayStateBlockHash,
            accountBindingVerifiedAtSnapshot: true,
        },
        tokenMetadata,
        request,
        verifiedFields: JSON.parse(stableVerifiedRepresentation(envelope)),
        stableVerifiedRepresentation: stableVerifiedRepresentation(envelope),
        rawProviderResponseText: result.rawProviderResponseText,
        rawProviderResponseBase64: result.rawProviderResponseBase64,
        providerUnsignedFields: {
            correlationId: envelope.providerQuoteResponse.correlationId,
            quoteRequestExtensions: Object.fromEntries(
                Object.entries(envelope.providerQuoteResponse.quoteRequest).filter(
                    ([key]) => !Object.hasOwn(request, key),
                ),
            ),
            note: 'These fields are retained for audit but are not authenticated by the SDK quote signature.',
        },
        preparation: {
            state: envelope.dry ? 'PREVIEW_ONLY' : 'READY_FOR_OWNER_AUTHORIZATION',
            onChainStateAfterOwnerAuthorization: envelope.dry ? null : 'Prepared',
            depositDispatchStatus: 'Disabled',
            depositDispatchReason: envelope.dry
                ? 'A dry quote has no deposit address and cannot be prepared.'
                : 'Production dispatch remains disabled; NEP-141 execution is available only in the explicitly feature-enabled local test artifact.',
            authorizationArgs: result.authorizationArgs,
        },
    });
}

module.exports = {
    DESTINATION_ASSET,
    ORIGIN_ASSET,
    buildPreparationEvidence,
    fetchTokenMetadata,
    stableVerifiedRepresentation,
};
