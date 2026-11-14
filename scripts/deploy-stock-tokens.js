#!/usr/bin/env node
'use strict';

/**
 * Deploy the claimable RELAY test stock / commodity tokens to NEAR Testnet.
 *
 * Read-only by default. Pass --execute to send real Testnet transactions.
 *
 * What it does, per asset:
 *   1. Creates `<symbol>.spellman.testnet` (or reuses it).
 *   2. Deploys the stock-token WASM and initializes name/symbol/decimals.
 *   3. Registers the treasury account with the token contract.
 *   4. Mints the demo supply to the treasury (refills after claims).
 *
 * The treasury is the account in NEAR_ACCOUNT_ID (spellman.testnet) using
 * NEAR_PRIVATE_KEY. No secret is printed.
 *
 * Usage:
 *   node scripts/deploy-stock-tokens.js              # preflight
 *   node scripts/deploy-stock-tokens.js --execute    # deploy
 *   node scripts/deploy-stock-tokens.js --execute --assets=AAPL,GOLD
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sdk = require('near-api-js');
const { parseEnvText } = require('./app-config');
const { STOCK_ASSETS } = require('./stock-assets');

const ROOT = path.resolve(__dirname, '..');
const WASM_PATH = path.join(
    ROOT,
    'integration-tests',
    'stock-token',
    'target',
    'wasm32-unknown-unknown',
    'release',
    'relay_stock_token.wasm',
);
const YOCTO = 10n ** 24n;
const STORAGE_PER_BYTE = 10n ** 19n;
const DEPLOY_GAS = 300n * 10n ** 12n;
const CALL_GAS = 100n * 10n ** 12n;
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const SUPPLY_SHARES = 10_000_000n; // 10M shares per token
const SHARE = 10n ** 6n;

function fail(message) {
    const error = new Error(message);
    error.code = 'STOCK_DEPLOY_FAILED';
    throw error;
}

function readEnv() {
    const parsed = parseEnvText(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
    const privateKey = parsed.NEAR_PRIVATE_KEY;
    if (!privateKey) fail('NEAR_PRIVATE_KEY is missing from .env.');
    const accountId = parsed.NEAR_ACCOUNT_ID;
    if (!accountId) fail('NEAR_ACCOUNT_ID is missing from .env.');
    if ((parsed.NEAR_NETWORK || 'testnet') !== 'testnet') fail('NEAR_NETWORK must be testnet.');
    return {
        privateKey,
        treasuryAccountId: parsed.STOCK_FAUCET_ACCOUNT_ID || accountId,
        rpcUrl: process.env.RELAY_DEPLOY_RPC_URL || parsed.NEAR_RPC_URL || 'https://test.rpc.fastnear.com',
    };
}

async function viewFunction(provider, contractId, method, args = {}) {
    try {
        return await provider.callFunction({
            contractId,
            method,
            args,
            blockQuery: { finality: 'final' },
        });
    } catch (error) {
        if (/does not exist|MethodNotFound|Contract method is not found|UnknownAccount/i.test(String(error?.message || error))) {
            return null;
        }
        throw error;
    }
}

async function viewAccount(provider, accountId) {
    try {
        return await provider.viewAccount({ accountId });
    } catch (error) {
        if (/does not exist|UnknownAccount/i.test(String(error?.message || error))) return null;
        throw error;
    }
}

function fmtNear(yocto) {
    return (Number(yocto) / 1e24).toFixed(4);
}

async function main() {
    const execute = process.argv.includes('--execute');
    const assetFilter = (process.argv.find((arg) => arg.startsWith('--assets=')) || '')
        .slice('--assets='.length)
        .split(',')
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean);
    const assets = assetFilter.length
        ? STOCK_ASSETS.filter((asset) => assetFilter.includes(asset.symbol))
        : STOCK_ASSETS;
    if (!assets.length) fail('No matching stock assets selected.');

    const env = readEnv();
    const wasm = fs.readFileSync(WASM_PATH);
    const wasmHash = crypto.createHash('sha256').update(wasm).digest('hex');
    const deployDeposit = BigInt(wasm.length) * STORAGE_PER_BYTE + 10n ** 23n; // +0.1 NEAR buffer
    const supply = SUPPLY_SHARES * SHARE;

    const provider = new sdk.JsonRpcProvider({ url: env.rpcUrl });
    const status = await provider.viewNodeStatus();
    if (status.chain_id !== 'testnet') fail(`RPC reports ${status.chain_id}, expected testnet.`);

    const signer = sdk.KeyPairSigner.fromSecretKey(env.privateKey);
    const signerPublicKey = (await signer.getPublicKey()).toString();
    const treasuryKeys = await provider.viewAccessKeyList({
        accountId: env.treasuryAccountId,
        finalityQuery: { finality: 'final' },
    });
    const fullAccess = (treasuryKeys.keys || []).find((entry) =>
        entry.public_key === signerPublicKey &&
        (entry.access_key?.permission === 'FullAccess' || entry.access_key?.permission?.FullAccess !== undefined));
    if (!fullAccess) fail(`The configured key is not a FullAccess key on ${env.treasuryAccountId}.`);

    const treasuryState = await viewAccount(provider, env.treasuryAccountId);
    if (!treasuryState) fail(`Treasury account ${env.treasuryAccountId} does not exist.`);

    console.log('RELAY test stock deployment preflight');
    console.log(`  RPC: ${env.rpcUrl} (${status.chain_id})`);
    console.log(`  Treasury: ${env.treasuryAccountId} (${fmtNear(treasuryState.amount)} NEAR)`);
    console.log(`  WASM: ${wasm.length} bytes (sha256 ${wasmHash.slice(0, 16)}…)`);
    console.log(`  Deploy deposit per token: ${fmtNear(deployDeposit)} NEAR`);
    console.log(`  Supply per token: ${SUPPLY_SHARES} shares (${supply} base units)`);
    console.log('');

    const plans = [];
    let totalCost = 0n;
    for (const asset of assets) {
        const account = await viewAccount(provider, asset.contractId);
        const metadata = account ? await viewFunction(provider, asset.contractId, 'ft_metadata') : null;
        const treasuryBalance = metadata
            ? BigInt((await viewFunction(provider, asset.contractId, 'ft_balance_of', {
                account_id: env.treasuryAccountId,
            })) || '0')
            : 0n;
        const storage = metadata
            ? await viewFunction(provider, asset.contractId, 'storage_balance_of', {
                account_id: env.treasuryAccountId,
            })
            : null;
        const needsDeploy = !metadata;
        const needsStorage = Boolean(metadata) && !storage;
        const mintDelta = metadata && treasuryBalance < supply ? supply - treasuryBalance : 0n;
        if (needsDeploy) totalCost += deployDeposit;
        plans.push({ asset, account, metadata, treasuryBalance, needsDeploy, needsStorage, mintDelta });
        const state = !account
            ? 'create + deploy + init'
            : needsDeploy
                ? 'deploy + init'
                : 'already initialized';
        console.log(`  ${asset.symbol.padEnd(5)} ${asset.contractId}`);
        console.log(`        ${state}; treasury ${metadata ? `${treasuryBalance / SHARE} shares` : 'n/a'}; mint ${mintDelta / SHARE} shares`);
    }

    console.log('');
    console.log(`Estimated new contract cost: ${fmtNear(totalCost)} NEAR (gas excluded)`);
    if (totalCost > BigInt(treasuryState.amount)) {
        fail(`Treasury balance ${fmtNear(treasuryState.amount)} NEAR is below the estimated cost ${fmtNear(totalCost)} NEAR.`);
    }

    if (!execute) {
        console.log('\nRead-only preflight. Re-run with --execute to deploy.');
        return;
    }

    const treasuryAccount = new sdk.Account(env.treasuryAccountId, provider, signer);
    const results = [];

    for (const plan of plans) {
        const { asset } = plan;
        console.log(`\n${asset.symbol}: ${asset.contractId}`);

        if (plan.needsDeploy) {
            const actions = [];
            if (!plan.account) {
                actions.push(sdk.actions.createAccount());
                actions.push(sdk.actions.transfer(deployDeposit));
            }
            actions.push(sdk.actions.deployContract(wasm));
            actions.push(sdk.actions.functionCall('new', {
                owner_id: env.treasuryAccountId,
                name: asset.name,
                symbol: asset.symbol,
                decimals: asset.decimals,
            }, DEPLOY_GAS, 0n));
            const result = await treasuryAccount.signAndSendTransaction({
                receiverId: asset.contractId,
                actions,
                waitUntil: 'FINAL',
            });
            const hash = result?.transaction?.hash || result?.transaction_outcome?.id || 'ok';
            console.log(`  deployed + initialized: ${hash}`);
        } else {
            console.log('  contract already initialized; skipping deploy');
        }

        const storage = await viewFunction(provider, asset.contractId, 'storage_balance_of', {
            account_id: env.treasuryAccountId,
        });
        if (!storage) {
            const result = await treasuryAccount.signAndSendTransaction({
                receiverId: asset.contractId,
                actions: [
                    sdk.actions.functionCall(
                        'storage_deposit',
                        { account_id: env.treasuryAccountId, registration_only: true },
                        CALL_GAS,
                        STORAGE_DEPOSIT,
                    ),
                ],
                waitUntil: 'FINAL',
            });
            console.log(`  treasury storage registered: ${result?.transaction?.hash || 'ok'}`);
        } else {
            console.log('  treasury storage already registered');
        }

        const balance = BigInt((await viewFunction(provider, asset.contractId, 'ft_balance_of', {
            account_id: env.treasuryAccountId,
        })) || '0');
        if (balance < supply) {
            const delta = supply - balance;
            const result = await treasuryAccount.signAndSendTransaction({
                receiverId: asset.contractId,
                actions: [
                    sdk.actions.functionCall('mint', {
                        account_id: env.treasuryAccountId,
                        amount: delta.toString(),
                    }, CALL_GAS, 0n),
                ],
                waitUntil: 'FINAL',
            });
            console.log(`  minted ${delta / SHARE} shares: ${result?.transaction?.hash || 'ok'}`);
        } else {
            console.log('  treasury already funded');
        }

        const metadata = await viewFunction(provider, asset.contractId, 'ft_metadata');
        const finalBalance = BigInt((await viewFunction(provider, asset.contractId, 'ft_balance_of', {
            account_id: env.treasuryAccountId,
        })) || '0');
        results.push({
            symbol: asset.symbol,
            contractId: asset.contractId,
            name: metadata?.name || asset.name,
            decimals: metadata?.decimals ?? asset.decimals,
            treasuryBalance: finalBalance.toString(),
        });
        console.log(`  verified: ${metadata?.symbol} · ${metadata?.name} · treasury ${finalBalance / SHARE} shares`);
    }

    console.log('\nDeployment complete.');
    console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
    console.error(`Stock deployment failed: ${error.message}`);
    process.exitCode = 1;
});
