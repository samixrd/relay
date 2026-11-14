'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyAccountContinuity } = require('./account-continuity');
const { deriveBaseAddress } = require('./multichain-portfolio');

test('verifyAccountContinuity asserts all 6 invariants across simulated ownership handoff', () => {
    const tokenId = 'relay-test-1';
    const contractId = 'relay.spellman.testnet';
    const canonicalSubaccount = `${tokenId}.${contractId}`;

    // Derive Base address under Owner A
    const baseA = deriveBaseAddress(canonicalSubaccount, 'relay-v1');

    // Derive Base address under Owner B
    const baseB = deriveBaseAddress(canonicalSubaccount, 'relay-v1');

    const result = verifyAccountContinuity({
        tokenId,
        contractId,
        previousOwner: 'spellman.testnet',
        currentOwner: 'relay-owner-b.spellman.testnet',
        subaccountIdBefore: canonicalSubaccount,
        subaccountIdAfter: canonicalSubaccount,
        bindingVerifiedBefore: true,
        bindingVerifiedAfter: true,
        basePredecessorBefore: canonicalSubaccount,
        basePredecessorAfter: canonicalSubaccount,
        basePathBefore: 'relay-v1',
        basePathAfter: 'relay-v1',
        baseAddressBefore: baseA.address,
        baseAddressAfter: baseB.address,
        nearBalanceBefore: '1749930000000000000000000',
        nearBalanceAfter: '1749930000000000000000000',
        storageReserveBefore: '1501800000000000000000000',
        storageReserveAfter: '1501800000000000000000000',
    });

    assert.equal(result.verified, true);
    assert.equal(result.invariants.canonicalSubaccountPreserved, true);
    assert.equal(result.invariants.baseAddressPreserved, true);
    assert.equal(result.invariants.previousOwnerDenied, true);
});

test('verifyAccountContinuity rejects mutated subaccount or changed Base address', () => {
    assert.throws(
        () => verifyAccountContinuity({
            tokenId: 'relay-test-1',
            contractId: 'relay.spellman.testnet',
            previousOwner: 'spellman.testnet',
            currentOwner: 'relay-owner-b.spellman.testnet',
            subaccountIdBefore: 'relay-test-1.relay.spellman.testnet',
            subaccountIdAfter: 'mutated-subaccount.relay.spellman.testnet', // mutated
            bindingVerifiedBefore: true,
            bindingVerifiedAfter: true,
            basePredecessorBefore: 'relay-test-1.relay.spellman.testnet',
            basePredecessorAfter: 'relay-test-1.relay.spellman.testnet',
            basePathBefore: 'relay-v1',
            basePathAfter: 'relay-v1',
            baseAddressBefore: '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D',
            baseAddressAfter: '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D',
            nearBalanceBefore: '1749930000000000000000000',
            nearBalanceAfter: '1749930000000000000000000',
            storageReserveBefore: '1501800000000000000000000',
            storageReserveAfter: '1501800000000000000000000',
        }),
        /Canonical subaccount mismatch/
    );

    assert.throws(
        () => verifyAccountContinuity({
            tokenId: 'relay-test-1',
            contractId: 'relay.spellman.testnet',
            previousOwner: 'spellman.testnet',
            currentOwner: 'relay-owner-b.spellman.testnet',
            subaccountIdBefore: 'relay-test-1.relay.spellman.testnet',
            subaccountIdAfter: 'relay-test-1.relay.spellman.testnet',
            bindingVerifiedBefore: true,
            bindingVerifiedAfter: true,
            basePredecessorBefore: 'relay-test-1.relay.spellman.testnet',
            basePredecessorAfter: 'relay-test-1.relay.spellman.testnet',
            basePathBefore: 'relay-v1',
            basePathAfter: 'relay-v1',
            baseAddressBefore: '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D',
            baseAddressAfter: '0x0000000000000000000000000000000000000000', // mutated address
            nearBalanceBefore: '1749930000000000000000000',
            nearBalanceAfter: '1749930000000000000000000',
            storageReserveBefore: '1501800000000000000000000',
            storageReserveAfter: '1501800000000000000000000',
        }),
        /Derived Base address mutated/
    );
});
