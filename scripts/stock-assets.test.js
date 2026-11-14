'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    SHARE,
    STOCK_ASSETS,
    createStockFaucet,
} = require('./stock-assets');

const AAPL = 'aapl.spellman.testnet';

function tempLedger() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-stock-'));
    return path.join(directory, 'claims.json');
}

function fakeProvider({ treasuryBalance = '10000000000000' } = {}) {
    return {
        async callFunction({ method, args }) {
            if (method === 'ft_balance_of') return treasuryBalance;
            return null;
        },
    };
}

function fakeAccount() {
    return {
        calls: [],
        async signAndSendTransaction({ receiverId, actions, waitUntil }) {
            this.calls.push({ receiverId, actions, waitUntil });
            return { transaction: { hash: `tx-${this.calls.length}` } };
        },
    };
}

function faucetFor({ filePath = tempLedger(), provider = fakeProvider(), account = fakeAccount() } = {}) {
    return createStockFaucet({
        rpcUrl: 'http://localhost',
        treasuryAccountId: 'spellman.testnet',
        treasuryPrivateKey: null,
        account,
        provider,
        filePath,
        now: () => 1_700_000_000_000,
    });
}

test('exposes four stock / commodity demo assets with distinct metadata', () => {
    assert.equal(STOCK_ASSETS.length, 4);
    assert.deepEqual(STOCK_ASSETS.map((asset) => asset.symbol), ['AAPL', 'TSLA', 'GOLD', 'OIL']);
    for (const asset of STOCK_ASSETS) {
        assert.match(asset.contractId, /\.spellman\.testnet$/);
        assert.equal(asset.decimals, 6);
        assert.equal(BigInt(asset.claimAmount), 100n * SHARE);
        assert.equal(BigInt(asset.claimCap), 1_000n * SHARE);
    }
});

test('claim registers storage and transfers the grant into the card account', async () => {
    const account = fakeAccount();
    const faucet = faucetFor({ account });
    const result = await faucet.claim({
        contractId: AAPL,
        tokenId: 'obelisk',
        cardAccountId: 'obelisk.relay.spellman.testnet',
    });

    assert.equal(result.amount, (100n * SHARE).toString());
    assert.equal(result.claimed, (100n * SHARE).toString());
    assert.equal(result.remaining, (900n * SHARE).toString());
    assert.equal(result.symbol, 'AAPL');
    assert.equal(result.transactionHash, 'tx-1');
    assert.equal(account.calls.length, 1);
    assert.equal(account.calls[0].receiverId, AAPL);
    assert.equal(account.calls[0].waitUntil, 'FINAL');
    assert.equal(account.calls[0].actions.length, 2);
    assert.equal(account.calls[0].actions[0].functionCall.methodName, 'storage_deposit');
    assert.equal(account.calls[0].actions[1].functionCall.methodName, 'ft_transfer');
    const transferArgs = JSON.parse(Buffer.from(account.calls[0].actions[1].functionCall.args).toString('utf8'));
    assert.equal(transferArgs.receiver_id, 'obelisk.relay.spellman.testnet');
    assert.equal(transferArgs.amount, (100n * SHARE).toString());
});

test('enforces the per-card lifetime cap and persists the ledger', async () => {
    const filePath = tempLedger();
    const faucet = faucetFor({ filePath });

    for (let index = 0; index < 10; index += 1) {
        await faucet.claim({ contractId: AAPL, tokenId: 'obelisk', cardAccountId: 'obelisk.relay.spellman.testnet' });
    }
    assert.equal(faucet.remainingFor(AAPL, 'obelisk'), 0n);
    await assert.rejects(
        () => faucet.claim({ contractId: AAPL, tokenId: 'obelisk', cardAccountId: 'obelisk.relay.spellman.testnet' }),
        (error) => error.code === 'CLAIM_CAP',
    );

    // A new process reads the same ledger from disk.
    const reloaded = faucetFor({ filePath });
    assert.equal(reloaded.claimedFor(AAPL, 'obelisk'), 1_000n * SHARE);
    assert.equal(reloaded.remainingFor(AAPL, 'obelisk'), 0n);
});

test('caps the final claim at the remaining allowance', async () => {
    const filePath = tempLedger();
    const faucet = faucetFor({ filePath });
    await faucet.claim({ contractId: AAPL, tokenId: 'obelisk', cardAccountId: 'obelisk.relay.spellman.testnet' });
    // Simulate a ledger that is 50 shares short of the cap.
    const ledger = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    ledger.claims[0].claimed = (950n * SHARE).toString();
    fs.writeFileSync(filePath, JSON.stringify(ledger));

    const reloaded = faucetFor({ filePath });
    const result = await reloaded.claim({ contractId: AAPL, tokenId: 'obelisk', cardAccountId: 'obelisk.relay.spellman.testnet' });
    assert.equal(result.amount, (50n * SHARE).toString());
    assert.equal(result.claimed, (1_000n * SHARE).toString());
});

test('rejects unsupported contracts and an empty treasury', async () => {
    const faucet = faucetFor();
    await assert.rejects(
        () => faucet.claim({ contractId: 'wrap.testnet', tokenId: 'obelisk', cardAccountId: 'obelisk.relay.spellman.testnet' }),
        (error) => error.code === 'FT_UNSUPPORTED',
    );

    const empty = faucetFor({ provider: fakeProvider({ treasuryBalance: '0' }) });
    await assert.rejects(
        () => empty.claim({ contractId: AAPL, tokenId: 'obelisk', cardAccountId: 'obelisk.relay.spellman.testnet' }),
        (error) => error.code === 'FAUCET_EMPTY',
    );
});

test('registers a fresh recipient and skips an already-registered one', async () => {
    const account = fakeAccount();
    const faucet = faucetFor({ account });
    const created = await faucet.ensureRegistered({ contractId: AAPL, accountId: 'friend.testnet' });
    assert.equal(created.created, true);
    assert.equal(account.calls.length, 1);
    assert.equal(account.calls[0].actions[0].functionCall.methodName, 'storage_deposit');

    const registeredProvider = {
        async callFunction({ method }) {
            if (method === 'storage_balance_of') return { total: '1250000000000000000000', available: '0' };
            return null;
        },
    };
    const second = faucetFor({ account, provider: registeredProvider });
    const existing = await second.ensureRegistered({ contractId: AAPL, accountId: 'friend.testnet' });
    assert.equal(existing.created, false);
    assert.equal(account.calls.length, 1);
});
