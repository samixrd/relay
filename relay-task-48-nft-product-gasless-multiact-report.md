# RELAY — Task 48: Google Sign-In, Real Wallet Connect, Cross-User Isolation, and Artwork Upload

**Repository:** `D:\relay`
**Network:** NEAR Testnet only (`relay.spellman.testnet`)
**Date:** 2026-11-13
**Status:** Implementation complete and tested. Real Google popup login, real external-wallet approval, and MPC signing still require a human with Google credentials and an installed Testnet wallet; those steps are listed honestly in section 12.

---

## 0. What this addendum does and does not claim

Task 48 adds four things on top of the verified Task 46/47 product:

1. Google sign-in that actually completes the NEAR Auth path and restores a server session.
2. A real, independent NEAR wallet mode using Wallet Selector and NEP-413.
3. Server-enforced cross-user isolation for every owner-bound action.
4. Real artwork upload with server-side validation and the resulting URI stored in on-chain NFT metadata.

Preserved without regression:

- the Task 46 payment preparation/verification path;
- the deployed contract and controller protections;
- the Testnet-only boundary;
- the legacy direct Google OIDC server flow in `app-server.js` (left intact, not replaced);
- the single Wallet Selector bridge (no second competing adapter).

This report does **not** claim a completed human Google login, a human wallet approval, a Mainnet deployment, a production object-storage deployment, or an external security audit. Every claim below is tied to a command, an HTTP response, or a finalized Testnet transaction.

### Evidence index

| Artifact | Location |
| --- | --- |
| Two-user isolation + artwork evidence | `data/task48-testnet-evidence-mwejhope.json` |
| Adversarial test suite | `scripts/task48-security.test.js` |
| Evidence runner | `scripts/task48-evidence.js` |
| Prior Task 46/47 evidence | `data/near-auth-testnet-evidence-relay-auth-mwda5vg7.json` |

---

## 1. Google sign-in: root cause and fix

### Symptom

Google sign-in could reach Auth0 but the NEAR Auth path failed before an identity could be resolved. The failure was not an OAuth configuration problem: the tenant, client ID, guard, and MPC contract were already correct.

### Root cause A — wrong `callFunction` argument shape in the browser

`web/near-auth.entry.js` called the NEAR RPC like this:

```js
rpc.callFunction({ contractId, methodName: 'derived_public_key', args, finality: 'final' })
```

`near-api-js` 7.4.0 expects:

```js
rpc.callFunction({ contractId, method: 'derived_public_key', args, blockQuery: { finality: 'final' } })
```

The old shape produced an RPC validation error (`missing field 'method_name'` / invalid block reference), so the derived public key was never read and the login could not resolve a signer.

**Fix:** `web/near-auth.entry.js` now uses `method` and `blockQuery: { finality: 'final' }`.

### Root cause B — the same wrong shape in the server relayer

`scripts/near-auth-relayer.js` had the same defect inside `viewFunction`:

```js
nearProvider.callFunction({ contractId, methodName, args })
```

**Fix:** the server now calls:

```js
nearProvider.callFunction({ contractId, method, args, blockQuery: { finality: 'final' } })
```

This was confirmed against FastNEAR: the old call fails with `Failed parsing args: missing field 'method_name'`, while the corrected call returns the `derived_public_key` for the FastAuth path.

### What counts as a successful Google login

A redirect return is not success. The session is created only after:

1. the Auth0 ID token signature is verified against the tenant JWKS;
2. `iss`, `aud`, `exp`, and `email_verified` are checked;
3. the server reads the MPC `derived_public_key` for the verified subject;
4. a server session is created and the `sub` is bound to the account;
5. the browser reloads and restores that session;
6. the user's own cards load from finalized chain state.

The server is the authority. A client-supplied public key or account ID is accepted only if it matches the MPC key for the verified identity.

---

## 2. Signer mapping: Google identity → MPC key → NEAR account

The mapping is deterministic and never derived in the browser alone:

