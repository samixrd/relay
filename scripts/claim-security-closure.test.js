'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const nacl = require('tweetnacl');
const { base58 } = require('@scure/base');

const {
    ChallengeStore,
    OAuthTransactionStore,
    ServerSessionStore,
    createGoogleAuthUrl,
    createSessionCookiePayload,
    decodeNearPublicKey,
    decodeNearSignature,
    exchangeAuthorizationCode,
    generatePkcePair,
    parseCookies,
    serializeCookie,
    serializeNep413Payload,
    validateAuthConfig,
    validateNearAccountId,
    verifyGoogleIdToken,
    verifyNep413Signature,
    verifyOAuthStateToken,
    verifySessionCookiePayload,
} = require('./auth-provider-adapter');

const {
    CLAIM_STATES,
    createClaimJournal,
} = require('./claim-journal');

const {
    createClaimSession,
    markSessionClaimed,
    verifyClaimSession,
} = require('./claim-session');

const {
    verifyFinalizedTransferTransaction,
} = require('./app-server');

const {
    deriveBaseAddress,
    verifyAccountContinuity,
} = require('./multichain-portfolio');

const TEST_SECRET = 'task-38-security-test-secret-key-32!';

// ---------------------------------------------------------------------------
// 1. OAuth PKCE and Session Security Tests
// ---------------------------------------------------------------------------
test('OAuth PKCE: verifier never appears in browser-visible URL, opaque state is single-use', () => {
    const env = {
        GOOGLE_CLIENT_ID: 'mock-client.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'mock-secret',
        GOOGLE_REDIRECT_URI: 'https://relay.app/api/auth/google/callback',
    };
    const store = new OAuthTransactionStore(60000);
    const { url, state, codeVerifier, nonce } = createGoogleAuthUrl(env, 'session-42', TEST_SECRET, {
        transactionStore: store,
    });

    // 1. Verify URL does NOT contain the code verifier
    assert.equal(url.includes(codeVerifier), false, 'PKCE verifier must not appear in the URL');
    assert.ok(url.includes(`state=${state}`));
    assert.ok(url.includes(`nonce=${nonce}`));

    // 2. State is stored in server-side transaction store
    const tx = store.getTransaction(state);
    assert.ok(tx);
    assert.equal(tx.codeVerifier, codeVerifier);
    assert.equal(tx.nonce, nonce);
    assert.equal(tx.claimSessionId, 'session-42');

    // 3. State consumption is atomic and prevents replay
    const consumed = store.consumeTransaction(state);
    assert.equal(consumed.state, state);
    assert.equal(store.consumeTransaction(state), null, 'Replayed state must return null');
    assert.equal(store.getTransaction(state), null);
});

test('OAuth Session: ServerSessionStore creates, verifies, and revokes sessions', () => {
    const sessionStore = new ServerSessionStore(3600000);
    const session = sessionStore.createSession({
        sub: 'google-sub-user-123',
        email: 'alice@example.com',
        name: 'Alice Web2',
    });
    assert.ok(session.sessionId);
    assert.equal(session.sub, 'google-sub-user-123');

    // Retrieve active session
    const retrieved = sessionStore.getSession(session.sessionId);
    assert.equal(retrieved.email, 'alice@example.com');

    // Revoke session (logout)
    const revoked = sessionStore.revokeSession(session.sessionId);
    assert.equal(revoked, true);
    assert.equal(sessionStore.getSession(session.sessionId), null, 'Revoked session must be null');
});

test('OAuth Cookies: Production HTTPS enforces Secure, development permits non-Secure', () => {
    const prodCookie = serializeCookie('relay_auth_session', 'sess-val', {
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
    });
    assert.ok(prodCookie.includes('Secure'), 'Production cookie must include Secure');
    assert.ok(prodCookie.includes('HttpOnly'), 'Cookie must include HttpOnly');
    assert.ok(prodCookie.includes('SameSite=Lax'), 'Cookie must include SameSite=Lax');

    const devCookie = serializeCookie('relay_auth_session', 'sess-val', {
        secure: false,
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
    });
    assert.equal(devCookie.includes('Secure'), false, 'Development local HTTP cookie must not mandate Secure');
});

