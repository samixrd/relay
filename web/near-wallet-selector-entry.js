import './buffer-shim.js';
import { setupWalletSelector, internalActionToNaj } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui-js';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import { Buffer } from 'buffer';
import '@near-wallet-selector/modal-ui-js/styles.css';

/**
 * RELAY Wallet Selector bridge.
 *
 * IMPORTANT: a modal opening is not a connection. `connect()` only resolves
 * after the selector reports a signed-in account, or reports `redirected: true`
 * when a browser wallet is navigating away. `restore()` reads the selector's
 * persisted account state and is used after a redirect or page reload.
 */

let selectorPromise = null;
let selectorOptions = null;
let modalInstance = null;

async function initialize({ networkId, contractId }) {
    if (networkId !== 'testnet') {
        throw new Error(`RELAY wallet integration only supports NEAR Testnet (requested ${networkId}).`);
    }
    if (!contractId || typeof contractId !== 'string') {
        throw new Error('RELAY contract ID is required to initialize the wallet selector.');
    }

    if (selectorPromise) {
        if (selectorOptions.networkId !== networkId || selectorOptions.contractId !== contractId) {
            throw new Error('Wallet Selector is already initialized for a different network or contract.');
        }
        return selectorPromise;
    }

    selectorOptions = { networkId, contractId };
    selectorPromise = setupWalletSelector({
        network: 'testnet',
        modules: [
            setupMeteorWallet(),
            setupMyNearWallet({ walletUrl: 'https://testnet.mynearwallet.com' }),
        ],
    }).then((selector) => {
        modalInstance = setupModal(selector, {
            contractId,
            description: 'Connect a NEAR Testnet account to RELAY.',
        });
        return { selector, modal: modalInstance };
    }).catch((error) => {
        selectorPromise = null;
        modalInstance = null;
        selectorOptions = null;
        throw error;
    });

    return selectorPromise;
}

function stateOf(selector) {
    return selector?.store?.getState?.() || { accounts: [], selectedWalletId: null };
}

function accountPayload(selector, walletId = null) {
    const state = stateOf(selector);
    const accounts = Array.isArray(state.accounts) ? state.accounts : [];
    const active = accounts.find((account) => account.active) || accounts[0] || null;
    if (!active) return { connected: false, accounts: [] };
    return {
        connected: true,
        walletId: walletId || state.selectedWalletId || null,
        accountId: active.accountId,
        publicKey: active.publicKey || null,
        accounts: accounts.map((account) => ({
            accountId: account.accountId,
            publicKey: account.publicKey || null,
            active: Boolean(account.active),
        })),
    };
}

async function restore(config) {
    const { selector } = await initialize(config);
    if (!selector.isSignedIn()) return { connected: false, accounts: [] };
    return accountPayload(selector);
}

async function connect(config) {
    const { selector, modal } = await initialize(config);
    const existing = accountPayload(selector);
    if (existing.connected) return existing;

    return new Promise((resolve, reject) => {
        let settled = false;
        const subscriptions = [];
        const cleanup = () => {
            settled = true;
            for (const subscription of subscriptions) {
                try { subscription.unsubscribe(); } catch { /* already removed */ }
            }
        };
        subscriptions.push(selector.on('signedIn', ({ walletId, accounts }) => {
            if (settled) return;
            cleanup();
            const state = stateOf(selector);
            const active = accounts.find((account) => account.active) || accounts[0];
            resolve({
                connected: Boolean(active?.accountId),
                walletId: walletId || state.selectedWalletId || null,
                accountId: active?.accountId || null,
                publicKey: active?.publicKey || null,
            });
        }));
        subscriptions.push(modal.on('onHide', ({ hideReason }) => {
            if (settled) return;
            if (hideReason === 'wallet-navigation') {
                cleanup();
                resolve({ connected: false, redirected: true });
                return;
            }
            cleanup();
            reject(new Error('The wallet window was closed before an account was connected.'));
        }));
        try {
            modal.show();
        } catch (error) {
            cleanup();
            reject(new Error(`Could not open the wallet selector: ${error.message}`));
        }
    });
}

async function activeWallet(config) {
    const { selector } = await initialize(config);
    const state = stateOf(selector);
    if (!state.selectedWalletId) return null;
    return selector.wallet(state.selectedWalletId);
}

async function signMessage(config, { message, recipient, nonce, callbackUrl = null }) {
    const wallet = await activeWallet(config);
    if (!wallet) throw new Error('No NEAR wallet is connected.');
    if (typeof wallet.signMessage !== 'function') {
        throw new Error('This wallet does not support NEP-413 message signing. Try Meteor Wallet or MyNearWallet.');
    }
    const result = await wallet.signMessage({
        message,
        recipient,
        // The selector validates `Buffer.isBuffer(nonce)` and requires exactly
        // 32 bytes; a plain Uint8Array is rejected.
        nonce: Buffer.from(Uint8Array.from(nonce || [])),
        ...(callbackUrl ? { callbackUrl } : {}),
    });
    if (!result) {
        return { redirected: true };
    }
    return {
        accountId: result.accountId,
        publicKey: result.publicKey,
        signature: result.signature,
    };
}

function toInternalAction(action) {
    if (!action || typeof action !== 'object') {
        throw new Error('RELAY prepared an unreadable wallet action.');
    }
    // The server sends flat actions; older paths send the nested `params` form.
    if (action.type === 'FunctionCall') {
        const source = action.params || action;
        return {
            type: 'FunctionCall',
            params: {
                methodName: source.methodName,
                args: source.args || {},
                gas: String(source.gas),
                deposit: String(source.deposit),
            },
        };
    }
    if (action.type === 'Transfer') {
        const source = action.params || action;
        return { type: 'Transfer', params: { deposit: String(source.deposit) } };
    }
    return action;
}

async function signAndSendTransaction(config, { receiverId, actions, callbackUrl = null }) {
    const { selector } = await initialize(config);
    const state = stateOf(selector);
    if (!state.selectedWalletId) throw new Error('No NEAR wallet is connected.');
    const wallet = await selector.wallet(state.selectedWalletId);
    const internalActions = actions.map(toInternalAction);
    // Meteor Wallet 10.1.4 runs every action through `najActionToInternal`,
    // so it needs NAJ-shaped actions; the other modules expect the internal
    // shape. Passing the wrong one throws "Unsupported NAJ action".
    const preparedActions = state.selectedWalletId === 'meteor-wallet'
        ? internalActions.map(internalActionToNaj)
        : internalActions;
    const result = await wallet.signAndSendTransaction({
        receiverId,
        actions: preparedActions,
        ...(callbackUrl ? { callbackUrl } : {}),
    });
    if (!result) return { redirected: true, transactionHash: null };
    const hash = result?.transaction?.hash
        || result?.transaction_outcome?.id
        || (typeof result === 'string' ? result : null);
    return {
        redirected: false,
        transactionHash: hash || null,
        raw: result,
    };
}

async function disconnect(config) {
    const { selector } = await initialize(config);
    const state = stateOf(selector);
    if (state.selectedWalletId) {
        try {
            const wallet = await selector.wallet(state.selectedWalletId);
            if (typeof wallet.signOut === 'function') await wallet.signOut();
        } catch {
            // The server-side wallet session is revoked regardless.
        }
    }
    return { connected: false };
}

function accounts(config) {
    if (!selectorPromise) return { connected: false, accounts: [] };
    return selectorPromise.then(({ selector }) => accountPayload(selector));
}

window.RelayWalletSelectorBridge = Object.freeze({
    initialize,
    connect,
    restore,
    disconnect,
    accounts,
    signMessage,
    signAndSendTransaction,
});
