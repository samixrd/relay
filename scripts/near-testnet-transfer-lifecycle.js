'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseEnvText } = require('./app-config');

const OWNER_A_ACCOUNT_ID = 'spellman.testnet';
const CONTRACT_ACCOUNT_ID = 'relay.spellman.testnet';
const TOKEN_ID = 'relay-test-1';
const ASSOCIATED_ACCOUNT_ID = `${TOKEN_ID}.${CONTRACT_ACCOUNT_ID}`;
const DEFAULT_OWNER_B_ACCOUNT_ID = `relay-owner-b.${OWNER_A_ACCOUNT_ID}`;
const TESTNET_RPC_URL = 'https://rpc.testnet.near.org';
const YOCTO_PER_NEAR = 10n ** 24n;
const ACCOUNT_FUNDING = YOCTO_PER_NEAR / 10n;
const MAX_OWNER_B_FUNDING = YOCTO_PER_NEAR;
const TRANSFER_DEPOSIT = 1n;
const TRANSFER_GAS = 30n * 10n ** 12n;
const AUTHORIZATION_GAS = 100n * 10n ** 12n;
const ACCOUNT_CREATION_GAS_CAP = 100n * 10n ** 12n;
const EXPECTED_PARENT_CODE_SHA256 = '2CB1AE95CDB0B6616D69A728BAD983093225A98B10526358BFE90AD9AD334B6F';
const EXPECTED_CONTROLLER_CODE_SHA256 = '762A821E16897303AB491E90E26F02FA466ED831008CE73C4EB27F3CB4F29242';

function failure(message) {
    return new Error(message);
}

function isFullAccess(permission) {
    return permission === 'FullAccess' ||
        (permission && typeof permission === 'object' && Object.hasOwn(permission, 'FullAccess'));
}

function validateDistinctOwners(ownerA, ownerB) {
    if (!ownerA || !ownerB || ownerA === ownerB) {
        throw failure('Owner A and Owner B must be distinct NEAR accounts.');
    }
    if (ownerB !== DEFAULT_OWNER_B_ACCOUNT_ID) {
        throw failure(`Owner B must be the configured independent account ${DEFAULT_OWNER_B_ACCOUNT_ID}.`);
    }
    return true;
}

function buildTransferArguments(ownerB) {
    validateDistinctOwners(OWNER_A_ACCOUNT_ID, ownerB);
    return {
        token_id: TOKEN_ID,
        receiver_id: ownerB,
        approval_id: null,
        memo: null,
    };
}

function buildTransferAction(sdk, ownerB) {
    return sdk.actions.functionCall(
        'nft_transfer',
        buildTransferArguments(ownerB),
        TRANSFER_GAS,
        TRANSFER_DEPOSIT,
    );
}

function buildAccountCreationActions(sdk, publicKey) {
    return [
        sdk.actions.createAccount(),
        sdk.actions.transfer(ACCOUNT_FUNDING),
        sdk.actions.addFullAccessKey(sdk.PublicKey.from(publicKey)),
    ];
}

function buildAuthorizationAction(sdk, ownerB) {
    return sdk.actions.functionCall(
        'relay_execute_subaccount',
        {
            token_id: TOKEN_ID,
            action: {
                TransferNear: {
                    receiver_id: ownerB,
                    amount: '0',
                },
            },
        },
        AUTHORIZATION_GAS,
        0n,
    );
}

function transactionHash(result) {
    return result?.transaction?.hash ||
        result?.transaction_outcome?.id ||
        result?.transaction?.hash?.toString?.() ||
        null;
}

function receiptEvidence(result) {
    return (result?.receipts_outcome || []).map(receipt => ({
        id: receipt.id || receipt.outcome?.id || null,
        executorId: receipt.outcome?.executor_id || null,
        blockHash: receipt.outcome?.block_hash || null,
        gasBurnt: receipt.outcome?.gas_burnt === undefined
            ? null
            : String(receipt.outcome.gas_burnt),
        status: receipt.outcome?.status || null,
    }));
}

function hasFailedOutcome(result) {
    const status = result?.status;
    if (status && typeof status === 'object' && Object.hasOwn(status, 'Failure')) return true;
    if (result?.transaction_outcome?.outcome?.status?.Failure) return true;
    return (result?.receipts_outcome || []).some(receipt =>
        Boolean(receipt?.outcome?.status?.Failure));
}

