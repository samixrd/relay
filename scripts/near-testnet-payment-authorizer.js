'use strict';

/**
 * RELAY Testnet-Native Payment Authorizer
 *
 * Implements owner-bound NEAR native payment authorization via the existing
 * relay_execute_subaccount → TransferNear path on relay.spellman.testnet.
 *
 * Security model:
 * - The NFT's current owner must authorize the payment.
 * - Payment is bound to the exact token ID and canonical associated account.
 * - The server verifies finalized NFT ownership immediately before preparing authorization.
 * - The receiver must be a valid NEAR Testnet account.
 * - The amount must be explicit and bounded within the spendable reserve.
 * - The subaccount always preserves its storage reserve.
 * - No arbitrary frontend-controlled contract/method execution.
 * - Nonces are monotonic (token_nonce advances on each relay_execute_subaccount call).
 * - Replay protection: paymentId must be unique per token and is permanently recorded.
 * - Base Sepolia is portfolio read-only: address derived via Chain Signatures epsilon
 *   derivation but no signing path is exposed (blocked until verified MPC infrastructure exists).
 *
 * Testnet-only. Never use this module with Mainnet credentials or contracts.
 *
 * 1Click / NEAR Intents routes are explicitly EXCLUDED from this module.
 * They require Mainnet-only provider endpoints and cannot execute on Testnet.
 */

const crypto = require('node:crypto');

const YOCTO_PER_NEAR = 10n ** 24n;
const STORAGE_COST_PER_BYTE = 10n ** 19n; // 10^19 yoctoNEAR per byte
const STORAGE_RESERVE_PADDING = YOCTO_PER_NEAR / 10n; // 0.1 NEAR safety buffer above storage reserve
const MIN_TRANSFER_YOCTO = YOCTO_PER_NEAR / 1000n; // 0.001 NEAR minimum
const MAX_TRANSFER_NEAR = 10n; // 10 NEAR maximum for testnet demo
const DEFAULT_AUTHORIZATION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MIN_AUTHORIZATION_TTL_MS = 60 * 1000; // 1 minute
const MAX_AUTHORIZATION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PAYMENT_ID_LEN = 64;
const PAYMENT_ID_RE = /^[a-zA-Z0-9._:-]{1,64}$/;
const NEAR_ACCOUNT_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
// Reject Ethereum-style hex addresses — these cannot be NEAR accounts in context of this demo
const ETH_HEX_PREFIX_RE = /^0x[0-9a-fA-F]+$/;

// Network / architecture constants
const TESTNET_NETWORK = 'testnet';
const TESTNET_RPC_URL = 'https://rpc.testnet.near.org';

// Known contract constants (from live testnet audit at block 276946165)
const CANONICAL_CONTRACT_ID = 'relay.spellman.testnet';
const CANONICAL_TOKEN_ID = 'relay-test-1';
const CANONICAL_ASSOCIATED_ACCOUNT = 'relay-test-1.relay.spellman.testnet';
const EXPECTED_PARENT_CODE_SHA256 = '2CB1AE95CDB0B6616D69A728BAD983093225A98B10526358BFE90AD9AD334B6F';
const EXPECTED_CONTROLLER_CODE_SHA256 = '762A821E16897303AB491E90E26F02FA466ED831008CE73C4EB27F3CB4F29242';

// Gas constants (must match relay_execute_subaccount internal allocations)
const EXECUTE_SUBACCOUNT_GAS_TGAS = 100n; // 100 TGas total attached
const EXECUTE_SUBACCOUNT_GAS = EXECUTE_SUBACCOUNT_GAS_TGAS * 10n ** 12n;
const EXECUTE_SUBACCOUNT_DEPOSIT_YOCTO = 0n; // No attached deposit

// Payment states
const NEAR_PAYMENT_STATES = Object.freeze({
    Draft: 'Draft',
    Prepared: 'Prepared',
    Authorized: 'Authorized',
    SourceTransferPending: 'SourceTransferPending',
    SourceTransferCompleted: 'SourceTransferCompleted',
    Settled: 'Settled',
    Failed: 'Failed',
    RecoveryRequired: 'RecoveryRequired',
});

class PaymentAuthorizationError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PaymentAuthorizationError';
        this.code = code;
        this.details = details;
    }
}

/**
 * Validates a NEAR account ID.
 */
function validateNearAccountId(accountId) {
    if (typeof accountId !== 'string') return false;
    if (accountId.length < 2 || accountId.length > 64) return false;
    // Reject Ethereum-style 0x hex strings — not valid NEAR accounts in this context
    if (ETH_HEX_PREFIX_RE.test(accountId)) return false;
    return NEAR_ACCOUNT_ID_RE.test(accountId);
}

/**
 * Formats yoctoNEAR as a human-readable NEAR string.
 */
