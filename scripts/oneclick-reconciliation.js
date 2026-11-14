'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const stableStringify = require('json-stable-stringify');
const {
    buildQuoteAuthorizationArgs,
    computeQuoteCommitment,
    fetchRelayReconciliationSnapshot,
    providerSignatureHash,
    verifyQuoteResponse,
} = require('./oneclick-quote-adapter');

const STATUS_VALUES = new Set([
    'KNOWN_DEPOSIT_TX',
    'PENDING_DEPOSIT',
    'INCOMPLETE_DEPOSIT',
    'PROCESSING',
    'SUCCESS',
    'REFUNDED',
    'FAILED',
]);
const TERMINAL_PROVIDER_STATUSES = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const STATUS_URL = 'https://1click.chaindefuser.com/v0/status';
const MAX_STATUS_RESPONSE_BYTES = 1_048_576;

function fail(message) {
    throw new TypeError(message);
}

function paymentKey(tokenId, nonce, commitmentHash) {
    return `${tokenId}:${nonce}:${commitmentHash}`;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function validateStatusResponse(response) {
    if (!isObject(response)) fail('1Click status response must be an object');
    if (
        typeof response.correlationId !== 'string' ||
        response.correlationId.length === 0 ||
        response.correlationId.length > 128
    ) {
        fail('1Click status response has an invalid correlationId');
    }
    if (!STATUS_VALUES.has(response.status)) {
        fail('1Click status response contains an unsupported status');
    }
    if (
        typeof response.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(response.updatedAt))
    ) {
        fail('1Click status response has an invalid updatedAt timestamp');
    }
    if (!isObject(response.quoteResponse) || !isObject(response.swapDetails)) {
        fail('1Click status response is missing quoteResponse or swapDetails');
    }
    const details = response.swapDetails;
    for (const field of ['intentHashes', 'nearTxHashes', 'originChainTxHashes', 'destinationChainTxHashes']) {
        if (!Array.isArray(details[field])) {
            fail(`1Click status response has an invalid swapDetails.${field}`);
        }
    }
    for (const field of ['originChainTxHashes', 'destinationChainTxHashes']) {
        for (const transaction of details[field]) {
            if (
                !isObject(transaction) ||
                typeof transaction.hash !== 'string' ||
                transaction.hash.length === 0 ||
                typeof transaction.explorerUrl !== 'string'
            ) {
                fail(`1Click status response has an invalid swapDetails.${field} entry`);
            }
        }
    }
    const serialized = stableStringify(response);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATUS_RESPONSE_BYTES) {
        fail('1Click status response exceeds the durable journal limit');
    }
    return serialized;
}

function classifyProviderObservation(status) {
    switch (status) {
        case 'KNOWN_DEPOSIT_TX':
        case 'PENDING_DEPOSIT':
        case 'INCOMPLETE_DEPOSIT':
            return 'PROVIDER_DEPOSIT_UNCONFIRMED';
        case 'PROCESSING':
            return 'PROVIDER_PROCESSING_UNVERIFIED';
        case 'SUCCESS':
            return 'DESTINATION_SETTLEMENT_PENDING';
        case 'REFUNDED':
            return 'REFUND_PENDING';
        case 'FAILED':
            return 'PROVIDER_FAILURE_UNVERIFIED';
        default:
            fail('Unsupported 1Click provider status');
    }
}

