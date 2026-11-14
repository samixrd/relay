'use strict';

const { createHash } = require('node:crypto');
const stableStringify = require('json-stable-stringify');
const { base58 } = require('@scure/base');
const nacl = require('tweetnacl');
const {
    DESTINATION_ASSET,
    ORIGIN_ASSET,
    buildQuoteAuthorizationArgs,
    fetchRelayQuoteContext,
    providerSignatureHash,
    verifyQuoteResponseWithManagerKeyForTesting,
    verifyRelayQuoteAuthorizationWithManagerKeyForTesting,
} = require('./oneclick-quote-adapter');

const FIXTURE_NOW = Date.now();
const FIXTURE_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const fixtureKeyPair = nacl.sign.keyPair.fromSeed(FIXTURE_SEED);
const fixtureManagerPublicKey = `ed25519:${base58.encode(fixtureKeyPair.publicKey)}`;
const fixtureNow = () => FIXTURE_NOW;

async function getLatestBlockTimestampMs(rpcUrl) {
    try {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'block-query',
                method: 'block',
                params: { finality: 'final' },
            }),
        });
        if (res.ok) {
            const body = await res.json();
            const tsNanos = body?.result?.header?.timestamp_nanosec ?? body?.result?.header?.timestamp;
            if (tsNanos) {
                return Number(BigInt(tsNanos) / 1000000n);
            }
        }
    } catch {
        // Fallback to Date.now()
    }
    return Date.now();
}

function createSignedQuote(
    context,
    variant,
    signatureFormat,
    customDepositAddress,
    customDepositMemo,
    customAmount,
    nowMs = Date.now(),
) {
    if (!['prefixed', 'prefixless'].includes(signatureFormat)) {
        throw new TypeError('Signature format must be prefixed or prefixless');
    }
    const isExpiring = variant === 'expiring' || variant.includes('expiring');
    const requestDeadline =
        isExpiring
            ? new Date(nowMs + 15_000).toISOString()
            : '2099-01-01T00:00:00.000Z';
    const providerQuoteDeadline =
        isExpiring
            ? new Date(nowMs + 30_000).toISOString()
            : '2099-01-02T00:00:00.000Z';
    const amount =
        customAmount ||
        (variant.startsWith('native') ? '100000000000000000000000' : '100000');
    const depositAddress = customDepositAddress || 'sandboxfixture.near';
    const depositMemo =
        customDepositMemo !== undefined
            ? (customDepositMemo === 'null' || customDepositMemo === null || customDepositMemo === '' ? undefined : customDepositMemo)
            : (variant.startsWith('native') ? undefined : `sandbox-fixture-${variant}`);
    const request = {
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: ORIGIN_ASSET,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: DESTINATION_ASSET,
        amount,
        refundTo: context.associatedAccountId,
        refundType: 'ORIGIN_CHAIN',
        recipient: '0x1111111111111111111111111111111111111111',
        recipientType: 'DESTINATION_CHAIN',
        deadline: requestDeadline,
    };
    const quoteRequest = {
        ...request,
        depositMode: 'SIMPLE',
        confidentiality: 'public',
        insured: false,
    };
    const quote = {
        amountIn: request.amount,
        amountInFormatted: '0.0001',
        amountInUsd: '0.1',
        minAmountIn: request.amount,
        amountOut: variant === 'alternate' ? '2002' : '2001',
        amountOutFormatted: '0.000002001',
        amountOutUsd: '0.2',
        minAmountOut: variant === 'alternate' ? '1990' : '1990',
        depositAddress,
        ...(depositMemo !== undefined ? { depositMemo } : {}),
        deadline: providerQuoteDeadline,
        timeWhenInactive: providerQuoteDeadline,
        timeEstimate: 1,
        refundFee: '0',
        withdrawFee: '0',
    };
    const timestamp = '2026-11-07T12:00:00.000Z';
    const signedRequest = {
        dry: quoteRequest.dry,
        swapType: quoteRequest.swapType,
        slippageTolerance: quoteRequest.slippageTolerance,
        originAsset: quoteRequest.originAsset,
        depositType: quoteRequest.depositType,
        destinationAsset: quoteRequest.destinationAsset,
        amount: quoteRequest.amount,
        refundTo: quoteRequest.refundTo,
        refundType: quoteRequest.refundType,
        recipient: quoteRequest.recipient,
        recipientType: quoteRequest.recipientType,
        deadline: quoteRequest.deadline,
    };
    const signedQuote = {
        amountIn: quote.amountIn,
        amountInFormatted: quote.amountInFormatted,
        amountInUsd: quote.amountInUsd,
        minAmountIn: quote.minAmountIn,
        amountOut: quote.amountOut,
        amountOutFormatted: quote.amountOutFormatted,
        amountOutUsd: quote.amountOutUsd,
        minAmountOut: quote.minAmountOut,
        depositAddress,
        ...(depositMemo !== undefined ? { depositMemo } : {}),
        deadline: quote.deadline,
        timeWhenInactive: quote.timeWhenInactive,
        timeEstimate: quote.timeEstimate,
        refundFee: quote.refundFee,
        withdrawFee: quote.withdrawFee,
    };
    const message = base58.encode(
        createHash('sha256')
            .update(stableStringify({ ...signedRequest, ...signedQuote, timestamp }), 'utf8')
            .digest(),
    );
    const signatureBytes = base58.encode(
        nacl.sign.detached(Buffer.from(message, 'utf8'), fixtureKeyPair.secretKey),
    );
    const signature =
        signatureFormat === 'prefixless'
            ? signatureBytes
            : `ed25519:${signatureBytes}`;
    return {
        request,
        providerResponse: {
            quoteRequest,
            quote,
            signature,
            timestamp,
            correlationId: `relay-sandbox-fixture-${variant}`,
        },
    };
}

