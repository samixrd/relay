'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const OWNER_A_ACCOUNT_ID = 'spellman.testnet';
const DEFAULT_OWNER_B_ACCOUNT_ID = 'relay-owner-b.spellman.testnet';
const CONTRACT_ACCOUNT_ID = 'relay.spellman.testnet';
const TOKEN_ID = 'relay-test-1';
const ASSOCIATED_ACCOUNT_ID = `${TOKEN_ID}.${CONTRACT_ACCOUNT_ID}`;
const TESTNET_RPC_URL = 'https://rpc.testnet.near.org';

const EXPECTED_KEY_PUBLIC_KEY = 'ed25519:XZdy4mt96Cmx36VBruUVXZZuKmazy9qGtoEk5rYefHA';
const EXPECTED_KEY_NONCE = 276787880000000n;
const UNRESOLVED_TX_HASHES = Object.freeze([
    'AQfGpA2unJP6PWgu1xBYk8XeiBDjJnvVQkYNpEbz1tpn',
    '5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U',
]);

const TRANSACTION_VALIDITY_PERIOD = 86400n; // authoritative Testnet validity period in blocks (~28.3 hours)
const LAST_SNAPSHOT_BLOCK_HEIGHT = 276793835n;
const CONSERVATIVE_EXPIRY_THRESHOLD = LAST_SNAPSHOT_BLOCK_HEIGHT + TRANSACTION_VALIDITY_PERIOD; // 276880235n

const YOCTO_PER_NEAR = 10n ** 24n;
const TERA_GAS = 10n ** 12n;
const STORAGE_COST_PER_BYTE = 10n ** 19n; // 10^19 yoctoNEAR per storage byte

const PROBE_AMOUNT_YOCTO = 10n ** 22n; // 0.01 NEAR (10 milliNEAR)
const AUTHORIZATION_GAS = 100n * TERA_GAS; // 100 TGas allocated to parent call
const SUBACCOUNT_DISPATCH_GAS = 30n * TERA_GAS; // 30 TGas static gas allocated by parent to subaccount
const CALLBACK_GAS = 10n * TERA_GAS; // 10 TGas static gas allocated to on_subaccount_executed
const PROBE_DEPOSIT = 0n; // 0 NEAR attached deposit

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

function isFullAccess(permission) {
    return permission === 'FullAccess' ||
        (permission && typeof permission === 'object' && Object.hasOwn(permission, 'FullAccess'));
}

function validateTestnetStatus(status) {
    if (status?.chain_id !== 'testnet') {
        throw failure(`Connected NEAR network is ${status?.chain_id || 'unknown'}, expected testnet.`);
    }
    return true;
}

function checkExpiryThreshold(currentBlockHeight, threshold = CONSERVATIVE_EXPIRY_THRESHOLD) {
    const height = BigInt(currentBlockHeight);
    const target = BigInt(threshold);
    const blocksRemaining = target > height ? target - height : 0n;
    const expired = height >= target;
    return {
        expired,
        currentHeight: height,
        threshold: target,
        blocksRemaining,
    };
}

function calculateSpendableBalance(accountBalanceYocto, storageUsageBytes) {
    const balance = BigInt(accountBalanceYocto);
    const storageUsage = BigInt(storageUsageBytes);
    const storageReserve = storageUsage * STORAGE_COST_PER_BYTE;
    const availableBalance = balance > storageReserve ? balance - storageReserve : 0n;
    return {
        balance,
        storageUsage,
        storageReserve,
        availableBalance,
    };
}

function buildProbeAction(receiverId = DEFAULT_OWNER_B_ACCOUNT_ID, amountYocto = PROBE_AMOUNT_YOCTO) {
    const amount = BigInt(amountYocto);
    if (!receiverId || typeof receiverId !== 'string') {
        throw failure('Receiver account ID must be a non-empty string.');
    }
    if (receiverId === ASSOCIATED_ACCOUNT_ID) {
        throw failure('Receiver cannot be the subaccount itself.');
    }
    if (amount <= 0n) {
        throw failure('TransferNear amount must be strictly greater than zero.');
    }
    return {
        TransferNear: {
            receiver_id: receiverId,
            amount: amount.toString(),
        },
    };
}

