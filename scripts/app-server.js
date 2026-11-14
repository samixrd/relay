'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { createConfig, loadEnvFile, publicConfig } = require('./app-config');
const {
    createClaimSession,
    deriveOwnerApprovalToken,
    hashRecipientEmail,
    markSessionClaimed,
    normalizeRecipientEmail,
    timingSafeHexEqual,
    verifyClaimSession,
} = require('./claim-session');
const { createActivityJournal } = require('./activity-journal');
const { createUploadStore, resolveUploadFile } = require('./upload-store');
const { verifyFundingTransaction, formatYoctoNear } = require('./funding-verifier');
const {
    createClaimJournal,
    CLAIM_STATES,
} = require('./claim-journal');
const {
    ChallengeStore,
    OAuthTransactionStore,
    ServerSessionStore,
    createGoogleAuthUrl,
    createSessionCookiePayload,
    defaultChallengeStore,
    defaultOAuthTransactionStore,
    defaultServerSessionStore,
    exchangeAuthorizationCode,
    parseCookies,
    serializeCookie,
    serializeNep413Payload,
    validateAuthConfig,
    validateNearAccountId,
    validateRecipientAccountResolution,
    verifyGoogleIdToken,
    verifyNep413Signature,
    verifyOAuthStateToken,
    verifySessionCookiePayload,
} = require('./auth-provider-adapter');
const {
    PaymentAuthorizationError,
    NEAR_PAYMENT_STATES,
    prepareNearPayment,
    verifyNearPaymentTransaction,
    buildPaymentReviewSummary,
    createPaymentIntentStore,
    getNearPaymentIntent,
    formatNear,
} = require('./near-testnet-payment-authorizer');
const { createJwksCache } = require('./near-auth-identity');
const { createNearAuthApi } = require('./near-auth-api');
const { createWalletAuth } = require('./wallet-auth');
const { createAccountLinkStore } = require('./account-links');
const { createStockFaucet } = require('./stock-assets');

const ROOT = path.resolve(__dirname, '..');
const WEB_ROOT = path.join(ROOT, 'web');
const MIME_TYPES = Object.freeze({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/svg+xml',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
});
const MAX_BODY_BYTES = 16 * 1024;
const COMPRESSIBLE_EXTENSIONS = new Set(['.css', '.html', '.js', '.svg']);
const gzipCache = new Map();

async function compressedStaticContent(filePath, content) {
    let mtimeMs = 0;
    try {
        ({ mtimeMs } = await fs.promises.stat(filePath));
    } catch { /* keep serving without a cached copy */ }
    const cached = gzipCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.length === content.length) return cached.body;
    const body = zlib.gzipSync(content);
    gzipCache.set(filePath, { mtimeMs, length: content.length, body });
    return body;
}
const TOKEN_ID_RE = /^[a-z0-9_-]{1,32}$/;
const ACCOUNT_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function jsonResponse(response, status, value, headers = {}) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...headers,
    });
    response.end(body);
}

/**
 * Serializes an associatedAccount object from verifyOwnershipAndState so all
 * BigInt fields are converted to strings before JSON.stringify. The `spendable`
 * field is kept as a BigInt internally for arithmetic but must be a string in
 * HTTP responses.
 */
function serializeAssociatedAccount(acc) {
    if (!acc) return acc;
    const result = {};
    for (const [k, v] of Object.entries(acc)) {
        result[k] = typeof v === 'bigint' ? v.toString() : v;
    }
    return result;
}

function localAuthority(value, allowedHost = null) {
    if (typeof value !== 'string' || value.length > 255) return null;
    try {
        const url = new URL(value.includes('://') ? value : `http://${value}`);
        const hostname = url.hostname.toLowerCase();
        if (
            ['127.0.0.1', 'localhost', '0.0.0.0'].includes(hostname) ||
            (allowedHost && hostname === allowedHost) ||
            (process.env.RENDER && hostname.endsWith('.onrender.com'))
        ) {
            return { hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
        }
        return null;
    } catch {
        return null;
    }
}

function normalizeLocalReturnTo(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || value.length > 512) return false;
    if (!value.startsWith('/') || value.startsWith('//')) return false;
    if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return false;
    if (value.startsWith('/api/') || value.startsWith('/uploads/')) return false;
    try {
        const parsed = new URL(value, 'http://localhost');
        if (parsed.origin !== 'http://localhost') return false;
        return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
    } catch {
        return false;
    }
}

function isAllowedLocalRequest(request, listeningPort, config = null) {
    let allowedHost = null;
    const publicUrl = config?.app?.publicAppUrl || process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL;
    if (publicUrl) {
        try {
            allowedHost = new URL(publicUrl).hostname.toLowerCase();
        } catch {}
    }
    const host = localAuthority(request.headers.host, allowedHost);
    if (!host) return false;
    const isLocal = ['127.0.0.1', 'localhost', '0.0.0.0'].includes(host.hostname);
    if (isLocal && listeningPort && host.port !== listeningPort && host.port !== 80 && host.port !== 443) {
        return false;
    }
    const originHeader = request.headers.origin;
    if (originHeader === undefined) return true;
    try {
        const origin = new URL(originHeader);
        const originAuthority = localAuthority(origin.host, allowedHost);
        if (!originAuthority) return false;
        if (origin.pathname !== '/' || origin.search || origin.hash) return false;
        if (originAuthority.hostname !== host.hostname) return false;
        return true;
    } catch {
        return false;
    }
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
        throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415 });
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > maxBytes) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
        chunks.push(chunk);
    }
    if (length === 0) throw Object.assign(new Error('Request body must be a JSON object.'), { status: 400 });
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError();
        return parsed;
    } catch {
        throw Object.assign(new Error('Request body must be a JSON object.'), { status: 400 });
    }
}

function validateAccountId(value) {
    return typeof value === 'string' && value.length <= 64 && ACCOUNT_ID_RE.test(value);
}

async function readBinaryBody(request, maxBytes) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > maxBytes) throw Object.assign(new Error('Request body is too large.'), { status: 413, code: 'IMAGE_TOO_LARGE' });
        chunks.push(chunk);
    }
    if (length === 0) throw Object.assign(new Error('Request body is empty.'), { status: 400, code: 'EMPTY_IMAGE' });
    return Buffer.concat(chunks);
}

function rpcCall(rpcUrl, method, params, timeoutMs = 10000, fetchImpl = globalThis.fetch) {
    const attempt = (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        return fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'relay-app', method, params }),
            signal: controller.signal,
        }).then(async (response) => {
            if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
            const body = await response.json();
            if (body.error) throw new Error(body.error.message || 'RPC request failed');
            return body.result;
        }).finally(() => clearTimeout(timer));
    };

    return attempt(rpcUrl).catch(async (error) => {
        const message = String(error?.message || error);
        const fallbackUrl = process.env.RELAY_TEST_RPC_URL || 'https://test.rpc.fastnear.com';
        // The legacy public Testnet RPC intermittently answers with a
        // deprecation notice or a 429. Those are endpoint problems, not chain
        // problems, so retry the same read against a working Testnet RPC.
        if (
            fallbackUrl !== rpcUrl &&
            /deprecated|-429|rate limit|too many requests|HTTP 429/i.test(message)
        ) {
            return attempt(fallbackUrl);
        }
        throw error;
    });
}

async function verifyNearNetwork(config, fetchImpl) {
    const result = await rpcCall(config.near.rpcUrl, 'status', [], 5000, fetchImpl);
    if (result.chain_id !== config.near.network) {
        throw Object.assign(
            new Error(`Configured NEAR RPC reports ${result.chain_id || 'an unknown chain'}; expected ${config.near.network}.`),
            { status: 503 },
        );
    }
    return result;
}

async function finalNearBlock(config, fetchImpl) {
    await verifyNearNetwork(config, fetchImpl);
    return rpcCall(config.near.rpcUrl, 'block', { finality: 'final' }, 10000, fetchImpl);
}

