'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_ACTIVITY_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
    'card.mint.verified',
    'card.provision.verified',
    'funding.verified',
    'spend.verified',
    'claim.invitation.created',
    'claim.approved',
    'claim.finalized',
    'claim.cancelled',
]);

function normalizeEvent(event) {
    if (!event || typeof event !== 'object') throw new TypeError('Activity event must be an object.');
    if (!ALLOWED_TYPES.has(event.type)) throw new TypeError(`Unsupported activity event type: ${event.type}`);
    const timestamp = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
        ? event.timestamp
        : Date.now();
    const clean = {
        id: `${timestamp.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        type: event.type,
        timestamp,
    };
    const allowed = [
        'tokenId', 'contractId', 'transactionHash', 'network', 'ownerId',
        'receiverId', 'amountYocto', 'amountFormatted', 'sessionId',
        'recipientLabel', 'status', 'explorerUrl', 'note',
    ];
    for (const key of allowed) {
        if (event[key] === undefined || event[key] === null) continue;
        if (typeof event[key] === 'number' || typeof event[key] === 'boolean') {
            clean[key] = event[key];
        } else if (typeof event[key] === 'string') {
            clean[key] = event[key].slice(0, 512);
        }
    }
    return clean;
}

async function createActivityJournal({ filePath }) {
    const absolutePath = path.resolve(filePath);
    const events = [];
    let queue = Promise.resolve();

    async function load() {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
        let text = '';
        try {
            const stat = await fs.stat(absolutePath);
            if (stat.size > MAX_ACTIVITY_BYTES) {
                throw new Error('Activity journal exceeds the 8 MiB safety limit.');
            }
            text = await fs.readFile(absolutePath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed && ALLOWED_TYPES.has(parsed.type)) events.push(parsed);
            } catch {
                // A corrupt local history line must not take the app down.
            }
        }
    }

    const ready = load();

    async function record(event) {
        const clean = normalizeEvent(event);
        await ready;
        const task = queue.then(async () => {
            await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
            const handle = await fs.open(absolutePath, 'a', 0o600);
            try {
                await handle.writeFile(`${JSON.stringify(clean)}\n`, 'utf8');
                await handle.sync();
            } finally {
                await handle.close();
            }
            events.push(clean);
            return clean;
        });
        queue = task.catch(() => {});
        return task;
    }

    return {
        record,
        async list(limit = 100) {
            await ready;
            return events.slice(-Math.max(1, Math.min(limit, 500))).reverse();
        },
        async close() {
            await queue.catch(() => {});
        },
    };
}

module.exports = {
    ALLOWED_TYPES,
    createActivityJournal,
};