async function validateRegistration(input) {
    if (!isObject(input) || !isObject(input.context) || !isObject(input.request)) {
        fail('Payment registration requires a verified quote context and request');
    }
    const {
        context,
        request,
        providerQuoteResponse,
        authorizationArgs,
        rpcUrl,
        rpcFetchImpl,
        timeoutMs,
    } = input;
    if (!isObject(authorizationArgs) || !isObject(authorizationArgs.quote)) {
        fail('Payment registration is missing authorization or payment record data');
    }
    if (
        authorizationArgs.token_id !== context.tokenId ||
        authorizationArgs.expected_nonce !== context.quoteNonce
    ) {
        fail('Authorization arguments do not match the quote context');
    }

    const signedTimestamp = Date.parse(providerQuoteResponse && providerQuoteResponse.timestamp);
    if (!Number.isFinite(signedTimestamp)) fail('Provider quote timestamp is invalid');
    const { envelope } = verifyQuoteResponse({
        request,
        context,
        providerResponse: providerQuoteResponse,
        now: signedTimestamp,
    });
    const quote = authorizationArgs.quote;
    const commitment = computeQuoteCommitment(envelope);
    const expectedQuote = buildQuoteAuthorizationArgs(envelope).quote;
    if (
        quote.commitment_hash !== commitment ||
        stableStringify(quote) !== stableStringify(expectedQuote)
    ) {
        fail('Authorization values do not match the provider-signed quote');
    }
    const relaySnapshot = await fetchRelayReconciliationSnapshot({
        rpcUrl,
        relayContractId: context.relayContractId,
        tokenId: context.tokenId,
        commitmentHash: commitment,
        fetchImpl: rpcFetchImpl,
        timeoutMs,
    });
    const paymentRecord = relaySnapshot.payment;
    const authorization = relaySnapshot.authorization;
    if (
        paymentRecord.token_id !== context.tokenId ||
        paymentRecord.owner_at_dispatch !== context.ownerAccountId ||
        paymentRecord.associated_account_id !== context.associatedAccountId ||
        paymentRecord.commitment_hash !== commitment ||
        BigInt(paymentRecord.amount) !== BigInt(envelope.sourceAmount) ||
        paymentRecord.source_ft_contract !== 'wrap.near' ||
        paymentRecord.receiver_id !== envelope.depositAddress
    ) {
        fail('Finalized RELAY payment record does not match the exact authorized quote');
    }
    if (
        authorization.parent_contract_id !== context.relayContractId ||
        authorization.owner_at_authorization !== context.ownerAccountId ||
        authorization.associated_account_id !== context.associatedAccountId ||
        authorization.account_binding_verified !== true ||
        authorization.provider_signature_hash !== envelope.providerSignatureHash ||
        authorization.source_asset !== envelope.sourceAsset ||
        authorization.source_decimals !== envelope.sourceDecimals ||
        authorization.deposit_type !== request.depositType ||
        authorization.source_amount !== envelope.sourceAmount ||
        authorization.destination_asset !== envelope.destinationAsset ||
        authorization.destination_decimals !== envelope.destinationDecimals ||
        authorization.expected_output !== envelope.expectedOutput ||
        authorization.minimum_output !== envelope.minimumOutput ||
        authorization.recipient !== envelope.recipient ||
        authorization.deposit_address !== envelope.depositAddress ||
        (authorization.deposit_memo ?? null) !== envelope.depositMemo ||
        authorization.refund_address !== envelope.refundAddress ||
        authorization.refund_type !== envelope.refundType ||
        authorization.request_deadline !== quote.request_deadline ||
        authorization.provider_quote_deadline !== quote.provider_quote_deadline ||
        (authorization.provider_inactive_deadline ?? null) !==
            quote.provider_inactive_deadline ||
        authorization.nonce !== context.quoteNonce
    ) {
        fail('Finalized RELAY authorization does not match the provider-signed quote');
    }
    if (
        !['CheckoutPending', 'SourceTransferCompleted', 'RecoveryRequired'].includes(
            paymentRecord.checkout_status,
        )
    ) {
        fail('Payment record is not in a reconcilable checkout state');
    }
    if (!Number.isSafeInteger(paymentRecord.nonce) || paymentRecord.nonce < 1) {
        fail('Payment record nonce must be a positive safe integer');
    }
    const id = paymentKey(context.tokenId, String(paymentRecord.nonce), commitment);

    const sourceTransferSupported = envelope.sourceAsset === 'nep141:wrap.near';
    const sourceCallbackSucceeded =
        paymentRecord.checkout_status === 'SourceTransferCompleted' &&
        paymentRecord.token_transfer_status === 'TokenTransferCompleted';
    const sourceLimitation =
        !sourceTransferSupported
            ? 'The payment does not identify wrap.near as its NEP-141 source token.'
            : 'No finalized NEAR transaction/receipt evidence has been independently linked to this payment.';

    return {
        id,
        registeredAt: new Date().toISOString(),
        relaySnapshotBlockHash: relaySnapshot.blockHash,
        context: JSON.parse(JSON.stringify(context)),
        request: JSON.parse(JSON.stringify(request)),
        providerQuoteResponse: JSON.parse(JSON.stringify(providerQuoteResponse)),
        providerSignatureHash: providerSignatureHash(providerQuoteResponse.signature),
        authorizationArgs: JSON.parse(JSON.stringify(authorizationArgs)),
        paymentRecord: JSON.parse(JSON.stringify(paymentRecord)),
        authorization: JSON.parse(JSON.stringify(authorization)),
        sourceTransferSupported,
        sourceCallbackSucceeded,
        sourceEvidenceVerified: false,
        sourceLimitation,
        phase: !sourceTransferSupported ||
            paymentRecord.checkout_status === 'RecoveryRequired' ||
            paymentRecord.token_transfer_status === 'RecoveryRequired'
            ? 'RECOVERY_REQUIRED'
            : sourceCallbackSucceeded
              ? 'SOURCE_DEPOSIT_FINALITY_UNVERIFIED'
              : 'SOURCE_TRANSFER_SUBMITTED',
        providerPhase: null,
        providerStatusUpdatedAt: null,
        providerObservations: [],
        pollFailures: [],
        limitations: [sourceLimitation],
        conflicts: [],
        destinationVerification: {
            supported: false,
            reason: 'No configured chain-specific finality verifier is available for this destination.',
        },
        refundVerification: {
            supported: false,
            reason: 'No independently verified origin-chain refund transaction is linked to this payment.',
        },
        providerStatusAuthenticated: false,
        terminalOutcomeVerified: false,
        nftUnlockPermitted: false,
    };
}