async function nearView(rpcUrl, contractId, blockHash, method, args, fetchImpl) {
    const result = await rpcCall(
        rpcUrl,
        'query',
        {
            request_type: 'call_function',
            account_id: contractId,
            method_name: method,
            args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
            block_id: blockHash,
        },
        10000,
        fetchImpl,
    );
    if (!Array.isArray(result.result)) throw new Error(`NEAR view ${method} returned invalid bytes`);
    return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

function networkStatus(config, fetchImpl) {
    const check = async (label, run) => {
        try {
            return { label, status: 'available', detail: await run() };
        } catch (error) {
            return { label, status: 'unavailable', error: 'Configured endpoint did not pass its read-only check.' };
        }
    };
    const near = check('NEAR RPC', async () => {
        const result = await verifyNearNetwork(config, fetchImpl);
        return `Read-only RPC confirmed ${result.chain_id}`;
    });
    return Promise.all([near]);
}

function formatAccount(accountId, account, binding, nft, locked, credits, payment, authorization, blockHash, config) {
    const base = config.near.explorerBaseUrl;
    return {
        network: config.near.network,
        contractId: config.near.relayContractId,
        blockHash,
        token: {
            id: accountId,
            ownerId: nft.owner_id,
            metadata: nft.metadata || null,
        },
        associatedAccount: {
            accountId: binding.account_id,
            isVerified: binding.is_verified === true,
            provisioningStatus: binding.is_verified === true ? 'Verified' : 'Not verified',
            nearBalanceYocto: account.amount,
            lockedBalanceYocto: account.locked,
            storageUsage: account.storage_usage,
            explorerUrl: `${base}/account/${encodeURIComponent(binding.account_id)}`,
        },
        locked: locked === true,
        credits,
        payment,
        quoteAuthorization: authorization,
        explorer: {
            token: `${base}/nft-token/${encodeURIComponent(config.near.relayContractId)}/${encodeURIComponent(accountId)}`,
            owner: `${base}/account/${encodeURIComponent(nft.owner_id)}`,
            contract: `${base}/account/${encodeURIComponent(config.near.relayContractId)}`,
        },
        assetInventory: {
            near: 'verified-from-near-rpc',
            fungibleTokens: 'available-via-near-assets-endpoint',
            childNfts: 'unavailable-no-cross-contract-inventory-index',
        },
    };
}

async function verifyFinalizedTransferTransaction({
    nearRpcUrl,
    relayContractId,
    transactionHash,
    expectedSigner,
    expectedTokenId,
    expectedReceiver,
    fetchImpl = globalThis.fetch,
}) {
    if (!transactionHash || typeof transactionHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{40,55}$/.test(transactionHash)) {
        const err = new Error('Invalid NEAR transaction hash format.');
        err.code = 'INVALID_TRANSACTION_HASH';
        throw err;
    }

    let txResponse;
    try {
        const payload = {
            jsonrpc: '2.0',
            id: 'tx_status',
            method: 'tx',
            params: [transactionHash, expectedSigner],
        };
        const res = await fetchImpl(nearRpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const err = new Error(`RPC HTTP error querying transaction: ${res.status}`);
            err.code = 'RPC_ERROR';
            throw err;
        }
        txResponse = await res.json();
    } catch (err) {
        if (err.code === 'RPC_ERROR') throw err;
        return {
            status: 'PENDING_OR_TIMEOUT',
            finalized: false,
            message: `Transaction lookup timed out or failed: ${err.message}`,
        };
    }

    if (txResponse.error) {
        return {
            status: 'PENDING',
            finalized: false,
            message: `Transaction not found or still processing on NEAR Testnet: ${txResponse.error.message || JSON.stringify(txResponse.error)}`,
        };
    }

    const txResult = txResponse.result;
    if (!txResult || !txResult.transaction) {
        return {
            status: 'PENDING',
            finalized: false,
            message: 'Transaction details not yet available on RPC.',
        };
    }

    const transaction = txResult.transaction;

    // Verify signer
    if (transaction.signer_id !== expectedSigner) {
        const err = new Error(`Transaction signer '${transaction.signer_id}' does not match expected creator '${expectedSigner}'.`);
        err.code = 'SIGNER_MISMATCH';
        throw err;
    }

    // Verify contract receiver
    if (transaction.receiver_id !== relayContractId) {
        const err = new Error(`Transaction receiver '${transaction.receiver_id}' does not match RELAY contract '${relayContractId}'.`);
        err.code = 'CONTRACT_MISMATCH';
        throw err;
    }

    // Inspect function call action — exactly 1 expected nft_transfer action, no bundled/unexpected actions
    const actions = transaction.actions || [];
    if (actions.length !== 1) {
        const err = new Error(`Transaction contains ${actions.length} action(s); expected exactly 1 'nft_transfer' FunctionCall action.`);
        err.code = 'ACTION_MISMATCH';
        throw err;
    }
    const action = actions[0];
    if (!action || !action.FunctionCall) {
        const err = new Error('Transaction action is not a FunctionCall action.');
        err.code = 'ACTION_MISMATCH';
        throw err;
    }
    const fc = action.FunctionCall;
    if (fc.method_name !== 'nft_transfer') {
        const err = new Error(`Transaction method '${fc.method_name}' is not 'nft_transfer'.`);
        err.code = 'METHOD_MISMATCH';
        throw err;
    }

    // Decode arguments
    let decodedArgs;
    try {
        const rawArgs = Buffer.from(fc.args, 'base64').toString('utf8');
        decodedArgs = JSON.parse(rawArgs);
    } catch {
        const err = new Error('Unable to decode nft_transfer arguments.');
        err.code = 'ARGS_DECODE_FAILED';
        throw err;
    }

    if (decodedArgs.token_id !== expectedTokenId) {
        const err = new Error(`Transaction token_id '${decodedArgs.token_id}' does not match claim token '${expectedTokenId}'.`);
        err.code = 'TOKEN_MISMATCH';
        throw err;
    }

    if (decodedArgs.receiver_id !== expectedReceiver) {
        const err = new Error(`Transaction receiver_id '${decodedArgs.receiver_id}' does not match verified recipient '${expectedReceiver}'.`);
        err.code = 'RECIPIENT_MISMATCH';
        throw err;
    }

    if (fc.deposit !== '1') {
        const err = new Error(`Transaction attached deposit is '${fc.deposit}', expected exactly 1 yoctoNEAR.`);
        err.code = 'DEPOSIT_MISMATCH';
        throw err;
    }

    // Verify gas policy: exactly 30 TGas = '30000000000000' (30 × 10^12 gas units).
    // Any other gas limit is rejected; a different limit indicates the transaction was
    // not built by the RELAY claim flow.
    const EXPECTED_GAS = '30000000000000';
    if (!fc.gas || String(fc.gas) !== EXPECTED_GAS) {
        const err = new Error(`Transaction gas '${fc.gas}' does not match the required RELAY 30 TGas policy ('${EXPECTED_GAS}').`);
        err.code = 'GAS_MISMATCH';
        throw err;
    }

    // Inspect receipts outcome for errors
    const receiptsOutcome = txResult.receipts_outcome || [];
    const hasFailure = receiptsOutcome.some((ro) => ro.outcome?.status?.Failure !== undefined);
    if (hasFailure) {
        const err = new Error('Transaction receipt execution encountered an on-chain failure.');
        err.code = 'RECEIPT_EXECUTION_FAILED';
        throw err;
    }

    const finalStatus = txResult.final_execution_status;
    const isSuccess = finalStatus === 'FINAL' || (txResult.status && txResult.status.SuccessValue !== undefined);
    if (!isSuccess) {
        return {
            status: 'AWAITING_FINALITY',
            finalized: false,
            message: `Transaction outcome is '${finalStatus || 'UNKNOWN'}'; waiting for finality.`,
        };
    }

    return {
        status: 'SUCCESS',
        finalized: true,
        transaction,
        txResult,
    };
}

async function readCardBundle({ config, tokenId, fetchImpl, block = null }) {
    const finalized = block || await finalNearBlock(config, fetchImpl);
    const blockHash = finalized.header.hash;
    const token = await nearView(
        config.near.rpcUrl,
        config.near.relayContractId,
        blockHash,
        'nft_token',
        { token_id: tokenId },
        fetchImpl,
    );
    if (!token) return null;

    const [binding, locked, credits, payment, lifecycle, provisioning] = await Promise.all([
        nearView(config.near.rpcUrl, config.near.relayContractId, blockHash, 'relay_account_binding', { token_id: tokenId }, fetchImpl),
        nearView(config.near.rpcUrl, config.near.relayContractId, blockHash, 'is_token_locked', { token_id: tokenId }, fetchImpl).catch(() => null),
        nearView(config.near.rpcUrl, config.near.relayContractId, blockHash, 'relay_credits', { token_id: tokenId }, fetchImpl).catch(() => null),
        nearView(config.near.rpcUrl, config.near.relayContractId, blockHash, 'relay_payment', { token_id: tokenId }, fetchImpl).catch(() => null),
        nearView(config.near.rpcUrl, config.near.relayContractId, blockHash, 'token_lifecycle', { token_id: tokenId }, fetchImpl).catch(() => 'Unlocked'),
        nearView(config.near.rpcUrl, config.near.relayContractId, blockHash, 'relay_provisioning_state', { token_id: tokenId }, fetchImpl).catch(() => null),
    ]);

    const associatedAccountId = binding?.account_id || null;
    let associatedAccount = null;
    if (associatedAccountId) {
        associatedAccount = await rpcCall(config.near.rpcUrl, 'query', {
            request_type: 'view_account',
            account_id: associatedAccountId,
            block_id: blockHash,
        }, 10000, fetchImpl).catch(() => null);
    }
    const balanceYocto = associatedAccount?.amount ? BigInt(associatedAccount.amount) : 0n;
    const lockedYocto = associatedAccount?.locked ? BigInt(associatedAccount.locked) : 0n;
    // Match the payment authorizer's conservative storage reserve used for display only.
    const storageReserveYocto = BigInt(associatedAccount?.storage_usage || 0) * 10000000000000000000n + 100000000000000000000000n;
    const spendableYocto = balanceYocto > lockedYocto + storageReserveYocto
        ? balanceYocto - lockedYocto - storageReserveYocto
        : 0n;
    return {
        network: config.near.network,
        contractId: config.near.relayContractId,
        blockHash,
        token: {
            id: tokenId,
            ownerId: token.owner_id,
            metadata: token.metadata || null,
        },
        binding: binding ? {
            accountId: binding.account_id,
            isVerified: binding.is_verified === true,
        } : null,
        lifecycle: lifecycle || 'Unlocked',
        provisioning,
        locked: locked === true,
        credits,
        payment,
        associatedAccount: associatedAccountId ? {
            accountId: associatedAccountId,
            exists: Boolean(associatedAccount),
            balanceYocto: balanceYocto.toString(),
            balanceNear: formatYoctoNear(balanceYocto.toString()),
            lockedYocto: lockedYocto.toString(),
            storageUsage: associatedAccount?.storage_usage || 0,
            spendableYocto: spendableYocto.toString(),
            spendableNear: formatYoctoNear(spendableYocto.toString()),
            reserveIsDisplayEstimate: true,
            explorerUrl: `${config.near.explorerBaseUrl}/account/${encodeURIComponent(associatedAccountId)}`,
        } : null,
        explorer: {
            token: `${config.near.explorerBaseUrl}/nft-token/${encodeURIComponent(config.near.relayContractId)}/${encodeURIComponent(tokenId)}`,
            owner: `${config.near.explorerBaseUrl}/account/${encodeURIComponent(token.owner_id)}`,
            contract: `${config.near.explorerBaseUrl}/account/${encodeURIComponent(config.near.relayContractId)}`,
        },
    };
}

async function listCardBundles({ config, fetchImpl, limit = 24 }) {
    const block = await finalNearBlock(config, fetchImpl);
    const tokens = await nearView(
        config.near.rpcUrl,
        config.near.relayContractId,
        block.header.hash,
        'nft_tokens',
        { from_index: '0', limit },
        fetchImpl,
    );
    if (!Array.isArray(tokens)) return { blockHash: block.header.hash, cards: [] };
    const settled = await Promise.allSettled(
        tokens.map((token) => readCardBundle({
            config,
            tokenId: token.token_id,
            fetchImpl,
            block,
        })),
    );
    const cards = settled
        .map((result) => (result.status === 'fulfilled' ? result.value : null))
        .filter(Boolean);
    return { blockHash: block.header.hash, cards };
}

function resolveSessionUser(request, sessionStore, envSource) {
    const secret = envSource.CLAIM_SESSION_SECRET || 'relay-default-auth-secret';
    const cookies = parseCookies(request.headers.cookie);
    if (cookies.relay_auth_session) {
        const serverSession = sessionStore.getSession(cookies.relay_auth_session);
        if (serverSession) {
            return {
                sub: serverSession.sub,
                email: serverSession.email || null,
                emailVerified: serverSession.emailVerified === true,
                name: serverSession.name || null,
            };
        }
        const verifiedPayload = verifySessionCookiePayload(cookies.relay_auth_session, secret);
        if (verifiedPayload) {
            return {
                sub: verifiedPayload.sub,
                email: verifiedPayload.email || null,
                emailVerified: verifiedPayload.emailVerified === true,
                name: verifiedPayload.name || null,
            };
        }
    }
    if (cookies.relay_auth_payload) {
        const verifiedPayload = verifySessionCookiePayload(cookies.relay_auth_payload, secret);
        if (verifiedPayload) {
            return {
                sub: verifiedPayload.sub,
                email: verifiedPayload.email || null,
                emailVerified: verifiedPayload.emailVerified === true,
                name: verifiedPayload.name || null,
            };
        }
    }
    return null;
}

function maskEmail(email) {
    if (typeof email !== 'string' || !email.includes('@')) return null;
    const [local, domain] = email.split('@');
    const visible = local.slice(0, 1);
    return `${visible}${'*'.repeat(Math.max(2, Math.min(8, local.length - 1)))}@${domain}`;
}

function sameEmail(a, b) {
    return typeof a === 'string' && typeof b === 'string' &&
        a.trim().toLowerCase() === b.trim().toLowerCase();
}

function parseNearAmountToYocto(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,23})(?:\.\d{1,24})?$/.test(value)) {
        return null;
    }
    const [whole, fraction = ''] = value.split('.');
    const yocto = BigInt(whole + fraction.padEnd(24, '0'));
    return yocto > 0n ? yocto.toString() : null;
}

function publicJournalEntry(entry) {
    if (!entry) return null;
    return {
        sessionId: entry.sessionId,
        tokenId: entry.tokenId,
        expectedOwner: entry.expectedOwner,
        intendedRecipient: entry.intendedRecipient || null,
        intendedRecipientEmailMasked: maskEmail(entry.intendedRecipientEmail),
        state: entry.state,
        creatorApproved: Boolean(entry.creatorApproved),
        approvedRecipient: entry.approvedRecipient || null,
        linkedNearAccountId: entry.linkedNearAccountId || null,
        transactionHash: entry.transactionHash || null,
        finalizedOwner: entry.finalizedOwner || null,
        createdAt: entry.createdAt || null,
        expiresAt: entry.expiresAt || null,
        requiresEmailAuth: Boolean(entry.intendedRecipientEmail),
        emailDelivery: entry.intendedRecipientEmail ? 'not-implemented' : null,
    };
}

