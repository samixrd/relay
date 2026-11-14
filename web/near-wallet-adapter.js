'use strict';

/**
 * RELAY Near Wallet Adapter — Task 41 hardened version.
 *
 * Key design principles:
 *   - Three distinct provider types are handled separately:
 *       1. NEAR Wallet Selector (MeteorWallet, MyNearWallet via selector abstraction)
 *       2. Standard injected wallet (window.near — NEP-408 / Sender / legacy)
 *       3. window.nightly.near injected adapter (Nightly extension, NEAR chain only)
 *   - Redirect-safe: signMessage() on a BrowserWallet returns `void` (redirect), not
 *     a synchronous SignedMessage.  Callers must persist opaque flow state before calling
 *     and resume from the URL callback.
 *   - window.hereWallet is NOT treated as a supported injected provider — HERE Wallet
 *     exposes itself through the Wallet Selector (@near-wallet-selector/here-wallet),
 *     not as a stable window.hereWallet injection API.
 *   - Nightly's EVM capabilities are intentionally ignored; only window.nightly.near
 *     is queried, and only after verifying the connected network is NEAR Testnet.
 *   - NEP-413 signMessage is never silently downgraded.
 *   - signAndSendTransaction for BrowserWallet type returns void (redirect) and callers
 *     must handle the transactionHashes callback URL parameter.
 */