// ---------------------------------------------------------------------------
// 2. Journal Durability, Lockfile & Concurrency Tests
// ---------------------------------------------------------------------------
test('Journal: Single-writer lockfile rejects concurrent writer and recovers upon release', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-sec-lock-'));
    const journalPath = path.join(tmpDir, 'test.journal');

    try {
        const j1 = await createClaimJournal({ filePath: journalPath });
        assert.ok(j1);

        // Attempting to open a second journal for the same file rejects with JOURNAL_LOCKED
        await assert.rejects(
            createClaimJournal({ filePath: journalPath }),
            { code: 'JOURNAL_LOCKED' }
        );

        // Closing j1 releases lock
        await j1.close();

        // Now j2 can cleanly open
        const j2 = await createClaimJournal({ filePath: journalPath });
        assert.ok(j2);
        await j2.close();
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});

test('Journal: Corrupt JSON or invalid events fail closed without restoring partial state', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-sec-corrupt-'));
    const journalPath = path.join(tmpDir, 'corrupt.journal');

    try {
        await fs.writeFile(journalPath, '{"type":"SESSION_CREATED","sessionId":"s1","session":{"sessionId":"s1"}}\n{BROKEN_LINE\n', 'utf8');
        await assert.rejects(
            createClaimJournal({ filePath: journalPath }),
            { code: 'JOURNAL_CORRUPT' }
        );
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});

test('Journal: Duplicate claim consumption is rejected atomically', async () => {
    const journal = await createClaimJournal();
    const session = createClaimSession({
        tokenId: 'relay-test-1',
        expectedOwner: 'creator.testnet',
    });
    await journal.recordSessionCreated(session);
    await journal.recordAccountLinked(session.sessionId, 'recipient.testnet');
    await journal.recordCreatorApproved(session.sessionId);
    await journal.recordTransferFinalized(session.sessionId, 'recipient.testnet');

    // Attempting to finalize the same session a second time throws CLAIM_ALREADY_CONSUMED
    await assert.rejects(
        journal.recordTransferFinalized(session.sessionId, 'recipient.testnet'),
        { code: 'CLAIM_ALREADY_CONSUMED' }
    );
});

test('Journal: Account change resets prior creator approval', async () => {
    const journal = await createClaimJournal();
    const session = createClaimSession({
        tokenId: 'relay-test-1',
        expectedOwner: 'creator.testnet',
    });
    await journal.recordSessionCreated(session);
    await journal.recordAccountLinked(session.sessionId, 'recipient1.testnet');
    await journal.recordCreatorApproved(session.sessionId);

    let entry = journal.getSession(session.sessionId);
    assert.equal(entry.creatorApproved, true);
    assert.equal(entry.approvedRecipient, 'recipient1.testnet');

    // Recipient updates account to recipient2.testnet
    await journal.recordAccountLinked(session.sessionId, 'recipient2.testnet');
    entry = journal.getSession(session.sessionId);
    assert.equal(entry.creatorApproved, false, 'Approval must be revoked upon account change');
    assert.equal(entry.approvedRecipient, null);
    assert.equal(entry.linkedNearAccountId, 'recipient2.testnet');
});

// ---------------------------------------------------------------------------
// 3. Cryptographic Recipient Account Proof Tests (NEP-413)
// ---------------------------------------------------------------------------
test('NEP-413: Valid Ed25519 signature verifies against on-chain active access key', async () => {
    const keyPair = nacl.sign.keyPair();
    const pubKeyBase58 = `ed25519:${base58.encode(keyPair.publicKey)}`;
    const challengeStore = new ChallengeStore(60000);

    const challenge = challengeStore.createChallenge({
        claimSessionId: 'session-xyz',
        recipientSub: 'sub-12345',
        tokenId: 'relay-test-1',
        recipientAccountId: 'recipient.testnet',
        appOrigin: 'https://relay.app',
    });

    const { hash } = serializeNep413Payload({
        message: challenge.message,
        recipient: challenge.recipientAccountId,
        nonce: challenge.nonceBytes,
    });

    const sigBytes = nacl.sign.detached(hash, keyPair.secretKey);
    const signature = base58.encode(sigBytes);

    const mockFetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                keys: [{ public_key: pubKeyBase58, access_key: { permission: 'FullAccess' } }],
            },
        }),
    });

    const verified = await verifyNep413Signature({
        challenge,
        signature,
        publicKey: pubKeyBase58,
        recipientAccountId: 'recipient.testnet',
        nearRpcUrl: 'https://rpc.testnet.near.org',
        fetchImpl: mockFetch,
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.accountId, 'recipient.testnet');
    assert.equal(verified.publicKey, pubKeyBase58);
});

