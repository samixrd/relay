# RELAY Task 45 — Testnet-Native Checkout Demo Report

**Date:** 2026-11-09  
**Verdict:** COMPLETE (all requirements met within Testnet capability boundaries)

---

## 1. Initial repository and deployment audit

**Live Testnet state read at block 276946165** (finalized):

| Property | Value |
|---|---|
| NFT contract | `relay.spellman.testnet` |
| Token ID | `relay-test-1` |
| NFT owner | `relay-owner-b.spellman.testnet` |
| Associated account | `relay-test-1.relay.spellman.testnet` |
| Lifecycle | `Unlocked` |
| Credits | 3/3 |
| Token nonce | 1 |
| Subaccount balance | 1,749,930,000,000,000,000,000,000 yoctoNEAR (~1.75 NEAR) |
| Storage usage | 150,180 bytes |
| Access keys | 0 (contract-controlled only) |
| Parent code SHA256 | `2CB1AE95CDB0B6616D69A728BAD983093225A98B10526358BFE90AD9AD334B6F` |
| Controller code SHA256 | `762A821E16897303AB491E90E26F02FA466ED831008CE73C4EB27F3CB4F29242` |
| Base Sepolia address | Derived via Chain Signatures MPC (`v1.signer-prod.testnet`) |

**Key architectural finding:** The contract already has `relay_execute_subaccount → TransferNear` as the authorized native NEAR transfer path. No new contract deployment is needed.

**Git status:** 9 modified files (pre-existing from earlier tasks) + 48 untracked files. All pre-existing modifications and untracked files preserved throughout.

---

## 2. Files created or modified

### New files (Task 45)

| File | Purpose |
|---|---|
| `scripts/near-testnet-payment-authorizer.js` | Owner-bound NEAR Testnet payment authorization, verification, and replay protection |
| `scripts/task45-testnet-checkout.test.js` | 40 tests covering all Task 45 requirements |

### Modified files (Task 45)

| File | Change |
|---|---|
| `scripts/asset-registry.js` | Added `NEAR_TESTNET_DIRECT_TRANSFER` status for `native:near-testnet`; added testnet-native checkout pair; fixed `validateCheckoutRoute` to allow direct-transfer routes without 1Click provider |
| `scripts/app-server.js` | Added `POST /api/payment/prepare-near`, `POST /api/payment/verify-near`, `GET /api/payment/assets` routes |
| `web/index.html` | Replaced checkout section with Testnet-native panel (primary) + clearly labelled Mainnet-only 1Click section (preserved, disabled) |
| `web/app.js` | Added `renderTestnetCheckoutAddresses`, `resetNearPayPanel`, `prepareNearPayment`, `submitNearPayment`, `verifyNearPayment`, `formatYoctoNear`; wired all checkout event listeners |
| `README.md` | Added "Checkout and payment architecture" section with full status table |

### Deleted files (cleanup)

| File | Reason |
|---|---|
| `scripts/insert-payment-routes.js` | Temporary helper used to insert routes with CRLF-safe splicing; deleted after verification |

---

## 3. Mainnet-only features disabled

| Feature | Status | Reason |
|---|---|---|
| 1Click / NEAR Intents checkout | **DISABLED** | Provider uses Mainnet-only routes; `wrap.testnet` not supported |
| Mainnet wNEAR (`wrap.near`) checkout pairs | **DISABLED** | Mainnet asset — cannot spend on Testnet |
| Base Mainnet USDC / WETH | **DISABLED** | Mainnet assets |
| `usdc.fakes.testnet` / `usdt.fakes.testnet` | **BLOCKED** | Zero-value test fixtures; asset registry marks as `TESTNET_FIXTURE` |

The 1Click code from Task 44 is preserved behind `ALLOWED_CHECKOUT_PAIRS` entries that are never matched for Testnet assets, and the UI section is visually disabled with `pointer-events: none` and a clear warning banner.

The `validateCheckoutRoute` function in `asset-registry.js` enforces the distinction at the API level.

---

## 4. NEAR native payment implementation

### Authorization flow

