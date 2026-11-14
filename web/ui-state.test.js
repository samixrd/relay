'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    authPresentation,
    canTransferOwnership,
    checkoutPresentation,
    claimPresentation,
    formatNear,
    formatUnits,
    shorten,
    verificationPresentation,
    walletPresentation,
} = require('./ui-state');

test('checkout states describe verification and recovery without optimistic success', () => {
    assert.equal(checkoutPresentation('verified').label, 'QUOTE VERIFIED');
    assert.equal(checkoutPresentation('destinationVerified').label, 'DESTINATION VERIFIED');
    assert.equal(checkoutPresentation('recoveryRequired').tone, 'danger');
    assert.equal(checkoutPresentation('unknown').label, 'UNAVAILABLE');
});

test('claim states describe recipient onboarding without simulated transfers', () => {
    assert.equal(claimPresentation('ready_for_recipient').label, 'READY TO CLAIM');
    assert.equal(claimPresentation('ready_for_recipient').tone, 'success');
    assert.equal(claimPresentation('claimed').label, 'CLAIMED');
    assert.equal(claimPresentation('CREATED').label, 'SESSION CREATED');
    assert.equal(claimPresentation('RECIPIENT_AUTHENTICATED').label, 'RECIPIENT AUTHENTICATED');
    assert.equal(claimPresentation('RECIPIENT_ACCOUNT_LINKED').label, 'NEAR ACCOUNT LINKED');
    assert.equal(claimPresentation('AWAITING_CREATOR_APPROVAL').label, 'AWAITING CREATOR APPROVAL');
    assert.equal(claimPresentation('TRANSFER_PREPARED').label, 'TRANSFER PREPARED');
    assert.equal(claimPresentation('TRANSFER_FINALIZED').label, 'OWNERSHIP FINALIZED');
    assert.equal(claimPresentation('unknown').label, 'UNAVAILABLE');
});

test('auth presentation honestly reflects credential status without fake login', () => {
    const configured = authPresentation(true);
    assert.equal(configured.label, 'GOOGLE AUTH CONFIGURED');
    assert.equal(configured.tone, 'success');

    const unconfigured = authPresentation(false);
    assert.equal(unconfigured.label, 'GOOGLE AUTH UNCONFIGURED');
    assert.equal(unconfigured.tone, 'warning');
    assert.match(unconfigured.message, /Credentials missing in \.env/);
});

test('ownership transfer eligibility requires a loaded unlocked account', () => {
    assert.equal(canTransferOwnership(null), false);
    assert.equal(canTransferOwnership({ locked: true, token: { ownerId: 'owner.near' } }), false);
    assert.equal(canTransferOwnership({ locked: false, token: { ownerId: 'owner.near' } }), true);
});

test('NEAR balance formatter preserves large integer precision', () => {
    assert.equal(formatNear('1000000000000000000000000'), '1.00000');
    assert.equal(formatNear('1234567890123456789012345'), '1.23456');
    assert.equal(formatNear('not-a-balance'), '—');
});

test('formatUnits handles custom decimals and formatting', () => {
    assert.equal(formatUnits('1000000000000000000', 18), '1');
    assert.equal(formatUnits('1500000000000000000', 18), '1.5');
    assert.equal(formatUnits('50000000', 6), '50');
    assert.equal(formatUnits('1234567', 6), '1.2345');
    assert.equal(formatUnits('bad', 6), '—');
});

test('wallet presentation accurately describes wallet connection and signing states', () => {
    assert.equal(walletPresentation('disconnected').label, 'Connect NEAR wallet');
    assert.equal(walletPresentation('disconnected').tone, 'neutral');
    assert.equal(walletPresentation('connected').label, 'Wallet connected');
    assert.equal(walletPresentation('connected').tone, 'success');
    assert.equal(walletPresentation('mismatch').label, 'Wallet account mismatch');
    assert.equal(walletPresentation('mismatch').tone, 'danger');
    assert.equal(walletPresentation('awaitingSignature').label, 'Wallet awaiting signature');
    assert.equal(walletPresentation('awaitingSignature').tone, 'warning');
    assert.equal(walletPresentation('submitted').label, 'Transaction submitted');
    assert.equal(walletPresentation('submitted').tone, 'warning');
    assert.equal(walletPresentation('unknown').label, 'Connect NEAR wallet');
});

test('verification presentation reflects handoff lifecycle stages', () => {
    assert.equal(verificationPresentation('unverified').label, 'Verify account ownership');
    assert.equal(verificationPresentation('unverified').tone, 'neutral');
    assert.equal(verificationPresentation('awaitingApproval').label, 'Awaiting creator approval');
    assert.equal(verificationPresentation('awaitingApproval').tone, 'warning');
    assert.equal(verificationPresentation('readyForSignature').label, 'Ready for creator signature');
    assert.equal(verificationPresentation('submitted').label, 'Transaction submitted');
    assert.equal(verificationPresentation('awaitingFinality').label, 'Awaiting finality');
    assert.equal(verificationPresentation('finalized').label, 'Ownership finalized');
    assert.equal(verificationPresentation('finalized').tone, 'success');
    assert.equal(verificationPresentation('inconclusive').label, 'Verification inconclusive');
    assert.equal(verificationPresentation('inconclusive').tone, 'danger');
    assert.equal(verificationPresentation('unknown').label, 'Verify account ownership');
});

test('shortens references without changing small values', () => {
    assert.equal(shorten('abc'), 'abc');
    assert.equal(shorten('12345678901234567890', 5, 4), '12345…7890');
});