async function main() {
    const [
        mode,
        rpcUrl,
        relayContractId,
        tokenId,
        variant = 'primary',
        signatureFormat = 'prefixed',
        customDepositAddress,
        customDepositMemo,
        customAmount,
    ] =
        process.argv.slice(2);
    if (!['prepare', 'verify'].includes(mode) || !rpcUrl || !relayContractId || !tokenId) {
        throw new TypeError(
            'Usage: node oneclick-sandbox-integration.js <prepare|verify> <rpc-url> <relay-contract> <token-id> [variant] [prefixed|prefixless]',
        );
    }

    const currentNow = await getLatestBlockTimestampMs(rpcUrl);
    const fixtureNow = () => currentNow;

    if (mode === 'prepare') {
        const context = await fetchRelayQuoteContext({
            rpcUrl,
            relayContractId,
            tokenId,
        });
        const fixture = createSignedQuote(
            context,
            variant,
            signatureFormat,
            customDepositAddress,
            customDepositMemo,
            customAmount,
            currentNow,
        );
        const verified = verifyQuoteResponseWithManagerKeyForTesting({
            ...fixture,
            context,
            now: currentNow,
            managerPublicKey: fixtureManagerPublicKey,
        });
        const args = buildQuoteAuthorizationArgs(verified.envelope);
        const alternateSignature = verified.envelope.providerSignature.startsWith('ed25519:')
            ? verified.envelope.providerSignature.slice('ed25519:'.length)
            : `ed25519:${verified.envelope.providerSignature}`;
        const alternateHash = providerSignatureHash(alternateSignature);
        process.stdout.write(
            JSON.stringify({
                fixtureLabel: 'local deterministic signed quote fixture; not a provider quote',
                sdkVersion: verified.envelope.sdkVersion,
                context,
                request: fixture.request,
                providerResponse: fixture.providerResponse,
                authorizationArgs: args,
                providerSignatureHash: args.quote.provider_signature_hash,
                signatureFormat,
                alternateProviderSignatureHash: alternateHash,
                canonicalPrefixMatch: args.quote.provider_signature_hash === alternateHash,
            }),
        );
        return;
    }

    const fixtureContext = await fetchRelayQuoteContext({
        rpcUrl,
        relayContractId,
        tokenId,
    });
    const fixture = createSignedQuote(
        fixtureContext,
        variant,
        signatureFormat,
        customDepositAddress,
        customDepositMemo,
        customAmount,
            currentNow,
    );
    const verified = await verifyRelayQuoteAuthorizationWithManagerKeyForTesting({
        ...fixture,
        relayContractId,
        tokenId,
        rpcUrl,
        now: fixtureNow,
        managerPublicKey: fixtureManagerPublicKey,
    });
    process.stdout.write(
        JSON.stringify({
            fixtureLabel: 'local deterministic signed quote fixture; not a provider quote',
            relayStateVerified: verified.conditions.relayStateVerified,
            status: verified.authorization.status,
            tokenId: verified.authorization.token_id,
            ownerAtAuthorization: verified.authorization.owner_at_authorization,
            associatedAccountId: verified.authorization.associated_account_id,
            nonce: verified.authorization.nonce,
            providerSignatureHash: verified.authorization.provider_signature_hash,
        }),
    );
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    if (error && (error.code || error.details)) {
        process.stderr.write(
            `${JSON.stringify({ code: error.code, details: error.details })}\n`,
        );
    }
    process.exitCode = 1;
});
