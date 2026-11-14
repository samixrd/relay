'use strict';

const { createHash } = require('node:crypto');
const { base58 } = require('@scure/base');
const stableStringify = require('json-stable-stringify');
const {
    quoteHash,
    verifyQuoteSignature,
} = require('@defuse-protocol/one-click-sdk-typescript');
const SDK_VERSION = require('../package.json').dependencies[
    '@defuse-protocol/one-click-sdk-typescript'
];

const API_URL = 'https://1click.chaindefuser.com/v0/quote';
const TOKEN_API_URL = 'https://1click.chaindefuser.com/v0/tokens';
const ORIGIN_ASSET = 'nep141:wrap.near';
const DESTINATION_ASSET =
    'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near';
const ORIGIN_DECIMALS = 24;
const DESTINATION_DECIMALS = 18;
const BASE_USDC_ASSET = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const BASE_USDC_DECIMALS = 6;
const BASE_WETH_ASSET = 'nep141:base-0x4200000000000000000000000000000000000006.omft.near';
const BASE_WETH_DECIMALS = 18;
const { findCheckoutPair, getAsset, ALLOWED_CHECKOUT_PAIRS, ASSET_REGISTRY } = require('./asset-registry');
const AUTHORIZATION_DEPOSIT_HINT = '1000000000000000000000000';
const U128_MAX = 340282366920938463463374607431768211455n;
const REQUEST_FIELDS = [
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
const ISSUED_ENVELOPES = new WeakSet();
const CLAIMED_ENVELOPES = new WeakSet();
const CLAIMED_QUOTES = new Set();
const ED25519_PREFIX = 'ed25519:';

class QuoteAdapterError extends Error {
    constructor(code, message, conditions, details) {
        super(message);
        this.name = 'QuoteAdapterError';
        this.code = code;
        this.conditions = Object.freeze({ ...conditions });
        if (details !== undefined) this.details = details;
    }
}

function fail(code, message, conditions, details) {
    throw new QuoteAdapterError(code, message, conditions, details);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseIsoDate(value) {
    if (typeof value !== 'string' || value.length > 40) return null;
    const match = value.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/,
    );
    if (!match) return null;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] =
        match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
    const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
    const daysInMonth = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > daysInMonth[month - 1] ||
        hour > 23 ||
        minute > 59 ||
        second > 59 ||
        offsetHour > 23 ||
        offsetMinute > 59
    ) {
        return null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function isNearAccountId(value) {
    return (
        typeof value === 'string' &&
        value.length >= 2 &&
        value.length <= 64 &&
        /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)
    );
}

function validateContext(context) {
    if (!isRecord(context)) {
        throw new TypeError('RELAY context must be an object');
    }

    const { tokenId, relayContractId, associatedAccountId, ownerAccountId, quoteNonce } =
        context;
    if (
        typeof tokenId !== 'string' ||
        tokenId.length < 1 ||
        tokenId.length > 32 ||
        !/^[a-z0-9_-]+$/.test(tokenId)
    ) {
        throw new TypeError('tokenId must be 1-32 lowercase account-safe characters');
    }
    if (!isNearAccountId(relayContractId) || !isNearAccountId(ownerAccountId)) {
        throw new TypeError('RELAY contract and owner must be valid NEAR account IDs');
    }
    if (!isNearAccountId(associatedAccountId)) {
        throw new TypeError('associatedAccountId must be a valid NEAR account ID');
    }
    if (associatedAccountId !== `${tokenId}.${relayContractId}`) {
        throw new TypeError('associatedAccountId must be the canonical token subaccount');
    }
    if (
        typeof quoteNonce !== 'string' ||
        quoteNonce.length > 20 ||
        !/^(0|[1-9]\d*)$/.test(quoteNonce) ||
        BigInt(quoteNonce) > 18446744073709551615n
    ) {
        throw new TypeError('quoteNonce must be a canonical u64 decimal string');
    }

    const normalized = {
        tokenId,
        relayContractId,
        associatedAccountId,
        ownerAccountId,
        quoteNonce,
    };
    if (context.relayStateBlockHash !== undefined) {
        if (
            typeof context.relayStateBlockHash !== 'string' ||
            context.relayStateBlockHash.length === 0 ||
            context.relayStateBlockHash.length > 128
        ) {
            throw new TypeError('relayStateBlockHash must be a non-empty block hash string');
        }
        normalized.relayStateBlockHash = context.relayStateBlockHash;
    }
    return Object.freeze(normalized);
}

function amountAsU128(value, field) {
    if (
        typeof value !== 'string' ||
        value.length > 39 ||
        !/^(0|[1-9]\d*)$/.test(value)
    ) {
        throw new TypeError(`${field} must be a canonical unsigned integer string`);
    }
    const amount = BigInt(value);
    if (amount > U128_MAX) {
        throw new TypeError(`${field} exceeds the NEP-141 U128 amount range`);
    }
    return amount;
}

