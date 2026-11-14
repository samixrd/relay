'use strict';

/**
 * NEAR Auth relayer and sponsor.
 *
 * The user never needs NEAR or a browser wallet. A transaction is prepared
 * server-side, the user authorizes the exact bytes through Auth0, and this
 * module:
 *
 *   1. validates the Auth0 signing JWT and proves its `fatxn` claim is the
 *      prepared transaction (byte for byte),
 *   2. pays for `fast-auth.testnet.sign` from the RELAY sponsor account,
 *   3. recovers the MPC ed25519 signature, verifies it against the user key,
 *   4. broadcasts the user-signed transaction (the account signer is the user,
 *      not the sponsor), and
 *   5. reads the finalized result.
 *
 * Gas sponsorship is limited by explicit hourly and lifetime-per-account
 * budgets. The sponsor never signs on behalf of the user: the outer transaction
 * is always signed by the MPC key that Auth0 unlocked.
 */

const crypto = require('node:crypto');
const nacl = require('tweetnacl');
const {
    Account,
    JsonRpcProvider,
    KeyPair,
    KeyPairSigner,
    PublicKey,
    Signature,
    SignedTransaction,
    actions,
    baseDecode,
    baseEncode,
    createTransaction,
    encodeTransaction,
    KeyType,
} = require('near-api-js');
const {
    AUTH_GUARD_ID,
    AUTH_ISSUER,
    AUTH_SIGNING_AUDIENCE,
    FAST_AUTH_CONTRACT_ID,
    MPC_CONTRACT_ID,
    normalizeNearPublicKey,
} = require('./near-auth-identity');

const YOCTO_PER_NEAR = 10n ** 24n;
const ONE_TGAS = 10n ** 12n;
const DEFAULT_GAS = 100n * ONE_TGAS;
const AUTH_SIGN_GAS = 100n * ONE_TGAS;
const AUTH_SIGN_DEPOSIT = 10_000_000_000_000_000_000_000n; // 0.01 NEAR, refunded by fast-auth
const DEFAULT_ACCOUNT_BALANCE = 250_000_000_000_000_000_000_000n; // 0.25 NEAR
const DEFAULT_GAS_RESERVE = 150_000_000_000_000_000_000_000n; // 0.15 NEAR
const DEFAULT_MAX_TOP_UP = 2_000_000_000_000_000_000_000_000n; // 2 NEAR
const DEFAULT_HOURLY_BUDGET = 5_000_000_000_000_000_000_000_000n; // 5 NEAR
const DEFAULT_ACCOUNT_BUDGET = 3_000_000_000_000_000_000_000_000n; // 3 NEAR
const MAX_SIGN_PAYLOAD_BYTES = 32 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const ACCOUNT_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function failure(message, code = 'NEAR_AUTH_RELAYER_ERROR') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isAccountId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 64 && ACCOUNT_ID_RE.test(value);
}

function normalizePrivateKey(value) {
    if (typeof value !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(value.trim())) {
        throw failure('Sponsor private key must be an ed25519 NEAR key.', 'SPONSOR_KEY');
    }
    try {
        return KeyPair.fromString(value.trim());
    } catch {
        throw failure('Sponsor private key is invalid.', 'SPONSOR_KEY');
    }
}

function toByteArray(value, label = 'payload') {
    if (!Array.isArray(value)) {
        throw failure(`${label} must be a byte array.`, 'SIGN_PAYLOAD');
    }
    if (value.length === 0 || value.length > MAX_SIGN_PAYLOAD_BYTES) {
        throw failure(`${label} has an invalid length.`, 'SIGN_PAYLOAD');
    }
    const bytes = Buffer.alloc(value.length);
    for (let index = 0; index < value.length; index += 1) {
        const byte = value[index];
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
            throw failure(`${label} contains a non-byte value.`, 'SIGN_PAYLOAD');
        }
        bytes[index] = byte;
    }
    return bytes;
}

function decodeJwtClaims(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_BYTES) {
        throw failure('Auth0 signing token is missing or too large.', 'SIGN_TOKEN_MISSING');
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw failure('Auth0 signing token is not a compact JWS.', 'SIGN_TOKEN_MALFORMED');
    }
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        throw failure('Auth0 signing token payload is invalid.', 'SIGN_TOKEN_MALFORMED');
    }
}