function applyEvent(records, event) {
    if (!isObject(event) || typeof event.type !== 'string' || typeof event.paymentId !== 'string') {
        fail('Reconciliation journal contains a malformed event');
    }
    if (event.type === 'REGISTER') {
        if (!isObject(event.record) || event.record.id !== event.paymentId) {
            fail('Reconciliation journal contains a malformed registration');
        }
        const existing = records.get(event.paymentId);
        if (existing && stableStringify(existing) !== stableStringify(event.record)) {
            fail('Reconciliation journal contains conflicting payment registrations');
        }
        if (!existing) {
            if (event.record.providerPhase === undefined) event.record.providerPhase = null;
            if (event.record.providerStatusUpdatedAt === undefined) {
                event.record.providerStatusUpdatedAt = null;
            }
            records.set(event.paymentId, event.record);
        }
        return;
    }
    const record = records.get(event.paymentId);
    if (!record) fail('Reconciliation journal event references an unknown payment');
    switch (event.type) {
        case 'PROVIDER_STATUS':
            record.providerObservations.push(event.observation);
            if (!event.observation.stale) {
                record.providerPhase = event.phase;
                record.providerStatusUpdatedAt = event.observation.updatedAt;
            }
            break;
        case 'POLL_FAILURE':
            record.pollFailures.push(event.failure);
            break;
        case 'CONFLICT':
            record.conflicts.push(event.reason);
            record.phase = 'RECOVERY_REQUIRED';
            break;
        default:
            fail('Reconciliation journal contains an unknown event type');
    }
}