function validateRequest(request, context, now, checkDeadline = true) {
    if (!isRecord(request)) throw new TypeError('Quote request must be an object');
    const requestKeys = Object.keys(request).sort();
    const expectedKeys = [...REQUEST_FIELDS].sort();
    if (
        requestKeys.length !== expectedKeys.length ||
        requestKeys.some((key, index) => key !== expectedKeys[index])
    ) {
        throw new TypeError(`Quote request must contain exactly: ${REQUEST_FIELDS.join(', ')}`);
    }

    if (typeof request.dry !== 'boolean' || request.swapType !== 'EXACT_INPUT') {
        throw new TypeError('Only EXACT_INPUT quote requests are supported');
    }
    if (!Number.isInteger(request.slippageTolerance) ||
        request.slippageTolerance < 1 ||
        request.slippageTolerance > 5000) {
        throw new TypeError('slippageTolerance must be an integer from 1 to 5000 basis points');
    }
    for (const asset of [request.originAsset, request.destinationAsset]) {
        if (
            typeof asset !== 'string' ||
            !/^nep141:[a-z0-9._-]+$/.test(asset)
        ) {
            throw new TypeError('Asset identifiers must use the canonical nep141:<contract> format');
        }
    }
    const pair = findCheckoutPair(request.originAsset, request.destinationAsset);
    if (!pair) {
        throw new TypeError('Asset pair is not in the adapter allowlist');
    }
    if (
        request.depositType !== 'ORIGIN_CHAIN' ||
        request.recipientType !== 'DESTINATION_CHAIN' ||
        request.refundType !== 'ORIGIN_CHAIN'
    ) {
        throw new TypeError('Unsupported deposit, recipient, or refund type combination');
    }
    const amount = amountAsU128(request.amount, 'amount');
    if (amount === 0n) throw new TypeError('amount must be greater than zero');
    if (request.refundTo !== context.associatedAccountId) {
        throw new TypeError('refundTo must exactly match the canonical associated account');
    }
    if (pair.destinationAsset === 'nep141:wrap.near') {
        if (!isNearAccountId(request.recipient)) {
            throw new TypeError('recipient must be a valid NEAR account ID');
        }
    } else {
        if (
            typeof request.recipient !== 'string' ||
            !/^0x[0-9a-fA-F]{40}$/.test(request.recipient)
        ) {
            throw new TypeError('recipient must be a 20-byte EVM address');
        }
    }

    const deadline = parseIsoDate(request.deadline);
    if (deadline === null || (checkDeadline && deadline <= now)) {
        throw new TypeError('deadline must be a valid future ISO-8601 timestamp');
    }
}

