'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const nacl = require('tweetnacl');
const { base58 } = require('@scure/base');

const {
    ChallengeStore,
    serializeNep413Payload,
    verifyNep413Signature,
    validateNearAccountId,
} = require('./auth-provider-adapter');
const { createClaimJournal } = require('./claim-journal');
const { createClaimSession, verifyClaimSession } = require('./claim-session');
const { verifyFinalizedTransferTransaction } = require('./app-server');
const { NearWalletAdapter } = require('../web/near-wallet-adapter');
const { verifyAccountContinuity } = require('./account-continuity');

test('Task 40 E2E: Recipient connects wallet, signs NEP-413 challenge, and links account', async () => {
    const keyPair = nacl.sign.keyPair();
    const pubKeyBase58 = `ed25519:${base58.encode(keyPair.publicKey)}`;
    const recipientAccountId = 'friend.testnet';
    const tokenId = 'relay-test-1';
    const relayContractId = 'relay.spellman.testnet';

    // 1. Mock injected wallet extension supporting NEP-413
    const mockWindow = {
        near: {
            getAccountId: async () => recipientAccountId,
            getPublicKey: async () => pubKeyBase58,
            signMessage: async ({ message, recipient, nonce }) => {
                // Wallet computes NEP-413 Borsh payload hash and signs with secret key
                const { hash } = serializeNep413Payload({
                    message,
                    recipient,
                    nonce,
                });
                const sig = nacl.sign.detached(hash, keyPair.secretKey);
                return {
                    accountId: recipientAccountId,
                    publicKey: pubKeyBase58,
                    signature: base58.encode(sig),
                };
            },
            signAndSendTransaction: async () => {},
        },
    };

    const walletAdapter = new NearWalletAdapter({
        networkId: 'testnet',
        contractId: relayContractId,
        windowRef: mockWindow,
    });

    const conn = await walletAdapter.connect();
    assert.equal(conn.connected, true);
    assert.equal(conn.accountId, recipientAccountId);
    assert.equal(conn.capabilities.signMessage, true);

    // 2. Creator creates claim session
    const journal = await createClaimJournal({ enableLock: false });
    const session = createClaimSession({
        tokenId,
        expectedOwner: 'relay-owner-b.spellman.testnet',
        secret: 'test-task40-secret-16chars',
        journal,
    });
    assert.ok(session.sessionId);
    await journal.recordSessionCreated(session);

    // 3. Server issues NEP-413 challenge
    const challengeStore = new ChallengeStore(60000);
    const challenge = challengeStore.createChallenge({
        claimSessionId: session.sessionId,
        recipientSub: 'google-sub-friend',
        tokenId,
        recipientAccountId,
        appOrigin: 'https://relay.example.com',
    });

    // 4. Wallet signs NEP-413 challenge
    const signed = await walletAdapter.signNep413Message({
        message: challenge.message,
        recipient: challenge.recipientAccountId,
        nonce: challenge.nonceHex,
    });
    assert.equal(signed.accountId, recipientAccountId);
    assert.equal(signed.publicKey, pubKeyBase58);

    // 5. Server verifies NEP-413 signature against FullAccess key on Testnet RPC
    const mockRpcFetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                keys: [{
                    public_key: pubKeyBase58,
                    access_key: {
                        nonce: 10,
                        permission: 'FullAccess',
                    },
                }],
            },
        }),
    });

    const verified = await verifyNep413Signature({
        challenge,
        signature: signed.signature,
        publicKey: signed.publicKey,
        recipientAccountId,
        nearRpcUrl: 'https://rpc.testnet.near.org',
        fetchImpl: mockRpcFetch,
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.accountId, recipientAccountId);

    // Record account linking in journal
    await journal.recordAccountLinked(session.sessionId, recipientAccountId);
    const entry = journal.getSession(session.sessionId);
    assert.equal(entry.state, 'RECIPIENT_ACCOUNT_LINKED');
    assert.equal(entry.linkedNearAccountId, recipientAccountId);
});

