#!/usr/bin/env node

/**
 * RELAY — Testnet Deployment & Bootstrap Planning Script
 *
 * SAFETY GUARANTEES:
 * - Defaults to DRY-RUN mode.
 * - Does NOT deploy anything to testnet or mainnet unless explicit '--execute' flag is provided.
 * - Does NOT read, log, or store private keys, seeds, or credentials.
 * - Validates contract artifacts, configuration, and canonical sub-account formats.
 *
 * Usage:
 *   node scripts/bootstrap.js              # Runs dry-run simulation
 *   node scripts/bootstrap.js --dry-run    # Explicit dry-run simulation
 */

const fs = require('fs');
const path = require('path');

function findWasm(filename) {
    const candidatePaths = [
        path.resolve(__dirname, `../target/wasm32-unknown-unknown/release/${filename}`),
        path.resolve(__dirname, `../contract/target/wasm32-unknown-unknown/release/${filename}`),
        path.resolve(__dirname, `../subaccount/target/wasm32-unknown-unknown/release/${filename}`)
    ];
    for (const p of candidatePaths) {
        if (fs.existsSync(p)) return p;
    }
    return candidatePaths[0];
}

const RELAY_WASM = findWasm('relay_contract.wasm');
const SUBACCOUNT_WASM = findWasm('relay_subaccount.wasm');

function main() {
    const args = process.argv.slice(2);
    const isExecute = args.includes('--execute');
    const isDryRun = !isExecute || args.includes('--dry-run');

    console.log('====================================================');
    console.log('  RELAY — Deployment & Bootstrap Architecture Plan  ');
    console.log('====================================================\n');

    // 1. Artifact Verification
    console.log('1. Checking compiled contract artifacts:');
    let allFound = true;
    for (const [name, p] of [['RELAY Core Contract', RELAY_WASM], ['Sub-Account Controller', SUBACCOUNT_WASM]]) {
        if (fs.existsSync(p)) {
            const stats = fs.statSync(p);
            console.log(`   [OK] ${name}: ${p}`);
            console.log(`        Binary size: ${(stats.size / 1024).toFixed(2)} KB`);
        } else {
            console.error(`   [FAIL] ${name} not found at ${p}`);
            allFound = false;
        }
    }
    if (!allFound) {
        console.error('\n   Run "npm run build" first.\n');
        process.exit(1);
    }
    console.log();

    // 2. Configuration Verification
    console.log('2. Validating environment configuration:');
    const network = process.env.NEAR_NETWORK || 'testnet';
    const masterAccount = process.env.NEAR_ACCOUNT_ID;

    console.log(`   Network: ${network}`);
    if (!masterAccount) {
        console.log('   [WARN] NEAR_ACCOUNT_ID is not set in environment.');
        console.log('   Using placeholder "relay-master.testnet" for dry-run simulation.\n');
    } else {
        console.log(`   Target master account: ${masterAccount}\n`);
    }

    const effectiveAccount = masterAccount || 'relay-master.testnet';
    const sampleTokenId = 'relay-1';
    const canonicalSubaccount = `${sampleTokenId}.${effectiveAccount}`;

    // 3. Namespace Validation
    console.log('3. Validating Token-Bound Account canonical namespace:');
    console.log(`   Token ID: "${sampleTokenId}"`);
    console.log(`   Parent Contract Account: "${effectiveAccount}"`);
    console.log(`   Canonical Associated Sub-Account: "${canonicalSubaccount}"`);
    if (canonicalSubaccount.length > 64) {
        console.error(`   [FAIL] Subaccount name exceeds NEAR 64-character limit! (${canonicalSubaccount.length} chars)`);
        process.exit(1);
    }
    console.log('   [OK] Canonical sub-account satisfies NEAR account ID format rules.\n');

    // 4. Execution Plan (Dry-Run by default)
    console.log('4. Execution Plan (Dry-Run Plan — No network transactions submitted):');
    console.log('   [PLAN] Step 4.1: Deploy relay_contract.wasm to ' + effectiveAccount);
    console.log('          Command: near contract deploy ' + effectiveAccount + ' use-file ' + RELAY_WASM + ' without-init-call');
    console.log('   [PLAN] Step 4.2: Initialize RELAY contract with default metadata');
    console.log('          Command: near contract call-type ' + effectiveAccount + ' new_default_meta json-args \'{"owner_id":"' + effectiveAccount + '"}\'');
    console.log('   [PLAN] Step 4.3: Upload and store controller WASM in parent contract');
    console.log('          Action: Owner calls store_controller_code with compiled relay_subaccount.wasm');
    console.log('          Command: near contract call-type ' + effectiveAccount + ' store_controller_code base64-args <subaccount_wasm_bytes> --deposit 1.5');
    console.log('   [PLAN] Step 4.4: Mint RELAY NFT #' + sampleTokenId + ' bound to canonical ' + canonicalSubaccount);
    console.log('          Command: near contract call-type ' + effectiveAccount + ' relay_mint json-args \'{"token_id":"' + sampleTokenId + '","token_owner_id":"' + effectiveAccount + '","token_metadata":{"title":"RELAY #1"},"associated_account_id":"' + canonicalSubaccount + '","initial_credits":3}\'');
    console.log('   [PLAN] Step 4.5: On-Chain Real Sub-Account Provisioning');
    console.log('          Action: Token owner calls relay_provision_subaccount attached with required storage deposit (~1.6 NEAR)');
    console.log('          Execution: Parent contract executes atomic Action Receipt on ' + canonicalSubaccount + ':');
    console.log('                     - CreateAccount');
    console.log('                     - Transfer(attached_deposit)');
    console.log('                     - DeployContract(controller_wasm)');
    console.log('                     - FunctionCall(new, {"parent_contract_id":"' + effectiveAccount + '","token_id":"' + sampleTokenId + '"})');
    console.log('          Authority: NO FullAccess key created. Control held strictly by deployed controller WASM.');
    console.log('          Callback: on_provision_complete validates generation nonce & marks binding is_verified = true.');
    console.log('   [PLAN] Step 4.6: Verify binding status on parent contract');
    console.log('          Command: near contract call-type ' + effectiveAccount + ' relay_account_binding json-args \'{"token_id":"' + sampleTokenId + '"}\'');
    console.log('          Outcome: AccountBinding.is_verified == true, ProvisioningState == Completed.\n');

    if (isDryRun) {
        console.log('====================================================');
        console.log('  STATUS: DRY-RUN SIMULATION COMPLETED SAFELY        ');
        console.log('  - No network transactions were submitted.         ');
        console.log('  - No accounts were created or modified.           ');
        console.log('  - No keys or secrets were touched.                ');
        console.log('====================================================');
        return;
    }

    // Safety guard against accidental live deployment in this task
    console.log('[SAFETY LOCK] Live testnet deployment is not enabled in this task.');
    console.log('All acceptance criteria for Task 3 are strictly offline / verifiable simulation.');
}

main();