function validateResponseShape(response, dry) {
    if (!isRecord(response) || !isRecord(response.quoteRequest) || !isRecord(response.quote)) {
        throw new TypeError('Provider response must include quoteRequest and quote objects');
    }
    const responseFields = ['quoteRequest', 'quote', 'signature', 'timestamp', 'correlationId'];
    if (Object.keys(response).some((key) => !responseFields.includes(key))) {
        throw new TypeError('Provider response contains unsupported top-level fields');
    }
    const requestFields = [
        ...REQUEST_FIELDS,
        'depositMode',
        'confidentiality',
        'insured',
        'quoteWaitingTimeMs',
    ];
    if (Object.keys(response.quoteRequest).some((key) => !requestFields.includes(key))) {
        throw new TypeError('Provider quote request contains unsupported fields');
    }
    const quoteFields = [
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
    if (Object.keys(response.quote).some((key) => !quoteFields.includes(key))) {
        throw new TypeError('Provider quote contains unsupported fields');
    }
    if (
        typeof response.correlationId !== 'string' ||
        response.correlationId.length === 0 ||
        response.correlationId.length > 128 ||
        parseIsoDate(response.timestamp) === null ||
        typeof response.signature !== 'string' ||
        response.signature.length === 0 ||
        response.signature.length > 256
    ) {
        throw new TypeError('Provider response has malformed correlation, timestamp, or signature');
    }
    decodeProviderSignature(response.signature);
    const quote = response.quote;
    for (const key of ['amountIn', 'minAmountIn', 'amountOut', 'minAmountOut']) {
        amountAsU128(quote[key], `quote.${key}`);
    }
    if (dry) {
        for (const field of ['depositAddress', 'depositMemo', 'deadline', 'timeWhenInactive']) {
            if (quote[field] !== undefined) {
                throw new TypeError(`Dry quote must not contain ${field}`);
            }
        }
        return;
    }
    if (!isNearAccountId(quote.depositAddress) && !/^0x[0-9a-fA-F]{40}$/.test(quote.depositAddress)) {
        throw new TypeError('NEAR ORIGIN_CHAIN quote depositAddress must be a valid NEAR account ID or 20-byte EVM address');
    }
    if (quote.depositMemo !== undefined &&
        (typeof quote.depositMemo !== 'string' ||
            quote.depositMemo.length === 0 ||
            quote.depositMemo.length > 1024)) {
        throw new TypeError('depositMemo must be a non-empty string when present');
    }
    if (typeof quote.deadline !== 'string' || parseIsoDate(quote.deadline) === null) {
        throw new TypeError('Provider quote must include a valid quote deadline');
    }
    if (quote.timeWhenInactive !== undefined &&
        (typeof quote.timeWhenInactive !== 'string' ||
            parseIsoDate(quote.timeWhenInactive) === null)) {
        throw new TypeError('Provider quote timeWhenInactive must be a valid ISO-8601 timestamp');
    }
}

function requestMatches(request, providerRequest) {
    return REQUEST_FIELDS.every((field) => providerRequest[field] === request[field]);
}

function validateProviderRequestExtensions(providerRequest) {
    return (
        providerRequest.depositMode === 'SIMPLE' &&
        providerRequest.confidentiality === 'public' &&
        providerRequest.insured === false &&
        (providerRequest.quoteWaitingTimeMs === undefined ||
            providerRequest.quoteWaitingTimeMs === 0)
    );
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

function decodeProviderSignature(signature) {
    if (typeof signature !== 'string' || signature.length === 0) {
        throw new TypeError('Provider signature must be a non-empty Base58 Ed25519 signature');
    }
    const encoded = signature.startsWith(ED25519_PREFIX)
        ? signature.slice(ED25519_PREFIX.length)
        : signature;
    if (encoded.length === 0 || encoded.includes(':')) {
        throw new TypeError('Provider signature has a malformed Ed25519 prefix');
    }
    let bytes;
    try {
        bytes = base58.decode(encoded);
    } catch (error) {
        throw new TypeError('Provider signature is not valid Base58', { cause: error });
    }
    if (bytes.length !== 64) {
        throw new TypeError('Provider signature must decode to exactly 64 bytes');
    }
    return Uint8Array.from(bytes);
}

function providerSignatureHash(signature) {
    return createHash('sha256').update(decodeProviderSignature(signature)).digest('hex');
}

function verifyQuoteResponseInternal({
    request,
    context,
    providerResponse,
    now = Date.now(),
    signatureVerifier = verifyQuoteSignature,
}) {
    const conditions = {
        httpRequestSucceeded: null,
        quoteSignatureValid: false,
        requestResponseBound: false,
        quoteAvailable: false,
        quoteUnexpired: false,
    };
    let normalizedContext;
    try {
        normalizedContext = validateContext(context);
        validateRequest(request, normalizedContext, now, false);
        validateResponseShape(providerResponse, request.dry);
    } catch (error) {
        fail('INVALID_INPUT_OR_RESPONSE', error.message, conditions);
    }

    if (
        !requestMatches(request, providerResponse.quoteRequest) ||
        !validateProviderRequestExtensions(providerResponse.quoteRequest)
    ) {
        fail(
            'REQUEST_RESPONSE_MISMATCH',
            'Provider quote request or unsigned mode fields do not match the supported request policy',
            conditions,
        );
    }
    conditions.requestResponseBound = true;

    let signatureValid = false;
    try {
        signatureValid = signatureVerifier(providerResponse);
    } catch {
        signatureValid = false;
    }
    if (!signatureValid) {
        fail('INVALID_SIGNATURE', 'Provider quote signature is missing or invalid', conditions);
    }
    conditions.quoteSignatureValid = true;

    const quote = providerResponse.quote;
    const amount = BigInt(request.amount);
    const amountIn = BigInt(quote.amountIn);
    const minAmountIn = BigInt(quote.minAmountIn);
    const amountOut = BigInt(quote.amountOut);
    const minAmountOut = BigInt(quote.minAmountOut);
    if (
        amountIn !== amount ||
        minAmountIn === 0n ||
        minAmountIn > amountIn ||
        amountOut === 0n ||
        minAmountOut === 0n ||
        minAmountOut > amountOut
    ) {
        fail(
            'INVALID_QUOTE',
            'Signed quote amounts are inconsistent with the requested exact input',
            conditions,
        );
    }
    conditions.quoteAvailable = true;

    const requestDeadline = parseIsoDate(request.deadline);
    const providerDeadline = request.dry ? null : parseIsoDate(quote.deadline);
    const inactiveDeadline =
        request.dry || quote.timeWhenInactive === undefined
            ? null
            : parseIsoDate(quote.timeWhenInactive);
    if (
        requestDeadline <= now ||
        (!request.dry &&
            (providerDeadline <= now ||
                (inactiveDeadline !== null && inactiveDeadline <= now)))
    ) {
        fail('QUOTE_EXPIRED', 'Request, provider quote, or inactivity deadline has expired', conditions);
    }
    conditions.quoteUnexpired = true;

    const quoteRequest = JSON.parse(JSON.stringify(request));
    const responseCopy = JSON.parse(JSON.stringify(providerResponse));
    const envelope = deepFreeze({
        tokenId: normalizedContext.tokenId,
        relayContractId: normalizedContext.relayContractId,
        associatedAccountId: normalizedContext.associatedAccountId,
        ownerAtQuote: normalizedContext.ownerAccountId,
        relay: normalizedContext,
        quoteNonce: normalizedContext.quoteNonce,
        relayStateBlockHash: normalizedContext.relayStateBlockHash ?? null,
        quoteRequest,
        providerQuoteResponse: responseCopy,
        providerSignature: providerResponse.signature,
        providerSignatureHash: providerSignatureHash(providerResponse.signature),
        providerQuoteHash: quoteHash(providerResponse),
        quoteTimestamp: providerResponse.timestamp,
        depositAddress: quote.depositAddress,
        depositMemo: quote.depositMemo ?? null,
        sourceAsset: request.originAsset,
        sourceDecimals: findCheckoutPair(request.originAsset, request.destinationAsset)?.sourceDecimals ?? ORIGIN_DECIMALS,
        sourceAmount: request.amount,
        destinationAsset: request.destinationAsset,
        destinationDecimals: findCheckoutPair(request.originAsset, request.destinationAsset)?.destinationDecimals ?? DESTINATION_DECIMALS,
        expectedOutput: quote.amountOut,
        minimumOutput: quote.minAmountOut,
        recipient: request.recipient,
        refundAddress: request.refundTo,
        refundType: request.refundType,
        requestDeadline: request.deadline,
        providerQuoteDeadline: quote.deadline ?? null,
        providerInactiveDeadline: quote.timeWhenInactive ?? null,
        dry: request.dry,
        sdkVersion: SDK_VERSION,
    });
    ISSUED_ENVELOPES.add(envelope);

    return Object.freeze({
        conditions: Object.freeze({ ...conditions }),
        envelope,
    });
}

function verifyQuoteResponse(options) {
    return verifyQuoteResponseInternal(options);
}

function verifyQuoteResponseWithManagerKeyForTesting({ managerPublicKey, ...options }) {
    if (typeof managerPublicKey !== 'string' || managerPublicKey.length === 0) {
        throw new TypeError('A test fixture manager public key is required');
    }
    return verifyQuoteResponseInternal({
        ...options,
        signatureVerifier: (response) => verifyQuoteSignature(response, managerPublicKey),
    });
}

async function requestVerifiedQuote({
    request,
    context,
    fetchImpl = globalThis.fetch,
    apiKey,
    apiUrl = API_URL,
    timeoutMs = 15000,
    now = Date.now,
}) {
    const failedConditions = {
        httpRequestSucceeded: false,
        quoteSignatureValid: false,
        requestResponseBound: false,
        quoteAvailable: false,
        quoteUnexpired: false,
    };
    const currentTime = now();
    try {
        const normalizedContext = validateContext(context);
        validateRequest(request, normalizedContext, currentTime);
    } catch (error) {
        fail('INVALID_REQUEST', error.message, failedConditions);
    }
    if (typeof fetchImpl !== 'function') {
        fail('PROVIDER_UNAVAILABLE', 'No fetch implementation is available', failedConditions);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
        fail('INVALID_TIMEOUT', 'timeoutMs must be an integer from 1 to 120000', failedConditions);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let providerResponse;
    let rawProviderResponseText;
    let rawProviderResponseBase64;
    try {
        response = await fetchImpl(apiUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(apiKey ? { 'x-api-key': apiKey } : {}),
            },
            body: JSON.stringify(request),
            signal: controller.signal,
        });
        if (response && response.ok) {
            if (typeof response.arrayBuffer === 'function') {
                const rawBytes = Buffer.from(await response.arrayBuffer());
                rawProviderResponseBase64 = rawBytes.toString('base64');
                rawProviderResponseText = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
                providerResponse = JSON.parse(rawProviderResponseText);
            } else if (typeof response.text === 'function') {
                rawProviderResponseText = await response.text();
                providerResponse = JSON.parse(rawProviderResponseText);
            } else {
                providerResponse = await response.json();
                rawProviderResponseText = JSON.stringify(providerResponse);
            }
        }
    } catch (error) {
        const timedOut = controller.signal.aborted;
        const bodyReadFailed = response && response.ok;
        fail(
            timedOut
                ? 'PROVIDER_TIMEOUT'
                : bodyReadFailed
                  ? 'MALFORMED_RESPONSE'
                  : 'PROVIDER_UNAVAILABLE',
            timedOut
                ? '1Click quote request timed out'
                : bodyReadFailed
                  ? 'Provider returned invalid or incomplete JSON'
                  : '1Click quote request failed',
            bodyReadFailed
                ? { ...failedConditions, httpRequestSucceeded: true }
                : failedConditions,
            { cause: error.message },
        );
    } finally {
        clearTimeout(timer);
    }

    if (!response || typeof response.ok !== 'boolean') {
        fail('MALFORMED_HTTP_RESPONSE', 'Provider returned an invalid HTTP response', failedConditions);
    }
    if (!response.ok) {
        fail(
            'PROVIDER_HTTP_ERROR',
            `1Click quote endpoint returned HTTP ${response.status}`,
            { ...failedConditions, httpRequestSucceeded: true },
            { status: response.status },
        );
    }

    let verified;
    try {
        verified = verifyQuoteResponse({
            request,
            context,
            providerResponse,
            now: now(),
        });
    } catch (error) {
        if (error instanceof QuoteAdapterError) {
            throw new QuoteAdapterError(
                error.code,
                error.message,
                { ...error.conditions, httpRequestSucceeded: true },
                error.details,
            );
        }
        throw error;
    }
    return Object.freeze({
        conditions: Object.freeze({
            ...verified.conditions,
            httpRequestSucceeded: true,
        }),
        envelope: verified.envelope,
        rawProviderResponseText,
        rawProviderResponseBase64,
    });
}

function canonicalU64(value, field) {
    if (
        typeof value !== 'string' ||
        value.length > 20 ||
        !/^(0|[1-9]\d*)$/.test(value) ||
        BigInt(value) > 18446744073709551615n
    ) {
        throw new TypeError(`${field} must be a canonical u64 decimal string`);
    }
    return value;
}

async function relayViewCall({
    rpcUrl,
    contractId,
    methodName,
    args,
    fetchImpl,
    timeoutMs,
    blockId,
    includeBlockHash = false,
}) {
    let url;
    try {
        url = new URL(rpcUrl);
    } catch {
        throw new QuoteAdapterError('INVALID_RELAY_RPC_URL', 'RELAY RPC URL is invalid', {});
    }
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        !isNearAccountId(contractId)
    ) {
        throw new QuoteAdapterError('INVALID_RELAY_RPC_URL', 'RELAY RPC URL or contract ID is invalid', {});
    }
    if (typeof fetchImpl !== 'function') {
        throw new QuoteAdapterError('RELAY_RPC_UNAVAILABLE', 'No fetch implementation is available', {});
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let body;
    try {
        response = await fetchImpl(url.toString(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'relay-quote-adapter',
                method: 'query',
                params: {
                    request_type: 'call_function',
                    account_id: contractId,
                    method_name: methodName,
                    args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
                    ...(blockId ? { block_id: blockId } : { finality: 'final' }),
                },
            }),
            signal: controller.signal,
        });
        if (response && response.ok) body = await response.json();
    } catch (error) {
        throw new QuoteAdapterError(
            controller.signal.aborted ? 'RELAY_RPC_TIMEOUT' : 'RELAY_RPC_UNAVAILABLE',
            controller.signal.aborted ? 'RELAY RPC request timed out' : 'RELAY RPC request failed',
            {},
            {
                methodName,
                rpcHost: url.hostname,
                systemCode: error.cause && error.cause.code,
            },
        );
    } finally {
        clearTimeout(timer);
    }
    if (!response || !response.ok) {
        throw new QuoteAdapterError(
            'RELAY_RPC_HTTP_ERROR',
            `RELAY RPC returned HTTP ${response ? response.status : 'unknown'}`,
            {},
            { methodName, status: response && response.status },
        );
    }
    if (
        !isRecord(body) ||
        body.jsonrpc !== '2.0' ||
        body.id !== 'relay-quote-adapter' ||
        body.error ||
        !isRecord(body.result) ||
        !Array.isArray(body.result.result)
    ) {
        throw new QuoteAdapterError(
            'RELAY_RPC_MALFORMED_RESPONSE',
            'RELAY RPC returned an invalid view-call response',
            {},
            { methodName, rpcError: isRecord(body) ? body.error : undefined },
        );
    }
    if (
        body.result.result.some(
            (byte) => !Number.isInteger(byte) || byte < 0 || byte > 255,
        )
    ) {
        throw new QuoteAdapterError(
            'RELAY_RPC_MALFORMED_RESPONSE',
            'RELAY RPC view-call result contains invalid bytes',
            {},
            { methodName },
        );
    }
    try {
        const encoded = new TextDecoder('utf-8', { fatal: true }).decode(
            Uint8Array.from(body.result.result),
        );
        const value = JSON.parse(encoded);
        if (includeBlockHash) {
            if (typeof body.result.block_hash !== 'string' || body.result.block_hash.length === 0) {
                throw new TypeError('RELAY RPC response omitted its finalized block hash');
            }
            return { value, blockHash: body.result.block_hash };
        }
        return value;
    } catch (error) {
        throw new QuoteAdapterError(
            'RELAY_RPC_MALFORMED_RESPONSE',
            'RELAY contract returned invalid JSON from a view method',
            {},
            { methodName, cause: error.message },
        );
    }
}

