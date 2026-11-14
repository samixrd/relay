'use strict';

(function exposeRelayUi(root) {
    const checkoutStates = Object.freeze({
        requested: { label: 'QUOTE REQUESTED', tone: 'neutral' },
        verified: { label: 'QUOTE VERIFIED', tone: 'success' },
        awaitingDeposit: { label: 'AWAITING DEPOSIT', tone: 'warning' },
        depositDetected: { label: 'DEPOSIT DETECTED', tone: 'warning' },
        processing: { label: 'PROCESSING', tone: 'warning' },
        destinationVerified: { label: 'DESTINATION VERIFIED', tone: 'success' },
        refundVerified: { label: 'REFUND VERIFIED', tone: 'success' },
        recoveryRequired: { label: 'RECOVERY REQUIRED', tone: 'danger' },
        unavailable: { label: 'UNAVAILABLE', tone: 'danger' },
    });

    const claimStates = Object.freeze({
        ready_for_recipient: { label: 'READY TO CLAIM', tone: 'success', description: 'NFT and multi-chain accounts ready to be transferred to recipient.' },
        claimed: { label: 'CLAIMED', tone: 'neutral', description: 'Ownership has already been transferred to recipient.' },
        CREATED: { label: 'SESSION CREATED', tone: 'neutral', description: 'Claim session link created by creator.' },
        RECIPIENT_AUTHENTICATED: { label: 'RECIPIENT AUTHENTICATED', tone: 'success', description: 'Recipient signed in with genuine Google OIDC.' },
        RECIPIENT_ACCOUNT_LINKED: { label: 'NEAR ACCOUNT LINKED', tone: 'success', description: 'Recipient linked verified NEAR Testnet account.' },
        AWAITING_CREATOR_APPROVAL: { label: 'AWAITING CREATOR APPROVAL', tone: 'warning', description: 'Linked recipient account is awaiting creator approval.' },
        TRANSFER_PREPARED: { label: 'TRANSFER PREPARED', tone: 'warning', description: 'Transfer transaction prepared; awaiting owner signature.' },
        TRANSFER_SUBMITTED: { label: 'TRANSFER SUBMITTED', tone: 'warning', description: 'Transaction submitted; awaiting block finality.' },
        AWAITING_FINALITY: { label: 'AWAITING FINALITY', tone: 'warning', description: 'Transaction submitted to NEAR Testnet; waiting for block finality.' },
        TRANSFER_FINALIZED: { label: 'OWNERSHIP FINALIZED', tone: 'success', description: 'NFT transferred and ownership verified on-chain.' },
        EXPIRED: { label: 'SESSION EXPIRED', tone: 'danger', description: 'Claim session has expired.' },
        CANCELLED: { label: 'SESSION CANCELLED', tone: 'neutral', description: 'Claim session cancelled by creator.' },
        FAILED: { label: 'TRANSFER FAILED', tone: 'danger', description: 'Ownership transfer failed on-chain.' },
        unavailable: { label: 'UNAVAILABLE', tone: 'danger', description: 'Claim status could not be verified.' },
    });

    const walletStates = Object.freeze({
        disconnected: { label: 'Connect NEAR wallet', tone: 'neutral' },
        connected: { label: 'Wallet connected', tone: 'success' },
        mismatch: { label: 'Wallet account mismatch', tone: 'danger' },
        awaitingSignature: { label: 'Wallet awaiting signature', tone: 'warning' },
        submitted: { label: 'Transaction submitted', tone: 'warning' },
    });

    const verificationStates = Object.freeze({
        unverified: { label: 'Verify account ownership', tone: 'neutral' },
        awaitingApproval: { label: 'Awaiting creator approval', tone: 'warning' },
        readyForSignature: { label: 'Ready for creator signature', tone: 'warning' },
        submitted: { label: 'Transaction submitted', tone: 'warning' },
        awaitingFinality: { label: 'Awaiting finality', tone: 'warning' },
        finalized: { label: 'Ownership finalized', tone: 'success' },
        inconclusive: { label: 'Verification inconclusive', tone: 'danger' },
    });

    function checkoutPresentation(state) {
        return checkoutStates[state] || checkoutStates.unavailable;
    }

    function claimPresentation(state) {
        return claimStates[state] || claimStates.unavailable;
    }

    function walletPresentation(state) {
        return walletStates[state] || walletStates.disconnected;
    }

    function verificationPresentation(state) {
        return verificationStates[state] || verificationStates.unverified;
    }

    function authPresentation(configured) {
        if (configured) {
            return {
                label: 'GOOGLE AUTH CONFIGURED',
                tone: 'success',
                message: 'OAuth 2.0 active. Web2 recipient can claim with a Google account.',
            };
        }
        return {
            label: 'GOOGLE AUTH UNCONFIGURED',
            tone: 'warning',
            message: 'Credentials missing in .env. Honest preview mode active; no fake login displayed.',
        };
    }

    function canTransferOwnership(account) {
        return Boolean(account && account.locked === false && account.token?.ownerId);
    }

    function formatNear(yocto) {
        if (typeof yocto !== 'string' || !/^\d+$/.test(yocto)) return '—';
        const value = BigInt(yocto);
        const whole = value / 10n ** 24n;
        const fraction = (value % 10n ** 24n).toString().padStart(24, '0').slice(0, 5);
        return `${whole.toLocaleString('en-US')}.${fraction}`;
    }

    function formatUnits(rawAmount, decimals = 18, maxFraction = 4) {
        if (rawAmount === null || rawAmount === undefined || typeof rawAmount !== 'string' || !/^\d+$/.test(rawAmount)) {
            return '—';
        }
        const amount = BigInt(rawAmount);
        const base = 10n ** BigInt(decimals);
        const whole = amount / base;
        const remainder = amount % base;
        if (remainder === 0n) return whole.toLocaleString('en-US');
        const fractionStr = remainder.toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
        return fractionStr ? `${whole.toLocaleString('en-US')}.${fractionStr}` : whole.toLocaleString('en-US');
    }

    function shorten(value, start = 10, end = 7) {
        if (typeof value !== 'string' || value.length <= start + end + 3) return value || '—';
        return `${value.slice(0, start)}…${value.slice(-end)}`;
    }

    const nearPaymentStates = Object.freeze({
        Prepared: { label: 'PREPARED', tone: 'warning' },
        AwaitingWallet: { label: 'AWAITING WALLET APPROVAL', tone: 'warning' },
        Submitted: { label: 'SUBMITTED — AWAITING FINALITY', tone: 'warning' },
        Finalized: { label: 'FINALIZED', tone: 'success' },
        Failed: { label: 'FAILED', tone: 'danger' },
        RecoveryRequired: { label: 'RECOVERY REQUIRED', tone: 'danger' },
        WalletRequired: { label: 'WALLET NOT CONNECTED', tone: 'neutral' },
        WalletMismatch: { label: 'WALLET MISMATCH', tone: 'danger' },
        Expired: { label: 'AUTHORIZATION EXPIRED', tone: 'danger' },
        RpcError: { label: 'RPC ERROR', tone: 'danger' },
    });

    function nearPaymentPresentation(status) {
        return nearPaymentStates[status] || nearPaymentStates.Prepared;
    }

    /**
     * Normalizes /api/payment/prepare-near into the exact fields the checkout
     * UI renders. Throws instead of silently proceeding with an undefined plan.
     */
    function normalizeNearPaymentPrepare(result) {
        if (!result || typeof result !== 'object') {
            throw new Error('The server returned an empty payment preparation response.');
        }
        const plan = result.transactionPlan || result.plan || null;
        const record = result.payment || result.paymentRecord || null;
        if (!plan || !record) {
            throw new Error('The server response did not include a transaction plan and payment record.');
        }
        if (!plan.contractId || plan.methodName !== 'relay_execute_subaccount') {
            throw new Error('The server returned an unsupported transaction plan.');
        }
        if (!record.paymentId || !record.ownerId || !record.receiverId || !record.amountYocto) {
            throw new Error('The payment record is missing required authorization fields.');
        }
        return {
            plan,
            record,
            currentState: result.currentState || null,
            review: result.review || null,
            response: result,
        };
    }

    /**
     * Rebuilds the checkout review inputs from a server-side payment intent,
     * used when resuming after a wallet redirect or page reload.
     */
    function normalizeNearPaymentIntent(intent) {
        if (!intent || typeof intent !== 'object' || !intent.plan) {
            throw new Error('The payment authorization could not be restored.');
        }
        return {
            plan: intent.plan,
            record: {
                paymentId: intent.paymentId,
                status: intent.status,
                network: intent.network,
                relayContractId: intent.relayContractId,
                tokenId: intent.tokenId,
                associatedAccountId: intent.associatedAccountId,
                ownerId: intent.ownerId,
                receiverId: intent.receiverId,
                amountYocto: intent.amountYocto,
                amountFormatted: intent.amountFormatted,
                expectedTokenNonce: intent.expectedTokenNonce,
                currentTokenNonce: intent.expectedTokenNonce,
                deadline: intent.deadline,
                deadlineIso: intent.deadlineIso,
                receiverBalanceBeforeYocto: intent.receiverBalanceBeforeYocto,
                associatedBalanceBeforeYocto: intent.associatedBalanceBeforeYocto,
                transactionHash: intent.transactionHash || null,
                settledAt: intent.settledAt || null,
                evidence: intent.evidence || null,
            },
            currentState: null,
            review: null,
        };
    }

    const api = Object.freeze({
        authPresentation,
        canTransferOwnership,
        checkoutPresentation,
        claimPresentation,
        formatNear,
        formatUnits,
        nearPaymentPresentation,
        normalizeNearPaymentIntent,
        normalizeNearPaymentPrepare,
        shorten,
        verificationPresentation,
        walletPresentation,
    });

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.RelayUiState = api;
})(typeof window !== 'undefined' ? window : null);
