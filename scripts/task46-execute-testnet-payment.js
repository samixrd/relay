'use strict';
/**
 * Task 46 — Execute Real NEAR Testnet Payment
 *
 * Submits a real relay_execute_subaccount → TransferNear transaction on NEAR Testnet
 * using the OWNER_B_PRIVATE_KEY from .env.
 *
 * Signer:    relay-owner-b.spellman.testnet  (current NFT owner)
 * Contract:  relay.spellman.testnet           (parent relay contract)
 * Method:    relay_execute_subaccount
 * Action:    TransferNear { receiver_id: spellman.testnet, amount: 10 NEAR yN (0.01 NEAR) }
 * Gas:       100 TGas
 * Deposit:   0 yoctoNEAR
 *
 * NEVER prints private keys or seed phrases.
 * NEVER submits Mainnet transactions.
 * Always verifies ownership and lifecycle before submitting.
 */

const path = require('node:path');
const { parseEnvText } = require('./app-config');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const TESTNET_RPC_URL = 'https://rpc.testnet.near.org';
const RELAY_CONTRACT_ID = 'relay.spellman.testnet';
const TOKEN_ID = 'relay-test-1';
const EXPECTED_OWNER = 'relay-owner-b.spellman.testnet';
const RECEIVER_ID = 'spellman.testnet';
const AMOUNT_YOCTO = '10000000000000000000000'; // 0.01 NEAR
const AMOUNT_NEAR = '0.01';
const GAS = '100000000000000'; // 100 TGas
const DEPOSIT = '0';
const EXPLORER_BASE = 'https://testnet.nearblocks.io/txns';

const YOCTO_PER_NEAR = 10n ** 24n;

function formatNear(yocto) {
    const v = BigInt(yocto);
    const whole = v / YOCTO_PER_NEAR;
    const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
    return `${whole}${frac ? `.${frac}` : ''} NEAR`;
}

async function rpc(method, params) {
    const res = await globalThis.fetch(TESTNET_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`RPC error (${method}): ${JSON.stringify(json.error)}`);
    return json.result;
}

async function viewAccount(accountId) {
    const block = await rpc('block', { finality: 'final' });
    const result = await rpc('query', {
        request_type: 'view_account',
        account_id: accountId,
        block_id: block.header.hash,
    });
    return { blockHash: block.header.hash, blockHeight: block.header.height, ...result };
}