async function fetchRelayQuoteSnapshot({
    rpcUrl,
    relayContractId,
    tokenId,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10000,
}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
        throw new QuoteAdapterError('INVALID_TIMEOUT', 'timeoutMs must be from 1 to 120000', {});
    }
    if (
        typeof tokenId !== 'string' ||
        tokenId.length < 1 ||
        tokenId.length > 32 ||
        !/^[a-z0-9_-]+$/.test(tokenId) ||
        !isNearAccountId(relayContractId)
    ) {
        throw new QuoteAdapterError('INVALID_RELAY_CONTEXT', 'RELAY token or contract ID is invalid', {});
    }
    const snapshot = await relayViewCall({
        rpcUrl,
        contractId: relayContractId,
        methodName: 'nft_total_supply',
        args: {},
        fetchImpl,
        timeoutMs,
        includeBlockHash: true,
    });
    const [token, binding, nonceResult] = await Promise.all([
        relayViewCall({
            rpcUrl,
            contractId: relayContractId,
            methodName: 'nft_token',
            args: { token_id: tokenId },
            fetchImpl,
            timeoutMs,
            blockId: snapshot.blockHash,
        }),
        relayViewCall({
            rpcUrl,
            contractId: relayContractId,
            methodName: 'relay_account_binding',
            args: { token_id: tokenId },
            fetchImpl,
            timeoutMs,
            blockId: snapshot.blockHash,
        }),
        relayViewCall({
            rpcUrl,
            contractId: relayContractId,
            methodName: 'relay_quote_nonce',
            args: { token_id: tokenId },
            fetchImpl,
            timeoutMs,
            blockId: snapshot.blockHash,
        }),
    ]);
    const canonicalAccountId = `${tokenId}.${relayContractId}`;
    if (
        !isRecord(token) ||
        !isNearAccountId(token.owner_id) ||
        !isRecord(binding) ||
        binding.account_id !== canonicalAccountId ||
        binding.is_verified !== true
    ) {
        throw new QuoteAdapterError(
            'INVALID_RELAY_STATE',
            'RELAY token is missing, unverified, or not bound to its canonical account',
            {},
        );
    }
    let quoteNonce;
    try {
        quoteNonce = canonicalU64(nonceResult, 'relay_quote_nonce');
    } catch (error) {
        throw new QuoteAdapterError('INVALID_RELAY_STATE', error.message, {});
    }
    return {
        context: validateContext({
            tokenId,
            relayContractId,
            associatedAccountId: binding.account_id,
            ownerAccountId: token.owner_id,
            quoteNonce,
            relayStateBlockHash: snapshot.blockHash,
        }),
        blockHash: snapshot.blockHash,
    };
}

