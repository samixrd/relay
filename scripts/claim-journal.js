'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_JOURNAL_SIZE_BYTES = 32 * 1024 * 1024; // 32 MiB

function failure(message, code = 'CLAIM_JOURNAL_ERROR') {
    const error = new Error(message);
    error.code = code;
    return error;
}

/**
 * Valid claim lifecycle states:
 * CREATED -> RECIPIENT_AUTHENTICATED -> RECIPIENT_ACCOUNT_LINKED ->
 * AWAITING_CREATOR_APPROVAL -> TRANSFER_PREPARED -> TRANSFER_SUBMITTED -> TRANSFER_FINALIZED
 * Terminal failure / exit states: EXPIRED, CANCELLED, FAILED, RECOVERY_REQUIRED
 */
const CLAIM_STATES = Object.freeze({
    CREATED: 'CREATED',
    RECIPIENT_AUTHENTICATED: 'RECIPIENT_AUTHENTICATED',
    RECIPIENT_ACCOUNT_LINKED: 'RECIPIENT_ACCOUNT_LINKED',
    AWAITING_CREATOR_APPROVAL: 'AWAITING_CREATOR_APPROVAL',
    TRANSFER_PREPARED: 'TRANSFER_PREPARED',
    TRANSFER_SUBMITTED: 'TRANSFER_SUBMITTED',
    TRANSFER_FINALIZED: 'TRANSFER_FINALIZED',
    EXPIRED: 'EXPIRED',
    CANCELLED: 'CANCELLED',
    FAILED: 'FAILED',
    RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
});

