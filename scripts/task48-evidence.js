#!/usr/bin/env node
'use strict';

/**
 * Task 48 real NEAR Testnet evidence.
 *
 * Read-only unless `--execute` is passed. With `--execute` this script:
 *
 *   1. Uploads a real generated PNG through the actual RELAY HTTP upload route
 *      with an authenticated server session.
 *   2. Mints two controlled Testnet NFTs with distinct owners (A and B), each
 *      carrying the uploaded image URI in on-chain metadata.
 *   3. Provisions both card accounts and verifies the controller code hash.
 *   4. Reads the metadata back from the finalized chain and compares the URI.
 *   5. Runs cross-user adversarial requests against the actual backend, which
 *      performs real finalized-chain reads: B must not prepare an action on A's
 *      NFT and A must not prepare an action on B's NFT.
 *
 * No secret is printed. The evidence JSON records public chain facts only.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const sdk = require('near-api-js');
const { createConfig, parseEnvText } = require('./app-config');
const { createAppServer } = require('./app-server');
const { createUploadStore } = require('./upload-store');
const { ServerSessionStore } = require('./auth-provider-adapter');

const ROOT = path.resolve(__dirname, '..');
const RPC_URL = process.env.RELAY_TEST_RPC_URL || 'https://test.rpc.fastnear.com';
const APP_URL = process.env.PUBLIC_APP_URL || 'http://127.0.0.1:4173';
const NEAR = 10n ** 24n;
const MINT_DEPOSIT = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
const MINT_GAS = 100n * 10n ** 12n;
const PROVISION_GAS = 300n * 10n ** 12n;
const FUND_B_TRANSFER = 3n * NEAR;
const STAMP = Date.now().toString(36);
const TOKEN_A = `t48a-${STAMP}`;
const TOKEN_B = `t48b-${STAMP}`;

function loadEnv() {
    return parseEnvText(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
}

async function view(provider, contractId, method, args = {}) {
    return provider.callFunction({ contractId, method, args, blockQuery: { finality: 'final' } });
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * Generates a real 320x200 RGB PNG so the upload is not a synthetic data URL
 * or a hand-written signature stub.
 */
