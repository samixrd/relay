'use strict';

/**
 * HTTP surface for the NEAR Auth product path.
 *
 * One login (Auth0 via NEAR Auth) unlocks:
 *   - a deterministic sponsored NEAR account,
 *   - permissionless self-minting of RELAY NFTs,
 *   - sponsored gas for every supported user action,
 *   - email-verified friend claims.
 *
 * Every mutating action is prepared server-side, signed by the user's MPC key
 * through Auth0, and only then broadcast. The sponsor pays for `sign` and for
 * gas top-ups, but never signs the user's transaction.
 */

const crypto = require('node:crypto');
const { JsonRpcProvider, actions, baseEncode } = require('near-api-js');
const {
    AUTH_CLIENT_ID,
    AUTH_DOMAIN,
    AUTH_SIGNING_AUDIENCE,
    deriveFastAuthPath,
    deriveUserAccountId,
    normalizeNearPublicKey,
    verifyNearAuthIdentity,
} = require('./near-auth-identity');
const {
    createNearAuthRelayer,
    decodeJwtClaims,
    outcomeFailed,
    toByteArray,
} = require('./near-auth-relayer');
const { createNearAuthClaimStore } = require('./near-auth-claims');
const { createAccountLinkStore } = require('./account-links');
const { STOCK_ASSETS } = require('./stock-assets');
const { normalizeActions } = require('./wallet-auth');
const {
    parseCookies,
    serializeCookie,
    validateNearAccountId,
    verifyNep413Signature,
} = require('./auth-provider-adapter');

const TOKEN_ID_RE = /^[a-z0-9_-]{1,32}$/;
const ACCOUNT_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MAX_BODY_BYTES = 64 * 1024;
const PENDING_TTL_MS = 5 * 60 * 1000;
const LINK_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MINT_DEPOSIT_YOCTO = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
// The controller WASM is ~164 KB. The contract requires
// (wasm_len + 20,000) bytes of storage plus a 0.05 NEAR reserve, which is
// ~1.892 NEAR. 1.95 NEAR keeps headroom without wasting sponsor budget.
const PROVISION_DEPOSIT_YOCTO = 1_950_000_000_000_000_000_000_000n; // 1.95 NEAR
const FT_STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const NEAR_GAS = 100n * 10n ** 12n;
// Provisioning deploys the ~164 KB controller WASM, so it needs far more gas
// than a mint. The network rejects 100 TGas with "Exceeded the prepaid gas";
// 300 TGas is the protocol maximum per transaction and what the verified
// lifecycle/evidence scripts use.
const PROVISION_GAS = 300n * 10n ** 12n;
const DEFAULT_FT_ASSETS = Object.freeze([
    Object.freeze({ contractId: 'wrap.testnet', symbol: 'wNEAR', decimals: 24, name: 'Wrapped NEAR' }),
    ...STOCK_ASSETS.map((asset) => Object.freeze({
        contractId: asset.contractId,
        symbol: asset.symbol,
        decimals: asset.decimals,
        name: asset.name,
    })),
]);

function failure(message, code = 'NEAR_AUTH_API_ERROR', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function json(response, status, body, headers = {}) {
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...headers,
    });
    response.end(JSON.stringify(body));
    return true;
}

function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(failure('Request body is too large.', 'BODY_TOO_LARGE', 413));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (chunks.length === 0) return resolve({});
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    return reject(failure('Request body must be a JSON object.', 'BODY_INVALID'));
                }
                resolve(parsed);
            } catch {
                reject(failure('Request body is not valid JSON.', 'BODY_INVALID'));
            }
        });
        request.on('error', reject);
    });
}

function isAccountId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 64 && ACCOUNT_ID_RE.test(value);
}

function parseNearAmount(value, label = 'amount') {
    if (typeof value === 'number') value = String(value);
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,24})?$/.test(value.trim())) {
        throw failure(`Enter a positive ${label} with at most 24 decimal places.`, 'AMOUNT_INVALID');
    }
    const [whole, fraction = ''] = value.trim().split('.');
    const yocto = BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, '0') || '0');
    if (yocto <= 0n) throw failure(`The ${label} must be greater than zero.`, 'AMOUNT_INVALID');
    return yocto;
}

