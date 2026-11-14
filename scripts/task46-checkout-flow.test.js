'use strict';

/**
 * Task 46 — End-to-end checkout flow, intent binding, and UI wiring tests.
 *
 * Everything here runs against deterministic RPC mocks. No network calls and
 * no transaction submission occur in this file.
 *
 * Coverage:
 * - Server-side payment intent binding (paymentId is authoritative)
 * - Receiver / amount tampering is rejected
 * - Expired authorization is rejected at the inclusion block
 * - Stale token nonce is rejected
 * - Ownership change between prepare and execution is rejected
 * - Duplicate settlement / idempotent replay handling
 * - Block-level balance evidence must show subaccount debit + receiver credit
 * - UI normalization + source wiring (no student-era result.plan assumptions)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    PaymentAuthorizationError,
    CANONICAL_CONTRACT_ID,
    CANONICAL_TOKEN_ID,
    NEAR_PAYMENT_STATES,
    createPaymentIntentStore,
    getNearPaymentIntent,
    prepareNearPayment,
    verifyNearPaymentTransaction,
} = require('./near-testnet-payment-authorizer');

const {
    normalizeNearPaymentPrepare,
    normalizeNearPaymentIntent,
    nearPaymentPresentation,
} = require('../web/ui-state');

const OWNER = 'relay-owner-b.spellman.testnet';
const RECEIVER = 'spellman.testnet';
const ASSOCIATED = `${CANONICAL_TOKEN_ID}.${CANONICAL_CONTRACT_ID}`;
const AMOUNT = '10000000000000000000000'; // 0.01 NEAR
const TX_HASH = '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f';
const OTHER_TX_HASH = 'J4aNw8zTgdGbZgZ9JgRu7ZeAdVUjAFFx1hxMendfZWM4';
const INCLUSION_BLOCK = 'inclusion-block-111';
const RECEIPT_BLOCK = 'receipt-block-222';
const PREPARE_BLOCK = 'prepare-block-333';

/**
 * Deterministic RPC mock that understands both prepareNearPayment and
 * intent-bound verifyNearPaymentTransaction.
 */
