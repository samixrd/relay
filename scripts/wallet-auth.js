'use strict';

/**
 * RELAY external-wallet authentication and wallet-signed actions.
 *
 * This is a second, independent authentication mode. It is intentionally kept
 * separate from the Google / NEAR Auth session:
 *
 *   - Google login proves an Auth0 subject and unlocks an MPC key.
 *   - Wallet login proves control of a NEAR account with a NEP-413 signature
 *     over a server-issued challenge, using a FullAccess key that is present on
 *     Testnet for that account.
 *
 * A wallet account is never merged with a Google identity here. The wallet is
 * the signer for its own actions; the other wallet's account can never be used.
 *
 * Wallet actions are built server-side, signed and broadcast by the wallet, and
 * then independently verified by RELAY (finality, signer, receiver, exact
 * actions, and current on-chain NFT ownership) before the action is accepted.
 */

const crypto = require('node:crypto');
const { JsonRpcProvider } = require('near-api-js');
const { STOCK_ASSETS } = require('./stock-assets');
const {
    parseCookies,
    serializeCookie,
    validateNearAccountId,
    verifyNep413Signature,
} = require('./auth-provider-adapter');

const TOKEN_ID_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_BODY_BYTES = 64 * 1024;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MINT_DEPOSIT_YOCTO = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
const PROVISION_DEPOSIT_YOCTO = 1_950_000_000_000_000_000_000_000n; // 1.95 NEAR
const FT_STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const NEAR_GAS = 100n * 10n ** 12n;
// Provisioning creates the sub-account, deploys the controller WASM, calls its
// init method, and runs the callback. 100 TGas is not enough for the deploy and
// the network fails the call with "Exceeded the prepaid gas". The protocol
// ceiling for prepaid gas per transaction is 300 TGas, which is what the
// verified lifecycle/evidence scripts use.
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

function failure(message, code = 'WALLET_AUTH_ERROR', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function json(response, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(payload),
        ...headers,
    });
    response.end(payload);
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
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(failure('Request body must be valid JSON.', 'INVALID_JSON', 400));
            }
        });
        request.on('error', reject);
    });
}

function formatNear(yocto) {
    const value = BigInt(yocto);
    const whole = value / 10n ** 24n;
    const fraction = (value % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function normalizeActions(actions) {
    if (!Array.isArray(actions)) return [];
    return actions.map((action) => {
        if (action?.FunctionCall) {
            return {
                type: 'FunctionCall',
                methodName: action.FunctionCall.method_name,
                args: action.FunctionCall.args,
                gas: String(action.FunctionCall.gas),
                deposit: String(action.FunctionCall.deposit),
            };
        }
        if (action?.Transfer) {
            return { type: 'Transfer', deposit: String(action.Transfer.deposit) };
        }
        return { type: Object.keys(action || {})[0] || 'Unknown' };
    });
}

function sameActions(expected, actual) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
        const left = expected[index];
        const right = actual[index];
        if (!left || !right || left.type !== right.type) return false;
        if (left.type === 'FunctionCall') {
            if (left.methodName !== right.methodName) return false;
            if (left.gas !== right.gas) return false;
            if (left.deposit !== right.deposit) return false;
            const leftArgs = typeof left.args === 'string' ? Buffer.from(left.args, 'base64').toString('utf8') : JSON.stringify(left.args || {});
            const rightArgs = typeof right.args === 'string' ? Buffer.from(right.args, 'base64').toString('utf8') : JSON.stringify(right.args || {});
            const a = safeParse(leftArgs);
            const b = safeParse(rightArgs);
            if (JSON.stringify(a) !== JSON.stringify(b)) return false;
        }
        if (left.type === 'Transfer' && left.deposit !== right.deposit) return false;
    }
    return true;
}

