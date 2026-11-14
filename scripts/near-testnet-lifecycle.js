'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bs58 = require('bs58');
const { parseEnvText } = require('./app-config');

const DEPLOYER_ACCOUNT_ID = 'spellman.testnet';
const CONTRACT_ACCOUNT_ID = 'relay.spellman.testnet';
const TESTNET_RPC_URL = 'https://rpc.testnet.near.org';
const YOCTO_PER_NEAR = 10n ** 24n;
const TERA_GAS = 10n ** 12n;

const EXPECTED_CONTRACT_SHA256 = '2CB1AE95CDB0B6616D69A728BAD983093225A98B10526358BFE90AD9AD334B6F';
const EXPECTED_CONTROLLER_SHA256 = '762A821E16897303AB491E90E26F02FA466ED831008CE73C4EB27F3CB4F29242';
const EXPECTED_CONTROLLER_BYTE_LENGTH = 149993;

const DEFAULT_TEST_TOKEN_ID = 'relay-test-1';
const MINT_ATTACHED_DEPOSIT = 10n ** 22n; // 0.01 NEAR for storage stake buffer
const MINT_GAS = 50n * TERA_GAS;          // 50 TGas
const PROVISION_GAS = 150n * TERA_GAS;    // 150 TGas for atomic cross-contract batch + callback

function failure(message) {
    return new Error(message);
}