function buildParentExecuteArgs(tokenId = TOKEN_ID, action = buildProbeAction()) {
    return {
        token_id: tokenId,
        action,
    };
}

function assertSafetyGates(snapshot, options = {}) {
    const issues = [];
    const enforceExpiry = options.enforceExpiry ?? true;
    const targetThreshold = options.threshold ?? CONSERVATIVE_EXPIRY_THRESHOLD;

    // Gate 1: Conservative Expiry Threshold Gate
    const expiry = checkExpiryThreshold(snapshot.block.height, targetThreshold);
    if (enforceExpiry && !expiry.expired) {
        issues.push({
            gate: 'EXPIRY_THRESHOLD_GATE',
            error: `Conservative expiry threshold not reached: current block ${expiry.currentHeight} < threshold ${expiry.threshold} (${expiry.blocksRemaining} blocks remaining). Pending transactions ${UNRESOLVED_TX_HASHES.join(', ')} cannot be safely assumed expired.`,
        });
    }

    // Gate 2: Signer & Nonce Gate
    const ownerBKey = (snapshot.ownerB?.keys || []).find(k => k.public_key === EXPECTED_KEY_PUBLIC_KEY);
    if (!ownerBKey) {
        issues.push({
            gate: 'SIGNER_KEY_GATE',
            error: `Owner B (${DEFAULT_OWNER_B_ACCOUNT_ID}) missing expected public key ${EXPECTED_KEY_PUBLIC_KEY}.`,
        });
    } else {
        if (!isFullAccess(ownerBKey.access_key?.permission)) {
            issues.push({
                gate: 'SIGNER_KEY_GATE',
                error: `Owner B key ${EXPECTED_KEY_PUBLIC_KEY} does not have FullAccess permission.`,
            });
        }
        const currentNonce = BigInt(ownerBKey.access_key?.nonce || 0);
        if (currentNonce !== EXPECTED_KEY_NONCE) {
            issues.push({
                gate: 'SIGNER_NONCE_GATE',
                error: `Owner B key nonce is ${currentNonce}, expected exact snapshot nonce ${EXPECTED_KEY_NONCE}.`,
            });
        }
    }

    // Gate 3: Ownership Gate
    const token = snapshot.parent?.views?.nft_token;
    if (!token) {
        issues.push({
            gate: 'OWNERSHIP_GATE',
            error: `Token ${TOKEN_ID} not found on contract ${CONTRACT_ACCOUNT_ID}.`,
        });
    } else if (token.owner_id !== DEFAULT_OWNER_B_ACCOUNT_ID) {
        issues.push({
            gate: 'OWNERSHIP_GATE',
            error: `Token owner is ${token.owner_id}, expected ${DEFAULT_OWNER_B_ACCOUNT_ID}.`,
        });
    }

    // Gate 4: Canonical Subaccount Binding & Balance Gate
    const binding = snapshot.parent?.views?.relay_account_binding;
    if (!binding || binding.account_id !== ASSOCIATED_ACCOUNT_ID) {
        issues.push({
            gate: 'BINDING_GATE',
            error: `Associated account binding mismatch: expected ${ASSOCIATED_ACCOUNT_ID}, got ${binding?.account_id}.`,
        });
    } else if (!binding.is_verified) {
        issues.push({
            gate: 'BINDING_GATE',
            error: `Associated account ${ASSOCIATED_ACCOUNT_ID} is not verified.`,
        });
    }

    const provisioning = snapshot.parent?.views?.relay_provisioning_state;
    if (provisioning !== 'Completed') {
        issues.push({
            gate: 'PROVISIONING_GATE',
            error: `Provisioning state is ${provisioning}, expected Completed.`,
        });
    }

    const subaccount = snapshot.associatedAccount;
    if (!subaccount) {
        issues.push({
            gate: 'SUBACCOUNT_EXISTS_GATE',
            error: `Associated subaccount ${ASSOCIATED_ACCOUNT_ID} does not exist on chain.`,
        });
    } else {
        const spendable = calculateSpendableBalance(subaccount.amountYocto, subaccount.storageUsageBytes);
        if (spendable.availableBalance < PROBE_AMOUNT_YOCTO) {
            issues.push({
                gate: 'SUBACCOUNT_BALANCE_GATE',
                error: `Insufficient spendable balance in subaccount: available ${formatNear(spendable.availableBalance)} NEAR < probe amount ${formatNear(PROBE_AMOUNT_YOCTO)} NEAR (storage reserve: ${formatNear(spendable.storageReserve)} NEAR).`,
            });
        }
    }

    // Gate 5: Lifecycle & State Invariant Gate
    const lifecycle = snapshot.parent?.views?.token_lifecycle;
    if (lifecycle !== 'Unlocked') {
        issues.push({
            gate: 'LIFECYCLE_GATE',
            error: `Token lifecycle is ${typeof lifecycle === 'object' ? JSON.stringify(lifecycle) : lifecycle}, expected Unlocked.`,
        });
    }

    const credits = snapshot.parent?.views?.relay_credits;
    if (!credits || credits.remaining !== 3 || credits.total !== 3) {
        issues.push({
            gate: 'CREDITS_GATE',
            error: `Credits invariant violated: expected 3/3, got ${credits?.remaining}/${credits?.total}.`,
        });
    }

    return {
        passed: issues.length === 0,
        expiry,
        issues,
    };
}