```text
Auth0 sub
  → FastAuth path:  jwt#https://login.testnet.fast-auth.com/#<sub>
  → MPC view:       derived_public_key({ path, predecessor: fast-auth.testnet, domain_id: 1 })
  → public key:     ed25519:<returned key>
  → account:        u-<sha256(path)[0:16]>.relay.spellman.testnet
```

Implementation points:

- `scripts/near-auth-identity.js` — `deriveFastAuthPath`, `deriveUserAccountId`.
- `web/near-auth.entry.js` — reads the MPC key with the corrected RPC call.
- `scripts/near-auth-api.js` — verifies the returned key, binds it to `session.nearAuth`, and uses it for transaction preparation.

Properties:

- The same Google `sub` always maps to the same Testnet account.
- The account is a function of the verified path, not of user input.
- The MPC key signs; the sponsor never signs for the user.
- A different Google account produces a different `sub`, a different path, a different key, and a different account. There is no account collision by construction.

---

## 3. Wallet connection: real methods and flows

Wallet mode is a separate authentication mode with its own session cookie (`relay_wallet_session`). It is never merged with the Google session.

### Bridge methods (`web/near-wallet-selector-entry.js`)

| Method | Behaviour |
| --- | --- |
| `connect(config)` | Opens the real Wallet Selector modal and resolves only after a wallet returns an account or redirects. |
| `restore(config)` | Reads the selector's restored account; never invents one. |
| `disconnect(config)` | Calls the wallet's disconnect and clears local selector state. |
| `signMessage(config, { message, recipient, nonce, callbackUrl })` | NEP-413 sign-in. Handles wallets that return a signature and wallets that redirect. |
| `signAndSendTransaction(config, { receiverId, actions, callbackUrl })` | Wallet-signed card actions; handles redirect-based wallets. |

The existing `web/near-wallet-adapter.js` remains the only adapter. No second wallet stack was added.

### Server routes (`scripts/wallet-auth.js`)

| Route | Purpose |
| --- | --- |
| `POST /api/auth/wallet/challenge` | Creates a 5-minute NEP-413 challenge bound to origin, account, nonce, and expiry. |
| `POST /api/auth/wallet/verify` | Verifies the signature, checks the account did not change, revokes any previous session, creates a wallet session. |
| `GET /api/auth/wallet/session` | Restores the wallet identity after reload. |
| `POST /api/auth/wallet/logout` | Revokes the server session and clears the cookie. |
| `POST /api/near/wallet/prepare-action` | Builds the exact action plan and binds it to the wallet account. |
| `POST /api/near/wallet/confirm-action` | Reads the finalized transaction, checks signer, receiver, exact actions, finality, failure status, and current ownership. |
| `GET /api/near/wallet/assets` | Reads supported NEP-141 balances for the selected card. |
| `GET /api/near/wallet/account` | Reads the connected account's Testnet state. |

### NEP-413 challenge text

```text
RELAY wallet authentication
Origin: <app origin>
Account: <accountId>
Nonce: <32 random bytes, hex>
Expires: <ISO timestamp>
```

Verification checks the signature against a FullAccess key on chain, the recipient, the nonce, the origin, and the expiry. The challenge is single-use.

### Connection semantics

- "Connected" appears only after a wallet returns an account **and** the server verifies the signature.
- Opening the modal is not a connection; closing it without an account produces a rejection message.
- Rejection, unavailable wallet, popup blocked, redirect failure, and network mismatch all surface explicit errors.
- Redirect wallets that return `void` store a pending action in `sessionStorage`; `boot()` resumes it from `transactionHashes` or `errorCode` after reload.
- Disconnect revokes the server session, so a stale cookie cannot keep acting.

**Browser-verified:** the real selector modal opened with **Meteor Wallet** and **MyNearWallet**, with zero console errors.

---

## 4. Device and environment limitations

These are real constraints, not UI omissions:

