# RELAY — Task 47: Product UI Transformation Report

**Repository:** `D:\relay`
**Network:** NEAR Testnet only (contract `relay.spellman.testnet`)
**Date:** 2026-11-11
**Status:** UI implemented and browser-tested; several capabilities remain unverified because they require credentials or keys that are not present in this environment.

---

## 1. Executive summary

RELAY was a read-only technical dashboard. It is now a routed, multi-page product
with a public marketing surface, an authenticated-shaped workspace, a creator
studio, funding, sending, spending, activity, and settings — all backed by the
existing NEAR Testnet backend and the Task 46 payment path.

The transformation is governed by one rule: **the UI may only show what the
backend can actually prove.** Where a capability cannot run in this environment
(Google OAuth, contract-owner minting, wallet-signed transfers), the product says
so explicitly instead of simulating success.

What actually runs today against the live deployment:

- finalized-block reads of `relay-test-1` (owner, binding, lifecycle, credits,
  balance);
- claim-invitation creation, email binding, capability-guarded approval, and
  cancellation;
- funding-plan preparation and the Task 46 spend `prepare-near` plan;
- an activity feed built from real journals and recorded evidence.

What does not run here, and is labelled as such:

- Google sign-in (credentials unset);
- `relay_mint` (contract-owner-only; no owner key);
- wallet-signed funding, mint, spend, or `nft_transfer` (no browser wallet
  signature was executed here).

No fake identity, ownership, balance, payment, mint, provisioning, or claim
success state exists anywhere in the UI.

---

## 2. Scope, constraints, and what this report does not claim

Hard constraints that shaped the work:

- **Preserve RELAY identity.** Cream/light background, navy/black accents, serif
  headings, monospace labels, lime accent, real dark mode. No sci-fi visuals,
  glassmorphism, or decorative gradients.
- **Real operations only.** Every button maps to a backend route. Google identity
  is never treated as wallet ownership or transaction authorization.
- **Testnet only.** No Mainnet, no 1Click execution, no Base Sepolia signing.
  Base Sepolia is a read-only portfolio view.
- **No parallel payment system.** The Task 46 `prepare-near` → sign → `verify-near`
  path is the only spend route.
- **Do not touch secrets or ship.** `.env` was not modified, nothing was
  committed, pushed, or deployed, and no Google OAuth client was configured.

This report does **not** claim: a production deployment, a security audit, a
successful live Google round trip, a successful live mint, or any settled
payment executed by this UI.

---

## 3. Product architecture and route map

The product is a hash-routed single-page app served by `scripts/app-server.js`,
loading `web/app.js`, `web/styles.css`, and `web/index.html`. It keeps the
existing `web/ui-state.js`, `web/near-wallet-adapter.js`, and the Wallet Selector
bundle, and reuses every backend route it needs.

**Public pages**

| Route | Purpose |
|---|---|
| `#/` | Home: identity, value proposition, live status strip, CTA |
| `#/how-it-works` | The object, the identity model, the money, and an honest capability matrix |
| `#/signin` | Google sign-in gate (disabled and explained when OAuth is unset) |
| `#/connect-wallet` | NEAR wallet connection |
| `#/claim?session=…&token=…` | Recipient invitation resolution |

**Workspace pages**

| Route | Purpose |
|---|---|
| `#/overview` | Read-first workspace with live cards and chain facts |
| `#/cards` | All readable cards |
| `#/cards/:tokenId` | Card detail with chain facts and actions |
| `#/create` | Creator studio: mint plan, upload, provisioning plan |
| `#/fund` | Native NEAR funding plan and verification |
| `#/send` | Two-sided email-bound invitation flow |
| `#/spend` | Task 46 payment preparation and verification |
| `#/activity` | Real journal and evidence feed |
| `#/settings` | Identity, wallet, network, creator data, session |