function applyJournalEvent(sessionsMap, event) {
    if (!event || typeof event.type !== 'string' || typeof event.sessionId !== 'string') {
        throw failure('Journal contains a malformed event.', 'MALFORMED_EVENT');
    }

    const sessionId = event.sessionId;

    switch (event.type) {
        case 'SESSION_CREATED': {
            if (!event.session || event.session.sessionId !== sessionId) {
                throw failure('Malformed SESSION_CREATED payload.', 'MALFORMED_CREATION');
            }
            if (sessionsMap.has(sessionId)) {
                const existing = sessionsMap.get(sessionId);
                if (existing.sessionToken !== event.session.sessionToken) {
                    throw failure(`Conflicting session creation for ${sessionId}`, 'CONFLICTING_CREATION');
                }
                return;
            }
            const intendedRecipient = typeof event.session.intendedRecipient === 'string'
                && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(event.session.intendedRecipient)
                && event.session.intendedRecipient.length >= 2
                && event.session.intendedRecipient.length <= 64
                ? event.session.intendedRecipient
                : null;
            const intendedRecipientEmail = typeof event.session.intendedRecipientEmail === 'string'
                ? event.session.intendedRecipientEmail.trim().toLowerCase()
                : null;
            sessionsMap.set(sessionId, {
                ...event.session,
                state: CLAIM_STATES.CREATED,
                history: [{ type: event.type, timestamp: event.timestamp || Date.now() }],
                authenticatedUser: null,
                // Legacy compatibility: only a syntactically valid NEAR account
                // may be auto-approved. An email is never treated as a NEAR
                // account and never authorizes self-approval.
                linkedNearAccountId: intendedRecipient,
                cryptographicallyVerified: false,
                verifiedPublicKey: null,
                creatorApproved: Boolean(intendedRecipient),
                approvedRecipient: intendedRecipient,
                intendedRecipientEmail,
                intendedRecipientEmailHash: event.session.intendedRecipientEmailHash || null,
                ownerApprovalToken: event.session.ownerApprovalToken || null,
                transferPlan: null,
                transactionHash: null,
                finalizedOwner: null,
            });
            break;
        }

        case 'RECIPIENT_AUTHENTICATED': {
            const entry = sessionsMap.get(sessionId);
            if (!entry) throw failure(`Event references unknown session ${sessionId}`, 'UNKNOWN_SESSION');
            if (entry.state === CLAIM_STATES.TRANSFER_FINALIZED || entry.state === CLAIM_STATES.CANCELLED) {
                return; // Ignore if terminal
            }
            entry.authenticatedUser = event.user;
            if (entry.state === CLAIM_STATES.CREATED) {
                entry.state = CLAIM_STATES.RECIPIENT_AUTHENTICATED;
            }
            entry.history.push({ type: event.type, timestamp: event.timestamp || Date.now(), user: event.user?.sub });
            break;
        }

        case 'ACCOUNT_LINKED': {
            const entry = sessionsMap.get(sessionId);
            if (!entry) throw failure(`Event references unknown session ${sessionId}`, 'UNKNOWN_SESSION');
            if (entry.state === CLAIM_STATES.TRANSFER_FINALIZED || entry.state === CLAIM_STATES.CANCELLED) {
                return;
            }
            entry.linkedNearAccountId = event.nearAccountId;
            entry.cryptographicallyVerified = Boolean(event.cryptographicallyVerified);
            entry.verifiedPublicKey = event.verifiedPublicKey || null;
            entry.state = CLAIM_STATES.RECIPIENT_ACCOUNT_LINKED;
            // Any account change resets prior creator approval to prevent recipient substitution
            entry.creatorApproved = false;
            entry.approvedRecipient = null;
            entry.transferPlan = null;
            entry.history.push({
                type: event.type,
                timestamp: event.timestamp || Date.now(),
                nearAccountId: event.nearAccountId,
                cryptographicallyVerified: entry.cryptographicallyVerified,
                verifiedPublicKey: entry.verifiedPublicKey,
            });
            break;
        }

        case 'CREATOR_APPROVED': {
            const entry = sessionsMap.get(sessionId);
            if (!entry) throw failure(`Event references unknown session ${sessionId}`, 'UNKNOWN_SESSION');
            if (entry.state === CLAIM_STATES.TRANSFER_FINALIZED || entry.state === CLAIM_STATES.CANCELLED) {
                return;
            }
            if (!entry.linkedNearAccountId) {
                throw failure('Cannot approve claim before recipient account is linked.', 'ACCOUNT_NOT_LINKED');
            }
            entry.creatorApproved = true;
            entry.approvedRecipient = entry.linkedNearAccountId;
            entry.state = CLAIM_STATES.AWAITING_CREATOR_APPROVAL;
            entry.history.push({ type: event.type, timestamp: event.timestamp || Date.now(), approvedRecipient: entry.approvedRecipient });
            break;
        }

        case 'TRANSFER_PREPARED': {
            const entry = sessionsMap.get(sessionId);
            if (!entry) throw failure(`Event references unknown session ${sessionId}`, 'UNKNOWN_SESSION');
            if (!entry.creatorApproved || entry.linkedNearAccountId !== entry.approvedRecipient) {
                throw failure('Cannot prepare transfer without valid creator approval.', 'APPROVAL_INVALID');
            }
            entry.state = CLAIM_STATES.TRANSFER_PREPARED;
            entry.transferPlan = event.transferPlan;
            entry.history.push({ type: event.type, timestamp: event.timestamp || Date.now() });
            break;
        }

        case 'TRANSFER_SUBMITTED': {
            const entry = sessionsMap.get(sessionId);
            if (!entry) throw failure(`Event references unknown session ${sessionId}`, 'UNKNOWN_SESSION');
            entry.state = CLAIM_STATES.TRANSFER_SUBMITTED;
            entry.transactionHash = event.transactionHash;
            entry.history.push({ type: event.type, timestamp: event.timestamp || Date.now(), transactionHash: event.transactionHash });
            break;
        }

        case 'TRANSFER_FINALIZED': {
            const entry = sessionsMap.get(sessionId);
            if (!entry) throw failure(`Event references unknown session ${sessionId}`, 'UNKNOWN_SESSION');
            if (entry.state === CLAIM_STATES.TRANSFER_FINALIZED) {
                return; // Already finalized; idempotent replay
            }
            entry.state = CLAIM_STATES.TRANSFER_FINALIZED;
            entry.finalizedOwner = event.finalizedOwner;
            entry.consumedAt = event.timestamp || Date.now();
            entry.history.push({ type: event.type, timestamp: event.timestamp || Date.now(), finalizedOwner: event.finalizedOwner });
            break;
        }

        case 'SESSION_CANCELLED': {
            const entry = sessionsMap.get(sessionId);
            if (!entry) throw failure(`Event references unknown session ${sessionId}`, 'UNKNOWN_SESSION');
            if (entry.state === CLAIM_STATES.TRANSFER_FINALIZED) {
                return; // Cannot cancel after finalization
            }
            entry.state = CLAIM_STATES.CANCELLED;
            entry.cancellationReason = event.reason || 'Cancelled by creator';
            entry.history.push({ type: event.type, timestamp: event.timestamp || Date.now(), reason: entry.cancellationReason });
            break;
        }

        case 'SESSION_INVALIDATED': {
            const entry = sessionsMap.get(sessionId);
            if (!entry) return;
            entry.state = event.newState || CLAIM_STATES.FAILED;
            entry.invalidationReason = event.reason || 'Invalidated';
            entry.history.push({ type: event.type, timestamp: event.timestamp || Date.now(), reason: event.reason });
            break;
        }

        default:
            throw failure(`Unknown journal event type: ${event.type}`, 'UNKNOWN_EVENT_TYPE');
    }
}

