#!/usr/bin/env node
'use strict';

/**
 * Real NEAR Testnet evidence for the NEAR Auth product surface.
 *
 * Acts as an independent, non-owner Testnet user (relay-owner-b.spellman.testnet)
 * and exercises the same contract methods the server builds for Google users:
 *
 *   1. Permissionless self-mint (relay_mint).
 *   2. `u-` token ID reservation rejection (owner-only namespace).
 *   3. Card provisioning + controller install (relay_provision_subaccount).
 *   4. NEP-141 storage registration on the card account.
 *   5. Direct native NEAR spend from the card account.
 *
 * Read-only unless --execute is passed. No secret is printed.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sdk = require('near-api-js');
const { parseEnvText } = require('./app-config');

const ROOT = path.resolve(__dirname, '..');
const RPC_URL = process.env.RELAY_TEST_RPC_URL || 'https://test.rpc.fastnear.com';
const NEAR = 10n ** 24n;
const GAS = 100n * 10n ** 12n;
const MINT_DEPOSIT = 50_000_000_000_000_000_000_000n; // 0.05 NEAR, excess refunded
const NFT_GAS = 150n * 10n ** 12n;
const FT_CONTRACT = 'wrap.testnet';
const FT_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const SPEND_AMOUNT = 10_000_000_000_000_000_000_000n; // 0.01 NEAR

const TOKEN_ID = process.env.RELAY_EVIDENCE_TOKEN_ID || `relay-auth-${Date.now().toString(36)}`;

function loadEnv() {
    return parseEnvText(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
}

async function view(provider, contractId, method, args = {}) {
    return provider.callFunction({ contractId, method, args, blockQuery: { finality: 'final' } });
}

async function main() {
    const execute = process.argv.includes('--execute');
    const env = loadEnv();
    const contractId = env.RELAY_CONTRACT_ID;
    if (!contractId) throw new Error('RELAY_CONTRACT_ID is missing from .env.');
    if (!env.OWNER_B_PRIVATE_KEY) throw new Error('OWNER_B_PRIVATE_KEY is missing from .env.');
    const userAccountId = env.OWNER_B_ACCOUNT_ID || 'relay-owner-b.spellman.testnet';

    const provider = new sdk.JsonRpcProvider({ url: RPC_URL });
    const status = await provider.viewNodeStatus();
    if (status.chain_id !== 'testnet') throw new Error(`RPC reports ${status.chain_id}, expected testnet.`);

    const signer = sdk.KeyPairSigner.fromSecretKey(env.OWNER_B_PRIVATE_KEY);
    const account = new sdk.Account(userAccountId, provider, signer);
    const associatedAccountId = `${TOKEN_ID}.${contractId}`;

    const controllerWasm = fs.readFileSync(path.join(ROOT, 'target/wasm32-unknown-unknown/release/relay_subaccount.wasm'));
    const controllerSha = crypto.createHash('sha256').update(controllerWasm).digest('hex');
    const minimumDeposit = BigInt(await view(provider, contractId, 'get_provision_minimum_deposit'));

    console.log('RELAY NEAR Testnet evidence run');
    console.log(`  Network: ${status.chain_id}`);
    console.log(`  Contract: ${contractId}`);
    console.log(`  Independent user: ${userAccountId}`);
    console.log(`  Token ID: ${TOKEN_ID}`);
    console.log(`  Provision minimum: ${(Number(minimumDeposit) / 1e24).toFixed(6)} NEAR`);
    console.log(`  Controller SHA-256: ${controllerSha}`);

    if (!execute) {
        console.log('\nRead-only preview. Re-run with --execute to send Testnet transactions.');
        return;
    }

    const evidence = {
        network: status.chain_id,
        contractId,
        userAccountId,
        tokenId: TOKEN_ID,
        associatedAccountId,
        controllerSha256: controllerSha,
        steps: [],
    };

    function record(step, value) {
        evidence.steps.push({ step, at: new Date().toISOString(), ...value });
        console.log(`  ✔ ${step}${value.transactionHash ? ` — ${value.transactionHash}` : ''}`);
    }

    // ── 1. Permissionless self-mint by a non-owner ───────────────────────────
    console.log('\n1. Permissionless self-mint');
    const existing = await view(provider, contractId, 'nft_token', { token_id: TOKEN_ID }).catch(() => null);
    if (!existing) {
        const mint = await account.signAndSendTransaction({
            receiverId: contractId,
            actions: [sdk.actions.functionCall('relay_mint', {
                token_id: TOKEN_ID,
                token_owner_id: userAccountId,
                token_metadata: {
                    title: 'RELAY Auth demo card',
                    description: 'Minted by an independent Testnet account through the permissionless RELAY mint path.',
                },
                associated_account_id: associatedAccountId,
                initial_credits: 3,
            }, NFT_GAS, MINT_DEPOSIT)],
            waitUntil: 'FINAL',
        });
        record('relay_mint (non-owner)', { transactionHash: mint.transaction.hash });
    } else {
        console.log('  Token already exists; reusing it.');
    }
    const token = await view(provider, contractId, 'nft_token', { token_id: TOKEN_ID });
    if (!token || token.owner_id !== userAccountId) throw new Error('Minted token owner mismatch.');
    record('nft_token owner verified', { ownerId: token.owner_id, tokenId: TOKEN_ID });

    // ── 2. Reserved `u-` namespace rejection ─────────────────────────────────
    console.log('\n2. Reserved u- namespace');
    let reservedRejected = false;
    let reservedError = null;
    try {
        await account.signAndSendTransaction({
            receiverId: contractId,
            actions: [sdk.actions.functionCall('relay_mint', {
                token_id: 'u-evidence-test',
                token_owner_id: userAccountId,
                token_metadata: { title: 'Should fail' },
                associated_account_id: `u-evidence-test.${contractId}`,
                initial_credits: 0,
            }, NFT_GAS, MINT_DEPOSIT)],
            waitUntil: 'FINAL',
        });
    } catch (error) {
        reservedRejected = /reserved|unreachable|panicked/i.test(String(error.message));
        reservedError = String(error.message).slice(0, 200);
    }
    if (!reservedRejected) throw new Error('Reserved u- token ID was not rejected.');
    record('u- token ID rejected for non-owner', { error: reservedError });

    // ── 3. Provision the card account ────────────────────────────────────────
    console.log('\n3. Provision card account');
    let binding = await view(provider, contractId, 'relay_account_binding', { token_id: TOKEN_ID });
    if (!binding?.is_verified) {
        const provision = await account.signAndSendTransaction({
            receiverId: contractId,
            actions: [sdk.actions.functionCall('relay_provision_subaccount', { token_id: TOKEN_ID }, 300n * 10n ** 12n, minimumDeposit)],
            waitUntil: 'FINAL',
        });
        record('relay_provision_subaccount', { transactionHash: provision.transaction.hash, depositYocto: minimumDeposit.toString() });
        binding = await view(provider, contractId, 'relay_account_binding', { token_id: TOKEN_ID });
    }
    if (!binding?.is_verified) throw new Error('Card account is not verified after provisioning.');

    const cardState = await provider.viewAccount({ accountId: associatedAccountId, finalityQuery: { finality: 'final' } });
    const cardCode = await provider.viewContractCode({ contractId: associatedAccountId, blockQuery: { finality: 'final' } });
    const cardCodeSha = crypto.createHash('sha256').update(Buffer.from(cardCode.code)).digest('hex');
    if (cardCodeSha !== controllerSha) throw new Error('Card controller code hash does not match the deployed controller.');
    record('card account verified', {
        accountId: associatedAccountId,
        balanceNear: (Number(cardState.amount) / 1e24).toFixed(6),
        controllerBytes: cardCode.code.length,
        controllerSha256: cardCodeSha,
    });

    // ── 4. NEP-141 storage registration ──────────────────────────────────────
    console.log('\n4. NEP-141 registration (wNEAR)');
    const storage = await view(provider, FT_CONTRACT, 'storage_balance_of', { account_id: associatedAccountId }).catch(() => null);
    let ftTx = null;
    if (!storage) {
        const reg = await account.signAndSendTransaction({
            receiverId: contractId,
            actions: [sdk.actions.functionCall('relay_execute_subaccount', {
                token_id: TOKEN_ID,
                action: { RegisterNep141: { ft_contract_id: FT_CONTRACT, storage_deposit: FT_STORAGE_DEPOSIT.toString() } },
            }, 150n * 10n ** 12n, 0n)],
            waitUntil: 'FINAL',
        });
        ftTx = reg.transaction.hash;
        record('relay_execute_subaccount RegisterNep141', { transactionHash: ftTx, ftContractId: FT_CONTRACT });
    } else {
        console.log('  Card already registered with wNEAR.');
    }
    const afterStorage = await view(provider, FT_CONTRACT, 'storage_balance_of', { account_id: associatedAccountId });
    if (!afterStorage) throw new Error('wNEAR storage registration did not take effect.');
    record('wNEAR storage balance verified', { storageBalance: JSON.stringify(afterStorage), transactionHash: ftTx });

    // ── 5. Direct native NEAR spend from the card ────────────────────────────
    console.log('\n5. Direct native NEAR spend');
    const recipient = env.NEAR_ACCOUNT_ID || 'spellman.testnet';
    const beforeCard = BigInt((await provider.viewAccount({ accountId: associatedAccountId, finalityQuery: { finality: 'final' } })).amount);
    const beforeRecipient = BigInt((await provider.viewAccount({ accountId: recipient, finalityQuery: { finality: 'final' } })).amount);
    const spend = await account.signAndSendTransaction({
        receiverId: contractId,
        actions: [sdk.actions.functionCall('relay_execute_subaccount', {
            token_id: TOKEN_ID,
            action: { TransferNear: { receiver_id: recipient, amount: SPEND_AMOUNT.toString() } },
        }, 150n * 10n ** 12n, 0n)],
        waitUntil: 'FINAL',
    });
    const afterCard = BigInt((await provider.viewAccount({ accountId: associatedAccountId, finalityQuery: { finality: 'final' } })).amount);
    const afterRecipient = BigInt((await provider.viewAccount({ accountId: recipient, finalityQuery: { finality: 'final' } })).amount);
    if (afterRecipient - beforeRecipient !== SPEND_AMOUNT) {
        throw new Error('Recipient balance did not increase by the spent amount.');
    }
    if (beforeCard - afterCard < SPEND_AMOUNT) {
        throw new Error('Card balance did not decrease by at least the spent amount.');
    }
    record('relay_execute_subaccount TransferNear', {
        transactionHash: spend.transaction.hash,
        from: associatedAccountId,
        to: recipient,
        amountNear: (Number(SPEND_AMOUNT) / 1e24).toFixed(6),
        cardDebitNear: (Number(beforeCard - afterCard) / 1e24).toFixed(6),
        recipientCreditNear: (Number(afterRecipient - beforeRecipient) / 1e24).toFixed(6),
    });

    const outputDirectory = path.join(ROOT, 'data');
    fs.mkdirSync(outputDirectory, { recursive: true });
    const outputPath = path.join(outputDirectory, `near-auth-testnet-evidence-${TOKEN_ID}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(evidence, null, 2));
    console.log(`\nEvidence written to ${path.relative(ROOT, outputPath)}`);
    console.log('All Testnet evidence steps passed.');
}

main().catch((error) => {
    console.error(`Evidence run failed: ${error.message}`);
    process.exitCode = 1;
});