function formatNear(yocto) {
    const value = BigInt(yocto);
    const whole = value / YOCTO_PER_NEAR;
    const fraction = (value % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''} NEAR`;
}

/**
 * Calculates the spendable balance after preserving the storage reserve.
 * Includes a 0.1 NEAR safety padding above the raw storage reserve cost.
 */
function calculateSpendableBalance(balanceYocto, storageUsageBytes) {
    const balance = BigInt(balanceYocto);
    const storageUsage = BigInt(storageUsageBytes);
    const rawStorageReserve = storageUsage * STORAGE_COST_PER_BYTE;
    const storageReserveWithPadding = rawStorageReserve + STORAGE_RESERVE_PADDING;
    const spendable = balance > storageReserveWithPadding ? balance - storageReserveWithPadding : 0n;
    // Return strings so the result is safe for JSON.stringify (BigInt is not JSON-serializable).
    return {
        balance: balance.toString(),
        storageUsage: storageUsage.toString(),
        rawStorageReserve: rawStorageReserve.toString(),
        storageReserveWithPadding: storageReserveWithPadding.toString(),
        spendable: spendable.toString(),
    };
}

/**
 * Generates a collision-resistant payment ID for a new payment.
 * Format: p-<tokenId>-<timestampMs>-<randomHex8>
 */
function generatePaymentId(tokenId) {
    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const base = `p-${tokenId}-${ts}-${rand}`;
    return base.slice(0, MAX_PAYMENT_ID_LEN);
}

/**
 * In-memory store for prepared payment intents.
 *
 * A payment intent is the server-side authorization context that binds:
 * payment ID, token, owner, canonical associated account, receiver, amount,
 * expected token nonce, and deadline. Verification refuses to attribute a
 * transaction to an intent unless every field matches.
 *
 * The store is intentionally process-local: an app restart invalidates
 * outstanding intents and forces the owner to prepare a fresh one. No
 * private material is stored here.
 */
function createPaymentIntentStore() {
    const intents = new Map();
    return {
        put(intent) {
            intents.set(intent.paymentId, Object.freeze({ ...intent }));
            return intents.get(intent.paymentId);
        },
        get(paymentId) {
            return intents.get(paymentId) || null;
        },
        update(paymentId, patch) {
            const current = intents.get(paymentId);
            if (!current) return null;
            const next = Object.freeze({
                ...current,
                ...patch,
                updatedAt: new Date().toISOString(),
            });
            intents.set(paymentId, next);
            return next;
        },
        clear() {
            intents.clear();
        },
        get size() {
            return intents.size;
        },
    };
}

const defaultPaymentIntentStore = createPaymentIntentStore();

function assertAuthorizationTtl(ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs < MIN_AUTHORIZATION_TTL_MS || ttlMs > MAX_AUTHORIZATION_TTL_MS) {
        throw new PaymentAuthorizationError(
            'INVALID_CONFIG',
            `Authorization TTL must be between ${MIN_AUTHORIZATION_TTL_MS} and ${MAX_AUTHORIZATION_TTL_MS} milliseconds.`
        );
    }
}

/**
 * Creates a small NEAR RPC client with a per-request timeout.
 * Never logs request bodies or credentials.
 */
function createRpcClient({ rpcUrl = TESTNET_RPC_URL, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    return function rpc(method, params) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 'payment-auth', method, params });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        return fetchImpl(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: controller.signal,
        }).then(async (res) => {
            clearTimeout(timer);
            if (!res.ok) throw new PaymentAuthorizationError('RPC_ERROR', `RPC HTTP ${res.status}`);
            const json = await res.json();
            if (json.error) throw new PaymentAuthorizationError('RPC_ERROR', json.error.message || 'RPC error');
            return json.result;
        }).catch((err) => {
            clearTimeout(timer);
            if (err instanceof PaymentAuthorizationError) throw err;
            throw new PaymentAuthorizationError('RPC_ERROR', `RPC request failed: ${err.message}`);
        });
    };
}

function viewCallAt(rpc, contractId, methodName, args, blockHash) {
    return rpc('query', {
        request_type: 'call_function',
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        block_id: blockHash,
    }).then((result) => JSON.parse(Buffer.from(result.result).toString('utf8')));
}

function viewAccountAt(rpc, accountId, blockHash) {
    return rpc('query', {
        request_type: 'view_account',
        account_id: accountId,
        block_id: blockHash,
    }).catch((err) => {
        throw new PaymentAuthorizationError(
            'ACCOUNT_READ_FAILED',
            `Could not read account '${accountId}' at block '${blockHash}': ${err.message}`
        );
    });
}

/**
 * Returns a JSON-safe public view of a payment intent.
 */
function serializePaymentIntent(intent) {
    if (!intent) return null;
    return JSON.parse(JSON.stringify(intent));
}

/**
 * Returns a payment intent by ID from a store.
 */
function getNearPaymentIntent(paymentId, intentStore = defaultPaymentIntentStore) {
    if (typeof paymentId !== 'string' || !PAYMENT_ID_RE.test(paymentId)) return null;
    return serializePaymentIntent(intentStore.get(paymentId));
}

/**
 * Verifies current finalized NFT ownership and returns account state.
 * Throws PaymentAuthorizationError on mismatch.
 */
async function verifyOwnershipAndState({
    rpcUrl = TESTNET_RPC_URL,
    relayContractId,
    tokenId,
    receiverId = null,
    fetchImpl = globalThis.fetch,
}) {
    function rpc(method, params) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 'payment-auth', method, params });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        return fetchImpl(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: controller.signal,
        }).then(async (res) => {
            clearTimeout(timer);
            if (!res.ok) throw new PaymentAuthorizationError('RPC_ERROR', `RPC HTTP ${res.status}`);
            const json = await res.json();
            if (json.error) throw new PaymentAuthorizationError('RPC_ERROR', json.error.message || 'RPC error');
            return json.result;
        }).catch((err) => {
            clearTimeout(timer);
            throw err;
        });
    }

    function viewCall(contractId, methodName, args) {
        return rpc('query', {
            request_type: 'call_function',
            account_id: contractId,
            method_name: methodName,
            args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
            block_id: blockHash,
        }).then((result) => JSON.parse(Buffer.from(result.result).toString('utf8')));
    }

    // Get finalized block
    const block = await rpc('block', { finality: 'final' });
    const blockHash = block.header.hash;
    const blockHeight = block.header.height;

    // Verify NEAR network
    const status = await rpc('status', []);
    if (status.chain_id !== TESTNET_NETWORK) {
        throw new PaymentAuthorizationError(
            'WRONG_NETWORK',
            `RPC endpoint reports network '${status.chain_id}'; expected '${TESTNET_NETWORK}'.`
        );
    }

    // Read NFT ownership at finalized block
    const [nftToken, binding, lifecycle, credits, tokenNonce] = await Promise.all([
        viewCall(relayContractId, 'nft_token', { token_id: tokenId }),
        viewCall(relayContractId, 'relay_account_binding', { token_id: tokenId }),
        viewCall(relayContractId, 'token_lifecycle', { token_id: tokenId }),
        viewCall(relayContractId, 'relay_credits', { token_id: tokenId }),
        viewCall(relayContractId, 'token_nonce', { token_id: tokenId }),
    ]);

    if (!nftToken) {
        throw new PaymentAuthorizationError('TOKEN_NOT_FOUND', `Token '${tokenId}' not found on contract '${relayContractId}'.`);
    }
    if (!binding || !binding.is_verified) {
        throw new PaymentAuthorizationError(
            'ACCOUNT_NOT_VERIFIED',
            `Associated account for token '${tokenId}' is not verified.`
        );
    }

    const associatedAccountId = binding.account_id;

    // Verify canonical binding
    const expectedAssociated = `${tokenId}.${relayContractId}`;
    if (associatedAccountId !== expectedAssociated) {
        throw new PaymentAuthorizationError(
            'BINDING_MISMATCH',
            `Associated account '${associatedAccountId}' does not match expected canonical account '${expectedAssociated}'.`
        );
    }

    if (lifecycle !== 'Unlocked') {
        throw new PaymentAuthorizationError(
            'TOKEN_LOCKED',
            `Token lifecycle is '${JSON.stringify(lifecycle)}'; cannot initiate payment while token is locked.`,
            { lifecycle }
        );
    }

    // Read associated account balance
    const assocAccount = await rpc('query', {
        request_type: 'view_account',
        account_id: associatedAccountId,
        block_id: blockHash,
    });

    const spendable = calculateSpendableBalance(assocAccount.amount, assocAccount.storage_usage);

    // Optionally read the receiver at the same finalized block. A receiver that
    // does not exist on-chain cannot receive a native transfer.
    let receiverAccount = null;
    if (receiverId) {
        try {
            const rawReceiver = await rpc('query', {
                request_type: 'view_account',
                account_id: receiverId,
                block_id: blockHash,
            });
            receiverAccount = {
                accountId: receiverId,
                balanceYocto: rawReceiver.amount,
                storageUsageBytes: rawReceiver.storage_usage,
                balanceFormatted: formatNear(rawReceiver.amount),
            };
        } catch (err) {
            if (err instanceof PaymentAuthorizationError && err.code === 'RPC_ERROR') {
                throw new PaymentAuthorizationError(
                    'RECEIVER_NOT_FOUND',
                    `Receiver '${receiverId}' does not exist on NEAR Testnet or could not be read.`,
                    { receiverId }
                );
            }
            throw err;
        }
    }

    return {
        blockHash,
        blockHeight,
        ownerId: nftToken.owner_id,
        tokenId,
        associatedAccountId,
        lifecycle,
        credits,
        tokenNonce,
        receiverAccount,
        associatedAccount: {
            balanceYocto: assocAccount.amount,
            storageUsageBytes: assocAccount.storage_usage,
            balance: spendable.balance,
            storageUsage: spendable.storageUsage,
            rawStorageReserve: spendable.rawStorageReserve,
            storageReserveWithPadding: spendable.storageReserveWithPadding,
            spendableYocto: spendable.spendable.toString(),
            spendableFormatted: formatNear(spendable.spendable),
        },
        contractCodeVerified: relayContractId === CANONICAL_CONTRACT_ID,
    };
}

/**
 * Prepares a NEAR native payment authorization plan.
 *
 * This validates all inputs and returns the exact transaction plan that the
 * NFT owner must sign and submit. No transaction is submitted by this function.
 *
 * The owner must call relay_execute_subaccount on the parent contract with
 * a TransferNear action pointing to the requested receiver and amount.
 *
 * @returns {Promise<{plan, state, paymentRecord}>}
 */
async function prepareNearPayment({
    rpcUrl = TESTNET_RPC_URL,
    relayContractId,
    tokenId,
    receiverId,
    amountYocto,
    paymentId = null,
    intentStore = defaultPaymentIntentStore,
    authorizationTtlMs = DEFAULT_AUTHORIZATION_TTL_MS,
    now = Date.now,
    fetchImpl = globalThis.fetch,
}) {
    assertAuthorizationTtl(authorizationTtlMs);

    // Input validation
    if (!relayContractId || typeof relayContractId !== 'string') {
        throw new PaymentAuthorizationError('INVALID_CONFIG', 'relayContractId is required.');
    }
    if (!tokenId || !NEAR_ACCOUNT_ID_RE.test(tokenId)) {
        throw new PaymentAuthorizationError('INVALID_TOKEN_ID', 'Invalid token ID.');
    }
    if (!receiverId || !validateNearAccountId(receiverId)) {
        throw new PaymentAuthorizationError('INVALID_RECEIVER', `Receiver '${receiverId}' is not a valid NEAR account ID.`);
    }

    let amountBigInt;
    try {
        amountBigInt = BigInt(amountYocto);
    } catch {
        throw new PaymentAuthorizationError('INVALID_AMOUNT', 'Amount must be an integer yoctoNEAR string.');
    }
    if (amountBigInt <= 0n) {
        throw new PaymentAuthorizationError('INVALID_AMOUNT', 'Amount must be positive.');
    }
    if (amountBigInt < MIN_TRANSFER_YOCTO) {
        throw new PaymentAuthorizationError(
            'AMOUNT_TOO_SMALL',
            `Transfer amount ${formatNear(amountBigInt)} is below the minimum ${formatNear(MIN_TRANSFER_YOCTO)}.`
        );
    }
    if (amountBigInt > MAX_TRANSFER_NEAR * YOCTO_PER_NEAR) {
        throw new PaymentAuthorizationError(
            'AMOUNT_TOO_LARGE',
            `Transfer amount ${formatNear(amountBigInt)} exceeds the testnet demo maximum of ${MAX_TRANSFER_NEAR} NEAR.`
        );
    }

    const resolvedPaymentId = paymentId || generatePaymentId(tokenId);
    if (!PAYMENT_ID_RE.test(resolvedPaymentId)) {
        throw new PaymentAuthorizationError('INVALID_PAYMENT_ID', 'Payment ID contains invalid characters.');
    }
    if (intentStore.get(resolvedPaymentId)) {
        throw new PaymentAuthorizationError('DUPLICATE_PAYMENT_ID', 'This payment ID has already been prepared.');
    }

    // Verify live testnet state (including the receiver account) at one finalized block.
    const state = await verifyOwnershipAndState({ rpcUrl, relayContractId, tokenId, receiverId, fetchImpl });

    // Receiver cannot be the associated account itself
    if (receiverId === state.associatedAccountId) {
        throw new PaymentAuthorizationError(
            'SELF_TRANSFER',
            `Receiver cannot be the associated subaccount itself (${state.associatedAccountId}).`
        );
    }

    // Check spendable balance
    if (amountBigInt > BigInt(state.associatedAccount.spendableYocto)) {
        throw new PaymentAuthorizationError(
            'INSUFFICIENT_BALANCE',
            `Requested amount ${formatNear(amountBigInt)} exceeds available spendable balance ${state.associatedAccount.spendableFormatted} ` +
            `(total: ${formatNear(state.associatedAccount.balanceYocto)}, storage reserve: ${formatNear(state.associatedAccount.storageReserveWithPadding)}).`,
            {
                requested: amountBigInt.toString(),
                spendable: state.associatedAccount.spendableYocto,
                storageReserve: state.associatedAccount.storageReserveWithPadding.toString(),
            }
        );
    }

    if (!state.receiverAccount) {
        throw new PaymentAuthorizationError('RECEIVER_NOT_FOUND', `Receiver '${receiverId}' could not be read from NEAR Testnet.`);
    }

    const preparedAtMs = typeof now === 'function' ? now() : now;
    const deadlineMs = preparedAtMs + authorizationTtlMs;

    // Build the exact transaction plan
    // The NFT owner must sign this transaction on the parent relay contract.
    // relay_execute_subaccount → TransferNear is the authorized path for native NEAR transfers.
    const plan = {
        network: TESTNET_NETWORK,
        contractId: relayContractId,
        methodName: 'relay_execute_subaccount',
        args: {
            token_id: tokenId,
            action: {
                TransferNear: {
                    receiver_id: receiverId,
                    amount: amountBigInt.toString(),
                },
            },
        },
        attachedDepositYocto: EXECUTE_SUBACCOUNT_DEPOSIT_YOCTO.toString(),
        attachedGasTGas: Number(EXECUTE_SUBACCOUNT_GAS_TGAS),
        requiredSigner: state.ownerId,
        note: 'The current NFT owner must sign this transaction. Only relay_execute_subaccount → TransferNear is used. No arbitrary calldata is accepted.',
    };

    const paymentRecord = {
        paymentId: resolvedPaymentId,
        state: NEAR_PAYMENT_STATES.Prepared,
        status: 'Prepared',
        network: TESTNET_NETWORK,
        relayContractId,
        tokenId,
        associatedAccountId: state.associatedAccountId,
        ownerId: state.ownerId,
        receiverId,
        amountYocto: amountBigInt.toString(),
        amountFormatted: formatNear(amountBigInt),
        currentTokenNonce: state.tokenNonce,
        expectedTokenNonce: String(state.tokenNonce),
        preparedAt: new Date(preparedAtMs).toISOString(),
        preparedAtBlock: state.blockHash,
        preparedAtBlockHeight: state.blockHeight,
        deadline: deadlineMs,
        deadlineIso: new Date(deadlineMs).toISOString(),
        receiverBalanceBeforeYocto: state.receiverAccount.balanceYocto,
        receiverBalanceBeforeFormatted: state.receiverAccount.balanceFormatted,
        associatedBalanceBeforeYocto: state.associatedAccount.balanceYocto,
        transactionHash: null,
        settledAt: null,
        evidence: null,
    };

    // Persist the intent in the server-side store. Verification will refuse to
    // attribute any transaction that does not match this exact context.
    intentStore.put({
        paymentId: resolvedPaymentId,
        status: 'Prepared',
        network: TESTNET_NETWORK,
        relayContractId,
        tokenId,
        ownerId: state.ownerId,
        associatedAccountId: state.associatedAccountId,
        receiverId,
        amountYocto: amountBigInt.toString(),
        amountFormatted: formatNear(amountBigInt),
        expectedTokenNonce: String(state.tokenNonce),
        preparedAt: paymentRecord.preparedAt,
        preparedAtBlock: state.blockHash,
        preparedAtBlockHeight: state.blockHeight,
        deadline: deadlineMs,
        deadlineIso: paymentRecord.deadlineIso,
        receiverBalanceBeforeYocto: state.receiverAccount.balanceYocto,
        associatedBalanceBeforeYocto: state.associatedAccount.balanceYocto,
        associatedStorageUsageBefore: String(state.associatedAccount.storageUsageBytes),
        storageReserveWithPadding: state.associatedAccount.storageReserveWithPadding,
        plan,
        transactionHash: null,
        submittedAt: null,
        settledAt: null,
        failureCode: null,
        evidence: null,
    });

    return {
        plan,
        paymentRecord,
        currentState: state,
        mainnetOneClickStatus: 'DISABLED_FOR_TESTNET',
        mainnetOneClickReason: '1Click provider does not support Testnet routes. Direct NEAR native transfer via relay_execute_subaccount → TransferNear is used instead.',
    };
}

/**
 * Verifies a finalized NEAR native payment transaction.
 *
 * Verifies:
 * 1. Transaction hash exists and is finalized on NEAR Testnet.
 * 2. The signer is the expected NFT owner (not any other account).
 * 3. The transaction receiver is the relay parent contract.
 * 4. The method called is relay_execute_subaccount.
 * 5. The action is TransferNear with the correct receiver and amount.
 * 6. The receiver's balance increased by at least the expected amount
 *    (confirmed via finalized state read after the transaction).
 * 7. No receipt failures.
 *
 * @returns {Promise<{verified, state, evidence}>}
 */
async function verifyNearPaymentTransaction({
    rpcUrl = TESTNET_RPC_URL,
    relayContractId,
    tokenId,
    transactionHash,
    expectedOwner,
    expectedReceiver,
    expectedAmountYocto,
    paymentId = null,
    intentStore = defaultPaymentIntentStore,
    fetchImpl = globalThis.fetch,
}) {
    if (!transactionHash || typeof transactionHash !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{40,55}$/.test(transactionHash)) {
        throw new PaymentAuthorizationError('INVALID_TX_HASH', 'Invalid NEAR transaction hash format.');
    }

    // ─────────────────────────────────────────────────────────────────────
    // Intent-bound verification (used by the HTTP route and browser UI)
    // ───────────────────────────────────────────────────────���─────────────
    let intent = null;
    if (paymentId) {
        intent = intentStore.get(paymentId);
        if (!intent) {
            throw new PaymentAuthorizationError(
                'PAYMENT_INTENT_NOT_FOUND',
                'This payment authorization is unknown or has expired on the server. Prepare a new payment.'
            );
        }
        if (relayContractId && intent.relayContractId !== relayContractId) {
            throw new PaymentAuthorizationError('PAYMENT_CONTEXT_MISMATCH', 'Relay contract does not match the prepared payment.');
        }
        if (tokenId && intent.tokenId !== tokenId) {
            throw new PaymentAuthorizationError('PAYMENT_CONTEXT_MISMATCH', 'Token ID does not match the prepared payment.');
        }
        if (expectedOwner && expectedOwner !== intent.ownerId) {
            throw new PaymentAuthorizationError('PAYMENT_CONTEXT_MISMATCH', 'Owner does not match the prepared payment.');
        }
        if (expectedReceiver && expectedReceiver !== intent.receiverId) {
            throw new PaymentAuthorizationError('PAYMENT_CONTEXT_MISMATCH', 'Receiver does not match the prepared payment.');
        }
        if (expectedAmountYocto && String(expectedAmountYocto) !== intent.amountYocto) {
            throw new PaymentAuthorizationError('PAYMENT_CONTEXT_MISMATCH', 'Amount does not match the prepared payment.');
        }

        // Server-side context always wins over client-supplied values.
        relayContractId = intent.relayContractId;
        tokenId = intent.tokenId;
        expectedOwner = intent.ownerId;
        expectedReceiver = intent.receiverId;
        expectedAmountYocto = intent.amountYocto;

        if (intent.status === 'Settled') {
            if (intent.transactionHash === transactionHash) {
                // Idempotent re-verification of the same finalized payment.
                return {
                    verified: true,
                    pending: false,
                    replayed: true,
                    state: NEAR_PAYMENT_STATES.Settled,
                    paymentId,
                    evidence: intent.evidence,
                    transactionHash,
                };
            }
            throw new PaymentAuthorizationError(
                'DUPLICATE_PAYMENT',
                'This payment authorization is already settled by a different transaction. A second transfer was not accepted.'
            );
        }
        if (intent.transactionHash && intent.transactionHash !== transactionHash) {
            throw new PaymentAuthorizationError(
                'DUPLICATE_PAYMENT',
                'A different transaction hash is already associated with this payment authorization. Refusing to attribute a second transfer.'
            );
        }
    }

    // Fetch transaction with final status
    let txResponse;
    try {
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: 'verify-payment',
            method: 'tx',
            params: {
                tx_hash: transactionHash,
                sender_account_id: expectedOwner,
                wait_until: 'FINAL',
            },
        });
        const res = await fetchImpl(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
        });
        if (!res.ok) {
            throw new PaymentAuthorizationError('RPC_ERROR', `RPC HTTP ${res.status} when fetching transaction.`);
        }
        txResponse = await res.json();
    } catch (err) {
        if (err.code === 'RPC_ERROR') throw err;
        return {
            verified: false,
            pending: true,
            reason: `Transaction lookup failed or timed out: ${err.message}`,
            transactionHash,
            paymentId,
        };
    }

    if (txResponse.error) {
        return {
            verified: false,
            pending: true,
            reason: `Transaction not found or still processing: ${txResponse.error.message || JSON.stringify(txResponse.error)}`,
            transactionHash,
            paymentId,
        };
    }

    const txResult = txResponse.result;
    if (!txResult || !txResult.transaction) {
        return {
            verified: false,
            pending: true,
            reason: 'Transaction details not yet available on RPC.',
            transactionHash,
            paymentId,
        };
    }

    const tx = txResult.transaction;

    // 1. Verify signer is the expected owner
    if (tx.signer_id !== expectedOwner) {
        return {
            verified: false,
            pending: false,
            reason: `Transaction signer '${tx.signer_id}' does not match expected owner '${expectedOwner}'.`,
            transactionHash,
            paymentId,
        };
    }

    // 2. Verify receiver is the relay contract
    if (tx.receiver_id !== relayContractId) {
        return {
            verified: false,
            pending: false,
            reason: `Transaction receiver '${tx.receiver_id}' does not match relay contract '${relayContractId}'.`,
            transactionHash,
            paymentId,
        };
    }

    // 3. Verify exactly one action
    const actions = tx.actions || [];
    if (actions.length !== 1 || !actions[0]?.FunctionCall) {
        return {
            verified: false,
            pending: false,
            reason: `Expected exactly 1 FunctionCall action; found ${actions.length} action(s).`,
            transactionHash,
            paymentId,
        };
    }

    const fc = actions[0].FunctionCall;

    // 4. Verify method name
    if (fc.method_name !== 'relay_execute_subaccount') {
        return {
            verified: false,
            pending: false,
            reason: `Method '${fc.method_name}' is not 'relay_execute_subaccount'.`,
            transactionHash,
            paymentId,
        };
    }

    // 5. Decode and verify arguments
    let decodedArgs;
    try {
        decodedArgs = JSON.parse(Buffer.from(fc.args, 'base64').toString('utf8'));
    } catch {
        return {
            verified: false,
            pending: false,
            reason: 'Failed to decode relay_execute_subaccount arguments.',
            transactionHash,
            paymentId,
        };
    }

    if (decodedArgs.token_id !== tokenId) {
        return {
            verified: false,
            pending: false,
            reason: `Argument token_id '${decodedArgs.token_id}' does not match expected '${tokenId}'.`,
            transactionHash,
            paymentId,
        };
    }

    const transferNearAction = decodedArgs.action?.TransferNear;
    if (!transferNearAction) {
        return {
            verified: false,
            pending: false,
            reason: 'Transaction action is not a TransferNear action.',
            transactionHash,
            paymentId,
        };
    }

    if (transferNearAction.receiver_id !== expectedReceiver) {
        return {
            verified: false,
            pending: false,
            reason: `TransferNear receiver '${transferNearAction.receiver_id}' does not match expected receiver '${expectedReceiver}'.`,
            transactionHash,
            paymentId,
        };
    }

    // Amount: NearToken in Rust serializes as { "amount": "N" } or just "N" depending on version
    // The contract uses NearToken which serializes to yoctoNEAR as a string
    const submittedAmount = typeof transferNearAction.amount === 'string'
        ? transferNearAction.amount
        : (transferNearAction.amount?.amount || transferNearAction.amount?.toString() || null);

    if (!submittedAmount || BigInt(submittedAmount) < BigInt(expectedAmountYocto)) {
        return {
            verified: false,
            pending: false,
            reason: `TransferNear amount '${submittedAmount}' is less than expected '${expectedAmountYocto}'.`,
            transactionHash,
            paymentId,
        };
    }

    // 6. Check for receipt failures
    const receiptsOutcome = txResult.receipts_outcome || [];
    const hasFailure = receiptsOutcome.some((ro) => ro.outcome?.status?.Failure !== undefined);
    if (hasFailure) {
        const failureReceipt = receiptsOutcome.find((ro) => ro.outcome?.status?.Failure !== undefined);
        if (intent) {
            intentStore.update(paymentId, { status: 'Failed', failureCode: 'RECEIPT_FAILED', transactionHash });
        }
        return {
            verified: false,
            pending: false,
            recoveryRequired: Boolean(intent),
            reason: `Receipt execution failed: ${JSON.stringify(failureReceipt?.outcome?.status?.Failure)}.`,
            transactionHash,
            paymentId,
        };
    }

    // 7. Verify finality — only accept NEAR's authoritative FINAL execution status
    // Note: txResult.status.SuccessValue reflects the top-level action result but
    // is present even before all receipts are finalized. Use final_execution_status.
    const finalStatus = txResult.final_execution_status;
    const isSuccess = finalStatus === 'FINAL';

    if (!isSuccess) {
        return {
            verified: false,
            pending: true,
            reason: `Transaction outcome '${finalStatus || 'UNKNOWN'}' is not yet final.`,
            transactionHash,
            paymentId,
        };
    }

    // Legacy evidence path: no prepared intent supplied.
    if (!intent) {
        const evidence = {
            transactionHash,
            signerVerified: tx.signer_id,
            receiverContract: tx.receiver_id,
            methodVerified: 'relay_execute_subaccount',
            tokenIdVerified: tokenId,
            actionVerified: 'TransferNear',
            receiverVerified: expectedReceiver,
            amountVerified: submittedAmount,
            finalExecutionStatus: finalStatus,
            receiptCount: receiptsOutcome.length,
            explorerUrl: `https://testnet.nearblocks.io/txns/${transactionHash}`,
        };

        return {
            verified: true,
            pending: false,
            state: NEAR_PAYMENT_STATES.Settled,
            evidence,
            transactionHash,
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Intent-bound on-chain evidence. The transaction must be attributable
    // to the exact prepared context and every balance/nonce check must pass.
    // ─────────────────────────────────────────────────────────────────────
    const txOutcome = txResult.transaction_outcome;
    if (!txOutcome || !txOutcome.block_hash) {
        throw new PaymentAuthorizationError('RPC_ERROR', 'Transaction outcome is missing its inclusion block.');
    }

    // Bind this transaction hash to the intent as soon as its contents match.
    if (!intent.transactionHash) {
        intent = intentStore.update(paymentId, {
            transactionHash,
            submittedAt: new Date().toISOString(),
            status: 'Submitted',
        });
    }

    const rpc = createRpcClient({ rpcUrl, fetchImpl });

    const inclusionBlock = await rpc('block', { block_id: txOutcome.block_hash });
    const inclusionTimestampMs = Number(BigInt(inclusionBlock.header.timestamp) / 1_000_000n);

    // Deadline is evaluated against the block that included the transaction,
    // not against the verification time. A late verification of an in-window
    // transaction is valid; an authorization used after its deadline is not.
    if (inclusionTimestampMs > intent.deadline) {
        intentStore.update(paymentId, { status: 'Failed', failureCode: 'AUTHORIZATION_EXPIRED' });
        throw new PaymentAuthorizationError(
            'AUTHORIZATION_EXPIRED',
            `This authorization expired at ${intent.deadlineIso}; the transaction was included at ${new Date(inclusionTimestampMs).toISOString()}.`,
            { deadline: intent.deadlineIso, includedAt: new Date(inclusionTimestampMs).toISOString() }
        );
    }

    // Owner at the inclusion block must be the owner that prepared the intent.
    const ownerAtExecution = await viewCallAt(
        rpc,
        intent.relayContractId,
        'nft_token',
        { token_id: intent.tokenId },
        txOutcome.block_hash
    );
    if (!ownerAtExecution || ownerAtExecution.owner_id !== intent.ownerId) {
        intentStore.update(paymentId, { status: 'Failed', failureCode: 'OWNERSHIP_MISMATCH' });
        throw new PaymentAuthorizationError(
            'OWNERSHIP_MISMATCH',
            `NFT owner at execution block was '${ownerAtExecution?.owner_id || 'unknown'}', not the authorizing owner '${intent.ownerId}'.`,
            { ownerAtExecution: ownerAtExecution?.owner_id || null }
        );
    }

    // The finalized state after the payment is the highest receipt block.
    let afterBlock = inclusionBlock;
    for (const receiptBlockHash of new Set(receiptsOutcome.map((ro) => ro.block_hash).filter(Boolean))) {
        const receiptBlock = await rpc('block', { block_id: receiptBlockHash });
        if (receiptBlock.header.height > afterBlock.header.height) afterBlock = receiptBlock;
    }

    const [nonceBeforeRaw, nonceAfterRaw, assocBefore, assocAfter, receiverBefore, receiverAfter] = await Promise.all([
        viewCallAt(rpc, intent.relayContractId, 'token_nonce', { token_id: intent.tokenId }, txOutcome.block_hash),
        viewCallAt(rpc, intent.relayContractId, 'token_nonce', { token_id: intent.tokenId }, afterBlock.header.hash),
        viewAccountAt(rpc, intent.associatedAccountId, txOutcome.block_hash),
        viewAccountAt(rpc, intent.associatedAccountId, afterBlock.header.hash),
        viewAccountAt(rpc, intent.receiverId, txOutcome.block_hash),
        viewAccountAt(rpc, intent.receiverId, afterBlock.header.hash),
    ]);

    const nonceBefore = String(nonceBeforeRaw);
    const nonceAfter = String(nonceAfterRaw);

    if (nonceBefore !== String(intent.expectedTokenNonce)) {
        intentStore.update(paymentId, { status: 'Failed', failureCode: 'STALE_AUTHORIZATION' });
        throw new PaymentAuthorizationError(
            'STALE_AUTHORIZATION',
            `The token nonce at execution (${nonceBefore}) does not match the prepared authorization nonce (${intent.expectedTokenNonce}). Prepare a new payment.`
        );
    }
    if (BigInt(nonceAfter) <= BigInt(nonceBefore)) {
        intentStore.update(paymentId, { status: 'RecoveryRequired', failureCode: 'NONCE_NOT_ADVANCED' });
        return {
            verified: false,
            pending: false,
            recoveryRequired: true,
            reason: 'The payment transaction finalized but the token nonce did not advance. Payment execution is ambiguous.',
            transactionHash,
            paymentId,
            state: NEAR_PAYMENT_STATES.RecoveryRequired,
        };
    }

    const amountBigInt = BigInt(intent.amountYocto);
    const associatedBeforeYocto = BigInt(assocBefore.amount);
    const associatedAfterYocto = BigInt(assocAfter.amount);
    const receiverBeforeYocto = BigInt(receiverBefore.amount);
    const receiverAfterYocto = BigInt(receiverAfter.amount);
    const associatedDeltaYocto = associatedAfterYocto - associatedBeforeYocto;
    const receiverDeltaYocto = receiverAfterYocto - receiverBeforeYocto;

    const associatedDebited = associatedDeltaYocto <= -amountBigInt;
    const receiverCredited = receiverDeltaYocto >= amountBigInt;
    const storageReservePreserved = associatedAfterYocto >= BigInt(intent.storageReserveWithPadding);

    if (!associatedDebited || !receiverCredited || !storageReservePreserved) {
        intentStore.update(paymentId, { status: 'RecoveryRequired', failureCode: 'BALANCE_EVIDENCE_MISMATCH' });
        return {
            verified: false,
            pending: false,
            recoveryRequired: true,
            state: NEAR_PAYMENT_STATES.RecoveryRequired,
            reason:
                `Finalized balance evidence did not match the intent. ` +
                `Subaccount delta ${associatedDeltaYocto.toString()} yocto (expected <= -${intent.amountYocto}), ` +
                `receiver delta ${receiverDeltaYocto.toString()} yocto (expected >= ${intent.amountYocto}), ` +
                `storage reserve preserved: ${storageReservePreserved}.`,
            transactionHash,
            paymentId,
        };
    }

    const evidence = {
        paymentId,
        transactionHash,
        network: 'NEAR Testnet',
        asset: 'native NEAR (Testnet)',
        architecture: 'NEAR_TESTNET_DIRECT_TRANSFER',
        signerVerified: tx.signer_id,
        receiverContract: tx.receiver_id,
        methodVerified: 'relay_execute_subaccount',
        tokenIdVerified: tokenId,
        actionVerified: 'TransferNear',
        ownerAtExecution: ownerAtExecution.owner_id,
        subaccount: intent.associatedAccountId,
        receiverVerified: expectedReceiver,
        amountVerified: submittedAmount,
        amountFormatted: formatNear(submittedAmount),
        finalExecutionStatus: finalStatus,
        finalized: true,
        receiptCount: receiptsOutcome.length,
        receiptFailures: 0,
        authorizationDeadline: intent.deadlineIso,
        nonceBefore,
        nonceAfter,
        storageReserveAfterYocto: intent.storageReserveWithPadding,
        storageReservePreserved,
        inclusionBlock: {
            height: inclusionBlock.header.height,
            hash: inclusionBlock.header.hash,
            timestamp: new Date(inclusionTimestampMs).toISOString(),
        },
        finalizedBlock: {
            height: afterBlock.header.height,
            hash: afterBlock.header.hash,
        },
        balances: {
            associated: {
                beforeYocto: associatedBeforeYocto.toString(),
                afterYocto: associatedAfterYocto.toString(),
                deltaYocto: associatedDeltaYocto.toString(),
                beforeFormatted: formatNear(associatedBeforeYocto),
                afterFormatted: formatNear(associatedAfterYocto),
                deltaFormatted: `${associatedDeltaYocto < 0n ? '-' : '+'}${formatNear(associatedDeltaYocto < 0n ? -associatedDeltaYocto : associatedDeltaYocto)}`,
            },
            receiver: {
                beforeYocto: receiverBeforeYocto.toString(),
                afterYocto: receiverAfterYocto.toString(),
                deltaYocto: receiverDeltaYocto.toString(),
                beforeFormatted: formatNear(receiverBeforeYocto),
                afterFormatted: formatNear(receiverAfterYocto),
                deltaFormatted: `${receiverDeltaYocto < 0n ? '-' : '+'}${formatNear(receiverDeltaYocto < 0n ? -receiverDeltaYocto : receiverDeltaYocto)}`,
            },
        },
        receiverBalanceDeltaVerified: receiverCredited,
        subaccountDebitVerified: associatedDebited,
        explorerUrl: `https://testnet.nearblocks.io/txns/${transactionHash}`,
    };

    intentStore.update(paymentId, {
        status: 'Settled',
        settledAt: new Date().toISOString(),
        transactionHash,
        evidence,
    });

    return {
        verified: true,
        pending: false,
        state: NEAR_PAYMENT_STATES.Settled,
        paymentId,
        evidence,
        transactionHash,
    };
}