async function viewCall(contractId, method, args, blockHash) {
    const block = blockHash ? { block_id: blockHash } : { finality: 'final' };
    const result = await rpc('query', {
        request_type: 'call_function',
        account_id: contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        ...block,
    });
    return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

async function main() {
    // Load env — never print private key
    let env;
    try {
        env = parseEnvText(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
    } catch {
        throw new Error('Could not read .env file.');
    }

    const ownerBKey = env.OWNER_B_PRIVATE_KEY;
    if (!ownerBKey) throw new Error('OWNER_B_PRIVATE_KEY not found in .env');
    // Confirm we are on testnet
    if (env.NEAR_NETWORK && env.NEAR_NETWORK !== 'testnet') {
        throw new Error(`NEAR_NETWORK is '${env.NEAR_NETWORK}', expected 'testnet'. Refusing to submit.`);
    }

    // ── Phase 1: Verify on-chain state before submitting ──────────────────────
    console.log('\n═══ Phase 1: Pre-flight on-chain verification ═══\n');

    // Verify network is testnet
    const status = await rpc('status', []);
    if (status.chain_id !== 'testnet') {
        throw new Error(`RPC chain_id is '${status.chain_id}', expected 'testnet'. Refusing to submit.`);
    }
    console.log(`✅ NEAR network: ${status.chain_id}`);

    // Fetch current NFT state
    const block = await rpc('block', { finality: 'final' });
    const blockHash = block.header.hash;
    const blockHeight = block.header.height;
    console.log(`✅ Finalized block: ${blockHeight} (${blockHash.substring(0, 10)}...)`);

    const nftToken = await viewCall(RELAY_CONTRACT_ID, 'nft_token', { token_id: TOKEN_ID }, blockHash);
    if (!nftToken) throw new Error(`Token '${TOKEN_ID}' does not exist on ${RELAY_CONTRACT_ID}`);
    if (nftToken.owner_id !== EXPECTED_OWNER) {
        throw new Error(`NFT owner is '${nftToken.owner_id}', expected '${EXPECTED_OWNER}'. Refusing to submit.`);
    }
    console.log(`✅ NFT owner: ${nftToken.owner_id}`);

    const lifecycle = await viewCall(RELAY_CONTRACT_ID, 'token_lifecycle', { token_id: TOKEN_ID }, blockHash);
    console.log(`✅ Lifecycle: ${JSON.stringify(lifecycle)}`);
    if (lifecycle !== 'Unlocked' && !(typeof lifecycle === 'object' && Object.keys(lifecycle)[0] === 'Unlocked')) {
        throw new Error(`Lifecycle is not Unlocked: ${JSON.stringify(lifecycle)}`);
    }

    // Check binding
    const binding = await viewCall(RELAY_CONTRACT_ID, 'relay_binding', { token_id: TOKEN_ID }, blockHash).catch(() => null);
    const associatedAccountId = binding?.account_id || `${TOKEN_ID}.${RELAY_CONTRACT_ID}`;
    console.log(`✅ Associated account: ${associatedAccountId}`);

    // Check balances
    const assocState = await viewAccount(associatedAccountId);
    const assocBalance = BigInt(assocState.amount);
    const spendable = assocBalance - BigInt(assocState.storage_usage) * 10n ** 19n - 100n * 10n ** 21n; // rough estimate
    console.log(`✅ Subaccount balance: ${formatNear(assocBalance)}`);

    const receiverBefore = await viewAccount(RECEIVER_ID);
    const receiverBalanceBefore = BigInt(receiverBefore.amount);
    console.log(`✅ Receiver (${RECEIVER_ID}) balance before: ${formatNear(receiverBalanceBefore)}`);

    const amountYocto = BigInt(AMOUNT_YOCTO);
    if (amountYocto > assocBalance) {
        throw new Error(`Amount ${formatNear(amountYocto)} exceeds subaccount balance ${formatNear(assocBalance)}`);
    }

    // ── Phase 2: Print transaction plan ───────────────────────────────────────
    console.log('\n═══ Phase 2: Transaction Plan ═══\n');
    console.log(`  Signer:    ${EXPECTED_OWNER}`);
    console.log(`  Contract:  ${RELAY_CONTRACT_ID}`);
    console.log(`  Method:    relay_execute_subaccount`);
    console.log(`  Args:      { token_id: "${TOKEN_ID}", action: { TransferNear: { receiver_id: "${RECEIVER_ID}", amount: "${AMOUNT_YOCTO}" } } }`);
    console.log(`  Gas:       ${GAS} (100 TGas)`);
    console.log(`  Deposit:   ${DEPOSIT} yoctoNEAR`);
    console.log(`  Amount:    ${AMOUNT_NEAR} NEAR (${AMOUNT_YOCTO} yocto)`);
    console.log(`  Receiver:  ${RECEIVER_ID}`);
    console.log('\n⚠️  NEAR Testnet ONLY. No monetary value. Submitting now...\n');

    // ── Phase 3: Load SDK and submit transaction ───────────────────────────────
    console.log('═══ Phase 3: Signing and submitting ═══\n');
    const sdk = require('near-api-js');
    let signer;
    try {
        signer = sdk.KeyPairSigner.fromSecretKey(ownerBKey);
        const pubKey = (await signer.getPublicKey()).toString();
        console.log(`✅ Signer public key loaded: ${pubKey.substring(0, 20)}...`);
    } catch (e) {
        throw new Error('Could not load OWNER_B_PRIVATE_KEY: ' + e.message);
    }

    const provider = new sdk.JsonRpcProvider({ url: TESTNET_RPC_URL });
    const account = new sdk.Account(EXPECTED_OWNER, provider, signer);

    console.log('Submitting relay_execute_subaccount → TransferNear...');
    let txResult;
    try {
        txResult = await account.signAndSendTransaction({
            receiverId: RELAY_CONTRACT_ID,
            actions: [
                sdk.actions.functionCall(
                    'relay_execute_subaccount',
                    {
                        token_id: TOKEN_ID,
                        action: {
                            TransferNear: {
                                receiver_id: RECEIVER_ID,
                                amount: AMOUNT_YOCTO,
                            },
                        },
                    },
                    BigInt(GAS),
                    BigInt(DEPOSIT)
                ),
            ],
        });
    } catch (e) {
        throw new Error('Transaction submission failed: ' + e.message);
    }

    // ── Phase 4: Verify outcome ────────────────────────────────────────────────
    console.log('\n═══ Phase 4: Verifying finalized outcome ═══\n');

    // Extract tx hash from result
    let txHash;
    if (txResult?.transaction?.hash) {
        txHash = txResult.transaction.hash;
    } else if (txResult?.transaction_outcome?.id) {
        txHash = txResult.transaction_outcome.id;
    } else {
        console.log('RAW RESULT:', JSON.stringify(txResult, null, 2));
        throw new Error('Could not extract transaction hash from result');
    }

    console.log(`✅ Transaction hash: ${txHash}`);
    console.log(`✅ Explorer link: ${EXPLORER_BASE}/${txHash}`);

    // Check receipt outcomes for failures
    const receiptOutcomes = txResult.receipts_outcome || [];
    for (const ro of receiptOutcomes) {
        const status = ro.outcome?.status;
        if (status && typeof status === 'object' && status.Failure) {
            console.error('❌ Receipt failure:', JSON.stringify(status.Failure, null, 2));
            throw new Error('A receipt failed: ' + JSON.stringify(status.Failure));
        }
    }
    console.log(`✅ All ${receiptOutcomes.length} receipt(s) succeeded`);

    // Wait a moment for finalization, then check receiver balance
    console.log('Waiting 3s for finalization before balance check...');
    await new Promise(r => setTimeout(r, 3000));

    const receiverAfter = await viewAccount(RECEIVER_ID);
    const receiverBalanceAfter = BigInt(receiverAfter.amount);
    const delta = receiverBalanceAfter - receiverBalanceBefore;

    console.log(`✅ Receiver (${RECEIVER_ID}) balance after:  ${formatNear(receiverBalanceAfter)}`);
    console.log(`✅ Balance delta: +${formatNear(delta)}`);

    if (delta < amountYocto) {
        console.warn(`⚠️  Balance delta (${formatNear(delta)}) is less than expected (${formatNear(amountYocto)}). Check gas refunds.`);
    } else {
        console.log(`✅ Balance increase confirmed: ${formatNear(delta)} ≥ ${formatNear(amountYocto)}`);
    }

    // ── Phase 5: Final Summary ─────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  NEAR TESTNET PAYMENT — VERIFIED EXECUTION RECORD');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Tx Hash:        ${txHash}`);
    console.log(`  Explorer:       ${EXPLORER_BASE}/${txHash}`);
    console.log(`  Signer:         ${EXPECTED_OWNER}`);
    console.log(`  Contract:       ${RELAY_CONTRACT_ID}`);
    console.log(`  Method:         relay_execute_subaccount → TransferNear`);
    console.log(`  Subaccount:     ${associatedAccountId}`);
    console.log(`  Receiver:       ${RECEIVER_ID}`);
    console.log(`  Amount:         ${AMOUNT_NEAR} NEAR (${AMOUNT_YOCTO} yocto)`);
    console.log(`  Balance Before: ${formatNear(receiverBalanceBefore)}`);
    console.log(`  Balance After:  ${formatNear(receiverBalanceAfter)}`);
    console.log(`  Delta:          +${formatNear(delta)}`);
    console.log(`  Block:          ${blockHeight}`);
    console.log(`  Receipts:       ${receiptOutcomes.length} succeeded`);
    console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch(e => {
    console.error('\n❌ FATAL:', e.message);
    process.exitCode = 1;
});