Unknown routes render an explicit 404 page. Legacy backend links of the form
`#claim=…&session=…` are normalized into `#/claim?session=…&token=…`, keeping old
invitations working.

**Access model.** Workspace pages are readable without signing in. Each action is
gated by the capability it actually needs: Google resolves the invited email; a
NEAR wallet signature authorizes value. Guest users see an explicit access gate,
not a hidden wall.

---

## 4. Design system and RELAY identity

The look is a restrained editorial system, not a neon crypto dashboard.

- **Tokens:** `--paper #f5f4ed`, `--surface #fffefa`, `--ink #1c2520`,
  `--navy #202c33`, `--accent #d8e64a`, `--panel-dark #1d2924`, plus dark-mode
  overrides.
- **Type:** serif display headings, sans body, monospace kickers and identifiers.
- **Cards:** the RELAY NFT card is a fixed 5:6.7 aspect surface with the mark, a
  lime account badge, lifecycle tag, token id, title, and owner — the recurring
  visual anchor across Home, Overview, Cards, and Claim.
- **Dark mode:** a real second theme (`data-theme`), verified by screenshot.
- **Motion:** reduced-motion support; no gratuitous animation.

**CSP discipline.** The server sends a strict policy
(`style-src 'self'; script-src 'self'; …`). To satisfy it:

- all ~99 inline `style="…"` attributes were removed from `web/app.js` and
  replaced with real utility classes;
- inline event handlers were removed from `web/index.html`;
- the Google Fonts `@import` was removed from `web/wallet-selector.bundle.css`;
- `web/env-shim.js` provides an inert `window.process.env` so the Wallet Selector
  bundle stops throwing `process is not defined` — `window.RelayWalletSelectorBridge`
  now loads.

The console is clean on every route (verified by CDP: zero errors across 29
route/viewport captures).

---

## 5. Backend truth map (UI action → real endpoint)

| UI action | Real backend operation |
|---|---|
| Read cards, owners, bindings | `GET /api/cards`, `GET /api/cards/:tokenId` → `nft_token`, `relay_account_binding`, `token_lifecycle`, `view_account` at a finalized block |
| Read activity | `GET /api/activity` → claim journal + activity journal + recorded Task 46 evidence |
| Create mint plan | `POST /api/cards/mint-plan` (returns a `relay_mint` plan, owner-only warning) |
| Verify mint | `POST /api/cards/verify-mint` |
| Provision plan / verify | `POST /api/cards/provision-plan`, then re-read |
| Upload artwork | `POST /api/uploads` (PNG/JPEG/WebP, ≤ 2 MiB; SVG rejected) |
| Funding plan | `POST /api/cards/:tokenId/funding-plan` (server-derived receiver) |
| Verify funding | `POST /api/cards/:tokenId/verify-funding` |
| Spend (Task 46) | `POST /api/payment/prepare-near`, then `POST /api/payment/verify-near` |
| Create invitation | `POST /api/claim/session` |
| Read invitation | `GET /api/claim/session/:token` |
| Link recipient account | `POST /api/claim/challenge`, `POST /api/claim/verify-and-link` |
| Approve / cancel | `POST /api/claim/approve`, `POST /api/claim/cancel` (creator capability) |
| Prepare / finalize transfer | `POST /api/claim/prepare-transfer`, `POST /api/claim/finalize` |
| Google sign-in | `GET /api/auth/google/login`, `GET /api/auth/google/callback` |
| Auth status | `GET /api/auth/config` (reports `configured:false` and `missing`) |

No UI success state is derived from client-local optimism; each is the parsed
result of a server response.

---

## 6. Ownership, Google identity, and claim security

**Two separate proofs.** Google OIDC answers *"is this the invited email?"*
NEP-413 answers *"does this wallet control this NEAR account?"* Neither substitutes
for the other. A Google session alone never transfers an NFT.