function parseOutcome(result) {
    return {
        transactionHash: transactionHash(result),
        finalStatus: result?.status || null,
        transactionOutcome: result?.transaction_outcome || null,
        receipts: receiptEvidence(result),
        failed: hasFailedOutcome(result),
    };
}

function readEnv(envPath) {
    try {
        return parseEnvText(fs.readFileSync(envPath, 'utf8'));
    } catch {
        throw failure('Could not read valid local .env configuration.');
    }
}

function assertEnvIgnored(rootDir) {
    const result = spawnSync('git', ['check-ignore', '--quiet', '--', '.env'], {
        cwd: rootDir,
        stdio: 'ignore',
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        throw failure('Refusing to save credentials because .env is not ignored by Git.');
    }
}

function updateEnvText(existingText, values) {
    const lines = existingText.length ? existingText.split(/\r?\n/) : [];
    for (const [name, value] of Object.entries(values)) {
        if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
            throw failure(`Cannot safely save invalid ${name} configuration.`);
        }
        const prefix = `${name}=`;
        const index = lines.findIndex(line => line.startsWith(prefix));
        if (index >= 0) lines[index] = `${prefix}${value}`;
        else lines.push(`${prefix}${value}`);
    }
    return `${lines.filter((line, index) => index < lines.length - 1 || line !== '').join(os.EOL)}${os.EOL}`;
}

function restrictEnvPermissions(envPath) {
    if (process.platform === 'win32') {
        const username = process.env.USERNAME;
        const domain = process.env.USERDOMAIN;
        if (!username) throw failure('Could not determine the current Windows user for .env permissions.');
        const identity = domain ? `${domain}\\${username}` : username;
        const result = spawnSync('icacls.exe', [
            envPath,
            '/inheritance:r',
            '/grant:r',
            `${identity}:(F)`,
        ], { stdio: 'ignore', windowsHide: true });
        if (result.error || result.status !== 0) {
            throw failure('Could not restrict .env permissions to the current Windows user.');
        }
    } else {
        fs.chmodSync(envPath, 0o600);
    }
}

