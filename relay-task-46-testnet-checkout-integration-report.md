# RELAY Task 46 - Testnet Checkout Integration Report

**Date:** 2026-11-10
**Network:** NEAR Testnet only
**Verdict:** COMPLETE for the intent-bound checkout flow, live finalized transfer, independent verification, and visible browser receipt. One explicitly human-only step remains: real browser-wallet signing/approval.

---

## 1. Objective and boundaries

Task 46 required a full browser -> API prepare -> owner authorization -> real finalized NEAR Testnet transfer -> independent RPC verification -> visible receipt flow, plus documentation.

Boundaries honored throughout:

- NEAR Testnet only. No Mainnet route or Mainnet funds were used.
- No private key, seed phrase, OAuth secret, or `.env` value was printed, logged, or requested.
- Existing Task 44/45 work, deployed contract, and untracked files were preserved.
- No payment success was claimed without independently verified finalized-chain evidence.
- The direct native NEAR transfer is not represented as NEAR Intents or 1Click.
- Mainnet-only 1Click routes remain disabled for Testnet. Base Sepolia remains read-only.
- No Google OAuth configuration, git push, or public deployment was performed.

---

## 2. Implementation summary

### 2.1 Server-side payment intent binding

`scripts/near-testnet-payment-authorizer.js` now supports a server-owned intent for every prepared payment:

| Field | Purpose |
|---|---|
| `paymentId` | Stable server intent identifier; required by verify |
| owner | NFT owner read from finalized chain state at prepare time |
| tokenId / subaccount | Canonical token and associated account |
| receiverId | Bound receiver; cannot be swapped by the client |
| amountYocto | Bound amount; cannot be swapped by the client |
| expectedTokenNonce | Stale-intent / replay protection |
| preparedAt / preparedAtBlock | Preparation context |
| deadline | Authorization window, default 15 minutes (bounded 1-60) |
| balance-before reads | Subaccount, receiver, storage usage, reserve with padding |
| transaction plan | Exact contract, method, args, gas, deposit, required signer |

Exports added: `createPaymentIntentStore`, `createRpcClient`, `viewCallAt`, `viewAccountAt`, `serializePaymentIntent`, `getNearPaymentIntent`.

### 2.2 Verification rules

`verifyNearPaymentTransaction` with a `paymentId` enforces:

1. The hash is finalized and `FINAL`.
2. Inclusion block timestamp is not after the intent deadline.
3. The signer is the current NFT owner and the owner at the execution block.
4. The token nonce advances from the expected value.
5. A block-level subaccount debit of exactly the bound amount exists.
6. A receiver credit of exactly the bound amount exists.
7. The storage reserve is preserved.
8. An identical hash replays the same evidence idempotently.
9. A different hash for an already-settled payment is rejected.

The legacy behavior (no `paymentId`) is preserved so the Task 45 suite keeps passing.

### 2.3 API routes

`scripts/app-server.js`:

| Route | Behavior |
|---|---|
| `POST /api/payment/prepare-near` | Registers intent; returns `payment`, `transactionPlan`, `review`, `currentState` |
| `POST /api/payment/verify-near` | Requires `paymentId`; 200 settled, 202 pending, typed 400/404/409/410/502 failures |
| `GET /api/payment/intent?paymentId=` | Restores prepared or settled state after reload/redirect |

The server intent is authoritative. Client-supplied expected values are context checks only.

### 2.4 Browser UI

`web/app.js`, `web/ui-state.js`, and `web/index.html` now provide:

- Review rendering: payment ID, nonce, deadline, signer, receiver, amount, gas, deposit.
- Owner gating: submit stays disabled unless the connected account equals the required signer.
- Correct wallet adapter call shape: `{ receiverId, actions: [FunctionCall] }`.
- Redirect restore through the server intent endpoint.
- Automatic polling on 202.
- Full receipt: payment ID, signer, owner-at-execution, subaccount, receiver, amount,
  nonce before/after, subaccount and receiver balance deltas, preserved storage reserve,
  inclusion and finalized blocks, deadline, receipt count, transaction hash, explorer link.