function safeParse(value) {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function createWalletAuth({
    config,
    envSource = config.rawEnv || process.env,
    sessionStore,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    publicAppUrl = null,
    accountLinks = null,
    faucet = null,
} = {}) {
    if (!config) throw new Error('config is required');
    if (!sessionStore) throw new Error('sessionStore is required');

    const provider = new JsonRpcProvider({ url: config.near.rpcUrl });
    const fallbackUrl = envSource.RELAY_TEST_RPC_URL || 'https://test.rpc.fastnear.com';
    const fallbackProvider = fallbackUrl === config.near.rpcUrl ? null : new JsonRpcProvider({ url: fallbackUrl });
    const challenges = new Map();
    const pending = new Map();
    const secureCookie = Boolean((publicAppUrl || config.app.publicAppUrl || '').startsWith('https:'));
    const appOrigin = (publicAppUrl || config.app.publicAppUrl || `http://localhost:${config.app.port || 4173}`).replace(/\/$/, '');

    async function view(contractId, method, args = {}) {
        const request = { contractId, method, args, blockQuery: { finality: 'final' } };
        try {
            return await provider.callFunction(request);
        } catch (error) {
            const message = String(error?.message || error);
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

    async function viewAccount(accountId) {
        try {
            return await provider.viewAccount({ accountId });
        } catch (error) {
            if (/does not exist|UnknownAccount/i.test(String(error?.message || error))) return null;
            throw error;
        }
    }

    function tokenIdFrom(value) {
        const tokenId = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (!TOKEN_ID_RE.test(tokenId)) throw failure('Invalid RELAY token ID.', 'TOKEN_ID', 400);
        return tokenId;
    }

    async function tokenState(tokenId) {
        const contractId = config.near.relayContractId;
        if (!contractId) throw failure('RELAY_CONTRACT_ID is not configured.', 'CONTRACT_UNCONFIGURED', 503);
        const token = await view(contractId, 'nft_token', { token_id: tokenId });
        if (!token) return null;
        const binding = await view(contractId, 'relay_account_binding', { token_id: tokenId });
        return { token, binding, contractId, associatedAccountId: `${tokenId}.${contractId}` };
    }

    async function requireOwnedToken(tokenId, accountId) {
        const state = await tokenState(tokenId);
        if (!state) throw failure(`Token ${tokenId} does not exist.`, 'TOKEN_MISSING', 404);
        if (state.token.owner_id !== accountId) throw failure('Only the current NFT owner can do this.', 'TOKEN_OWNER', 403);
        return state;
    }

    async function requireVerifiedToken(tokenId, accountId) {
        const state = await requireOwnedToken(tokenId, accountId);
        if (!state.binding?.is_verified) throw failure('The card account is not provisioned yet.', 'TOKEN_NOT_PROVISIONED', 409);
        return state;
    }

    function readSession(request) {
        const cookies = parseCookies(request.headers.cookie);
        const id = cookies.relay_wallet_session;
        if (!id) return { sessionId: null, session: null };
        const session = sessionStore.getSession(id);
        if (!session) return { sessionId: null, session: null };
        return { sessionId: id, session };
    }

    function requireWalletSession(request) {
        const { sessionId, session } = readSession(request);
        const identity = session?.walletAuth;
        if (!identity?.accountId || !identity.publicKey) {
            throw failure('Connect a NEAR wallet to continue.', 'WALLET_AUTH_REQUIRED', 401);
        }
        return { sessionId, session, identity };
    }

    function clearWalletSession(request, response) {
        const cookies = parseCookies(request.headers.cookie);
        if (cookies.relay_wallet_session) sessionStore.revokeSession(cookies.relay_wallet_session);
        response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'set-cookie': serializeCookie('relay_wallet_session', '', {
                maxAge: 0,
                httpOnly: true,
                path: '/',
                sameSite: 'Lax',
                secure: secureCookie,
            }),
        });
        response.end(JSON.stringify({ authenticated: false, loggedOut: true, provider: 'near-wallet' }));
    }

    function cleanup() {
        const cutoff = now();
        for (const [id, entry] of challenges) if (entry.expiresAt <= cutoff) challenges.delete(id);
        for (const [id, entry] of pending) if (entry.expiresAt <= cutoff) pending.delete(id);
    }

    async function handleChallenge(request, response) {
        cleanup();
        const body = await readJsonBody(request);
        const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
        if (!validateNearAccountId(accountId)) throw failure('A valid NEAR Testnet account ID is required.', 'ACCOUNT_ID', 400);
        const account = await viewAccount(accountId);
        if (!account) throw failure(`${accountId} does not exist on NEAR Testnet.`, 'ACCOUNT_MISSING', 404);
        const nonceBytes = crypto.randomBytes(32);
        const nonceHex = nonceBytes.toString('hex');
        const expiresAt = now() + CHALLENGE_TTL_MS;
        const challengeId = crypto.randomBytes(16).toString('hex');
        const message = [
            'RELAY wallet authentication',
            `Origin: ${appOrigin}`,
            `Account: ${accountId}`,
            `Nonce: ${nonceHex}`,
            `Expires: ${new Date(expiresAt).toISOString()}`,
        ].join('\n');
        challenges.set(challengeId, {
            challengeId,
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

    async function handleVerify(request, response) {
        cleanup();
        const body = await readJsonBody(request);
        const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
        const challenge = challenges.get(challengeId);
        if (!challenge) throw failure('This wallet challenge has expired. Connect again.', 'CHALLENGE_EXPIRED', 410);
        challenges.delete(challengeId);
        const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
        if (accountId !== challenge.accountId) throw failure('Wallet account changed during authentication.', 'ACCOUNT_MISMATCH', 403);
        const verified = await verifyNep413Signature({
            challenge,
            signature: body.signature,
            publicKey: body.publicKey,
            recipientAccountId: accountId,
            nearRpcUrl: envSource.RELAY_TEST_RPC_URL || config.near.rpcUrl,
            fetchImpl,
            expectedAppOrigin: appOrigin,
        });
        const previous = readSession(request).sessionId;
        if (previous) sessionStore.revokeSession(previous);
        const session = sessionStore.createSession({
            sub: `wallet:${accountId}`,
            email: null,
            emailVerified: false,
            name: accountId,
        });
        session.walletAuth = {
            mode: 'wallet',
            accountId,
            publicKey: verified.publicKey,
            providerId: typeof body.providerId === 'string' ? body.providerId.slice(0, 64) : null,
            verifiedAt: now(),
            origin: appOrigin,
        };
        const account = await viewAccount(accountId);
        const cookie = serializeCookie('relay_wallet_session', session.sessionId, {
            maxAge: SESSION_TTL_SECONDS,
            httpOnly: true,
            sameSite: 'Lax',
            path: '/',
            secure: secureCookie,
        });

        // If this browser is already signed in with Google, bind the wallet to
        // that identity immediately. The wallet just proved control with a
        // NEP-413 signature, so this is the same evidence the explicit Settings
        // link uses; the user does not have to link twice.
        let autoLinked = null;
        if (accountLinks) {
            try {
                const cookies = parseCookies(request.headers.cookie);
                const googleSession = cookies.relay_auth_session
                    ? sessionStore.getSession(cookies.relay_auth_session)
                    : null;
                const googleSub = googleSession?.nearAuth?.sub;
                if (googleSub) {
                    autoLinked = accountLinks.link({
                        sub: googleSub,
                        accountId,
                        publicKey: verified.publicKey,
                        providerId: session.walletAuth.providerId,
                    });
                }
            } catch {
                // Auto-linking is best effort; the explicit link endpoint still works.
            }
        }

        return json(response, 200, {
            authenticated: true,
            provider: 'near-wallet',
            mode: 'wallet',
            linked: Boolean(autoLinked),
            account: {
                accountId,
                publicKey: verified.publicKey,
                providerId: session.walletAuth.providerId,
                exists: Boolean(account),
                balanceYocto: account?.amount?.toString?.() || '0',
                balanceNear: account ? formatNear(account.amount) : '0',
            },
            expiresAt: session.expiresAt,
        }, { 'set-cookie': cookie });
    }

    async function handleSession(request, response) {
        const { session } = readSession(request);
        const identity = session?.walletAuth;
        if (!identity?.accountId) {
            return json(response, 200, { authenticated: false, provider: 'near-wallet', mode: 'wallet' });
        }
        const account = await viewAccount(identity.accountId);
        return json(response, 200, {
            authenticated: true,
            provider: 'near-wallet',
            mode: 'wallet',
            account: {
                accountId: identity.accountId,
                publicKey: identity.publicKey,
                providerId: identity.providerId,
                exists: Boolean(account),
                balanceYocto: account?.amount?.toString?.() || '0',
                balanceNear: account ? formatNear(account.amount) : '0',
            },
            expiresAt: session.expiresAt,
        });
    }

    function ftRegistry() {
        const configured = envSource.RELAY_FT_ASSETS;
        if (!configured) return [...DEFAULT_FT_ASSETS];
        return configured.split(',').map((entry) => {
            const [contractId, symbol, decimals] = entry.split(':');
            if (!validateNearAccountId(contractId)) return null;
            return { contractId, symbol: symbol || contractId, decimals: Number(decimals || 24), name: symbol || contractId };
        }).filter(Boolean);
    }

    async function buildPlan(kind, body, identity) {
        const accountId = identity.accountId;
        const contractId = config.near.relayContractId;
        if (!contractId) throw failure('RELAY_CONTRACT_ID is not configured.', 'CONTRACT_UNCONFIGURED', 503);

        if (kind === 'mint') {
            const tokenId = tokenIdFrom(body.tokenId);
            if (tokenId.startsWith('u-')) throw failure('Token IDs beginning with u- are reserved for RELAY user accounts.', 'TOKEN_ID_RESERVED');
            if (await tokenState(tokenId)) throw failure(`Token ${tokenId} already exists.`, 'TOKEN_EXISTS', 409);
            const title = typeof body.name === 'string' ? body.name.trim() : '';
            if (!title || title.length > 64) throw failure('Card name must be between 1 and 64 characters.', 'METADATA');
            const description = typeof body.description === 'string' ? body.description.trim() : '';
            if (description.length > 500) throw failure('Description must be at most 500 characters.', 'METADATA');
            const media = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
            if (media && !/^(?:https:\/\/[^\s]+|\/uploads\/[a-z0-9-]+\.(?:png|jpe?g|webp))$/i.test(media)) {
                throw failure('Image URL must be an uploaded RELAY image or an HTTPS URL.', 'METADATA');
            }
            const initialCredits = body.initialCredits === undefined ? 3 : Number(body.initialCredits);
            if (!Number.isInteger(initialCredits) || initialCredits < 0 || initialCredits > 100) {
                throw failure('Initial credits must be an integer between 0 and 100.', 'METADATA');
            }
            const metadata = { title, description };
            if (media) metadata.media = media;
            return {
                kind,
                receiverId: contractId,
                actions: [{
                    type: 'FunctionCall',
                    methodName: 'relay_mint',
                    args: {
                        token_id: tokenId,
                        token_owner_id: accountId,
                        token_metadata: metadata,
                        associated_account_id: `${tokenId}.${contractId}`,
                        initial_credits: initialCredits,
                    },
                    gas: NEAR_GAS.toString(),
                    deposit: MINT_DEPOSIT_YOCTO.toString(),
                }],
                summary: {
                    title: `Create “${title}”`,
                    detail: `Mint NFT ${tokenId} to wallet ${accountId}. The wallet signs and pays the ${formatNear(MINT_DEPOSIT_YOCTO)} NEAR storage deposit and gas.`,
                    tokenId,
                    signer: accountId,
                },
            };
        }

        if (kind === 'provision') {
            const tokenId = tokenIdFrom(body.tokenId);
            const state = await requireOwnedToken(tokenId, accountId);
            if (state.binding?.is_verified) throw failure('This card account is already provisioned.', 'ALREADY_PROVISIONED', 409);
            return {
                kind,
                receiverId: contractId,
                actions: [{
                    type: 'FunctionCall',
                    methodName: 'relay_provision_subaccount',
                    args: { token_id: tokenId },
                    gas: PROVISION_GAS.toString(),
                    deposit: PROVISION_DEPOSIT_YOCTO.toString(),
                }],
                summary: {
                    title: `Provision the account for ${tokenId}`,
                    detail: `Create and verify ${state.associatedAccountId}. The wallet signs and funds the ${formatNear(PROVISION_DEPOSIT_YOCTO)} NEAR deposit.`,
                    tokenId,
                    signer: accountId,
                },
            };
        }

        if (kind === 'fund') {
            const tokenId = tokenIdFrom(body.tokenId);
            const state = await requireVerifiedToken(tokenId, accountId);
            const amount = parseNearAmount(body.amountNear);
            return {
                kind,
                receiverId: state.associatedAccountId,
                actions: [{ type: 'Transfer', deposit: amount.toString() }],
                summary: {
                    title: `Fund ${tokenId}`,
                    detail: `Send ${formatNear(amount)} NEAR from wallet ${accountId} into ${state.associatedAccountId}.`,
                    tokenId,
                    signer: accountId,
                    assetSource: `wallet ${accountId}`,
                },
            };
        }

        if (kind === 'spend') {
            const tokenId = tokenIdFrom(body.tokenId);
            const receiverId = typeof body.receiverId === 'string' ? body.receiverId.trim() : '';
            if (!validateNearAccountId(receiverId)) throw failure('Enter a valid NEAR recipient account ID.', 'RECIPIENT');
            const amount = parseNearAmount(body.amountNear);
            const state = await requireVerifiedToken(tokenId, accountId);
            return {
                kind,
                receiverId: contractId,
                actions: [{
                    type: 'FunctionCall',
                    methodName: 'relay_execute_subaccount',
                    args: {
                        token_id: tokenId,
                        action: { TransferNear: { receiver_id: receiverId, amount: amount.toString() } },
                    },
                    gas: NEAR_GAS.toString(),
                    deposit: '0',
                }],
                summary: {
                    title: `Send ${formatNear(amount)} NEAR`,
                    detail: `Send NEAR from ${state.associatedAccountId} to ${receiverId}. Wallet ${accountId} signs as the NFT owner. Source: card account.`,
                    tokenId,
                    signer: accountId,
                    assetSource: state.associatedAccountId,
                },
            };
        }

        if (kind === 'transfer') {
            const tokenId = tokenIdFrom(body.tokenId);
            const receiverId = typeof body.receiverId === 'string' ? body.receiverId.trim() : '';
            if (!validateNearAccountId(receiverId)) throw failure('Enter a valid NEAR recipient account ID.', 'RECIPIENT');
            await requireOwnedToken(tokenId, accountId);
            return {
                kind,
                receiverId: contractId,
                actions: [{
                    type: 'FunctionCall',
                    methodName: 'nft_transfer',
                    args: { receiver_id: receiverId, token_id: tokenId, approval_id: null, memo: null },
                    gas: NEAR_GAS.toString(),
                    deposit: '1',
                }],
                summary: {
                    title: `Transfer ${tokenId}`,
                    detail: `Transfer the NFT and its associated account to ${receiverId}. Wallet ${accountId} signs.`,
                    tokenId,
                    signer: accountId,
                },
            };
        }

        if (kind === 'ft_register') {
            const tokenId = tokenIdFrom(body.tokenId);
            const ftContractId = typeof body.ftContractId === 'string' ? body.ftContractId.trim() : '';
            if (!validateNearAccountId(ftContractId)) throw failure('Select a supported NEP-141 contract.', 'FT_CONTRACT');
            const asset = ftRegistry().find((entry) => entry.contractId === ftContractId);
            if (!asset) throw failure('That NEP-141 asset is not supported by RELAY.', 'FT_UNSUPPORTED');
            const state = await requireVerifiedToken(tokenId, accountId);
            return {
                kind,
                receiverId: contractId,
                actions: [{
                    type: 'FunctionCall',
                    methodName: 'relay_execute_subaccount',
                    args: {
                        token_id: tokenId,
                        action: {
                            RegisterNep141: {
                                ft_contract_id: ftContractId,
                                storage_deposit: FT_STORAGE_DEPOSIT_YOCTO.toString(),
                            },
                        },
                    },
                    gas: NEAR_GAS.toString(),
                    deposit: '0',
                }],
                summary: {
                    title: `Register ${asset.symbol} storage`,
                    detail: `Register ${state.associatedAccountId} with ${ftContractId}. Wallet ${accountId} signs as owner.`,
                    tokenId,
                    signer: accountId,
                },
            };
        }

        if (kind === 'ft_spend') {
            const tokenId = tokenIdFrom(body.tokenId);
            const ftContractId = typeof body.ftContractId === 'string' ? body.ftContractId.trim() : '';
            const receiverId = typeof body.receiverId === 'string' ? body.receiverId.trim() : '';
            if (!validateNearAccountId(ftContractId)) throw failure('Select a supported NEP-141 contract.', 'FT_CONTRACT');
            if (!ftRegistry().some((entry) => entry.contractId === ftContractId)) {
                throw failure('That NEP-141 asset is not supported by RELAY.', 'FT_UNSUPPORTED');
            }
            if (!validateNearAccountId(receiverId)) throw failure('Enter a valid NEAR recipient account ID.', 'RECIPIENT');
            const amount = typeof body.amount === 'string' || typeof body.amount === 'number' ? BigInt(String(body.amount)) : 0n;
            if (amount <= 0n) throw failure('Enter a positive token amount.', 'AMOUNT_INVALID');
            await requireVerifiedToken(tokenId, accountId);
            if (faucet?.isConfigured?.() && faucet.assetFor(ftContractId)) {
                await faucet.ensureRegistered({ contractId: ftContractId, accountId: receiverId });
            }
            const paymentId = `wallet-${crypto.randomBytes(8).toString('hex')}`;
            return {
                kind,
                receiverId: contractId,
                actions: [{
                    type: 'FunctionCall',
                    methodName: 'relay_start_payment',
                    args: {
                        token_id: tokenId,
                        source_ft_contract: ftContractId,
                        receiver_id: receiverId,
                        amount: amount.toString(),
                        payment_id: paymentId,
                        deadline: null,
                        transfer_call: false,
                        msg: '',
                    },
                    gas: NEAR_GAS.toString(),
                    deposit: '0',
                }],
                summary: {
                    title: `Spend ${amount} base units`,
                    detail: `Transfer ${ftContractId} from ${tokenId}.${contractId} to ${receiverId}. Wallet ${accountId} signs as owner.`,
                    tokenId,
                    paymentId,
                    signer: accountId,
                },
            };
        }

        throw failure(`Unsupported wallet action kind: ${kind}`, 'ACTION_KIND');
    }

    function parseNearAmount(value) {
        const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
        if (!/^\d+(?:\.\d{1,24})?$/.test(text)) throw failure('Enter a valid NEAR amount.', 'AMOUNT', 400);
        const [whole, fraction = ''] = text.split('.');
        const amount = BigInt(whole) * 10n ** 24n + BigInt((fraction + '0'.repeat(24)).slice(0, 24));
        if (amount <= 0n) throw failure('Enter an amount greater than zero.', 'AMOUNT', 400);
        return amount;
    }

    async function handlePrepare(request, response) {
        cleanup();
        const { identity } = requireWalletSession(request);
        const body = await readJsonBody(request);
        const kind = typeof body.kind === 'string' ? body.kind : '';
        const plan = await buildPlan(kind, body, identity);
        const actionId = crypto.randomBytes(18).toString('hex');
        pending.set(actionId, {
            id: actionId,
            kind,
            accountId: identity.accountId,
            sub: `wallet:${identity.accountId}`,
            plan,
            createdAt: now(),
            expiresAt: now() + PENDING_TTL_MS,
        });
        return json(response, 200, {
            prepared: true,
            mode: 'wallet',
            actionId,
            kind,
            receiverId: plan.receiverId,
            actions: plan.actions,
            summary: plan.summary,
            expiresAt: now() + PENDING_TTL_MS,
        });
    }

    async function handleConfirm(request, response) {
        cleanup();
        const { identity } = requireWalletSession(request);
        const body = await readJsonBody(request);
        const actionId = typeof body.actionId === 'string' ? body.actionId : '';
        const transactionHash = typeof body.transactionHash === 'string' ? body.transactionHash : '';
        if (!/^[1-9A-HJ-NP-Za-km-z]{40,55}$/.test(transactionHash)) {
            throw failure('A valid NEAR transaction hash is required.', 'TRANSACTION_HASH', 400);
        }
        const entry = pending.get(actionId);
        if (!entry) throw failure('This wallet action has expired. Start again.', 'ACTION_EXPIRED', 410);
        if (entry.sub !== `wallet:${identity.accountId}` || entry.accountId !== identity.accountId) {
            throw failure('This wallet action belongs to another account.', 'ACTION_OWNER', 403);
        }
        pending.delete(actionId);

        let tx;
        try {
            tx = await provider.sendJsonRpc('tx', {
                tx_hash: transactionHash,
                sender_account_id: identity.accountId,
                wait_until: 'FINAL',
            });
        } catch (error) {
            throw failure(`The wallet transaction is not readable on NEAR Testnet: ${error.message}`, 'TRANSACTION_NOT_FOUND', 502);
        }
        const transaction = tx?.transaction;
        if (!transaction) throw failure('The wallet transaction has no readable body.', 'TRANSACTION_UNREADABLE', 502);
        if (transaction.signer_id !== identity.accountId) {
            throw failure('The transaction was signed by a different account.', 'SIGNER_MISMATCH', 403);
        }
        if (transaction.receiver_id !== entry.plan.receiverId) {
            throw failure('The transaction receiver does not match the approved intent.', 'RECEIVER_MISMATCH', 403);
        }
        const actualActions = normalizeActions(transaction.actions);
        if (!sameActions(entry.plan.actions.map((action) => ({
            ...action,
            args: action.args ? Buffer.from(JSON.stringify(action.args)).toString('base64') : action.args,
        })), actualActions)) {
            throw failure('The transaction actions do not match the approved intent.', 'ACTIONS_MISMATCH', 403);
        }
        if (tx?.final_execution_status && tx.final_execution_status !== 'FINAL') {
            throw failure('The transaction is not final yet.', 'NOT_FINAL', 409);
        }
        const receipts = Array.isArray(tx.receipts_outcome) ? tx.receipts_outcome : [];
        const failed = tx.status?.Failure || receipts.some((receipt) => receipt?.outcome?.status?.Failure);
        if (failed) throw failure('The transaction finalized with an on-chain failure.', 'TRANSACTION_FAILED', 502);

        // Re-read ownership from the finalized chain. A pending intent must never
        // be accepted after the NFT moved to another account.
        if (entry.plan.summary?.tokenId) {
            const tokenId = entry.plan.summary.tokenId;
            if (entry.kind !== 'mint' && entry.kind !== 'transfer') {
                await requireOwnedToken(tokenId, identity.accountId);
            }
            if (entry.kind === 'mint') {
                const state = await tokenState(tokenId);
                if (!state || state.token.owner_id !== identity.accountId) {
                    throw failure('The minted NFT is not owned by the signing wallet.', 'OWNERSHIP_CHANGED', 403);
                }
            }
        }

        return json(response, 200, {
            updated: true,
            mode: 'wallet',
            actionId,
            kind: entry.kind,
            transactionHash,
            explorerUrl: `${config.near.explorerBaseUrl}/txns/${transactionHash}`,
            summary: entry.plan.summary,
        });
    }

    async function handleAssets(request, response, url) {
        requireWalletSession(request);
        const tokenId = url.searchParams.get('tokenId');
        if (tokenId && !TOKEN_ID_RE.test(tokenId)) throw failure('Invalid RELAY token ID.', 'TOKEN_ID');
        const target = tokenId ? `${tokenId}.${config.near.relayContractId}` : null;
        const assets = [];
        for (const asset of ftRegistry()) {
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
            assets.push({
                contractId: asset.contractId,
                symbol: metadata.symbol || asset.symbol,
                name: metadata.name || asset.name,
                decimals: Number(metadata.decimals ?? asset.decimals),
                balance: balance === null ? null : String(balance),
                registered: balance !== null,
            });
        }
        return json(response, 200, {
            network: config.near.network,
            tokenId: tokenId || null,
            associatedAccountId: target,
            assets,
        });
    }

    async function handle(request, response, url) {
        if (url.pathname === '/api/auth/wallet/challenge' && request.method === 'POST') {
            await handleChallenge(request, response);
            return true;
        }
        if (url.pathname === '/api/auth/wallet/verify' && request.method === 'POST') {
            await handleVerify(request, response);
            return true;
        }
        if (url.pathname === '/api/auth/wallet/session' && request.method === 'GET') {
            await handleSession(request, response);
            return true;
        }
        if (url.pathname === '/api/auth/wallet/logout' && request.method === 'POST') {
            clearWalletSession(request, response);
            return true;
        }
        if (url.pathname === '/api/near/wallet/prepare-action' && request.method === 'POST') {
            await handlePrepare(request, response);
            return true;
        }
        if (url.pathname === '/api/near/wallet/confirm-action' && request.method === 'POST') {
            await handleConfirm(request, response);
            return true;
        }
        if (url.pathname === '/api/near/wallet/assets' && request.method === 'GET') {
            await handleAssets(request, response, url);
            return true;
        }
        if (url.pathname === '/api/near/wallet/account' && request.method === 'GET') {
            const { identity } = requireWalletSession(request);
            const account = await viewAccount(identity.accountId);
            return json(response, 200, {
                near: {
                    accountId: identity.accountId,
                    exists: Boolean(account),
                    balanceYocto: account?.amount?.toString?.() || '0',
                    balanceNear: account ? formatNear(account.amount) : '0',
                },
            });
        }
        return false;
    }

    return {
        handle,
        readSession,
        requireWalletSession,
        limits: { challengeTtlMs: CHALLENGE_TTL_MS, pendingTtlMs: PENDING_TTL_MS, sessionTtlSeconds: SESSION_TTL_SECONDS },
    };
}

module.exports = {
    MINT_DEPOSIT_YOCTO,
    PROVISION_DEPOSIT_YOCTO,
    createWalletAuth,
    formatNear,
    normalizeActions,
    sameActions,
};