```
User fills receiver + amount
↓
POST /api/payment/prepare-near
↓
Server reads finalized Testnet state:
  - block at finality: "final"
  - nft_token → owner_id (chain-verified, not client-supplied)
  - relay_account_binding → canonical subaccount
  - token_lifecycle → must be "Unlocked"
  - view_account → balance + storage_usage
↓
Server calculates spendable = balance - (storage_usage × 10^19) - 0.1 NEAR padding
↓
Server returns exact tx plan: { contractId, methodName, args, gas, deposit }
↓
UI shows review panel with all transaction details
↓
User approves and signs via wallet
↓
Wallet broadcasts relay_execute_subaccount → TransferNear
↓
POST /api/payment/verify-near (with tx hash)
↓
Server reads tx from NEAR Testnet RPC:
  - Verifies signer === expected owner
  - Verifies receiver === relay contract
  - Verifies method === relay_execute_subaccount
  - Verifies action === TransferNear with correct receiver + amount
  - Verifies final_execution_status === "FINAL"
  - Verifies no receipt failures
↓
Returns verified evidence + explorer URL
```

### Security properties

| Property | Implementation |
|---|---|
| Owner-bound | Server reads `nft_token.owner_id` from finalized chain state before preparing plan |
| Token-bound | `token_id` and `contractId` are fixed constants, not client-supplied |
| Storage reserve | `150,180 × 10^19 + 0.1 NEAR` locked; transfer rejected if amount > spendable |
| Replay protection | NEAR `token_nonce` advances monotonically on each `relay_execute_subaccount` call |
| Self-transfer blocked | Receiver cannot be the associated subaccount itself |
| No arbitrary calldata | Only `TransferNear` action is exposed; method and contract are hard-coded constants |
| No FullAccess keys | Subaccount controller has no user key; parent contract mediates all actions |
| Stale authorization rejection | Ownership is re-read from chain on every `/prepare-near` call; old owners cannot authorize new payments |

---

## 5. NEP-141 token payments on Testnet

No real NEP-141 token suitable for a demo transfer exists on Testnet:

| Token | Assessment |
|---|---|
| `wrap.testnet` | Real wNEAR — but 1Click provider does not support it |
| `usdc.fakes.testnet` | Zero-value test fixture — not a stablecoin |
| `usdt.fakes.testnet` | Zero-value test fixture — not a stablecoin |

**Conclusion:** Native NEAR is used for the demo. No fake token is described as USDC or a genuine stablecoin.

---

## 6. Base Sepolia signing feasibility

**Conclusion: Not feasible. Base Sepolia is portfolio read-only.**

Reasons:
- Deriving a Base address via Chain Signatures epsilon derivation does not prove signing capability.
- The Chain Signatures MPC endpoint (`v1.signer-prod.testnet`) requires a contract-mediated `sign` call with verified path derivation.
- No existing contract on `relay.spellman.testnet` or `relay-test-1.relay.spellman.testnet` exposes a `sign` method with proper ownership and transaction constraints.
- Adding such a path without full security review and owner-bound constraints would be unsafe.

**What works:**
- Real Base Sepolia ETH balance reading via `eth_getBalance`.
- Real Base Sepolia USDC balance reading via `eth_call` on the Circle testnet contract.
- Address display in the UI with a clear **PORTFOLIO ONLY** label.

---

## 7. Asset and network registry

The `scripts/asset-registry.js` asset registry defines:

```
native:near-testnet       → TESTNET_NATIVE_TRANSFER  (spendable via relay_execute_subaccount → TransferNear)
nep141:wrap.testnet       → TESTNET_PORTFOLIO_ONLY   (1Click unsupported)
nep141:usdc.fakes.testnet → TESTNET_FIXTURE           (zero value, blocked)
nep141:usdt.fakes.testnet → TESTNET_FIXTURE           (zero value, blocked)
native:base-sepolia       → TESTNET_PORTFOLIO_ONLY   (read-only)
erc20:base-sepolia-0x036c → TESTNET_PORTFOLIO_ONLY   (Circle testnet fixture)
nep141:wrap.near          → MAINNET_ONECLICK          (Mainnet-only)
nep141:base-0x8335...     → MAINNET_ONECLICK          (Mainnet-only)
nep141:base-0x4200...     → MAINNET_ONECLICK          (Mainnet-only)
```