| Environment | Constraint | What the product does |
| --- | --- | --- |
| Desktop browser with extension | Meteor works through the extension | Real modal, real account, real signature |
| Desktop browser, web wallet | MyNearWallet redirects away and back | Pending auth/action stored and resumed |
| Mobile browser | No browser extensions | Use the wallet's in-app browser or a redirect wallet; the UI says so |
| Mobile upload | Gallery works; camera is only a hint | `accept="image/jpeg,image/png,image/webp"`; desktop picker and drag/drop also work |
| iOS photos | HEIC is not accepted | User must pick/convert JPEG, PNG, or WebP; the limit is stated |
| Popup blockers | Google popup can be blocked | UI asks the user to allow popups for the site |
| Wallet approval | Always human-in-the-loop | RELAY waits; it never fabricates a signature |
| Testnet only | No Mainnet accounts or assets | The server rejects non-Testnet configuration |

The 10 MB limit and accepted formats are documented in the UI and enforced again on the server.

---

## 5. Cross-user isolation architecture

### 5.1 Authentication authority

- Google: `relay_auth_session`, HTTP-only, signed server-side session. Identity comes from `session.nearAuth`, never from a request body.
- Wallet: `relay_wallet_session`, HTTP-only, separate session. Identity comes from `session.walletAuth`, never from a request body.
- The two sessions are independent. A Google session cannot be used as a wallet session, and vice versa.
- Re-authentication revokes the previous session ID, preventing session fixation.

### 5.2 Ownership authority

Every owner-bound operation resolves ownership from the **finalized chain**, not from the UI:

- `nft_token(token_id)` → `owner_id`;
- `relay_account_binding(token_id)` → canonical card account and `is_verified`;
- `relay_provisioning_state(token_id)` → provisioning status.

The card account is always `<token-id>.<contract-id>`. A caller cannot substitute a different account.

### 5.3 Intent binding

A prepared intent is bound to:

- principal (`sub` / wallet account);
- account ID;
- NFT token ID;
- action kind;
- receiver;
- exact Borsh bytes (Google) or exact action list (wallet);
- asset and amount;
- nonce and deadline;
- a single-use action ID.

`activeByAccount` allows only one pending action per account, so two tabs cannot race the same principal.

### 5.4 Re-validation before execution

- Google submit calls `assertIntentStillAuthorized` **before** handing bytes to the relayer. It re-reads the finalized owner and provisioning state. If the NFT moved, it returns `409 OWNERSHIP_CHANGED` and the intent is discarded.
- Wallet confirm re-reads the finalized owner after verifying the transaction. If ownership changed, it returns `403 TOKEN_OWNER`.
- A consumed action is deleted before/at execution, so replay returns `410 ACTION_EXPIRED`.
- The transaction hash is checked for shape, signer, receiver, normalized actions, finality, and on-chain failure.

### 5.5 Forbidden cross-user actions

| Attempt | Result |
| --- | --- |
| Read another user's NFT/account state | Allowed only as public chain data; no private data exists |
| Spend from another user's card | `403 TOKEN_OWNER` |
| Prepare/execute another user's payment | `403 ACTION_OWNER` / `403 TOKEN_OWNER` |
| Reuse another user's payment ID | `410 ACTION_EXPIRED` |
| Reuse another user's nonce/session | Challenge is single-use; session is bound to its own identity |
| Change receiver/amount after prepare | `403 RECEIVER_MISMATCH` / `403 ACTIONS_MISMATCH` |
| Claim/modify another user's invitation | Owner check on claim routes |
| Access another user's uploaded file | Uploads are public artwork by design; there is no delete endpoint, and filenames are content-addressed and non-guessable |

### 5.6 Transport and browser hardening

- Loopback bind; non-local `Host` and cross-origin mutating requests are rejected.
- HTTP-only, `SameSite=Lax` cookies; `Secure` when the public app URL is HTTPS.
- Strict CSP; `frame-ancestors 'none'`; `base-uri 'none'`.
- Rate limits on prepare/submit per principal.
- No RPC URLs or server credentials in the public browser config.

---

## 6. Security test matrix

All rows below were executed by `node --test scripts/task48-security.test.js` against the actual app server HTTP surface with two injected principals and a mocked finalized-chain read layer. This is not a unit test of helpers.