async function acquireJournalLock(lockPath, timeoutMs = 2000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        try {
            const handle = await fs.open(lockPath, 'wx');
            await handle.writeFile(`${process.pid}\n${Date.now()}`, 'utf8');
            await handle.sync();
            await handle.close();
            return true;
        } catch (err) {
            if (err.code === 'EEXIST') {
                try {
                    const content = await fs.readFile(lockPath, 'utf8');
                    const [pidStr, timeStr] = content.split('\n');
                    const pid = parseInt(pidStr, 10);
                    const lockTime = parseInt(timeStr, 10);

                    // Check if process that holds lock is still running
                    let isProcessAlive = false;
                    try {
                        if (pid && !Number.isNaN(pid)) {
                            process.kill(pid, 0);
                            isProcessAlive = true;
                        }
                    } catch (killErr) {
                        if (killErr.code === 'ESRCH') {
                            isProcessAlive = false;
                        } else {
                            isProcessAlive = true;
                        }
                    }

                    if (!isProcessAlive) {
                        // Process is dead (ESRCH), safely unlink stale lock and retry
                        await fs.unlink(lockPath).catch(() => {});
                        continue;
                    }
                } catch {
                    // Ignore read error
                }
                await new Promise((r) => setTimeout(r, 50));
            } else {
                throw err;
            }
        }
    }
    throw failure(`Failed to acquire journal lock: ${lockPath} is held by another process.`, 'JOURNAL_LOCKED');
}

