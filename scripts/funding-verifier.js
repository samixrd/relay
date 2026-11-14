'use strict';

const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{40,55}$/;

function failure(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/**
 * Independently verifies a finalized native NEAR Transfer into a card's
 * associated sub-account. This only reads chain state; it never constructs or
 * signs a transfer.
 */
async function verifyFundingTransaction({
    rpcUrl,
    transactionHash,
    expectedSender,
    expectedReceiver,
    expectedAmountYocto,
    fetchImpl = globalThis.fetch,
}) {
    if (!TX_HASH_RE.test(transactionHash || '')) {
        throw failure('Invalid NEAR transaction hash format.', 'INVALID_TRANSACTION_HASH');
    }
    if (!expectedReceiver || typeof expectedReceiver !== 'string') {
        throw failure('Expected receiver is required.', 'INVALID_RECEIVER');
    }

    let rpcBody;
    try {
        const response = await fetchImpl(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'relay-funding-verify',
                method: 'tx',
                params: [transactionHash, expectedSender],
            }),
        });
        if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
        rpcBody = await response.json();
    } catch (error) {
        return { verified: false, pending: true, reason: `Transaction lookup failed: ${error.message}` };
    }

    if (rpcBody.error || !rpcBody.result?.transaction) {
        return { verified: false, pending: true, reason: 'Transaction is not yet visible on NEAR Testnet.' };
    }

    const { transaction, final_execution_status: finalStatus, receipts_outcome: receipts } = rpcBody.result;
    if (transaction.signer_id !== expectedSender) {
        throw failure(`Transaction signer ${transaction.signer_id} does not match connected sender ${expectedSender}.`, 'SIGNER_MISMATCH');
    }
    if (transaction.receiver_id !== expectedReceiver) {
        throw failure(`Transaction receiver ${transaction.receiver_id} does not match card account ${expectedReceiver}.`, 'RECEIVER_MISMATCH');
    }
    const actions = Array.isArray(transaction.actions) ? transaction.actions : [];
    if (actions.length !== 1 || !actions[0]?.Transfer) {
        throw failure('Transaction must contain exactly one native NEAR Transfer action.', 'ACTION_MISMATCH');
    }
    const amount = String(actions[0].Transfer.deposit);
    if (expectedAmountYocto && amount !== String(expectedAmountYocto)) {
        throw failure(`Transferred amount ${amount} yoctoNEAR does not match the prepared amount.`, 'AMOUNT_MISMATCH');
    }
    if ((receipts || []).some((receipt) => receipt?.outcome?.status?.Failure !== undefined)) {
        throw failure('The funding transaction has a failed receipt.', 'RECEIPT_FAILED');
    }
    const finalized = finalStatus === 'FINAL' && rpcBody.result.status?.SuccessValue !== undefined;
    if (!finalized) {
        return {
            verified: false,
            pending: true,
            reason: `Transaction final execution status is ${finalStatus || 'unknown'}; waiting for FINAL.`,
        };
    }

    return {
        verified: true,
        pending: false,
        transactionHash,
        signerId: transaction.signer_id,
        receiverId: transaction.receiver_id,
        amountYocto: amount,
        amountNear: formatYoctoNear(amount),
        explorerUrl: `https://testnet.nearblocks.io/txns/${transactionHash}`,
    };
}

function formatYoctoNear(yocto) {
    try {
        const value = BigInt(yocto);
        const whole = value / 10n ** 24n;
        const fraction = (value % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
        return fraction ? `${whole}.${fraction}` : `${whole}`;
    } catch {
        return String(yocto);
    }
}

module.exports = {
    formatYoctoNear,
    verifyFundingTransaction,
};