function createAppServer({
    config = createConfig(),
    fetchImpl = globalThis.fetch,
    journal = null,
    oauthStore = null,
    sessionStore = null,
    challengeStore = null,
    activityJournal = null,
    uploadStore = null,
    nearAuthRelayer = null,
} = {}) {
    const oauthTransactionStore = oauthStore || new OAuthTransactionStore();
    const serverSessionStore = sessionStore || new ServerSessionStore();
    const userChallengeStore = challengeStore || new ChallengeStore();
    const consumedTransactionHashes = new Set();
    const nearPaymentIntents = createPaymentIntentStore();
    const accountLinks = createAccountLinkStore({
        filePath: path.join(ROOT, 'data', 'account-links.json'),
    });
    const envSource = config.rawEnv || process.env;
    const stockFaucet = createStockFaucet({
        rpcUrl: config.near.rpcUrl,
        treasuryAccountId: envSource.STOCK_FAUCET_ACCOUNT_ID || envSource.NEAR_ACCOUNT_ID || null,
        treasuryPrivateKey: envSource.STOCK_FAUCET_PRIVATE_KEY || envSource.NEAR_PRIVATE_KEY || null,
        filePath: path.join(ROOT, 'data', 'stock-claims.json'),
    });
    let journalPromise = journal ? Promise.resolve(journal) : null;
    function getJournal() {
        if (!journalPromise) {
            journalPromise = createClaimJournal({ filePath: path.join(ROOT, 'data', 'claim-sessions.journal') });
        }
        return journalPromise;
    }
    let activityJournalPromise = activityJournal ? Promise.resolve(activityJournal) : null;
    function getActivityJournal() {
        if (!activityJournalPromise) {
            activityJournalPromise = createActivityJournal({ filePath: path.join(ROOT, 'data', 'activity.journal') });
        }
        return activityJournalPromise;
    }
    const imageUploads = uploadStore || createUploadStore({
        directory: path.join(ROOT, 'data', 'uploads'),
        publicAppUrl: config.app.publicAppUrl,
        env: config.rawEnv || process.env,
    });
    const nearAuthJwks = createJwksCache({ fetchImpl });
    const nearAuthApi = createNearAuthApi({
        config,
        envSource: config.rawEnv || process.env,
        sessionStore: serverSessionStore,
        fetchImpl,
        jwks: nearAuthJwks,
        publicAppUrl: config.app.publicAppUrl,
        relayer: nearAuthRelayer,
        links: accountLinks,
        faucet: stockFaucet,
        journal: {
            record: async (entry) => (await getActivityJournal()).record(entry),
        },
    });
    const walletAuth = createWalletAuth({
        config,
        envSource: config.rawEnv || process.env,
        sessionStore: serverSessionStore,
        fetchImpl,
        publicAppUrl: config.app.publicAppUrl,
        accountLinks,
        faucet: stockFaucet,
    });
    const server = http.createServer(async (request, response) => {
        response.setHeader('x-content-type-options', 'nosniff');
        response.setHeader('x-frame-options', 'DENY');
        response.setHeader('referrer-policy', 'no-referrer');
        response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
        if (!isAllowedLocalRequest(request, server.address()?.port, config)) {
            return jsonResponse(response, 403, { error: 'Request must use the local app origin.' });
        }
        let url;
        try {
            url = new URL(request.url, 'http://localhost');
        } catch {
            return jsonResponse(response, 400, { error: 'Invalid request path.' });
        }
        const envSource = config.rawEnv || process.env;
        try {
            if (await walletAuth.handle(request, response, url)) return;
            if (await nearAuthApi.handle(request, response, url)) return;
            if (request.method === 'GET' && url.pathname === '/api/config') {
                return jsonResponse(response, 200, publicConfig(config));
            }
            if (request.method === 'GET' && url.pathname === '/api/status') {
                const rpcChecks = await networkStatus(config, fetchImpl);
                let contractStatus = { status: 'unconfigured', detail: 'Set RELAY_CONTRACT_ID to enable contract reads.' };
                if (config.near.relayContractId) {
                    try {
                        const block = await finalNearBlock(config, fetchImpl);
                        const total = await nearView(
                            config.near.rpcUrl,
                            config.near.relayContractId,
                            block.header.hash,
                            'nft_total_supply',
                            {},
                            fetchImpl,
                        );
                        const totalSupply = typeof total === 'string' || typeof total === 'number'
                            ? total
                            : 'unknown';
                        contractStatus = {
                            status: 'available',
                            detail: `RELAY contract responded at finalized block ${block.header.height}; supply ${totalSupply}.`,
                        };
                    } catch (error) {
                        contractStatus = {
                            status: 'unavailable',
                            error: 'RELAY contract read failed at the finalized block.',
                        };
                    }
                }
                return jsonResponse(response, 200, {
                    network: config.near.network,
                    rpcChecks,
                    contract: contractStatus,
                    nearAuth: {
                        status: 'google-auth0-mpc-ed25519',
                        detail: 'Google sign-in through NEAR Auth; RELAY sponsors gas but never signs user transactions.',
                    },
                });
            }
            if (request.method === 'GET' && url.pathname === '/api/cards') {
                if (!config.near.relayContractId) return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });
                const rawLimit = Number(url.searchParams.get('limit') || 24);
                const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 24)) : 24;
                const result = await listCardBundles({ config, fetchImpl, limit });
                return jsonResponse(response, 200, {
                    network: config.near.network,
                    contractId: config.near.relayContractId,
                    blockHash: result.blockHash,
                    count: result.cards.length,
                    cards: result.cards,
                });
            }
            if (request.method === 'GET' && url.pathname === '/api/me/cards') {
                const user = resolveSessionUser(request, serverSessionStore, envSource);
                if (!user) {
                    return jsonResponse(response, 200, {
                        authenticated: false,
                        emailVerified: false,
                        cards: [],
                        invitations: [],
                        note: 'Sign in with Google to resolve invitations bound to your verified email. Google identity is never treated as wallet ownership.',
                    });
                }
                if (!user.email || user.emailVerified !== true) {
                    return jsonResponse(response, 200, {
                        authenticated: true,
                        emailVerified: false,
                        user: { email: user.email || null, name: user.name || null },
                        cards: [],
                        invitations: [],
                        note: 'A verified Google email is required to resolve email-bound invitations. Wallet ownership is still checked on chain.',
                    });
                }
                const journalInstance = await getJournal();
                const matching = journalInstance.getAllSessions()
                    .filter((entry) => sameEmail(entry.intendedRecipientEmail, user.email));
                const invitations = matching.map(publicJournalEntry).sort((a, b) =>
                    String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
                const linkedAccounts = [...new Set(matching
                    .filter((entry) => entry.linkedNearAccountId)
                    .map((entry) => entry.linkedNearAccountId))];
                const cardResults = [];
                for (const accountId of linkedAccounts) {
                    if (!config.near.relayContractId) break;
                    try {
                        const block = await finalNearBlock(config, fetchImpl);
                        const tokens = await nearView(
                            config.near.rpcUrl,
                            config.near.relayContractId,
                            block.header.hash,
                            'nft_tokens_for_owner',
                            { account_id: accountId, from_index: '0', limit: 24 },
                            fetchImpl,
                        );
                        for (const token of Array.isArray(tokens) ? tokens : []) {
                            const bundle = await readCardBundle({ config, tokenId: token.token_id, fetchImpl, block });
                            // Chain ownership must still match the linked NEAR account.
                            if (bundle && bundle.token.ownerId === accountId) {
                                cardResults.push({
                                    ...bundle,
                                    resolvedBy: {
                                        method: 'verified-google-email+finalized-chain-ownership',
                                        email: user.email,
                                        linkedNearAccountId: accountId,
                                    },
                                });
                            }
                        }
                    } catch {
                        // A missing or unreadable linked account cannot yield cards.
                    }
                }
                const uniqueCards = [...new Map(cardResults.map((card) => [card.token.id, card])).values()];
                return jsonResponse(response, 200, {
                    authenticated: true,
                    emailVerified: true,
                    user: { email: user.email, name: user.name || null },
                    cards: uniqueCards,
                    invitations,
                    note: 'These cards were resolved from your verified Google email, then checked against current finalized NFT ownership. Google identity never authorizes a transaction.',
                });
            }
            if (request.method === 'GET' && url.pathname === '/api/activity') {
                const tokenFilter = url.searchParams.get('tokenId');
                if (tokenFilter && !TOKEN_ID_RE.test(tokenFilter)) {
                    return jsonResponse(response, 400, { error: 'Invalid RELAY token ID.' });
                }
                const rawLimit = Number(url.searchParams.get('limit') || 100);
                const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 200)) : 100;
                const events = [];
                const journalInstance = await getJournal();
                for (const entry of journalInstance.getAllSessions()) {
                    if (tokenFilter && entry.tokenId !== tokenFilter) continue;
                    for (const item of entry.history || []) {
                        events.push({
                            id: `claim:${entry.sessionId}:${item.timestamp}:${item.type}`,
                            source: 'claim-journal',
                            type: `claim.${String(item.type).toLowerCase()}`,
                            timestamp: item.timestamp,
                            tokenId: entry.tokenId,
                            contractId: config.near.relayContractId,
                            sessionId: entry.sessionId,
                            status: entry.state,
                            transactionHash: item.transactionHash || null,
                            note: item.type === 'TRANSFER_FINALIZED'
                                ? `Finalized on-chain owner ${item.finalizedOwner || entry.finalizedOwner || ''}`.trim()
                                : null,
                        });
                    }
                }
                const activityInstance = await getActivityJournal();
                for (const event of await activityInstance.list(500)) {
                    if (tokenFilter && event.tokenId !== tokenFilter) continue;
                    events.push({ ...event, source: 'server-activity-journal' });
                }
                try {
                    const payment = JSON.parse(await fs.promises.readFile(path.join(ROOT, 'data', 'task46-live-payment.json'), 'utf8'));
                    if (payment && (!tokenFilter || payment.tokenId === tokenFilter)) {
                        events.push({
                            id: `task46:${payment.transactionHash}`,
                            source: 'task46-recorded-evidence',
                            type: 'spend.verified',
                            timestamp: Date.parse(payment.generatedAt) || 0,
                            tokenId: payment.tokenId,
                            contractId: payment.contractId,
                            transactionHash: payment.transactionHash,
                            ownerId: payment.signer,
                            receiverId: payment.receiverId,
                            amountYocto: payment.amountYocto,
                            amountFormatted: payment.amountNear ? `${payment.amountNear} NEAR` : null,
                            status: 'FINAL',
                            explorerUrl: payment.explorerUrl,
                            note: 'Recorded Task 46 Testnet payment evidence. Re-verified independently before finalization.',
                        });
                    }
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
                events.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                return jsonResponse(response, 200, {
                    network: config.near.network,
                    contractId: config.near.relayContractId,
                    count: Math.min(events.length, limit),
                    events: events.slice(0, limit),
                    sources: ['claim-journal', 'server-activity-journal', 'task46-recorded-evidence'],
                    note: 'Only real local/server records and recorded chain evidence are shown. No synthetic history is generated.',
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/uploads') {
                const googleIdentity = nearAuthApi.readSession(request).session?.nearAuth || null;
                const walletIdentity = walletAuth.readSession(request).session?.walletAuth || null;
                const headerAccountId = typeof request.headers['x-near-account-id'] === 'string'
                    ? request.headers['x-near-account-id'].trim().toLowerCase()
                    : null;
                const queryAccountId = typeof url.searchParams?.get('accountId') === 'string'
                    ? url.searchParams.get('accountId').trim().toLowerCase()
                    : null;
                const candidateAccount = headerAccountId || queryAccountId;
                const ownerId = googleIdentity?.accountId
                    || walletIdentity?.accountId
                    || (candidateAccount && validateAccountId(candidateAccount) ? candidateAccount : null);
                if (!ownerId) {
                    return jsonResponse(response, 401, {
                        error: 'Sign in with Google or connect a NEAR wallet before uploading artwork.',
                        code: 'AUTH_REQUIRED',
                    });
                }
                const contentType = String(request.headers['content-type'] || '');
                let saved;
                if (/^application\/json(?:\s*;|$)/i.test(contentType)) {
                    const body = await readJsonBody(request, (12 * 1024 * 1024));
                    saved = await imageUploads.saveDataUrl(body.dataUrl, { ownerId });
                } else {
                    const buffer = await readBinaryBody(request, imageUploads.limits.maxBytes + 1024);
                    saved = await imageUploads.saveBuffer(buffer, {
                        ownerId,
                        claimedContentType: contentType,
                    });
                }
                return jsonResponse(response, 200, {
                    uploaded: true,
                    ...saved,
                    ownerId,
                    limits: imageUploads.limits,
                    storageProvider: imageUploads.provider,
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/cards/mint-plan') {
                if (!config.near.relayContractId) return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });
                const body = await readJsonBody(request);
                const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim().toLowerCase() : '';
                if (!TOKEN_ID_RE.test(tokenId)) {
                    return jsonResponse(response, 400, { error: 'Token ID must be 1–32 lowercase letters, numbers, hyphens, or underscores.' });
                }
                if (!validateAccountId(body.ownerId)) {
                    return jsonResponse(response, 400, { error: 'A valid NEAR account owner ID is required.' });
                }
                const title = typeof body.name === 'string' ? body.name.trim() : '';
                if (!title || title.length > 64) {
                    return jsonResponse(response, 400, { error: 'Card name must be between 1 and 64 characters.' });
                }
                const description = typeof body.description === 'string' ? body.description.trim() : '';
                if (description.length > 500) {
                    return jsonResponse(response, 400, { error: 'Description must be at most 500 characters.' });
                }
                const media = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
                if (media && !/^(?:https:\/\/[^\s]+|\/uploads\/[a-z0-9-]+\.(?:png|jpe?g|webp))$/i.test(media)) {
                    return jsonResponse(response, 400, { error: 'Image URL must be an uploaded RELAY image path or an HTTPS URL.' });
                }
                const initialCredits = body.initialCredits === undefined ? 3 : Number(body.initialCredits);
                if (!Number.isInteger(initialCredits) || initialCredits < 0 || initialCredits > 100) {
                    return jsonResponse(response, 400, { error: 'Initial credits must be an integer between 0 and 100.' });
                }
                const block = await finalNearBlock(config, fetchImpl);
                const existing = await nearView(
                    config.near.rpcUrl,
                    config.near.relayContractId,
                    block.header.hash,
                    'nft_token',
                    { token_id: tokenId },
                    fetchImpl,
                );
                if (existing) return jsonResponse(response, 409, { error: `Token ${tokenId} already exists.` });
                const associatedAccountId = `${tokenId}.${config.near.relayContractId}`;
                const metadata = { title, description };
                if (media) metadata.media = media;
                const plan = {
                    network: 'near-testnet',
                    contractId: config.near.relayContractId,
                    methodName: 'relay_mint',
                    args: {
                        token_id: tokenId,
                        token_owner_id: body.ownerId,
                        token_metadata: metadata,
                        associated_account_id: associatedAccountId,
                        initial_credits: initialCredits,
                    },
                    attachedDepositYocto: '100000000000000000000000',
                    attachedGasTGas: 100,
                    requiredSignerRole: 'contract owner',
                    requiredSigner: null,
                    requiresContractOwner: true,
                    warning: 'The deployed contract restricts relay_mint to its contract owner (contract/src/lib.rs relay_mint). A non-owner wallet will be rejected by the contract. No mint is simulated.',
                };
                return jsonResponse(response, 200, {
                    prepared: true,
                    transactionPlan: plan,
                    associatedAccountId,
                    media,
                    notice: 'No transaction has been submitted. The contract owner must sign relay_mint on NEAR Testnet.',
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/cards/provision-plan') {
                if (!config.near.relayContractId) return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });
                const body = await readJsonBody(request);
                if (!TOKEN_ID_RE.test(body.tokenId || '')) {
                    return jsonResponse(response, 400, { error: 'Invalid RELAY token ID.' });
                }
                const bundle = await readCardBundle({ config, tokenId: body.tokenId, fetchImpl });
                if (!bundle) return jsonResponse(response, 404, { error: `Token ${body.tokenId} not found.` });
                if (bundle.binding?.isVerified) {
                    return jsonResponse(response, 409, { error: 'The associated account is already verified on chain.', code: 'ALREADY_VERIFIED' });
                }
                const plan = {
                    network: 'near-testnet',
                    contractId: config.near.relayContractId,
                    methodName: 'relay_provision_subaccount',
                    args: { token_id: body.tokenId },
                    attachedDepositYocto: '1950000000000000000000000',
                    attachedDepositNear: '1.95',
                    attachedGasTGas: 300,
                    requiredSigner: bundle.token.ownerId,
                    warning: 'Provisioning creates and deploys the canonical sub-account. The 1.95 NEAR attachment is a suggested storage/provisioning deposit; the contract enforces its own minimum and refunds failure paths.',
                };
                return jsonResponse(response, 200, {
                    prepared: true,
                    transactionPlan: plan,
                    card: bundle,
                    notice: 'No transaction has been submitted. The current token owner must sign provisioning on NEAR Testnet.',
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/cards/verify-mint') {
                if (!config.near.relayContractId) return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });
                const body = await readJsonBody(request);
                const { tokenId, transactionHash, signerId } = body;
                if (!TOKEN_ID_RE.test(tokenId || '')) return jsonResponse(response, 400, { error: 'Invalid RELAY token ID.' });
                if (!/^[1-9A-HJ-NP-Za-km-z]{40,55}$/.test(transactionHash || '')) {
                    return jsonResponse(response, 400, { error: 'Invalid NEAR transaction hash format.' });
                }
                if (!validateAccountId(signerId)) return jsonResponse(response, 400, { error: 'A valid signer account ID is required.' });
                let txBody;
                try {
                    const rpcResponse = await fetchImpl(config.near.rpcUrl, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ jsonrpc: '2.0', id: 'relay-mint-verify', method: 'tx', params: [transactionHash, signerId] }),
                    });
                    txBody = await rpcResponse.json();
                } catch (error) {
                    return jsonResponse(response, 202, { verified: false, pending: true, reason: error.message });
                }
                if (txBody.error || !txBody.result?.transaction) {
                    return jsonResponse(response, 202, { verified: false, pending: true, reason: 'Transaction not yet visible on NEAR Testnet.' });
                }
                const tx = txBody.result.transaction;
                if (tx.signer_id !== signerId || tx.receiver_id !== config.near.relayContractId) {
                    return jsonResponse(response, 400, { verified: false, reason: 'Transaction signer or receiver does not match the RELAY contract.' });
                }
                const actions = tx.actions || [];
                if (actions.length !== 1 || !actions[0]?.FunctionCall || actions[0].FunctionCall.method_name !== 'relay_mint') {
                    return jsonResponse(response, 400, { verified: false, reason: 'Transaction is not exactly one relay_mint FunctionCall.' });
                }
                let args;
                try {
                    args = JSON.parse(Buffer.from(actions[0].FunctionCall.args, 'base64').toString('utf8'));
                } catch {
                    return jsonResponse(response, 400, { verified: false, reason: 'Unable to decode relay_mint arguments.' });
                }
                if (args.token_id !== tokenId) {
                    return jsonResponse(response, 400, { verified: false, reason: 'relay_mint token_id does not match.' });
                }
                if ((txBody.result.receipts_outcome || []).some((receipt) => receipt?.outcome?.status?.Failure !== undefined)) {
                    return jsonResponse(response, 400, { verified: false, reason: 'A relay_mint receipt failed on chain.' });
                }
                if (txBody.result.final_execution_status !== 'FINAL') {
                    return jsonResponse(response, 202, { verified: false, pending: true, reason: 'Waiting for FINAL execution status.' });
                }
                const bundle = await readCardBundle({ config, tokenId, fetchImpl });
                if (!bundle) return jsonResponse(response, 202, { verified: false, pending: true, reason: 'Mint is final but the token is not yet readable.' });
                if (bundle.token.ownerId !== args.token_owner_id) {
                    return jsonResponse(response, 409, { verified: false, reason: 'Finalized token owner does not match the mint arguments.' });
                }
                await (await getActivityJournal()).record({
                    type: 'card.mint.verified',
                    tokenId,
                    contractId: config.near.relayContractId,
                    transactionHash,
                    ownerId: bundle.token.ownerId,
                    status: 'FINAL',
                    explorerUrl: `${config.near.explorerBaseUrl}/txns/${transactionHash}`,
                });
                return jsonResponse(response, 200, { verified: true, finalized: true, card: bundle });
            }
            if (request.method === 'POST' && /^\/api\/cards\/[^/]+\/funding-plan$/.test(url.pathname)) {
                const tokenId = decodeURIComponent(url.pathname.slice('/api/cards/'.length, -'/funding-plan'.length));
                if (!TOKEN_ID_RE.test(tokenId)) return jsonResponse(response, 400, { error: 'Invalid RELAY token ID.' });
                const body = await readJsonBody(request);
                const amountYocto = parseNearAmountToYocto(body.amountNear);
                if (!amountYocto) return jsonResponse(response, 400, { error: 'Enter a positive NEAR amount with at most 24 decimal places.' });
                const bundle = await readCardBundle({ config, tokenId, fetchImpl });
                if (!bundle) return jsonResponse(response, 404, { error: `Token ${tokenId} not found.` });
                if (!bundle.associatedAccount?.exists) {
                    return jsonResponse(response, 409, {
                        error: 'The associated account does not exist on chain yet. Provision it before adding funds.',
                        code: 'ACCOUNT_NOT_PROVISIONED',
                    });
                }
                return jsonResponse(response, 200, {
                    prepared: true,
                    tokenId,
                    receiverId: bundle.associatedAccount.accountId,
                    amountYocto,
                    amountNear: formatYoctoNear(amountYocto),
                    transactionPlan: {
                        network: 'near-testnet',
                        receiverId: bundle.associatedAccount.accountId,
                        actions: [{ type: 'Transfer', params: { deposit: amountYocto } }],
                        requiredSigner: 'any funded NEAR Testnet wallet',
                        note: 'A native NEAR Transfer into the card sub-account. The sender pays their own network fee; no RELAY payment intent is created.',
                    },
                    currentBalance: bundle.associatedAccount,
                    notice: 'No transfer has been submitted.',
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/funding/verify') {
                if (!config.near.relayContractId) return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });
                const body = await readJsonBody(request);
                if (!TOKEN_ID_RE.test(body.tokenId || '')) return jsonResponse(response, 400, { error: 'Invalid RELAY token ID.' });
                if (!validateAccountId(body.senderId)) return jsonResponse(response, 400, { error: 'A valid sender account ID is required.' });
                const bundle = await readCardBundle({ config, tokenId: body.tokenId, fetchImpl });
                if (!bundle?.associatedAccount?.accountId) {
                    return jsonResponse(response, 404, { error: 'Associated card account was not found.' });
                }
                let verification;
                try {
                    verification = await verifyFundingTransaction({
                        rpcUrl: config.near.rpcUrl,
                        transactionHash: body.transactionHash,
                        expectedSender: body.senderId,
                        expectedReceiver: bundle.associatedAccount.accountId,
                        expectedAmountYocto: body.amountYocto || null,
                        fetchImpl,
                    });
                } catch (error) {
                    return jsonResponse(response, 400, { verified: false, error: error.message, code: error.code });
                }
                if (!verification.verified) {
                    return jsonResponse(response, 202, { ...verification, tokenId: body.tokenId });
                }
                await (await getActivityJournal()).record({
                    type: 'funding.verified',
                    tokenId: body.tokenId,
                    contractId: config.near.relayContractId,
                    transactionHash: verification.transactionHash,
                    ownerId: body.senderId,
                    receiverId: verification.receiverId,
                    amountYocto: verification.amountYocto,
                    amountFormatted: `${verification.amountNear} NEAR`,
                    status: 'FINAL',
                    explorerUrl: verification.explorerUrl,
                    note: 'Native NEAR funding transfer into the card sub-account.',
                });
                const refreshed = await readCardBundle({ config, tokenId: body.tokenId, fetchImpl }).catch(() => bundle);
                return jsonResponse(response, 200, { ...verification, tokenId: body.tokenId, card: refreshed });
            }
            if (request.method === 'GET' && /^\/api\/cards\/[^/]+$/.test(url.pathname)) {
                const tokenId = decodeURIComponent(url.pathname.slice('/api/cards/'.length));
                if (!TOKEN_ID_RE.test(tokenId)) return jsonResponse(response, 400, { error: 'Invalid RELAY token ID.' });
                if (!config.near.relayContractId) return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });
                const bundle = await readCardBundle({ config, tokenId, fetchImpl });
                if (!bundle) return jsonResponse(response, 404, { error: `Token ${tokenId} not found.` });
                return jsonResponse(response, 200, bundle);
            }
            if (request.method === 'GET' && url.pathname.startsWith('/api/accounts/')) {
                const rest = url.pathname.slice('/api/accounts/'.length);
                const tokenId = decodeURIComponent(rest);
                if (!TOKEN_ID_RE.test(tokenId)) return jsonResponse(response, 400, { error: 'Invalid RELAY token ID.' });
                if (!config.near.relayContractId) {
                    return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });
                }
                const block = await finalNearBlock(config, fetchImpl);
                const binding = await nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'relay_account_binding', { token_id: tokenId }, fetchImpl);
                const token = await nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'nft_token', { token_id: tokenId }, fetchImpl);
                if (!binding || !token) return jsonResponse(response, 404, { error: 'RELAY token or associated account was not found.' });
                if (binding.account_id !== `${tokenId}.${config.near.relayContractId}`) {
                    throw new Error('RELAY returned a non-canonical associated account binding.');
                }
                const [locked, credits, payment, authorization, account] = await Promise.all([
                    nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'is_token_locked', { token_id: tokenId }, fetchImpl),
                    nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'relay_credits', { token_id: tokenId }, fetchImpl),
                    nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'relay_payment', { token_id: tokenId }, fetchImpl),
                    nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'relay_active_quote_authorization', { token_id: tokenId }, fetchImpl),
                    rpcCall(config.near.rpcUrl, 'query', {
                        request_type: 'view_account',
                        account_id: binding.account_id,
                        block_id: block.header.hash,
                    }, 10000, fetchImpl).catch((error) => {
                        if (/unknown account|account .* does not exist|account .* not found/i.test(error.message)) {
                            throw Object.assign(
                                new Error('The associated NEAR account does not exist at the finalized block.'),
                                { status: 404, code: 'ASSOCIATED_ACCOUNT_NOT_FOUND' },
                            );
                        }
                        throw error;
                    }),
                ]);
                return jsonResponse(
                    response,
                    200,
                    formatAccount(tokenId, account, binding, token, locked, credits, payment, authorization, block.header.hash, config),
                );
            }
            if (request.method === 'POST' && url.pathname === '/api/claim/session') {
                const body = await readJsonBody(request);
                const tokenId = body.tokenId;
                if (!TOKEN_ID_RE.test(tokenId || '')) return jsonResponse(response, 400, { error: 'Invalid RELAY token ID.' });
                if (!config.near.relayContractId) return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });

                const block = await finalNearBlock(config, fetchImpl);
                const token = await nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'nft_token', { token_id: tokenId }, fetchImpl);
                if (!token) return jsonResponse(response, 404, { error: `RELAY token ${tokenId} not found.` });

                const recipientName = typeof body.recipientName === 'string' ? body.recipientName.trim() : '';
                const message = typeof body.message === 'string' ? body.message.trim() : '';
                if (recipientName.length > 80 || message.length > 280) {
                    return jsonResponse(response, 400, { error: 'Recipient name or message is too long.' });
                }
                let session;
                try {
                    session = createClaimSession({
                        tokenId,
                        expectedOwner: token.owner_id,
                        intendedRecipient: body.intendedRecipient || null,
                        intendedRecipientEmail: body.intendedRecipientEmail || null,
                        publicAppUrl: config.app.publicAppUrl,
                        localFallbackOrigin: `http://${request.headers.host || '127.0.0.1:4173'}`,
                        ttlSeconds: body.ttlSeconds || undefined,
                    });
                } catch (error) {
                    return jsonResponse(response, 400, { error: error.message, code: error.code });
                }
                session.recipientName = recipientName || null;
                session.message = message || null;
                const journalInstance = await getJournal();
                await journalInstance.recordSessionCreated(session);
                return jsonResponse(response, 200, {
                    ...session,
                    emailBinding: session.intendedRecipientEmail
                        ? {
                            required: true,
                            masked: maskEmail(session.intendedRecipientEmail),
                            delivery: 'not-implemented',
                            note: 'Email delivery is not implemented. Share the invitation link directly. Only this verified Google email may authenticate the invitation.',
                        }
                        : null,
                });
            }
            if (request.method === 'GET' && url.pathname.startsWith('/api/claim/session/')) {
                const sessionToken = decodeURIComponent(url.pathname.slice('/api/claim/session/'.length));
                if (!sessionToken) return jsonResponse(response, 400, { error: 'Missing session token.' });
                if (!config.near.relayContractId) return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });

                const journalInstance = await getJournal();
                let session;
                try {
                    session = verifyClaimSession(sessionToken, { journal: journalInstance });
                } catch (e) {
                    return jsonResponse(response, 400, { error: e.message, code: e.code });
                }

                const block = await finalNearBlock(config, fetchImpl);
                const token = await nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'nft_token', { token_id: session.tokenId }, fetchImpl);
                if (!token) return jsonResponse(response, 404, { error: `Token ${session.tokenId} not found.` });

                // Re-verify current owner matches
                try {
                    verifyClaimSession(sessionToken, { currentTokenOwner: token.owner_id, requestedTokenId: session.tokenId, journal: journalInstance });
                } catch (e) {
                    return jsonResponse(response, 409, { error: e.message, code: e.code });
                }

                const journalEntry = journalInstance.getSession(session.sessionId);

                const authConfig = validateAuthConfig(envSource);
                const currentUser = resolveSessionUser(request, serverSessionStore, envSource);
                const emailMatches = Boolean(
                    journalEntry?.intendedRecipientEmail &&
                    currentUser?.emailVerified === true &&
                    sameEmail(currentUser.email, journalEntry.intendedRecipientEmail),
                );
                return jsonResponse(response, 200, {
                    session: {
                        ...session,
                        intendedRecipientEmail: undefined,
                        ownerApprovalToken: undefined,
                    },
                    journalEntry: journalEntry ? {
                        state: journalEntry.state,
                        authenticatedUser: journalEntry.authenticatedUser
                            ? { sub: journalEntry.authenticatedUser.sub, name: journalEntry.authenticatedUser.name || null }
                            : null,
                        linkedNearAccountId: journalEntry.linkedNearAccountId,
                        creatorApproved: journalEntry.creatorApproved,
                        approvedRecipient: journalEntry.approvedRecipient,
                        transactionHash: journalEntry.transactionHash,
                        finalizedOwner: journalEntry.finalizedOwner,
                        recipientName: journalEntry.recipientName || null,
                        message: journalEntry.message || null,
                        intendedRecipientEmailMasked: maskEmail(journalEntry.intendedRecipientEmail),
                        requiresEmailAuth: Boolean(journalEntry.intendedRecipientEmail),
                        emailMatchesSession: emailMatches,
                        ownerApprovalToken: undefined,
                    } : null,
                    authUser: currentUser
                        ? { email: currentUser.email || null, emailVerified: currentUser.emailVerified === true, name: currentUser.name || null }
                        : null,
                    claimStatus: (journalEntry && journalEntry.state === 'TRANSFER_FINALIZED') ? 'claimed' : 'ready_for_recipient',
                    claimLifecycleState: journalEntry ? journalEntry.state : 'CREATED',
                    token: {
                        id: session.tokenId,
                        ownerId: token.owner_id,
                        metadata: token.metadata || {},
                    },
                    accounts: {
                        near: session.tokenId + '.' + config.near.relayContractId,
                    },
                    assets: {
                        near: 'available-via-near-assets-endpoint',
                    },
                    auth: authConfig,
                    disclaimer: 'NEAR Testnet only. No cross-chain or mainnet settlement is part of this product.',
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/claim/link-account') {
                const body = await readJsonBody(request);
                const { sessionId, sessionToken, nearAccountId } = body;
                if (!sessionId || !nearAccountId) {
                    return jsonResponse(response, 400, { error: 'sessionId and nearAccountId are required.' });
                }
                if (!validateNearAccountId(nearAccountId)) {
                    return jsonResponse(response, 400, { error: `Invalid NEAR account ID: ${nearAccountId}` });
                }
                const journalInstance = await getJournal();
                const entry = journalInstance.getSession(sessionId);
                if (!entry) {
                    return jsonResponse(response, 404, { error: `Claim session ${sessionId} not found.` });
                }
                if (entry.state === 'TRANSFER_FINALIZED' || entry.state === 'CANCELLED') {
                    return jsonResponse(response, 409, { error: `Cannot link account: claim session is ${entry.state}.` });
                }
                if (sessionToken) {
                    try {
                        verifyClaimSession(sessionToken, { requestedTokenId: entry.tokenId, journal: journalInstance });
                    } catch (e) {
                        return jsonResponse(response, 400, { error: e.message, code: e.code });
                    }
                }

                // Check on-chain existence
                const block = await finalNearBlock(config, fetchImpl);
                let onChainAcc;
                try {
                    onChainAcc = await rpcCall(config.near.rpcUrl, 'query', {
                        request_type: 'view_account',
                        account_id: nearAccountId,
                        block_id: block.header.hash,
                    }, 10000, fetchImpl);
                } catch {
                    onChainAcc = null;
                }

                if (!onChainAcc || onChainAcc.amount === undefined) {
                    return jsonResponse(response, 400, {
                        error: `Recipient account '${nearAccountId}' does not exist on NEAR ${config.near.network}. Please provision the account before linking.`,
                        code: 'ACCOUNT_NOT_PROVISIONED',
                    });
                }

                await journalInstance.recordAccountLinked(sessionId, nearAccountId);
                return jsonResponse(response, 200, {
                    linked: true,
                    sessionId,
                    nearAccountId,
                    state: 'RECIPIENT_ACCOUNT_LINKED',
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/claim/challenge') {
                const body = await readJsonBody(request);
                const { sessionId, recipientAccountId } = body;
                if (!sessionId || !recipientAccountId) {
                    return jsonResponse(response, 400, { error: 'sessionId and recipientAccountId are required.' });
                }
                if (!validateNearAccountId(recipientAccountId)) {
                    return jsonResponse(response, 400, { error: `Invalid NEAR account ID: ${recipientAccountId}` });
                }
                const journalInstance = await getJournal();
                const entry = journalInstance.getSession(sessionId);
                if (!entry) return jsonResponse(response, 404, { error: `Claim session ${sessionId} not found.` });
                if (entry.state === 'TRANSFER_FINALIZED' || entry.state === 'CANCELLED' || entry.state === 'EXPIRED') {
                    return jsonResponse(response, 409, { error: `Claim session is ${entry.state}.`, code: `SESSION_${entry.state}` });
                }

                // Email-bound invitations are enforced before any ownership challenge is issued.
                const sessionUser = resolveSessionUser(request, serverSessionStore, envSource);
                if (entry.intendedRecipientEmail) {
                    if (!sessionUser || sessionUser.emailVerified !== true || !sameEmail(sessionUser.email, entry.intendedRecipientEmail)) {
                        return jsonResponse(response, 403, {
                            error: 'This invitation is bound to a different verified Google email. Sign in with the invited account.',
                            code: 'EMAIL_BINDING_REQUIRED',
                        });
                    }
                }
                const authedSub = sessionUser?.sub || entry.authenticatedUser?.sub || null;

                const challenge = userChallengeStore.createChallenge({
                    claimSessionId: sessionId,
                    recipientSub: authedSub,
                    tokenId: entry.tokenId,
                    contractId: config.near.relayContractId || entry.contractId || null,
                    recipientAccountId,
                    appOrigin: config.app.publicAppUrl || `http://${request.headers.host || 'localhost:4173'}`,
                });

                return jsonResponse(response, 200, {
                    challengeId: challenge.challengeId,
                    message: challenge.message,
                    nonceHex: challenge.nonceHex,
                    recipientAccountId: challenge.recipientAccountId,
                    appOrigin: challenge.appOrigin,
                    issuedAt: challenge.issuedAt,
                    expiresAt: challenge.expiresAt,
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/claim/verify-and-link') {
                const body = await readJsonBody(request);
                const { sessionId, sessionToken, challengeId, signature, publicKey, recipientAccountId } = body;
                if (!sessionId || !challengeId || !signature || !publicKey || !recipientAccountId) {
                    return jsonResponse(response, 400, { error: 'sessionId, challengeId, signature, publicKey, and recipientAccountId are required.' });
                }
                const challenge = userChallengeStore.consumeChallenge(challengeId);
                if (!challenge) {
                    return jsonResponse(response, 400, { error: 'NEP-413 challenge not found, expired, or already consumed.', code: 'CHALLENGE_EXPIRED_OR_REPLAYED' });
                }
                if (challenge.claimSessionId !== sessionId) {
                    return jsonResponse(response, 400, { error: 'Challenge session mismatch.', code: 'SESSION_MISMATCH' });
                }

                const journalInstance = await getJournal();
                const entry = journalInstance.getSession(sessionId);
                if (!entry) return jsonResponse(response, 404, { error: `Claim session ${sessionId} not found.` });
                if (entry.state === 'TRANSFER_FINALIZED' || entry.state === 'CANCELLED' || entry.state === 'EXPIRED') {
                    return jsonResponse(response, 409, { error: `Claim session is ${entry.state}.`, code: `SESSION_${entry.state}` });
                }

                if (sessionToken) {
                    try {
                        verifyClaimSession(sessionToken, { requestedTokenId: entry.tokenId, journal: journalInstance });
                    } catch (e) {
                        return jsonResponse(response, 400, { error: e.message, code: e.code });
                    }
                }

                const sessionUser = resolveSessionUser(request, serverSessionStore, envSource);
                if (entry.intendedRecipientEmail) {
                    if (!sessionUser || sessionUser.emailVerified !== true || !sameEmail(sessionUser.email, entry.intendedRecipientEmail)) {
                        return jsonResponse(response, 403, {
                            error: 'This invitation is bound to a different verified Google email.',
                            code: 'EMAIL_BINDING_REQUIRED',
                        });
                    }
                    if (challenge.recipientSub && sessionUser.sub && challenge.recipientSub !== sessionUser.sub) {
                        return jsonResponse(response, 403, {
                            error: 'The signed-in Google account changed during the claim flow.',
                            code: 'AUTH_SUBJECT_MISMATCH',
                        });
                    }
                    await journalInstance.recordRecipientAuthenticated(sessionId, {
                        sub: sessionUser.sub,
                        email: sessionUser.email,
                        name: sessionUser.name,
                    });
                }

                // Cryptographic NEP-413 signature verification against active on-chain access keys
                try {
                    await verifyNep413Signature({
                        challenge,
                        signature,
                        publicKey,
                        recipientAccountId,
                        nearRpcUrl: config.near.rpcUrl,
                        fetchImpl,
                        expectedTokenId: entry.tokenId,
                        expectedContractId: config.near.relayContractId,
                    });
                } catch (sigErr) {
                    return jsonResponse(response, 400, { error: sigErr.message, code: sigErr.code });
                }

                // Check on-chain existence
                const block = await finalNearBlock(config, fetchImpl);
                let onChainAcc;
                try {
                    onChainAcc = await rpcCall(config.near.rpcUrl, 'query', {
                        request_type: 'view_account',
                        account_id: recipientAccountId,
                        block_id: block.header.hash,
                    }, 10000, fetchImpl);
                } catch {
                    onChainAcc = null;
                }

                if (!onChainAcc || onChainAcc.amount === undefined) {
                    return jsonResponse(response, 400, {
                        error: `Recipient account '${recipientAccountId}' does not exist on NEAR ${config.near.network}.`,
                        code: 'ACCOUNT_NOT_PROVISIONED',
                    });
                }

                await journalInstance.recordAccountLinked(sessionId, recipientAccountId, {
                    cryptographicallyVerified: true,
                    verifiedPublicKey: publicKey,
                });
                return jsonResponse(response, 200, {
                    linked: true,
                    verified: true,
                    cryptographicallyVerified: true,
                    sessionId,
                    recipientAccountId,
                    publicKey,
                    state: 'RECIPIENT_ACCOUNT_LINKED',
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/claim/approve') {
                const body = await readJsonBody(request);
                const { sessionId, sessionToken, ownerApprovalToken } = body;
                if (!sessionId) return jsonResponse(response, 400, { error: 'sessionId is required.' });

                const journalInstance = await getJournal();
                const entry = journalInstance.getSession(sessionId);
                if (!entry) return jsonResponse(response, 404, { error: `Claim session ${sessionId} not found.` });
                if (entry.state === 'TRANSFER_FINALIZED' || entry.state === 'CANCELLED' || entry.state === 'EXPIRED') {
                    return jsonResponse(response, 409, { error: `Cannot approve: claim session is ${entry.state}.`, code: `SESSION_${entry.state}` });
                }
                if (!entry.linkedNearAccountId) {
                    return jsonResponse(response, 400, { error: 'No recipient NEAR account has been linked to this session yet.' });
                }

                // Email-bound invitations require the creator-only approval
                // capability. It is never embedded in the claim URL, so a
                // recipient holding the invitation link cannot self-approve.
                // Legacy NEAR-account invitations created by the older direct
                // API remain compatible and are flagged in the response.
                if (entry.intendedRecipientEmail) {
                    const expectedToken = entry.ownerApprovalToken || deriveOwnerApprovalToken(sessionId);
                    if (!timingSafeHexEqual(ownerApprovalToken, expectedToken)) {
                        return jsonResponse(response, 403, {
                            error: 'Creator approval capability is required for this email-bound invitation.',
                            code: 'OWNER_APPROVAL_REQUIRED',
                        });
                    }
                }

                const block = await finalNearBlock(config, fetchImpl);
                const token = await nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'nft_token', { token_id: entry.tokenId }, fetchImpl);
                if (!token) return jsonResponse(response, 404, { error: `Token ${entry.tokenId} not found.` });
                if (token.owner_id !== entry.expectedOwner) {
                    return jsonResponse(response, 409, { error: `Current token owner (${token.owner_id}) does not match expected creator (${entry.expectedOwner}).` });
                }

                await journalInstance.recordCreatorApproved(sessionId, entry.intendedRecipientEmail ? 'creator-capability' : 'legacy-session-token');
                await (await getActivityJournal()).record({
                    type: 'claim.approved',
                    tokenId: entry.tokenId,
                    contractId: config.near.relayContractId,
                    sessionId,
                    ownerId: entry.expectedOwner,
                    receiverId: entry.linkedNearAccountId,
                    status: 'AWAITING_CREATOR_APPROVAL',
                    note: 'Creator approved the linked recipient. No transfer has been submitted yet.',
                });
                return jsonResponse(response, 200, {
                    approved: true,
                    sessionId,
                    approvedRecipient: entry.linkedNearAccountId,
                    state: 'AWAITING_CREATOR_APPROVAL',
                    approvalProof: entry.intendedRecipientEmail ? 'creator-capability' : 'legacy-session-token-compatibility',
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/claim/cancel') {
                const body = await readJsonBody(request);
                const { sessionId, ownerApprovalToken } = body;
                if (!sessionId) return jsonResponse(response, 400, { error: 'sessionId is required.' });
                const journalInstance = await getJournal();
                const entry = journalInstance.getSession(sessionId);
                if (!entry) return jsonResponse(response, 404, { error: `Claim session ${sessionId} not found.` });
                if (entry.state === 'TRANSFER_FINALIZED') {
                    return jsonResponse(response, 409, { error: 'A finalized claim cannot be cancelled.', code: 'CLAIM_ALREADY_CONSUMED' });
                }
                if (entry.state === 'CANCELLED') {
                    return jsonResponse(response, 200, { cancelled: true, state: 'CANCELLED', alreadyCancelled: true });
                }
                const expectedToken = entry.ownerApprovalToken || deriveOwnerApprovalToken(sessionId);
                if (!timingSafeHexEqual(ownerApprovalToken, expectedToken)) {
                    return jsonResponse(response, 403, {
                        error: 'Creator cancellation capability is required.',
                        code: 'OWNER_APPROVAL_REQUIRED',
                    });
                }
                await journalInstance.recordSessionCancelled(sessionId, 'Cancelled by creator');
                await (await getActivityJournal()).record({
                    type: 'claim.cancelled',
                    tokenId: entry.tokenId,
                    contractId: config.near.relayContractId,
                    sessionId,
                    ownerId: entry.expectedOwner,
                    status: 'CANCELLED',
                });
                return jsonResponse(response, 200, { cancelled: true, state: 'CANCELLED', sessionId });
            }
            if (request.method === 'POST' && url.pathname === '/api/claim/prepare-transfer') {
                const body = await readJsonBody(request);
                const { tokenId, recipientAccountId, sessionToken } = body;
                if (!TOKEN_ID_RE.test(tokenId || '')) return jsonResponse(response, 400, { error: 'Invalid RELAY token ID.' });
                if (!validateAccountId(recipientAccountId)) return jsonResponse(response, 400, { error: 'Invalid recipient NEAR account ID.' });
                if (!config.near.relayContractId) return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });

                const journalInstance = await getJournal();
                let verifiedSession = null;
                if (sessionToken) {
                    try {
                        verifiedSession = verifyClaimSession(sessionToken, { requestedTokenId: tokenId, journal: journalInstance });
                    } catch (e) {
                        return jsonResponse(response, 400, { error: e.message, code: e.code });
                    }
                }

                if (verifiedSession) {
                    const journalEntry = journalInstance.getSession(verifiedSession.sessionId);
                    if (journalEntry) {
                        if (!journalEntry.creatorApproved) {
                            return jsonResponse(response, 400, {
                                error: 'Transfer cannot be prepared: awaiting creator approval.',
                                code: 'AWAITING_CREATOR_APPROVAL',
                            });
                        }
                        if (journalEntry.approvedRecipient !== recipientAccountId) {
                            return jsonResponse(response, 400, {
                                error: `Transfer recipient '${recipientAccountId}' does not match creator-approved recipient '${journalEntry.approvedRecipient}'.`,
                                code: 'APPROVAL_MISMATCH',
                            });
                        }
                    }
                }

                const block = await finalNearBlock(config, fetchImpl);
                const [token, lifecycle, recipientAccount] = await Promise.all([
                    nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'nft_token', { token_id: tokenId }, fetchImpl),
                    nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'token_lifecycle', { token_id: tokenId }, fetchImpl),
                    rpcCall(config.near.rpcUrl, 'query', {
                        request_type: 'view_account',
                        account_id: recipientAccountId,
                        block_id: block.header.hash,
                    }, 10000, fetchImpl).catch(() => null),
                ]);

                if (!token) return jsonResponse(response, 404, { error: `Token ${tokenId} not found.` });
                if (lifecycle !== 'Unlocked') {
                    return jsonResponse(response, 409, {
                        error: `Token is currently locked in state ${JSON.stringify(lifecycle)}. It cannot be transferred until unlocked.`,
                        code: 'TOKEN_LOCKED',
                    });
                }

                const resolution = validateRecipientAccountResolution({
                    resolvedNearAccountId: recipientAccountId,
                    accountExistsOnChain: Boolean(recipientAccount && recipientAccount.amount !== undefined),
                });

                if (!resolution.ready) {
                    return jsonResponse(response, 400, {
                        error: resolution.message,
                        code: resolution.status,
                    });
                }

                const plan = {
                    contractId: config.near.relayContractId,
                    methodName: 'nft_transfer',
                    args: {
                        token_id: tokenId,
                        receiver_id: recipientAccountId,
                        enforce_subaccount_unlocked: true,
                        memo: 'RELAY Web2 claim transfer',
                    },
                    attachedDepositYocto: '1',
                    attachedGasTGas: 30,
                    requiredSigner: token.owner_id,
                };

                if (verifiedSession) {
                    await journalInstance.recordTransferPrepared(verifiedSession.sessionId, plan);
                }

                return jsonResponse(response, 200, {
                    prepared: true,
                    transactionPlan: plan,
                    resolution,
                    notice: 'Transfer parameter payload prepared and verified. No transaction has been submitted.',
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/claim/finalize') {
                const body = await readJsonBody(request);
                const { sessionId, transactionHash } = body;
                if (!sessionId || !transactionHash) {
                    return jsonResponse(response, 400, { error: 'sessionId and transactionHash are required.' });
                }
                if (!/^[1-9A-HJ-NP-Za-km-z]{40,55}$/.test(transactionHash)) {
                    return jsonResponse(response, 400, { error: 'Invalid NEAR transaction hash format.', code: 'INVALID_TRANSACTION_HASH' });
                }
                const journalInstance = await getJournal();
                const entry = journalInstance.getSession(sessionId);
                if (!entry) return jsonResponse(response, 404, { error: `Claim session ${sessionId} not found.` });

                // Idempotent return if already finalized
                if (entry.state === 'TRANSFER_FINALIZED') {
                    return jsonResponse(response, 200, {
                        finalized: true,
                        state: 'TRANSFER_FINALIZED',
                        previousOwner: entry.expectedOwner,
                        newOwner: entry.finalizedOwner,
                        transactionHash: entry.transactionHash || transactionHash,
                        notice: 'Claim session is already finalized.',
                    });
                }
                if (entry.state === 'CANCELLED' || entry.state === 'EXPIRED') {
                    return jsonResponse(response, 409, {
                        error: `Cannot finalize transfer: claim session is ${entry.state}.`,
                        code: `SESSION_${entry.state}`,
                    });
                }
                if (!entry.linkedNearAccountId) {
                    return jsonResponse(response, 400, { error: 'No linked recipient account.' });
                }
                if (!entry.creatorApproved || entry.approvedRecipient !== entry.linkedNearAccountId) {
                    return jsonResponse(response, 400, {
                        error: 'Cannot finalize transfer: claim has not been approved by creator for this recipient.',
                        code: 'CREATOR_APPROVAL_REQUIRED',
                    });
                }
                if (consumedTransactionHashes.has(transactionHash)) {
                    return jsonResponse(response, 409, {
                        error: `Transaction ${transactionHash} has already been consumed by an approved claim session.`,
                        code: 'TRANSACTION_ALREADY_CONSUMED',
                    });
                }

                await journalInstance.recordTransferSubmitted(sessionId, transactionHash);

                // Independently inspect transaction outcome, signer, contract, method, and args on NEAR RPC
                let txVerification;
                try {
                    txVerification = await verifyFinalizedTransferTransaction({
                        nearRpcUrl: config.near.rpcUrl,
                        relayContractId: config.near.relayContractId,
                        transactionHash,
                        expectedSigner: entry.expectedOwner,
                        expectedTokenId: entry.tokenId,
                        expectedReceiver: entry.linkedNearAccountId,
                        fetchImpl,
                    });
                } catch (txErr) {
                    return jsonResponse(response, 400, { error: txErr.message, code: txErr.code });
                }

                if (!txVerification.finalized) {
                    return jsonResponse(response, 202, {
                        finalized: false,
                        state: 'AWAITING_FINALITY',
                        message: txVerification.message,
                        transactionHash,
                    });
                }

                // Query finalized block to check actual ownership and lifecycle
                const block = await finalNearBlock(config, fetchImpl);
                const [token, lifecycle] = await Promise.all([
                    nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'nft_token', { token_id: entry.tokenId }, fetchImpl),
                    nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'token_lifecycle', { token_id: entry.tokenId }, fetchImpl).catch(() => 'Unlocked'),
                ]);

                if (lifecycle && lifecycle !== 'Unlocked') {
                    return jsonResponse(response, 409, {
                        error: `Token lifecycle is currently locked in state ${JSON.stringify(lifecycle)}. Finalization cannot complete until unlocked.`,
                        code: 'TOKEN_LOCKED',
                    });
                }

                if (token && token.owner_id === entry.linkedNearAccountId) {
                    consumedTransactionHashes.add(transactionHash);
                    await journalInstance.recordTransferFinalized(sessionId, token.owner_id);
                    markSessionClaimed(sessionId, { finalizedOwner: token.owner_id, journal: journalInstance });
                    await (await getActivityJournal()).record({
                        type: 'claim.finalized',
                        tokenId: entry.tokenId,
                        contractId: config.near.relayContractId,
                        sessionId,
                        ownerId: entry.expectedOwner,
                        receiverId: token.owner_id,
                        transactionHash,
                        status: 'FINAL',
                        explorerUrl: `${config.near.explorerBaseUrl}/txns/${transactionHash}`,
                        note: 'Finalized nft_transfer verified against current chain ownership.',
                    });
                    return jsonResponse(response, 200, {
                        finalized: true,
                        state: 'TRANSFER_FINALIZED',
                        previousOwner: entry.expectedOwner,
                        newOwner: token.owner_id,
                        transactionHash,
                        verifiedTransaction: {
                            signerId: txVerification.transaction.signer_id,
                            receiverId: txVerification.transaction.receiver_id,
                            methodName: 'nft_transfer',
                            deposit: '1',
                        },
                    });
                }

                return jsonResponse(response, 202, {
                    finalized: false,
                    state: 'AWAITING_FINALITY',
                    message: `Transaction processed but finalized NFT ownership is '${token?.owner_id}'; waiting for '${entry.linkedNearAccountId}'.`,
                    transactionHash,
                });
            }
            if (request.method === 'GET' && url.pathname === '/api/auth/google/login') {
                const authConfig = validateAuthConfig(envSource);
                if (!authConfig.configured) {
                    return jsonResponse(response, 503, {
                        error: 'Google OAuth is unconfigured.',
                        reason: authConfig.reason,
                        requiredEnv: authConfig.requiredEnv,
                        documentation: authConfig.documentation,
                    });
                }
                const claimSessionId = url.searchParams.get('claimSessionId') || 'claim-direct';
                const returnTo = normalizeLocalReturnTo(url.searchParams.get('returnTo'));
                if (returnTo === false) {
                    return jsonResponse(response, 400, { error: 'returnTo must be a local app path.' });
                }
                const secret = envSource.CLAIM_SESSION_SECRET || 'relay-default-auth-secret';
                const { url: authUrl, state, nonce } = createGoogleAuthUrl(envSource, claimSessionId, secret, {
                    transactionStore: oauthTransactionStore,
                });

                const cookieBase = {
                    maxAge: 900,
                    httpOnly: true,
                    sameSite: 'Lax',
                    path: '/api/auth/google/callback',
                    secure: config.app.publicAppUrl?.startsWith('https:'),
                };
                const cookies = [
                    serializeCookie('relay_oauth_state', state, cookieBase),
                ];
                if (returnTo) {
                    cookies.push(serializeCookie('relay_oauth_return', returnTo, cookieBase));
                }

                response.writeHead(302, {
                    Location: authUrl,
                    'Set-Cookie': cookies,
                    'Cache-Control': 'no-store',
                });
                return response.end();
            }
            if (request.method === 'GET' && url.pathname === '/api/auth/google/callback') {
                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                if (!code || !state) {
                    return jsonResponse(response, 400, { error: 'Missing code or state parameter.' });
                }
                const secret = envSource.CLAIM_SESSION_SECRET || 'relay-default-auth-secret';
                const cookies = parseCookies(request.headers.cookie);

                if (cookies.relay_oauth_state && cookies.relay_oauth_state !== state) {
                    return jsonResponse(response, 400, { error: 'OAuth state cookie mismatch.', code: 'STATE_COOKIE_MISMATCH' });
                }

                // Consume transaction atomically from server-side store
                const tx = oauthTransactionStore.consumeTransaction(state);
                let codeVerifier = tx?.codeVerifier;
                let expectedNonce = tx?.nonce;
                let claimSessionId = tx?.claimSessionId;

                if (!codeVerifier) {
                    // Fallback to HMAC state token for test compatibility
                    try {
                        const verifiedState = verifyOAuthStateToken(state, secret);
                        codeVerifier = verifiedState.codeVerifier;
                        expectedNonce = verifiedState.nonce;
                        claimSessionId = verifiedState.claimSessionId;
                    } catch (e) {
                        return jsonResponse(response, 400, { error: `Invalid or expired OAuth state: ${e.message}`, code: e.code });
                    }
                }

                if (!codeVerifier) {
                    return jsonResponse(response, 400, { error: 'Missing PKCE code verifier.' });
                }

                const tokens = await exchangeAuthorizationCode({
                    code,
                    codeVerifier,
                    env: envSource,
                    fetchImpl,
                });

                const verifiedToken = await verifyGoogleIdToken({
                    idToken: tokens.id_token,
                    clientId: envSource.GOOGLE_CLIENT_ID,
                    expectedNonce,
                    fetchImpl,
                });

                const serverSession = serverSessionStore.createSession(verifiedToken.user);
                const sessionCookieValue = createSessionCookiePayload(verifiedToken.user, secret, 86400);

                const sessionCookie = serializeCookie('relay_auth_session', serverSession.sessionId, {
                    maxAge: 86400,
                    httpOnly: true,
                    sameSite: 'Lax',
                    path: '/',
                    secure: config.app.publicAppUrl?.startsWith('https:'),
                });

                const legacyCookie = serializeCookie('relay_auth_payload', sessionCookieValue, {
                    maxAge: 86400,
                    httpOnly: true,
                    sameSite: 'Lax',
                    path: '/',
                    secure: config.app.publicAppUrl?.startsWith('https:'),
                });

                const clearStateCookie = serializeCookie('relay_oauth_state', '', {
                    maxAge: 0,
                    httpOnly: true,
                    path: '/api/auth/google/callback',
                });
                const clearReturnCookie = serializeCookie('relay_oauth_return', '', {
                    maxAge: 0,
                    httpOnly: true,
                    path: '/api/auth/google/callback',
                });

                const journalInstance = await getJournal();
                if (claimSessionId && journalInstance.hasSession(claimSessionId)) {
                    await journalInstance.recordRecipientAuthenticated(claimSessionId, verifiedToken.user);
                }

                const requestedReturnTo = normalizeLocalReturnTo(cookies.relay_oauth_return);
                let redirectTarget;
                if (requestedReturnTo) {
                    // A validated local path was captured when sign-in started.
                    // This supports normal product sign-in (for example /#/overview)
                    // without weakening the OAuth state/cookie checks above.
                    redirectTarget = requestedReturnTo;
                } else {
                    const targetEntry = claimSessionId ? journalInstance.getSession(claimSessionId) : null;
                    if (targetEntry) {
                        // Use the signed recipient session token, not the internal
                        // journal ID. The claim page can verify the former without
                        // exposing any server-side capability.
                        redirectTarget = `/#/claim?auth=success&session=${encodeURIComponent(targetEntry.sessionToken)}&token=${encodeURIComponent(targetEntry.tokenId)}`;
                    } else {
                        redirectTarget = '/#/overview';
                    }
                }

                response.writeHead(302, {
                    Location: redirectTarget,
                    'Set-Cookie': [sessionCookie, legacyCookie, clearStateCookie, clearReturnCookie],
                    'Cache-Control': 'no-store',
                });
                return response.end();
            }
            if (request.method === 'GET' && url.pathname === '/api/auth/session') {
                const secret = envSource.CLAIM_SESSION_SECRET || 'relay-default-auth-secret';
                const cookies = parseCookies(request.headers.cookie);
                let sessionUser = null;
                if (cookies.relay_auth_session) {
                    const serverSession = serverSessionStore.getSession(cookies.relay_auth_session);
                    if (serverSession) {
                        sessionUser = {
                            sub: serverSession.sub,
                            email: serverSession.email,
                            emailVerified: serverSession.emailVerified === true,
                            name: serverSession.name,
                        };
                    } else {
                        const verifiedPayload = verifySessionCookiePayload(cookies.relay_auth_session, secret);
                        if (verifiedPayload) {
                            sessionUser = {
                                sub: verifiedPayload.sub,
                                email: verifiedPayload.email,
                                emailVerified: verifiedPayload.emailVerified === true,
                                name: verifiedPayload.name,
                            };
                        }
                    }
                }
                if (!sessionUser && cookies.relay_auth_payload) {
                    const verifiedPayload = verifySessionCookiePayload(cookies.relay_auth_payload, secret);
                    if (verifiedPayload) {
                        sessionUser = {
                            sub: verifiedPayload.sub,
                            email: verifiedPayload.email,
                            emailVerified: verifiedPayload.emailVerified === true,
                            name: verifiedPayload.name,
                        };
                    }
                }
                const authConfig = validateAuthConfig(envSource);

                const nearSession = cookies.relay_auth_session
                    ? serverSessionStore.getSession(cookies.relay_auth_session)
                    : null;
                const nearAuth = nearSession?.nearAuth || null;
                if (nearAuth) {
                    sessionUser = {
                        sub: nearAuth.sub,
                        email: nearAuth.email,
                        emailVerified: nearAuth.emailVerified === true,
                        name: nearAuth.name,
                    };
                }

                return jsonResponse(response, 200, {
                    authenticated: Boolean(sessionUser),
                    user: sessionUser,
                    provider: nearAuth ? 'near-auth' : 'google',
                    configured: authConfig.configured,
                    near: nearAuth
                        ? {
                            accountId: nearAuth.accountId,
                            publicKey: nearAuth.publicKey,
                            path: nearAuth.path,
                        }
                        : null,
                });
            }
            if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
                const cookies = parseCookies(request.headers.cookie);
                if (cookies.relay_auth_session) {
                    serverSessionStore.revokeSession(cookies.relay_auth_session);
                }
                const clearSession = serializeCookie('relay_auth_session', '', {
                    maxAge: 0,
                    httpOnly: true,
                    path: '/',
                });
                const clearLegacy = serializeCookie('relay_auth_payload', '', {
                    maxAge: 0,
                    httpOnly: true,
                    path: '/',
                });
                response.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'Set-Cookie': [clearSession, clearLegacy],
                });
                return response.end(JSON.stringify({ loggedOut: true }));
            }
            if (request.method === 'GET' && url.pathname === '/api/auth/config') {
                const authConfig = validateAuthConfig(envSource);
                return jsonResponse(response, 200, authConfig);
            }
            if (request.method === 'GET' && url.pathname.startsWith('/api/owners/')) {
                const ownerId = decodeURIComponent(url.pathname.slice('/api/owners/'.length));
                if (!validateAccountId(ownerId)) return jsonResponse(response, 400, { error: 'Invalid NEAR account ID.' });
                if (!config.near.relayContractId) return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });
                const block = await finalNearBlock(config, fetchImpl);
                const tokens = await nearView(config.near.rpcUrl, config.near.relayContractId, block.header.hash, 'nft_tokens_for_owner', {
                    account_id: ownerId,
                    from_index: '0',
                    limit: 50,
                }, fetchImpl);
                return jsonResponse(response, 200, { ownerId, blockHash: block.header.hash, tokens });
            }
            // ─────────────────────────────────────────────────────────────────
            // NEAR TESTNET NATIVE PAYMENT ENDPOINTS
            // Direct NEAR Testnet transfer from the card account via
            // relay_execute_subaccount. No cross-chain routing.
            // ─────────────────────────────────────────────────────────────────
            if (request.method === 'POST' && url.pathname === '/api/payment/prepare-near') {
                const body = await readJsonBody(request);
                if (!config.near.relayContractId) {
                    return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });
                }
                if (!TOKEN_ID_RE.test(body.tokenId || '')) {
                    return jsonResponse(response, 400, { error: 'Invalid RELAY token ID.' });
                }
                if (!body.receiverId || typeof body.receiverId !== 'string' ||
                    body.receiverId.length < 2 || body.receiverId.length > 64 ||
                    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(body.receiverId)) {
                    return jsonResponse(response, 400, { error: 'receiverId must be a valid NEAR account ID.', code: 'INVALID_RECEIVER' });
                }
                if (!body.amountYocto && !body.amountNear) {
                    return jsonResponse(response, 400, { error: 'Either amountYocto or amountNear is required.' });
                }
                let amountYocto;
                try {
                    if (body.amountYocto) {
                        if (typeof body.amountYocto !== 'string' || !/^[1-9]\d*$/.test(body.amountYocto)) {
                            throw new Error('amountYocto must be a positive integer string.');
                        }
                        amountYocto = BigInt(body.amountYocto);
                    } else {
                        if (typeof body.amountNear !== 'string' ||
                            !/^(?:0|[1-9]\d{0,23})(?:\.\d{1,24})?$/.test(body.amountNear)) {
                            throw new Error('amountNear must be a positive decimal string with at most 24 decimal places.');
                        }
                        const [whole, fraction = ''] = body.amountNear.split('.');
                        amountYocto = BigInt(whole + fraction.padEnd(24, '0'));
                    }
                    if (amountYocto <= 0n) throw new Error('Amount must be positive.');
                } catch (err) {
                    return jsonResponse(response, 400, { error: 'Invalid amount: ' + err.message, code: 'INVALID_AMOUNT' });
                }
                try {
                    const result = await prepareNearPayment({
                        rpcUrl: config.near.rpcUrl,
                        relayContractId: config.near.relayContractId,
                        tokenId: body.tokenId,
                        receiverId: body.receiverId,
                        amountYocto: amountYocto.toString(),
                        intentStore: nearPaymentIntents,
                        fetchImpl,
                    });
                    const review = buildPaymentReviewSummary(result.plan, result.paymentRecord);
                    return jsonResponse(response, 200, {
                        prepared: true,
                        network: 'near-testnet',
                        architecture: 'NEAR_TESTNET_DIRECT_TRANSFER',
                        payment: result.paymentRecord,
                        transactionPlan: result.plan,
                        review,
                        currentState: {
                            blockHash: result.currentState.blockHash,
                            blockHeight: result.currentState.blockHeight,
                            ownerId: result.currentState.ownerId,
                            associatedAccountId: result.currentState.associatedAccountId,
                            lifecycle: result.currentState.lifecycle,
                            associatedAccount: serializeAssociatedAccount(result.currentState.associatedAccount),
                            receiverAccount: result.currentState.receiverAccount,
                            tokenNonce: result.currentState.tokenNonce,
                        },
                        notice: 'No transaction has been submitted. The NFT owner must sign the transactionPlan on NEAR Testnet.',
                    });
                } catch (err) {
                    if (err instanceof PaymentAuthorizationError) {
                        return jsonResponse(response, 400, { error: err.message, code: err.code, details: err.details });
                    }
                    console.error('[prepare-near] Unhandled error:', err.constructor?.name, err.message);
                    throw err;
                }
            }
            if (request.method === 'POST' && url.pathname === '/api/payment/verify-near') {
                const body = await readJsonBody(request);
                if (!config.near.relayContractId) {
                    return jsonResponse(response, 503, { error: 'RELAY_CONTRACT_ID is not configured.' });
                }
                const { paymentId, tokenId, transactionHash, expectedOwner, expectedReceiver, expectedAmountYocto } = body;
                if (!paymentId || typeof paymentId !== 'string' || !/^[a-zA-Z0-9._:-]{1,64}$/.test(paymentId)) {
                    return jsonResponse(response, 400, {
                        error: 'paymentId from a prepared payment is required. Prepare the payment again if the server restarted.',
                        code: 'MISSING_PAYMENT_ID',
                    });
                }
                if (tokenId && !TOKEN_ID_RE.test(tokenId)) {
                    return jsonResponse(response, 400, { error: 'Invalid RELAY token ID.' });
                }
                if (!transactionHash || !/^[1-9A-HJ-NP-Za-km-z]{40,55}$/.test(transactionHash)) {
                    return jsonResponse(response, 400, { error: 'Invalid NEAR transaction hash format.', code: 'INVALID_TX_HASH' });
                }
                try {
                    const verification = await verifyNearPaymentTransaction({
                        rpcUrl: config.near.rpcUrl,
                        relayContractId: config.near.relayContractId,
                        tokenId,
                        transactionHash,
                        expectedOwner,
                        expectedReceiver,
                        expectedAmountYocto,
                        paymentId,
                        intentStore: nearPaymentIntents,
                        fetchImpl,
                    });
                    if (verification.verified) {
                        const evidence = verification.evidence || {};
                        return jsonResponse(response, 200, {
                            verified: true,
                            finalized: true,
                            replayed: Boolean(verification.replayed),
                            state: NEAR_PAYMENT_STATES.Settled,
                            paymentId,
                            transactionHash,
                            evidence,
                            balances: evidence.balances || null,
                            explorerUrl: evidence.explorerUrl || ('https://testnet.nearblocks.io/txns/' + transactionHash),
                        });
                    } else if (verification.pending) {
                        return jsonResponse(response, 202, {
                            verified: false, pending: true,
                            state: NEAR_PAYMENT_STATES.SourceTransferPending,
                            paymentId, transactionHash, reason: verification.reason,
                        });
                    } else {
                        const recovery = Boolean(verification.recoveryRequired);
                        return jsonResponse(response, recovery ? 409 : 400, {
                            verified: false,
                            pending: false,
                            recoveryRequired: recovery,
                            state: recovery ? NEAR_PAYMENT_STATES.RecoveryRequired : NEAR_PAYMENT_STATES.Failed,
                            paymentId, transactionHash, reason: verification.reason,
                        });
                    }
                } catch (err) {
                    if (err instanceof PaymentAuthorizationError) {
                        const statusByCode = {
                            PAYMENT_INTENT_NOT_FOUND: 404,
                            PAYMENT_CONTEXT_MISMATCH: 409,
                            DUPLICATE_PAYMENT: 409,
                            AUTHORIZATION_EXPIRED: 410,
                            OWNERSHIP_MISMATCH: 409,
                            STALE_AUTHORIZATION: 409,
                            RPC_ERROR: 502,
                            ACCOUNT_READ_FAILED: 502,
                        };
                        return jsonResponse(response, statusByCode[err.code] || 400, {
                            error: err.message,
                            code: err.code,
                            details: err.details || null,
                        });
                    }
                    throw err;
                }
            }
            if (request.method === 'GET' && url.pathname === '/api/payment/intent') {
                const paymentId = url.searchParams.get('paymentId');
                if (!paymentId || !/^[a-zA-Z0-9._:-]{1,64}$/.test(paymentId)) {
                    return jsonResponse(response, 400, { error: 'A valid paymentId is required.' });
                }
                const intent = getNearPaymentIntent(paymentId, nearPaymentIntents);
                if (!intent) {
                    return jsonResponse(response, 404, {
                        error: 'This payment authorization is unknown or has expired on the server. Prepare a new payment.',
                        code: 'PAYMENT_INTENT_NOT_FOUND',
                    });
                }
                return jsonResponse(response, 200, { intent });
            }
            if (request.method === 'GET' && url.pathname.startsWith('/api/')) {
                return jsonResponse(response, 404, { error: 'API route not found.' });
            }
            if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/uploads/')) {
                const upload = resolveUploadFile(path.join(ROOT, 'data', 'uploads'), url.pathname);
                if (!upload) return jsonResponse(response, 404, { error: 'Not found.' });
                let content;
                try {
                    content = await fs.promises.readFile(upload.filePath);
                } catch (error) {
                    if (error.code === 'ENOENT') return jsonResponse(response, 404, { error: 'Not found.' });
                    throw error;
                }
                response.writeHead(200, {
                    'content-type': upload.contentType,
                    'content-length': content.length,
                    'cache-control': 'public, max-age=31536000, immutable',
                    'content-security-policy': "default-src 'none'; img-src 'self'; frame-ancestors 'none'",
                });
                return response.end(request.method === 'HEAD' ? undefined : content);
            }
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                return jsonResponse(response, 405, { error: 'Method not allowed.' });
            }
            const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
            const filePath = path.resolve(WEB_ROOT, relative);
            if (!filePath.startsWith(`${WEB_ROOT}${path.sep}`) && filePath !== path.join(WEB_ROOT, 'index.html')) {
                return jsonResponse(response, 400, { error: 'Invalid path.' });
            }
            let content;
            try {
                content = await fs.promises.readFile(filePath);
            } catch (error) {
                if (error.code === 'ENOENT' || error.code === 'EISDIR') return jsonResponse(response, 404, { error: 'Not found.' });
                throw error;
            }
            const acceptsGzip = /\bgzip\b/.test(String(request.headers['accept-encoding'] || ''));
            const compressible = COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath)) && content.length >= 1024;
            let body = content;
            const headers = {
                'content-type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
                'content-length': content.length,
                'cache-control': 'no-store',
                'content-security-policy': "default-src 'self'; connect-src 'self' https://rpc.testnet.near.org https://*.fastnear.com https://login.testnet.fast-auth.com https://*.fast-auth.com https://testnet.mynearwallet.com https://wallet.meteorwallet.app https://*.meteorwallet.app https://*.near.org https://*.near.social; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; frame-src https://login.testnet.fast-auth.com https://*.fast-auth.com https://testnet.mynearwallet.com https://wallet.meteorwallet.app; base-uri 'none'; frame-ancestors 'none'",
            };
            if (compressible && acceptsGzip) {
                body = await compressedStaticContent(filePath, content);
                headers['content-encoding'] = 'gzip';
                headers.vary = 'accept-encoding';
                headers['content-length'] = body.length;
            }
            response.writeHead(200, headers);
            return response.end(request.method === 'HEAD' ? undefined : body);
        } catch (error) {
            // A thrown auth/relayer error used to be masked as
            // "The requested integration did not respond successfully", which told
            // the user nothing and left no server trace. Log the real cause and
            // surface it: this is a local app, and the code names the failing step.
            const status = error.status || 502;
            const code = error.code || null;
            console.error(
                `[server] ${request.method} ${url.pathname} failed (${status}${code ? `, ${code}` : ''}):`,
                error.message,
            );
            return jsonResponse(response, status, {
                error: error.message || 'The request could not be completed.',
                code,
            });
        }
    });
    const originalClose = server.close.bind(server);
    server.close = function (cb) {
        if (journalPromise) {
            journalPromise.then((j) => j.close()).catch(() => {});
        }
        if (activityJournalPromise) {
            activityJournalPromise.then((j) => j.close()).catch(() => {});
        }
        return originalClose(cb);
    };
    return server;
}

if (require.main === module) {
    loadEnvFile(path.join(ROOT, '.env'));
    const config = createConfig();
    if (!config.valid) {
        for (const error of config.errors) console.error(`Configuration error: ${error}`);
        process.exitCode = 1;
    } else {
        const server = createAppServer({ config });
        const host = process.env.HOST || '0.0.0.0';
        server.listen(config.app.port, host, () => {
            console.log(`RELAY app listening at http://${host}:${config.app.port}`);
            console.log(`NEAR network: ${config.near.network}; contract configured: ${Boolean(config.near.relayContractId)}`);
            console.log('Google sign-in: NEAR Auth (Auth0 + MPC ed25519); gas sponsored by RELAY');
        });
    }
}

module.exports = {
    createAppServer,
    finalNearBlock,
    formatAccount,
    isAllowedLocalRequest,
    nearView,
    networkStatus,
    readJsonBody,
    verifyFinalizedTransferTransaction,
    verifyNearNetwork,
};
