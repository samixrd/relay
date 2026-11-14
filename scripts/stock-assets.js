'use strict';

/**
 * Claimable stock / commodity demo assets.
 *
 * Each entry is a real NEP-141 contract on NEAR Testnet. The treasury account
 * holds the minted supply and sends a fixed amount into a RELAY card account
 * when that card's owner clicks Claim. The ledger is keyed by
 * (contract, card token) and enforces a lifetime cap so a public demo cannot
 * drain the treasury.
 *
 * These are test tokens. They are not securities, are not redeemable, and have
 * no relation to the real companies or commodities in their names.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Account, JsonRpcProvider, KeyPairSigner, actions } = require('near-api-js');

const SHARE = 10n ** 6n; // every stock token uses 6 decimals
const NEAR_GAS = 100n * 10n ** 12n;
const FT_STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR

function frozenAsset(asset) {
    return Object.freeze({
        contractId: asset.contractId,
        symbol: asset.symbol,
        name: asset.name,
        decimals: asset.decimals,
        claimAmount: asset.claimAmount,
        claimCap: asset.claimCap,
    });
}

const STOCK_ASSETS = Object.freeze([
    frozenAsset({
        contractId: 'aapl.spellman.testnet',
        symbol: 'AAPL',
        name: 'Apple Inc. (Test)',
        decimals: 6,
        claimAmount: (100n * SHARE).toString(),
        claimCap: (1_000n * SHARE).toString(),
    }),
    frozenAsset({
        contractId: 'tsla.spellman.testnet',
        symbol: 'TSLA',
        name: 'Tesla Inc. (Test)',
        decimals: 6,
        claimAmount: (100n * SHARE).toString(),
        claimCap: (1_000n * SHARE).toString(),
    }),
    frozenAsset({
        contractId: 'gold.spellman.testnet',
        symbol: 'GOLD',
        name: 'Gold (Test)',
        decimals: 6,
        claimAmount: (100n * SHARE).toString(),
        claimCap: (1_000n * SHARE).toString(),
    }),
    frozenAsset({
        contractId: 'oil.spellman.testnet',
        symbol: 'OIL',
        name: 'Crude Oil (Test)',
        decimals: 6,
        claimAmount: (100n * SHARE).toString(),
        claimCap: (1_000n * SHARE).toString(),
    }),
]);

function failure(message, code = 'STOCK_FAUCET_ERROR', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function createStockFaucet({
    rpcUrl = 'https://test.rpc.fastnear.com',
    treasuryAccountId,
    treasuryPrivateKey,
    assets = STOCK_ASSETS,
    filePath = path.join(__dirname, '..', 'data', 'stock-claims.json'),
    now = Date.now,
    provider = null,
    account = null,
} = {}) {
    const nearProvider = provider || new JsonRpcProvider({ url: rpcUrl });
    let treasuryAccount = account;
    let configurationError = null;

    if (!treasuryAccount) {
        if (!treasuryAccountId) configurationError = 'STOCK_FAUCET_ACCOUNT_ID is not configured.';
        else if (!treasuryPrivateKey) configurationError = 'STOCK_FAUCET_PRIVATE_KEY (or NEAR_PRIVATE_KEY) is not configured.';
        else {
            try {
                const signer = KeyPairSigner.fromSecretKey(treasuryPrivateKey);
                treasuryAccount = new Account(treasuryAccountId, nearProvider, signer);
            } catch (error) {
                configurationError = `The stock treasury key is invalid: ${error.message}`;
            }
        }
    }

    const ledger = new Map();
    let loaded = false;
    const inFlight = new Set();

    function assetFor(contractId) {
        return assets.find((entry) => entry.contractId === contractId) || null;
    }

    function ledgerKey(contractId, tokenId) {
        return `${contractId}\u0000${tokenId}`;
    }

    function load() {
        if (loaded) return;
        loaded = true;
        let text;
        try {
            text = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw failure('The stock claim ledger is not valid JSON.', 'CLAIM_LEDGER');
        }
        for (const entry of Array.isArray(parsed?.claims) ? parsed.claims : []) {
            if (!entry || typeof entry.contractId !== 'string' || typeof entry.tokenId !== 'string') continue;
            ledger.set(ledgerKey(entry.contractId, entry.tokenId), {
                contractId: entry.contractId,
                tokenId: entry.tokenId,
                claimed: String(entry.claimed || '0'),
                updatedAt: entry.updatedAt || 0,
            });
        }
    }

    function persist() {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const body = JSON.stringify({
            version: 1,
            claims: [...ledger.values()].sort((a, b) => a.updatedAt - b.updatedAt),
        }, null, 2);
        const temporary = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        fs.writeFileSync(temporary, body, { mode: 0o600 });
        fs.renameSync(temporary, filePath);
    }

    function claimedFor(contractId, tokenId) {
        load();
        return BigInt(ledger.get(ledgerKey(contractId, tokenId))?.claimed || '0');
    }

    function remainingFor(contractId, tokenId) {
        const asset = assetFor(contractId);
        if (!asset) return 0n;
        const remaining = BigInt(asset.claimCap) - claimedFor(contractId, tokenId);
        return remaining > 0n ? remaining : 0n;
    }

    function list() {
        return assets.map((asset) => ({ ...asset }));
    }

    async function view(contractId, method, args) {
        try {
            return await nearProvider.callFunction({
                contractId,
                method,
                args,
                blockQuery: { finality: 'final' },
            });
        } catch (error) {
            if (/does not exist|MethodNotFound|Contract method is not found|UnknownAccount/i.test(String(error?.message || error))) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Register a recipient with the token contract if it has no storage yet.
     * The treasury pays the 0.00125 NEAR storage deposit, so a card can send a
     * demo stock to a fresh Testnet account without a separate setup step.
     */
    async function ensureRegistered({ contractId, accountId }) {
        if (!treasuryAccount) throw failure(configurationError || 'The stock faucet is not configured.', 'FAUCET_UNCONFIGURED', 503);
        if (!assetFor(contractId)) throw failure('That contract is not a RELAY test stock.', 'FT_UNSUPPORTED', 400);
        if (typeof accountId !== 'string' || !accountId) throw failure('A recipient account is required.', 'ACCOUNT_ID', 400);
        const existing = await view(contractId, 'storage_balance_of', { account_id: accountId });
        if (existing) return { registered: true, created: false, transactionHash: null };
        const result = await treasuryAccount.signAndSendTransaction({
            receiverId: contractId,
            actions: [
                actions.functionCall(
                    'storage_deposit',
                    { account_id: accountId, registration_only: true },
                    NEAR_GAS,
                    FT_STORAGE_DEPOSIT_YOCTO,
                ),
            ],
            waitUntil: 'FINAL',
        });
        return {
            registered: true,
            created: true,
            transactionHash: result?.transaction?.hash || result?.transaction_outcome?.id || null,
        };
    }

    async function claim({ contractId, tokenId, cardAccountId }) {
        if (!treasuryAccount) throw failure(configurationError || 'The stock faucet is not configured.', 'FAUCET_UNCONFIGURED', 503);
        const asset = assetFor(contractId);
        if (!asset) throw failure('That contract is not a RELAY test stock.', 'FT_UNSUPPORTED', 400);
        if (typeof tokenId !== 'string' || !tokenId) throw failure('A card token ID is required.', 'TOKEN_ID', 400);
        if (typeof cardAccountId !== 'string' || !cardAccountId) throw failure('A card account is required.', 'ACCOUNT_ID', 400);

        const key = ledgerKey(contractId, tokenId);
        if (inFlight.has(key)) {
            throw failure('A claim for this card is already in progress. Wait for it to finish.', 'CLAIM_IN_FLIGHT', 409);
        }
        inFlight.add(key);
        try {
            load();
            const claimed = BigInt(ledger.get(key)?.claimed || '0');
            const cap = BigInt(asset.claimCap);
            if (claimed >= cap) {
                throw failure(
                    `This card already claimed the ${asset.symbol} demo limit (${cap / SHARE} shares).`,
                    'CLAIM_CAP',
                    409,
                );
            }
            const remaining = cap - claimed;
            const requested = BigInt(asset.claimAmount);
            const grant = requested < remaining ? requested : remaining;

            const treasuryBalance = BigInt((await view(contractId, 'ft_balance_of', { account_id: treasuryAccountId })) || '0');
            if (treasuryBalance < grant) {
                throw failure(`The ${asset.symbol} test treasury is empty. Ask the RELAY operator to refill it.`, 'FAUCET_EMPTY', 503);
            }

            const result = await treasuryAccount.signAndSendTransaction({
                receiverId: contractId,
                actions: [
                    actions.functionCall(
                        'storage_deposit',
                        { account_id: cardAccountId, registration_only: true },
                        NEAR_GAS,
                        FT_STORAGE_DEPOSIT_YOCTO,
                    ),
                    actions.functionCall(
                        'ft_transfer',
                        { receiver_id: cardAccountId, amount: grant.toString(), memo: 'RELAY test stock claim' },
                        NEAR_GAS,
                        1n,
                    ),
                ],
                waitUntil: 'FINAL',
            });

            const total = claimed + grant;
            ledger.set(key, {
                contractId,
                tokenId,
                claimed: total.toString(),
                updatedAt: now(),
            });
            persist();

            return {
                contractId,
                symbol: asset.symbol,
                name: asset.name,
                decimals: asset.decimals,
                tokenId,
                accountId: cardAccountId,
                amount: grant.toString(),
                claimed: total.toString(),
                claimCap: cap.toString(),
                remaining: (cap - total).toString(),
                transactionHash: result?.transaction?.hash || result?.transaction_outcome?.id || null,
            };
        } finally {
            inFlight.delete(key);
        }
    }

    return {
        assets: list,
        assetFor,
        claimedFor,
        remainingFor,
        ensureRegistered,
        claim,
        isConfigured: () => Boolean(treasuryAccount),
        configurationError: () => configurationError,
        clearLedger() {
            ledger.clear();
            loaded = true;
        },
    };
}

module.exports = {
    FT_STORAGE_DEPOSIT_YOCTO,
    NEAR_GAS,
    SHARE,
    STOCK_ASSETS,
    createStockFaucet,
};