function makeIntentRpcMock(overrides = {}) {
    const owner = overrides.owner || OWNER;
    const ownerAtExecution = overrides.ownerAtExecution || owner;
    const txSigner = overrides.txSigner || owner;
    const txReceiver = overrides.txReceiver || RECEIVER;
    const txAmount = overrides.txAmount || AMOUNT;
    const finalStatus = overrides.finalStatus || 'FINAL';
    const nonceBefore = String(overrides.nonceBefore != null ? overrides.nonceBefore : 1);
    const nonceAfter = String(overrides.nonceAfter != null ? overrides.nonceAfter : 2);
    const amount = BigInt(txAmount);
    const assocBefore = BigInt(overrides.assocBefore || '1749930000000000000000000');
    const assocAfter = overrides.assocAfter != null
        ? BigInt(overrides.assocAfter)
        : assocBefore - amount;
    const receiverBefore = BigInt(overrides.receiverBefore || '5889316574544037299999999');
    const receiverAfter = overrides.receiverAfter != null
        ? BigInt(overrides.receiverAfter)
        : receiverBefore + amount;
    const inclusionTimestampNs = overrides.inclusionTimestampNs
        || (BigInt(Date.now()) * 1_000_000n).toString();

    const encodedArgs = Buffer.from(JSON.stringify({
        token_id: CANONICAL_TOKEN_ID,
        action: {
            TransferNear: {
                receiver_id: txReceiver,
                amount: txAmount,
            },
        },
    })).toString('base64');

    function ok(result) {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 'mock', result }) };
    }
    function view(value) {
        return ok({ result: Array.from(Buffer.from(JSON.stringify(value))) });
    }

    return async function mockFetch(url, opts) {
        const body = JSON.parse(opts.body);
        const method = body.method;
        const params = body.params || {};

        if (method === 'status') {
            return ok({ chain_id: 'testnet', sync_info: { latest_block_height: 100 } });
        }

        if (method === 'block') {
            if (params.block_id === RECEIPT_BLOCK) {
                return ok({ header: { hash: RECEIPT_BLOCK, height: 101, timestamp: inclusionTimestampNs } });
            }
            if (params.block_id === INCLUSION_BLOCK) {
                return ok({ header: { hash: INCLUSION_BLOCK, height: 100, timestamp: inclusionTimestampNs } });
            }
            return ok({
                header: {
                    hash: params.block_id || PREPARE_BLOCK,
                    height: 99,
                    timestamp: inclusionTimestampNs,
                },
            });
        }

        if (method === 'tx') {
            if (params.tx_hash !== TX_HASH && params.tx_hash !== OTHER_TX_HASH) {
                return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 'mock', error: { message: 'not found' } }) };
            }
            return ok({
                status: { SuccessValue: '' },
                final_execution_status: finalStatus,
                transaction: {
                    hash: params.tx_hash,
                    signer_id: txSigner,
                    receiver_id: CANONICAL_CONTRACT_ID,
                    actions: [{
                        FunctionCall: {
                            method_name: 'relay_execute_subaccount',
                            args: encodedArgs,
                            gas: '100000000000000',
                            deposit: '0',
                        },
                    }],
                },
                transaction_outcome: { block_hash: INCLUSION_BLOCK },
                receipts_outcome: [{
                    block_hash: RECEIPT_BLOCK,
                    outcome: { status: { SuccessValue: 'dHJ1ZQ==' } },
                }],
            });
        }

        if (method === 'query') {
            if (params.request_type === 'call_function') {
                switch (params.method_name) {
                    case 'nft_token':
                        return view({
                            token_id: CANONICAL_TOKEN_ID,
                            owner_id: params.block_id === INCLUSION_BLOCK ? ownerAtExecution : owner,
                        });
                    case 'relay_account_binding':
                        return view({ account_id: ASSOCIATED, is_verified: true });
                    case 'token_lifecycle':
                        return view(overrides.lifecycle || 'Unlocked');
                    case 'relay_credits':
                        return view(null);
                    case 'token_nonce':
                        if (params.block_id === RECEIPT_BLOCK) return view(Number(nonceAfter));
                        if (params.block_id === INCLUSION_BLOCK) return view(Number(nonceBefore));
                        return view(Number(nonceBefore));
                    default:
                        break;
                }
            }
            if (params.request_type === 'view_account') {
                if (params.account_id === ASSOCIATED) {
                    const amountAt = params.block_id === RECEIPT_BLOCK ? assocAfter : assocBefore;
                    return ok({ amount: amountAt.toString(), storage_usage: 150180, locked: '0' });
                }
                if (params.account_id === RECEIVER) {
                    const amountAt = params.block_id === RECEIPT_BLOCK ? receiverAfter : receiverBefore;
                    return ok({ amount: amountAt.toString(), storage_usage: 1000, locked: '0' });
                }
                return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 'mock', error: { message: 'account not found' } }) };
            }
        }

        throw new Error(`Unexpected mock RPC call: ${method} ${JSON.stringify(params)}`);
    };
}

async function prepareIntent(overrides = {}) {
    const store = createPaymentIntentStore();
    const prepared = await prepareNearPayment({
        rpcUrl: 'https://mock.test',
        relayContractId: CANONICAL_CONTRACT_ID,
        tokenId: CANONICAL_TOKEN_ID,
        receiverId: overrides.receiverId || RECEIVER,
        amountYocto: overrides.amountYocto || AMOUNT,
        intentStore: store,
        fetchImpl: makeIntentRpcMock(overrides),
        now: overrides.now,
    });
    return { store, prepared };
}

function verifyIntent({ store, prepared, fetchImpl, ...rest }) {
    return verifyNearPaymentTransaction({
        rpcUrl: 'https://mock.test',
        relayContractId: CANONICAL_CONTRACT_ID,
        tokenId: CANONICAL_TOKEN_ID,
        transactionHash: TX_HASH,
        paymentId: prepared.paymentRecord.paymentId,
        intentStore: store,
        fetchImpl: fetchImpl || makeIntentRpcMock(),
        ...rest,
    });
}

// ── §1: Intent binding ────────────────────────────────────────────────────────