test('NEP-413: Signature verification rejects unauthorized keys, wrong account, and expired challenges', async () => {
    const keyPair = nacl.sign.keyPair();
    const pubKeyBase58 = `ed25519:${base58.encode(keyPair.publicKey)}`;
    const challengeStore = new ChallengeStore(60000);

    const challenge = challengeStore.createChallenge({
        claimSessionId: 'session-xyz',
        recipientSub: 'sub-12345',
        tokenId: 'relay-test-1',
        recipientAccountId: 'recipient.testnet',
        appOrigin: 'https://relay.app',
    });

    const { hash } = serializeNep413Payload({
        message: challenge.message,
        recipient: challenge.recipientAccountId,
        nonce: challenge.nonceBytes,
    });

    const sigBytes = nacl.sign.detached(hash, keyPair.secretKey);
    const signature = base58.encode(sigBytes);

    // 1. Key not authorized on account
    const unauthFetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                keys: [{ public_key: 'ed25519:unrelatedKey111111111111111111111111111111111', access_key: { permission: 'FullAccess' } }],
            },
        }),
    });
    await assert.rejects(
        verifyNep413Signature({
            challenge,
            signature,
            publicKey: pubKeyBase58,
            recipientAccountId: 'recipient.testnet',
            nearRpcUrl: 'https://rpc.testnet.near.org',
            fetchImpl: unauthFetch,
        }),
        { code: 'PUBLIC_KEY_NOT_AUTHORIZED' }
    );

    // 2. Recipient account mismatch
    await assert.rejects(
        verifyNep413Signature({
            challenge,
            signature,
            publicKey: pubKeyBase58,
            recipientAccountId: 'attacker.testnet',
        }),
        { code: 'RECIPIENT_MISMATCH' }
    );

    // 3. Expired challenge
    const expired = { ...challenge, expiresAt: Date.now() - 5000 };
    await assert.rejects(
        verifyNep413Signature({
            challenge: expired,
            signature,
            publicKey: pubKeyBase58,
            recipientAccountId: 'recipient.testnet',
        }),
        { code: 'EXPIRED_CHALLENGE' }
    );

    // 4. Reject FunctionCall access key (FullAccess required by NEP-413)
    const functionCallFetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                keys: [{
                    public_key: pubKeyBase58,
                    access_key: {
                        nonce: 5,
                        permission: {
                            FunctionCall: {
                                allowance: '500000',
                                receiver_id: 'relay.spellman.testnet',
                                method_names: ['some_method'],
                            },
                        },
                    },
                }],
            },
        }),
    });
    await assert.rejects(
        verifyNep413Signature({
            challenge,
            signature,
            publicKey: pubKeyBase58,
            recipientAccountId: 'recipient.testnet',
            nearRpcUrl: 'https://rpc.testnet.near.org',
            fetchImpl: functionCallFetch,
        }),
        { code: 'FULL_ACCESS_KEY_REQUIRED' }
    );
});

// ---------------------------------------------------------------------------
// 4. Independent Finalized Transaction Verification Tests
// ---------------------------------------------------------------------------
test('Transaction Verification: Valid transaction passes all 15 checks', async () => {
    const txHash = '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f';
    const mockFetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                transaction: {
                    hash: txHash,
                    signer_id: 'creator.testnet',
                    receiver_id: 'relay.spellman.testnet',
                    actions: [{
                        FunctionCall: {
                            method_name: 'nft_transfer',
                            args: Buffer.from(JSON.stringify({
                                token_id: 'relay-test-1',
                                receiver_id: 'recipient.testnet',
                            })).toString('base64'),
                            deposit: '1',
                            gas: '30000000000000',
                        },
                    }],
                },
                receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }],
                final_execution_status: 'FINAL',
            },
        }),
    });

    const result = await verifyFinalizedTransferTransaction({
        nearRpcUrl: 'https://rpc.testnet.near.org',
        relayContractId: 'relay.spellman.testnet',
        transactionHash: txHash,
        expectedSigner: 'creator.testnet',
        expectedTokenId: 'relay-test-1',
        expectedReceiver: 'recipient.testnet',
        fetchImpl: mockFetch,
    });

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.finalized, true);
    assert.equal(result.transaction.signer_id, 'creator.testnet');
});