async function fetchRelayReconciliationSnapshot({
    rpcUrl,
    relayContractId,
    tokenId,
    commitmentHash,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10000,
}) {
    if (
        typeof commitmentHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(commitmentHash)
    ) {
        throw new QuoteAdapterError(
            'INVALID_RECONCILIATION_CONTEXT',
            'Quote commitment must be a canonical lowercase SHA-256 digest',
            {},
        );
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
        throw new QuoteAdapterError('INVALID_TIMEOUT', 'timeoutMs must be from 1 to 120000', {});
    }
    if (
        typeof tokenId !== 'string' ||
        tokenId.length < 1 ||
        tokenId.length > 32 ||
        !/^[a-z0-9_-]+$/.test(tokenId) ||
        !isNearAccountId(relayContractId)
    ) {
        throw new QuoteAdapterError(
            'INVALID_RECONCILIATION_CONTEXT',
            'RELAY token or contract ID is invalid',
            {},
        );
    }
    const snapshot = await relayViewCall({
        rpcUrl,
        contractId: relayContractId,
        methodName: 'nft_total_supply',
        args: {},
        fetchImpl,
        timeoutMs,
        includeBlockHash: true,
    });
    const [payment, authorization, token, binding, isLocked] = await Promise.all([
        relayViewCall({
            rpcUrl,
            contractId: relayContractId,
            methodName: 'relay_payment',
            args: { token_id: tokenId },
            fetchImpl,
            timeoutMs,
            blockId: snapshot.blockHash,
        }),
        relayViewCall({
            rpcUrl,
            contractId: relayContractId,
            methodName: 'relay_quote_authorization',
            args: { token_id: tokenId, commitment_hash: commitmentHash },
            fetchImpl,
            timeoutMs,
            blockId: snapshot.blockHash,
        }),
        relayViewCall({
            rpcUrl,
            contractId: relayContractId,
            methodName: 'nft_token',
            args: { token_id: tokenId },
            fetchImpl,
            timeoutMs,
            blockId: snapshot.blockHash,
        }),
        relayViewCall({
            rpcUrl,
            contractId: relayContractId,
            methodName: 'relay_account_binding',
            args: { token_id: tokenId },
            fetchImpl,
            timeoutMs,
            blockId: snapshot.blockHash,
        }),
        relayViewCall({
            rpcUrl,
            contractId: relayContractId,
            methodName: 'is_token_locked',
            args: { token_id: tokenId },
            fetchImpl,
            timeoutMs,
            blockId: snapshot.blockHash,
        }),
    ]);
    const canonicalAccountId = `${tokenId}.${relayContractId}`;
    if (
        !isRecord(payment) ||
        payment.token_id !== tokenId ||
        payment.commitment_hash !== commitmentHash ||
        !isRecord(authorization) ||
        authorization.token_id !== tokenId ||
        authorization.commitment_hash !== commitmentHash ||
        !['Consumed', 'RecoveryRequired'].includes(authorization.status) ||
        !['Dispatched', 'SourceTransferCompleted'].includes(
            authorization.deposit_dispatch_status,
        ) ||
        !isRecord(token) ||
        !isNearAccountId(token.owner_id) ||
        token.owner_id !== payment.owner_at_dispatch ||
        !isRecord(binding) ||
        binding.account_id !== canonicalAccountId ||
        binding.account_id !== payment.associated_account_id ||
        binding.is_verified !== true ||
        isLocked !== true
    ) {
        throw new QuoteAdapterError(
            'INVALID_RECONCILIATION_STATE',
            'Finalized RELAY payment, authorization, owner, binding, or lock state is inconsistent',
            {},
        );
    }
    return Object.freeze({
        blockHash: snapshot.blockHash,
        payment: Object.freeze(payment),
        authorization: Object.freeze(authorization),
        token: Object.freeze(token),
        binding: Object.freeze(binding),
        isLocked,
    });
}