function generateProofPlan(snapshot) {
    const action = buildProbeAction(DEFAULT_OWNER_B_ACCOUNT_ID, PROBE_AMOUNT_YOCTO);
    const args = buildParentExecuteArgs(TOKEN_ID, action);
    const gatesResult = assertSafetyGates(snapshot, { enforceExpiry: false });
    const expiry = checkExpiryThreshold(snapshot.block.height);

    const subaccountBalance = BigInt(snapshot.associatedAccount?.amountYocto || 0);
    const storageUsage = BigInt(snapshot.associatedAccount?.storageUsageBytes || 0);
    const spendable = calculateSpendableBalance(subaccountBalance, storageUsage);

    const projectedSubaccountBalance = subaccountBalance - PROBE_AMOUNT_YOCTO;
    const projectedSpendable = spendable.availableBalance - PROBE_AMOUNT_YOCTO;

    const currentTokenNonce = BigInt(snapshot.parent?.views?.token_nonce || 1);
    const projectedTokenNonce = currentTokenNonce + 1n;

    return {
        status: 'PREPARED_READ_ONLY_PLAN',
        unresolvedTransactions: {
            hashes: UNRESOLVED_TX_HASHES,
            signer: DEFAULT_OWNER_B_ACCOUNT_ID,
            keyNonce: EXPECTED_KEY_NONCE.toString(),
            validityPeriodBlocks: Number(TRANSACTION_VALIDITY_PERIOD),
            conservativeExpiryThreshold: CONSERVATIVE_EXPIRY_THRESHOLD.toString(),
            currentBlockHeight: snapshot.block.height.toString(),
            blocksRemaining: expiry.blocksRemaining.toString(),
            expired: expiry.expired,
        },
        authorityProbe: {
            contractId: CONTRACT_ACCOUNT_ID,
            signerId: DEFAULT_OWNER_B_ACCOUNT_ID,
            methodName: 'relay_execute_subaccount',
            args,
            attachedDepositYocto: PROBE_DEPOSIT.toString(),
            attachedDepositNear: '0',
            attachedGasTGas: Number(AUTHORIZATION_GAS / TERA_GAS),
            internalAllocations: {
                subaccountExecutionGasTGas: Number(SUBACCOUNT_DISPATCH_GAS / TERA_GAS),
                callbackGasTGas: Number(CALLBACK_GAS / TERA_GAS),
            },
        },
        rejectionCheck: {
            unauthorizedCaller: OWNER_A_ACCOUNT_ID,
            enforcementSite: 'contract/src/lib.rs:1440',
            assertion: 'env::predecessor_account_id() == token.owner_id',
            expectedResult: 'Panics with "Only current token owner can execute operations on associated sub-account"',
        },
        stateInvariantsAndProjections: {
            token: {
                id: TOKEN_ID,
                currentOwner: snapshot.parent?.views?.nft_token?.owner_id,
                projectedOwner: DEFAULT_OWNER_B_ACCOUNT_ID,
                currentLifecycle: snapshot.parent?.views?.token_lifecycle,
                intermediateLifecycle: `LockedForSubaccount { nonce: ${projectedTokenNonce}, initiator: "${DEFAULT_OWNER_B_ACCOUNT_ID}" }`,
                finalLifecycle: 'Unlocked',
                currentTokenNonce: currentTokenNonce.toString(),
                projectedTokenNonce: projectedTokenNonce.toString(),
                credits: {
                    before: snapshot.parent?.views?.relay_credits,
                    after: snapshot.parent?.views?.relay_credits,
                    consumed: 0,
                },
                quoteAuthorization: {
                    before: snapshot.parent?.views?.relay_active_quote_authorization,
                    after: null,
                    invalidationTrigger: 'invalidate_quote_authorization_for_context_change',
                },
            },
            subaccount: {
                accountId: ASSOCIATED_ACCOUNT_ID,
                storageUsageBytes: Number(storageUsage),
                storageReserveYocto: spendable.storageReserve.toString(),
                storageReserveNear: formatNear(spendable.storageReserve),
                before: {
                    balanceYocto: subaccountBalance.toString(),
                    balanceNear: formatNear(subaccountBalance),
                    spendableYocto: spendable.availableBalance.toString(),
                    spendableNear: formatNear(spendable.availableBalance),
                },
                probeTransferYocto: PROBE_AMOUNT_YOCTO.toString(),
                probeTransferNear: formatNear(PROBE_AMOUNT_YOCTO),
                projected: {
                    balanceYocto: projectedSubaccountBalance.toString(),
                    balanceNear: formatNear(projectedSubaccountBalance),
                    spendableYocto: projectedSpendable.toString(),
                    spendableNear: formatNear(projectedSpendable),
                    storageReservePreserved: projectedSubaccountBalance >= spendable.storageReserve,
                },
            },
            recipient: {
                accountId: DEFAULT_OWNER_B_ACCOUNT_ID,
                grossTransferReceivedNear: formatNear(PROBE_AMOUNT_YOCTO),
            },
        },
        safetyGates: {
            allPassedExceptExpiry: gatesResult.passed,
            expiryGatePassed: expiry.expired,
            issues: gatesResult.issues,
        },
    };
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

async function fetchLiveSnapshot(provider) {
    const status = await provider.viewNodeStatus();
    validateTestnetStatus(status);

    const block = await provider.viewBlock({ finality: 'final' });
    const blockHeight = BigInt(block.header.height);
    const blockHash = block.header.hash;

    const [nftToken, binding, provisioning, credits, lifecycle, nonce, quoteAuth] = await Promise.all([
        viewMethod(provider, CONTRACT_ACCOUNT_ID, 'nft_token', { token_id: TOKEN_ID }),
        viewMethod(provider, CONTRACT_ACCOUNT_ID, 'relay_account_binding', { token_id: TOKEN_ID }),
        viewMethod(provider, CONTRACT_ACCOUNT_ID, 'relay_provisioning_state', { token_id: TOKEN_ID }),
        viewMethod(provider, CONTRACT_ACCOUNT_ID, 'relay_credits', { token_id: TOKEN_ID }),
        viewMethod(provider, CONTRACT_ACCOUNT_ID, 'token_lifecycle', { token_id: TOKEN_ID }),
        viewMethod(provider, CONTRACT_ACCOUNT_ID, 'token_nonce', { token_id: TOKEN_ID }),
        viewMethod(provider, CONTRACT_ACCOUNT_ID, 'relay_active_quote_authorization', { token_id: TOKEN_ID }),
    ]);

    const subaccountView = await provider.viewAccount({
        accountId: ASSOCIATED_ACCOUNT_ID,
        blockQuery: { finality: 'final' },
    });

    const ownerBKeys = await provider.viewAccessKeyList({
        accountId: DEFAULT_OWNER_B_ACCOUNT_ID,
        blockQuery: { finality: 'final' },
    });

    return {
        block: {
            height: blockHeight,
            hash: blockHash,
        },
        parent: {
            accountId: CONTRACT_ACCOUNT_ID,
            views: {
                nft_token: nftToken,
                relay_account_binding: binding,
                relay_provisioning_state: provisioning,
                relay_credits: credits,
                token_lifecycle: lifecycle,
                token_nonce: nonce,
                relay_active_quote_authorization: quoteAuth,
            },
        },
        associatedAccount: {
            accountId: ASSOCIATED_ACCOUNT_ID,
            amountYocto: subaccountView.amount,
            storageUsageBytes: subaccountView.storage_usage,
        },
        ownerB: {
            accountId: DEFAULT_OWNER_B_ACCOUNT_ID,
            keys: ownerBKeys.keys,
        },
    };
}

async function runAuthorityProof(options = {}) {
    const rpcUrl = options.rpcUrl || TESTNET_RPC_URL;
    const sdk = options.sdk || require('near-api-js');
    const provider = options.provider || new sdk.JsonRpcProvider({ url: rpcUrl });

    const snapshot = options.snapshot || await fetchLiveSnapshot(provider);
    const plan = generateProofPlan(snapshot);

    if (options.execute) {
        // Enforce safety gates strictly
        const gates = assertSafetyGates(snapshot, {
            enforceExpiry: true,
            threshold: options.threshold ?? CONSERVATIVE_EXPIRY_THRESHOLD,
        });

        if (!gates.passed) {
            const reasons = gates.issues.map(i => `[${i.gate}] ${i.error}`).join('; ');
            throw failure(`Refusing execution: Safety gate validation failed: ${reasons}`);
        }

        if (!options.explicitApproval) {
            throw failure('Refusing execution: Missing required explicit user approval flag (--yes-i-understand-testnet-transactions-are-real).');
        }

        // Under Task 34F, live execution is deliberately not permitted
        throw failure('EXECUTION_HALTED: Task 34F is strictly a non-submitting preparation and safety gate test task. Live execution is blocked.');
    }

    return plan;
}

function parseArguments(argv) {
    const valid = new Set([
        '--plan',
        '--dry-run',
        '--execute',
        '--yes-i-understand-testnet-transactions-are-real',
        '--rpc-url',
    ]);

    let rpcUrl = null;
    const filtered = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--rpc-url') {
            rpcUrl = argv[++i];
            if (!rpcUrl) throw failure('Missing argument for --rpc-url.');
        } else {
            filtered.push(argv[i]);
        }
    }

    if (filtered.some(arg => !valid.has(arg))) {
        throw failure(`Unknown command-line option: ${filtered.find(arg => !valid.has(arg))}`);
    }

    const execute = filtered.includes('--execute');
    const plan = filtered.includes('--plan') || filtered.includes('--dry-run') || !execute;
    const explicitApproval = filtered.includes('--yes-i-understand-testnet-transactions-are-real');

    return {
        plan,
        dryRun: filtered.includes('--dry-run'),
        execute,
        explicitApproval,
        rpcUrl: rpcUrl || TESTNET_RPC_URL,
    };
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    const result = await runAuthorityProof(options);
    const replacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;
    process.stdout.write(`${JSON.stringify(result, replacer, 2)}\n`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    ASSOCIATED_ACCOUNT_ID,
    AUTHORIZATION_GAS,
    CALLBACK_GAS,
    CONSERVATIVE_EXPIRY_THRESHOLD,
    CONTRACT_ACCOUNT_ID,
    DEFAULT_OWNER_B_ACCOUNT_ID,
    EXPECTED_KEY_NONCE,
    EXPECTED_KEY_PUBLIC_KEY,
    LAST_SNAPSHOT_BLOCK_HEIGHT,
    OWNER_A_ACCOUNT_ID,
    PROBE_AMOUNT_YOCTO,
    PROBE_DEPOSIT,
    STORAGE_COST_PER_BYTE,
    SUBACCOUNT_DISPATCH_GAS,
    TOKEN_ID,
    TRANSACTION_VALIDITY_PERIOD,
    UNRESOLVED_TX_HASHES,
    YOCTO_PER_NEAR,
    assertSafetyGates,
    buildParentExecuteArgs,
    buildProbeAction,
    calculateSpendableBalance,
    checkExpiryThreshold,
    fetchLiveSnapshot,
    formatNear,
    generateProofPlan,
    parseArguments,
    runAuthorityProof,
    validateTestnetStatus,
};