| # | Attack | Expected | Actual |
| --- | --- | --- | --- |
| 1 | Google B prepares a spend from A's card | `403 TOKEN_OWNER` | pass |
| 2 | Google B prepares a transfer of A's NFT | `403 TOKEN_OWNER` | pass |
| 3 | Google A prepares a spend from B's card | `403 TOKEN_OWNER` | pass |
| 4 | Wallet B prepares a spend from A's card | `403 TOKEN_OWNER` | pass |
| 5 | Wallet A prepares a transfer of B's NFT | `403 TOKEN_OWNER` | pass |
| 6 | Wallet B confirms A's prepared action | `403 ACTION_OWNER` | pass |
| 7 | Replay an unknown/consumed action | `410 ACTION_EXPIRED` | pass |
| 8 | Malformed transaction hash | `400 TRANSACTION_HASH` | pass |
| 9 | Finalized tx with a different receiver | `403 RECEIVER_MISMATCH` | pass |
| 10 | Finalized tx with different actions | `403 ACTIONS_MISMATCH` | pass |
| 11 | NFT ownership moves between prepare and submit | `409 OWNERSHIP_CHANGED` | pass |
| 12 | Session A still resolves to A while B is rejected | own identity only | pass |
| 13 | Anonymous artwork upload | `401 AUTH_REQUIRED` | pass |
| 14 | Google principal uploads a real PNG | `200`, owner = A | pass |
| 15 | Wallet principal uploads a real PNG | `200`, owner = B | pass |
| 16 | HTML disguised as `image/png` | `400` | pass |
| 17 | SVG data URL | `400 UNSUPPORTED_IMAGE_TYPE` | pass |
| 18 | SVG bytes labelled PNG | rejected | pass |
| 19 | Buffer over 10 MB | rejected before storage | pass |
| 20 | Path traversal / non-image name | `null` / rejected | pass |

Additional suites:

| Suite | Result |
| --- | --- |
| `npm run test:app` | 27 pass, 0 fail |
| `node --test scripts/near-auth-*.test.js scripts/auth-provider-adapter.test.js scripts/account-continuity.test.js` | 32 pass, 0 fail |
| `node --test scripts/task48-security.test.js` | 21 pass, 0 fail |
| `cargo test` | 112 contract + 11 sub-controller, 0 fail |
| Browser smoke (all routes, both auth UIs) | 0 console errors |

---

## 7. Testnet adversarial evidence (real backend, real finalized reads)

`node scripts/task48-evidence.js --execute` ran against `relay.spellman.testnet` with two distinct controlled Testnet accounts. The backend performed real finalized-chain reads for every rejection.

**Accounts**

- A: `spellman.testnet`
- B: `relay-owner-b.spellman.testnet`

**Cards**

- A: `t48a-mwejhope`, card account `t48a-mwejhope.relay.spellman.testnet`
- B: `t48b-mwejhope`, card account `t48b-mwejhope.relay.spellman.testnet`

**Rejections observed**

| Attempt | HTTP | Code |
| --- | --- | --- |
| Google B prepares a spend from A's card | 403 | `TOKEN_OWNER` |
| Google A prepares a spend from B's card | 403 | `TOKEN_OWNER` |
| Wallet B prepares a spend from A's card | 403 | `TOKEN_OWNER` |
| Wallet A prepares a transfer of B's NFT | 403 | `TOKEN_OWNER` |
| Anonymous upload | 401 | `AUTH_REQUIRED` |

Both cards' controllers matched the deployed controller byte-for-byte:

- 164,590 bytes;
- SHA-256 `9dcd020761c350058894653cf9a9a1b09910076363a6d8824d775f1b0dadafe6`.

Evidence file: `data/task48-testnet-evidence-mwejhope.json`.

---

## 8. Artwork upload and storage

### 8.1 Client behaviour

- Real file input: `accept="image/jpeg,image/png,image/webp"`.
- Desktop file picker, drag-and-drop, and mobile gallery all use the same input path.
- Camera is an optional hint, not a separate fake capture flow.
- Local preview appears immediately, separate from the persistent URI.
- Replace, remove, upload progress, and retry are implemented.
- Upload uses `XMLHttpRequest` with raw binary and progress events.
- No base64/data URL is written to `localStorage`; a blob URL is never submitted as metadata.