async function fetchRelayQuoteContext(options) {
    return (await fetchRelayQuoteSnapshot(options)).context;
}

function timestampToNanos(timestamp, field) {
    if (parseIsoDate(timestamp) === null) {
        throw new TypeError(`${field} must be an ISO-8601 timestamp`);
    }
    const fraction = timestamp.match(/\.(\d+)(?=Z|[+-]\d{2}:\d{2})/);
    if (fraction && fraction[1].length > 9) {
        throw new TypeError(`${field} cannot have precision finer than one nanosecond`);
    }
    const wholeSecondTimestamp = timestamp.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2})/, '');
    const wholeSeconds = Math.trunc(Date.parse(wholeSecondTimestamp) / 1000);
    if (!Number.isFinite(wholeSeconds)) {
        throw new TypeError(`${field} must be an ISO-8601 timestamp`);
    }
    const fractionalNanos = BigInt(((fraction && fraction[1]) || '').padEnd(9, '0') || '0');
    const nanoseconds = BigInt(wholeSeconds) * 1000000000n + fractionalNanos;
    if (nanoseconds > 18446744073709551615n) {
        throw new TypeError(`${field} exceeds the NEAR block timestamp range`);
    }
    return nanoseconds.toString();
}

function providerSignedPayload(response) {
    const request = response.quoteRequest;
    const quote = response.quote;
    const signedRequest = {
        dry: request.dry,
        swapType: request.swapType,
        slippageTolerance: request.slippageTolerance,
        originAsset: request.originAsset,
        depositType: request.depositType,
        destinationAsset: request.destinationAsset,
        amount: request.amount,
        refundTo: request.refundTo,
        refundType: request.refundType,
        recipient: request.recipient,
        recipientType: request.recipientType,
        deadline: request.deadline,
        quoteWaitingTimeMs: request.quoteWaitingTimeMs ? request.quoteWaitingTimeMs : undefined,
        referral: request.referral ? request.referral : undefined,
        virtualChainRecipient: request.virtualChainRecipient
            ? request.virtualChainRecipient
            : undefined,
        virtualChainRefundRecipient: request.virtualChainRefundRecipient
            ? request.virtualChainRefundRecipient
            : undefined,
        customRecipientMsg: request.customRecipientMsg ? request.customRecipientMsg : undefined,
        sessionId: undefined,
        connectedWallets: undefined,
        correlationId: undefined,
        appFees: undefined,
        partnerId: undefined,
        userAccountId: undefined,
        depositMode: undefined,
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
        depositAddress: quote.depositAddress || undefined,
        depositMemo: quote.depositMemo || undefined,
        deadline: quote.deadline || undefined,
        timeWhenInactive: quote.timeWhenInactive || undefined,
        timeEstimate: quote.timeEstimate || undefined,
        refundFee: quote.refundFee || undefined,
        withdrawFee: quote.withdrawFee || undefined,
    };
    return stableStringify({ ...signedRequest, ...signedQuote, timestamp: response.timestamp });
}

function quoteAuthorizationFields(envelope) {
    const quote = envelope.providerQuoteResponse.quote;
    return {
        providerSignatureHash: providerSignatureHash(envelope.providerSignature),
        sourceAsset: envelope.sourceAsset,
        sourceDecimals: envelope.sourceDecimals,
        depositType: envelope.quoteRequest.depositType,
        sourceAmount: envelope.sourceAmount,
        destinationAsset: envelope.destinationAsset,
        destinationDecimals: envelope.destinationDecimals,
        expectedOutput: quote.amountOut,
        minimumOutput: quote.minAmountOut,
        recipient: envelope.recipient,
        depositAddress: envelope.depositAddress,
        depositMemo: envelope.depositMemo,
        refundAddress: envelope.refundAddress,
        refundType: envelope.refundType,
        requestDeadline: timestampToNanos(envelope.requestDeadline, 'requestDeadline'),
        providerQuoteDeadline: timestampToNanos(
            envelope.providerQuoteDeadline,
            'providerQuoteDeadline',
        ),
        providerInactiveDeadline: envelope.providerInactiveDeadline === null
            ? null
            : timestampToNanos(envelope.providerInactiveDeadline, 'providerInactiveDeadline'),
    };
}

function computeQuoteCommitment(envelope) {
    if (envelope.dry) throw new TypeError('Dry quote previews cannot be committed for preparation');
    const quote = quoteAuthorizationFields(envelope);
    const fields = [
        'RELAY-1CLICK-QUOTE-AUTH-V2',
        envelope.tokenId,
        envelope.relayContractId,
        envelope.associatedAccountId,
        envelope.ownerAtQuote,
        envelope.quoteNonce,
        quote.providerSignatureHash,
        quote.sourceAsset,
        String(quote.sourceDecimals),
        quote.depositType,
        quote.sourceAmount,
        quote.destinationAsset,
        String(quote.destinationDecimals),
        quote.expectedOutput,
        quote.minimumOutput,
        quote.recipient,
        quote.depositAddress,
        quote.depositMemo === null ? '0' : '1',
        quote.depositMemo ?? '',
        quote.refundAddress,
        quote.refundType,
        quote.requestDeadline,
        quote.providerQuoteDeadline,
        quote.providerInactiveDeadline === null ? '0' : '1',
        quote.providerInactiveDeadline ?? '',
    ];
    const chunks = [];
    for (const field of fields) {
        const encoded = Buffer.from(field, 'utf8');
        if (encoded.length > 0xffffffff) throw new TypeError('Quote commitment field is too large');
        const length = Buffer.alloc(4);
        length.writeUInt32BE(encoded.length);
        chunks.push(length, encoded);
    }
    return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}