describe('Task 46 §1: server-side payment intent binding', () => {
    it('prepares and verifies the exact intent with block-level balance evidence', async () => {
        const { store, prepared } = await prepareIntent();
        assert.ok(prepared.paymentRecord.paymentId.startsWith(`p-${CANONICAL_TOKEN_ID}-`));
        assert.equal(prepared.paymentRecord.ownerId, OWNER);
        assert.equal(prepared.paymentRecord.receiverId, RECEIVER);
        assert.equal(prepared.paymentRecord.amountYocto, AMOUNT);
        assert.ok(prepared.paymentRecord.deadline > Date.now());
        assert.ok(prepared.paymentRecord.expectedTokenNonce);

        const result = await verifyIntent({ store, prepared });

        assert.equal(result.verified, true);
        assert.equal(result.state, NEAR_PAYMENT_STATES.Settled);
        assert.equal(result.evidence.finalExecutionStatus, 'FINAL');
        assert.equal(result.evidence.nonceBefore, '1');
        assert.equal(result.evidence.nonceAfter, '2');
        assert.equal(result.evidence.ownerAtExecution, OWNER);
        assert.equal(result.evidence.subaccountDebitVerified, true);
        assert.equal(result.evidence.receiverBalanceDeltaVerified, true);
        assert.equal(result.evidence.storageReservePreserved, true);
        assert.equal(result.evidence.balances.associated.deltaYocto, `-${AMOUNT}`);
        assert.equal(result.evidence.balances.receiver.deltaYocto, AMOUNT);
    });

    it('rejects a client-supplied receiver that differs from the prepared intent', async () => {
        const { store, prepared } = await prepareIntent();
        await assert.rejects(
            () => verifyIntent({ store, prepared, expectedReceiver: 'attacker.testnet' }),
            (err) => err instanceof PaymentAuthorizationError &&
                err.code === 'PAYMENT_CONTEXT_MISMATCH' &&
                /Receiver/i.test(err.message)
        );
    });

    it('rejects a client-supplied amount that differs from the prepared intent', async () => {
        const { store, prepared } = await prepareIntent();
        await assert.rejects(
            () => verifyIntent({ store, prepared, expectedAmountYocto: '1' }),
            (err) => err instanceof PaymentAuthorizationError &&
                err.code === 'PAYMENT_CONTEXT_MISMATCH' &&
                /Amount/i.test(err.message)
        );
    });

    it('rejects an unknown paymentId instead of trusting client context', async () => {
        const { store, prepared } = await prepareIntent();
        await assert.rejects(
            () => verifyIntent({ store: createPaymentIntentStore(), prepared }),
            (err) => err instanceof PaymentAuthorizationError && err.code === 'PAYMENT_INTENT_NOT_FOUND'
        );
    });
});

// ── §2: Time, nonce, ownership, duplicate, evidence guards ───────────────────

describe('Task 46 §2: authorization and on-chain guards', () => {
    it('rejects a transaction included after the authorization deadline', async () => {
        const { store, prepared } = await prepareIntent();
        store.update(prepared.paymentRecord.paymentId, {
            deadline: Date.now() - 60_000,
            deadlineIso: new Date(Date.now() - 60_000).toISOString(),
        });

        await assert.rejects(
            () => verifyIntent({ store, prepared }),
            (err) => err instanceof PaymentAuthorizationError && err.code === 'AUTHORIZATION_EXPIRED'
        );
    });

    it('rejects a stale authorization when the token nonce already advanced', async () => {
        const { store, prepared } = await prepareIntent();
        await assert.rejects(
            () => verifyIntent({
                store,
                prepared,
                fetchImpl: makeIntentRpcMock({ nonceBefore: 5, nonceAfter: 6 }),
            }),
            (err) => err instanceof PaymentAuthorizationError && err.code === 'STALE_AUTHORIZATION'
        );
    });

    it('rejects execution when ownership changed after preparation', async () => {
        const { store, prepared } = await prepareIntent();
        await assert.rejects(
            () => verifyIntent({
                store,
                prepared,
                fetchImpl: makeIntentRpcMock({ ownerAtExecution: 'intruder.testnet' }),
            }),
            (err) => err instanceof PaymentAuthorizationError && err.code === 'OWNERSHIP_MISMATCH'
        );
    });

    it('returns RecoveryRequired when the subaccount was not actually debited', async () => {
        const { store, prepared } = await prepareIntent();
        const result = await verifyIntent({
            store,
            prepared,
            fetchImpl: makeIntentRpcMock({ assocAfter: '1749930000000000000000000' }),
        });
        assert.equal(result.verified, false);
        assert.equal(result.recoveryRequired, true);
        assert.match(result.reason, /balance evidence/i);
    });

    it('returns RecoveryRequired when the receiver was not credited', async () => {
        const { store, prepared } = await prepareIntent();
        const result = await verifyIntent({
            store,
            prepared,
            fetchImpl: makeIntentRpcMock({ receiverAfter: '5889316574544037299999999' }),
        });
        assert.equal(result.verified, false);
        assert.equal(result.recoveryRequired, true);
    });

    it('is idempotent for the same settled hash and rejects a different hash', async () => {
        const { store, prepared } = await prepareIntent();
        const first = await verifyIntent({ store, prepared });
        assert.equal(first.verified, true);
        assert.equal(first.replayed, undefined);

        const replay = await verifyIntent({ store, prepared });
        assert.equal(replay.verified, true);
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.evidence, first.evidence);

        await assert.rejects(
            () => verifyIntent({ store, prepared, transactionHash: OTHER_TX_HASH }),
            (err) => err instanceof PaymentAuthorizationError && err.code === 'DUPLICATE_PAYMENT'
        );
    });

    it('does not settle before FINAL execution status', async () => {
        const { store, prepared } = await prepareIntent();
        const result = await verifyIntent({
            store,
            prepared,
            fetchImpl: makeIntentRpcMock({ finalStatus: 'INCLUDED' }),
        });
        assert.equal(result.verified, false);
        assert.equal(result.pending, true);
    });
});