**Email binding.** `POST /api/claim/session` accepts `intendedRecipientEmail`. The
server stores a SHA-256 hash (`intendedRecipientEmailHash`) in the signed session
and the plaintext only in the server-side journal. The invitation URL contains
only the session token.

Live verification in this session:

- A bound session was created for `invited.friend@example.com`. The returned
  `claimUrl` contained the session token but **not** the email and **not** the
  creator approval capability.
- An unauthenticated read reported `requiresEmailAuth: true`,
  `emailMatchesSession: false`, a masked email `i********@example.com`, and did
  **not** expose `ownerApprovalToken`.
- The session did not echo the recipient email back to the client.

**Creator capability.** `ownerApprovalToken` is HMAC-derived, stored in the
journal and in the creator's browser only, and never placed in the claim link.
Approval and cancellation require it. A recipient holding the link cannot
self-approve.

**Closed and reused links.** After `POST /api/claim/cancel` with the creator
capability, the session state became `CANCELLED` and reading the same link
returned HTTP `400`. Expired sessions render an explicit "expired" notice, and an
owner mismatch after creation renders a "ownership changed" refusal. A forwarded
link is never treated as ownership.

**Identity in the UI.** The sign-in gate is disabled and annotated when OAuth is
unconfigured, stating the missing variables. The claim page shows "Google not
configured" rather than a fake login button. Settings reports identity as
"Identity only".

---

## 7. Funding, spending, and the Task 46 payment path

- **Funding plan.** `POST /api/cards/relay-test-1/funding-plan` returned a native
  NEAR `Transfer` to `relay-test-1.relay.spellman.testnet` (server-derived, not
  typed), with the current balance (`1.72993 NEAR`). Preparing submits nothing.
- **Spend preparation.** `POST /api/payment/prepare-near` returned a
  `Prepared` payment record and a `relay_execute_subaccount` / `TransferNear`
  plan: contract `relay.spellman.testnet`, method `relay_execute_subaccount`,
  attached deposit `0`, gas `100 TGas`, required signer
  `relay-owner-b.spellman.testnet`, token nonce `3` → expected nonce `3`, and a
  deadline. The review object exposes owner-bound, token-bound, no-arbitrary-
  calldata, nonce-bound, and replay-protected flags.
- **No submission.** No transaction was signed or submitted by the UI in this
  session. Verification (`verify-near`) therefore was not exercised live here;
  it is covered by the Task 46 tests and prior recorded evidence
  (`spend.verified` appears in the activity feed).
- **No parallel system.** The UI does not define its own payments; it renders the
  Task 46 plan and calls the Task 46 endpoints.

The UI never marks a payment settled locally. Submitted hashes are sent to
`verify-near`, and only finalized evidence is displayed.

---

## 8. Activity: evidence, not a synthetic feed

`GET /api/activity` merges three real sources and tags each record with its
origin:

- **claim journal** — `claim.session_created`, `claim.account_linked`,
  `claim.creator_approved`, `claim.transfer_prepared`, `claim.transfer_submitted`,
  `claim.transfer_finalized`, `claim.finalized`, `claim.cancelled`;
- **server activity journal** — `claim.approved`, `claim.finalized`,
  `funding.verified`, `spend.verified`, `card.mint.verified`,
  `card.provision.verified`;
- **recorded Task 46 evidence** — real Testnet payment evidence.

At QA time the feed returned the 100-record API limit with real records,
including four finalized claims, ten finalized transfers, and one verified
spend. The page renders the first 40 and offers "Show more"; there is no
generated history.

---

## 9. Responsive QA and screenshots

Screenshots were captured with headless Chrome over the DevTools Protocol using
`Emulation.setDeviceMetricsOverride`, so each image is a true layout width (a
plain `--window-size` run is misleading because Chrome enforces a minimum window
width). Each capture also recorded console errors and document overflow
(`scrollWidth` vs viewport).

