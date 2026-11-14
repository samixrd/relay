'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseEnvText } = require('./app-config');

const DEPLOYER_ACCOUNT_ID = 'spellman.testnet';
const TARGET_ACCOUNT_ID = 'relay.spellman.testnet';
const TESTNET_RPC_URL = 'https://rpc.testnet.near.org';
const EXPECTED_ARTIFACTS = Object.freeze({
    contract: '2CB1AE95CDB0B6616D69A728BAD983093225A98B10526358BFE90AD9AD334B6F',
    controller: '762A821E16897303AB491E90E26F02FA466ED831008CE73C4EB27F3CB4F29242',
});
const YOCTO_PER_NEAR = 10n ** 24n;
const TERA_GAS = 10n ** 12n;

function failure(message) {
    return new Error(message);
}

function toBigInt(value, label) {
    try {
        return BigInt(value);
    } catch {
        throw failure(`Testnet RPC returned invalid ${label}.`);
    }
}

function formatNear(yocto) {
    const value = BigInt(yocto);
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const whole = absolute / YOCTO_PER_NEAR;
    const fraction = (absolute % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function isFullAccess(permission) {
    return permission === 'FullAccess' ||
        (permission && typeof permission === 'object' && Object.hasOwn(permission, 'FullAccess'));
}

function cleanRpcUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw failure('NEAR_RPC_URL is invalid.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw failure('NEAR_RPC_URL must be an HTTPS URL without credentials, query, or fragment.');
    }
    return url;
}

function readArtifact(rootDir, relativePath, name) {
    const artifactPath = path.join(rootDir, relativePath);
    let bytes;
    try {
        bytes = fs.readFileSync(artifactPath);
    } catch {
        throw failure(`The ${name} WASM artifact is unavailable.`);
    }
    return {
        path: relativePath.replaceAll(path.sep, '/'),
        bytes: bytes.length,
        jsonCodeArgumentBytes: name === 'controller' ? jsonVecArgumentBytes(bytes) : null,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(),
    };
}

function jsonVecArgumentBytes(bytes) {
    let length = Buffer.byteLength('{"code":[') + Buffer.byteLength(']}');
    for (const byte of bytes) length += byte < 10 ? 1 : byte < 100 ? 2 : 3;
    if (bytes.length > 1) length += bytes.length - 1;
    return length;
}

function readContractFingerprint(rootDir) {
    const fingerprintRoot = path.join(
        rootDir,
        'target',
        'wasm32-unknown-unknown',
        'release',
        '.fingerprint',
    );
    let directories;
    try {
        directories = fs.readdirSync(fingerprintRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name.startsWith('relay-contract-'));
    } catch {
        throw failure('The contract build fingerprint is unavailable.');
    }
    const fingerprints = [];
    for (const directory of directories) {
        const fingerprintPath = path.join(fingerprintRoot, directory.name, 'lib-relay_contract.json');
        if (!fs.existsSync(fingerprintPath)) continue;
        try {
            fingerprints.push(JSON.parse(fs.readFileSync(fingerprintPath, 'utf8')));
        } catch {
            throw failure('The contract build fingerprint is invalid.');
        }
    }
    if (fingerprints.length !== 1 || typeof fingerprints[0].features !== 'string') {
        throw failure('Could not identify one unambiguous contract build fingerprint.');
    }
    let features;
    try {
        features = JSON.parse(fingerprints[0].features);
    } catch {
        throw failure('The contract build fingerprint has invalid feature metadata.');
    }
    if (!Array.isArray(features) || features.some(feature => typeof feature !== 'string')) {
        throw failure('The contract build fingerprint has invalid feature metadata.');
    }
    return {
        activeFeatures: features,
        sandboxCheckoutDispatchEnabled: features.includes('sandbox-checkout-dispatch'),
        defaultFeaturesOnly: features.length === 1 && features[0] === 'default',
    };
}

function protocolFee(config, actionName, byteLength = 0) {
    const costs = config.runtime_config?.transaction_costs;
    let action = costs?.action_creation_config?.[`${actionName}_cost`];
    if (actionName === 'add_key') action = action?.full_access_cost;
    if (!action) throw failure(`Testnet protocol configuration is missing ${actionName} costs.`);
    let fee = toBigInt(action.execution, `${actionName} execution cost`) +
        toBigInt(action.send_not_sir, `${actionName} send cost`);
    if (byteLength > 0) {
        const perByte = costs.action_creation_config[`${actionName}_cost_per_byte`];
        if (!perByte) throw failure(`Testnet protocol configuration is missing ${actionName} byte costs.`);
        fee += BigInt(byteLength) * (
            toBigInt(perByte.execution, `${actionName} per-byte execution cost`) +
            toBigInt(perByte.send_not_sir, `${actionName} per-byte send cost`)
        );
    }
    return fee;
}

function receiptFee(config) {
    const receipt = config.runtime_config?.transaction_costs?.action_receipt_creation_config;
    if (!receipt) throw failure('Testnet protocol configuration is missing receipt costs.');
    return toBigInt(receipt.execution, 'receipt execution cost') +
        toBigInt(receipt.send_not_sir, 'receipt send cost');
}

function inspectArtifacts(rootDir) {
    const contract = readArtifact(
        rootDir,
        path.join('target', 'wasm32-unknown-unknown', 'release', 'relay_contract.wasm'),
        'contract',
    );
    const controller = readArtifact(
        rootDir,
        path.join('target', 'wasm32-unknown-unknown', 'release', 'relay_subaccount.wasm'),
        'controller',
    );
    const fingerprint = readContractFingerprint(rootDir);
    return {
        contract: {
            ...contract,
            expectedSha256: EXPECTED_ARTIFACTS.contract,
            expectedHashValid: /^[A-F0-9]{64}$/.test(EXPECTED_ARTIFACTS.contract),
            matchesAuditedHash: contract.sha256 === EXPECTED_ARTIFACTS.contract,
        },
        controller: {
            ...controller,
            expectedSha256: EXPECTED_ARTIFACTS.controller,
            expectedHashValid: /^[A-F0-9]{64}$/.test(EXPECTED_ARTIFACTS.controller),
            matchesAuditedHash: controller.sha256 === EXPECTED_ARTIFACTS.controller,
        },
        fingerprint,
    };
}

async function runReadOnlyPreflight(options = {}) {
    const rootDir = options.rootDir || path.resolve(__dirname, '..');
    const envPath = options.envPath || path.join(rootDir, '.env');
    const readFile = options.readFile || fs.readFileSync;
    const sdk = options.sdk || require('near-api-js');
    let env;
    try {
        env = parseEnvText(readFile(envPath, 'utf8'));
    } catch {
        throw failure('Could not read valid local .env configuration.');
    }

    const privateKey = env.NEAR_PRIVATE_KEY;
    delete env.NEAR_PRIVATE_KEY;
    if (!privateKey) throw failure('NEAR_PRIVATE_KEY is missing from the ignored local .env file.');
    if (env.NEAR_ACCOUNT_ID !== DEPLOYER_ACCOUNT_ID) {
        throw failure('NEAR_ACCOUNT_ID must be spellman.testnet for this preflight.');
    }
    if (env.NEAR_NETWORK && env.NEAR_NETWORK !== 'testnet') {
        throw failure('Configured NEAR_NETWORK is not testnet.');
    }
    if (env.RELAY_CONTRACT_ID && env.RELAY_CONTRACT_ID !== TARGET_ACCOUNT_ID) {
        throw failure('Configured RELAY_CONTRACT_ID does not match the requested Testnet target.');
    }

    const rpcUrl = cleanRpcUrl(env.NEAR_RPC_URL || TESTNET_RPC_URL);
    let signer;
    let publicKey;
    try {
        signer = sdk.KeyPairSigner.fromSecretKey(privateKey);
        publicKey = (await signer.getPublicKey()).toString();
    } catch {
        throw failure('NEAR_PRIVATE_KEY could not be loaded by the official NEAR SDK.');
    }

    let provider;
    let status;
    try {
        provider = new sdk.JsonRpcProvider({ url: rpcUrl.toString() });
        status = await provider.viewNodeStatus();
    } catch {
        throw failure('Could not verify the configured NEAR RPC network.');
    }
    if (!status || status.chain_id !== 'testnet') {
        throw failure('Configured NEAR RPC did not identify itself as Testnet.');
    }

    let finalizedBlock;
    let deployer;
    let accessKeyList;
    let protocol;
    let gasPrice;
    try {
        finalizedBlock = await provider.viewBlock({ finality: 'final' });
        deployer = await provider.viewAccount({
            accountId: DEPLOYER_ACCOUNT_ID,
            blockQuery: { finality: 'final' },
        });
        accessKeyList = await provider.viewAccessKeyList({
            accountId: DEPLOYER_ACCOUNT_ID,
            finalityQuery: { finality: 'final' },
        });
        protocol = await provider.experimental_protocolConfig({ finality: 'final' });
        gasPrice = await provider.viewGasPrice(finalizedBlock.header.height);
    } catch {
        throw failure('Could not complete finalized Testnet account and protocol reads.');
    }

    const accessKeys = Array.isArray(accessKeyList.keys) ? accessKeyList.keys : [];
    const matchingFullAccessKey = accessKeys.some(key =>
        key.public_key === publicKey && isFullAccess(key.access_key?.permission));
    if (!matchingFullAccessKey) {
        throw failure('Derived NEAR public key does not match a FullAccess key on spellman.testnet.');
    }

    let targetExists = true;
    let targetState = null;
    try {
        targetState = await provider.viewAccount({
            accountId: TARGET_ACCOUNT_ID,
            blockQuery: { finality: 'final' },
        });
    } catch (error) {
        if (error?.name !== 'AccountDoesNotExistError') {
            throw failure('Could not verify the requested target account state on Testnet.');
        }
        targetExists = false;
    }

    let account;
    try {
        account = new sdk.Account(DEPLOYER_ACCOUNT_ID, provider, signer);
    } catch {
        throw failure('The verified key could not be bound to the Testnet account signer.');
    }
    if (typeof account.signAndSendTransaction !== 'function') {
        throw failure('The installed NEAR SDK does not expose its account transaction API.');
    }

    const artifacts = (options.inspectArtifacts || inspectArtifacts)(rootDir);
    const storagePerByte = toBigInt(
        protocol.runtime_config?.storage_amount_per_byte,
        'storage amount per byte',
    );
    const currentGasPrice = toBigInt(gasPrice.gas_price, 'gas price');
    const actionCosts = protocol.runtime_config?.transaction_costs?.action_creation_config;
    const storageUsageConfig = protocol.runtime_config?.transaction_costs?.storage_usage_config;
    const baseAccountStorageBytes = toBigInt(
        storageUsageConfig?.num_bytes_account,
        'base account storage bytes',
    ) + toBigInt(storageUsageConfig?.num_extra_bytes_record, 'extra record storage bytes');
    const createAccountGas = protocolFee(protocol, 'create_account') +
        protocolFee(protocol, 'transfer') +
        protocolFee(protocol, 'add_key') +
        receiptFee(protocol);
    const deployContractGas = protocolFee(protocol, 'deploy_contract', artifacts.contract.bytes) +
        receiptFee(protocol);
    const controllerCallGas = protocolFee(protocol, 'function_call', artifacts.controller.jsonCodeArgumentBytes) +
        receiptFee(protocol);
    const initArgsBytes = Buffer.byteLength(JSON.stringify({ owner_id: DEPLOYER_ACCOUNT_ID }));
    const initCallGas = protocolFee(protocol, 'function_call', initArgsBytes) + receiptFee(protocol);
    const maxBurntGas = toBigInt(
        protocol.runtime_config?.wasm_config?.limit_config?.max_gas_burnt,
        'maximum burnt gas',
    );
    const explicitGasCaps = {
        initialize: 100n * TERA_GAS,
        storeController: 100n * TERA_GAS,
    };
    if (Object.values(explicitGasCaps).some(gas => gas > maxBurntGas)) {
        throw failure('Planned function-call gas exceeds the Testnet protocol limit.');
    }
    const totalGasBudget = createAccountGas + deployContractGas + controllerCallGas + initCallGas +
        explicitGasCaps.initialize + explicitGasCaps.storeController;
    const contractStorageStake = BigInt(artifacts.contract.bytes) * storagePerByte;
    const controllerPayloadStake = BigInt(artifacts.controller.bytes) * storagePerByte;
    const controllerStorageBuffer = 10n ** 22n;
    const deploymentBlockers = [];
    if (targetExists) deploymentBlockers.push('target-account-already-exists');
    if (!artifacts.contract.expectedHashValid) deploymentBlockers.push('provided-contract-hash-is-not-a-valid-sha256');
    if (!artifacts.contract.matchesAuditedHash) deploymentBlockers.push('contract-artifact-hash-does-not-match-provided-hash');
    if (!artifacts.controller.matchesAuditedHash) deploymentBlockers.push('controller-artifact-hash-does-not-match-provided-hash');
    if (!artifacts.fingerprint.defaultFeaturesOnly || artifacts.fingerprint.sandboxCheckoutDispatchEnabled) {
        deploymentBlockers.push('contract-feature-fingerprint-is-not-default-only');
    }

    return {
        mode: 'read-only',
        transactionSubmissionPerformed: false,
        transactionSubmissionExposed: false,
        deploymentReady: deploymentBlockers.length === 0,
        deploymentBlockers,
        sdk: {
            name: 'near-api-js',
            version: readSdkVersion(),
            keyLoading: 'KeyPairSigner.fromSecretKey (in process memory)',
            accountTransactionApiAvailable: true,
        },
        network: {
            expected: 'testnet',
            reported: status.chain_id,
            rpcEndpoint: `${rpcUrl.origin}${rpcUrl.pathname.replace(/\/$/, '')}`,
            finalizedBlockHeight: finalizedBlock.header.height,
        },
        deployer: {
            accountId: DEPLOYER_ACCOUNT_ID,
            publicKey,
            fullAccessKeyMatch: matchingFullAccessKey,
            liquidBalanceYocto: String(deployer.amount),
            liquidBalanceNear: formatNear(deployer.amount),
            lockedBalanceNear: formatNear(deployer.locked),
            storageUsageBytes: deployer.storage_usage,
        },
        target: {
            accountId: TARGET_ACCOUNT_ID,
            exists: targetExists,
            codeHash: targetState ? String(targetState.code_hash) : null,
        },
        artifacts: {
            ...artifacts,
            allMatchAuditedHashes: artifacts.contract.matchesAuditedHash &&
                artifacts.controller.matchesAuditedHash,
        },
        protocol: {
            storageAmountPerByteYocto: String(storagePerByte),
            storageAmountPerByteNear: formatNear(storagePerByte),
            accountStorageProtocolBaseBytes: String(baseAccountStorageBytes),
            accountStorageProtocolBaseStakeNear: formatNear(baseAccountStorageBytes * storagePerByte),
            accountStorageBaseStakeIsNotTotal: true,
            gasPriceYoctoPerGas: String(currentGasPrice),
            gasPriceBlockHeight: finalizedBlock.header.height,
            maxBurntGas: String(maxBurntGas),
            maxBurntGasTgas: formatTgas(maxBurntGas),
            accountCreationGas: String(createAccountGas),
            contractDeploymentGas: String(deployContractGas),
            initializationIntrinsicGas: String(initCallGas),
            controllerUploadIntrinsicGas: String(controllerCallGas),
            controllerUploadArgumentBytes: artifacts.controller.jsonCodeArgumentBytes,
            initializationArgumentBytes: initArgsBytes,
            explicitFunctionCallGasCaps: {
                initializeTgas: formatTgas(explicitGasCaps.initialize),
                storeControllerTgas: formatTgas(explicitGasCaps.storeController),
            },
            totalPlannedGasBudget: String(totalGasBudget),
            totalPlannedGasBudgetTgas: formatTgas(totalGasBudget),
            totalPlannedGasBudgetNearAtCurrentPrice: formatNear(totalGasBudget * currentGasPrice),
            contractCodeStorageStakeYocto: String(contractStorageStake),
            contractCodeStorageStakeNear: formatNear(contractStorageStake),
            controllerPayloadStorageStakeYocto: String(controllerPayloadStake),
            controllerPayloadStorageStakeNear: formatNear(controllerPayloadStake),
            controllerAttachedDepositTargetYocto: String(controllerPayloadStake + controllerStorageBuffer),
            controllerAttachedDepositTargetNear: formatNear(controllerPayloadStake + controllerStorageBuffer),
            controllerStorageRefundBufferNear: formatNear(controllerStorageBuffer),
            contractAccountInitializationStorageNotIncluded: true,
            actionCostsAvailable: Boolean(actionCosts),
        },
        deploymentPlan: [
            {
                step: 'create-account',
                receiverId: TARGET_ACCOUNT_ID,
                actions: ['CreateAccount', 'Transfer', 'AddKey(FullAccess)'],
            },
            {
                step: 'deploy-contract',
                receiverId: TARGET_ACCOUNT_ID,
                artifact: artifacts.contract.path,
            },
            {
                step: 'initialize',
                receiverId: TARGET_ACCOUNT_ID,
                method: 'new_default_meta',
                args: { owner_id: DEPLOYER_ACCOUNT_ID },
            },
            {
                step: 'store-controller',
                receiverId: TARGET_ACCOUNT_ID,
                method: 'store_controller_code',
                artifact: artifacts.controller.path,
                attachedDepositNear: formatNear(controllerPayloadStake + controllerStorageBuffer),
                note: 'The contract refunds excess above its exact storage growth.',
            },
        ],
    };
}

function formatTgas(gas) {
    const value = BigInt(gas);
    const whole = value / TERA_GAS;
    const remainder = value % TERA_GAS;
    return remainder === 0n ? String(whole) : `${whole}.${remainder.toString().padStart(12, '0').replace(/0+$/, '')}`;
}

function readSdkVersion() {
    try {
        const packagePath = path.resolve(path.dirname(require.resolve('near-api-js')), '..', 'package.json');
        return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
    } catch {
        throw failure('Could not determine the installed near-api-js version.');
    }
}

async function main() {
    const report = await runReadOnlyPreflight();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    runReadOnlyPreflight,
    formatNear,
    isFullAccess,
};