Allowed checkout pairs:
1. `NEAR_TESTNET_DIRECT_TRANSFER`: `native:near-testnet` → `native:near-testnet` **(new, Testnet-native)**
2. `NEAR_MAINNET_TO_BASE_MAINNET_USDC`: `nep141:wrap.near` → Base USDC (Mainnet 1Click)
3. `NEAR_MAINNET_TO_BASE_MAINNET_WETH`: `nep141:wrap.near` → Base WETH (Mainnet 1Click)
4. `BASE_MAINNET_TO_NEAR_MAINNET`: Base USDC → `nep141:wrap.near` (Mainnet 1Click)
5. `NEAR_MAINNET_TO_NEAR_MAINNET`: `nep141:wrap.near` → `nep141:wrap.near` (Mainnet 1Click)

---

## 8. Payment state machine

The existing `checkout-state-machine.js` from Task 44 is reused. States used in the Testnet-native path:

```
Draft → Prepared → Authorized → SourceTransferPending
      → SourceTransferCompleted → Settled
      → Failed
      → RecoveryRequired
```

For a direct NEAR transfer, source and destination are the same chain (NEAR Testnet). Settlement requires `destinationVerified: true` via `verifyNearPaymentTransaction`.

---

## 9. Security and lifecycle behavior

All existing RELAY security model properties are preserved:

- **Owner changes invalidate authorizations.** The prepare step reads the current owner from chain. A new owner must call `/prepare-near` fresh.
- **Nonces are monotonic.** `token_nonce` advances on each `relay_execute_subaccount` call.
- **Lifecycle locks respected.** Payments are blocked when `token_lifecycle !== 'Unlocked'`.
- **Storage reserves intact.** The spendable calculation is strictly enforced server-side.
- **No FullAccess keys.** The subaccount controller has no user key.
- **No arbitrary calldata.** Only `TransferNear` with explicit receiver and amount is exposed.
- **No private key exposure.** `.env` contents are never logged or returned from APIs.
- **No NEP-413 weakening.** Existing auth-provider-adapter and claim flows unchanged.

---

## 10. UI user journey

1. Open RELAY at `http://localhost:4173` (or deployed URL).
2. Enter token ID → load account.
3. **Testnet Checkout** section shows at top of `#checkout` panel.
4. See: NEAR Testnet subaccount address, Base Sepolia address (portfolio-only), spendable balance, NFT owner.
5. Select payment method: **NEAR Testnet — Native Transfer** (available). 1Click (disabled). Base Sepolia (read-only).
6. Enter receiver NEAR account ID and amount in NEAR.
7. Click **Prepare Payment Plan** → server validates inputs and reads live Testnet state.
8. Review panel shows exact transaction plan: contract, method, action, source, receiver, amount, gas, deposit, signer, payment ID, storage reserve.
9. Click **Submit via Wallet** → wallet signs and broadcasts `relay_execute_subaccount`.
10. Paste transaction hash → click **Verify** → server confirms finalized on-chain evidence.
11. See verified receipt with signer, receiver, amount, transaction hash, and nearblocks.io link.

The 1Click section is preserved below the testnet checkout section, visually dimmed with `pointer-events: none` and a clear **MAINNET ONLY · DISABLED** banner.

---

## 11. Test commands and results

```bash
# Task 45 — Testnet-native checkout
node --test scripts/task45-testnet-checkout.test.js
# → 40/40 pass

# Task 44 — Universal checkout (regression)
node --test scripts/task44-universal-checkout.test.js
# → 21/21 pass

# App server routes (regression)
node --test scripts/app-server.test.js
# → 14/14 pass

# Task 43 — Friend handoff (regression)
node --test scripts/task43-friend-handoff.test.js
# → 11/11 pass

# App config (regression)
node --test scripts/app-config.test.js
# → 7/7 pass

# App server syntax check
node -e "require('./scripts/app-server.js')"
# → exit 0
```

**Total: 93 tests, 93 pass, 0 fail.**

---

## 12. Rust / Sandbox validation