// ── §3: Intent store serialization ───────────────────────────────────────────

describe('Task 46 §3: intent store and serialization', () => {
    it('getNearPaymentIntent returns the plan plus JSON-safe context', async () => {
        const { store, prepared } = await prepareIntent();
        const intent = getNearPaymentIntent(prepared.paymentRecord.paymentId, store);
        assert.ok(intent);
        assert.equal(intent.paymentId, prepared.paymentRecord.paymentId);
        assert.equal(intent.plan.contractId, CANONICAL_CONTRACT_ID);
        assert.equal(intent.plan.methodName, 'relay_execute_subaccount');
        assert.equal(intent.receiverId, RECEIVER);
        assert.equal(typeof intent.amountYocto, 'string');
        assert.doesNotThrow(() => JSON.stringify(intent));
    });

    it('unknown or malformed payment IDs return null', async () => {
        const store = createPaymentIntentStore();
        assert.equal(getNearPaymentIntent('p-unknown', store), null);
        assert.equal(getNearPaymentIntent('../etc/passwd', store), null);
    });
});

// ── §4: UI normalization ─────────────────────────────────────────────────────

describe('Task 46 §4: checkout UI normalization', () => {
    it('normalizes the real server response shape (transactionPlan/payment)', async () => {
        const { prepared } = await prepareIntent();
        const normalized = normalizeNearPaymentPrepare({
            transactionPlan: prepared.plan,
            payment: prepared.paymentRecord,
            currentState: prepared.currentState,
        });
        assert.equal(normalized.plan.contractId, CANONICAL_CONTRACT_ID);
        assert.equal(normalized.record.paymentId, prepared.paymentRecord.paymentId);
        assert.equal(normalized.record.receiverId, RECEIVER);
        assert.equal(normalized.currentState, prepared.currentState);
    });

    it('still accepts legacy plan/paymentRecord keys', async () => {
        const { prepared } = await prepareIntent();
        const normalized = normalizeNearPaymentPrepare({
            plan: prepared.plan,
            paymentRecord: prepared.paymentRecord,
        });
        assert.equal(normalized.plan.methodName, 'relay_execute_subaccount');
    });

    it('throws instead of returning an undefined plan', () => {
        assert.throws(() => normalizeNearPaymentPrepare(null), /empty payment preparation/i);
        assert.throws(() => normalizeNearPaymentPrepare({ prepared: true }), /transaction plan and payment record/i);
        assert.throws(
            () => normalizeNearPaymentPrepare({
                transactionPlan: { contractId: CANONICAL_CONTRACT_ID, methodName: 'other_method' },
                payment: { paymentId: 'p-1', ownerId: OWNER, receiverId: RECEIVER, amountYocto: AMOUNT },
            }),
            /unsupported transaction plan/i
        );
        assert.throws(
            () => normalizeNearPaymentPrepare({
                transactionPlan: { contractId: CANONICAL_CONTRACT_ID, methodName: 'relay_execute_subaccount' },
                payment: { paymentId: 'p-1' },
            }),
            /missing required authorization fields/i
        );
    });

    it('normalizes a restored intent into the same record shape', async () => {
        const { store, prepared } = await prepareIntent();
        const intent = getNearPaymentIntent(prepared.paymentRecord.paymentId, store);
        const normalized = normalizeNearPaymentIntent(intent);
        assert.equal(normalized.record.paymentId, intent.paymentId);
        assert.equal(normalized.record.ownerId, OWNER);
        assert.equal(normalized.record.receiverId, RECEIVER);
        assert.equal(normalized.plan.methodName, 'relay_execute_subaccount');
    });

    it('maps checkout states without optimistic success labels', () => {
        assert.equal(nearPaymentPresentation('Prepared').tone, 'warning');
        assert.equal(nearPaymentPresentation('Finalized').tone, 'success');
        assert.equal(nearPaymentPresentation('Expired').tone, 'danger');
        assert.equal(nearPaymentPresentation('WalletMismatch').label, 'WALLET MISMATCH');
    });
});