Viewports tested: **1440, 1024, 768, 390, 360**, in light and dark mode, across
Home, Overview, Cards, Card detail, Create, Fund, Send, Spend, Activity,
Settings, How It Works, Sign in, Connect Wallet, and Claim.

Result: **zero console errors and zero horizontal overflow** on all 29 captures,
at every viewport.

Two real mobile defects were found and fixed during QA:

1. **Home status strip overflowed at ≤ 640 px.** The three-column
   `.status-strip` forced a ~452 px minimum. It now stacks to one column with
   row dividers.
2. **Workspace top bar overflowed at 360 px.** The net pill plus identity and
   wallet controls exceeded the viewport. The net pill is now hidden at ≤ 390 px.

Curated evidence images are in
[`docs/task-47-screenshots/`](docs/task-47-screenshots/).

---

## 10. Working, unverified, read-only, and blocked

**Working and verified against the live Testnet deployment**

- Finalized-block card reads: owner `relay-owner-b.spellman.testnet`, binding
  verified, `provisioning: Completed`, `lifecycle: Unlocked`, credits `3 / 3`,
  balance `1.72993 NEAR`.
- Claim-invitation creation, email binding, mask, cancellation, and closed-link
  rejection.
- Funding plan and Task 46 spend preparation (plans only).
- Activity feed over real journals and recorded evidence.
- Clean console and no horizontal overflow across all tested viewports.

**Implemented but not live-verified here**

- Google OIDC sign-in and the full claim-by-email round trip (no credentials).
- Wallet-signed funding, mint, spend, and `nft_transfer` (no browser wallet
  signature executed).
- `relay_mint` (contract-owner-only; no owner key available).
- NEP-413 recipient linking against a real funded Testnet wallet.

**Read-only**

- Base Sepolia balances and the derived identity `0x7aE8…2E2D`.
- Contract and account RPC reads at a finalized block.
- Mainnet and 1Click execution are not supported
  (`oneClick.executionEnabled: false`).

**Blocked**

- Arbitrary-user minting: the deployed `relay_mint` is restricted to the contract
  owner and no owner key is available here. The UI prepares the exact plan and
  documents the blocker.
- Live OAuth: `/api/auth/config` returns `configured:false`.

---

## 11. Human-only steps, OAuth configuration, unsupported assets, planned checkout

**Human-only steps**

1. Create Google OIDC credentials and set them server-side.
2. Set `PUBLIC_APP_URL` so invitation links work across devices (otherwise links
   use the local origin).
3. Obtain the RELAY contract owner key to mint.
4. Fund a signing wallet with Testnet NEAR.
5. Connect a NEAR Testnet wallet extension to sign transactions.

**Required Google OAuth environment** (server-side `.env` only; never in browser
code):

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://127.0.0.1:4173/api/auth/google/callback
```

**Unsupported assets and absent features**

- `usdc.fakes.testnet` and `usdt.fakes.testnet` are Testnet faucet fixtures, not
  real stablecoins; the UI says so and never presents them as USDC/USDT.
- No real USDC/USDT settlement, no Mainnet, no 1Click execution, no Base Sepolia
  signing.
- Email delivery is not implemented; the creator shares the link manually.
- No custodial account creation; the recipient must already control a NEAR
  Testnet account.

**Planned checkout**

The Task 46 `prepare-near` → wallet signature → `verify-near` path is the
checkout route for this demo. A second payment system must not be added beside
it. 1Click execution remains disabled until a Mainnet-capable, verified
settlement design exists.

---

## 12. Tests, reproduction, and conclusion

**Focused test suite** (offline, deterministic):

```bash
node --test \
  scripts/app-config.test.js scripts/app-server.test.js \
  scripts/claim-session.test.js scripts/claim-journal.test.js \
  scripts/claim-security-closure.test.js \
  scripts/task43-friend-handoff.test.js scripts/task44-universal-checkout.test.js \
  scripts/task45-testnet-checkout.test.js \
  scripts/task46-integration.test.js scripts/task46-checkout-flow.test.js \
  web/ui-state.test.js web/near-wallet-adapter.test.js