function saveOwnerBCredentials(envPath, ownerB, privateKey, options = {}, extraValues = {}) {
    const rootDir = options.rootDir || path.resolve(__dirname, '..');
    (options.assertEnvIgnored || assertEnvIgnored)(rootDir);
    const existingText = fs.readFileSync(envPath, 'utf8');
    const nextText = updateEnvText(existingText, {
        OWNER_B_ACCOUNT_ID: ownerB,
        OWNER_B_PRIVATE_KEY: privateKey,
        ...extraValues,
    });
    const temporaryPath = `${envPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporaryPath, 'wx', 0o600);
        fs.writeFileSync(fd, nextText, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporaryPath, envPath);
        (options.restrictPermissions || restrictEnvPermissions)(envPath);
    } catch (error) {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        if (error?.message?.startsWith('Could not restrict .env permissions')) throw error;
        throw failure('Could not securely update local .env credentials.');
    }
}

function validateTestnetStatus(status) {
    if (status?.chain_id !== 'testnet') {
        throw failure(`Connected NEAR network is ${status?.chain_id || 'unknown'}, expected testnet.`);
    }
}

function assertTransactionSucceeded(result, label) {
    if (hasFailedOutcome(result)) {
        return { ...parseOutcome(result), label, succeeded: false };
    }
    if (!transactionHash(result)) {
        throw failure(`${label} returned no transaction hash; outcome is ambiguous and must be reconciled before any retry.`);
    }
    return { ...parseOutcome(result), label, succeeded: true };
}

function assertAuthorizationProbe(outcome, shouldSucceed, label) {
    if (outcome.ambiguous) {
        throw failure(`${label} outcome is ambiguous at ${outcome.transactionHash || 'an unknown transaction'}; do not retry.`);
    }
    if (shouldSucceed && !outcome.succeeded) {
        throw failure(`${label} was not accepted by the on-chain authorization path.`);
    }
    if (!shouldSucceed && !outcome.failed) {
        throw failure(`${label} unexpectedly succeeded.`);
    }
    return true;
}

async function submitOnce(account, provider, receiverId, actions, label, onSigned = null, sdk = require('near-api-js')) {
    let signedTransaction;
    let txHash;
    try {
        signedTransaction = await account.createSignedTransaction({
            receiverId,
            actions,
        });
        const baseEncode = provider.baseEncode || require('near-api-js').baseEncode;
        txHash = baseEncode(
            crypto.createHash('sha256')
                .update(signedTransaction.transaction.encode())
                .digest(),
        );
        if (onSigned) await onSigned(txHash, signedTransaction);
        const result = await provider.sendJsonRpc('send_tx', {
            signed_tx_base64: sdk.base64Encode(sdk.encodeTransaction(signedTransaction)),
            wait_until: 'FINAL',
        });
        return assertTransactionSucceeded(result, label);
    } catch (error) {
        if (txHash) {
            try {
                const reconciled = await provider.viewTransactionStatusWithReceipts({
                    txHash,
                    accountId: account.accountId,
                    waitUntil: 'FINAL',
                });
                return {
                    ...parseOutcome(reconciled),
                    label,
                    succeeded: !hasFailedOutcome(reconciled),
                    failed: hasFailedOutcome(reconciled),
                    reconciled: true,
                };
            } catch {
                return {
                    transactionHash: txHash,
                    finalStatus: null,
                    transactionOutcome: null,
                    receipts: [],
                    failed: false,
                    succeeded: false,
                    ambiguous: true,
                    label,
                };
            }
        }
        throw failure(`${label} submission/finality is ambiguous; reconcile finalized chain state before retrying.`);
    }
}

function decodeViewResult(result) {
    const text = Buffer.from(result.result).toString('utf8');
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function callView(provider, blockId, accountId, methodName, args = {}) {
    const response = await provider.sendJsonRpc('query', {
        request_type: 'call_function',
        account_id: accountId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        block_id: blockId,
    });
    return decodeViewResult(response);
}

async function queryAt(provider, blockId, request) {
    return provider.sendJsonRpc('query', { ...request, block_id: blockId });
}

async function finalizedSnapshot(provider) {
    const block = await provider.viewBlock({ finality: 'final' });
    const blockId = block.header.hash;
    const rpc = (request) => queryAt(provider, blockId, request);
    const parentMethods = [
        'nft_token',
        'nft_total_supply',
        'relay_account_binding',
        'relay_provisioning_state',
        'relay_credits',
        'token_lifecycle',
        'token_nonce',
        'relay_payment',
        'relay_quote_nonce',
        'relay_active_quote_authorization',
    ];
    const parentViews = {};
    for (const methodName of parentMethods) {
        parentViews[methodName] = await callView(
            provider,
            blockId,
            CONTRACT_ACCOUNT_ID,
            methodName,
            methodName === 'nft_total_supply' ? {} : { token_id: TOKEN_ID },
        );
    }
    const [
        parentAccount,
        parentCode,
        subaccount,
        subaccountCode,
        accessKeys,
        controllerState,
    ] = await Promise.all([
        rpc({ request_type: 'view_account', account_id: CONTRACT_ACCOUNT_ID }),
        rpc({ request_type: 'view_code', account_id: CONTRACT_ACCOUNT_ID }),
        rpc({ request_type: 'view_account', account_id: ASSOCIATED_ACCOUNT_ID }),
        rpc({ request_type: 'view_code', account_id: ASSOCIATED_ACCOUNT_ID }),
        rpc({ request_type: 'view_access_key_list', account_id: ASSOCIATED_ACCOUNT_ID }),
        callView(provider, blockId, ASSOCIATED_ACCOUNT_ID, 'get_controller_state'),
    ]);
    function codeDigest(code) {
        const bytes = Buffer.from(code.code_base64, 'base64');
        return {
            bytes: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(),
        };
    }
    return {
        block: { height: block.header.height, hash: blockId },
        parent: {
            accountId: CONTRACT_ACCOUNT_ID,
            codeHash: parentAccount.code_hash,
            runtimeCode: codeDigest(parentCode),
            views: parentViews,
        },
        associatedAccount: {
            accountId: ASSOCIATED_ACCOUNT_ID,
            amountYocto: String(subaccount.amount),
            lockedYocto: String(subaccount.locked),
            storageUsageBytes: subaccount.storage_usage,
            codeHash: subaccount.code_hash,
            runtimeCode: codeDigest(subaccountCode),
            accessKeyCount: (accessKeys.keys || []).length,
            controllerState,
        },
    };
}

function assertPreTransferState(snapshot, ownerB) {
    const views = snapshot.parent.views;
    if (views.nft_token?.owner_id !== OWNER_A_ACCOUNT_ID) {
        throw failure('Pre-transfer owner is not spellman.testnet; refusing to transfer.');
    }
    if (views.nft_token?.token_id !== TOKEN_ID ||
        views.relay_account_binding?.account_id !== ASSOCIATED_ACCOUNT_ID ||
        views.relay_account_binding?.is_verified !== true ||
        views.relay_provisioning_state !== 'Completed' ||
        views.relay_credits?.total !== 3 ||
        views.relay_credits?.remaining !== 3 ||
        views.token_lifecycle !== 'Unlocked' ||
        views.relay_payment !== null ||
        views.relay_active_quote_authorization !== null ||
        snapshot.associatedAccount.accessKeyCount !== 0 ||
        snapshot.parent.runtimeCode.sha256 !== EXPECTED_PARENT_CODE_SHA256 ||
        snapshot.associatedAccount.runtimeCode.sha256 !== EXPECTED_CONTROLLER_CODE_SHA256 ||
        JSON.stringify(snapshot.associatedAccount.controllerState) !==
            JSON.stringify([CONTRACT_ACCOUNT_ID, TOKEN_ID])) {
        throw failure('Pre-transfer lifecycle or associated-account state does not match the authorized test prerequisites.');
    }
    validateDistinctOwners(views.nft_token.owner_id, ownerB);
}

function assertHandoffState(before, after, ownerB, expectedNonce = null) {
    const views = after.parent.views;
    const beforeViews = before.parent.views;
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const failures = [];
    if (views.nft_token?.owner_id !== ownerB) failures.push('NFT owner');
    if (views.nft_token?.token_id !== TOKEN_ID) failures.push('token ID');
    if (!equal(views.relay_account_binding, beforeViews.relay_account_binding)) failures.push('account binding');
    if (views.relay_provisioning_state !== beforeViews.relay_provisioning_state) failures.push('provisioning state');
    if (!equal(views.relay_credits, beforeViews.relay_credits)) failures.push('credits');
    if (views.token_lifecycle !== 'Unlocked') failures.push('lifecycle');
    if (views.relay_payment !== null) failures.push('payment state');
    if (views.relay_active_quote_authorization !== null) failures.push('active quote state');
    if (after.associatedAccount.accountId !== before.associatedAccount.accountId) failures.push('associated account ID');
    if (after.associatedAccount.amountYocto !== before.associatedAccount.amountYocto) failures.push('associated account balance');
    if (after.associatedAccount.storageUsageBytes !== before.associatedAccount.storageUsageBytes) failures.push('associated account storage usage');
    if (after.associatedAccount.codeHash !== before.associatedAccount.codeHash) failures.push('controller code hash');
    if (!equal(after.associatedAccount.controllerState, before.associatedAccount.controllerState)) failures.push('controller binding');
    if (after.associatedAccount.accessKeyCount !== 0) failures.push('associated account access keys');
    if (expectedNonce !== null && BigInt(views.token_nonce) !== BigInt(expectedNonce)) failures.push('operation nonce');
    if (failures.length) throw failure(`Handoff invariant failure: ${failures.join(', ')}.`);
    return true;
}

function assertZeroValueOperation(action) {
    const amount = action?.TransferNear?.amount;
    if (amount !== '0' && amount !== 0) {
        throw failure('Authorization probe must be a zero-value TransferNear action.');
    }
}

async function runTransferLifecycle(options = {}) {
    const rootDir = options.rootDir || path.resolve(__dirname, '..');
    const envPath = options.envPath || path.join(rootDir, '.env');
    const env = options.env || readEnv(envPath);
    const sdk = options.sdk || require('near-api-js');
    const ownerAId = env.NEAR_ACCOUNT_ID || OWNER_A_ACCOUNT_ID;
    const ownerBId = env.OWNER_B_ACCOUNT_ID || DEFAULT_OWNER_B_ACCOUNT_ID;
    if (ownerAId !== OWNER_A_ACCOUNT_ID) throw failure(`Owner A must be ${OWNER_A_ACCOUNT_ID}.`);
    validateDistinctOwners(ownerAId, ownerBId);
    if (env.NEAR_NETWORK && env.NEAR_NETWORK !== 'testnet') {
        throw failure('Configured NEAR_NETWORK is not testnet.');
    }
    if (env.RELAY_CONTRACT_ID && env.RELAY_CONTRACT_ID !== CONTRACT_ACCOUNT_ID) {
        throw failure('Configured RELAY_CONTRACT_ID does not match the deployed Testnet contract.');
    }

    const rpcUrl = env.NEAR_RPC_URL || TESTNET_RPC_URL;
    const provider = options.provider || new sdk.JsonRpcProvider({ url: rpcUrl });
    validateTestnetStatus(await provider.viewNodeStatus());

    const keyA = env.NEAR_PRIVATE_KEY;
    if (!keyA) throw failure('Owner A signer is missing from local .env.');
    let signerA;
    try {
        signerA = sdk.KeyPairSigner.fromSecretKey(keyA);
    } catch {
        throw failure('Could not load Owner A signer from local .env.');
    }
    const publicKeyA = (await signerA.getPublicKey()).toString();
    const ownerAKeys = await provider.viewAccessKeyList({
        accountId: ownerAId,
        finalityQuery: { finality: 'final' },
    });
    if (!(ownerAKeys.keys || []).some(key =>
        key.public_key === publicKeyA && isFullAccess(key.access_key?.permission))) {
        throw failure('Owner A signer does not match its on-chain FullAccess key.');
    }

    const ownerBSecret = env.OWNER_B_PRIVATE_KEY;
    const ownerBAccountExists = options.ownerBAccountExists === undefined
        ? await accountExists(provider, ownerBId)
        : options.ownerBAccountExists;
    if (!ownerBAccountExists && ownerBSecret) {
        if (env.OWNER_B_CREATION_TX_HASH) {
            throw failure('Owner B creation transaction is recorded but the account is absent; reconcile that transaction before proceeding.');
        }
    }
    let signerB = null;
    let publicKeyB = null;
    if (ownerBSecret) {
        try {
            signerB = sdk.KeyPairSigner.fromSecretKey(ownerBSecret);
            publicKeyB = (await signerB.getPublicKey()).toString();
        } catch {
            throw failure('Could not load Owner B signer from local .env.');
        }
    }
    if (ownerBAccountExists && !signerB) {
        throw failure('Owner B account exists but its independent signer is not configured in local .env.');
    }
    if (!ownerBAccountExists && !options.prepareOwnerB) {
        throw failure('Owner B account does not exist; use --prepare-owner-b to create it with an independent key.');
    }

    const ownerAAccount = new sdk.Account(ownerAId, provider, signerA);
    const readSnapshot = options.readSnapshot || finalizedSnapshot;
    const before = await readSnapshot(provider);
    if (options.resumeOwnerBAuthorization) {
        const views = before.parent.views;
        if (!env.OWNER_B_AUTHORIZATION_TX_HASH ||
            env.OWNER_B_AUTHORIZATION_RETRY_HASH ||
            views.nft_token?.owner_id !== ownerBId ||
            views.relay_account_binding?.account_id !== ASSOCIATED_ACCOUNT_ID ||
            views.relay_account_binding?.is_verified !== true ||
            views.relay_provisioning_state !== 'Completed' ||
            views.relay_credits?.total !== 3 ||
            views.relay_credits?.remaining !== 3 ||
            views.token_lifecycle !== 'Unlocked' ||
            views.relay_payment !== null ||
            views.relay_active_quote_authorization !== null ||
            before.associatedAccount.accessKeyCount !== 0 ||
            before.parent.runtimeCode.sha256 !== EXPECTED_PARENT_CODE_SHA256 ||
            before.associatedAccount.runtimeCode.sha256 !== EXPECTED_CONTROLLER_CODE_SHA256 ||
            JSON.stringify(before.associatedAccount.controllerState) !==
                JSON.stringify([CONTRACT_ACCOUNT_ID, TOKEN_ID])) {
            throw failure('Owner B authorization resume prerequisites are not satisfied or a prior retry is already recorded.');
        }
        const keyInfo = await provider.viewAccessKey({
            accountId: ownerBId,
            publicKey: publicKeyB,
            finalityQuery: { finality: 'final' },
        });
        const ownerBAccount = new sdk.Account(ownerBId, provider, signerB);
        const authorization = await submitOnce(
            ownerBAccount,
            provider,
            CONTRACT_ACCOUNT_ID,
            [buildAuthorizationAction(sdk, ownerBId)],
            'New-owner authorization probe (single resume)',
            (txHash, signed) => saveOwnerBCredentials(
                envPath,
                ownerBId,
                ownerBSecret,
                options,
                {
                    OWNER_B_AUTHORIZATION_RETRY_HASH: txHash,
                    OWNER_B_AUTHORIZATION_RETRY_NONCE: String(signed.transaction.nonce),
                    OWNER_B_AUTHORIZATION_PRIOR_NONCE: String(keyInfo.nonce),
                },
            ),
            sdk,
        );
        assertAuthorizationProbe(authorization, true, 'Owner B authorization resume');
        const after = await readSnapshot(provider);
        assertHandoffState(before, after, ownerBId, BigInt(before.parent.views.token_nonce) + 1n);
        return {
            mode: 'owner-b-authorization-resumed',
            network: 'testnet',
            ownerA: ownerAId,
            ownerB: ownerBId,
            priorAttempt: {
                transactionHash: env.OWNER_B_AUTHORIZATION_TX_HASH,
                finalStatus: 'no finalized state change observed at the pre-resume block',
            },
            ownerBKeyNonceBeforeRetry: String(keyInfo.nonce),
            newOwnerAuthorization: authorization,
            after,
        };
    }
    assertPreTransferState(before, ownerBId);
    const ownerAAccountView = await provider.viewAccount({
        accountId: ownerAId,
        blockQuery: { finality: 'final' },
    });
    const gasPrice = await provider.viewGasPrice(before.block.height);
    const gasPriceYocto = BigInt(gasPrice.gas_price);

    let creation = null;
    if (!ownerBAccountExists && options.prepareOwnerB) {
        const keyPair = options.ownerBKeyPair || (ownerBSecret ? null : sdk.KeyPairEd25519.fromRandom());
        const privateKey = ownerBSecret || keyPair.toString();
        publicKeyB = publicKeyB || keyPair.getPublicKey().toString();
        if (publicKeyB === publicKeyA) throw failure('Generated Owner B key is not independent from Owner A.');
        if (options.dryRun) {
            creation = {
                planned: true,
                receiverId: ownerBId,
                publicKey: publicKeyB,
                fundingYocto: ACCOUNT_FUNDING.toString(),
                fundingNear: '0.1',
                gasCapTgas: '100',
                maxSpendYocto: (ACCOUNT_FUNDING + ACCOUNT_CREATION_GAS_CAP * gasPriceYocto).toString(),
                privateKeySaved: false,
                transactionSubmitted: false,
            };
        } else {
            if (ACCOUNT_FUNDING > MAX_OWNER_B_FUNDING) {
                throw failure('Planned Owner B funding exceeds the one-NEAR limit.');
            }
            if (BigInt(ownerAAccountView.amount) < ACCOUNT_FUNDING + ACCOUNT_CREATION_GAS_CAP * gasPriceYocto) {
                throw failure('Owner A balance is insufficient for the planned 0.1 NEAR funding and 100 TGas budget.');
            }
            saveOwnerBCredentials(envPath, ownerBId, privateKey, options);
            const accountCreation = await submitOnce(
                ownerAAccount,
                provider,
                ownerBId,
                buildAccountCreationActions(sdk, publicKeyB),
                'Owner B account creation',
                txHash => saveOwnerBCredentials(
                    envPath,
                    ownerBId,
                    privateKey,
                    options,
                    { OWNER_B_CREATION_TX_HASH: txHash },
                ),
                sdk,
            );
            creation = accountCreation;
            if (creation.ambiguous) {
                throw failure(`Owner B account creation is ambiguous at ${creation.transactionHash}; do not resubmit.`);
            }
            if (!creation.succeeded) throw failure(`Owner B account creation failed at ${creation.transactionHash || 'unknown transaction'}.`);
            const createdAccount = await provider.viewAccount({
                accountId: ownerBId,
                blockQuery: { finality: 'final' },
            });
            const createdKeys = await provider.viewAccessKeyList({
                accountId: ownerBId,
                finalityQuery: { finality: 'final' },
            });
            if (!(createdKeys.keys || []).some(key =>
                key.public_key === publicKeyB && isFullAccess(key.access_key?.permission))) {
                throw failure('Owner B finalized account is missing the generated FullAccess key.');
            }
            if (BigInt(createdAccount.amount) < ACCOUNT_FUNDING) {
                throw failure('Owner B finalized balance is lower than the funded amount.');
            }
            signerB = sdk.KeyPairSigner.fromSecretKey(privateKey);
            creation = {
                ...creation,
                accountId: ownerBId,
                fundingYocto: ACCOUNT_FUNDING.toString(),
                fundingNear: '0.1',
                accountBalanceYocto: String(createdAccount.amount),
                lockedBalanceYocto: String(createdAccount.locked),
                storageUsageBytes: createdAccount.storage_usage,
                accessKeyCount: (createdKeys.keys || []).length,
                gasTokensBurnt: creation.transactionOutcome?.outcome?.tokens_burnt || null,
                verifiedFullAccess: true,
            };
            return {
                mode: 'owner-b-created',
                network: 'testnet',
                ownerA: ownerAId,
                ownerB: ownerBId,
                ownerBCreation: creation,
                ownerBPublicKey: publicKeyB,
                credentialsSaved: true,
                preTransferSnapshot: before,
                transferSubmitted: false,
            };
        }
    }

    if (signerB) {
        if (publicKeyB === publicKeyA) throw failure('Owner B signer is not independent from Owner A.');
        const ownerBKeys = await provider.viewAccessKeyList({
            accountId: ownerBId,
            finalityQuery: { finality: 'final' },
        });
        if (!(ownerBKeys.keys || []).some(key =>
            key.public_key === publicKeyB && isFullAccess(key.access_key?.permission))) {
            throw failure('Owner B signer does not match its on-chain FullAccess key.');
        }
    }

    if (options.dryRun) {
        return {
            mode: 'dry-run',
            network: 'testnet',
            ownerA: ownerAId,
            ownerB: ownerBId,
            before,
            ownerBCreation: creation,
            transfer: {
                receiverId: CONTRACT_ACCOUNT_ID,
                methodName: 'nft_transfer',
                args: buildTransferArguments(ownerBId),
                attachedDepositYocto: TRANSFER_DEPOSIT.toString(),
                gasTgas: '30',
                maxGasCostYocto: (TRANSFER_GAS * gasPriceYocto).toString(),
                submitted: false,
            },
            authorizationProbe: {
                methodName: 'relay_execute_subaccount',
                action: { TransferNear: { receiver_id: ownerBId, amount: '0' } },
                gasTgas: '100',
                amountYocto: '0',
                submitted: false,
            },
        };
    }

    if (!signerB) throw failure('Owner B signer is unavailable; refusing to transfer ownership.');
    if (options.execute !== true) throw failure('Execution requires --execute.');
    if (creation?.planned) throw failure('Cannot execute transfer in the same run as a dry-run account plan.');

    const transferResult = await submitOnce(
        ownerAAccount,
        provider,
        CONTRACT_ACCOUNT_ID,
        [buildTransferAction(sdk, ownerBId)],
        'NFT transfer',
        txHash => saveOwnerBCredentials(
            envPath,
            ownerBId,
            ownerBSecret,
            options,
            { OWNER_B_HANDOFF_TX_HASH: txHash },
        ),
        sdk,
    );
    if (transferResult.ambiguous) {
        throw failure(`NFT transfer outcome remains ambiguous at transaction ${transferResult.transactionHash}; do not retry.`);
    }
    if (!transferResult.succeeded) {
        throw failure('NFT transfer did not return a definitive successful finalized outcome; reconcile ownership before retrying.');
    }
    const afterTransfer = await readSnapshot(provider);
    if (afterTransfer.parent.views.nft_token?.owner_id !== ownerBId) {
        throw failure('Finalized NFT transfer receipt did not result in Owner B ownership.');
    }

    const ownerAProbe = await submitOnce(
        ownerAAccount,
        provider,
        CONTRACT_ACCOUNT_ID,
        [buildAuthorizationAction(sdk, ownerBId)],
        'Old-owner revocation probe',
        txHash => saveOwnerBCredentials(
            envPath,
            ownerBId,
            ownerBSecret,
            options,
            { OWNER_A_REVOCATION_TX_HASH: txHash },
        ),
        sdk,
    );
    assertAuthorizationProbe(ownerAProbe, false, 'Old-owner revocation probe');
    const afterOwnerAProbe = await readSnapshot(provider);
    assertHandoffState(before, afterOwnerAProbe, ownerBId);

    const ownerBAccount = new sdk.Account(ownerBId, provider, signerB);
    const action = { TransferNear: { receiver_id: ownerBId, amount: '0' } };
    assertZeroValueOperation(action);
    const ownerBProbe = await submitOnce(
        ownerBAccount,
        provider,
        CONTRACT_ACCOUNT_ID,
        [buildAuthorizationAction(sdk, ownerBId)],
        'New-owner authorization probe',
        txHash => saveOwnerBCredentials(
            envPath,
            ownerBId,
            ownerBSecret,
            options,
            { OWNER_B_AUTHORIZATION_TX_HASH: txHash },
        ),
        sdk,
    );
    assertAuthorizationProbe(ownerBProbe, true, 'Owner B zero-value authorization probe');
    const afterOwnerBProbe = await readSnapshot(provider);
    assertHandoffState(before, afterOwnerBProbe, ownerBId, BigInt(before.parent.views.token_nonce) + 1n);

    return {
        mode: 'executed',
        network: 'testnet',
        ownerA: ownerAId,
        ownerB: ownerBId,
        ownerBCreation: creation,
        before,
        transfer: transferResult,
        afterTransfer,
        oldOwnerRejection: ownerAProbe,
        afterOldOwnerProbe: afterOwnerAProbe,
        newOwnerAuthorization: ownerBProbe,
        afterNewOwnerProbe: afterOwnerBProbe,
    };
}

async function accountExists(provider, accountId) {
    try {
        await provider.viewAccount({
            accountId,
            blockQuery: { finality: 'final' },
        });
        return true;
    } catch (error) {
        if (error?.name === 'AccountDoesNotExistError') return false;
        throw failure(`Could not determine whether Owner B account ${accountId} exists.`);
    }
}

function parseArguments(argv) {
    const valid = new Set([
        '--prepare-owner-b',
        '--dry-run',
        '--execute',
        '--resume-owner-b-authorization',
    ]);
    if (argv.some(arg => !valid.has(arg))) throw failure('Unknown command-line option.');
    if (argv.includes('--execute') && argv.includes('--dry-run')) {
        throw failure('Choose either --dry-run or --execute, not both.');
    }
    if (argv.includes('--resume-owner-b-authorization') && !argv.includes('--execute')) {
        throw failure('Resuming Owner B authorization requires --execute.');
    }
    return {
        prepareOwnerB: argv.includes('--prepare-owner-b'),
        dryRun: argv.includes('--dry-run'),
        execute: argv.includes('--execute'),
        resumeOwnerBAuthorization: argv.includes('--resume-owner-b-authorization'),
    };
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    const report = await runTransferLifecycle(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    ACCOUNT_FUNDING,
    ASSOCIATED_ACCOUNT_ID,
    CONTRACT_ACCOUNT_ID,
    DEFAULT_OWNER_B_ACCOUNT_ID,
    OWNER_A_ACCOUNT_ID,
    TOKEN_ID,
    assertHandoffState,
    assertPreTransferState,
    assertAuthorizationProbe,
    assertTransactionSucceeded,
    buildAccountCreationActions,
    buildAuthorizationAction,
    buildTransferAction,
    buildTransferArguments,
    hasFailedOutcome,
    parseArguments,
    parseOutcome,
    runTransferLifecycle,
    saveOwnerBCredentials,
    submitOnce,
    updateEnvText,
    validateDistinctOwners,
    validateTestnetStatus,
};
