#!/usr/bin/env node
'use strict';

/**
 * Deploy the RELAY NEAR Testnet contract and store the controller WASM.
 *
 * Read-only by default. Pass --execute to send real Testnet transactions.
 *
 * What it does:
 *   1. Loads .env and verifies the configured RPC is Testnet.
 *   2. Uses NEAR_PRIVATE_KEY (spellman.testnet) as the deployer.
 *   3. Backs up current contract state via view_state to data/.
 *   4. Tops up the contract if the larger code needs storage stake.
 *   5. Deploys target/wasm32-unknown-unknown/release/relay_contract.wasm.
 *   6. Stores relay_subaccount.wasm with store_controller_code.
 *   7. Verifies the new controller length, supply, and provision minimum.
 *
 * No secret is printed.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sdk = require('near-api-js');
const { parseEnvText } = require('./app-config');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_WASM = path.join(ROOT, 'target', 'wasm32-unknown-unknown', 'release', 'relay_contract.wasm');
const CONTROLLER_WASM = path.join(ROOT, 'target', 'wasm32-unknown-unknown', 'release', 'relay_subaccount.wasm');
const YOCTO = 10n ** 24n;
const TOP_UP = 3n * YOCTO;
const CONTROLLER_DEPOSIT = 300_000_000_000_000_000_000_000n; // 0.3 NEAR, refunded excess
const GAS = 300n * 10n ** 12n; // 300 TGas

function fail(message) {
    const error = new Error(message);
    error.code = 'DEPLOY_FAILED';
    throw error;
}

function readEnv() {
    const parsed = parseEnvText(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
    const privateKey = parsed.NEAR_PRIVATE_KEY;
    if (!privateKey) fail('NEAR_PRIVATE_KEY is missing from .env.');
    const accountId = parsed.NEAR_ACCOUNT_ID;
    if (!accountId) fail('NEAR_ACCOUNT_ID is missing from .env.');
    const contractId = parsed.RELAY_CONTRACT_ID;
    if (!contractId) fail('RELAY_CONTRACT_ID is missing from .env.');
    if ((parsed.NEAR_NETWORK || 'testnet') !== 'testnet') fail('NEAR_NETWORK must be testnet.');
    return {
        privateKey,
        accountId,
        contractId,
        rpcUrl: process.env.RELAY_DEPLOY_RPC_URL || parsed.NEAR_RPC_URL || 'https://test.rpc.fastnear.com',
    };
}

async function rpc(rpcUrl, method, params) {
    const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'relay-deploy', method, params }),
    });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message || JSON.stringify(body.error)}`);
    return body.result;
}

async function viewFunction(rpcUrl, contractId, method, args) {
    const result = await rpc(rpcUrl, 'query', {
        request_type: 'call_function',
        account_id: contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        finality: 'final',
    });
    return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

async function viewAccount(rpcUrl, accountId) {
    return rpc(rpcUrl, 'query', { request_type: 'view_account', account_id: accountId, finality: 'final' });
}

async function backupState(provider, contractId, codeHash) {
    const directory = path.join(ROOT, 'data');
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `state-backup-${String(codeHash).slice(0, 12)}-${Date.now()}.json`);
    const state = await provider.viewContractState({ contractId, prefix: '' });
    fs.writeFileSync(filePath, JSON.stringify({
        contractId,
        codeHash,
        capturedAt: new Date().toISOString(),
        blockHeight: state.block_height,
        values: state.values || [],
    }, null, 2));
    return { filePath, keys: (state.values || []).length };
}

async function main() {
    const execute = process.argv.includes('--execute');
    const storeOnly = process.argv.includes('--store-only');
    const env = readEnv();
    const contractBytes = fs.readFileSync(CONTRACT_WASM);
    const controllerBytes = fs.readFileSync(CONTROLLER_WASM);
    const contractHash = crypto.createHash('sha256').update(contractBytes).digest('hex');
    const controllerHash = crypto.createHash('sha256').update(controllerBytes).digest('hex');

    const provider = new sdk.JsonRpcProvider({ url: env.rpcUrl });
    const status = await provider.viewNodeStatus();
    if (status.chain_id !== 'testnet') fail(`RPC reports ${status.chain_id}, expected testnet.`);

    const signer = sdk.KeyPairSigner.fromSecretKey(env.privateKey);
    const signerPublicKey = (await signer.getPublicKey()).toString();
    const keys = await provider.viewAccessKeyList({ accountId: env.accountId, finalityQuery: { finality: 'final' } });
    const fullAccess = (keys.keys || []).find((entry) =>
        entry.public_key === signerPublicKey &&
        (entry.access_key?.permission === 'FullAccess' || entry.access_key?.permission?.FullAccess !== undefined));
    if (!fullAccess) fail('The configured deployer key is not a FullAccess key on the configured account.');

    // A contract deploy must be signed by the contract account itself, so make
    // sure the same key is a FullAccess key there too.
    const contractKeys = await provider.viewAccessKeyList({ accountId: env.contractId, finalityQuery: { finality: 'final' } });
    const contractFullAccess = (contractKeys.keys || []).find((entry) =>
        entry.public_key === signerPublicKey &&
        (entry.access_key?.permission === 'FullAccess' || entry.access_key?.permission?.FullAccess !== undefined));
    if (!contractFullAccess) fail(`The configured key is not a FullAccess key on ${env.contractId}.`);

    const contractState = await viewAccount(env.rpcUrl, env.contractId).catch(() => null);
    if (!contractState) fail(`Contract account ${env.contractId} does not exist on Testnet.`);
    const deployerState = await viewAccount(env.rpcUrl, env.accountId);
    const controllerLength = await viewFunction(env.rpcUrl, env.contractId, 'get_controller_code_len', {}).catch(() => null);
    const supply = await viewFunction(env.rpcUrl, env.contractId, 'nft_total_supply', {}).catch(() => 'unknown');

    console.log('RELAY contract deployment preflight');
    console.log(`  RPC: ${env.rpcUrl} (${status.chain_id})`);
    console.log(`  Deployer: ${env.accountId}`);
    console.log(`  Contract: ${env.contractId}`);
    console.log(`  Contract code hash: ${contractState.code_hash}`);
    console.log(`  Contract balance: ${(Number(contractState.amount) / 1e24).toFixed(4)} NEAR`);
    console.log(`  Deployer balance: ${(Number(deployerState.amount) / 1e24).toFixed(4)} NEAR`);
    console.log(`  Current controller bytes: ${controllerLength}`);
    console.log(`  Current NFT supply: ${supply}`);
    console.log(`  New core WASM: ${contractBytes.length} bytes (sha256 ${contractHash.slice(0, 16)}…)`);
    console.log(`  New controller WASM: ${controllerBytes.length} bytes (sha256 ${controllerHash.slice(0, 16)}…)`);

    if (!execute) {
        console.log('\nRead-only preflight. Re-run with --execute to deploy.');
        return;
    }

    try {
        const backup = await backupState(provider, env.contractId, contractState.code_hash);
        console.log(`\nState backup written to ${path.relative(ROOT, backup.filePath)} (${backup.keys} keys).`);
    } catch (error) {
        console.warn(`\nState backup skipped (non-fatal): ${error.message}`);
    }

    // Top-ups come from the deployer wallet; deploy/store must be signed by the
    // contract account itself.
    const deployerAccount = new sdk.Account(env.accountId, provider, signer);
    const contractAccount = new sdk.Account(env.contractId, provider, signer);

    // The contract must cover the larger code's storage stake. `storage_usage`
    // already includes the current code, so only the growth needs funding.
    const storagePerByte = 10n ** 19n;
    const currentCoreCode = await provider
        .viewContractCode({ contractId: env.contractId, blockQuery: { finality: 'final' } })
        .catch(() => null);
    const currentCoreBytes = currentCoreCode?.code?.length || 0;
    const currentControllerBytes = controllerLength || 0;
    const codeGrowth = BigInt(
        Math.max(0, contractBytes.length - currentCoreBytes) +
        Math.max(0, controllerBytes.length - currentControllerBytes),
    );
    const available = BigInt(contractState.amount) - BigInt(contractState.storage_usage) * storagePerByte;
    const requiredTopUp = codeGrowth * storagePerByte + 10n ** 23n; // +0.1 NEAR buffer
    if (available < requiredTopUp) {
        let delta = requiredTopUp - available;
        if (delta > TOP_UP) delta = TOP_UP;
        console.log(`Code growth ${codeGrowth} bytes; topping up ${env.contractId} by ${(Number(delta) / 1e24).toFixed(4)} NEAR…`);
        const result = await deployerAccount.signAndSendTransaction({
            receiverId: env.contractId,
            actions: [sdk.actions.transfer(delta)],
            waitUntil: 'FINAL',
        });
        console.log(`  top-up finalized: ${result.transaction?.hash || result.transaction_outcome?.id || 'ok'}`);
    } else {
        console.log('Contract already has enough unstaked balance for the new code.');
    }

    console.log('Deploying core contract WASM…');
    if (storeOnly) {
        console.log('  skipped (--store-only): current code hash already ' + contractState.code_hash);
    } else {
        const deployResult = await contractAccount.signAndSendTransaction({
            receiverId: env.contractId,
            actions: [sdk.actions.deployContract(contractBytes)],
            waitUntil: 'FINAL',
        });
        console.log(`  deploy finalized: ${deployResult.transaction?.hash || deployResult.transaction_outcome?.id || 'ok'}`);
    }

    console.log('Storing controller WASM…');
    // store_controller_code asserts predecessor == contract owner
    // (spellman.testnet), so this call is signed by the deployer account.
    const storeResult = await deployerAccount.signAndSendTransaction({
        receiverId: env.contractId,
        actions: [sdk.actions.functionCall(
            'store_controller_code',
            { code: Array.from(controllerBytes) },
            GAS,
            CONTROLLER_DEPOSIT,
        )],
        waitUntil: 'FINAL',
    });
    console.log(`  controller store finalized: ${storeResult.transaction?.hash || storeResult.transaction_outcome?.id || 'ok'}`);

    const afterLength = await viewFunction(env.rpcUrl, env.contractId, 'get_controller_code_len', {});
    const afterSupply = await viewFunction(env.rpcUrl, env.contractId, 'nft_total_supply', {});
    const minimumDeposit = await viewFunction(env.rpcUrl, env.contractId, 'get_provision_minimum_deposit', {});
    const afterState = await viewAccount(env.rpcUrl, env.contractId);

    console.log('\nVerification');
    console.log(`  controller bytes: ${afterLength} (expected ${controllerBytes.length})`);
    console.log(`  NFT supply: ${afterSupply} (before ${supply})`);
    console.log(`  provision minimum: ${(Number(minimumDeposit) / 1e24).toFixed(6)} NEAR`);
    console.log(`  new code hash: ${afterState.code_hash}`);
    if (afterLength !== controllerBytes.length) fail('Controller length mismatch after store.');
    console.log('\nDeployment complete.');
}

main().catch((error) => {
    console.error(`Deployment failed: ${error.message}`);
    process.exitCode = 1;
});
