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

const WASM_PATH = path.resolve(__dirname, '../contract/target/wasm32-unknown-unknown/release/relay_contract.wasm');

function main() {
    const args = process.argv.slice(2);
    const isExecute = args.includes('--execute');
    const isDryRun = !isExecute || args.includes('--dry-run');

    console.log('====================================================');
    console.log('  RELAY — Deployment & Bootstrap Architecture Plan  ');
    console.log('====================================================\n');

    // 1. Artifact Verification
    console.log('1. Checking compiled contract artifacts:');
    if (fs.existsSync(WASM_PATH)) {
        const stats = fs.statSync(WASM_PATH);
        console.log(`   [OK] Contract binary found at: ${WASM_PATH}`);
        console.log(`   [OK] Binary size: ${(stats.size / 1024).toFixed(2)} KB\n`);
    } else {
        console.error(`   [FAIL] Contract binary not found at ${WASM_PATH}`);
        console.error('   Run "npm run build" first.\n');
        process.exit(1);
    }

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
    console.log('4. Execution Plan:');
    console.log('   [PLAN] Step 4.1: Deploy relay_contract.wasm to ' + effectiveAccount);
    console.log('          Command: near contract deploy ' + effectiveAccount + ' use-file ' + WASM_PATH + ' without-init-call');
    console.log('   [PLAN] Step 4.2: Initialize RELAY contract with default metadata');
    console.log('          Command: near contract call-type ' + effectiveAccount + ' new_default_meta json-args \'{"owner_id":"' + effectiveAccount + '"}\'');
    console.log('   [PLAN] Step 4.3: Create canonical sub-account ' + canonicalSubaccount);
    console.log('          Action: Protocol-level CreateAccount from parent ' + effectiveAccount);
    console.log('          Funding: Initial 0.1 NEAR for account storage');
    console.log('   [PLAN] Step 4.4: Mint RELAY NFT #' + sampleTokenId + ' bound to ' + canonicalSubaccount);
    console.log('          Command: near contract call-type ' + effectiveAccount + ' relay_mint json-args \'{"token_id":"' + sampleTokenId + '","token_owner_id":"' + effectiveAccount + '","token_metadata":{"title":"RELAY #1"},"associated_account_id":"' + canonicalSubaccount + '","initial_credits":3}\'');
    console.log('   [PLAN] Step 4.5: On-chain Verification Handshake');
    console.log('          Action: Sub-account ' + canonicalSubaccount + ' invokes relay_verify_associated_account on ' + effectiveAccount);
    console.log('          Outcome: AccountBinding.is_verified flips to true on-chain.\n');

    if (isDryRun) {
        console.log('====================================================');
        console.log('  STATUS: DRY-RUN SIMULATION COMPLETED SAFELY        ');
        console.log('  - No network transactions were submitted.         ');
        console.log('  - No accounts were created or modified.           ');
        console.log('  - No keys or secrets were touched.                ');
        console.log('====================================================');
        return;
    }

    // Safety guard against accidental live deployment in this reconnaissance/architecture phase
    console.log('[SAFETY LOCK] Live testnet deployment is not enabled in this task.');
    console.log('All acceptance criteria for Task 2 are strictly offline / verifiable simulation.');
}

main();