No Rust contract code was modified in Task 45. The existing deployed contracts at the code hashes audited above are sufficient. Running the full Cargo test suite is not justified by any identified Rust defect in this task.

---

## 13. Testnet transactions performed

**NONE.** No Testnet state-changing transactions were submitted during this implementation.

All reads used `finality: final` RPC queries. All writes remain behind user wallet approval.

---

## 14. Testnet transactions not performed and why

| Transaction | Reason not submitted |
|---|---|
| `relay_execute_subaccount → TransferNear` | Requires explicit user approval and wallet signature per policy |
| `nft_transfer` | Not needed for checkout demo |
| Contract/controller deployment | Not needed; existing code is sufficient |
| New account creation | Not needed |

---

## 15. Testnet transaction plan awaiting user approval

If the user wishes to demonstrate a live payment, the following plan is ready:

| Property | Value |
|---|---|
| Network | NEAR Testnet |
| Signer | `relay-owner-b.spellman.testnet` (current NFT owner) |
| Contract | `relay.spellman.testnet` |
| Method | `relay_execute_subaccount` |
| Args | `{ "token_id": "relay-test-1", "action": { "TransferNear": { "receiver_id": "<RECEIVER>", "amount": "<YOCTO_AMOUNT>" } } }` |
| Gas | 100 TGas |
| Attached deposit | 0 yoctoNEAR |
| Reversibility | Not reversible; Testnet NEAR has no monetary value |
| Failure behavior | Contract reverts if owner mismatch, lifecycle locked, or insufficient balance |

**User approval required before submission.**

---

## 16. Git status and pre-existing change preservation

All 9 pre-existing modified files (`M`) and 48+ untracked files (`??`) from Tasks 40–44 are preserved. No pre-existing work was deleted or overwritten.

New untracked files added by Task 45:
- `scripts/near-testnet-payment-authorizer.js`
- `scripts/task45-testnet-checkout.test.js`
- `relay-task-45-testnet-checkout-demo-report.md` (this file)

Modified by Task 45:
- `scripts/asset-registry.js`
- `scripts/app-server.js`
- `web/index.html`
- `web/app.js`
- `README.md`

---

## 17. README changes

Added section: **"Checkout and payment architecture (Task 45)"** with:
- Testnet-native direct payment details and flow
- Mainnet 1Click / NEAR Intents status (preserved, disabled)
- Base Sepolia status (portfolio read-only)
- Full asset status table
- NEP-141 token assessment
- Test run commands
- Testnet transaction policy description

---

## 18. Remaining blockers

| Capability | Blocker |
|---|---|
| Base Sepolia signing | Requires verified Chain Signatures MPC `sign` path with owner-bound constraints — not safe to add without full security review |
| NEP-141 Testnet token payments | No suitable real Testnet token exists without a custom deployment |
| 1Click on Testnet | Provider does not support `wrap.testnet` or any Testnet route |
| Live wallet signing in UI | Requires a connected NEAR wallet (Meteor, MyNEAR, or Wallet Selector bundle) in the browser |

None of these blockers affect the NEAR Testnet native transfer path, which is fully implemented.

---

## 19. Verdict: COMPLETE

All Task 45 requirements are satisfied within the Testnet capability boundaries:

- ✅ NEAR Testnet NFT owner reads from finalized chain state
- ✅ Direct native NEAR transfer via `relay_execute_subaccount → TransferNear`
- ✅ Owner-bound payment authorization (server verifies on every request)
- ✅ Storage reserve preserved (strictly enforced, never bypassed)
- ✅ Replay protection via monotonic `token_nonce`
- ✅ Finalized transaction verification with on-chain evidence
- ✅ 1Click Mainnet-only routes disabled and clearly labelled
- ✅ Base Sepolia portfolio read-only (signing not faked or implied)
- ✅ No fake tokens described as stablecoins
- ✅ No pre-existing work deleted
- ✅ No Testnet transactions submitted without user approval
- ✅ 93/93 tests pass across all test suites
- ✅ App server syntax clean (exit 0)
- ✅ UI shows real Testnet addresses, real balances, real payment state
- ✅ README distinguishes all capability tiers