```

Result of the focused run above (Node `node:test`, server stopped so the claim
journal lock is free):

```
tests 219
suites 11
pass 219
fail 0
cancelled 0
skipped 0
duration_ms 3047
```

`npm run test:app` (app config, app server, UI state) passes separately:

```
tests 30
pass 30
fail 0
duration_ms 892
```

The Task 46 browser-wiring section was rewritten for the routed SPA. It now
asserts the properties that matter rather than the removed DOM ids:

- the payment is prepared through `/api/payment/prepare-near` and the returned
  plan is stored intact;
- `verify-near` receives only `paymentId`, `tokenId`, and `transactionHash`, so
  no client-authored expected amount, receiver, or owner can shape the result;
- the connected account must equal `transactionPlan.requiredSigner` or the UI
  refuses to open the wallet with an explicit "Submission is blocked" message;
- wallet submission uses the adapter's `receiverId`/`actions` shape with the
  server's attached deposit;
- pending verification is rendered as "Not final yet", never as success;
- wallet redirects return to verification and state that a submitted hash is
  not finality;
- unknown routes render a 404 page that fabricates nothing;
- the HTML shell contains no inline scripts, styles, or event handlers, and
  loads `env-shim.js` before the Wallet Selector bundle;
- the UI states NEAR Testnet only, 1Click execution disabled, and Base Sepolia
  read-only.

**Screenshot evidence** (29 route/viewport captures plus one bound-claim
capture, all in [`docs/task-47-screenshots/`](docs/task-47-screenshots/)):

| File | What it shows |
|---|---|
| `home-1440.png`, `home-1024.png`, `home-768.png`, `home-390.png`, `home-360.png` | Public home across all five widths |
| `overview-1440.png`, `overview-1024.png`, `overview-768.png`, `overview-390.png`, `overview-360.png` | Workspace overview across all five widths |
| `card-1440.png`, `card-390.png` | Card detail with live chain facts |
| `create-1440.png`, `create-390.png` | Creator studio with the owner-only mint blocker visible |
| `send-1440.png`, `send-768.png`, `send-390.png` | Two-sided invitation flow |
| `spend-1440.png` | Task 46 payment review and verification |
| `activity-1440.png`, `activity-390.png` | Real activity feed with "Show more" |
| `settings-1440.png`, `settings-360.png` | Identity, wallet, network, and session controls |
| `how-1440.png`, `how-390.png` | Capability matrix and boundaries |
| `signin-390.png` | Google gate disabled with the missing-variable explanation |
| `connect-1440.png` | Wallet connection page |
| `claim-390.png` | Invitation page without a bound session |
| `claim-bound-email-390.png` | Email-bound invitation: masked email, Google required, creator approval not exposed |
| `dark-home-1440.png`, `dark-overview-390.png` | Dark mode |
| `capture-summary.json` | Per-capture console-error and overflow record |

The capture summary records **zero console errors and zero horizontal overflow**
for every image. Two defects found during this QA pass were fixed in
`web/styles.css`: `.status-strip` now stacks below 640 px, and the workspace
net pill is hidden at 390 px and below.

**Reproduction**

```bash
npm install
npm start            # SPA + API on http://127.0.0.1:4173
npm run test:app     # app config, app server, UI state
```

Then open `http://127.0.0.1:4173/` and walk the routes.

**Conclusion**

RELAY now reads as a product: a premium card identity, a coherent route
structure, real creator, funding, send, spend, activity, and settings surfaces,
and responsive layouts down to 360 px. The honesty rule held — the UI is careful
to show only what the chain and the backend actually produced. The remaining
gaps are not UI gaps; they are external prerequisites: Google credentials, a
contract-owner key, a funded signing wallet, and a public app URL. Until those
exist, the product says so plainly rather than pretending.