/**
 * Builds the transaction plan description for display in UI review screens.
 * Does not submit any transaction.
 */
function buildPaymentReviewSummary(plan, paymentRecord) {
    return {
        reviewRequired: true,
        network: 'NEAR Testnet',
        networkLabel: '🌐 NEAR Testnet',
        route: 'Direct native NEAR transfer via relay_execute_subaccount → TransferNear',
        architecture: 'NEAR_TESTNET_DIRECT_TRANSFER',
        payment: {
            id: paymentRecord.paymentId,
            tokenId: paymentRecord.tokenId,
            associatedAccount: paymentRecord.associatedAccountId,
            owner: paymentRecord.ownerId,
            receiver: paymentRecord.receiverId,
            amount: paymentRecord.amountFormatted,
            amountYocto: paymentRecord.amountYocto,
            expectedTokenNonce: paymentRecord.expectedTokenNonce,
            deadline: paymentRecord.deadlineIso || null,
            status: paymentRecord.status || 'Prepared',
        },
        transaction: {
            contract: plan.contractId,
            method: plan.methodName,
            signer: plan.requiredSigner,
            gasAllocated: `${plan.attachedGasTGas} TGas`,
            depositAttached: '0 yoctoNEAR',
            args: plan.args,
        },
        security: {
            ownerBound: true,
            tokenBound: true,
            storageReservePreserved: true,
            noArbitraryCalldata: true,
            authorizationNonceBound: true,
            authorizationDeadlineBound: true,
            replayProtected: 'Owner-signed transaction, server intent paymentId, and monotonic token_nonce',
        },
        mainnetOneClick: {
            status: 'DISABLED',
            reason: '1Click provider endpoints are Mainnet-only and cannot execute on NEAR Testnet.',
        },
        baseSepolia: {
            status: 'PORTFOLIO_READ_ONLY',
            reason: 'Base Sepolia signing requires verified Chain Signatures MPC infrastructure. Only balance reading is currently supported.',
        },
        warnings: [
            'This transaction will transfer real testnet NEAR from the associated subaccount.',
            'Testnet NEAR has no monetary value.',
            'The NFT owner must sign the transaction on the NEAR Testnet.',
        ],
    };
}