function generateArtwork() {
    const width = 320;
    const height = 200;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // truecolour RGB
    header[10] = 0;
    header[11] = 0;
    header[12] = 0;

    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const row = y * (width * 3 + 1);
        raw[row] = 0; // no filter
        for (let x = 0; x < width; x += 1) {
            const offset = row + 1 + x * 3;
            const wave = Math.round(28 * Math.sin((x + y) / 24));
            raw[offset] = Math.max(0, Math.min(255, 28 + wave)); // ink
            raw[offset + 1] = Math.max(0, Math.min(255, 90 + Math.round(y / 4))); // green
            raw[offset + 2] = Math.max(0, Math.min(255, 76 + Math.round(x / 8))); // accent
        }
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function googleSession(store, accountId) {
    const session = store.createSession({
        sub: `task48-evidence|${accountId}`,
        email: `${accountId.replace(/[^a-z0-9]/g, '')}@evidence.test`,
        emailVerified: true,
        name: accountId,
    });
    session.nearAuth = {
        sub: session.sub,
        email: session.email,
        emailVerified: true,
        name: session.name,
        accountId,
        publicKey: 'ed25519:11111111111111111111111111111111',
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
        publicKey: 'ed25519:11111111111111111111111111111111',
        providerId: 'evidence-wallet',
        verifiedAt: Date.now(),
        origin: APP_URL,
    };
    return session;
}

function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

async function postJson(base, pathname, body, cookie) {
    const response = await fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    return { status: response.status, body: parsed };
}

async function main() {
    const execute = process.argv.includes('--execute');
    const env = loadEnv();
    const contractId = env.RELAY_CONTRACT_ID;
    if (!contractId) throw new Error('RELAY_CONTRACT_ID is missing from .env.');
    if (!env.NEAR_PRIVATE_KEY) throw new Error('NEAR_PRIVATE_KEY is missing from .env.');
    if (!env.OWNER_B_PRIVATE_KEY) throw new Error('OWNER_B_PRIVATE_KEY is missing from .env.');

    const accountA = env.NEAR_ACCOUNT_ID || 'spellman.testnet';
    const accountB = env.OWNER_B_ACCOUNT_ID || 'relay-owner-b.spellman.testnet';
    if (accountA === accountB) throw new Error('Evidence requires two distinct Testnet accounts.');

    const provider = new sdk.JsonRpcProvider({ url: RPC_URL });
    const status = await provider.viewNodeStatus();
    if (status.chain_id !== 'testnet') throw new Error(`RPC reports ${status.chain_id}, expected testnet.`);

    const signerA = sdk.KeyPairSigner.fromSecretKey(env.NEAR_PRIVATE_KEY);
    const signerB = sdk.KeyPairSigner.fromSecretKey(env.OWNER_B_PRIVATE_KEY);
    const nearA = new sdk.Account(accountA, provider, signerA);
    const nearB = new sdk.Account(accountB, provider, signerB);

    const minimumDeposit = BigInt(await view(provider, contractId, 'get_provision_minimum_deposit'));
    const controllerWasm = fs.readFileSync(path.join(ROOT, 'target/wasm32-unknown-unknown/release/relay_subaccount.wasm'));
    const controllerSha = crypto.createHash('sha256').update(controllerWasm).digest('hex');

    console.log('RELAY Task 48 Testnet evidence');
    console.log(`  Network: ${status.chain_id}`);
    console.log(`  Contract: ${contractId}`);
    console.log(`  Owner A: ${accountA}`);
    console.log(`  Owner B: ${accountB}`);
    console.log(`  Token A: ${TOKEN_A}`);
    console.log(`  Token B: ${TOKEN_B}`);
    console.log(`  Provision minimum: ${(Number(minimumDeposit) / 1e24).toFixed(6)} NEAR`);
    console.log(`  Controller SHA-256: ${controllerSha}`);

    if (!execute) {
        console.log('\nRead-only preview. Re-run with --execute to upload, mint, provision, and verify on Testnet.');
        return;
    }

    const evidence = {
        task: 48,
        network: status.chain_id,
        contractId,
        appUrl: APP_URL,
        accounts: { A: accountA, B: accountB },
        tokens: { A: TOKEN_A, B: TOKEN_B },
        controllerSha256: controllerSha,
        provisionMinimumYocto: minimumDeposit.toString(),
        steps: [],
    };
    function record(step, value = {}) {
        evidence.steps.push({ step, at: new Date().toISOString(), ...value });
        console.log(`  ✔ ${step}${value.transactionHash ? ` — ${value.transactionHash}` : ''}`);
    }

    // ── 0. Make sure B can pay for its own mint and provision ────────────────
    const balanceB = BigInt((await provider.viewAccount({ accountId: accountB, finalityQuery: { finality: 'final' } })).amount);
    if (balanceB < 2n * minimumDeposit + 100n * 10n ** 21n) {
        console.log('\n0. Funding owner B from owner A');
        const funding = await nearA.signAndSendTransaction({
            receiverId: accountB,
            actions: [sdk.actions.transfer(FUND_B_TRANSFER)],
            waitUntil: 'FINAL',
        });
        record('transfer A → B for independent provisioning', {
            transactionHash: funding.transaction.hash,
            amountNear: (Number(FUND_B_TRANSFER) / 1e24).toFixed(6),
        });
    }

    // ── 1. Real upload through the actual HTTP route ─────────────────────────
    console.log('\n1. Artwork upload through the RELAY backend');
    const uploadDirectory = path.join(ROOT, 'data', 'uploads');
    fs.mkdirSync(uploadDirectory, { recursive: true });
    const store = new ServerSessionStore();
    const sessionA = googleSession(store, accountA);
    const sessionB = googleSession(store, accountB);
    const walletA = walletSession(store, accountA);
    const walletB = walletSession(store, accountB);

    const config = createConfig({
        ...env,
        NEAR_RPC_URL: RPC_URL,
        RELAY_CONTRACT_ID: contractId,
        APP_PORT: '4173',
    });
    if (!config.valid) throw new Error(`Config invalid: ${config.errors.join('; ')}`);

    const uploadStore = createUploadStore({
        directory: uploadDirectory,
        publicAppUrl: APP_URL,
        provider: env.UPLOAD_STORAGE_PROVIDER || 'local',
        env,
    });
    const server = createAppServer({ config, sessionStore: store, uploadStore });
    const port = await listen(server, 0);
    const base = `http://127.0.0.1:${port}`;
    try {
        const artwork = generateArtwork();
        const uploadResponse = await fetch(`${base}/api/uploads`, {
            method: 'POST',
            headers: {
                'content-type': 'image/png',
                cookie: `relay_auth_session=${sessionA.sessionId}`,
            },
            body: artwork,
        });
        const uploaded = await uploadResponse.json();
        if (uploadResponse.status !== 200 || !uploaded.url) {
            throw new Error(`Upload failed: ${uploadResponse.status} ${uploaded?.error || ''}`);
        }
        evidence.artwork = {
            uri: uploaded.url,
            path: uploaded.path,
            bytes: uploaded.bytes,
            sha256: uploaded.sha256,
            contentType: uploaded.contentType,
            storage: uploaded.storage,
            permanent: uploaded.permanent,
            ownerId: uploaded.ownerId,
        };
        record('artwork stored via POST /api/uploads', {
            uri: uploaded.url,
            bytes: uploaded.bytes,
            sha256: uploaded.sha256,
            storage: uploaded.storage,
            permanent: uploaded.permanent,
        });

        // ── 2. Mint two cards with distinct owners ──────────────────────────
        console.log('\n2. Mint two controlled cards');
        async function ensureMint(tokenId, ownerId, signerAccount, label) {
            const existing = await view(provider, contractId, 'nft_token', { token_id: tokenId }).catch(() => null);
            if (existing) {
                if (existing.owner_id !== ownerId) throw new Error(`Token ${tokenId} exists with a different owner.`);
                console.log(`  Token ${tokenId} already exists; reusing it.`);
                return existing;
            }
            const minted = await signerAccount.signAndSendTransaction({
                receiverId: contractId,
                actions: [sdk.actions.functionCall('relay_mint', {
                    token_id: tokenId,
                    token_owner_id: ownerId,
                    token_metadata: {
                        title: `RELAY Task 48 ${label}`,
                        description: 'Controlled Testnet card for Task 48 two-user isolation evidence.',
                        media: uploaded.url,
                    },
                    associated_account_id: `${tokenId}.${contractId}`,
                    initial_credits: 1,
                }, MINT_GAS, MINT_DEPOSIT)],
                waitUntil: 'FINAL',
            });
            record(`relay_mint ${tokenId} owned by ${ownerId}`, {
                transactionHash: minted.transaction.hash,
                tokenId,
                ownerId,
                media: uploaded.url,
            });
            return view(provider, contractId, 'nft_token', { token_id: tokenId });
        }

        const tokenA = await ensureMint(TOKEN_A, accountA, nearA, 'owner A');
        const tokenB = await ensureMint(TOKEN_B, accountB, nearB, 'owner B');
        if (tokenA.owner_id !== accountA || tokenB.owner_id !== accountB) {
            throw new Error('Minted ownership does not match the intended distinct owners.');
        }
        if (tokenA.owner_id === tokenB.owner_id) throw new Error('Evidence tokens are not owned by distinct accounts.');

        // ── 3. Provision both card accounts ─────────────────────────────────
        console.log('\n3. Provision both card accounts');
        async function ensureProvision(tokenId, signerAccount) {
            let binding = await view(provider, contractId, 'relay_account_binding', { token_id: tokenId });
            if (!binding?.is_verified) {
                const provisioned = await signerAccount.signAndSendTransaction({
                    receiverId: contractId,
                    actions: [sdk.actions.functionCall('relay_provision_subaccount', { token_id: tokenId }, PROVISION_GAS, minimumDeposit)],
                    waitUntil: 'FINAL',
                });
                record(`relay_provision_subaccount ${tokenId}`, {
                    transactionHash: provisioned.transaction.hash,
                    depositYocto: minimumDeposit.toString(),
                });
                binding = await view(provider, contractId, 'relay_account_binding', { token_id: tokenId });
            }
            if (!binding?.is_verified) throw new Error(`${tokenId} card account is not verified.`);
            return binding;
        }
        const bindingA = await ensureProvision(TOKEN_A, nearA);
        const bindingB = await ensureProvision(TOKEN_B, nearB);
        const cardA = `${TOKEN_A}.${contractId}`;
        const cardB = `${TOKEN_B}.${contractId}`;

        const codeA = await provider.viewContractCode({ contractId: cardA, blockQuery: { finality: 'final' } });
        const codeB = await provider.viewContractCode({ contractId: cardB, blockQuery: { finality: 'final' } });
        const shaA = crypto.createHash('sha256').update(Buffer.from(codeA.code)).digest('hex');
        const shaB = crypto.createHash('sha256').update(Buffer.from(codeB.code)).digest('hex');
        if (shaA !== controllerSha || shaB !== controllerSha) throw new Error('Card controller hash mismatch.');
        record('both card controllers match the deployed controller', {
            cardA, cardB, controllerBytes: codeA.code.length, controllerSha256: shaA,
        });

        // ── 4. Read metadata back from the finalized chain ──────────────────
        console.log('\n4. Metadata read-back');
        const readA = await view(provider, contractId, 'nft_token', { token_id: TOKEN_A });
        const readB = await view(provider, contractId, 'nft_token', { token_id: TOKEN_B });
        for (const [label, token, owner, binding] of [
            ['A', readA, accountA, bindingA],
            ['B', readB, accountB, bindingB],
        ]) {
            if (token.owner_id !== owner) throw new Error(`Token ${label} owner mismatch on read-back.`);
            if (token.metadata?.media !== uploaded.url) {
                throw new Error(`Token ${label} metadata.media does not match the uploaded URI.`);
            }
            if (!binding?.is_verified) throw new Error(`Token ${label} binding is not verified.`);
        }
        evidence.readBack = {
            A: { tokenId: TOKEN_A, ownerId: readA.owner_id, media: readA.metadata.media, accountId: cardA, verified: bindingA.is_verified },
            B: { tokenId: TOKEN_B, ownerId: readB.owner_id, media: readB.metadata.media, accountId: cardB, verified: bindingB.is_verified },
        };
        record('nft_token metadata.media matches the stored artwork URI for both cards', {
            uri: uploaded.url,
        });

        // ── 5. Adversarial requests against the actual backend ──────────────
        console.log('\n5. Cross-user adversarial requests (real finalized-chain reads)');
        const attempts = [];
        async function expectRejected(label, pathname, body, cookie, expectedStatus, expectedCode) {
            const result = await postJson(base, pathname, body, cookie);
            attempts.push({ label, status: result.status, code: result.body?.code || null, error: result.body?.error || null });
            if (result.status !== expectedStatus || result.body?.code !== expectedCode) {
                throw new Error(`${label} was not rejected as expected: ${result.status} ${JSON.stringify(result.body)}`);
            }
            console.log(`  ✔ ${label} → ${result.status} ${expectedCode}`);
        }

        await expectRejected(
            'Google B prepares a spend from A’s card',
            '/api/near/prepare-action',
            { kind: 'spend', tokenId: TOKEN_A, receiverId: 'attacker.testnet', amountNear: '0.01' },
            `relay_auth_session=${sessionB.sessionId}`,
            403,
            'TOKEN_OWNER',
        );
        await expectRejected(
            'Google A prepares a spend from B’s card',
            '/api/near/prepare-action',
            { kind: 'spend', tokenId: TOKEN_B, receiverId: 'attacker.testnet', amountNear: '0.01' },
            `relay_auth_session=${sessionA.sessionId}`,
            403,
            'TOKEN_OWNER',
        );
        await expectRejected(
            'Wallet B prepares a spend from A’s card',
            '/api/near/wallet/prepare-action',
            { kind: 'spend', tokenId: TOKEN_A, receiverId: 'attacker.testnet', amountNear: '0.01' },
            `relay_wallet_session=${walletB.sessionId}`,
            403,
            'TOKEN_OWNER',
        );
        await expectRejected(
            'Wallet A prepares a transfer of B’s NFT',
            '/api/near/wallet/prepare-action',
            { kind: 'transfer', tokenId: TOKEN_B, receiverId: accountA },
            `relay_wallet_session=${walletA.sessionId}`,
            403,
            'TOKEN_OWNER',
        );

        const anonymousUpload = await fetch(`${base}/api/uploads`, {
            method: 'POST',
            headers: { 'content-type': 'image/png' },
            body: generateArtwork(),
        });
        if (anonymousUpload.status !== 401) throw new Error('Anonymous upload was not rejected.');
        attempts.push({ label: 'anonymous upload', status: 401, code: 'AUTH_REQUIRED' });
        console.log('  ✔ anonymous upload → 401 AUTH_REQUIRED');

        evidence.adversarial = attempts;
        record('all cross-user attempts rejected against the real backend', { attempts: attempts.length });
    } finally {
        await close(server);
    }

    const outputDirectory = path.join(ROOT, 'data');
    fs.mkdirSync(outputDirectory, { recursive: true });
    const outputPath = path.join(outputDirectory, `task48-testnet-evidence-${STAMP}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(evidence, null, 2));
    console.log(`\nEvidence written to ${path.relative(ROOT, outputPath)}`);
    console.log('Task 48 Testnet evidence passed.');
}

main().catch((error) => {
    console.error(`Task 48 evidence failed: ${error.message}`);
    process.exitCode = 1;
});
