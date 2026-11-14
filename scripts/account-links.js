'use strict';

/**
 * Explicit wallet ↔ Google account links.
 *
 * A Google session and a wallet session are different cookies and stay
 * different signers. This store records only that a NEAR account proved
 * ownership of a wallet key while a specific Google subject was signed in.
 *
 * The link is used for ownership reads (does this Google identity control this
 * NFT?) and for choosing which signer must approve an action. It never turns a
 * Google token into a NEAR signature: a wallet-owned NFT is still moved by the
 * wallet, and a Google-owned NFT is still moved by the MPC key.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function failure(message, code = 'ACCOUNT_LINK_ERROR') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function createAccountLinkStore({
    filePath = path.join(__dirname, '..', 'data', 'account-links.json'),
    now = Date.now,
} = {}) {
    const links = new Map();
    let loaded = false;

    function key(sub, accountId) {
        return `${sub}\u0000${accountId}`;
    }

    function load() {
        if (loaded) return;
        loaded = true;
        let text;
        try {
            text = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw failure('The account link journal is not valid JSON.', 'LINK_JOURNAL');
        }
        for (const entry of Array.isArray(parsed?.links) ? parsed.links : []) {
            if (!entry || typeof entry.sub !== 'string' || typeof entry.accountId !== 'string') continue;
            links.set(key(entry.sub, entry.accountId), entry);
        }
    }

    function persist() {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const body = JSON.stringify({
            version: 1,
            links: [...links.values()].sort((a, b) => a.linkedAt - b.linkedAt),
        }, null, 2);
        const temporary = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        fs.writeFileSync(temporary, body, { mode: 0o600 });
        fs.renameSync(temporary, filePath);
    }

    function publicLink(entry) {
        return {
            accountId: entry.accountId,
            publicKey: entry.publicKey || null,
            providerId: entry.providerId || null,
            linkedAt: entry.linkedAt,
        };
    }

    function link({ sub, accountId, publicKey = null, providerId = null }) {
        load();
        if (typeof sub !== 'string' || !sub) throw failure('A Google identity is required to link a wallet.', 'LINK_SUBJECT');
        if (typeof accountId !== 'string' || !accountId) throw failure('A wallet account is required.', 'LINK_ACCOUNT');
        const entry = {
            sub,
            accountId,
            publicKey,
            providerId,
            linkedAt: now(),
        };
        links.set(key(sub, accountId), entry);
        persist();
        return publicLink(entry);
    }

    function unlink(sub, accountId) {
        load();
        const removed = links.delete(key(sub, accountId));
        if (removed) persist();
        return removed;
    }

    function accountsFor(sub) {
        load();
        if (typeof sub !== 'string' || !sub) return [];
        return [...links.values()]
            .filter((entry) => entry.sub === sub)
            .map((entry) => entry.accountId);
    }

    function listFor(sub) {
        load();
        if (typeof sub !== 'string' || !sub) return [];
        return [...links.values()]
            .filter((entry) => entry.sub === sub)
            .sort((a, b) => a.linkedAt - b.linkedAt)
            .map(publicLink);
    }

    function isLinked(sub, accountId) {
        load();
        return links.has(key(sub, accountId));
    }

    return {
        link,
        unlink,
        accountsFor,
        listFor,
        isLinked,
        clear() {
            links.clear();
            loaded = true;
        },
    };
}

module.exports = {
    createAccountLinkStore,
};