module.exports = {
    CANONICAL_ASSOCIATED_ACCOUNT,
    CANONICAL_CONTRACT_ID,
    CANONICAL_TOKEN_ID,
    DEFAULT_AUTHORIZATION_TTL_MS,
    EXECUTE_SUBACCOUNT_GAS,
    EXECUTE_SUBACCOUNT_GAS_TGAS,
    EXPECTED_CONTROLLER_CODE_SHA256,
    EXPECTED_PARENT_CODE_SHA256,
    MAX_AUTHORIZATION_TTL_MS,
    MAX_TRANSFER_NEAR,
    MIN_AUTHORIZATION_TTL_MS,
    MIN_TRANSFER_YOCTO,
    NEAR_PAYMENT_STATES,
    PaymentAuthorizationError,
    STORAGE_COST_PER_BYTE,
    STORAGE_RESERVE_PADDING,
    TESTNET_NETWORK,
    YOCTO_PER_NEAR,
    buildPaymentReviewSummary,
    calculateSpendableBalance,
    createPaymentIntentStore,
    defaultPaymentIntentStore,
    formatNear,
    generatePaymentId,
    getNearPaymentIntent,
    prepareNearPayment,
    serializePaymentIntent,
    validateNearAccountId,
    verifyNearPaymentTransaction,
    verifyOwnershipAndState,
};