/**
 * Validates the Auth0 signature request returned by the FastAuth browser SDK.
 * The guard contract is the final verifier; these checks stop the relayer from
 * forwarding tokens for another service or a different transaction.
 */
function validateSignatureRequest({ guardId, verifyPayload, signPayload }, { now = Date.now } = {}) {
    if (guardId !== AUTH_GUARD_ID) {
        throw failure('Signing request uses an unexpected Auth0 guard.', 'SIGN_GUARD');
    }
    const payload = toByteArray(signPayload, 'signPayload');
    const claims = decodeJwtClaims(verifyPayload);
    if (claims.iss !== AUTH_ISSUER) {
        throw failure('Auth0 signing token issuer is unexpected.', 'SIGN_ISSUER');
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(AUTH_SIGNING_AUDIENCE)) {
        throw failure('Auth0 signing token audience is unexpected.', 'SIGN_AUDIENCE');
    }
    if (typeof claims.exp !== 'number' || claims.exp * 1000 + 60_000 < now()) {
        throw failure('Auth0 signing token has expired.', 'SIGN_EXPIRED');
    }
    if (typeof claims.sub !== 'string' || !claims.sub) {
        throw failure('Auth0 signing token has no subject.', 'SIGN_SUBJECT');
    }
    const claimedBytes = toByteArray(claims.fatxn, 'fatxn claim');
    if (!claimedBytes.equals(payload)) {
        throw failure('Auth0 signed payload does not match the declared sign payload.', 'SIGN_PAYLOAD_MISMATCH');
    }
    return { claims, payload, sub: claims.sub };
}

function transactionBytes(transaction) {
    return Buffer.from(encodeTransaction(transaction));
}

function verifyUserSignature({ bytes, signature, publicKey }) {
    const key = normalizeNearPublicKey(publicKey);
    if (!key || !key.startsWith('ed25519:')) {
        throw failure('A valid ed25519 public key is required.', 'USER_KEY');
    }
    if (!Buffer.isBuffer(signature) || signature.length !== 64) {
        throw failure('MPC signature must be 64 bytes.', 'USER_SIGNATURE');
    }
    let decoded;
    try {
        decoded = PublicKey.from(key).data;
    } catch {
        throw failure('User public key is invalid.', 'USER_KEY');
    }
    const digest = crypto.createHash('sha256').update(bytes).digest();
    if (!nacl.sign.detached.verify(digest, signature, decoded)) {
        throw failure('MPC signature does not verify against the user public key.', 'USER_SIGNATURE');
    }
    return true;
}

function extractAuthSignature(result) {
    const receipts = Array.isArray(result?.receipts_outcome) ? result.receipts_outcome : [];
    for (let index = receipts.length - 1; index >= 0; index -= 1) {
        const success = receipts[index]?.outcome?.status?.SuccessValue;
        if (typeof success !== 'string') continue;
        let parsed;
        try {
            parsed = JSON.parse(Buffer.from(success, 'base64').toString('utf8'));
        } catch {
            continue;
        }
        const raw = parsed?.signature ?? parsed?.EdDsa?.signature ?? parsed?.eddsa?.signature;
        if (!Array.isArray(raw) || raw.length !== 64) continue;
        if (raw.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) continue;
        return Buffer.from(raw);
    }
    return null;
}

function outcomeFailed(result) {
    if (!result) return true;
    if (result.final_execution_status && result.final_execution_status !== 'FINAL') return false;
    const receipts = Array.isArray(result.receipts_outcome) ? result.receipts_outcome : [];
    return Boolean(result.status?.Failure) || receipts.some((receipt) => receipt?.outcome?.status?.Failure);
}

function lastSuccessValue(result) {
    const receipts = Array.isArray(result?.receipts_outcome) ? result.receipts_outcome : [];
    for (let index = receipts.length - 1; index >= 0; index -= 1) {
        const success = receipts[index]?.outcome?.status?.SuccessValue;
        if (typeof success === 'string') {
            try {
                return JSON.parse(Buffer.from(success, 'base64').toString('utf8'));
            } catch {
                return null;
            }
        }
    }
    return null;
}

class SponsorBudget {
    constructor({ hourlyLimitYocto = DEFAULT_HOURLY_BUDGET, accountLimitYocto = DEFAULT_ACCOUNT_BUDGET, now = Date.now } = {}) {
        this.hourlyLimit = BigInt(hourlyLimitYocto);
        this.accountLimit = BigInt(accountLimitYocto);
        this.now = now;
        this.events = [];
        this.perAccount = new Map();
    }