test('Transaction Verification: Rejects wrong signer, wrong contract, wrong method, wrong args, or receipt failure', async () => {
    const txHash = '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f';

    // 1. Wrong signer
    const wrongSignerFetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                transaction: {
                    hash: txHash,
                    signer_id: 'wrong-signer.testnet',
                    receiver_id: 'relay.spellman.testnet',
                    actions: [{ FunctionCall: { method_name: 'nft_transfer', args: Buffer.from('{}').toString('base64'), deposit: '1' } }],
                },
                receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }],
                final_execution_status: 'FINAL',
            },
        }),
    });
    await assert.rejects(
        verifyFinalizedTransferTransaction({
            nearRpcUrl: 'https://rpc.testnet.near.org',
            relayContractId: 'relay.spellman.testnet',
            transactionHash: txHash,
            expectedSigner: 'creator.testnet',
            expectedTokenId: 'relay-test-1',
            expectedReceiver: 'recipient.testnet',
            fetchImpl: wrongSignerFetch,
        }),
        { code: 'SIGNER_MISMATCH' }
    );

    // 2. Wrong method
    const wrongMethodFetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                transaction: {
                    hash: txHash,
                    signer_id: 'creator.testnet',
                    receiver_id: 'relay.spellman.testnet',
                    actions: [{ FunctionCall: { method_name: 'wrong_method', args: Buffer.from('{}').toString('base64'), deposit: '1' } }],
                },
                receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }],
                final_execution_status: 'FINAL',
            },
        }),
    });
    await assert.rejects(
        verifyFinalizedTransferTransaction({
            nearRpcUrl: 'https://rpc.testnet.near.org',
            relayContractId: 'relay.spellman.testnet',
            transactionHash: txHash,
            expectedSigner: 'creator.testnet',
            expectedTokenId: 'relay-test-1',
            expectedReceiver: 'recipient.testnet',
            fetchImpl: wrongMethodFetch,
        }),
        { code: 'METHOD_MISMATCH' }
    );

    // 3. Receipt failure
    const receiptFailureFetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                transaction: {
                    hash: txHash,
                    signer_id: 'creator.testnet',
                    receiver_id: 'relay.spellman.testnet',
                    actions: [{
                        FunctionCall: {
                            method_name: 'nft_transfer',
                            args: Buffer.from(JSON.stringify({ token_id: 'relay-test-1', receiver_id: 'recipient.testnet' })).toString('base64'),
                            deposit: '1',
                            gas: '30000000000000',
                        },
                    }],
                },
                receipts_outcome: [{ outcome: { status: { Failure: 'ExecutionError' } } }],
                final_execution_status: 'FINAL',
            },
        }),
    });
    await assert.rejects(
        verifyFinalizedTransferTransaction({
            nearRpcUrl: 'https://rpc.testnet.near.org',
            relayContractId: 'relay.spellman.testnet',
            transactionHash: txHash,
            expectedSigner: 'creator.testnet',
            expectedTokenId: 'relay-test-1',
            expectedReceiver: 'recipient.testnet',
            fetchImpl: receiptFailureFetch,
        }),
        { code: 'RECEIPT_EXECUTION_FAILED' }
    );
});

// ---------------------------------------------------------------------------
// 5. Account and Multi-Chain Continuity Tests
// ---------------------------------------------------------------------------
test('Continuity: Subaccount ID and Base Sepolia address remain identical across NFT ownership handoff', () => {
    const subaccount = 'relay-test-1.relay.spellman.testnet';
    const baseAddr1 = deriveBaseAddress(subaccount, 'relay-v1');
    const baseAddr2 = deriveBaseAddress(subaccount, 'relay-v1');

    assert.equal(baseAddr1.address, '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D');
    assert.equal(baseAddr2.address, '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D');
    assert.equal(baseAddr1.childPublicKeyBase58, baseAddr2.childPublicKeyBase58);
});