function formatNear(yocto) {
    const value = BigInt(yocto);
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const whole = absolute / YOCTO_PER_NEAR;
    const fraction = (absolute % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function computeBase58Sha256(bytes) {
    const raw = crypto.createHash('sha256').update(bytes).digest();
    return bs58.encode(raw);
}

async function viewMethod(provider, accountId, methodName, argsObj = {}) {
    const argsBase64 = Buffer.from(JSON.stringify(argsObj)).toString('base64');
    const response = await provider.sendJsonRpc('query', {
        request_type: 'call_function',
        account_id: accountId,
        method_name: methodName,
        args_base64: argsBase64,
        finality: 'final',
    });
    const utf8 = Buffer.from(response.result).toString('utf8');
    try {
        return JSON.parse(utf8);
    } catch {
        return utf8;
    }
}

async function runLifecyclePreflight(options = {}) {
    const rootDir = options.rootDir || path.resolve(__dirname, '..');
    const envPath = options.envPath || path.join(rootDir, '.env');
    const readFile = options.readFile || fs.readFileSync;
    const sdk = options.sdk || require('near-api-js');
    const tokenId = options.tokenId || DEFAULT_TEST_TOKEN_ID;

    let env;
    try {
        env = parseEnvText(readFile(envPath, 'utf8'));
    } catch {
        throw failure('Could not read valid local .env configuration.');
    }

    const privateKey = env.NEAR_PRIVATE_KEY;
    if (!privateKey) throw failure('NEAR_PRIVATE_KEY is missing from local .env.');
    if (!privateKey.startsWith('ed25519:')) throw failure('NEAR_PRIVATE_KEY must use ed25519 format.');

    const deployerId = env.NEAR_ACCOUNT_ID || DEPLOYER_ACCOUNT_ID;
    const contractId = env.RELAY_CONTRACT_ID || CONTRACT_ACCOUNT_ID;
    if (deployerId !== DEPLOYER_ACCOUNT_ID) throw failure(`Deployer must be ${DEPLOYER_ACCOUNT_ID}`);
    if (contractId !== CONTRACT_ACCOUNT_ID) throw failure(`Contract must be ${CONTRACT_ACCOUNT_ID}`);

    let signer;
    let publicKey;
    try {
        signer = sdk.KeyPairSigner.fromSecretKey(privateKey);
        publicKey = (await signer.getPublicKey()).toString();
    } catch {
        throw failure('Failed to initialize KeyPairSigner with configured private key.');
    }

    const rpcUrl = env.NEAR_RPC_URL || TESTNET_RPC_URL;
    const provider = new sdk.JsonRpcProvider({ url: rpcUrl });

    const status = await provider.viewNodeStatus();
    if (status.chain_id !== 'testnet') {
        throw failure(`Connected network is ${status.chain_id}, expected testnet.`);
    }

    // Check deployer
    const deployerAccount = await provider.viewAccount({
        accountId: deployerId,
        blockQuery: { finality: 'final' },
    });
    const accessKeyList = await provider.viewAccessKeyList({
        accountId: deployerId,
        finalityQuery: { finality: 'final' },
    });
    const hasFullAccess = (accessKeyList.keys || []).some(k =>
        k.public_key === publicKey &&
        (k.access_key?.permission === 'FullAccess' || k.access_key?.permission?.FullAccess !== undefined)
    );
    if (!hasFullAccess) throw failure(`Deployer ${deployerId} does not possess FullAccess key ${publicKey}`);

    // Check contract
    const contractAccount = await provider.viewAccount({
        accountId: contractId,
        blockQuery: { finality: 'final' },
    });

    // Check artifacts
    const contractWasmPath = path.join(rootDir, 'target', 'wasm32-unknown-unknown', 'release', 'relay_contract.wasm');
    const controllerWasmPath = path.join(rootDir, 'target', 'wasm32-unknown-unknown', 'release', 'relay_subaccount.wasm');
    const contractBytes = readFile(contractWasmPath);
    const controllerBytes = readFile(controllerWasmPath);

    const contractSha256 = crypto.createHash('sha256').update(contractBytes).digest('hex').toUpperCase();
    const controllerSha256 = crypto.createHash('sha256').update(controllerBytes).digest('hex').toUpperCase();

    if (contractSha256 !== EXPECTED_CONTRACT_SHA256) {
        throw failure(`Contract artifact SHA-256 mismatch: ${contractSha256}`);
    }
    if (controllerSha256 !== EXPECTED_CONTROLLER_SHA256) {
        throw failure(`Controller artifact SHA-256 mismatch: ${controllerSha256}`);
    }

    const expectedContractCodeHashBase58 = computeBase58Sha256(contractBytes);
    if (contractAccount.code_hash !== expectedContractCodeHashBase58) {
        throw failure(`On-chain contract code_hash (${contractAccount.code_hash}) does not match expected (${expectedContractCodeHashBase58})`);
    }

    // View contract metadata
    const metadata = await viewMethod(provider, contractId, 'nft_metadata');
    if (!metadata || metadata.name !== 'RELAY') {
        throw failure(`Contract metadata unexpected: ${JSON.stringify(metadata)}`);
    }

    // View controller code length
    const controllerLen = await viewMethod(provider, contractId, 'get_controller_code_len');
    if (Number(controllerLen) !== EXPECTED_CONTROLLER_BYTE_LENGTH) {
        throw failure(`Controller code length on-chain (${controllerLen}) does not match expected ${EXPECTED_CONTROLLER_BYTE_LENGTH}`);
    }

    // Minimum provisioning deposit
    const minProvisionYoctoStr = await viewMethod(provider, contractId, 'get_provision_minimum_deposit');
    const minProvisionDeposit = BigInt(minProvisionYoctoStr);

    // Verify token collision
    const existingToken = await viewMethod(provider, contractId, 'nft_token', { token_id: tokenId });
    if (existingToken !== null) {
        throw failure(`Token collision: token_id "${tokenId}" already exists on contract.`);
    }

    const canonicalSubaccountId = await viewMethod(provider, contractId, 'relay_canonical_account_id', { token_id: tokenId });
    if (canonicalSubaccountId !== `${tokenId}.${contractId}`) {
        throw failure(`Canonical subaccount derivation mismatch: expected ${tokenId}.${contractId}, got ${canonicalSubaccountId}`);
    }

    let subaccountExists = true;
    try {
        await provider.viewAccount({
            accountId: canonicalSubaccountId,
            blockQuery: { finality: 'final' },
        });
    } catch (err) {
        if (err?.name === 'AccountDoesNotExistError') {
            subaccountExists = false;
        } else {
            throw err;
        }
    }
    if (subaccountExists) {
        throw failure(`Canonical subaccount "${canonicalSubaccountId}" already exists on Testnet.`);
    }

    // Balance check
    const totalDepositRequired = MINT_ATTACHED_DEPOSIT + minProvisionDeposit;
    const maxGasNear = (MINT_GAS + PROVISION_GAS) * 100000000n; // 100M yocto per gas
    const totalMaxSpendYocto = totalDepositRequired + maxGasNear;

    const liquidDeployerYocto = BigInt(deployerAccount.amount);
    if (liquidDeployerYocto < totalMaxSpendYocto) {
        throw failure(`Insufficient liquid balance on ${deployerId}. Have ${formatNear(liquidDeployerYocto)} NEAR, need ${formatNear(totalMaxSpendYocto)} NEAR`);
    }

    return {
        network: status.chain_id,
        deployer: {
            accountId: deployerId,
            publicKey,
            liquidBalanceNear: formatNear(liquidDeployerYocto),
            hasFullAccess,
        },
        contract: {
            accountId: contractId,
            codeHash: contractAccount.code_hash,
            metadata,
            controllerCodeLength: Number(controllerLen),
            ownerStatus: 'verified_via_deployment_and_controller_storage',
        },
        token: {
            tokenId,
            recipient: deployerId,
            canonicalSubaccountId,
            subaccountExists,
            tokenCollision: false,
        },
        finances: {
            mintDepositNear: formatNear(MINT_ATTACHED_DEPOSIT),
            mintDepositYocto: MINT_ATTACHED_DEPOSIT.toString(),
            provisionDepositNear: formatNear(minProvisionDeposit),
            provisionDepositYocto: minProvisionDeposit.toString(),
            totalDepositNear: formatNear(totalDepositRequired),
            maxGasEstimateNear: formatNear(maxGasNear),
            maxSpendNear: formatNear(totalMaxSpendYocto),
        },
        readyToExecute: true,
    };
}

function buildExecutionPlan(preflight) {
    return {
        tokenId: preflight.token.tokenId,
        ownerAccountId: preflight.token.recipient,
        canonicalSubaccountId: preflight.token.canonicalSubaccountId,
        contractAccountId: preflight.contract.accountId,
        network: preflight.network,
        steps: [
            {
                step: 1,
                action: 'relay_mint',
                receiver: preflight.contract.accountId,
                signer: preflight.deployer.accountId,
                args: {
                    token_id: preflight.token.tokenId,
                    token_owner_id: preflight.token.recipient,
                    token_metadata: {
                        title: `RELAY Test NFT (${preflight.token.tokenId})`,
                        description: 'First real NEAR Testnet NFT and canonical subaccount lifecycle verification',
                        copies: 1,
                    },
                    associated_account_id: preflight.token.canonicalSubaccountId,
                    initial_credits: 3,
                },
                depositNear: preflight.finances.mintDepositNear,
                gasTgas: '50',
            },
            {
                step: 2,
                action: 'relay_provision_subaccount',
                receiver: preflight.contract.accountId,
                signer: preflight.deployer.accountId,
                args: {
                    token_id: preflight.token.tokenId,
                },
                depositNear: preflight.finances.provisionDepositNear,
                gasTgas: '150',
            },
        ],
        financials: {
            mintDepositNear: preflight.finances.mintDepositNear,
            provisionDepositNear: preflight.finances.provisionDepositNear,
            totalDepositNear: preflight.finances.totalDepositNear,
            maxGasNear: preflight.finances.maxGasEstimateNear,
            totalMaxSpendNear: preflight.finances.maxSpendNear,
            deployerAvailableNear: preflight.deployer.liquidBalanceNear,
        },
    };
}

async function executeLifecycle(options = {}) {
    if (!options.approved) {
        throw failure('Explicit user approval is required before state-changing execution.');
    }

    const preflight = await runLifecyclePreflight(options);
    const plan = buildExecutionPlan(preflight);

    const rootDir = options.rootDir || path.resolve(__dirname, '..');
    const envPath = options.envPath || path.join(rootDir, '.env');
    const readFile = options.readFile || fs.readFileSync;
    const sdk = options.sdk || require('near-api-js');

    const env = parseEnvText(readFile(envPath, 'utf8'));
    const privateKey = env.NEAR_PRIVATE_KEY;
    const signer = sdk.KeyPairSigner.fromSecretKey(privateKey);
    const provider = new sdk.JsonRpcProvider({ url: env.NEAR_RPC_URL || TESTNET_RPC_URL });
    const account = new sdk.Account(preflight.deployer.accountId, provider, signer);

    const results = {
        plan,
        mintTx: null,
        provisionTx: null,
        onChainVerifications: {},
    };

    // -----------------------------------------------------------------------
    // STEP 1: Mint NFT
    // -----------------------------------------------------------------------
    const mintStep = plan.steps[0];
    const mintArgs = Buffer.from(JSON.stringify(mintStep.args));
    const mintDeposit = BigInt(preflight.finances.mintDepositYocto);

    const mintResult = await account.signAndSendTransaction({
        receiverId: mintStep.receiver,
        actions: [
            sdk.actions.functionCall('relay_mint', mintArgs, MINT_GAS, mintDeposit),
        ],
    });

    results.mintTx = mintResult?.transaction?.hash || mintResult?.transaction_outcome?.id;
    for (const ro of (mintResult?.receipts_outcome || [])) {
        if (ro?.outcome?.status?.Failure) {
            throw failure(`Mint receipt failed: ${JSON.stringify(ro.outcome.status.Failure)}`);
        }
    }

    // Verify mint on chain
    const mintedToken = await viewMethod(provider, preflight.contract.accountId, 'nft_token', { token_id: plan.tokenId });
    if (!mintedToken || mintedToken.owner_id !== plan.ownerAccountId) {
        throw failure(`On-chain token verification failed after mint: ${JSON.stringify(mintedToken)}`);
    }

    const initialBinding = await viewMethod(provider, preflight.contract.accountId, 'relay_account_binding', { token_id: plan.tokenId });
    if (!initialBinding || initialBinding.account_id !== plan.canonicalSubaccountId || initialBinding.is_verified !== false) {
        throw failure(`Initial binding verification failed: ${JSON.stringify(initialBinding)}`);
    }

    results.onChainVerifications.postMint = {
        token: mintedToken,
        binding: initialBinding,
    };

    // -----------------------------------------------------------------------
    // STEP 2: Provision Canonical Subaccount
    // -----------------------------------------------------------------------
    const provStep = plan.steps[1];
    const provArgs = Buffer.from(JSON.stringify(provStep.args));
    const provDeposit = BigInt(preflight.finances.provisionDepositYocto);

    const provResult = await account.signAndSendTransaction({
        receiverId: provStep.receiver,
        actions: [
            sdk.actions.functionCall('relay_provision_subaccount', provArgs, PROVISION_GAS, provDeposit),
        ],
    });

    results.provisionTx = provResult?.transaction?.hash || provResult?.transaction_outcome?.id;
    for (const ro of (provResult?.receipts_outcome || [])) {
        if (ro?.outcome?.status?.Failure) {
            throw failure(`Provision receipt failed: ${JSON.stringify(ro.outcome.status.Failure)}`);
        }
    }

    // Wait a brief moment for finality
    await new Promise(resolve => setTimeout(resolve, 3000));

    // -----------------------------------------------------------------------
    // STEP 3: Post-Provision Verification
    // -----------------------------------------------------------------------
    // Verify parent contract binding
    const finalBinding = await viewMethod(provider, preflight.contract.accountId, 'relay_account_binding', { token_id: plan.tokenId });
    const finalProvState = await viewMethod(provider, preflight.contract.accountId, 'relay_provisioning_state', { token_id: plan.tokenId });
    const lifecycle = await viewMethod(provider, preflight.contract.accountId, 'token_lifecycle', { token_id: plan.tokenId });

    if (!finalBinding?.is_verified) {
        throw failure(`Post-provision binding is not verified: ${JSON.stringify(finalBinding)}`);
    }
    if (finalProvState !== 'Completed') {
        throw failure(`Post-provision state is not Completed: ${JSON.stringify(finalProvState)}`);
    }

    // Verify subaccount directly on chain
    const subaccountState = await provider.viewAccount({
        accountId: plan.canonicalSubaccountId,
        blockQuery: { finality: 'final' },
    });
    const subaccountKeys = await provider.viewAccessKeyList({
        accountId: plan.canonicalSubaccountId,
        finalityQuery: { finality: 'final' },
    });

    // Verify subaccount controller view methods
    const controllerState = await viewMethod(provider, plan.canonicalSubaccountId, 'get_controller_state');
    const nativeBal = await viewMethod(provider, plan.canonicalSubaccountId, 'get_native_balance');

    // Verify credits
    const credits = await viewMethod(provider, preflight.contract.accountId, 'relay_credits', { token_id: plan.tokenId });

    // Verify balances
    const deployerFinal = await provider.viewAccount({
        accountId: preflight.deployer.accountId,
        blockQuery: { finality: 'final' },
    });
    const contractFinal = await provider.viewAccount({
        accountId: preflight.contract.accountId,
        blockQuery: { finality: 'final' },
    });

    results.onChainVerifications.postProvision = {
        token: mintedToken,
        binding: finalBinding,
        provisioningState: finalProvState,
        lifecycle,
        credits,
        subaccount: {
            accountId: plan.canonicalSubaccountId,
            amountNear: formatNear(subaccountState.amount),
            storageUsageBytes: subaccountState.storage_usage,
            codeHash: subaccountState.code_hash,
            accessKeyCount: (subaccountKeys.keys || []).length,
            controllerState,
            nativeBalanceNear: formatNear(nativeBal),
        },
        balances: {
            deployerInitialNear: preflight.deployer.liquidBalanceNear,
            deployerFinalNear: formatNear(deployerFinal.amount),
            contractFinalNear: formatNear(contractFinal.amount),
            subaccountNear: formatNear(subaccountState.amount),
        },
    };

    return results;
}

async function main() {
    const isExecute = process.argv.includes('--execute');
    console.log('=== RELAY Testnet Lifecycle Preflight & Planning ===\n');

    const preflight = await runLifecyclePreflight();
    const plan = buildExecutionPlan(preflight);

    console.log('--- Read-Only Preflight Status ---');
    console.log(`Network:             ${preflight.network} (verified)`);
    console.log(`Deployer:            ${preflight.deployer.accountId}`);
    console.log(`Deployer Balance:    ${preflight.deployer.liquidBalanceNear} NEAR`);
    console.log(`Contract:            ${preflight.contract.accountId}`);
    console.log(`Contract Code Hash:  ${preflight.contract.codeHash}`);
    console.log(`Controller Code Len: ${preflight.contract.controllerCodeLength} bytes (expected 149993)`);
    console.log(`NFT Spec/Name:       ${preflight.contract.metadata.spec} / ${preflight.contract.metadata.name}`);
    console.log(`Target Token ID:     ${plan.tokenId}`);
    console.log(`Canonical Account:   ${plan.canonicalSubaccountId}`);
    console.log(`Token Exists:        ${preflight.token.tokenCollision ? 'YES (COLLISION)' : 'NO (AVAILABLE)'}`);
    console.log(`Subaccount Exists:   ${preflight.token.subaccountExists ? 'YES (COLLISION)' : 'NO (AVAILABLE)'}\n`);

    console.log('--- Proposed Execution Plan ---');
    console.log(`1. Mint NFT:`);
    console.log(`   Method:    ${plan.steps[0].action}`);
    console.log(`   Token ID:  ${plan.steps[0].args.token_id}`);
    console.log(`   Recipient: ${plan.steps[0].args.token_owner_id}`);
    console.log(`   Deposit:   ${plan.steps[0].depositNear} NEAR`);
    console.log(`   Gas:       ${plan.steps[0].gasTgas} TGas`);
    console.log(`2. Provision Canonical Subaccount:`);
    console.log(`   Method:    ${plan.steps[1].action}`);
    console.log(`   Subaccount:${plan.canonicalSubaccountId}`);
    console.log(`   Deposit:   ${plan.steps[1].depositNear} NEAR (exact minimum required)`);
    console.log(`   Gas:       ${plan.steps[1].gasTgas} TGas\n`);

    console.log('--- Financial Breakdown ---');
    console.log(`Mint Storage Deposit:    ${plan.financials.mintDepositNear} NEAR`);
    console.log(`Provisioning Deposit:    ${plan.financials.provisionDepositNear} NEAR`);
    console.log(`Total Attached Deposits: ${plan.financials.totalDepositNear} NEAR`);
    console.log(`Maximum Gas Estimate:    ${plan.financials.maxGasNear} NEAR`);
    console.log(`Total Maximum Spend:     ${plan.financials.totalMaxSpendNear} NEAR`);
    console.log(`Deployer Available:      ${plan.financials.deployerAvailableNear} NEAR\n`);

    if (!isExecute) {
        console.log('========================================================================');
        console.log('  STATUS: DRY-RUN COMPLETED SAFELY');
        console.log('  No state-changing transactions were submitted to NEAR Testnet.');
        console.log('  Awaiting explicit user approval before execution.');
        console.log('========================================================================');
        return;
    }

    console.log('--- Executing Authorized Plan on NEAR Testnet ---');
    const result = await executeLifecycle({ approved: true });
    console.log(`Mint Transaction:      ${result.mintTx}`);
    console.log(`Provision Transaction: ${result.provisionTx}`);
    console.log('\n--- Finalized Verification ---');
    console.log(JSON.stringify(result.onChainVerifications, null, 2));
    console.log('\n=== Lifecycle Successfully Completed & Verified On-Chain ===');
}

if (require.main === module) {
    main().catch(err => {
        console.error(`\nLIFECYCLE ERROR: ${err.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULT_TEST_TOKEN_ID,
    MINT_ATTACHED_DEPOSIT,
    PROVISION_GAS,
    MINT_GAS,
    runLifecyclePreflight,
    buildExecutionPlan,
    executeLifecycle,
    formatNear,
};