### 8.2 Server behaviour

`scripts/upload-store.js` is authoritative:

1. authenticate the Google or wallet session;
2. enforce the 10 MB limit before parsing;
3. check declared MIME type;
4. sniff the file signature and container structure;
5. reject SVG, HTML, executables, and disguised files;
6. generate a safe name: `<random>-<sha256 prefix>.<ext>`;
7. reject path traversal before any filesystem access;
8. write an owner sidecar;
9. return the real provider, byte count, SHA-256, content type, and whether the URI is permanent.

### 8.3 Providers

| `UPLOAD_STORAGE_PROVIDER` | Behaviour | Permanent claim |
| --- | --- | --- |
| `local` (default) | Durable files under `data/uploads` on this host | `permanent: false` |
| `http` | Raw `PUT` to object storage returning a public HTTPS URL | provider-dependent |
| `ipfs` | Pin via an IPFS pinning endpoint, serve from a gateway | provider-dependent |

`s3` and `object` are aliases for `http`. A non-local provider without its settings fails closed with `STORAGE_UNAVAILABLE`; it never silently falls back to memory.

Documented placeholders in `.env.example`:

```text
UPLOAD_STORAGE_PROVIDER=local
UPLOAD_HTTP_ENDPOINT=
UPLOAD_HTTP_TOKEN=
UPLOAD_HTTP_PUBLIC_BASE=
UPLOAD_IPFS_PINNING_URL=
UPLOAD_IPFS_TOKEN=
UPLOAD_IPFS_GATEWAY=
```

The local provider is explicitly not described as permanent public storage anywhere in the product or report.

---

## 9. Accepted types and limits

| Rule | Value |
| --- | --- |
| Accepted formats | JPEG, PNG, WebP |
| Maximum size | 10 MB (10 × 1024 × 1024 bytes) |
| Rejected | SVG, HTML, executables, unknown magic bytes, truncated containers |
| File name | server-generated, lowercase, content-addressed |
| Token ID | `^[a-z0-9_-]{1,32}$` |
| Reserved token prefix | `u-` |
| Card title | 1–64 characters |
| Card description | ≤ 500 characters |
| Media URI | `https://…` or `/uploads/<safe-name>.(png\|jpg\|jpeg\|webp)` |
| Wallet challenge TTL | 5 minutes |
| Wallet pending action TTL | 5 minutes |
| Wallet session TTL | 8 hours |
| Pending Google intent TTL | server-side cleanup window; re-validated before submit |

Server-side validation is not bypassed by changing the `Content-Type` header or by sending a data URL instead of binary.

---

## 10. Actual URI and on-chain metadata verification

### Upload result

| Field | Value |
| --- | --- |
| URI | `http://127.0.0.1:4173/uploads/mwejhsuv-dadf0b4b81f5e8bb98d638e4fe114753.png` |
| Bytes | 46,110 |
| SHA-256 | `6e4a413484e087513cc196d0c346c0225bb2c2810b8db9c3b8a8994c13ecc9eb` |
| Content type | `image/png` |
| Provider | `local` |
| Permanent | `false` |
| Owner | `spellman.testnet` |

### Read-back from the finalized chain

Both cards were read with `nft_token` at finality after minting:

| Card | Owner | `metadata.media` | Card account | Binding |
| --- | --- | --- | --- | --- |
| `t48a-mwejhope` | `spellman.testnet` | the URI above | `t48a-mwejhope.relay.spellman.testnet` | verified |
| `t48b-mwejhope` | `relay-owner-b.spellman.testnet` | the URI above | `t48b-mwejhope.relay.spellman.testnet` | verified |

The browser also rendered the artwork on `#/cards/t48a-mwejhope`, loaded from that on-chain URI, with zero console errors. This confirms the chain metadata is not just stored but consumable by the product UI.

Because the local provider is used, the URI is reachable only while this host serves it. It is **not** a permanent public URI, and the report does not claim otherwise. Selecting `http` or `ipfs` produces the corresponding public URI instead.

---

## 11. Testnet transaction hashes