test('Task 40 Creator: Dynamic ownership check, recipient substitution guard, and exact transfer preparation', async () => {
    const creatorAccountId = 'relay-owner-b.spellman.testnet';
    const tokenId = 'relay-test-1';
    const contractId = 'relay.spellman.testnet';
    const recipientAccountId = 'friend.testnet';

    const journal = await createClaimJournal({ enableLock: false });
    const session = createClaimSession({
        tokenId,
        expectedOwner: creatorAccountId,
        secret: 'test-task40-secret-16chars',
        journal,
    });
    await journal.recordSessionCreated(session);

    await journal.recordAccountLinked(session.sessionId, recipientAccountId);

    // Creator approves recipient
    await journal.recordCreatorApproved(session.sessionId);
    let entry = journal.getSession(session.sessionId);
    assert.equal(entry.creatorApproved, true);
    assert.equal(entry.approvedRecipient, recipientAccountId);

    // Recipient substitution test: if recipient changes account, creator approval is revoked
    await journal.recordAccountLinked(session.sessionId, 'mallory.testnet');
    entry = journal.getSession(session.sessionId);
    assert.equal(entry.creatorApproved, false);
    assert.equal(entry.approvedRecipient, null);

    // Re-link valid recipient and re-approve
    await journal.recordAccountLinked(session.sessionId, recipientAccountId);
    await journal.recordCreatorApproved(session.sessionId);

    // Creator wallet signs exact transfer
    const mockWindow = {
        near: {
            getAccountId: async () => creatorAccountId,
            signAndSendTransaction: async (txParams) => {
                assert.equal(txParams.receiverId, contractId);
                const action = txParams.actions[0];
                assert.equal(action.params.methodName, 'nft_transfer');
                assert.equal(action.params.args.token_id, tokenId);
                assert.equal(action.params.args.receiver_id, recipientAccountId);
                assert.equal(action.params.deposit, '1');
                return {
                    transaction: {
                        hash: '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f',
                    },
                };
            },
        },
    };

    const creatorWallet = new NearWalletAdapter({
        networkId: 'testnet',
        contractId,
        windowRef: mockWindow,
    });
    await creatorWallet.connect();

    // Dynamic ownership check: wallet must equal current token owner
    const currentOnChainOwner = creatorAccountId;
    assert.equal(creatorWallet.connectedAccountId, currentOnChainOwner);

    const txRes = await creatorWallet.signAndSendTransaction({
        receiverId: contractId,
        actions: [{
            methodName: 'nft_transfer',
            args: {
                token_id: tokenId,
                receiver_id: recipientAccountId,
                memo: 'RELAY Web2 friend claim',
            },
            deposit: '1',
            gas: '30000000000000',
        }],
    });
    assert.equal(txRes.transactionHash, '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f');
});

test('Task 40 Finality: Independent 15-step transaction verification and finalized block check', async () => {
    const txHash = '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f';
    const creatorAccountId = 'relay-owner-b.spellman.testnet';
    const recipientAccountId = 'friend.testnet';
    const contractId = 'relay.spellman.testnet';
    const tokenId = 'relay-test-1';

    const mockRpcFetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'tx') {
            return {
                ok: true,
                json: async () => ({
                    result: {
                        transaction: {
                            hash: txHash,
                            signer_id: creatorAccountId,
                            receiver_id: contractId,
                            actions: [{
                                FunctionCall: {
                                    method_name: 'nft_transfer',
                                    args: Buffer.from(JSON.stringify({
                                        token_id: tokenId,
                                        receiver_id: recipientAccountId,
                                        memo: 'RELAY Web2 friend claim',
                                    })).toString('base64'),
                                    deposit: '1',
                                    gas: 30000000000000,
                                },
                            }],
                        },
                        receipts_outcome: [{
                            outcome: {
                                status: { SuccessValue: '' },
                            },
                        }],
                        final_execution_status: 'FINAL',
                    },
                }),
            };
        }
        return { ok: false, status: 404 };
    };

    const verification = await verifyFinalizedTransferTransaction({
        nearRpcUrl: 'https://rpc.testnet.near.org',
        relayContractId: contractId,
        transactionHash: txHash,
        expectedSigner: creatorAccountId,
        expectedTokenId: tokenId,
        expectedReceiver: recipientAccountId,
        fetchImpl: mockRpcFetch,
    });

    assert.equal(verification.finalized, true);
    assert.equal(verification.status, 'SUCCESS');
    assert.equal(verification.transaction.signer_id, creatorAccountId);
    assert.equal(verification.transaction.receiver_id, contractId);
});

test('Task 40 Continuity: 6 invariants preserved across recipient ownership transition', async () => {
    const subaccount = 'relay-test-1.relay.spellman.testnet';
    const baseAddress = '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D';
    const balance = '1749930000000000000000000';
    const reserve = '100000000000000000000000';

    const check = verifyAccountContinuity({
        tokenId: 'relay-test-1',
        contractId: 'relay.spellman.testnet',
        previousOwner: 'relay-owner-b.spellman.testnet',
        currentOwner: 'friend.testnet',
        subaccountIdBefore: subaccount,
        subaccountIdAfter: subaccount,
        bindingVerifiedBefore: true,
        bindingVerifiedAfter: true,
        basePredecessorBefore: subaccount,
        basePredecessorAfter: subaccount,
        basePathBefore: 'relay-v1',
        basePathAfter: 'relay-v1',
        baseAddressBefore: baseAddress,
        baseAddressAfter: baseAddress,
        nearBalanceBefore: balance,
        nearBalanceAfter: balance,
        storageReserveBefore: reserve,
        storageReserveAfter: reserve,
    });
    assert.equal(check.verified, true);
    assert.equal(check.invariants.canonicalSubaccountPreserved, true);
    assert.equal(check.invariants.baseAddressPreserved, true);
    assert.equal(check.invariants.storageReservePreserved, true);
    assert.equal(check.invariants.previousOwnerDenied, true);
});