### 2.5 Restore bug found and fixed

The original reload-restore path did not work:

- Boot runs `loadConfigAndStatus()` -> `loadAccount()` -> `resetAccountView()`.
- That called `resetNearPayPanel()`, which deleted the `sessionStorage` payment ID.
- Only `restoreNearPaymentContext()` (run later) read that key.

Fix: `resetNearPayPanel({ clearStoredIntent = true })`; account resets pass
`clearStoredIntent: false`. Only the explicit Reset button clears the stored intent.
A regression test asserts the boot reset preserves the key.

Note: boot restore waits for the account RPC reads, which can take ~16 seconds per account
endpoint in this environment. Once complete, restoration is automatic.

---

## 3. Live NEAR Testnet evidence

### 3.1 Real intent-bound payment

| Property | Value |
|---|---|
| Payment ID | `p-relay-test-1-1794293415115-7b266ede` |
| Transaction | `G4wMYqLn7f6nfJTnncdNqJ3Yu1WYEg6zZsSsNjfKPbTD` |
| Explorer | https://testnet.nearblocks.io/txns/G4wMYqLn7f6nfJTnncdNqJ3Yu1WYEg6zZsSsNjfKPbTD |
| Signer / owner at execution | `relay-owner-b.spellman.testnet` |
| Contract / method | `relay.spellman.testnet` / `relay_execute_subaccount` |
| Action | `TransferNear` |
| Token | `relay-test-1` |
| Subaccount | `relay-test-1.relay.spellman.testnet` |
| Receiver | `spellman.testnet` |
| Amount | `0.01` NEAR (`10000000000000000000000` yocto) |
| Final status | `FINAL`, 8 receipts, 0 failures |
| Nonce | `2 -> 3` |
| Subaccount balance | `1.73993 -> 1.72993` NEAR (`-0.01` NEAR) |
| Receiver balance | `5.899316574544037299999999 -> 5.909316574544037299999999` NEAR (`+0.01` NEAR) |
| Storage reserve | `1.6018` NEAR preserved |
| Inclusion block | `#277032987` (`9bFWoTwruC8JAqqT25n1n3gacyNtZV2Hq9VSn4z7pu44`) |
| Finalized block | `#277032992` (`BLkxLH1k4cdJ6q3edQdurKnVNydu8xB6CLAvZYLe8zSp`) |
| Deadline | `2026-11-10T07:05:31.151Z` |
| Evidence file | `data/task46-live-payment.json` |

Execution sequence:

1. Server `prepare-near` registered the intent and returned the plan.
2. The operator signed the exact plan with the existing owner key outside the browser.
3. The transaction was broadcast to NEAR Testnet and finalized.
4. Server `verify-near` independently re-read chain state and produced the evidence above.
5. The evidence was independently re-checked against RPC and saved to disk.

This proves the deployed contract path, intent binding, and verifier. It does not prove automated browser-wallet approval.

### 3.2 Task 45 transaction remains valid

`J4aNw8zTgdGbZgZ9JgRu7ZeAdVUjAFFx1hxMendfZWM4` remains a valid earlier finalized direct transfer (`0.01` NEAR, 7 receipts) through the legacy verifier path without `paymentId`.

---

## 4. Live API security checks

Performed against the running local server with the real intent:

| Case | Result |
|---|---|
| Same hash replay | 200, `replayed: true`, same evidence |
| Different hash after settlement | 409 `DUPLICATE_PAYMENT` |
| Unknown paymentId | 404 `PAYMENT_INTENT_NOT_FOUND` |
| Missing paymentId | 400 `MISSING_PAYMENT_ID` |

Additional covered cases in the automated suite:

- Receiver tampering rejected.
- Amount tampering rejected.
- Expired authorization rejected at the inclusion block.
- Stale token nonce rejected.
- Ownership change between prepare and execution rejected.
- Block-level missing debit or missing receiver credit rejected.
- Storage reserve reduction rejected.

---

## 5. Browser evidence

Validated in the in-app Chromium tab against `http://127.0.0.1:4173`:

1. Prepare validation: loaded `relay-test-1`, entered `spellman.testnet` / `0.005` NEAR,
   prepared a plan; review showed `REVIEW REQUIRED`, payment ID, nonce `3`, deadline,
   signer, and amount.
2. Wallet gating: status `WALLET NOT CONNECTED`; submit disabled with
   "Connect Owner Wallet to Submit".
3. Real restore: stored the live payment ID, reloaded, and after the account RPC reads
   the page rendered `FINALIZED - SETTLED`.
4. Receipt fields observed: payment ID, signer, owner-at-execution, subaccount, receiver,
   amount `0.01 NEAR`, nonce `2 -> 3`, subaccount delta `-0.01`, receiver delta `+0.01`,
   storage `1.6018 NEAR preserved`, finality `FINAL`, inclusion `#277032987`,
   finalized `#277032992`, deadline, `8` receipts, transaction hash, explorer link.
5. Verify button with the real hash: 200 idempotent replay and message
   "This finalized payment was already verified. Showing the same on-chain evidence."
6. Screenshot captured showing the receipt in the Checkout view.

Console noise observed was limited to pre-existing CSP `style-src 'self'` inline-style
violations and a wallet bundle `process is not defined` warning. Neither affects payment
preparation, restore, verification, or receipt rendering.

---

## 6. Test results

All focused suites pass:

| Suite | Tests | Result |
|---|---|---|
| `scripts/task45-testnet-checkout.test.js` | 40 | PASS |
| `scripts/task46-integration.test.js` | 16 | PASS |
| `scripts/task46-checkout-flow.test.js` | 27 | PASS |
| `scripts/app-server.test.js` + `scripts/app-config.test.js` | 21 | PASS |
| **Total** | **104** | **PASS** |

`node --check` passes for `web/app.js` and `scripts/task46-checkout-flow.test.js`.

No full Cargo or Sandbox rerun was needed; no contract change was made.

---

## 7. What was not done and is not claimed

| Item | Status |
|---|---|
| Real browser-wallet signing/approval | **NOT DONE - human-only.** No wallet extension/login can be automated headlessly. |
| NEAR Intents / 1Click checkout on Testnet | **Not attempted.** Provider is Mainnet-only and remains disabled. |
| Base Sepolia signing | **Not attempted.** Remains read-only. |
| Mainnet activity | **Not performed.** |
| Google OAuth configuration | **Not performed.** |
| Git commit/push or public deployment | **Not performed.** |

The browser wallet step requires a human to install or open Meteor Wallet or MyNearWallet,
log in as `relay-owner-b.spellman.testnet`, connect to the Checkout view, review, and approve.
The UI will then submit the exact intent-bound plan, and the existing verify flow will
produce the same class of receipt evidence.

---

## 8. How to reproduce

1. Start the local app: `node scripts/app-server.js` (default `http://127.0.0.1:4173`).
2. Run focused tests:

```bash
node --test scripts/task45-testnet-checkout.test.js
node --test scripts/task46-integration.test.js
node --test scripts/task46-checkout-flow.test.js
node --test scripts/app-server.test.js scripts/app-config.test.js
```

3. Open the Checkout view, load `relay-test-1`, and prepare a payment.
4. Sign with the owner wallet, or for verification-only replay set the stored payment ID
   to the live intent and reload.
5. Verify `G4wMYqLn7f6nfJTnncdNqJ3Yu1WYEg6zZsSsNjfKPbTD` and compare the receipt with
   `data/task46-live-payment.json` and the explorer.

---

## 9. Conclusion

Task 46 is complete within the stated Testnet and human-approval boundaries:

- The prepare -> authorize -> submit -> verify -> receipt path is implemented.
- A real finalized NEAR Testnet transfer was verified with independent RPC evidence.
- Replay, duplicate, tampering, expiration, nonce, ownership, and balance checks are covered.
- The browser UI restores and displays the receipt, and the restore bug was fixed.
- Documentation was updated honestly.

The only remaining step is the inherently human browser-wallet approval, which is
explicitly not claimed as passed.