function buildQuoteAuthorizationArgs(envelope) {
    if (envelope && envelope.dry) {
        throw new QuoteAdapterError(
            'DRY_QUOTE_NOT_PREPARABLE',
            'Dry quote previews cannot be authorized for checkout preparation',
            {},
        );
    }
    if (!envelope || !ISSUED_ENVELOPES.has(envelope)) {
        throw new QuoteAdapterError(
            'UNISSUED_ENVELOPE',
            'Only an envelope verified by this adapter instance can be authorized',
            {},
        );
    }
    const fields = quoteAuthorizationFields(envelope);
    const commitmentHash = computeQuoteCommitment(envelope);
    return Object.freeze({
        token_id: envelope.tokenId,
        expected_nonce: envelope.quoteNonce,
        quote: Object.freeze({
            provider_signature_hash: fields.providerSignatureHash,
            provider_signature: Array.from(decodeProviderSignature(envelope.providerSignature)),
            provider_signed_payload: providerSignedPayload(envelope.providerQuoteResponse),
            commitment_hash: commitmentHash,
            source_asset: fields.sourceAsset,
            source_decimals: fields.sourceDecimals,
            deposit_type: fields.depositType,
            source_amount: fields.sourceAmount,
            destination_asset: fields.destinationAsset,
            destination_decimals: fields.destinationDecimals,
            expected_output: fields.expectedOutput,
            minimum_output: fields.minimumOutput,
            recipient: fields.recipient,
            deposit_address: fields.depositAddress,
            deposit_memo: fields.depositMemo,
            refund_address: fields.refundAddress,
            refund_type: fields.refundType,
            request_deadline: fields.requestDeadline,
            provider_quote_deadline: fields.providerQuoteDeadline,
            provider_inactive_deadline: fields.providerInactiveDeadline,
        }),
    });
}

async function requestRelayQuote({
    request,
    relayContractId,
    tokenId,
    rpcUrl,
    rpcFetchImpl = globalThis.fetch,
    providerFetchImpl = globalThis.fetch,
    apiKey,
    apiBaseUrl = 'https://1click.chaindefuser.com',
    timeoutMs = 10000,
    providerTimeoutMs = 15000,
    now = Date.now,
}) {
    const snapshot = await fetchRelayQuoteSnapshot({
        rpcUrl,
        relayContractId,
        tokenId,
        fetchImpl: rpcFetchImpl,
        timeoutMs,
    });
    const context = snapshot.context;
    const result = await requestVerifiedQuote({
        request,
        context,
        fetchImpl: providerFetchImpl,
        apiKey,
        apiUrl: `${apiBaseUrl.replace(/\/$/, '')}/v0/quote`,
        timeoutMs: providerTimeoutMs,
        now,
    });
    return Object.freeze({
        ...result,
        authorizationArgs: request.dry ? null : buildQuoteAuthorizationArgs(result.envelope),
        authorizationDepositHint: request.dry ? null : AUTHORIZATION_DEPOSIT_HINT,
    });
}

async function verifyRelayQuoteAuthorizationInternal(
    {
        request,
        providerResponse,
        relayContractId,
        tokenId,
        rpcUrl,
        rpcFetchImpl = globalThis.fetch,
        timeoutMs = 10000,
        now = Date.now,
    },
    verifyResponse,
) {
    const snapshot = await fetchRelayQuoteSnapshot({
        rpcUrl,
        relayContractId,
        tokenId,
        fetchImpl: rpcFetchImpl,
        timeoutMs,
    });
    const context = snapshot.context;
    const authorization = await relayViewCall({
        rpcUrl,
        contractId: relayContractId,
        methodName: 'relay_active_quote_authorization',
        args: { token_id: tokenId },
        fetchImpl: rpcFetchImpl,
        timeoutMs,
        blockId: snapshot.blockHash,
    });
    if (!isRecord(authorization)) {
        throw new QuoteAdapterError(
            'ONCHAIN_AUTHORIZATION_MISMATCH',
            'RELAY has no active quote authorization for this token',
            { relayStateVerified: false },
        );
    }
    let authorizationNonce;
    try {
        authorizationNonce = canonicalU64(authorization.nonce, 'authorization.nonce');
    } catch (error) {
        throw new QuoteAdapterError(
            'ONCHAIN_AUTHORIZATION_MISMATCH',
            'RELAY returned a malformed quote authorization nonce',
            { relayStateVerified: false },
            { cause: error.message },
        );
    }
    if (BigInt(context.quoteNonce) !== BigInt(authorizationNonce) + 1n) {
        throw new QuoteAdapterError(
            'ONCHAIN_AUTHORIZATION_MISMATCH',
            'RELAY quote nonce has advanced since this authorization',
            { relayStateVerified: false },
        );
    }
    const authorizationContext = validateContext({
        ...context,
        quoteNonce: authorizationNonce,
    });
    const verified = verifyResponse({
        request,
        context: authorizationContext,
        providerResponse,
        now: now(),
    });
    const authorizationArgs = buildQuoteAuthorizationArgs(verified.envelope);
    const expected = authorizationArgs.quote;
    let authorizationRequestDeadline;
    let authorizationProviderDeadline;
    let authorizationInactiveDeadline = null;
    let createdBlockHeight;
    let createdTimestamp;
    try {
        authorizationRequestDeadline = canonicalU64(
            authorization.request_deadline,
            'authorization.request_deadline',
        );
        authorizationProviderDeadline = canonicalU64(
            authorization.provider_quote_deadline,
            'authorization.provider_quote_deadline',
        );
        if (authorization.provider_inactive_deadline !== null) {
            authorizationInactiveDeadline = canonicalU64(
                authorization.provider_inactive_deadline,
                'authorization.provider_inactive_deadline',
            );
        }
        createdBlockHeight = canonicalU64(
            authorization.created_block_height,
            'authorization.created_block_height',
        );
        createdTimestamp = canonicalU64(
            authorization.created_timestamp,
            'authorization.created_timestamp',
        );
    } catch (error) {
        throw new QuoteAdapterError(
            'ONCHAIN_AUTHORIZATION_MISMATCH',
            'RELAY returned malformed quote authorization deadlines',
            { ...verified.conditions, relayStateVerified: false },
            { cause: error.message },
        );
    }
    const matches =
        authorization.status === 'Prepared' &&
        authorization.token_id === tokenId &&
        authorization.parent_contract_id === relayContractId &&
        authorization.associated_account_id === authorizationContext.associatedAccountId &&
        authorization.owner_at_authorization === authorizationContext.ownerAccountId &&
        authorization.nonce === authorizationNonce &&
        authorization.account_binding_verified === true &&
        authorization.deposit_dispatch_status === 'Disabled' &&
        authorization.provider_signature_hash === expected.provider_signature_hash &&
        authorization.commitment_hash === expected.commitment_hash &&
        authorization.source_asset === expected.source_asset &&
        authorization.source_decimals === expected.source_decimals &&
        authorization.deposit_type === expected.deposit_type &&
        authorization.source_amount === expected.source_amount &&
        authorization.destination_asset === expected.destination_asset &&
        authorization.destination_decimals === expected.destination_decimals &&
        authorization.expected_output === expected.expected_output &&
        authorization.minimum_output === expected.minimum_output &&
        authorization.recipient === expected.recipient &&
        authorization.deposit_address === expected.deposit_address &&
        (authorization.deposit_memo ?? null) === expected.deposit_memo &&
        authorization.refund_address === expected.refund_address &&
        authorization.refund_type === expected.refund_type &&
        authorizationRequestDeadline === expected.request_deadline &&
        authorizationProviderDeadline === expected.provider_quote_deadline &&
        authorizationInactiveDeadline === expected.provider_inactive_deadline &&
        createdBlockHeight !== undefined &&
        createdTimestamp !== undefined;
    if (!matches) {
        throw new QuoteAdapterError(
            'ONCHAIN_AUTHORIZATION_MISMATCH',
            'Current RELAY state does not contain an active authorization for this exact quote',
            { ...verified.conditions, relayStateVerified: false },
        );
    }
    return Object.freeze({
        conditions: Object.freeze({
            ...verified.conditions,
            relayStateVerified: true,
        }),
        envelope: verified.envelope,
        authorization,
    });
}