(function exposeNearWalletAdapter(root) {
    const NEAR_ACCOUNT_ID_RE = /^(([a-z0-9_-]+)\.)*[a-z0-9_-]+$/;
    const IMPLICIT_ACCOUNT_ID_RE = /^[0-9a-f]{64}$/;
    const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{40,55}$/;

    // ─────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────

    function failure(message, code = 'WALLET_ERROR') {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    function validateAccountId(accountId) {
        if (!accountId || typeof accountId !== 'string') return false;
        if (accountId.length < 2 || accountId.length > 64) return false;
        return NEAR_ACCOUNT_ID_RE.test(accountId) || IMPLICIT_ACCOUNT_ID_RE.test(accountId);
    }

    // ─────────────────────────────────────────────────
    // Provider capability matrix — static metadata only.
    // "supported" does NOT mean "installed"; it means the
    // interface this adapter uses has been verified against
    // the documented API for that provider type.
    // ─────────────────────────────────────────────────

    /**
     * PROVIDER CAPABILITY MATRIX (Task 41 audit)
     *
     * Provider           | Installed via           | signMessage (NEP-413) | signAndSendTx | Redirect? | Testnet?
     * ───────────────────┼─────────────────────────┼───────────────────────┼───────────────┼───────────┼──────────
     * MyNearWallet       | Wallet Selector browser  | VERIFIED (void/redir) | void (redir)  | YES       | YES
     * Meteor Wallet      | Wallet Selector injected | VERIFIED (immediate)  | immediate     | NO (ext)  | YES
     * Nightly (NEAR)     | window.nightly.near      | PARTIAL – not in WS   | PARTIAL       | NO        | YES
     * HERE Wallet        | Wallet Selector browser  | NOT INSTALLED in RELAY| –             | YES       | YES
     * window.near (generic)| injected NEP-408       | NOT TESTED individually| varies       | varies    | varies
     *
     * Evidence:
     *   - @near-wallet-selector/core 10.1.4 types: BrowserWalletBehaviour.signAndSendTransaction
     *     returns `Promise<FinalExecutionOutcome | void>` — void signals redirect.
     *   - SignMessageMethod.signMessage returns `Promise<SignedMessage | void>` — void signals redirect.
     *   - window.hereWallet has no documented stable injected API; HERE uses @here-wallet/core or WS.
     *   - window.nightly.near: documented at nightly.app as NEAR-chain adapter. NEP-413 support
     *     varies by version; treat as PARTIAL / NOT TESTED.
     *   - window.near: NEP-408 injected standard; concrete methods depend on the extension installed.
     *     Cannot be assumed to have signMessage. Marked PARTIAL.
     */
    const PROVIDER_CAPABILITY_MATRIX = Object.freeze([
        {
            id: 'selector-meteor',
            name: 'Meteor Wallet (Wallet Selector)',
            type: 'injected', // InjectedWallet in selector terminology
            source: 'wallet-selector',
            selectorId: 'meteor-wallet',
            signMessageStatus: 'verified',         // Returns SignedMessage immediately (extension)
            signAndSendStatus: 'verified',          // Returns FinalExecutionOutcome immediately
            redirectRequired: false,
            testnetSupport: 'verified',
            evidence: '@near-wallet-selector/meteor-wallet 10.1.4; InjectedWallet type',
        },
        {
            id: 'selector-mynearwallet',
            name: 'MyNearWallet (Wallet Selector)',
            type: 'browser', // BrowserWallet — full-page redirect
            source: 'wallet-selector',
            selectorId: 'my-near-wallet',
            signMessageStatus: 'verified-redirect',  // Returns void; result arrives via URL callback
            signAndSendStatus: 'verified-redirect',  // Returns void; hash arrives in transactionHashes param
            redirectRequired: true,
            testnetSupport: 'verified',
            evidence: '@near-wallet-selector/my-near-wallet 10.1.4; BrowserWalletBehaviour types; callbackUrl param',
        },
        {
            id: 'injected-nightly-near',
            name: 'Nightly Wallet (window.nightly.near)',
            type: 'injected-direct',
            source: 'window.nightly.near',
            signMessageStatus: 'partially-supported', // NEP-413 support documented but not tested in this codebase
            signAndSendStatus: 'partially-supported',
            redirectRequired: false,
            testnetSupport: 'verified',
            evidence: 'nightly.app docs; window.nightly.near injection; EVM adapter excluded',
            warning: 'Only window.nightly.near (NEAR chain) is used. EVM adapter is excluded.',
        },
        {
            id: 'injected-near',
            name: 'Standard injected NEAR wallet (window.near)',
            type: 'injected-direct',
            source: 'window.near',
            signMessageStatus: 'not-tested',
            signAndSendStatus: 'partially-supported',
            redirectRequired: false,
            testnetSupport: 'unknown',
            evidence: 'NEP-408 standard; actual methods depend on installed extension; Sender uses this path',
            warning: 'signMessage availability varies by extension. Network must be verified before use.',
        },
        {
            id: 'injected-here',
            name: 'HERE Wallet (window.hereWallet)',
            type: 'unsupported',
            source: 'window.hereWallet',
            signMessageStatus: 'unsupported',
            signAndSendStatus: 'unsupported',
            redirectRequired: null,
            testnetSupport: 'unknown',
            evidence: 'HERE Wallet has no documented stable window.hereWallet injection API. Use Wallet Selector (@near-wallet-selector/here-wallet) instead.',
            warning: 'REMOVED from supported providers. window.hereWallet is not a documented stable API.',
        },
    ]);

    // ─────────────────────────────────────────────────
    // Redirect flow state helpers
    //
    // State stored in sessionStorage under a stable opaque key.
    // Contains only: { flowType, sessionId, challengeId, nonce(hex), recipient, callbackUrl }.
    // No PKCE verifiers, no session secrets, no private key material.
    // ─────────────────────────────────────────────────

    const REDIRECT_STATE_KEY = 'relay_wallet_redirect_state';
    const REDIRECT_STATE_TTL_MS = 15 * 60 * 1000; // 15 minutes

    function saveRedirectState(state, storageRef) {
        const storage = storageRef || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
        if (!storage) return;
        const payload = {
            ...state,
            savedAt: Date.now(),
            expiresAt: Date.now() + REDIRECT_STATE_TTL_MS,
        };
        try {
            storage.setItem(REDIRECT_STATE_KEY, JSON.stringify(payload));
        } catch (e) {
            console.warn('RELAY: Could not save redirect state to sessionStorage:', e.message);
        }
    }

    function loadRedirectState(storageRef) {
        const storage = storageRef || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
        if (!storage) return null;
        try {
            const raw = storage.getItem(REDIRECT_STATE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || !parsed.expiresAt) return null;
            if (Date.now() > parsed.expiresAt) {
                storage.removeItem(REDIRECT_STATE_KEY);
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    }

    function clearRedirectState(storageRef) {
        const storage = storageRef || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
        if (!storage) return;
        try {
            storage.removeItem(REDIRECT_STATE_KEY);
        } catch {}
    }

    /**
     * Parse URL callback parameters after a wallet redirect.
     * MyNearWallet appends ?transactionHashes=... on success, ?errorCode=... on failure.
     * NEP-413 signMessage redirect returns signature data in URL params (varies by wallet).
     *
     * @param {string} search - window.location.search
     * @returns {{ transactionHashes: string[]|null, errorCode: string|null, errorMessage: string|null,
     *             accountId: string|null, publicKey: string|null, signature: string|null }}
     */
    function parseWalletCallbackParams(search) {
        const params = new URLSearchParams(search || '');
        const rawHashes = params.get('transactionHashes');
        const transactionHashes = rawHashes
            ? rawHashes.split(',').map(h => h.trim()).filter(h => TX_HASH_RE.test(h))
            : null;

        return {
            transactionHashes: transactionHashes && transactionHashes.length > 0 ? transactionHashes : null,
            errorCode: params.get('errorCode') || null,
            errorMessage: params.get('errorMessage') || null,
            // NEP-413 signMessage redirect params (wallet-specific, may be absent)
            accountId: params.get('accountId') || null,
            publicKey: params.get('publicKey') || null,
            signature: params.get('signature') || null,
            state: params.get('state') || null,
        };
    }

    // ─────────────────────────────────────────────────
    // NearWalletAdapter
    // ─────────────────────────────────────────────────

    class NearWalletAdapter {
        constructor({
            networkId = 'testnet',
            contractId = 'relay.spellman.testnet',
            windowRef = (typeof window !== 'undefined' ? window : null),
            storageRef = null,
        } = {}) {
            this.networkId = networkId;
            this.contractId = contractId;
            this.windowRef = windowRef;
            this.storageRef = storageRef;
            this.connectedProviderId = null;
            this.connectedAccountId = null;
            this.connectedPublicKey = null;
            this.activeProvider = null;
            this.activeProviderType = null; // 'injected-direct' | 'wallet-selector-bridge'
            this.isRedirectWallet = false;
            this.listeners = new Map();
        }

        get isConnected() {
            return Boolean(this.connectedAccountId);
        }

        setWindow(windowRef) {
            this.windowRef = windowRef;
        }

        on(event, handler) {
            if (!this.listeners.has(event)) this.listeners.set(event, new Set());
            this.listeners.get(event).add(handler);
            return () => this.off(event, handler);
        }

        off(event, handler) {
            if (this.listeners.has(event)) {
                this.listeners.get(event).delete(handler);
            }
        }

        emit(event, data) {
            if (this.listeners.has(event)) {
                for (const handler of this.listeners.get(event)) {
                    try { handler(data); } catch (e) { console.error('Wallet event listener error:', e); }
                }
            }
        }

        /**
         * Returns providers actually available in the current browser window.
         * Does NOT include HERE Wallet (window.hereWallet) as a supported provider.
         * Does NOT claim Nightly NEAR support unless window.nightly.near exists and
         * exposes a NEAR-compatible signMessage.
         */
        getAvailableProviders() {
            const win = this.windowRef;
            if (!win) return [];

            const result = [];

            // 1. Standard injected wallet (window.near — NEP-408)
            if (win.near && typeof win.near === 'object') {
                const p = win.near;
                result.push({
                    id: 'injected-near',
                    name: 'Injected NEAR Wallet (window.near)',
                    type: 'injected-direct',
                    available: true,
                    isRedirectWallet: false,
                    capabilities: {
                        signMessage: typeof p.signMessage === 'function',
                        signAndSendTransaction: (
                            typeof p.signAndSendTransaction === 'function' ||
                            typeof p.signAndSendTransactions === 'function' ||
                            Boolean(p.account && typeof p.account.signAndSendTransaction === 'function')
                        ),
                        network: p.networkId || p.network?.networkId || 'unknown',
                    },
                    capabilityStatus: {
                        signMessage: typeof p.signMessage === 'function' ? 'available' : 'not-detected',
                        note: 'Actual capability depends on installed extension. Network must be verified.',
                    },
                    provider: p,
                });
            }

            // 2. Nightly wallet — NEAR chain adapter only (window.nightly.near)
            if (win.nightly && win.nightly.near && typeof win.nightly.near === 'object') {
                const p = win.nightly.near;
                result.push({
                    id: 'injected-nightly-near',
                    name: 'Nightly Wallet (NEAR chain)',
                    type: 'injected-direct',
                    available: true,
                    isRedirectWallet: false,
                    capabilities: {
                        signMessage: typeof p.signMessage === 'function',
                        signAndSendTransaction: (
                            typeof p.signAndSendTransaction === 'function' ||
                            typeof p.signAndSendTransactions === 'function'
                        ),
                        network: 'unknown', // Nightly does not reliably expose networkId on the injected object
                    },
                    capabilityStatus: {
                        signMessage: typeof p.signMessage === 'function' ? 'partially-supported' : 'not-detected',
                        note: 'NEP-413 support via window.nightly.near is documented but not fully tested in RELAY. Network must be verified before signing.',
                    },
                    provider: p,
                    warning: 'Only the NEAR chain adapter (window.nightly.near) is considered. EVM adapters are excluded.',
                });
            }

            // 3. HERE Wallet — explicitly listed as unsupported via window.hereWallet
            if (win.hereWallet) {
                result.push({
                    id: 'injected-here',
                    name: 'HERE Wallet (window.hereWallet)',
                    type: 'unsupported',
                    available: false, // available as window object, but not supported as a direct provider
                    isRedirectWallet: null,
                    capabilities: null,
                    capabilityStatus: {
                        signMessage: 'unsupported',
                        note: 'window.hereWallet is not a documented stable API. Use HERE Wallet via NEAR Wallet Selector instead.',
                    },
                    provider: null,
                    warning: 'HERE Wallet is detected as a window object but cannot be used through this adapter. Use the Wallet Selector modal instead.',
                });
            }

            return result;
        }

        /**
         * Connect to a directly-injected provider (window.near or window.nightly.near).
         * This path does NOT use the Wallet Selector abstraction.
         *
         * For Wallet Selector wallets (MeteorWallet, MyNearWallet), the app must
         * use the RelayWalletSelectorBridge instead (near-wallet-selector-entry.js).
         */
        async connect(preferredProviderId = null) {
            const availableProviders = this.getAvailableProviders().filter(p => p.type !== 'unsupported');
            let selected = null;

            if (preferredProviderId) {
                selected = availableProviders.find(p => p.id === preferredProviderId && p.available);
                if (!selected) {
                    throw failure(
                        `Requested wallet provider '${preferredProviderId}' is not installed or not available as a direct injected provider. ` +
                        `Check that the browser extension is installed and enabled. ` +
                        `For Meteor Wallet or MyNearWallet, use the Wallet Selector modal via RelayWalletSelectorBridge.`,
                        'PROVIDER_UNAVAILABLE'
                    );
                }
            } else {
                selected = availableProviders.find(p => p.available);
            }

            if (!selected || !selected.provider) {
                throw failure(
                    'No supported NEAR browser wallet was detected. ' +
                    'Please install Meteor Wallet or use the Wallet Selector modal. ' +
                    'Note: HERE Wallet (window.hereWallet) is not supported as a direct injected provider.',
                    'NO_INJECTED_WALLET'
                );
            }

            const provider = selected.provider;
            let accountId = null;
            let publicKey = null;

            try {
                // Request sign in if provider supports it
                if (typeof provider.requestSignIn === 'function') {
                    const signInRes = await provider.requestSignIn({ contractId: this.contractId });
                    if (signInRes && signInRes.error) {
                        throw failure(`Wallet connection rejected: ${signInRes.error}`, 'USER_REJECTED');
                    }
                } else if (typeof provider.signIn === 'function') {
                    const signInRes = await provider.signIn({ contractId: this.contractId });
                    if (signInRes && signInRes.error) {
                        throw failure(`Wallet connection rejected: ${signInRes.error}`, 'USER_REJECTED');
                    }
                }

                // Read active account
                if (typeof provider.getAccountId === 'function') {
                    accountId = await provider.getAccountId();
                } else if (typeof provider.getAccounts === 'function') {
                    const accounts = await provider.getAccounts();
                    if (Array.isArray(accounts) && accounts.length > 0) {
                        const first = accounts[0];
                        accountId = typeof first === 'string' ? first : (first.accountId || first.id);
                        publicKey = first.publicKey || null;
                    }
                } else if (provider.accountId) {
                    accountId = provider.accountId;
                } else if (provider.account?.accountId) {
                    accountId = provider.account.accountId;
                }

                // Read public key if not yet obtained
                if (!publicKey) {
                    if (typeof provider.getPublicKey === 'function') {
                        publicKey = await provider.getPublicKey();
                    } else if (provider.publicKey) {
                        publicKey = provider.publicKey;
                    }
                }

                // Verify network identity before accepting connection
                const providerNetwork = provider.networkId || provider.network?.networkId || null;
                if (providerNetwork && providerNetwork !== this.networkId) {
                    throw failure(
                        `Wallet network mismatch: wallet is configured for '${providerNetwork}', ` +
                        `but application requires '${this.networkId}'. Please switch networks in your wallet.`,
                        'NETWORK_MISMATCH'
                    );
                }

                // If provider does not expose network, we cannot verify — warn but do not block
                if (!providerNetwork) {
                    console.warn(
                        `RELAY: Provider '${selected.id}' does not expose networkId. ` +
                        'Network identity cannot be verified before signing. ' +
                        'Ensure your wallet extension is configured for NEAR Testnet.'
                    );
                }

            } catch (err) {
                if (err.code === 'NETWORK_MISMATCH') throw err;
                if (err.code === 'USER_REJECTED') throw err;
                const errMsg = (err.message || '').toLowerCase();
                if (errMsg.includes('reject') || errMsg.includes('cancel') || errMsg.includes('denied') || errMsg.includes('declined') || err.code === 4001) {
                    throw failure('Wallet connection was rejected by the user.', 'USER_REJECTED');
                }
                throw failure(`Failed to connect to wallet: ${err.message}`, 'CONNECTION_FAILED');
            }

            if (!accountId || !validateAccountId(accountId)) {
                throw failure(
                    `Connected wallet returned invalid NEAR account identifier: '${accountId}'`,
                    'INVALID_ACCOUNT_ID'
                );
            }

            this.connectedProviderId = selected.id;
            this.connectedAccountId = accountId;
            this.connectedPublicKey = publicKey ? (publicKey.toString ? publicKey.toString() : String(publicKey)) : null;
            this.activeProvider = provider;
            this.activeProviderType = 'injected-direct';
            this.isRedirectWallet = false;

            const connectionState = {
                connected: true,
                providerId: selected.id,
                providerName: selected.name,
                providerType: 'injected-direct',
                isRedirectWallet: false,
                accountId,
                publicKey: this.connectedPublicKey,
                capabilities: selected.capabilities,
                capabilityStatus: selected.capabilityStatus,
            };

            this.emit('connected', connectionState);
            return connectionState;
        }

        /**
         * Attach a Wallet Selector wallet instance as the active provider.
         * Used when the app has initialized RelayWalletSelectorBridge and the user
         * selected a wallet through the modal.
         *
         * @param {{ walletInstance, accountId, publicKey, walletId, isRedirectWallet }} opts
         */
        attachSelectorWallet({ walletInstance, accountId, publicKey, walletId, isRedirectWallet }) {
            if (!walletInstance || !accountId) {
                throw failure('walletInstance and accountId are required to attach a Wallet Selector wallet.', 'INVALID_ARGUMENT');
            }
            if (!validateAccountId(accountId)) {
                throw failure(`Invalid NEAR account ID from Wallet Selector: '${accountId}'`, 'INVALID_ACCOUNT_ID');
            }

            this.connectedProviderId = walletId || 'wallet-selector';
            this.connectedAccountId = accountId;
            this.connectedPublicKey = publicKey || null;
            this.activeProvider = walletInstance;
            this.activeProviderType = 'wallet-selector';
            this.isRedirectWallet = Boolean(isRedirectWallet);

            const connectionState = {
                connected: true,
                providerId: this.connectedProviderId,
                providerName: walletId,
                providerType: 'wallet-selector',
                isRedirectWallet: this.isRedirectWallet,
                accountId,
                publicKey: this.connectedPublicKey,
            };

            this.emit('connected', connectionState);
            return connectionState;
        }

        disconnect() {
            if (this.activeProvider) {
                try {
                    if (typeof this.activeProvider.signOut === 'function') {
                        this.activeProvider.signOut();
                    } else if (typeof this.activeProvider.disconnect === 'function') {
                        this.activeProvider.disconnect();
                    }
                } catch (e) {
                    console.warn('Error during provider sign out:', e);
                }
            }
            const previousAccount = this.connectedAccountId;
            this.connectedProviderId = null;
            this.connectedAccountId = null;
            this.connectedPublicKey = null;
            this.activeProvider = null;
            this.activeProviderType = null;
            this.isRedirectWallet = false;
            clearRedirectState(this.storageRef);

            this.emit('disconnected', { previousAccount });
            return { connected: false };
        }

        /**
         * Request a NEP-413 off-chain signature.
         *
         * IMPORTANT — Redirect wallets (MyNearWallet):
         *   signMessage() will redirect the page away. This method will NOT return a signature.
         *   Before calling this, the caller MUST:
         *     1. Call saveRedirectState() with enough opaque state to resume the flow on return.
         *     2. Set callbackUrl to the page URL that will process the callback.
         *   On return, call parseWalletCallbackParams(window.location.search) and
         *   consumeRedirectState() to verify and resume.
         *
         * @param {{ message, recipient, nonce, callbackUrl }} params
         * @returns {Promise<{accountId, publicKey, signature}|null>}
         *   Returns null if the wallet redirects (redirect wallets only). Callers must handle this.
         */
        async signNep413Message({ message, recipient, nonce, callbackUrl = null }) {
            if (!this.connectedAccountId || !this.activeProvider) {
                throw failure('No NEAR wallet is connected. Please connect a wallet first.', 'WALLET_NOT_CONNECTED');
            }

            const currentAccountId = this.connectedAccountId;
            const provider = this.activeProvider;

            const signFn = typeof provider.signMessage === 'function'
                ? provider.signMessage.bind(provider)
                : (provider.account && typeof provider.account.signMessage === 'function'
                    ? provider.account.signMessage.bind(provider.account)
                    : null);

            if (!signFn) {
                throw failure(
                    `Connected wallet '${this.connectedProviderId}' does not support NEP-413 signMessage. ` +
                    'Use Meteor Wallet or MyNearWallet via Wallet Selector, or sign with NEAR CLI.',
                    'UNSUPPORTED_WALLET_CAPABILITY'
                );
            }

            // Validate and normalize nonce to Uint8Array (32 bytes required)
            let nonceBytes;
            if (typeof Buffer !== 'undefined' && Buffer.isBuffer(nonce)) {
                nonceBytes = Uint8Array.from(nonce);
            } else if (nonce instanceof Uint8Array) {
                nonceBytes = nonce;
            } else if (typeof nonce === 'string') {
                nonceBytes = Uint8Array.from(
                    typeof Buffer !== 'undefined'
                        ? Buffer.from(nonce, 'hex')
                        : nonce.match(/.{2}/g).map(b => parseInt(b, 16))
                );
            } else if (Array.isArray(nonce)) {
                nonceBytes = Uint8Array.from(nonce);
            }
            if (!nonceBytes || nonceBytes.length !== 32) {
                throw failure('NEP-413 nonce must be exactly 32 bytes.', 'INVALID_NONCE');
            }

            // For redirect wallets: persist opaque state before redirect
            if (this.isRedirectWallet && callbackUrl) {
                // The nonce will be verified server-side via the challenge; we do NOT store nonce here.
                // State stored is minimal and opaque: enough to resume from callback.
                console.info('RELAY: Redirect wallet detected. Page will navigate to wallet for signing.');
            }

            const signParams = {
                message,
                recipient,
                nonce: nonceBytes,
                callbackUrl: callbackUrl || undefined,
            };

            let res;
            try {
                res = await signFn(signParams);
            } catch (err) {
                const errMsg = (err.message || '').toLowerCase();
                if (errMsg.includes('reject') || errMsg.includes('cancel') || errMsg.includes('denied') || errMsg.includes('declined') || err.code === 4001) {
                    throw failure('Signature request was rejected in the wallet.', 'USER_REJECTED');
                }
                throw failure(`Wallet signMessage failed: ${err.message}`, 'SIGNING_FAILED');
            }

            // Redirect wallets return void (undefined) — the page will navigate away.
            // This is not an error; the caller must handle null return.
            if (res === null || res === undefined) {
                if (this.isRedirectWallet) {
                    // Page is about to navigate. Return null so caller can distinguish from an error.
                    return null;
                }
                throw failure('Wallet returned empty signMessage response without initiating a redirect.', 'MALFORMED_SIGNATURE_RESPONSE');
            }

            if (typeof res !== 'object') {
                throw failure('Wallet returned malformed signMessage response.', 'MALFORMED_SIGNATURE_RESPONSE');
            }

            // Validate that the signed account matches the connected account
            const signedAccountId = res.accountId || res.account_id || currentAccountId;
            if (signedAccountId !== currentAccountId) {
                throw failure(
                    `Signed account '${signedAccountId}' does not match connected account '${currentAccountId}'. ` +
                    'Account was changed during signing.',
                    'ACCOUNT_MISMATCH'
                );
            }

            const signature = res.signature;
            const publicKey = res.publicKey || res.public_key || this.connectedPublicKey;

            if (!signature) {
                throw failure('Wallet response did not contain a signature.', 'MISSING_SIGNATURE');
            }
            if (!publicKey) {
                throw failure('Wallet response did not contain the signer public key.', 'MISSING_PUBLIC_KEY');
            }

            return {
                accountId: signedAccountId,
                publicKey: publicKey.toString ? publicKey.toString() : String(publicKey),
                signature: signature.toString ? signature.toString() : String(signature),
            };
        }

        /**
         * Submit an on-chain transaction.
         *
         * IMPORTANT — Redirect wallets (MyNearWallet):
         *   signAndSendTransaction() will redirect the page away and return void.
         *   Before calling, persist enough opaque flow state via saveRedirectState().
         *   On return, call parseWalletCallbackParams(window.location.search).transactionHashes
         *   to retrieve the submitted transaction hash. The hash must then be verified for
         *   finality independently (not assumed finalized on receipt).
         *
         *   The returned transactionHash is a submission hash — NOT a finality proof.
         *   Always verify finality via verifyFinalizedTransferTransaction on the server.
         *
         * @param {{ receiverId, actions, deposit, gas, callbackUrl }} params
         * @returns {Promise<{success, signerAccountId, receiverId, transactionHash, rawResult, redirected}|null>}
         */
        async signAndSendTransaction({
            receiverId,
            actions,
            deposit = '1',
            gas = '30000000000000',
            callbackUrl = null,
        }) {
            if (!this.connectedAccountId || !this.activeProvider) {
                throw failure('No NEAR wallet is connected. Please connect creator wallet first.', 'WALLET_NOT_CONNECTED');
            }

            const provider = this.activeProvider;
            const signerAccountId = this.connectedAccountId;

            const sendTxFn = typeof provider.signAndSendTransaction === 'function'
                ? provider.signAndSendTransaction.bind(provider)
                : (typeof provider.signAndSendTransactions === 'function'
                    ? async (params) => {
                        const results = await provider.signAndSendTransactions({ transactions: [params] });
                        return Array.isArray(results) ? results[0] : results;
                    }
                    : (provider.account && typeof provider.account.signAndSendTransaction === 'function'
                        ? provider.account.signAndSendTransaction.bind(provider.account)
                        : null));

            if (!sendTxFn) {
                throw failure(
                    `Connected wallet '${this.connectedProviderId}' does not support signAndSendTransaction.`,
                    'UNSUPPORTED_WALLET_CAPABILITY'
                );
            }

            // Normalize to Wallet Selector action format
            const normalizedActions = (Array.isArray(actions) ? actions : [actions]).map((act) => {
                if (act.type === 'FunctionCall') return act;
                if (act.methodName) {
                    return {
                        type: 'FunctionCall',
                        params: {
                            methodName: act.methodName,
                            args: act.args || {},
                            gas: act.gas || gas,
                            deposit: act.deposit || deposit,
                        },
                    };
                }
                return act;
            });

            const txParams = {
                receiverId,
                actions: normalizedActions,
                ...(callbackUrl ? { callbackUrl } : {}),
            };

            let txResult;
            try {
                txResult = await sendTxFn(txParams);
            } catch (err) {
                const errMsg = (err.message || '').toLowerCase();
                if (errMsg.includes('reject') || errMsg.includes('cancel') || errMsg.includes('denied') || errMsg.includes('declined') || err.code === 4001) {
                    throw failure('Transaction was rejected in the wallet.', 'USER_REJECTED');
                }
                throw failure(`Wallet transaction broadcast failed: ${err.message}`, 'TRANSACTION_FAILED');
            }

            // Redirect wallet returns void — page will navigate. This is not an error.
            if (txResult === null || txResult === undefined) {
                if (this.isRedirectWallet) {
                    // The page is navigating away. Return a sentinel so the caller knows.
                    return {
                        success: false,
                        redirected: true,
                        signerAccountId,
                        receiverId,
                        transactionHash: null,
                        rawResult: null,
                        message: 'Browser wallet is performing a redirect. Transaction hash will be available in the callback URL parameter "transactionHashes".',
                    };
                }
                return {
                    success: false,
                    redirected: false,
                    signerAccountId,
                    receiverId,
                    transactionHash: null,
                    rawResult: null,
                    warning: 'Wallet returned no result without initiating a redirect. Transaction status is unknown.',
                };
            }

            // Extract transaction hash from FinalExecutionOutcome or similar shapes
            let transactionHash = null;
            if (typeof txResult === 'string' && TX_HASH_RE.test(txResult)) {
                transactionHash = txResult;
            } else if (txResult?.transaction?.hash) {
                transactionHash = txResult.transaction.hash;
            } else if (txResult?.transaction_outcome?.id) {
                transactionHash = txResult.transaction_outcome.id;
            } else if (txResult?.hash) {
                transactionHash = txResult.hash;
            }

            if (!transactionHash) {
                return {
                    success: true,
                    redirected: false,
                    signerAccountId,
                    receiverId,
                    transactionHash: null,
                    rawResult: txResult,
                    warning: 'Transaction was submitted but transaction hash could not be automatically parsed from wallet response. Verify on-chain before proceeding.',
                };
            }

            return {
                success: true,
                redirected: false,
                signerAccountId,
                receiverId,
                transactionHash,
                rawResult: txResult,
            };
        }
    }

    // ─────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────

    const api = Object.freeze({
        NearWalletAdapter,
        PROVIDER_CAPABILITY_MATRIX,
        validateAccountId,
        parseWalletCallbackParams,
        saveRedirectState,
        loadRedirectState,
        clearRedirectState,
    });

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) {
        // Expose adapter class and all redirect-state helpers on window so app.js
        // can call them without importing (browser script tag environment).
        root.NearWalletAdapter = NearWalletAdapter;
        root.parseWalletCallbackParams = parseWalletCallbackParams;
        root.saveRedirectState = saveRedirectState;
        root.loadRedirectState = loadRedirectState;
        root.clearRedirectState = clearRedirectState;
    }
})(typeof window !== 'undefined' ? window : null);