async function createReconciliationJournal({ filePath, now = Date.now }) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        throw new TypeError('A journal file path is required');
    }
    const absolutePath = path.resolve(filePath);
    const records = new Map();
    try {
        const contents = await fs.readFile(absolutePath, 'utf8');
        if (contents.length > 64 * 1024 * 1024) fail('Reconciliation journal exceeds 64 MiB');
        if (contents.length > 0) {
            const lines = contents.split('\n');
            if (lines[lines.length - 1] !== '') {
                fail('Reconciliation journal ends with an incomplete event');
            }
            for (const line of lines.slice(0, -1)) {
                if (line.length === 0) fail('Reconciliation journal contains an empty event');
                applyEvent(records, JSON.parse(line));
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    let queue = Promise.resolve();
    const enqueue = (work) => {
        const result = queue.then(work);
        queue = result.catch(() => {});
        return result;
    };

    async function append(event) {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        const handle = await fs.open(absolutePath, 'a');
        try {
            await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        applyEvent(records, event);
    }

    function snapshot(record) {
        return JSON.parse(JSON.stringify(record));
    }

    return Object.freeze({
        registerPayment(input) {
            return enqueue(async () => {
                const record = await validateRegistration(input);
                const existing = records.get(record.id);
                if (existing) {
                    if (
                        stableStringify({ ...existing, registeredAt: null }) !==
                        stableStringify({ ...record, registeredAt: null })
                    ) {
                        await append({
                            type: 'CONFLICT',
                            paymentId: record.id,
                            reason: 'A different payment record attempted to reuse this token, nonce, and commitment.',
                        });
                        return snapshot(records.get(record.id));
                    }
                    return snapshot(existing);
                }
                record.registeredAt = new Date(now()).toISOString();
                await append({ type: 'REGISTER', paymentId: record.id, record });
                return snapshot(record);
            });
        },

        observeProviderStatus(paymentId, response) {
            return enqueue(async () => {
                const record = records.get(paymentId);
                if (!record) fail('Payment is not registered for reconciliation');
                let serialized;
                try {
                    serialized = validateStatusResponse(response);
                    const signedAt = Date.parse(record.providerQuoteResponse.timestamp);
                    const { envelope } = verifyQuoteResponse({
                        request: record.request,
                        context: record.context,
                        providerResponse: response.quoteResponse,
                        now: signedAt,
                    });
                    if (
                        providerSignatureHash(response.quoteResponse.signature) !==
                            record.providerSignatureHash ||
                        envelope.providerQuoteHash !==
                            verifyQuoteResponse({
                                request: record.request,
                                context: record.context,
                                providerResponse: record.providerQuoteResponse,
                                now: signedAt,
                            }).envelope.providerQuoteHash ||
                        stableStringify(response.quoteResponse) !==
                            stableStringify(record.providerQuoteResponse)
                    ) {
                        fail('Provider status response refers to a different or altered quote');
                    }
                } catch (error) {
                    await append({
                        type: 'CONFLICT',
                        paymentId,
                        reason: `Unverifiable or mismatched provider status evidence: ${error.message}`,
                    });
                    throw error;
                }

                const fingerprint = sha256(serialized);
                if (
                    record.providerObservations.some(
                        (observation) => observation.fingerprint === fingerprint,
                    )
                ) {
                    return snapshot(record);
                }
                const observedPhase = classifyProviderObservation(response.status);
                const observedAtMs = Date.parse(response.updatedAt);
                const previousUpdatedAtMs = record.providerStatusUpdatedAt === null
                    ? null
                    : Date.parse(record.providerStatusUpdatedAt);
                const stale =
                    previousUpdatedAtMs !== null &&
                    observedAtMs < previousUpdatedAtMs;
                const previousTerminal = [...record.providerObservations]
                    .reverse()
                    .find((observation) => TERMINAL_PROVIDER_STATUSES.has(observation.status));
                if (
                    previousTerminal &&
                    previousTerminal.status !== response.status &&
                    (!stale || TERMINAL_PROVIDER_STATUSES.has(response.status))
                ) {
                    await append({
                        type: 'CONFLICT',
                        paymentId,
                        reason: `Provider terminal status changed from ${previousTerminal.status} to ${response.status}.`,
                    });
                    return snapshot(records.get(paymentId));
                }
                const observation = {
                    observedAt: new Date(now()).toISOString(),
                    status: response.status,
                    updatedAt: response.updatedAt,
                    phase: observedPhase,
                    stale,
                    correlationId: response.correlationId,
                    statusResponseAuthenticated: false,
                    fingerprint,
                    response: JSON.parse(serialized),
                };
                await append({
                    type: 'PROVIDER_STATUS',
                    paymentId,
                    observation,
                    phase: observedPhase,
                });
                return snapshot(records.get(paymentId));
            });
        },

        recordPollFailure(paymentId, error) {
            return enqueue(async () => {
                if (!records.has(paymentId)) fail('Payment is not registered for reconciliation');
                const failure = {
                    observedAt: new Date(now()).toISOString(),
                    name: String(error && error.name ? error.name : 'Error'),
                    message: String(error && error.message ? error.message : error),
                    httpStatus: Number.isInteger(error && error.status) ? error.status : null,
                };
                await append({ type: 'POLL_FAILURE', paymentId, failure });
                return snapshot(records.get(paymentId));
            });
        },

        getPayment(paymentId) {
            const record = records.get(paymentId);
            return record ? snapshot(record) : null;
        },

        listUnresolvedPayments() {
            return [...records.values()].map(snapshot);
        },
    });
}

async function fetchOneClickStatus({
    depositAddress,
    depositMemo,
    apiKey,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10000,
}) {
    if (typeof depositAddress !== 'string' || depositAddress.length === 0) {
        throw new TypeError('A deposit address is required to query 1Click status');
    }
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
        throw new TypeError('A 1Click API key is required to query status');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('No fetch implementation is available');
    const url = new URL(STATUS_URL);
    url.searchParams.set('depositAddress', depositAddress);
    if (depositMemo !== undefined && depositMemo !== null) {
        url.searchParams.set('depositMemo', depositMemo);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let response;
        try {
            response = await fetchImpl(url, {
                method: 'GET',
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: controller.signal,
            });
        } catch (error) {
            error.transient = true;
            throw error;
        }
        if (response.status === 429 || response.status >= 500 || response.status === 408) {
            const error = new Error(`1Click status endpoint returned transient HTTP ${response.status}`);
            error.status = response.status;
            error.transient = true;
            throw error;
        }
        if (!response.ok) {
            const error = new Error(`1Click status endpoint returned HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function pollPaymentStatus({
    journal,
    paymentId,
    fetchStatus,
    maxAttempts = 3,
    initialDelayMs = 250,
    maxDelayMs = 2000,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
    if (!journal || typeof journal.observeProviderStatus !== 'function') {
        throw new TypeError('A reconciliation journal is required');
    }
    if (typeof fetchStatus !== 'function') throw new TypeError('A status fetcher is required');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
        throw new TypeError('maxAttempts must be between 1 and 5');
    }
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            const response = await fetchStatus();
            return await journal.observeProviderStatus(paymentId, response);
        } catch (error) {
            lastError = error;
            const transient = error && (error.transient === true || TRANSIENT_HTTP_STATUSES.has(error.status));
            if (!transient || attempt + 1 === maxAttempts) break;
            await delay(Math.min(initialDelayMs * 2 ** attempt, maxDelayMs));
        }
    }
    await journal.recordPollFailure(paymentId, lastError);
    throw lastError;
}

module.exports = {
    classifyProviderObservation,
    createReconciliationJournal,
    fetchOneClickStatus,
    paymentKey,
    pollPaymentStatus,
};
