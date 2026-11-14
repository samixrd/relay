'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');

const { CLAIM_STATES, createClaimJournal } = require('./claim-journal');
const { createClaimSession, verifyClaimSession } = require('./claim-session');

test('claim journal records lifecycle events and survives simulated restart', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-journal-test-'));
    const journalPath = path.join(tmpDir, 'claim-sessions.journal');

    try {
        const journal1 = await createClaimJournal({ filePath: journalPath });

        const session = createClaimSession({
            tokenId: 'relay-test-1',
            expectedOwner: 'relay-owner-b.spellman.testnet',
            ttlSeconds: 3600,
        });
        await journal1.recordSessionCreated(session);

        // 1. Session created
        let entry = journal1.getSession(session.sessionId);
        assert.ok(entry);
        assert.equal(entry.state, CLAIM_STATES.CREATED);
        assert.equal(entry.tokenId, 'relay-test-1');

        // 2. Recipient authenticates
        await journal1.recordRecipientAuthenticated(session.sessionId, {
            sub: 'google-sub-777',
            email: 'friend@test.com',
            name: 'Friend',
        });
        entry = journal1.getSession(session.sessionId);
        assert.equal(entry.state, CLAIM_STATES.RECIPIENT_AUTHENTICATED);
        assert.equal(entry.authenticatedUser.sub, 'google-sub-777');

        // 3. Recipient links NEAR account
        await journal1.recordAccountLinked(session.sessionId, 'friend.testnet');
        entry = journal1.getSession(session.sessionId);
        assert.equal(entry.state, CLAIM_STATES.RECIPIENT_ACCOUNT_LINKED);
        assert.equal(entry.linkedNearAccountId, 'friend.testnet');
        assert.equal(entry.creatorApproved, false);

        // 4. Creator approves
        await journal1.recordCreatorApproved(session.sessionId);
        entry = journal1.getSession(session.sessionId);
        assert.equal(entry.creatorApproved, true);
        assert.equal(entry.approvedRecipient, 'friend.testnet');

        // 5. If recipient switches account, approval must be reset!
        await journal1.recordAccountLinked(session.sessionId, 'attacker.testnet');
        entry = journal1.getSession(session.sessionId);
        assert.equal(entry.linkedNearAccountId, 'attacker.testnet');
        assert.equal(entry.creatorApproved, false); // Anti-substitution check!

        // Re-link and re-approve friend.testnet
        await journal1.recordAccountLinked(session.sessionId, 'friend.testnet');
        await journal1.recordCreatorApproved(session.sessionId);

        // 6. Transfer prepared
        const plan = {
            contractId: 'relay.spellman.testnet',
            methodName: 'nft_transfer',
            args: { token_id: 'relay-test-1', receiver_id: 'friend.testnet' },
        };
        await journal1.recordTransferPrepared(session.sessionId, plan);
        entry = journal1.getSession(session.sessionId);
        assert.equal(entry.state, CLAIM_STATES.TRANSFER_PREPARED);

        // 7. Transfer submitted
        await journal1.recordTransferSubmitted(session.sessionId, '5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U');
        entry = journal1.getSession(session.sessionId);
        assert.equal(entry.state, CLAIM_STATES.TRANSFER_SUBMITTED);
        assert.equal(entry.transactionHash, '5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U');

        // 8. Transfer finalized
        await journal1.recordTransferFinalized(session.sessionId, 'friend.testnet');
        entry = journal1.getSession(session.sessionId);
        assert.equal(entry.state, CLAIM_STATES.TRANSFER_FINALIZED);
        assert.equal(entry.finalizedOwner, 'friend.testnet');

        // Verify that claim session verification now rejects reuse
        assert.throws(
            () => verifyClaimSession(session.sessionToken, { journal: journal1 }),
            /already been claimed/
        );

        // 9. Simulated Server Restart: Close previous process and read back into fresh journal instance
        await journal1.close();
        const journal2 = await createClaimJournal({ filePath: journalPath });
        const restoredEntry = journal2.getSession(session.sessionId);
        assert.ok(restoredEntry);
        assert.equal(restoredEntry.state, CLAIM_STATES.TRANSFER_FINALIZED);
        assert.equal(restoredEntry.finalizedOwner, 'friend.testnet');
        assert.equal(restoredEntry.authenticatedUser.sub, 'google-sub-777');

        // Fresh journal still rejects replaying finalized claim
        assert.throws(
            () => verifyClaimSession(session.sessionToken, { journal: journal2 }),
            /already been claimed/
        );
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});

test('claim journal cancellation and invalidation', async () => {
    const journal = await createClaimJournal();
    const session = createClaimSession({
        tokenId: 'relay-test-2',
        expectedOwner: 'owner.testnet',
    });
    await journal.recordSessionCreated(session);

    await journal.recordSessionCancelled(session.sessionId, 'Creator opted out');
    const entry = journal.getSession(session.sessionId);
    assert.equal(entry.state, CLAIM_STATES.CANCELLED);
    assert.equal(entry.cancellationReason, 'Creator opted out');

    assert.throws(
        () => verifyClaimSession(session.sessionToken, { journal }),
        /cancelled/
    );
});

test('claim journal fails closed on corrupt records', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-journal-corrupt-'));
    const journalPath = path.join(tmpDir, 'corrupt.journal');
    try {
        await fs.writeFile(journalPath, '{"type":"SESSION_CREATED","sessionId":"s1","session":{"sessionId":"s1"}}\n{CORRUPT_JSON_LINE\n', 'utf8');
        await assert.rejects(
            createClaimJournal({ filePath: journalPath }),
            { code: 'JOURNAL_CORRUPT' }
        );
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});

test('claim journal rejects concurrent writer when lock is active', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-journal-lock-'));
    const journalPath = path.join(tmpDir, 'locked.journal');
    try {
        const j1 = await createClaimJournal({ filePath: journalPath });
        await assert.rejects(
            createClaimJournal({ filePath: journalPath }),
            { code: 'JOURNAL_LOCKED' }
        );
        await j1.close();
        const j2 = await createClaimJournal({ filePath: journalPath });
        assert.ok(j2);
        await j2.close();
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});