async function verifyRelayQuoteAuthorization(options) {
    return verifyRelayQuoteAuthorizationInternal(options, verifyQuoteResponse);
}

async function verifyRelayQuoteAuthorizationWithManagerKeyForTesting({
    managerPublicKey,
    ...options
}) {
    return verifyRelayQuoteAuthorizationInternal(options, (verification) =>
        verifyQuoteResponseWithManagerKeyForTesting({
            ...verification,
            managerPublicKey,
        }),
    );
}

function claimQuoteEnvelope(envelope, expectedContext, now = Date.now()) {
    if (!envelope || !ISSUED_ENVELOPES.has(envelope)) {
        throw new QuoteAdapterError(
            'UNISSUED_ENVELOPE',
            'Envelope was not issued by this adapter instance',
            {
                httpRequestSucceeded: null,
                quoteSignatureValid: false,
                requestResponseBound: false,
                quoteAvailable: false,
                quoteUnexpired: false,
            },
        );
    }
    let normalizedContext;
    try {
        normalizedContext = validateContext(expectedContext);
    } catch (error) {
        throw new QuoteAdapterError('INVALID_CONTEXT', error.message, {});
    }
    const actual = envelope.relay;
    if (
        actual.tokenId !== normalizedContext.tokenId ||
        actual.relayContractId !== normalizedContext.relayContractId ||
        actual.associatedAccountId !== normalizedContext.associatedAccountId ||
        actual.ownerAccountId !== normalizedContext.ownerAccountId ||
        actual.quoteNonce !== normalizedContext.quoteNonce
    ) {
        throw new QuoteAdapterError(
            'ENVELOPE_CONTEXT_MISMATCH',
            'Quote envelope is bound to a different RELAY token, account, owner, or nonce',
            {},
        );
    }
    if (
        parseIsoDate(envelope.requestDeadline) <= now ||
        parseIsoDate(envelope.providerQuoteDeadline) <= now
    ) {
        throw new QuoteAdapterError(
            'QUOTE_EXPIRED',
            'Quote envelope expired before it could be claimed',
            {
                httpRequestSucceeded: null,
                quoteSignatureValid: true,
                requestResponseBound: true,
                quoteAvailable: true,
                quoteUnexpired: false,
            },
        );
    }
    if (CLAIMED_ENVELOPES.has(envelope)) {
        throw new QuoteAdapterError('ENVELOPE_REUSED', 'Quote envelope was already claimed', {});
    }
    const quoteId = `${envelope.providerSignature}\u0000${envelope.depositAddress}`;
    if (CLAIMED_QUOTES.has(quoteId)) {
        throw new QuoteAdapterError('QUOTE_REUSED', 'Provider quote was already claimed', {});
    }
    CLAIMED_ENVELOPES.add(envelope);
    CLAIMED_QUOTES.add(quoteId);
    return envelope;
}

module.exports = {
    API_URL,
    TOKEN_API_URL,
    AUTHORIZATION_DEPOSIT_HINT,
    DESTINATION_ASSET,
    DESTINATION_DECIMALS,
    ORIGIN_ASSET,
    ORIGIN_DECIMALS,
    BASE_USDC_ASSET,
    BASE_USDC_DECIMALS,
    BASE_WETH_ASSET,
    BASE_WETH_DECIMALS,
    amountAsU128,
    SDK_VERSION,
    QuoteAdapterError,
    buildQuoteAuthorizationArgs,
    claimQuoteEnvelope,
    computeQuoteCommitment,
    decodeProviderSignature,
    fetchRelayReconciliationSnapshot,
    fetchRelayQuoteContext,
    providerSignatureHash,
    requestRelayQuote,
    requestVerifiedQuote,
    verifyRelayQuoteAuthorization,
    verifyRelayQuoteAuthorizationWithManagerKeyForTesting,
    verifyQuoteResponse,
    verifyQuoteResponseWithManagerKeyForTesting,
};