    record(accountId, yocto) {
        const amount = BigInt(yocto);
        this.events.push({ at: this.now(), amount });
        this.perAccount.set(accountId, (this.perAccount.get(accountId) || 0n) + amount);
    }

    hourlySpent() {
        const cutoff = this.now() - 60 * 60 * 1000;
        this.events = this.events.filter((event) => event.at > cutoff);
        return this.events.reduce((total, event) => total + event.amount, 0n);
    }

    assertCanSpend(accountId, yocto) {
        const amount = BigInt(yocto);
        if (this.perAccount.get(accountId) !== undefined && this.perAccount.get(accountId) >= this.accountLimit) {
            throw failure('This account has reached its sponsored onboarding limit.', 'SPONSOR_ACCOUNT_LIMIT');
        }
        if (this.hourlySpent() + amount > this.hourlyLimit) {
            throw failure('The RELAY sponsor hourly budget is exhausted. Try again later.', 'SPONSOR_HOURLY_LIMIT');
        }
        if ((this.perAccount.get(accountId) || 0n) + amount > this.accountLimit) {
            throw failure('This account has reached its sponsored onboarding limit.', 'SPONSOR_ACCOUNT_LIMIT');
        }
    }
}

function createNearAuthRelayer({
    rpcUrl = 'https://rpc.testnet.near.org',
    sponsorAccountId,
    sponsorPrivateKey,
    provider,
    now = Date.now,
    budget,
    authSignDepositYocto = AUTH_SIGN_DEPOSIT,
    accountInitialBalanceYocto = DEFAULT_ACCOUNT_BALANCE,
    gasReserveYocto = DEFAULT_GAS_RESERVE,
    maxTopUpYocto = DEFAULT_MAX_TOP_UP,
} = {}) {
    if (!isAccountId(sponsorAccountId)) {
        throw failure('A valid sponsor account ID is required.', 'SPONSOR_ACCOUNT');
    }
    const sponsorKey = normalizePrivateKey(sponsorPrivateKey);
    const nearProvider = provider || new JsonRpcProvider({ url: rpcUrl });
    // near-api-js v7 expects a `Signer` (something with `signTransaction`),
    // not a bare KeyPair: passing the KeyPair threw
    // "TypeError: signer.signTransaction is not a function" on every sponsored
    // transaction, including the first Google login's account creation.
    const sponsorAccount = new Account(sponsorAccountId, nearProvider, new KeyPairSigner(sponsorKey));
    const sponsorPublicKey = sponsorKey.getPublicKey().toString();
    const sponsor = budget || new SponsorBudget({ now });

    async function sendSigned(signedTransaction, label) {
        const encoded = Buffer.from(encodeTransaction(signedTransaction)).toString('base64');
        const result = await nearProvider.sendJsonRpc('send_tx', {
            signed_tx_base64: encoded,
            wait_until: 'FINAL',
        });
        return { result, label, transactionHash: signedTransaction.transaction.hash?.toString?.() || null };
    }

    async function getAccount(accountId) {
        if (!isAccountId(accountId)) throw failure('Invalid NEAR account ID.', 'ACCOUNT_ID');
        try {
            return await nearProvider.viewAccount({ accountId });
        } catch (error) {
            if (/does not exist|UnknownAccount/i.test(String(error?.message || error))) return null;
            throw error;
        }
    }

    async function getAccessKey(accountId, publicKey) {
        try {
            return await nearProvider.viewAccessKey({ accountId, publicKey });
        } catch {
            return null;
        }
    }

    async function sponsorTransaction({ receiverId, actionList, label }) {
        const signed = await sponsorAccount.createSignedTransaction({ receiverId, actions: actionList });
        const hash = signed.transaction.hash?.toString?.() || null;
        const encoded = Buffer.from(encodeTransaction(signed)).toString('base64');
        const result = await nearProvider.sendJsonRpc('send_tx', {
            signed_tx_base64: encoded,
            wait_until: 'FINAL',
        });
        if (outcomeFailed(result)) {
            throw failure(`${label} failed on chain.`, 'SPONSOR_TRANSACTION_FAILED');
        }
        return { result, transactionHash: hash };
    }

    async function ensureUserAccount({ accountId, publicKey, initialBalanceYocto = accountInitialBalanceYocto }) {
        if (!isAccountId(accountId)) throw failure('Invalid user account ID.', 'ACCOUNT_ID');
        const key = normalizeNearPublicKey(publicKey);
        if (!key) throw failure('Invalid user public key.', 'USER_KEY');
        const existing = await getAccount(accountId);
        if (existing) {
            const accessKey = await getAccessKey(accountId, key);
            if (!accessKey) {
                throw failure('The derived account already exists without the MPC key; refusing to modify it.', 'USER_ACCOUNT_CONFLICT');
            }
            return { created: false, addedKey: false, accountId, balanceYocto: existing.amount.toString(), transactionHash: null };
        }

        const amount = BigInt(initialBalanceYocto);
        sponsor.assertCanSpend(accountId, amount);
        const created = await sponsorTransaction({
            receiverId: accountId,
            actionList: [
                actions.createAccount(),
                actions.transfer(amount),
                actions.addFullAccessKey(PublicKey.from(key)),
            ],
            label: 'Creating the sponsored user account',
        });
        sponsor.record(accountId, amount);
        return { created: true, addedKey: false, accountId, balanceYocto: amount.toString(), transactionHash: created.transactionHash };
    }

    async function ensureGas({ accountId, minBalanceYocto = gasReserveYocto, targetBalanceYocto = accountInitialBalanceYocto, maxTopUp = maxTopUpYocto } = {}) {
        const account = await getAccount(accountId);
        if (!account) throw failure('The sponsored account does not exist yet.', 'ACCOUNT_MISSING');
        const current = account.amount;
        if (current >= BigInt(minBalanceYocto)) {
            return { toppedUp: false, accountId, balanceYocto: current.toString(), amountYocto: '0', transactionHash: null };
        }
        const target = BigInt(targetBalanceYocto);
        const cap = BigInt(maxTopUp);
        const delta = (target > current ? target - current : 0n) > cap ? cap : (target > current ? target - current : 0n);
        if (delta <= 0n) {
            return { toppedUp: false, accountId, balanceYocto: current.toString(), amountYocto: '0', transactionHash: null };
        }
        sponsor.assertCanSpend(accountId, delta);
        const result = await sponsorTransaction({
            receiverId: accountId,
            actionList: [actions.transfer(delta)],
            label: 'Topping up the sponsored account',
        });
        sponsor.record(accountId, delta);
        return {
            toppedUp: true,
            accountId,
            balanceYocto: (current + delta).toString(),
            amountYocto: delta.toString(),
            transactionHash: result.transactionHash,
        };
    }

    async function prepareTransaction({ signerId, publicKey, receiverId, actionList }) {
        if (!isAccountId(signerId) || !isAccountId(receiverId)) {
            throw failure('Prepared transactions require valid signer and receiver IDs.', 'ACCOUNT_ID');
        }
        const key = normalizeNearPublicKey(publicKey);
        if (!key) throw failure('A valid signer public key is required.', 'USER_KEY');
        const accessKey = await getAccessKey(signerId, key);
        if (!accessKey) {
            throw failure('The user account is not ready for signing yet (missing key).', 'USER_KEY_MISSING');
        }
        const block = await nearProvider.viewBlock({ finality: 'final' });
        const transaction = createTransaction(
            signerId,
            PublicKey.from(key),
            receiverId,
            BigInt(accessKey.nonce) + 1n,
            actionList,
            // NEAR RPC returns the block hash as base58. Decoding it as base64
            // produces 33 bytes and Borsh rejects the transaction.
            Buffer.from(baseDecode(block.header.hash)),
        );
        const bytes = transactionBytes(transaction);
        return {
            transaction,
            bytes,
            base64: bytes.toString('base64'),
            transactionHash: baseEncode(crypto.createHash('sha256').update(bytes).digest()),
        };
    }

    async function requestAuthSignature({ request, expectedBytes }) {
        const { payload } = validateSignatureRequest(request, { now });
        if (expectedBytes && !payload.equals(expectedBytes)) {
            throw failure('Auth0 signed a different transaction than RELAY prepared.', 'SIGN_PAYLOAD_MISMATCH');
        }
        sponsor.assertCanSpend('auth-sign', authSignDepositYocto);
        const signAction = actions.functionCall(
            'sign',
            {
                guard_id: request.guardId,
                verify_payload: request.verifyPayload,
                sign_payload: Array.from(payload),
                algorithm: 'eddsa',
            },
            AUTH_SIGN_GAS,
            authSignDepositYocto,
        );
        const signed = await sponsorTransaction({
            receiverId: FAST_AUTH_CONTRACT_ID,
            actionList: [signAction],
            label: 'MPC signing request',
        });
        const signature = extractAuthSignature(signed.result);
        if (!signature) {
            throw failure('The FastAuth contract did not return an MPC signature.', 'AUTH_SIGNATURE_MISSING');
        }
        sponsor.record('auth-sign', authSignDepositYocto);
        return { signature, transactionHash: signed.transactionHash, result: signed.result };
    }

    async function submitPreparedAction({ prepared, request, publicKey }) {
        const bytes = Buffer.isBuffer(prepared?.bytes) ? prepared.bytes : Buffer.from(prepared?.base64 || '', 'base64');
        if (bytes.length === 0) throw failure('Prepared transaction bytes are missing.', 'PREPARED_TRANSACTION');
        const signature = await requestAuthSignature({ request, expectedBytes: bytes });
        verifyUserSignature({ bytes, signature: signature.signature, publicKey });
        const signedTransaction = new SignedTransaction({
            transaction: prepared.transaction,
            signature: new Signature({ keyType: KeyType.ED25519, data: signature.signature }),
        });
        const encoded = Buffer.from(encodeTransaction(signedTransaction)).toString('base64');
        const result = await nearProvider.sendJsonRpc('send_tx', {
            signed_tx_base64: encoded,
            wait_until: 'FINAL',
        });
        return {
            transactionHash: baseEncode(crypto.createHash('sha256').update(bytes).digest()),
            signTransactionHash: signature.transactionHash,
            result,
            success: !outcomeFailed(result),
            successValue: lastSuccessValue(result),
            finalExecutionStatus: result?.final_execution_status || null,
        };
    }

    async function waitForTransaction(transactionHash, signerId) {
        return nearProvider.viewTransactionStatusWithReceipts({
            txHash: transactionHash,
            accountId: signerId,
            waitUntil: 'FINAL',
        });
    }

    const fallbackRpcUrl = process.env.RELAY_TEST_RPC_URL || 'https://test.rpc.fastnear.com';
    const fallbackProvider = fallbackRpcUrl && fallbackRpcUrl !== rpcUrl ? new JsonRpcProvider({ url: fallbackRpcUrl }) : null;

    async function viewFunction({ contractId, methodName, args }) {
        try {
            return await nearProvider.callFunction({
                contractId,
                method: methodName,
                args,
                blockQuery: { finality: 'final' },
            });
        } catch (error) {
            const message = String(error?.message || error);
            if (fallbackProvider && /deprecated|-429|rate limit|too many requests/i.test(message)) {
                try {
                    return await fallbackProvider.callFunction({
                        contractId,
                        method: methodName,
                        args,
                        blockQuery: { finality: 'final' },
                    });
                } catch (fallbackError) {
                    error = fallbackError;
                }
            }
            throw error;
        }
    }

    return {
        sponsorAccountId,
        sponsorPublicKey,
        getAccount,
        getAccessKey,
        prepareTransaction,
        ensureUserAccount,
        ensureGas,
        requestAuthSignature,
        submitPreparedAction,
        sponsorTransaction,
        viewFunction,
        waitForTransaction,
        budget: sponsor,
        provider: nearProvider,
    };
}

module.exports = {
    ACCOUNT_ID_RE,
    AUTH_SIGN_DEPOSIT,
    AUTH_SIGN_GAS,
    DEFAULT_ACCOUNT_BALANCE,
    DEFAULT_ACCOUNT_BUDGET,
    DEFAULT_GAS_RESERVE,
    DEFAULT_HOURLY_BUDGET,
    DEFAULT_MAX_TOP_UP,
    MPC_CONTRACT_ID,
    SponsorBudget,
    YOCTO_PER_NEAR,
    createNearAuthRelayer,
    decodeJwtClaims,
    extractAuthSignature,
    isAccountId,
    lastSuccessValue,
    outcomeFailed,
    toByteArray,
    transactionBytes,
    validateSignatureRequest,
    verifyUserSignature,
};
