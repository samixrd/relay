'use strict';

/**
 * RELAY NEAR Auth browser bridge.
 *
 * Bundled into `near-auth.bundle.js` and exposed as `window.RelayNearAuth`.
 * The bundle only does three things:
 *   - run the official FastAuth Auth0 popup login,
 *   - expose the verified identity (ID token + MPC public key), and
 *   - ask Auth0 to sign the exact transaction bytes RELAY prepared.
 *
 * It never signs anything locally and never has a private key. The MPC contract
 * produces the ed25519 signature after Auth0 authorizes the exact payload.
 */

import './buffer-shim.js';
import { JavascriptProvider } from '@fast-auth-near/javascript-provider';
import { Buffer } from 'buffer';
import { FailoverRpcProvider, JsonRpcProvider, decodeTransaction } from 'near-api-js';

let provider = null;
let rpc = null;
let options = null;

function decodeBase64(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('RELAY did not provide transaction bytes.');
    }
    return Buffer.from(value, 'base64');
}

async function initialize(config) {
    if (!config || config.network !== 'testnet') {
        throw new Error('RELAY NEAR Auth only supports NEAR Testnet.');
    }
    if (!config.clientId || !config.domain) {
        throw new Error('NEAR Auth client configuration is missing.');
    }
    options = {
        clientId: config.clientId,
        domain: config.domain,
        signingAudience: config.signingAudience,
        rpcUrl: config.rpcUrl || 'https://rpc.testnet.near.org',
        mpcContractId: config.mpcContractId || 'v1.signer-prod.testnet',
        fastAuthContractId: config.fastAuthContractId || 'fast-auth.testnet',
    };
    provider = new JavascriptProvider({
        network: 'testnet',
        clientId: options.clientId,
        domain: options.domain,
        signingAudience: options.signingAudience,
    });

    const candidates = [
        options.rpcUrl,
        'https://rpc.testnet.near.org',
        'https://archival-rpc.testnet.near.org',
        'https://test.rpc.fastnear.com',
    ].filter((u, i, arr) => u && arr.indexOf(u) === i);

    rpc = new FailoverRpcProvider(candidates.map((url) => new JsonRpcProvider({ url })));
    return isLoggedIn();
}

function requireProvider() {
    if (!provider) throw new Error('NEAR Auth is not initialized yet.');
    return provider;
}

async function isLoggedIn() {
    if (!provider) return false;
    try {
        return await provider.isLoggedIn();
    } catch {
        return false;
    }
}

async function getIdentity() {
    const active = requireProvider();
    const claims = await active.client.getIdTokenClaims();
    if (!claims || typeof claims.__raw !== 'string') {
        throw new Error('Reconnect with Google to continue.');
    }
    const path = await active.getPath();
    const callArgs = {
        contractId: options.mpcContractId,
        method: 'derived_public_key',
        args: {
            path,
            predecessor: options.fastAuthContractId,
            domain_id: 1,
        },
        blockQuery: { finality: 'final' },
    };
    const derived = await rpc.callFunction(callArgs);
    const publicKey = typeof derived === 'string' ? derived : derived?.public_key;
    if (typeof publicKey !== 'string') {
        throw new Error('The MPC contract did not return a signing key.');
    }
    return {
        idToken: claims.__raw,
        publicKey,
        path,
        sub: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : null,
        emailVerified: claims.email_verified === true || claims.email_verified === 'true',
        name: typeof claims.name === 'string' ? claims.name : null,
        picture: typeof claims.picture === 'string' ? claims.picture : null,
    };
}

async function login() {
    const active = requireProvider();
    await active.login();
    return getIdentity();
}

async function ensureSession() {
    if (await isLoggedIn()) {
        return getIdentity();
    }
    return login();
}

/**
 * Requests an Auth0 signature over the server-prepared transaction. Returns the
 * signing request that the server submits to fast-auth.testnet.sign.
 */
async function requestSignature(transactionBase64) {
    const active = requireProvider();
    const bytes = decodeBase64(transactionBase64);
    let transaction;
    try {
        transaction = decodeTransaction(bytes);
    } catch {
        throw new Error('RELAY prepared an unreadable NEAR transaction.');
    }
    await active.requestTransactionSignature({ transaction });
    const response = await active.getSignatureRequest();
    const request = response?.signatureRequest;
    if (!request || typeof request.guardId !== 'string' || typeof request.verifyPayload !== 'string') {
        throw new Error('Auth0 did not return a transaction signature request.');
    }
    const signPayload = Array.from(request.signPayload || []);
    if (signPayload.length !== bytes.length) {
        throw new Error('Auth0 signed a different transaction length than RELAY prepared.');
    }
    return {
        guardId: request.guardId,
        verifyPayload: request.verifyPayload,
        signPayload,
    };
}

async function logout() {
    if (!provider) return;
    try {
        await provider.logout({
            logoutParams: { returnTo: `${window.location.origin}${window.location.pathname}` },
        });
    } catch {
        // The server session is cleared by /api/auth/near/logout regardless.
    }
}

window.RelayNearAuth = {
    initialize,
    isLoggedIn,
    login,
    logout,
    getIdentity,
    ensureSession,
    requestSignature,
};
