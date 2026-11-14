'use strict';

/**
 * near-wallet-adapter.test.js — Task 41 hardened wallet adapter tests.
 *
 * Tests are organized into logical groups:
 *   1. validateAccountId
 *   2. PROVIDER_CAPABILITY_MATRIX contents
 *   3. getAvailableProviders — detection and honesty
 *   4. connect() — network verification, rejection, account switching
 *   5. attachSelectorWallet()
 *   6. disconnect()
 *   7. signNep413Message() — immediate and redirect flows
 *   8. signAndSendTransaction() — immediate and redirect flows
 *   9. parseWalletCallbackParams() — URL callback parsing
 *  10. Redirect state helpers
 *
 * Synthetic fixtures are labelled SYNTHETIC. Fixtures based on documented
 * RPC/wallet response shapes are labelled DOCUMENTED-SHAPE.
 *
 * Tests do NOT make live network calls.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    NearWalletAdapter,
    PROVIDER_CAPABILITY_MATRIX,
    validateAccountId,
    parseWalletCallbackParams,
    saveRedirectState,
    loadRedirectState,
    clearRedirectState,
} = require('./near-wallet-adapter');

// ─────────────────────────────────────────────────
// 1. validateAccountId
// ─────────────────────────────────────────────────

test('validateAccountId accepts valid NEAR named and implicit accounts', () => {
    assert.equal(validateAccountId('alice.testnet'), true);
    assert.equal(validateAccountId('relay-owner-b.spellman.testnet'), true);
    assert.equal(validateAccountId('a.b'), true);
    // Implicit (64 hex chars)
    assert.equal(validateAccountId('0'.repeat(64)), true);
    assert.equal(validateAccountId('a'.repeat(64)), true);
});

test('validateAccountId rejects invalid identifiers', () => {
    assert.equal(validateAccountId(''), false);
    assert.equal(validateAccountId('A'), false);                 // too short AND uppercase
    assert.equal(validateAccountId('UPPERCASE.testnet'), false); // uppercase
    assert.equal(validateAccountId('bad@character'), false);
    assert.equal(validateAccountId('spaces here'), false);
    assert.equal(validateAccountId(null), false);
    assert.equal(validateAccountId(42), false);
    // Too long (> 64 chars)
    assert.equal(validateAccountId('a'.repeat(65)), false);
});

// ─────────────────────────────────────────────────
// 2. PROVIDER_CAPABILITY_MATRIX contents
// ─────────────────────────────────────────────────

test('PROVIDER_CAPABILITY_MATRIX is frozen and contains all audited providers', () => {
    assert.ok(Object.isFrozen(PROVIDER_CAPABILITY_MATRIX), 'Matrix must be frozen');
    const ids = PROVIDER_CAPABILITY_MATRIX.map(p => p.id);
    assert.ok(ids.includes('selector-meteor'), 'Meteor Wallet (selector) must be in matrix');
    assert.ok(ids.includes('selector-mynearwallet'), 'MyNearWallet (selector) must be in matrix');
    assert.ok(ids.includes('injected-nightly-near'), 'Nightly NEAR adapter must be in matrix');
    assert.ok(ids.includes('injected-near'), 'Standard injected window.near must be in matrix');
    assert.ok(ids.includes('injected-here'), 'HERE Wallet must be in matrix (as unsupported)');
});

test('PROVIDER_CAPABILITY_MATRIX marks HERE Wallet as unsupported', () => {
    const here = PROVIDER_CAPABILITY_MATRIX.find(p => p.id === 'injected-here');
    assert.ok(here, 'HERE Wallet entry must exist');
    assert.equal(here.type, 'unsupported', 'HERE Wallet must be typed as unsupported');
    assert.equal(here.signMessageStatus, 'unsupported');
    assert.equal(here.signAndSendStatus, 'unsupported');
});

test('PROVIDER_CAPABILITY_MATRIX marks MyNearWallet as redirect wallet', () => {
    const mnw = PROVIDER_CAPABILITY_MATRIX.find(p => p.id === 'selector-mynearwallet');
    assert.ok(mnw, 'MyNearWallet entry must exist');
    assert.equal(mnw.redirectRequired, true);
    assert.equal(mnw.type, 'browser');
    // signMessage returns void on redirect — documented in types
    assert.ok(mnw.signMessageStatus.includes('redirect'), 'signMessageStatus must indicate redirect behavior');
});

test('PROVIDER_CAPABILITY_MATRIX marks MeteorWallet as non-redirect injected', () => {
    const meteor = PROVIDER_CAPABILITY_MATRIX.find(p => p.id === 'selector-meteor');
    assert.ok(meteor, 'Meteor Wallet entry must exist');
    assert.equal(meteor.redirectRequired, false);
    assert.equal(meteor.type, 'injected');
    assert.equal(meteor.signMessageStatus, 'verified');
});

test('PROVIDER_CAPABILITY_MATRIX marks Nightly as partially supported', () => {
    const nightly = PROVIDER_CAPABILITY_MATRIX.find(p => p.id === 'injected-nightly-near');
    assert.ok(nightly, 'Nightly entry must exist');
    assert.equal(nightly.signMessageStatus, 'partially-supported');
    assert.ok(nightly.warning, 'Nightly entry must carry a warning about EVM exclusion');
});

// ─────────────────────────────────────────────────
// 3. getAvailableProviders — detection and honesty
// ─────────────────────────────────────────────────

test('getAvailableProviders returns empty list when no wallet is injected', () => {
    const adapter = new NearWalletAdapter({ windowRef: {} });
    const providers = adapter.getAvailableProviders();
    assert.equal(providers.length, 0);
});

test('getAvailableProviders detects window.near injected provider', () => {
    // SYNTHETIC fixture — represents a Sender Wallet injection
    const mockWindow = {
        near: {
            networkId: 'testnet',
            signMessage: async () => {},
            signAndSendTransaction: async () => {},
        },
    };
    const adapter = new NearWalletAdapter({ windowRef: mockWindow });
    const providers = adapter.getAvailableProviders();

    const injectedNear = providers.find(p => p.id === 'injected-near');
    assert.ok(injectedNear, 'window.near provider must be detected');
    assert.equal(injectedNear.available, true);
    assert.equal(injectedNear.capabilities.signMessage, true);
    assert.equal(injectedNear.capabilities.signAndSendTransaction, true);
});

test('getAvailableProviders detects window.nightly.near NEAR-chain adapter only', () => {
    // SYNTHETIC fixture — Nightly extension injects nightly.near, NOT nightly.ethereum
    const mockWindow = {
        nightly: {
            near: {
                signMessage: async () => {},
                signAndSendTransaction: async () => {},
            },
            ethereum: {
                request: async () => {},
            },
        },
    };
    const adapter = new NearWalletAdapter({ windowRef: mockWindow });
    const providers = adapter.getAvailableProviders();

    const nightly = providers.find(p => p.id === 'injected-nightly-near');
    assert.ok(nightly, 'window.nightly.near must be detected');
    assert.equal(nightly.available, true);
    // EVM adapter must NOT affect NEAR capability report
    assert.ok(!providers.find(p => p.id === 'nightly-ethereum'), 'EVM adapter must not appear as NEAR provider');
});

test('getAvailableProviders marks HERE Wallet as unsupported even when window.hereWallet exists', () => {
    // SYNTHETIC fixture — HERE Wallet extension injects window.hereWallet
    const mockWindow = {
        hereWallet: {
            signAndSendTransaction: async () => {},
        },
    };
    const adapter = new NearWalletAdapter({ windowRef: mockWindow });
    const providers = adapter.getAvailableProviders();

    const here = providers.find(p => p.id === 'injected-here');
    assert.ok(here, 'HERE Wallet detection must report entry');
    assert.equal(here.available, false, 'HERE Wallet must report available=false (unsupported via direct injection)');
    assert.equal(here.type, 'unsupported');
    assert.equal(here.provider, null, 'HERE Wallet provider must be null — cannot be used');
});

test('getAvailableProviders does NOT create a window.near entry when window.near is absent', () => {
    // No window.near, but window.nightly.near is present
    const mockWindow = {
        nightly: { near: { signMessage: async () => {} } },
    };
    const adapter = new NearWalletAdapter({ windowRef: mockWindow });
    const providers = adapter.getAvailableProviders();
    assert.ok(!providers.find(p => p.id === 'injected-near'), 'No window.near entry without window.near');
});

test('getAvailableProviders detects injected wallet without signMessage (capability=false)', () => {
    // SYNTHETIC — a wallet that provides signAndSendTransaction but NOT signMessage
    const mockWindow = {
        near: {
            networkId: 'testnet',
            signAndSendTransaction: async () => {},
            // No signMessage
        },
    };
    const adapter = new NearWalletAdapter({ windowRef: mockWindow });
    const providers = adapter.getAvailableProviders();
    const injected = providers.find(p => p.id === 'injected-near');
    assert.ok(injected);
    assert.equal(injected.capabilities.signMessage, false, 'signMessage must be false when missing');
    assert.equal(injected.capabilities.signAndSendTransaction, true);
});

// ─────────────────────────────────────────────────
// 4. connect() — network verification, rejection, account switching
// ─────────────────────────────────────────────────

test('connect throws NO_INJECTED_WALLET when no wallet is detected', async () => {
    const adapter = new NearWalletAdapter({ windowRef: {} });
    await assert.rejects(adapter.connect(), { code: 'NO_INJECTED_WALLET' });
});

test('connect throws PROVIDER_UNAVAILABLE when specific provider ID is not installed', async () => {
    // window.near is present but we ask for 'injected-nightly-near' which is absent
    const mockWindow = { near: { networkId: 'testnet', getAccountId: async () => 'alice.testnet' } };
    const adapter = new NearWalletAdapter({ windowRef: mockWindow });
    await assert.rejects(
        adapter.connect('injected-nightly-near'),
        { code: 'PROVIDER_UNAVAILABLE' }
    );
});

test('connect rejects with PROVIDER_UNAVAILABLE when requesting HERE Wallet (unsupported)', async () => {
    // HERE Wallet is never a valid connect() target
    const mockWindow = {
        hereWallet: { signAndSendTransaction: async () => {} },
    };
    const adapter = new NearWalletAdapter({ windowRef: mockWindow });
    await assert.rejects(
        adapter.connect('injected-here'),
        { code: 'PROVIDER_UNAVAILABLE' }
    );
});

test('connect succeeds and reads accountId and publicKey from window.near', async () => {
    // SYNTHETIC fixture
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'friend.testnet',
            getPublicKey: async () => 'ed25519:9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
            signMessage: async () => {},
            signAndSendTransaction: async () => {},
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    const state = await adapter.connect('injected-near');

    assert.equal(state.connected, true);
    assert.equal(state.accountId, 'friend.testnet');
    assert.equal(state.publicKey, 'ed25519:9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu');
    assert.equal(state.isRedirectWallet, false);
    assert.equal(state.providerType, 'injected-direct');
});

test('connect rejects NETWORK_MISMATCH when wallet networkId is mainnet but app requires testnet', async () => {
    const mockWindow = {
        near: {
            networkId: 'mainnet',
            getAccountId: async () => 'alice.near',
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await assert.rejects(
        adapter.connect('injected-near'),
        { code: 'NETWORK_MISMATCH' }
    );
});

test('connect warns but does NOT throw when provider does not expose networkId', async () => {
    // Window.near without networkId — cannot verify network, but should not block
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        const mockWindow = {
            near: {
                // No networkId
                getAccountId: async () => 'unknown-network.testnet',
                signMessage: async () => {},
                signAndSendTransaction: async () => {},
            },
        };
        const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
        const state = await adapter.connect('injected-near');
        assert.equal(state.connected, true);
        assert.ok(warnings.some(w => w.includes('networkId') || w.includes('network')), 'Should warn about missing networkId');
    } finally {
        console.warn = originalWarn;
    }
});

test('connect handles user rejection during requestSignIn', async () => {
    const mockWindow = {
        near: {
            requestSignIn: async () => {
                const err = new Error('User rejected the connection request');
                err.code = 4001;
                throw err;
            },
            getAccountId: async () => null,
        },
    };
    const adapter = new NearWalletAdapter({ windowRef: mockWindow });
    await assert.rejects(
        adapter.connect('injected-near'),
        { code: 'USER_REJECTED' }
    );
});

test('connect rejects INVALID_ACCOUNT_ID when provider returns malformed account', async () => {
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'BAD ACCOUNT@',
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await assert.rejects(
        adapter.connect('injected-near'),
        { code: 'INVALID_ACCOUNT_ID' }
    );
});

test('connect reads account from getAccounts() array when getAccountId is not available', async () => {
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccounts: async () => [{ accountId: 'alice.testnet', publicKey: 'ed25519:pub123' }],
            signMessage: async () => {},
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    const state = await adapter.connect('injected-near');
    assert.equal(state.accountId, 'alice.testnet');
});

// ─────────────────────────────────────────────────
// 5. attachSelectorWallet()
// ─────────────────────────────────────────────────

test('attachSelectorWallet sets up a non-redirect wallet correctly', () => {
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: {} });
    const fakeWalletInstance = { signMessage: async () => {}, signAndSendTransaction: async () => {} };
    const state = adapter.attachSelectorWallet({
        walletInstance: fakeWalletInstance,
        accountId: 'creator.testnet',
        publicKey: 'ed25519:pub123',
        walletId: 'meteor-wallet',
        isRedirectWallet: false,
    });

    assert.equal(state.connected, true);
    assert.equal(state.accountId, 'creator.testnet');
    assert.equal(state.isRedirectWallet, false);
    assert.equal(state.providerType, 'wallet-selector');
    assert.equal(adapter.connectedProviderId, 'meteor-wallet');
    assert.equal(adapter.isRedirectWallet, false);
});

test('attachSelectorWallet marks isRedirectWallet=true for browser-type wallets', () => {
    const adapter = new NearWalletAdapter({ windowRef: {} });
    adapter.attachSelectorWallet({
        walletInstance: { signMessage: async () => {}, signAndSendTransaction: async () => {} },
        accountId: 'recipient.testnet',
        walletId: 'my-near-wallet',
        isRedirectWallet: true,
    });
    assert.equal(adapter.isRedirectWallet, true);
});

test('attachSelectorWallet rejects invalid account ID', () => {
    const adapter = new NearWalletAdapter({ windowRef: {} });
    assert.throws(() => adapter.attachSelectorWallet({
        walletInstance: {},
        accountId: 'INVALID ACCOUNT!!',
        walletId: 'meteor-wallet',
    }), { code: 'INVALID_ACCOUNT_ID' });
});

// ─────────────────────────────────────────────────
// 6. disconnect()
// ─────────────────────────────────────────────────

test('disconnect resets all connection state and calls provider signOut', async () => {
    let signedOut = false;
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'friend.testnet',
            signOut: () => { signedOut = true; },
            signMessage: async () => {},
        },
    };
    const adapter = new NearWalletAdapter({ windowRef: mockWindow });
    await adapter.connect('injected-near');
    assert.equal(adapter.connectedAccountId, 'friend.testnet');

    const result = adapter.disconnect();
    assert.equal(result.connected, false);
    assert.equal(adapter.connectedAccountId, null);
    assert.equal(adapter.activeProvider, null);
    assert.equal(adapter.isRedirectWallet, false);
    assert.equal(signedOut, true);
});

test('disconnect emits disconnected event with previous account', async () => {
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'friend.testnet',
            signMessage: async () => {},
        },
    };
    const adapter = new NearWalletAdapter({ windowRef: mockWindow });
    await adapter.connect('injected-near');

    let disconnectEvent = null;
    adapter.on('disconnected', data => { disconnectEvent = data; });
    adapter.disconnect();

    assert.ok(disconnectEvent, 'disconnected event must be emitted');
    assert.equal(disconnectEvent.previousAccount, 'friend.testnet');
});

// ─────────────────────────────────────────────────
// 7. signNep413Message() — immediate and redirect flows
// ─────────────────────────────────────────────────

test('signNep413Message throws WALLET_NOT_CONNECTED if not connected', async () => {
    const adapter = new NearWalletAdapter({ windowRef: {} });
    await assert.rejects(
        adapter.signNep413Message({
            message: 'test',
            recipient: 'relay.spellman.testnet',
            nonce: Buffer.alloc(32, 1),
        }),
        { code: 'WALLET_NOT_CONNECTED' }
    );
});

test('signNep413Message throws UNSUPPORTED_WALLET_CAPABILITY if provider lacks signMessage', async () => {
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'friend.testnet',
            // No signMessage function
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await adapter.connect('injected-near');

    await assert.rejects(
        adapter.signNep413Message({
            message: 'test',
            recipient: 'relay.spellman.testnet',
            nonce: Buffer.alloc(32, 1),
        }),
        { code: 'UNSUPPORTED_WALLET_CAPABILITY' }
    );
});

test('signNep413Message rejects nonce shorter than 32 bytes', async () => {
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'friend.testnet',
            signMessage: async () => ({ signature: 'sig', publicKey: 'ed25519:pub' }),
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await adapter.connect('injected-near');

    await assert.rejects(
        adapter.signNep413Message({
            message: 'test',
            recipient: 'relay.spellman.testnet',
            nonce: Buffer.alloc(16, 1), // 16 bytes — invalid
        }),
        { code: 'INVALID_NONCE' }
    );
});

test('signNep413Message rejects nonce longer than 32 bytes', async () => {
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'friend.testnet',
            signMessage: async () => ({ signature: 'sig', publicKey: 'ed25519:pub' }),
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await adapter.connect('injected-near');

    await assert.rejects(
        adapter.signNep413Message({
            message: 'test',
            recipient: 'relay.spellman.testnet',
            nonce: Buffer.alloc(33, 1), // 33 bytes — invalid
        }),
        { code: 'INVALID_NONCE' }
    );
});

test('signNep413Message detects user rejection during signing', async () => {
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'friend.testnet',
            signMessage: async () => { throw new Error('User cancelled the sign request'); },
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await adapter.connect('injected-near');

    await assert.rejects(
        adapter.signNep413Message({
            message: 'test',
            recipient: 'relay.spellman.testnet',
            nonce: Buffer.alloc(32, 1),
        }),
        { code: 'USER_REJECTED' }
    );
});

test('signNep413Message rejects ACCOUNT_MISMATCH when signing account differs from connected account', async () => {
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'friend.testnet',
            signMessage: async () => ({
                accountId: 'different-account.testnet',
                publicKey: 'ed25519:pub123',
                signature: 'sig123',
            }),
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await adapter.connect('injected-near');

    await assert.rejects(
        adapter.signNep413Message({
            message: 'test',
            recipient: 'relay.spellman.testnet',
            nonce: Buffer.alloc(32, 1),
        }),
        { code: 'ACCOUNT_MISMATCH' }
    );
});

test('signNep413Message rejects MISSING_SIGNATURE when wallet returns no signature field', async () => {
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'friend.testnet',
            signMessage: async () => ({
                accountId: 'friend.testnet',
                publicKey: 'ed25519:pub123',
                // No signature field
            }),
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await adapter.connect('injected-near');

    await assert.rejects(
        adapter.signNep413Message({
            message: 'test',
            recipient: 'relay.spellman.testnet',
            nonce: Buffer.alloc(32, 1),
        }),
        { code: 'MISSING_SIGNATURE' }
    );
});

test('signNep413Message succeeds with valid wallet response (immediate return)', async () => {
    // SYNTHETIC — representative of Meteor Wallet injected response shape
    let capturedParams = null;
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'friend.testnet',
            signMessage: async (params) => {
                capturedParams = params;
                // Verify nonce passed as Uint8Array
                assert.ok(params.nonce instanceof Uint8Array, 'Nonce must be Uint8Array');
                assert.equal(params.nonce.length, 32, 'Nonce must be 32 bytes');
                return {
                    accountId: 'friend.testnet',
                    publicKey: 'ed25519:9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
                    signature: '2dLPdSDdryvftuFZKhtehX7uhCZaSWB3wWZukWPQQu2RV996BnihSSK7JFmcSUmdP4z5c6cEmL2uwTSgCNixobQC',
                };
            },
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await adapter.connect('injected-near');

    const nonce = Buffer.alloc(32, 0xab);
    const res = await adapter.signNep413Message({
        message: 'RELAY_OWNERSHIP_PROOF\nDomain: http://localhost:4173',
        recipient: 'relay.spellman.testnet',
        nonce,
    });

    assert.ok(res, 'Result must not be null for immediate wallet');
    assert.equal(res.accountId, 'friend.testnet');
    assert.equal(res.publicKey, 'ed25519:9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu');
    assert.ok(capturedParams, 'signMessage must have been called');
    assert.equal(capturedParams.recipient, 'relay.spellman.testnet');
});

test('signNep413Message returns null for redirect wallets (void response signals redirect)', async () => {
    // DOCUMENTED-SHAPE: BrowserWalletBehaviour.signMessage returns Promise<SignedMessage | void>
    // void indicates the wallet has redirected the page. The adapter must return null, NOT throw.
    const mockWalletInstance = {
        signMessage: async () => undefined, // void — redirect wallet
    };
    const adapter = new NearWalletAdapter({ windowRef: {} });
    adapter.attachSelectorWallet({
        walletInstance: mockWalletInstance,
        accountId: 'friend.testnet',
        walletId: 'my-near-wallet',
        isRedirectWallet: true,
    });

    const result = await adapter.signNep413Message({
        message: 'test-challenge',
        recipient: 'relay.spellman.testnet',
        nonce: Buffer.alloc(32, 0xcc),
        callbackUrl: 'http://localhost:4173/?session=abc',
    });

    assert.equal(result, null, 'Must return null for redirect wallet (void signMessage response)');
});

test('signNep413Message throws MALFORMED_SIGNATURE_RESPONSE when non-redirect wallet returns void', async () => {
    // A non-redirect injected wallet that returns undefined is an error — it should return a SignedMessage.
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'friend.testnet',
            signMessage: async () => undefined, // unexpected void from non-redirect wallet
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await adapter.connect('injected-near');
    // isRedirectWallet is false for injected-direct connections

    await assert.rejects(
        adapter.signNep413Message({
            message: 'test',
            recipient: 'relay.spellman.testnet',
            nonce: Buffer.alloc(32, 1),
        }),
        { code: 'MALFORMED_SIGNATURE_RESPONSE' }
    );
});

// ─────────────────────────────────────────────────
// 8. signAndSendTransaction() — immediate and redirect flows
// ─────────────────────────────────────────────────

test('signAndSendTransaction throws WALLET_NOT_CONNECTED if not connected', async () => {
    const adapter = new NearWalletAdapter({ windowRef: {} });
    await assert.rejects(
        adapter.signAndSendTransaction({
            receiverId: 'relay.spellman.testnet',
            actions: [{ methodName: 'nft_transfer', args: {}, deposit: '1' }],
        }),
        { code: 'WALLET_NOT_CONNECTED' }
    );
});

test('signAndSendTransaction submits nft_transfer and extracts transaction hash', async () => {
    // DOCUMENTED-SHAPE: FinalExecutionOutcome.transaction.hash as returned by NEAR RPC
    let capturedParams = null;
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'relay-owner-b.spellman.testnet',
            signAndSendTransaction: async (params) => {
                capturedParams = params;
                // DOCUMENTED-SHAPE: NEAR RPC FinalExecutionOutcome
                return {
                    transaction: {
                        hash: '5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U',
                        signer_id: 'relay-owner-b.spellman.testnet',
                        receiver_id: 'relay.spellman.testnet',
                    },
                    transaction_outcome: {
                        id: '5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U',
                        outcome: { status: { SuccessValue: '' } },
                    },
                    receipts_outcome: [],
                    final_execution_status: 'FINAL',
                    status: { SuccessValue: '' },
                };
            },
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await adapter.connect('injected-near');

    const txRes = await adapter.signAndSendTransaction({
        receiverId: 'relay.spellman.testnet',
        actions: [{
            methodName: 'nft_transfer',
            args: { token_id: 'relay-test-1', receiver_id: 'friend.testnet' },
            deposit: '1',
            gas: '30000000000000',
        }],
    });

    assert.equal(txRes.success, true);
    assert.equal(txRes.redirected, false);
    assert.equal(txRes.transactionHash, '5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U');
    assert.equal(txRes.signerAccountId, 'relay-owner-b.spellman.testnet');

    // Verify action was normalized to FunctionCall format
    assert.ok(capturedParams, 'signAndSendTransaction must have been called');
    assert.equal(capturedParams.receiverId, 'relay.spellman.testnet');
    assert.equal(capturedParams.actions[0].type, 'FunctionCall');
    assert.equal(capturedParams.actions[0].params.methodName, 'nft_transfer');
    assert.equal(capturedParams.actions[0].params.deposit, '1');
});

test('signAndSendTransaction returns redirected=true when redirect wallet returns void', async () => {
    // DOCUMENTED-SHAPE: BrowserWalletBehaviour.signAndSendTransaction returns
    // Promise<FinalExecutionOutcome | void> — void signals redirect
    const mockWalletInstance = {
        signAndSendTransaction: async () => undefined, // void — redirect
    };
    const adapter = new NearWalletAdapter({ windowRef: {} });
    adapter.attachSelectorWallet({
        walletInstance: mockWalletInstance,
        accountId: 'creator.testnet',
        walletId: 'my-near-wallet',
        isRedirectWallet: true,
    });

    const txRes = await adapter.signAndSendTransaction({
        receiverId: 'relay.spellman.testnet',
        actions: [{ type: 'FunctionCall', params: { methodName: 'nft_transfer', args: {}, gas: '30000000000000', deposit: '1' } }],
        callbackUrl: 'http://localhost:4173/?session=abc',
    });

    assert.equal(txRes.redirected, true, 'Must signal redirect, not success');
    assert.equal(txRes.success, false);
    assert.equal(txRes.transactionHash, null, 'Hash is not available until callback');
    assert.ok(txRes.message, 'Must include descriptive message about callback');
});

test('signAndSendTransaction detects user rejection', async () => {
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'creator.testnet',
            signAndSendTransaction: async () => {
                throw new Error('User rejected the transaction in the wallet extension');
            },
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await adapter.connect('injected-near');

    await assert.rejects(
        adapter.signAndSendTransaction({
            receiverId: 'relay.spellman.testnet',
            actions: [{ methodName: 'nft_transfer', args: {} }],
        }),
        { code: 'USER_REJECTED' }
    );
});

test('signAndSendTransaction warns when hash cannot be parsed from wallet response', async () => {
    // SYNTHETIC — wallet returns a non-standard object with no parseable hash
    const mockWindow = {
        near: {
            networkId: 'testnet',
            getAccountId: async () => 'creator.testnet',
            signAndSendTransaction: async () => ({ status: 'submitted', unknownField: true }),
        },
    };
    const adapter = new NearWalletAdapter({ networkId: 'testnet', windowRef: mockWindow });
    await adapter.connect('injected-near');

    const txRes = await adapter.signAndSendTransaction({
        receiverId: 'relay.spellman.testnet',
        actions: [{ methodName: 'nft_transfer', args: {} }],
    });

    // success=true because wallet did not throw, but transactionHash is null
    assert.equal(txRes.success, true);
    assert.equal(txRes.transactionHash, null);
    assert.ok(txRes.warning, 'Must include warning about unparseable hash');
});

// ─────────────────────────────────────────────────
// 9. parseWalletCallbackParams() — URL callback parsing
// ─────────────────────────────────────────────────

test('parseWalletCallbackParams extracts single transaction hash from MyNearWallet callback', () => {
    // DOCUMENTED-SHAPE: MyNearWallet returns ?transactionHashes=<hash> on success
    const result = parseWalletCallbackParams('?transactionHashes=5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U');
    assert.deepEqual(result.transactionHashes, ['5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U']);
    assert.equal(result.errorCode, null);
});

test('parseWalletCallbackParams extracts multiple valid transaction hashes', () => {
    // DOCUMENTED-SHAPE: comma-separated transactionHashes from MyNearWallet batch tx callback
    const hash1 = '5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U';
    const hash2 = 'BmefhGFe4bNhsHe4mBjzPLRNNR6N5HqicRzXRCEscmpa';
    const result = parseWalletCallbackParams(`?transactionHashes=${hash1},${hash2}`);
    assert.ok(Array.isArray(result.transactionHashes), 'Must return array');
    assert.equal(result.transactionHashes.length, 2, 'Both valid hashes must be returned');
    assert.ok(result.transactionHashes.includes(hash1));
    assert.ok(result.transactionHashes.includes(hash2));
});

test('parseWalletCallbackParams filters out malformed hashes in a comma-separated list', () => {
    // One valid hash, one malformed — only the valid one should pass
    const validHash = '5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U';
    const result = parseWalletCallbackParams(`?transactionHashes=${validHash},INVALID!@#HASH`);
    assert.ok(Array.isArray(result.transactionHashes));
    assert.equal(result.transactionHashes.length, 1, 'Only valid base58 hash should pass');
    assert.equal(result.transactionHashes[0], validHash);
});

test('parseWalletCallbackParams detects error code from MyNearWallet failure callback', () => {
    // DOCUMENTED-SHAPE: MyNearWallet returns ?errorCode=userRejected on cancellation
    const result = parseWalletCallbackParams('?errorCode=userRejected&errorMessage=User+cancelled');
    assert.equal(result.errorCode, 'userRejected');
    assert.equal(result.transactionHashes, null);
});

test('parseWalletCallbackParams returns all null when URL has no wallet params', () => {
    const result = parseWalletCallbackParams('?session=abc123');
    assert.equal(result.transactionHashes, null);
    assert.equal(result.errorCode, null);
    assert.equal(result.accountId, null);
    assert.equal(result.signature, null);
});

test('parseWalletCallbackParams rejects transaction hashes that do not match base58 pattern', () => {
    // Tampered or malformed hash
    const result = parseWalletCallbackParams('?transactionHashes=INVALID!@#HASH');
    assert.equal(result.transactionHashes, null, 'Malformed hash must be rejected');
});

test('parseWalletCallbackParams handles empty search string', () => {
    const result = parseWalletCallbackParams('');
    assert.equal(result.transactionHashes, null);
    assert.equal(result.errorCode, null);
});

// ─────────────────────────────────────────────────
// 10. Redirect state helpers
// ─────────────────────────────────────────────────

test('saveRedirectState persists opaque state; loadRedirectState retrieves it', () => {
    // SYNTHETIC — in-memory storage mock
    const store = new Map();
    const mockStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
    };

    saveRedirectState(
        { flowType: 'nep413-sign', sessionId: 'sess-abc', challengeId: 'chal-123' },
        mockStorage
    );

    const loaded = loadRedirectState(mockStorage);
    assert.ok(loaded, 'State must be loadable after save');
    assert.equal(loaded.flowType, 'nep413-sign');
    assert.equal(loaded.sessionId, 'sess-abc');
    assert.equal(loaded.challengeId, 'chal-123');
    assert.ok(loaded.savedAt, 'savedAt timestamp must be present');
    assert.ok(loaded.expiresAt, 'expiresAt must be set');
    // Verify no private key material or PKCE verifier fields are present
    assert.ok(!('privateKey' in loaded), 'Private key must not be stored');
    assert.ok(!('codeVerifier' in loaded), 'PKCE verifier must not be stored in redirect state');
});

test('clearRedirectState removes state from storage', () => {
    const store = new Map();
    const mockStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
    };

    saveRedirectState({ flowType: 'nft-transfer', sessionId: 'sess-xyz' }, mockStorage);
    clearRedirectState(mockStorage);
    const loaded = loadRedirectState(mockStorage);
    assert.equal(loaded, null, 'State must be null after clear');
});

test('loadRedirectState returns null for expired state', () => {
    const store = new Map();
    const mockStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
    };

    // Inject an already-expired state
    store.set('relay_wallet_redirect_state', JSON.stringify({
        flowType: 'nep413-sign',
        sessionId: 'old-session',
        savedAt: Date.now() - 20 * 60 * 1000,
        expiresAt: Date.now() - 5 * 60 * 1000, // expired 5 minutes ago
    }));

    const loaded = loadRedirectState(mockStorage);
    assert.equal(loaded, null, 'Expired redirect state must return null');
    // Also verify it was cleaned up
    assert.ok(!store.has('relay_wallet_redirect_state'), 'Expired state must be removed from storage');
});

test('loadRedirectState returns null when storage is empty', () => {
    const store = new Map();
    const mockStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
    };
    const loaded = loadRedirectState(mockStorage);
    assert.equal(loaded, null);
});