### Task 48 evidence

| Step | Transaction |
| --- | --- |
| Fund B for independent provisioning (3 NEAR) | `C2XvQV39u3WuL2qRTnK5AXRMB8umFRRYXUqbiX347fXm` |
| Mint `t48a-mwejhope` to A | `GirnN4r7ANisw34eASUfYcbdBECdqqPZCmJ1eABHLRpE` |
| Mint `t48b-mwejhope` to B | `AaVsvhib8NBYjKvDgxK25i5k5W7QiVHo6dYb6YLNGU4D` |
| Provision `t48a-mwejhope` | `5p9ZNZBcAKB88qht36VJe9b22wR7g8fuDRMbM7dFaHyh` |
| Provision `t48b-mwejhope` | `81RAjJ8EHafpnJiTvbH4WBubFjvS6MSjnJS39gwU22z4` |

### Preserved Task 46/47 evidence (`relay-auth-mwda5vg7`)

| Step | Transaction |
| --- | --- |
| Permissionless self-mint | `J9XFBtBGTT3dZcLYHbk2CCa29LchdGhivoTBUEWuSjgx` |
| Card account provision | `BzjybQJjpizrXZ7cf5T2AqdCTye6wzzB7Qzm341kuFih` |
| wNEAR storage registration | `DhtLaHLBXBjsdU2Z1xaS8HdDfbz5m1jZjfEoq7tBZ6xi` |
| Direct native NEAR spend | `9RBdwahYLtYEns9ewvemD3dbbL2AjNH4ryeqa9No59YZ` |

Explorer: `https://testnet.nearblocks.io/txns/<hash>`.

---

## 12. Remaining human-only steps

These cannot be completed by an automated agent in this environment. They are not simulated anywhere in the product.

1. **Real Google popup login.** A human must open `#/signin`, click **Continue with Google**, allow the popup, and complete the Google/Auth0 flow with a real Google account. The server-side verifiers and the corrected MPC path are ready; the human interaction is the missing part.
2. **Real MPC transaction signature.** After login, a human must create a card (or perform another sponsored action) and approve the Auth0 signing request. This produces the first end-to-end Google-signed Testnet transaction.
3. **Real external wallet approval.** A human with Meteor (or MyNearWallet) on Testnet must click **Connect NEAR Wallet**, approve the NEP-413 challenge, and then approve one wallet-signed card action. The modal is verified to open; the approval is not automated.
4. **Wallet redirect round trip.** A human on MyNearWallet should complete the redirect flow once to confirm the pending-action resume path on their specific wallet version.
5. **Production artwork storage.** An operator must choose and configure `http` or `ipfs` with real credentials, then upload once and confirm the public URI is reachable from a different network. The adapter and fail-closed behaviour are implemented; no production credentials exist here.
6. **Mobile device pass.** Test the gallery picker and the wallet's in-app browser on a real Android and a real iPhone. The responsive UI and format limits are implemented; device-specific behaviour is not claimed.
7. **Live wNEAR transfer.** Task 46/47 registered wNEAR storage but did not move wNEAR. A human should fund the card account with wNEAR and execute one NEP-141 spend to complete that branch.
8. **Independent security review.** The adversarial suite covers the specified cross-user classes, but it is not a substitute for an external audit.

Everything else in this report — the Google root-cause fixes, signer mapping, wallet bridge, isolation checks, upload validation, on-chain mint/provision/metadata read-back, and adversarial rejections — was executed and is reproducible with the commands below.

---

## Reproduction

```bash
# 1. Build both browser bundles
npm run build:near-auth
npm run build:wallet

# 2. Stop the dev server first: it holds the journal lock.
npm run test:app
node --test scripts/near-auth-*.test.js
node --test scripts/task48-security.test.js
cargo test

# 3. Read-only evidence preview
node scripts/task48-evidence.js

# 4. Real Testnet evidence (uploads, mints, provisions, reads back, attacks)
node scripts/task48-evidence.js --execute
```

No `.env` value, credential, token, or private key is printed by any command in this report. Nothing was committed, pushed, or publicly deployed.
