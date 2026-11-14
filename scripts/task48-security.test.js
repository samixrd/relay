'use strict';

/**
 * Task 48 adversarial security tests.
 *
 * These tests exercise the real HTTP surface with two injected principals and
 * a mocked Testnet RPC read layer. They are not unit tests of helpers: every
 * assertion below is a cross-user attempt against the actual app server.
 *
 * Covered:
 *   - Google principal B cannot prepare an action on A's NFT.
 *   - Wallet principal B cannot prepare an action on A's NFT.
 *   - Wallet principal B cannot confirm A's prepared wallet action.
 *   - A consumed/unknown wallet action cannot be replayed.
 *   - Artwork upload requires an authenticated principal.
 *   - Uploaded bytes are validated server-side (disguised HTML/SVG rejected).
 *   - Upload object names cannot traverse outside the storage directory.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createConfig } = require('./app-config');
const { createAppServer } = require('./app-server');
const { ServerSessionStore } = require('./auth-provider-adapter');
const {
    MAX_IMAGE_BYTES,
    createUploadStore,
    resolveUploadFile,
    validateImageBuffer,
} = require('./upload-store');

const OWNER_A = 'u-aaaaaaaaaaaaaaaa.relay.testnet';
const OWNER_B = 'u-bbbbbbbbbbbbbbbb.relay.testnet';
const CONTRACT = 'relay.testnet';
const TOKEN_ID = 'shared-card';
const CARD_ACCOUNT = `${TOKEN_ID}.${CONTRACT}`;
const PUBLIC_KEY = 'ed25519:11111111111111111111111111111111';
const FAKE_TX_HASH = '1'.repeat(44);

function jsonRpc(result) {
    return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 'relay-test', result }),
    };
}

function queryResult(value) {
    return jsonRpc({ result: Array.from(Buffer.from(JSON.stringify(value), 'utf8')), logs: [], block_height: 1, block_hash: 'final' });
}

function installRpcMock() {
    const realFetch = globalThis.fetch;
    const calls = [];
    let ownerId = OWNER_A;
    let txFixture = null;
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        const isNearRpc = /rpc\.testnet\.near\.org|fastnear\.com/.test(target);
        if (!isNearRpc) return realFetch(url, options);
        const body = JSON.parse(options.body || '{}');
        calls.push(body);
        if (body.method === 'tx') {
            if (!txFixture) return { ok: false, status: 404, text: async () => 'tx not found' };
            return jsonRpc(txFixture);
        }
        if (body.method !== 'query') {
            return { ok: false, status: 400, text: async () => `unexpected RPC method ${body.method}` };
        }
        const method = body.params?.method_name;
        if (method === 'nft_token') {
            return queryResult({
                token_id: TOKEN_ID,
                owner_id: ownerId,
                metadata: { title: 'Shared card', description: 'Owned by A' },
            });
        }
        if (method === 'relay_account_binding') {
            return queryResult({ account_id: CARD_ACCOUNT, is_verified: true });
        }
        if (method === 'relay_provisioning_state') {
            return queryResult({ status: 'Completed' });
        }
        return queryResult(null);
    };
    return {
        calls,
        setOwner(next) { ownerId = next; },
        setTx(next) { txFixture = next; },
        restore() { globalThis.fetch = realFetch; },
    };
}

function googleSession(store, accountId) {
    const session = store.createSession({
        sub: `google-oauth2|${accountId}`,
        email: `${accountId.replace(/[^a-z0-9]/g, '')}@example.test`,
        emailVerified: true,
        name: accountId,
    });
    session.nearAuth = {
        sub: session.sub,
        email: session.email,
        emailVerified: true,
        name: session.name,
        accountId,
        publicKey: PUBLIC_KEY,
        path: `jwt#https://login.testnet.fast-auth.com/#${session.sub}`,
        authDomain: 'login.testnet.fast-auth.com',
        verifiedAt: Date.now(),
        idTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    };
    return session;
}

function walletSession(store, accountId) {
    const session = store.createSession({
        sub: `wallet:${accountId}`,
        email: null,
        emailVerified: false,
        name: accountId,
    });
    session.walletAuth = {
        mode: 'wallet',
        accountId,
        publicKey: PUBLIC_KEY,
        providerId: 'meteor-wallet',
        verifiedAt: Date.now(),
        origin: 'http://localhost:4173',
    };
    return session;
}

async function withServer(server, run) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        await run(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
}

function postJson(base, pathname, body, cookie) {
    return fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
    });
}

function tinyPng() {
    // Signature + minimal IHDR + IEND is enough for the structural validator.
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    return Buffer.concat([signature, ihdr, Buffer.from('IEND', 'ascii')]);
}

test('Task 48: cross-user action isolation on the real HTTP surface', async (t) => {
    const store = new ServerSessionStore();
    const sessionA = googleSession(store, OWNER_A);
    const sessionB = googleSession(store, OWNER_B);
    const walletA = walletSession(store, OWNER_A);
    const walletB = walletSession(store, OWNER_B);
    const config = createConfig({ RELAY_CONTRACT_ID: CONTRACT });
    const fakeRelayer = {
        ensureUserAccount: async () => ({ ensured: true }),
        ensureGas: async () => ({ toppedUp: false }),
        prepareTransaction: async () => {
            const bytes = Buffer.from('task48-prepared-bytes', 'utf8');
            return { bytes, base64: bytes.toString('base64'), transactionHash: FAKE_TX_HASH };
        },
        submitPreparedAction: async () => {
            throw new Error('submitPreparedAction must not be reached for a rejected intent');
        },
    };
    const server = createAppServer({ config, sessionStore: store, nearAuthRelayer: fakeRelayer });
    const rpc = installRpcMock();
    t.after(() => rpc.restore());

    await withServer(server, async (base) => {
        await t.test('Google B cannot prepare a spend from A’s card account', async () => {
            const response = await postJson(base, '/api/near/prepare-action', {
                kind: 'spend',
                tokenId: TOKEN_ID,
                receiverId: 'attacker.testnet',
                amountNear: '0.1',
            }, `relay_auth_session=${sessionB.sessionId}`);
            assert.equal(response.status, 403);
            const body = await response.json();
            assert.equal(body.code, 'TOKEN_OWNER');
            assert.match(body.error, /current NFT owner/i);
        });

        await t.test('Google B cannot prepare a transfer of A’s NFT', async () => {
            const response = await postJson(base, '/api/near/prepare-action', {
                kind: 'transfer',
                tokenId: TOKEN_ID,
                receiverId: OWNER_B,
            }, `relay_auth_session=${sessionB.sessionId}`);
            assert.equal(response.status, 403);
            assert.equal((await response.json()).code, 'TOKEN_OWNER');
        });

        await t.test('Wallet B cannot prepare a spend from A’s card account', async () => {
            const response = await postJson(base, '/api/near/wallet/prepare-action', {
                kind: 'spend',
                tokenId: TOKEN_ID,
                receiverId: 'attacker.testnet',
                amountNear: '0.1',
            }, `relay_wallet_session=${walletB.sessionId}`);
            assert.equal(response.status, 403);
            assert.equal((await response.json()).code, 'TOKEN_OWNER');
        });

        await t.test('Wallet B cannot prepare a transfer of A’s NFT', async () => {
            const response = await postJson(base, '/api/near/wallet/prepare-action', {
                kind: 'transfer',
                tokenId: TOKEN_ID,
                receiverId: OWNER_B,
            }, `relay_wallet_session=${walletB.sessionId}`);
            assert.equal(response.status, 403);
            assert.equal((await response.json()).code, 'TOKEN_OWNER');
        });

        await t.test('Wallet B cannot confirm A’s prepared wallet action', async () => {
            const preparedResponse = await postJson(base, '/api/near/wallet/prepare-action', {
                kind: 'transfer',
                tokenId: TOKEN_ID,
                receiverId: OWNER_B,
            }, `relay_wallet_session=${walletA.sessionId}`);
            assert.equal(preparedResponse.status, 200);
            const prepared = await preparedResponse.json();
            assert.ok(prepared.actionId);
            assert.equal(prepared.summary.signer, OWNER_A);

            const stolen = await postJson(base, '/api/near/wallet/confirm-action', {
                actionId: prepared.actionId,
                transactionHash: FAKE_TX_HASH,
            }, `relay_wallet_session=${walletB.sessionId}`);
            assert.equal(stolen.status, 403);
            assert.equal((await stolen.json()).code, 'ACTION_OWNER');
        });

        await t.test('an unknown or already-consumed wallet action cannot be replayed', async () => {
            const response = await postJson(base, '/api/near/wallet/confirm-action', {
                actionId: 'f'.repeat(36),
                transactionHash: FAKE_TX_HASH,
            }, `relay_wallet_session=${walletA.sessionId}`);
            assert.equal(response.status, 410);
            assert.equal((await response.json()).code, 'ACTION_EXPIRED');
        });

        await t.test('wallet confirm rejects an action bound to another account even with a valid hash shape', async () => {
            const preparedResponse = await postJson(base, '/api/near/wallet/prepare-action', {
                kind: 'transfer',
                tokenId: TOKEN_ID,
                receiverId: OWNER_B,
            }, `relay_wallet_session=${walletA.sessionId}`);
            const prepared = await preparedResponse.json();
            const response = await postJson(base, '/api/near/wallet/confirm-action', {
                actionId: prepared.actionId,
                transactionHash: 'not-a-valid-hash',
            }, `relay_wallet_session=${walletA.sessionId}`);
            assert.equal(response.status, 400);
            assert.equal((await response.json()).code, 'TRANSACTION_HASH');
        });

        await t.test('wallet confirm rejects a transaction whose receiver differs from the intent', async () => {
            const preparedResponse = await postJson(base, '/api/near/wallet/prepare-action', {
                kind: 'spend',
                tokenId: TOKEN_ID,
                receiverId: 'attacker.testnet',
                amountNear: '0.1',
            }, `relay_wallet_session=${walletA.sessionId}`);
            const prepared = await preparedResponse.json();
            rpc.setTx({
                transaction: { signer_id: OWNER_A, receiver_id: 'different.testnet', actions: [] },
                final_execution_status: 'FINAL',
                receipts_outcome: [],
                status: { SuccessValue: '' },
            });
            const response = await postJson(base, '/api/near/wallet/confirm-action', {
                actionId: prepared.actionId,
                transactionHash: FAKE_TX_HASH,
            }, `relay_wallet_session=${walletA.sessionId}`);
            assert.equal(response.status, 403);
            assert.equal((await response.json()).code, 'RECEIVER_MISMATCH');
            rpc.setTx(null);
        });

        await t.test('wallet confirm rejects a transaction whose actions differ from the intent', async () => {
            const preparedResponse = await postJson(base, '/api/near/wallet/prepare-action', {
                kind: 'spend',
                tokenId: TOKEN_ID,
                receiverId: 'attacker.testnet',
                amountNear: '0.1',
            }, `relay_wallet_session=${walletA.sessionId}`);
            const prepared = await preparedResponse.json();
            rpc.setTx({
                transaction: { signer_id: OWNER_A, receiver_id: CONTRACT, actions: [] },
                final_execution_status: 'FINAL',
                receipts_outcome: [],
                status: { SuccessValue: '' },
            });
            const response = await postJson(base, '/api/near/wallet/confirm-action', {
                actionId: prepared.actionId,
                transactionHash: FAKE_TX_HASH,
            }, `relay_wallet_session=${walletA.sessionId}`);
            assert.equal(response.status, 403);
            assert.equal((await response.json()).code, 'ACTIONS_MISMATCH');
            rpc.setTx(null);
        });

        await t.test('Google submit rejects an intent whose NFT moved after preparation', async () => {
            const preparedResponse = await postJson(base, '/api/near/prepare-action', {
                kind: 'spend',
                tokenId: TOKEN_ID,
                receiverId: 'attacker.testnet',
                amountNear: '0.1',
            }, `relay_auth_session=${sessionA.sessionId}`);
            assert.equal(preparedResponse.status, 200);
            const prepared = await preparedResponse.json();
            const signPayload = Array.from(Buffer.from(prepared.transactionBase64, 'base64'));
            const verifyPayload = `x.${Buffer.from(JSON.stringify({ sub: sessionA.sub })).toString('base64url')}.y`;

            rpc.setOwner(OWNER_B);
            try {
                const response = await postJson(base, '/api/near/submit-action', {
                    actionId: prepared.actionId,
                    signPayload,
                    verifyPayload,
                    guardId: 'jwt#https://login.testnet.fast-auth.com/',
                }, `relay_auth_session=${sessionA.sessionId}`);
                assert.equal(response.status, 409);
                assert.equal((await response.json()).code, 'OWNERSHIP_CHANGED');
            } finally {
                rpc.setOwner(OWNER_A);
            }
        });

        await t.test('Google session A still sees its own identity while B is rejected', async () => {
            const response = await fetch(`${base}/api/auth/near/session`, {
                headers: { cookie: `relay_auth_session=${sessionA.sessionId}` },
            });
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.authenticated, true);
            assert.equal(body.near.accountId, OWNER_A);
            assert.notEqual(body.near.accountId, OWNER_B);
        });
    });
});

test('Task 48: artwork upload authentication and content validation', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-upload-'));
    t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });

    const store = new ServerSessionStore();
    const ownerSession = googleSession(store, OWNER_A);
    const wallet = walletSession(store, OWNER_B);
    const uploadStore = createUploadStore({ directory, publicAppUrl: null, provider: 'local' });
    const config = createConfig({ RELAY_CONTRACT_ID: CONTRACT });
    const server = createAppServer({ config, sessionStore: store, uploadStore });

    await withServer(server, async (base) => {
        await t.test('anonymous upload is rejected', async () => {
            const response = await fetch(`${base}/api/uploads`, {
                method: 'POST',
                headers: { 'content-type': 'image/png' },
                body: tinyPng(),
            });
            assert.equal(response.status, 401);
            assert.equal((await response.json()).code, 'AUTH_REQUIRED');
        });

        await t.test('authenticated Google principal can upload a real PNG', async () => {
            const response = await fetch(`${base}/api/uploads`, {
                method: 'POST',
                headers: {
                    'content-type': 'image/png',
                    cookie: `relay_auth_session=${ownerSession.sessionId}`,
                },
                body: tinyPng(),
            });
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.uploaded, true);
            assert.equal(body.ownerId, OWNER_A);
            assert.equal(body.storageProvider, 'local');
            assert.equal(body.permanent, false);
            assert.match(body.url, /^\/uploads\/[a-z0-9-]+\.png$/);
            const stored = await fs.readFile(path.join(directory, path.basename(body.url)));
            assert.deepEqual(stored, tinyPng());
        });

        await t.test('authenticated wallet principal can upload a real PNG', async () => {
            const response = await fetch(`${base}/api/uploads`, {
                method: 'POST',
                headers: {
                    'content-type': 'image/png',
                    cookie: `relay_wallet_session=${wallet.sessionId}`,
                },
                body: tinyPng(),
            });
            assert.equal(response.status, 200);
            assert.equal((await response.json()).ownerId, OWNER_B);
        });

        await t.test('disguised HTML labelled image/png is rejected by the server', async () => {
            const response = await fetch(`${base}/api/uploads`, {
                method: 'POST',
                headers: {
                    'content-type': 'image/png',
                    cookie: `relay_auth_session=${ownerSession.sessionId}`,
                },
                body: Buffer.from('<html><script>alert(1)</script></html>'),
            });
            assert.equal(response.status, 400);
            const body = await response.json();
            assert.ok(['UNSUPPORTED_IMAGE_TYPE', 'INVALID_IMAGE_BYTES'].includes(body.code));
        });

        await t.test('SVG data URL is rejected', async () => {
            const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
            const response = await postJson(base, '/api/uploads', { dataUrl: svg }, `relay_auth_session=${ownerSession.sessionId}`);
            assert.equal(response.status, 400);
            assert.equal((await response.json()).code, 'UNSUPPORTED_IMAGE_TYPE');
        });

        await t.test('a valid-looking SVG byte stream labelled image/png is rejected', () => {
            assert.throws(
                () => validateImageBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
                /not accepted as artwork|not a valid JPEG/i,
            );
        });

        await t.test('oversized buffers are rejected before storage', () => {
            assert.throws(
                () => validateImageBuffer(Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x89)),
                /10 MB upload limit/,
            );
        });

        await t.test('upload object names cannot traverse outside the directory', () => {
            assert.equal(resolveUploadFile(directory, '/uploads/../secret.png'), null);
            assert.equal(resolveUploadFile(directory, '/uploads/%2e%2e%2fsecret.png'), null);
            assert.equal(resolveUploadFile(directory, '/uploads/not-an-image.svg'), null);
        });
    });
});