async function releaseJournalLock(lockPath) {
    try {
        await fs.unlink(lockPath);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
}

async function createClaimJournal({ filePath = null, enableLock = true } = {}) {
    const sessions = new Map();
    const absolutePath = filePath ? path.resolve(filePath) : null;
    const lockPath = absolutePath ? `${absolutePath}.lock` : null;
    let queue = Promise.resolve();
    let lockAcquired = false;

    function enqueue(task) {
        const next = queue.then(task, task);
        queue = next.catch(() => {});
        return next;
    }

    if (absolutePath) {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
        if (enableLock && lockPath) {
            await acquireJournalLock(lockPath);
            lockAcquired = true;
        }

        try {
            const contents = await fs.readFile(absolutePath, 'utf8');
            if (Buffer.byteLength(contents, 'utf8') > MAX_JOURNAL_SIZE_BYTES) {
                throw failure('Claim journal exceeds size limit of 32 MiB.', 'JOURNAL_TOO_LARGE');
            }
            if (contents.length > 0) {
                const lines = contents.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const trimmed = lines[i].trim();
                    if (!trimmed) continue;
                    let event;
                    try {
                        event = JSON.parse(trimmed);
                    } catch (parseError) {
                        throw failure(`Claim journal is corrupted at line ${i + 1}: ${parseError.message}`, 'JOURNAL_CORRUPT');
                    }
                    try {
                        applyJournalEvent(sessions, event);
                    } catch (applyError) {
                        throw failure(`Claim journal event invalid at line ${i + 1}: ${applyError.message}`, 'JOURNAL_CORRUPT');
                    }
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                if (lockAcquired && lockPath) {
                    await releaseJournalLock(lockPath).catch(() => {});
                    lockAcquired = false;
                }
                throw error;
            }
        }
    }

    async function append(event) {
        return enqueue(async () => {
            if (absolutePath) {
                await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
                const handle = await fs.open(absolutePath, 'a', 0o600);
                try {
                    await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            }
            applyJournalEvent(sessions, event);
        });
    }

    return {
        CLAIM_STATES,
        getSession(sessionId) {
            return sessions.get(sessionId) || null;
        },
        hasSession(sessionId) {
            return sessions.has(sessionId);
        },
        getAllSessions() {
            return Array.from(sessions.values());
        },
        async close() {
            if (lockAcquired && lockPath) {
                await releaseJournalLock(lockPath);
                lockAcquired = false;
            }
        },
        async recordSessionCreated(session) {
            await append({
                type: 'SESSION_CREATED',
                sessionId: session.sessionId,
                session,
                timestamp: Date.now(),
            });
        },
        async recordRecipientAuthenticated(sessionId, user) {
            await append({
                type: 'RECIPIENT_AUTHENTICATED',
                sessionId,
                user,
                timestamp: Date.now(),
            });
        },
        async recordAccountLinked(sessionId, nearAccountId, { cryptographicallyVerified = false, verifiedPublicKey = null } = {}) {
            await append({
                type: 'ACCOUNT_LINKED',
                sessionId,
                nearAccountId,
                cryptographicallyVerified: Boolean(cryptographicallyVerified),
                verifiedPublicKey: verifiedPublicKey || null,
                timestamp: Date.now(),
            });
        },
        async recordCreatorApproved(sessionId, approver = 'creator') {
            await append({
                type: 'CREATOR_APPROVED',
                sessionId,
                approver,
                timestamp: Date.now(),
            });
        },
        async recordTransferPrepared(sessionId, transferPlan) {
            await append({
                type: 'TRANSFER_PREPARED',
                sessionId,
                transferPlan,
                timestamp: Date.now(),
            });
        },
        async recordTransferSubmitted(sessionId, transactionHash) {
            await append({
                type: 'TRANSFER_SUBMITTED',
                sessionId,
                transactionHash,
                timestamp: Date.now(),
            });
        },
        async recordTransferFinalized(sessionId, finalizedOwner) {
            const entry = sessions.get(sessionId);
            if (entry && entry.state === CLAIM_STATES.TRANSFER_FINALIZED) {
                throw failure(`Claim session ${sessionId} has already been finalized and consumed.`, 'CLAIM_ALREADY_CONSUMED');
            }
            await append({
                type: 'TRANSFER_FINALIZED',
                sessionId,
                finalizedOwner,
                timestamp: Date.now(),
            });
        },
        async recordSessionCancelled(sessionId, reason) {
            await append({
                type: 'SESSION_CANCELLED',
                sessionId,
                reason,
                timestamp: Date.now(),
            });
        },
        async recordSessionInvalidated(sessionId, reason, newState = CLAIM_STATES.FAILED) {
            await append({
                type: 'SESSION_INVALIDATED',
                sessionId,
                reason,
                newState,
                timestamp: Date.now(),
            });
        },
    };
}

module.exports = {
    CLAIM_STATES,
    createClaimJournal,
};