function formatNear(yocto) {
    const value = BigInt(yocto);
    const whole = value / 10n ** 24n;
    const fraction = (value % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
}

function createRateLimiter(now = Date.now) {
    const buckets = new Map();
    return {
        check(key, limit, windowMs) {
            const cutoff = now() - windowMs;
            const entries = (buckets.get(key) || []).filter((at) => at > cutoff);
            if (entries.length >= limit) {
                buckets.set(key, entries);
                throw failure('Too many requests. Wait a moment and try again.', 'RATE_LIMITED', 429);
            }
            entries.push(now());
            buckets.set(key, entries);
        },
    };
}

function createNearAuthApi({
    config,
    envSource = config.rawEnv || process.env,
    sessionStore,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    relayer: providedRelayer = null,
    jwks = null,
    claims = null,
    links = null,
    journal = null,
    publicAppUrl = null,
    ftAssets = null,
    faucet = null,
} = {}) {
    if (!config) throw new Error('config is required');
    if (!sessionStore) throw new Error('sessionStore is required');
    if (!jwks) throw new Error('jwks is required');

    const provider = new JsonRpcProvider({ url: config.near.rpcUrl });
    const fallbackRpcUrl = envSource.RELAY_TEST_RPC_URL || 'https://test.rpc.fastnear.com';
    const fallbackProvider = fallbackRpcUrl === config.near.rpcUrl
        ? null
        : new JsonRpcProvider({ url: fallbackRpcUrl });
    const limiter = createRateLimiter(now);
    const pending = new Map();
    const activeByAccount = new Map();
    const claimStore = claims || createNearAuthClaimStore({
        filePath: require('node:path').join(__dirname, '..', 'data', 'near-auth-claims.json'),
        secret: envSource.NEAR_AUTH_CLAIM_SECRET || envSource.CLAIM_SESSION_SECRET || 'relay-default-auth-secret',
        now,
    });
    const linkStore = links || createAccountLinkStore({
        filePath: require('node:path').join(__dirname, '..', 'data', 'account-links.json'),
        now,
    });
    const linkChallenges = new Map();
    const appOrigin = (publicAppUrl || config.app.publicAppUrl || `http://localhost:${config.app.port || 4173}`).replace(/\/$/, '');
    const secureCookie = Boolean((publicAppUrl || config.app.publicAppUrl || '').startsWith('https:'));

    let relayer = providedRelayer;
    let relayerError = null;
    function getRelayer() {
        if (relayer) return relayer;
        if (relayerError) throw relayerError;
        const sponsorAccountId = envSource.NEAR_AUTH_SPONSOR_ACCOUNT_ID
            || config.near.relayContractId
            || 'relay.spellman.testnet';
        const sponsorPrivateKey = envSource.NEAR_AUTH_SPONSOR_PRIVATE_KEY
            || envSource.OWNER_B_PRIVATE_KEY
            || envSource.NEAR_PRIVATE_KEY;
        if (!sponsorPrivateKey) {
            relayerError = failure(
                'NEAR Auth sponsorship is not configured. Set NEAR_AUTH_SPONSOR_PRIVATE_KEY, OWNER_B_PRIVATE_KEY, or NEAR_PRIVATE_KEY.',
                'SPONSOR_UNCONFIGURED',
                503,
            );
            throw relayerError;
        }
        try {
            relayer = createNearAuthRelayer({
                rpcUrl: config.near.rpcUrl,
                sponsorAccountId,
                sponsorPrivateKey,
                provider,
                now,
            });
        } catch (error) {
            relayerError = failure(`NEAR Auth sponsorship is unavailable: ${error.message}`, 'SPONSOR_UNCONFIGURED', 503);
            throw relayerError;
        }
        return relayer;
    }

    function parentAccountId() {
        return envSource.RELAY_USER_ACCOUNT_PARENT
            || config.near.relayContractId
            || 'relay.spellman.testnet';
    }

    function readSession(request) {
        const cookies = parseCookies(request.headers.cookie);
        const id = cookies.relay_auth_session;
        if (!id) return { sessionId: null, session: null };
        const session = sessionStore.getSession(id);
        if (!session) return { sessionId: null, session: null };
        return { sessionId: id, session };
    }

    function requireNearSession(request) {
        const { sessionId, session } = readSession(request);
        if (!session?.nearAuth?.accountId || !session.nearAuth.publicKey) {
            throw failure('Sign in with Google to continue.', 'AUTH_REQUIRED', 401);
        }
        return { sessionId, session, identity: session.nearAuth };
    }

    /**
     * Read the wallet session from the same cookie jar. The wallet session is a
     * different cookie and a different signer; it is only ever used to sign a
     * transaction for the account it proved control of.
     */
    function readWalletIdentity(request) {
        const cookies = parseCookies(request.headers.cookie);
        const id = cookies.relay_wallet_session;
        if (!id) return null;
        const session = sessionStore.getSession(id);
        const wallet = session?.walletAuth;
        if (!wallet?.accountId || !wallet.publicKey) return null;
        return {
            sub: session.sub || `wallet:${wallet.accountId}`,
            accountId: wallet.accountId,
            publicKey: wallet.publicKey,
            kind: 'wallet',
        };
    }

    function readGoogleIdentity(request) {
        const { session } = readSession(request);
        if (!session?.nearAuth?.accountId || !session.nearAuth.publicKey) return null;
        return {
            sub: session.nearAuth.sub || session.sub,
            accountId: session.nearAuth.accountId,
            publicKey: session.nearAuth.publicKey,
            kind: 'google',
        };
    }

    function accountsForIdentity(identity) {
        const accounts = new Set();
        if (identity?.accountId) accounts.add(identity.accountId);
        if (identity?.sub) {
            for (const accountId of linkStore.accountsFor(identity.sub)) accounts.add(accountId);
        }
        return accounts;
    }

    function clearLinkChallenges() {
        const cutoff = now();
        for (const [id, entry] of linkChallenges) if (entry.expiresAt <= cutoff) linkChallenges.delete(id);
    }

    function clearNearSession(request, response) {
        const cookies = parseCookies(request.headers.cookie);
        if (cookies.relay_auth_session) sessionStore.revokeSession(cookies.relay_auth_session);
        const cleared = serializeCookie('relay_auth_session', '', {
            maxAge: 0,
            httpOnly: true,
            path: '/',
            sameSite: 'Lax',
        });
        response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'set-cookie': cleared,
        });
        response.end(JSON.stringify({ authenticated: false, loggedOut: true }));
    }

    async function view(contractId, methodName, args) {
        const request = {
            contractId,
            method: methodName,
            args,
            blockQuery: { finality: 'final' },
        };
        try {
            return await provider.callFunction(request);
        } catch (error) {
            const message = String(error?.message || error);
            // The legacy public Testnet RPC intermittently answers read calls with
            // a deprecation/rate-limit error. Retry those reads against the
            // FastNEAR Testnet RPC instead of failing the whole page.
            if (fallbackProvider && /deprecated|-429|rate limit|too many requests/i.test(message)) {
                try {
                    return await fallbackProvider.callFunction(request);
                } catch (fallbackError) {
                    error = fallbackError;
                }
            }
            if (/does not exist|MethodNotFound|Contract method is not found|UnknownAccount/i.test(String(error?.message || error))) {
                return null;
            }
            throw error;
        }
    }

    async function tokenState(tokenId) {
        if (!TOKEN_ID_RE.test(tokenId || '')) throw failure('Invalid RELAY token ID.', 'TOKEN_ID');
        const contractId = config.near.relayContractId;
        if (!contractId) throw failure('RELAY_CONTRACT_ID is not configured.', 'CONTRACT_UNCONFIGURED', 503);
        const token = await view(contractId, 'nft_token', { token_id: tokenId });
        if (!token) return null;
        const binding = await view(contractId, 'relay_account_binding', { token_id: tokenId });
        const provisioning = await view(contractId, 'relay_provisioning_state', { token_id: tokenId });
        return { token, binding, provisioning, contractId, associatedAccountId: `${tokenId}.${contractId}` };
    }

    async function requireOwnedTokenFor(tokenId, accounts) {
        const state = await tokenState(tokenId);
        if (!state) throw failure(`Token ${tokenId} does not exist.`, 'TOKEN_MISSING', 404);
        if (!accounts.has(state.token.owner_id)) {
            throw failure('Only the current NFT owner can do this.', 'TOKEN_OWNER', 403);
        }
        return state;
    }

    async function requireOwnedToken(tokenId, accountId) {
        return requireOwnedTokenFor(tokenId, new Set([accountId]));
    }

    async function requireVerifiedToken(tokenId, accountId) {
        const state = await requireOwnedToken(tokenId, accountId);
        if (!state.binding?.is_verified) {
            throw failure('The card account is not provisioned yet.', 'TOKEN_NOT_PROVISIONED', 409);
        }
        return state;
    }

    const OWNER_BOUND_KINDS = new Set(['provision', 'fund', 'spend', 'transfer', 'ft_register', 'ft_spend', 'claim_transfer']);
    const PROVISIONED_KINDS = new Set(['fund', 'spend', 'ft_register', 'ft_spend']);

    async function assertIntentStillAuthorized(entry, identity) {
        const tokenId = typeof entry?.summary?.tokenId === 'string' ? entry.summary.tokenId : null;
        if (!tokenId) return;
        if (entry.kind === 'mint') {
            if (await tokenState(tokenId)) {
                throw failure('This token ID was minted by another request after you prepared it.', 'TOKEN_EXISTS', 409);
            }
            return;
        }
        if (!OWNER_BOUND_KINDS.has(entry.kind)) return;
        const state = await tokenState(tokenId);
        if (!state) throw failure('The NFT no longer exists.', 'TOKEN_MISSING', 404);
        if (state.token.owner_id !== identity.accountId) {
            throw failure('NFT ownership changed after this action was prepared. Start again.', 'OWNERSHIP_CHANGED', 409);
        }
        if (PROVISIONED_KINDS.has(entry.kind) && !state.binding?.is_verified) {
            throw failure('The card account is no longer provisioned.', 'TOKEN_NOT_PROVISIONED', 409);
        }
        return state;
    }

    function tokenAccountBalance(accountId) {
        return provider.viewAccount({ accountId }).then(
            (account) => ({
                exists: true,
                accountId,
                balanceYocto: account.amount.toString(),
                balanceNear: formatNear(account.amount),
                storageUsage: account.storage_usage,
            }),
            () => ({ exists: false, accountId, balanceYocto: '0', balanceNear: '0', storageUsage: 0 }),
        );
    }

    function ftRegistry() {
        if (Array.isArray(ftAssets)) return ftAssets;
        const configured = envSource.RELAY_FT_ASSETS;
        if (!configured) return [...DEFAULT_FT_ASSETS];
        return configured.split(',').map((entry) => {
            const [contractId, symbol, decimals] = entry.split(':');
            if (!isAccountId(contractId)) return null;
            return { contractId, symbol: symbol || contractId, decimals: Number(decimals || 24), name: symbol || contractId };
        }).filter(Boolean);
    }

    async function assetSnapshot(tokenId = null) {
        const registry = ftRegistry();
        const assets = [];
        const target = tokenId
            ? `${tokenId}.${config.near.relayContractId}`
            : null;
        for (const asset of registry) {
            const metadata = await view(asset.contractId, 'ft_metadata', {});
            if (!metadata) continue;
            let balance = null;
            if (target) {
                try {
                    balance = await view(asset.contractId, 'ft_balance_of', { account_id: target });
                } catch {
                    balance = null;
                }
            }
            const stock = faucet?.assetFor(asset.contractId) || null;
            const claimed = stock && tokenId ? faucet.claimedFor(asset.contractId, tokenId) : null;
            const remaining = stock && tokenId ? faucet.remainingFor(asset.contractId, tokenId) : null;
            assets.push({
                contractId: asset.contractId,
                symbol: metadata.symbol || asset.symbol,
                name: metadata.name || asset.name,
                decimals: Number(metadata.decimals ?? asset.decimals),
                balance: balance === null ? null : String(balance),
                registered: balance !== null,
                claimable: Boolean(stock),
                claimAmount: stock?.claimAmount || null,
                claimCap: stock?.claimCap || null,
                claimed: claimed === null ? null : claimed.toString(),
                claimRemaining: remaining === null ? null : remaining.toString(),
            });
        }
        return assets;
    }

    function cleanupPending() {
        const cutoff = now();
        for (const [id, entry] of pending) {
            if (entry.expiresAt <= cutoff) {
                pending.delete(id);
                if (activeByAccount.get(entry.accountId) === id) activeByAccount.delete(entry.accountId);
            }
        }
    }

    function actionContext(identity) {
        return {
            accountId: identity.accountId,
            sub: identity.sub,
            publicKey: identity.publicKey,
        };
    }

    async function ensureReady(identity, { minBalanceYocto, targetBalanceYocto, maxTopUp } = {}) {
        const instance = getRelayer();
        const ensured = await instance.ensureUserAccount({
            accountId: identity.accountId,
            publicKey: identity.publicKey,
        });
        if (minBalanceYocto !== undefined) {
            await instance.ensureGas({
                accountId: identity.accountId,
                minBalanceYocto,
                targetBalanceYocto,
                maxTopUp,
            });
        }
        return ensured;
    }

    async function buildAction(kind, body, identity) {
        const owner = identity.accountId;
        const contractId = config.near.relayContractId;
        if (!contractId) throw failure('RELAY_CONTRACT_ID is not configured.', 'CONTRACT_UNCONFIGURED', 503);

        if (kind === 'mint') {
            const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim().toLowerCase() : '';
            if (!TOKEN_ID_RE.test(tokenId)) throw failure('Token ID must be 1-32 lowercase letters, numbers, hyphens, or underscores.', 'TOKEN_ID');
            if (tokenId.startsWith('u-')) throw failure('Token IDs beginning with u- are reserved for RELAY user accounts.', 'TOKEN_ID_RESERVED');
            if (await tokenState(tokenId)) throw failure(`Token ${tokenId} already exists.`, 'TOKEN_EXISTS', 409);
            const title = typeof body.name === 'string' ? body.name.trim() : '';
            if (!title || title.length > 64) throw failure('Card name must be between 1 and 64 characters.', 'METADATA');
            const description = typeof body.description === 'string' ? body.description.trim() : '';
            if (description.length > 500) throw failure('Description must be at most 500 characters.', 'METADATA');
            const media = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
            if (media && !/^(?:https:\/\/|\/uploads\/[a-z0-9-]+\.(?:png|jpe?g|webp))$/i.test(media)) {
                throw failure('Image URL must be an uploaded RELAY image or an HTTPS URL.', 'METADATA');
            }
            const initialCredits = body.initialCredits === undefined ? 3 : Number(body.initialCredits);
            if (!Number.isInteger(initialCredits) || initialCredits < 0 || initialCredits > 100) {
                throw failure('Initial credits must be an integer between 0 and 100.', 'METADATA');
            }
            const metadata = { title, description };
            if (media) metadata.media = media;
            await ensureReady(identity, {
                minBalanceYocto: 200_000_000_000_000_000_000_000n,
                targetBalanceYocto: 250_000_000_000_000_000_000_000n,
            });
            return {
                kind,
                receiverId: contractId,
                actionList: [actions.functionCall('relay_mint', {
                    token_id: tokenId,
                    token_owner_id: owner,
                    token_metadata: metadata,
                    associated_account_id: `${tokenId}.${contractId}`,
                    initial_credits: initialCredits,
                }, NEAR_GAS, MINT_DEPOSIT_YOCTO)],
                summary: {
                    title: `Create “${title}”`,
                    detail: `Mint NFT ${tokenId} to ${owner}. RELAY sponsors the gas; the attached storage deposit is ${formatNear(MINT_DEPOSIT_YOCTO)} NEAR.`,
                    tokenId,
                },
            };
        }

        if (kind === 'provision') {
            const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim().toLowerCase() : '';
            const state = await requireOwnedToken(tokenId, owner);
            if (state.binding?.is_verified) throw failure('This card account is already provisioned.', 'ALREADY_PROVISIONED', 409);
            await ensureReady(identity, {
                minBalanceYocto: 1_960_000_000_000_000_000_000_000n,
                targetBalanceYocto: 2_050_000_000_000_000_000_000_000n,
                maxTopUp: 2_100_000_000_000_000_000_000_000n,
            });
            return {
                kind,
                receiverId: contractId,
                actionList: [actions.functionCall('relay_provision_subaccount', { token_id: tokenId }, PROVISION_GAS, PROVISION_DEPOSIT_YOCTO)],
                summary: {
                    title: `Provision the account for ${tokenId}`,
                    detail: `Create and verify ${state.associatedAccountId}. The ${formatNear(PROVISION_DEPOSIT_YOCTO)} NEAR deposit funds the card account and is enforced by the contract.`,
                    tokenId,
                },
            };
        }

        if (kind === 'fund') {
            const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim().toLowerCase() : '';
            const state = await requireVerifiedToken(tokenId, owner);
            const amount = parseNearAmount(body.amountNear, 'amount');
            // The sponsored account starts with gas money, not spending money. On
            // Testnet the demo sponsor tops it up so a Google-only user can move
            // real (valueless) NEAR into their own card. The per-account budget
            // caps the total, so this is not an unlimited faucet.
            const gasReserve = 150_000_000_000_000_000_000_000n; // 0.15 NEAR
            const targetBalance = amount + 250_000_000_000_000_000_000_000n;
            await ensureReady(identity, {
                minBalanceYocto: amount + gasReserve,
                targetBalanceYocto: targetBalance,
                maxTopUp: targetBalance,
            });
            return {
                kind,
                receiverId: state.associatedAccountId,
                actionList: [actions.transfer(amount)],
                summary: {
                    title: `Fund ${tokenId}`,
                    detail: `Move ${formatNear(amount)} NEAR into ${state.associatedAccountId}. On Testnet the RELAY demo sponsor tops up your account so this works without a wallet; the per-account budget caps the amount.`,
                    tokenId,
                },
            };
        }

        if (kind === 'spend') {
            const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim().toLowerCase() : '';
            const receiverId = typeof body.receiverId === 'string' ? body.receiverId.trim() : '';
            if (!isAccountId(receiverId)) throw failure('Enter a valid NEAR recipient account ID.', 'RECIPIENT');
            const amount = parseNearAmount(body.amountNear, 'amount');
            const state = await requireVerifiedToken(tokenId, owner);
            await ensureReady(identity, {
                minBalanceYocto: 150_000_000_000_000_000_000_000n,
                targetBalanceYocto: 200_000_000_000_000_000_000_000n,
            });
            return {
                kind,
                receiverId: state.contractId,
                actionList: [actions.functionCall('relay_execute_subaccount', {
                    token_id: tokenId,
                    action: { TransferNear: { receiver_id: receiverId, amount: amount.toString() } },
                }, NEAR_GAS, 0n)],
                summary: {
                    title: `Send ${formatNear(amount)} NEAR`,
                    detail: `Send NEAR from ${state.associatedAccountId} to ${receiverId}. The RELAY contract locks the card and verifies ownership in the same transaction.`,
                    tokenId,
                },
            };
        }

        if (kind === 'transfer') {
            const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim().toLowerCase() : '';
            const receiverId = typeof body.receiverId === 'string' ? body.receiverId.trim() : '';
            if (!isAccountId(receiverId)) throw failure('Enter a valid NEAR recipient account ID.', 'RECIPIENT');
            await requireOwnedToken(tokenId, owner);
            await ensureReady(identity, {
                minBalanceYocto: 150_000_000_000_000_000_000_000n,
                targetBalanceYocto: 200_000_000_000_000_000_000_000n,
            });
            return {
                kind,
                receiverId: contractId,
                actionList: [actions.functionCall('nft_transfer', {
                    receiver_id: receiverId,
                    token_id: tokenId,
                    approval_id: null,
                    memo: null,
                }, NEAR_GAS, 1n)],
                summary: {
                    title: `Transfer ${tokenId}`,
                    detail: `Transfer the NFT and its associated account to ${receiverId}.`,
                    tokenId,
                },
            };
        }

        if (kind === 'ft_register') {
            const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim().toLowerCase() : '';
            const ftContractId = typeof body.ftContractId === 'string' ? body.ftContractId.trim() : '';
            if (!isAccountId(ftContractId)) throw failure('Select a supported NEP-141 contract.', 'FT_CONTRACT');
            const asset = ftRegistry().find((entry) => entry.contractId === ftContractId);
            if (!asset) throw failure('That NEP-141 asset is not supported by RELAY.', 'FT_UNSUPPORTED');
            const state = await requireVerifiedToken(tokenId, owner);
            await ensureReady(identity, {
                minBalanceYocto: 150_000_000_000_000_000_000_000n,
                targetBalanceYocto: 200_000_000_000_000_000_000_000n,
            });
            return {
                kind,
                receiverId: contractId,
                actionList: [actions.functionCall('relay_execute_subaccount', {
                    token_id: tokenId,
                    action: {
                        RegisterNep141: {
                            ft_contract_id: ftContractId,
                            storage_deposit: FT_STORAGE_DEPOSIT_YOCTO.toString(),
                        },
                    },
                }, NEAR_GAS, 0n)],
                summary: {
                    title: `Register ${asset.symbol} storage`,
                    detail: `Register ${state.associatedAccountId} with ${ftContractId} so the card can hold ${asset.symbol}.`,
                    tokenId,
                },
            };
        }

        if (kind === 'ft_spend') {
            const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim().toLowerCase() : '';
            const ftContractId = typeof body.ftContractId === 'string' ? body.ftContractId.trim() : '';
            const receiverId = typeof body.receiverId === 'string' ? body.receiverId.trim() : '';
            if (!isAccountId(ftContractId)) throw failure('Select a supported NEP-141 contract.', 'FT_CONTRACT');
            if (!ftRegistry().some((entry) => entry.contractId === ftContractId)) {
                throw failure('That NEP-141 asset is not supported by RELAY.', 'FT_UNSUPPORTED');
            }
            if (!isAccountId(receiverId)) throw failure('Enter a valid NEAR recipient account ID.', 'RECIPIENT');
            const amount = typeof body.amount === 'string' || typeof body.amount === 'number'
                ? BigInt(String(body.amount))
                : 0n;
            if (amount <= 0n) throw failure('Enter a positive token amount.', 'AMOUNT_INVALID');
            await requireVerifiedToken(tokenId, owner);
            // A NEP-141 transfer needs the receiver registered with the token
            // contract. For the demo stocks the treasury pays that storage so a
            // card can send to any Testnet account in one step.
            if (faucet?.isConfigured?.() && faucet.assetFor(ftContractId)) {
                await faucet.ensureRegistered({ contractId: ftContractId, accountId: receiverId });
            }
            await ensureReady(identity, {
                minBalanceYocto: 150_000_000_000_000_000_000_000n,
                targetBalanceYocto: 200_000_000_000_000_000_000_000n,
            });
            const paymentId = `near-auth-${crypto.randomBytes(8).toString('hex')}`;
            return {
                kind,
                receiverId: contractId,
                actionList: [actions.functionCall('relay_start_payment', {
                    token_id: tokenId,
                    source_ft_contract: ftContractId,
                    receiver_id: receiverId,
                    amount: amount.toString(),
                    payment_id: paymentId,
                    deadline: null,
                    transfer_call: false,
                    msg: '',
                }, NEAR_GAS, 0n)],
                summary: {
                    title: `Spend ${amount} base units`,
                    detail: `Transfer ${ftContractId} from ${tokenId}.${contractId} to ${receiverId} through relay_start_payment.`,
                    tokenId,
                    paymentId,
                },
            };
        }

        throw failure(`Unsupported action kind: ${kind}`, 'ACTION_KIND');
    }

    async function handleAuthVerify(request, response, url) {
        limiter.check(`login:${request.socket.remoteAddress || 'local'}`, 20, 10 * 60 * 1000);
        const body = await readJsonBody(request);
        const instance = getRelayer();
        const identity = await verifyNearAuthIdentity({
            idToken: body.idToken,
            publicKey: body.publicKey,
            parentAccountId: parentAccountId(),
            jwks,
            callFunction: ({ contractId, methodName, args }) => instance.viewFunction({ contractId, methodName, args }),
            now,
        });
        const ensured = await instance.ensureUserAccount({
            accountId: identity.accountId,
            publicKey: identity.publicKey,
        });
        const account = await instance.getAccount(identity.accountId);
        const previous = readSession(request).sessionId;
        if (previous) sessionStore.revokeSession(previous);
        const session = sessionStore.createSession({
            sub: identity.sub,
            email: identity.email,
            emailVerified: true,
            name: identity.name,
        });
        session.nearAuth = {
            sub: identity.sub,
            email: identity.email,
            emailVerified: true,
            name: identity.name,
            picture: identity.picture,
            accountId: identity.accountId,
            publicKey: identity.publicKey,
            path: identity.path,
            authDomain: identity.authDomain,
            verifiedAt: now(),
            idTokenExpiresAt: identity.idTokenExpiresAt,
        };
        const cookie = serializeCookie('relay_auth_session', session.sessionId, {
            maxAge: SESSION_TTL_SECONDS,
            httpOnly: true,
            sameSite: 'Lax',
            path: '/',
            secure: secureCookie,
        });
        if (journal?.record) {
            await journal.record({
                type: 'near-auth.identity.verified',
                accountId: identity.accountId,
                emailHash: crypto.createHash('sha256').update(identity.email).digest('hex'),
                createdAccount: ensured.created,
                createdAt: new Date(now()).toISOString(),
            }).catch(() => {});
        }

        // If a wallet is already connected in this browser, bind it to the
        // Google identity now. Both proofs (OAuth token + NEP-413) are already
        // present, so wallet-owned cards count as this Google account without
        // an extra Settings step.
        let autoLinked = null;
        try {
            const wallet = readWalletIdentity(request);
            if (wallet?.accountId) {
                autoLinked = linkStore.link({
                    sub: identity.sub,
                    accountId: wallet.accountId,
                    publicKey: wallet.publicKey,
                    providerId: null,
                });
            }
        } catch {
            // Best effort; the explicit link endpoint still works.
        }

        json(response, 200, {
            authenticated: true,
            autoLinked: Boolean(autoLinked),
            user: {
                sub: identity.sub,
                email: identity.email,
                emailVerified: true,
                name: identity.name,
                picture: identity.picture,
            },
            near: {
                accountId: identity.accountId,
                publicKey: identity.publicKey,
                path: identity.path,
                newAccount: ensured.created,
                balanceYocto: account?.amount?.toString?.() || '0',
                balanceNear: account ? formatNear(account.amount) : '0',
            },
            provider: 'near-auth',
            expiresAt: session.expiresAt,
        }, { 'set-cookie': cookie });
    }

    async function handleSession(request, response) {
        const { session } = readSession(request);
        if (!session?.nearAuth?.accountId) {
            return json(response, 200, { authenticated: false, provider: 'near-auth' });
        }
        const identity = session.nearAuth;
        let account = null;
        try {
            account = await provider.viewAccount({ accountId: identity.accountId });
        } catch {
            account = null;
        }
        return json(response, 200, {
            authenticated: true,
            provider: 'near-auth',
            user: {
                sub: identity.sub,
                email: identity.email,
                emailVerified: identity.emailVerified === true,
                name: identity.name,
                picture: identity.picture,
            },
            near: {
                accountId: identity.accountId,
                publicKey: identity.publicKey,
                path: identity.path,
                balanceYocto: account?.amount?.toString?.() || '0',
                balanceNear: account ? formatNear(account.amount) : '0',
                ready: Boolean(account),
            },
            expiresAt: session.expiresAt,
        });
    }

    async function handleLinkChallenge(request, response) {
        clearLinkChallenges();
        const { identity } = requireNearSession(request);
        const body = await readJsonBody(request);
        const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
        if (!validateNearAccountId(accountId)) {
            throw failure('A valid NEAR account ID is required to link a wallet.', 'ACCOUNT_ID');
        }
        if (accountId === identity.accountId) {
            throw failure('That account is already your Google-derived account.', 'ALREADY_PRIMARY', 409);
        }
        let account = null;
        try {
            account = await provider.viewAccount({ accountId });
        } catch {
            account = null;
        }
        if (!account) throw failure(`${accountId} does not exist on NEAR Testnet.`, 'ACCOUNT_MISSING', 404);

        const nonceBytes = crypto.randomBytes(32);
        const nonceHex = nonceBytes.toString('hex');
        const expiresAt = now() + LINK_CHALLENGE_TTL_MS;
        const challengeId = crypto.randomBytes(16).toString('hex');
        const message = [
            'RELAY account link',
            `Google account: ${identity.accountId}`,
            `Origin: ${appOrigin}`,
            `Account: ${accountId}`,
            `Nonce: ${nonceHex}`,
            `Expires: ${new Date(expiresAt).toISOString()}`,
        ].join('\n');
        linkChallenges.set(challengeId, {
            challengeId,
            sub: identity.sub,
            accountId,
            message,
            recipientAccountId: accountId,
            recipient: accountId,
            nonceBytes,
            nonceHex,
            appOrigin,
            issuedAt: now(),
            expiresAt,
        });
        return json(response, 200, {
            challengeId,
            accountId,
            message,
            recipient: accountId,
            nonce: Array.from(nonceBytes),
            nonceHex,
            expiresAt,
        });
    }

    async function handleLinkVerify(request, response) {
        clearLinkChallenges();
        const { identity } = requireNearSession(request);
        const body = await readJsonBody(request);
        const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
        const challenge = linkChallenges.get(challengeId);
        if (!challenge) throw failure('This link challenge has expired. Start again.', 'CHALLENGE_EXPIRED', 410);
        linkChallenges.delete(challengeId);
        if (challenge.sub !== identity.sub) {
            throw failure('This link challenge belongs to another Google account.', 'CHALLENGE_SUBJECT', 403);
        }
        const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
        if (accountId !== challenge.accountId) {
            throw failure('The wallet account changed while linking.', 'ACCOUNT_MISMATCH', 403);
        }
        const verified = await verifyNep413Signature({
            challenge,
            signature: body.signature,
            publicKey: body.publicKey,
            recipientAccountId: accountId,
            nearRpcUrl: envSource.RELAY_TEST_RPC_URL || config.near.rpcUrl,
            fetchImpl,
            expectedAppOrigin: appOrigin,
        });
        const linked = linkStore.link({
            sub: identity.sub,
            accountId,
            publicKey: verified.publicKey,
            providerId: typeof body.providerId === 'string' ? body.providerId.slice(0, 64) : null,
        });
        if (journal?.record) {
            await journal.record({
                type: 'near-auth.account.linked',
                accountId,
                googleAccountId: identity.accountId,
                createdAt: new Date(now()).toISOString(),
            }).catch(() => {});
        }
        return json(response, 200, {
            linked: true,
            account: linked,
            accounts: linkStore.listFor(identity.sub),
        });
    }

    async function handleLinkRemove(request, response) {
        const { identity } = requireNearSession(request);
        const body = await readJsonBody(request);
        const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
        if (!validateNearAccountId(accountId)) throw failure('A valid NEAR account ID is required.', 'ACCOUNT_ID');
        const removed = linkStore.unlink(identity.sub, accountId);
        return json(response, 200, {
            removed,
            accounts: linkStore.listFor(identity.sub),
        });
    }

    async function handleLinks(request, response) {
        const { identity } = requireNearSession(request);
        return json(response, 200, {
            googleAccountId: identity.accountId,
            accounts: linkStore.listFor(identity.sub),
        });
    }

    async function handlePrepare(request, response) {
        cleanupPending();
        const { session, identity } = requireNearSession(request);
        limiter.check(`prepare:${identity.sub}`, 40, 5 * 60 * 1000);
        if (activeByAccount.has(identity.accountId)) {
            throw failure('Another action for this account is still waiting for your Google signature.', 'ACTION_PENDING', 409);
        }
        const body = await readJsonBody(request);
        const kind = typeof body.kind === 'string' ? body.kind : '';
        const built = await buildAction(kind, body, identity);
        const instance = getRelayer();
        const prepared = await instance.prepareTransaction({
            signerId: identity.accountId,
            publicKey: identity.publicKey,
            receiverId: built.receiverId,
            actionList: built.actionList,
        });
        const id = crypto.randomBytes(18).toString('hex');
        const entry = {
            id,
            kind,
            sub: identity.sub,
            accountId: identity.accountId,
            publicKey: identity.publicKey,
            prepared,
            summary: built.summary,
            claimId: body.claimId || null,
            createdAt: now(),
            expiresAt: now() + PENDING_TTL_MS,
        };
        pending.set(id, entry);
        activeByAccount.set(identity.accountId, id);
        return json(response, 200, {
            prepared: true,
            actionId: id,
            kind,
            transactionBase64: prepared.base64,
            transactionHash: prepared.transactionHash,
            expiresAt: entry.expiresAt,
            summary: built.summary,
            signing: {
                guardId: `jwt#https://${AUTH_DOMAIN}/`,
                audience: AUTH_SIGNING_AUDIENCE,
                method: 'requestTransactionSignature',
            },
        });
    }

    async function handleSubmit(request, response) {
        cleanupPending();
        const { identity } = requireNearSession(request);
        limiter.check(`submit:${identity.sub}`, 40, 5 * 60 * 1000);
        const body = await readJsonBody(request);
        const id = typeof body.actionId === 'string' ? body.actionId : '';
        const entry = pending.get(id);
        if (!entry) throw failure('This signing request has expired. Start again.', 'ACTION_EXPIRED', 410);
        if (entry.sub !== identity.sub || entry.accountId !== identity.accountId) {
            throw failure('This signing request belongs to another account.', 'ACTION_OWNER', 403);
        }
        const signPayload = toByteArray(body.signPayload, 'signPayload');
        if (!signPayload.equals(entry.prepared.bytes)) {
            throw failure('Auth0 signed different bytes than RELAY prepared.', 'SIGN_PAYLOAD_MISMATCH', 400);
        }
        const claims = decodeJwtClaims(body.verifyPayload);
        if (claims.sub !== identity.sub) {
            throw failure('Auth0 identity does not match the logged-in RELAY session.', 'SIGN_SUBJECT_MISMATCH', 403);
        }
        // Defence in depth: the contract also enforces ownership, but a pending
        // intent must be rejected server-side if the NFT moved (or was minted
        // by someone else) between preparation and execution.
        await assertIntentStillAuthorized(entry, identity);
        pending.delete(id);
        if (activeByAccount.get(entry.accountId) === id) activeByAccount.delete(entry.accountId);

        const instance = getRelayer();
        let outcome;
        try {
            outcome = await instance.submitPreparedAction({
                prepared: entry.prepared,
                publicKey: identity.publicKey,
                request: {
                    guardId: body.guardId,
                    verifyPayload: body.verifyPayload,
                    signPayload: body.signPayload,
                },
            });
        } catch (error) {
            throw failure(
                error.code === 'SPONSOR_HOURLY_LIMIT' || error.code === 'SPONSOR_ACCOUNT_LIMIT'
                    ? error.message
                    : `The sponsored signing request failed: ${error.message}`,
                error.code || 'SUBMIT_FAILED',
                error.status || 502,
            );
        }
        if (!outcome.success) {
            throw failure('The transaction was finalized with an on-chain failure.', 'TRANSACTION_FAILED', 502);
        }
        let claim = null;
        if (entry.claimId) {
            claim = claimStore.markClaimed(entry.claimId, outcome.transactionHash);
        }
        if (journal?.record) {
            await journal.record({
                type: `near-auth.${entry.kind}.verified`,
                accountId: entry.accountId,
                tokenId: entry.summary?.tokenId || null,
                transactionHash: outcome.transactionHash,
                createdAt: new Date(now()).toISOString(),
            }).catch(() => {});
        }
        return json(response, 200, {
            submitted: true,
            actionId: id,
            kind: entry.kind,
            transactionHash: outcome.transactionHash,
            signTransactionHash: outcome.signTransactionHash,
            explorerUrl: `${config.near.explorerBaseUrl}/txns/${outcome.transactionHash}`,
            summary: entry.summary,
            claim,
        });
    }

    async function handleClaims(request, response, url) {
        if (request.method === 'POST' && url.pathname === '/api/near/claims') {
            const google = readGoogleIdentity(request);
            const wallet = readWalletIdentity(request);
            if (!google && !wallet) {
                throw failure(
                    'Sign in with Google or connect the owning wallet to create a claim.',
                    'AUTH_REQUIRED',
                    401,
                );
            }
            const body = await readJsonBody(request);
            const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim().toLowerCase() : '';
            const state = await tokenState(tokenId);
            if (!state) throw failure(`Token ${tokenId} does not exist.`, 'TOKEN_MISSING', 404);
            const owner = state.token.owner_id;

            // Either session may own the card. A connected wallet does not have
            // to be linked first, but a linked wallet still counts through the
            // Google identity so ownership survives a wallet reconnect.
            let ownerIdentity = null;
            if (google && google.accountId === owner) ownerIdentity = google;
            else if (wallet && wallet.accountId === owner) ownerIdentity = wallet;
            else if (google && accountsForIdentity(google).has(owner)) ownerIdentity = google;
            if (!ownerIdentity) {
                throw failure(
                    `This card is owned by ${owner}. Connect that wallet, or link it in Settings → Linked accounts, then try again.`,
                    'TOKEN_OWNER',
                    403,
                );
            }

            const claim = claimStore.create({
                tokenId,
                contractId: config.near.relayContractId,
                ownerAccountId: owner,
                ownerSub: ownerIdentity.sub,
                recipientEmail: body.email,
            });
            return json(response, 200, {
                created: true,
                claim,
                claimPath: `#/claim/near/${claim.id}`,
            });
        }
        if (request.method === 'GET' && url.pathname === '/api/near/claims') {
            const google = readGoogleIdentity(request);
            const wallet = readWalletIdentity(request);
            if (!google && !wallet) {
                throw failure('Sign in with Google or connect a wallet to list claims.', 'AUTH_REQUIRED', 401);
            }
            const seen = new Set();
            const claims = [];
            for (const identity of [google, wallet]) {
                if (!identity?.sub) continue;
                for (const claim of claimStore.listForOwner(identity.sub)) {
                    if (seen.has(claim.id)) continue;
                    seen.add(claim.id);
                    claims.push(claim);
                }
            }
            claims.sort((a, b) => b.createdAt - a.createdAt);
            return json(response, 200, { claims });
        }
        const match = url.pathname.match(/^\/api\/near\/claims\/([a-f0-9]{32})(?:\/(verify|cancel|prepare|complete))?$/);
        if (!match) return false;
        const [, id, action = null] = match;
        const entry = claimStore.get(id);
        if (!entry) throw failure('Claim not found.', 'CLAIM_NOT_FOUND', 404);

        if (request.method === 'GET' && !action) {
            return json(response, 200, { claim: claimStore.publicClaim(entry) });
        }
        if (request.method === 'POST' && action === 'verify') {
            const { identity } = requireNearSession(request);
            const claim = claimStore.verifyRecipient(id, {
                sub: identity.sub,
                email: identity.email,
                accountId: identity.accountId,
            });
            return json(response, 200, { verified: true, claim });
        }
        if (request.method === 'POST' && action === 'cancel') {
            const google = readGoogleIdentity(request);
            const wallet = readWalletIdentity(request);
            const identity = google || wallet;
            if (!identity) throw failure('Sign in to cancel a claim.', 'AUTH_REQUIRED', 401);
            return json(response, 200, { cancelled: true, claim: claimStore.cancel(id, identity.sub) });
        }
        if (request.method === 'POST' && action === 'prepare') {
            const google = readGoogleIdentity(request);
            const wallet = readWalletIdentity(request);
            if (!google && !wallet) throw failure('Sign in to approve this claim.', 'AUTH_REQUIRED', 401);
            const accounts = new Set([
                ...(google ? accountsForIdentity(google) : []),
                ...(wallet ? accountsForIdentity(wallet) : []),
            ]);
            const creator = [google, wallet].find((identity) => identity && claimStore.ownerHasClaim(entry, identity.sub));
            if (!creator && !accounts.has(entry.ownerAccountId)) {
                throw failure('Only the claim creator can approve this transfer.', 'CLAIM_OWNER', 403);
            }
            if (entry.status !== 'ready') {
                throw failure('The recipient has not verified their email yet.', 'CLAIM_NOT_READY', 409);
            }
            const state = await requireOwnedTokenFor(entry.tokenId, accounts);

            // A Google-derived account signs through the MPC key. A wallet-owned
            // NFT is signed by that wallet: the server returns the exact transfer
            // intent and the browser asks the wallet to sign it.
            if (!(google && state.token.owner_id === google.accountId)) {
                if (!wallet || wallet.accountId !== state.token.owner_id) {
                    throw failure(
                        `Reconnect the NEAR wallet that owns this card (${state.token.owner_id}) to approve the claim.`,
                        'WALLET_REQUIRED',
                        409,
                    );
                }
                return json(response, 200, {
                    mode: 'wallet',
                    prepared: false,
                    tokenId: entry.tokenId,
                    receiverId: entry.recipientAccountId,
                    summary: {
                        title: `Transfer ${entry.tokenId}`,
                        detail: `Transfer the NFT and its associated account to ${entry.recipientAccountId}. Wallet ${wallet.accountId} signs as the on-chain owner.`,
                        tokenId: entry.tokenId,
                        signer: wallet.accountId,
                    },
                    claim: claimStore.publicClaim(entry),
                });
            }

            const built = await buildAction('transfer', {
                tokenId: entry.tokenId,
                receiverId: entry.recipientAccountId,
            }, google);
            const instance = getRelayer();
            const prepared = await instance.prepareTransaction({
                signerId: google.accountId,
                publicKey: google.publicKey,
                receiverId: built.receiverId,
                actionList: built.actionList,
            });
            const actionId = crypto.randomBytes(18).toString('hex');
            pending.set(actionId, {
                id: actionId,
                kind: 'claim_transfer',
                sub: google.sub,
                accountId: google.accountId,
                publicKey: google.publicKey,
                prepared,
                summary: built.summary,
                claimId: id,
                createdAt: now(),
                expiresAt: now() + PENDING_TTL_MS,
            });
            activeByAccount.set(google.accountId, actionId);
            return json(response, 200, {
                mode: 'google',
                prepared: true,
                actionId,
                kind: 'claim_transfer',
                transactionBase64: prepared.base64,
                expiresAt: now() + PENDING_TTL_MS,
                summary: built.summary,
                claim: claimStore.publicClaim(entry),
            });
        }
        if (request.method === 'POST' && action === 'complete') {
            const google = readGoogleIdentity(request);
            const wallet = readWalletIdentity(request);
            if (!google && !wallet) throw failure('Sign in to finish this claim.', 'AUTH_REQUIRED', 401);
            const creator = [google, wallet].find((identity) => identity && claimStore.ownerHasClaim(entry, identity.sub));
            const ownsOwnerAccount = wallet && wallet.accountId === entry.ownerAccountId;
            if (!creator && !ownsOwnerAccount) {
                throw failure('Only the claim creator can complete this transfer.', 'CLAIM_OWNER', 403);
            }
            if (entry.status !== 'ready') {
                throw failure('The recipient has not verified their email yet.', 'CLAIM_NOT_READY', 409);
            }
            if (!wallet || wallet.accountId !== entry.ownerAccountId) {
                throw failure(
                    `Reconnect the NEAR wallet that owns this card (${entry.ownerAccountId}) to finish the claim.`,
                    'WALLET_REQUIRED',
                    409,
                );
            }
            const body = await readJsonBody(request);
            const transactionHash = typeof body.transactionHash === 'string' ? body.transactionHash : '';
            if (!/^[1-9A-HJ-NP-Za-km-z]{40,55}$/.test(transactionHash)) {
                throw failure('A valid NEAR transaction hash is required.', 'TRANSACTION_HASH', 400);
            }
            let tx;
            try {
                tx = await provider.sendJsonRpc('tx', {
                    tx_hash: transactionHash,
                    sender_account_id: entry.ownerAccountId,
                    wait_until: 'FINAL',
                });
            } catch (error) {
                throw failure(`The wallet transaction is not readable on NEAR Testnet: ${error.message}`, 'TRANSACTION_NOT_FOUND', 502);
            }
            const transaction = tx?.transaction;
            if (!transaction) throw failure('The wallet transaction has no readable body.', 'TRANSACTION_UNREADABLE', 502);
            if (transaction.signer_id !== entry.ownerAccountId) {
                throw failure('The transaction was signed by a different account.', 'SIGNER_MISMATCH', 403);
            }
            if (transaction.receiver_id !== config.near.relayContractId) {
                throw failure('The transaction does not target the RELAY contract.', 'RECEIVER_MISMATCH', 403);
            }
            const actions = normalizeActions(transaction.actions);
            const transfer = actions.find((item) => item.type === 'FunctionCall' && item.methodName === 'nft_transfer');
            if (!transfer) throw failure('The transaction is not an nft_transfer.', 'ACTION_MISMATCH', 403);
            let args = {};
            try {
                args = JSON.parse(Buffer.from(transfer.args, 'base64').toString('utf8'));
            } catch {
                args = {};
            }
            if (args.token_id !== entry.tokenId || args.receiver_id !== entry.recipientAccountId) {
                throw failure('The transfer does not match the verified claim.', 'ACTION_MISMATCH', 403);
            }
            if (tx?.final_execution_status && tx.final_execution_status !== 'FINAL') {
                throw failure('The transaction is not final yet.', 'NOT_FINAL', 409);
            }
            const receipts = Array.isArray(tx.receipts_outcome) ? tx.receipts_outcome : [];
            if (tx.status?.Failure || receipts.some((receipt) => receipt?.outcome?.status?.Failure)) {
                throw failure('The transaction finalized with an on-chain failure.', 'TRANSACTION_FAILED', 502);
            }
            const claim = claimStore.markClaimed(id, transactionHash);
            if (journal?.record) {
                await journal.record({
                    type: 'near-auth.claim.completed',
                    accountId: entry.ownerAccountId,
                    tokenId: entry.tokenId,
                    transactionHash,
                    createdAt: new Date(now()).toISOString(),
                }).catch(() => {});
            }
            return json(response, 200, {
                completed: true,
                mode: 'wallet',
                transactionHash,
                explorerUrl: `${config.near.explorerBaseUrl}/txns/${transactionHash}`,
                claim,
            });
        }
        throw failure('Unsupported claim operation.', 'CLAIM_OPERATION', 405);
    }

    /**
     * Public test-stock faucet. Any signed-in Google identity (including its
     * auto-linked wallets) or connected wallet can claim a fixed amount into a
     * card account it owns. The treasury signs the transfer; the caller only
     * proves ownership of the card, so no user transaction is needed.
     */
    async function handleStockClaim(request, response) {
        limiter.check(`stock-claim:${request.socket.remoteAddress || 'local'}`, 30, 10 * 60 * 1000);
        if (!faucet) throw failure('The test stock faucet is not configured.', 'FAUCET_UNCONFIGURED', 503);
        const body = await readJsonBody(request);
        const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim().toLowerCase() : '';
        const ftContractId = typeof body.ftContractId === 'string' ? body.ftContractId.trim() : '';
        if (!TOKEN_ID_RE.test(tokenId)) throw failure('Invalid RELAY token ID.', 'TOKEN_ID');
        if (!isAccountId(ftContractId)) throw failure('Select a supported NEP-141 contract.', 'FT_CONTRACT');

        const accounts = new Set();
        const { session } = readSession(request);
        const sub = session?.nearAuth?.sub || null;
        if (session?.nearAuth?.accountId) accounts.add(session.nearAuth.accountId);
        if (sub) {
            for (const accountId of linkStore.accountsFor(sub)) accounts.add(accountId);
        }
        const wallet = readWalletIdentity(request);
        if (wallet?.accountId) accounts.add(wallet.accountId);
        if (!accounts.size) throw failure('Sign in with Google or connect a NEAR wallet to claim.', 'AUTH_REQUIRED', 401);

        const state = await requireOwnedTokenFor(tokenId, accounts);
        if (!state.binding?.is_verified) {
            throw failure('Provision the card account before claiming test stock.', 'TOKEN_NOT_PROVISIONED', 409);
        }

        const result = await faucet.claim({
            contractId: ftContractId,
            tokenId,
            cardAccountId: state.associatedAccountId,
        });

        if (journal?.record) {
            await journal.record({
                type: 'stock.claim',
                tokenId,
                contractId: ftContractId,
                symbol: result.symbol,
                amount: result.amount,
                accountId: result.accountId,
                transactionHash: result.transactionHash,
                createdAt: new Date(now()).toISOString(),
            }).catch(() => {});
        }

        return json(response, 200, { claimed: true, ...result });
    }

    async function handle(request, response, url) {
        if (url.pathname === '/api/auth/near/config' && request.method === 'GET') {
            let configured = true;
            let reason = null;
            try {
                getRelayer();
            } catch (error) {
                configured = false;
                reason = error.message;
            }
            return json(response, 200, {
                provider: 'near-auth',
                network: config.near.network,
                domain: AUTH_DOMAIN,
                clientId: AUTH_CLIENT_ID,
                signingAudience: AUTH_SIGNING_AUDIENCE,
                contractId: config.near.relayContractId,
                parentAccountId: parentAccountId(),
                rpcUrl: config.near.rpcUrl,
                mpcContractId: envSource.NEAR_AUTH_MPC_CONTRACT_ID || 'v1.signer-prod.testnet',
                fastAuthContractId: envSource.NEAR_AUTH_FAST_AUTH_CONTRACT_ID || 'fast-auth.testnet',
                configured,
                reason,
                flow: 'google-auth0-mpc-ed25519',
            });
        }
        if (url.pathname === '/api/auth/near/verify' && request.method === 'POST') {
            await handleAuthVerify(request, response, url);
            return true;
        }
        if (url.pathname === '/api/auth/near/session' && request.method === 'GET') {
            await handleSession(request, response);
            return true;
        }
        if (url.pathname === '/api/auth/near/logout' && request.method === 'POST') {
            clearNearSession(request, response);
            return true;
        }
        if (url.pathname === '/api/auth/near/links' && request.method === 'GET') {
            await handleLinks(request, response);
            return true;
        }
        if (url.pathname === '/api/auth/near/links/challenge' && request.method === 'POST') {
            await handleLinkChallenge(request, response);
            return true;
        }
        if (url.pathname === '/api/auth/near/links/verify' && request.method === 'POST') {
            await handleLinkVerify(request, response);
            return true;
        }
        if (url.pathname === '/api/auth/near/links/remove' && request.method === 'POST') {
            await handleLinkRemove(request, response);
            return true;
        }
        if (url.pathname === '/api/near/prepare-action' && request.method === 'POST') {
            await handlePrepare(request, response);
            return true;
        }
        if (url.pathname === '/api/near/submit-action' && request.method === 'POST') {
            await handleSubmit(request, response);
            return true;
        }
        if (url.pathname === '/api/near/cancel-action' && request.method === 'POST') {
            const { identity } = requireNearSession(request);
            const body = await readJsonBody(request);
            const id = typeof body.actionId === 'string' ? body.actionId : '';
            const entry = pending.get(id);
            if (entry && entry.sub === identity.sub) {
                pending.delete(id);
                if (activeByAccount.get(entry.accountId) === id) activeByAccount.delete(entry.accountId);
            }
            return json(response, 200, { cancelled: true });
        }
        if (url.pathname.startsWith('/api/near/claims')) {
            return (await handleClaims(request, response, url)) !== false;
        }
        if (url.pathname === '/api/near/assets' && request.method === 'GET') {
            const tokenId = url.searchParams.get('tokenId');
            if (tokenId && !TOKEN_ID_RE.test(tokenId)) throw failure('Invalid RELAY token ID.', 'TOKEN_ID');
            const assets = await assetSnapshot(tokenId);
            return json(response, 200, {
                network: config.near.network,
                tokenId: tokenId || null,
                associatedAccountId: tokenId ? `${tokenId}.${config.near.relayContractId}` : null,
                assets,
            });
        }
        if (url.pathname === '/api/near/ft/stocks' && request.method === 'GET') {
            return json(response, 200, {
                network: config.near.network,
                configured: Boolean(faucet?.isConfigured()),
                assets: faucet ? faucet.assets() : [],
            });
        }
        if (url.pathname === '/api/near/ft/claim' && request.method === 'POST') {
            await handleStockClaim(request, response);
            return true;
        }
        if (url.pathname === '/api/near/account' && request.method === 'GET') {
            const { identity } = requireNearSession(request);
            const balance = await tokenAccountBalance(identity.accountId);
            return json(response, 200, { near: { accountId: identity.accountId, ...balance } });
        }
        return false;
    }

    return {
        handle,
        readSession,
        requireNearSession,
        claimStore,
        linkStore,
        getRelayer,
        limits: { pendingTtlMs: PENDING_TTL_MS, linkChallengeTtlMs: LINK_CHALLENGE_TTL_MS, sessionTtlSeconds: SESSION_TTL_SECONDS },
    };
}

module.exports = {
    DEFAULT_FT_ASSETS,
    MAX_BODY_BYTES,
    MINT_DEPOSIT_YOCTO,
    PROVISION_DEPOSIT_YOCTO,
    createNearAuthApi,
    formatNear,
    parseNearAmount,
};