// ── §5: Browser wiring regression checks ─────────────────────────────────────

describe('Task 46 §5: browser wiring', () => {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
    const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

    it('prepares the payment through the server and keeps the returned plan intact', () => {
        assert.match(appSource, /\/api\/payment\/prepare-near/);
        assert.match(appSource, /state\.spend\.plan = plan;/);
        assert.doesNotMatch(appSource, /currentNearPayPlan = result\.plan/);
    });

    it('verify requests carry paymentId and not client-authored expected fields', () => {
        assert.match(appSource, /body: \{\s*paymentId,\s*tokenId,\s*transactionHash,\s*\}/);
        assert.doesNotMatch(appSource, /expectedOwner:/);
        assert.doesNotMatch(appSource, /expectedReceiver:/);
        assert.doesNotMatch(appSource, /expectedAmountYocto:/);
    });

    it('wallet submission uses the adapter receiverId/actions shape', () => {
        assert.match(appSource, /state\.adapter\.signAndSendTransaction\(\{[\s\S]*receiverId: txPlan\.contractId/);
        assert.match(appSource, /type: 'FunctionCall'/);
        assert.match(appSource, /deposit: txPlan\.attachedDepositYocto/);
    });

    it('submit is blocked unless the connected account is the required signer', () => {
        assert.match(appSource, /requiredSigner = txPlan\.requiredSigner/);
        assert.match(appSource, /state\.wallet\.accountId !== requiredSigner/);
        assert.match(appSource, /Submission is blocked/);
    });

    it('verification uses the Task 46 verify endpoint and treats pending as not-final', () => {
        assert.match(appSource, /\/api\/payment\/verify-near/);
        assert.match(appSource, /result\.pending/);
        assert.match(appSource, /Not final yet/);
    });

    it('wallet redirects return to verification instead of claiming success', () => {
        assert.match(appSource, /result\?\.redirected/);
        assert.match(appSource, /Return with the transaction hash/);
        assert.match(appSource, /A submitted hash is not finality/);
    });

    it('unknown routes are explicit rather than fabricated', () => {
        assert.match(appSource, /function notFoundPage\(\)/);
        assert.match(appSource, /The route was not found\. Nothing was fabricated to fill the space\./);
    });

    it('HTML shell exposes the SPA mounts and no inline scripts, styles, or handlers', () => {
        for (const id of ['app', 'toast-region', 'dialog-root']) {
            assert.match(htmlSource, new RegExp(`id="${id}"`), `Missing #${id}`);
        }
        assert.doesNotMatch(htmlSource, /\sstyle="/);
        assert.doesNotMatch(htmlSource, /\son[a-z]+="/);
        assert.match(htmlSource, /<script src="\/env-shim\.js" defer><\/script>[\s\S]*wallet-selector\.bundle\.js/);
    });

    it('UI states the Testnet-only boundary and does not enable Mainnet 1Click', () => {
        assert.match(appSource, /NEAR Testnet only/);
        assert.match(appSource, /1Click execution/);
        assert.match(appSource, /Base Sepolia is read-only/);
        assert.match(appSource, /Not supported/);
        assert.doesNotMatch(appSource, /1Click execution[^<]{0,40}enabled/i);
    });
});
