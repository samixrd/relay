# RELAY Sandbox integration tests

The standalone harness runs Stages A–L against disposable accounts on local
NEAR Sandbox. It is intentionally outside the Cargo workspace; the integration
manifests and lockfiles pin the fixtures independently.

## Requirements

- Ubuntu 24.04 under WSL2
- Rust 1.95.0 and the `wasm32-unknown-unknown` target
- NEAR Sandbox 2.14.0 (started by `near-sandbox` 0.4.0)
- Node.js 18+ in WSL2 with the root npm dependencies installed, for Stage J

## Reproduce

From Windows PowerShell, build the current RELAY WASM and run the complete
harness in Ubuntu 24.04:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'cd /mnt/d/relay && cargo build --release -p relay-contract --features sandbox-checkout-dispatch --target wasm32-unknown-unknown && cargo build --release -p relay-subaccount --target wasm32-unknown-unknown'
wsl.exe -d Ubuntu-24.04 -- bash -lc 'cd /mnt/d/relay/integration-tests && cargo run --release'
```

The first command deliberately opts the local harness artifact into
`sandbox-checkout-dispatch`; Stage A initializes it through the feature-gated
`new_sandbox_checkout_test` method. Ordinary `new`/`new_default_meta`
initialization leaves the immutable local-dispatch state disabled, even in a
feature-enabled build. A default contract build also omits the feature and
rejects dispatch. The feature-enabled WASM cannot reliably identify Sandbox
and can transfer to any valid NEAR account if used with its test initializer;
never deploy or otherwise use that artifact outside the disposable local
harness. It also compiles a deterministic fixture Ed25519 verification key,
not the 1Click provider key. The ordinary/default build instead pins the
provider key shipped by SDK 0.1.26. `.sandbox` suffixes are test account
labels, not network detection.

The harness builds the external NFT, receiver, fungible-token, and payment
receiver fixtures itself. The successful Stage H run observed:

- NEP-141 storage registration for the canonical account and registered
  receivers, followed by fixture-token minting and balance verification;
- parent-mediated `ft_transfer` and accepted `ft_transfer_call`, with the
  canonical subaccount recorded as sender and exact receiver/amount/message
  observations and resulting token balances;
- full-use, zero-use, partial-use, and failed-receiver `ft_transfer_call`
  outcomes verified using the standard resolver result and actual balances;
- previous-owner, unrelated-caller, and direct-controller authorization
  failures;
- failed transfer to an unregistered receiver, insufficient token balance,
  insufficient storage deposit, and a standard FT call with no 1 yoctoNEAR;
- NFT ownership transition after a terminal payment, stable canonical account
  identity, successful payment by the new owner, and old-owner rejection;
- an explicitly injected resolver failure after the receiver accepted tokens,
  leaving `RecoveryRequired`, the token locked, and transfer/payment/credit
  actions blocked.

The parent contract unit tests additionally cover starting a second payment
while one is pending, stale and duplicate callback nonces, terminal callback
idempotence, and recovery-state locking. The Sandbox harness awaits the
cross-contract receipt chain for each transaction, so it does not claim to
race two client transactions against a still-pending receipt in real time.

Stage A–G scenarios remain enabled. The harness covers NFT mint/transfer,
provisioning and controller binding, native NEAR dispatch, token-bound credits,
child NEP-171 custody, and RELAY NFT transfer-call acceptance/rejection. The
external-NFT-to-controller `nft_on_transfer` path remains unresolved and is not
claimed as tested.

Stage K provisions a separate RELAY-controlled subaccount, transfers 0.1
native NEAR to a controlled local Sandbox account through `TransferNear`, and
asserts the exact source and receiver balance deltas. It makes no 1Click API
request and does not send funds to a provider. This tests the local controller
mechanism only; it does not prove that 1Click accepts a native transfer or
associates it with a quote.

Stage L connects the owner-bound checkout preparation records to RELAY's
payment lifecycle and the subaccount's NEP-141 `ft_transfer` path. It uses
Stage H's local mock wrapped-NEAR token, not production `wrap.near`, and sends
no funds to a real 1Click deposit address. It is not a complete checkout or a
working Universal Checkout. It covers minting, provisioning, binding
verification, authorization of a deterministic SDK test quote, execution,
exact mock-token balance deltas, native storage reserve preservation,
`SourceTransferCompleted` recording and token-lock retention, duplicate
execution rejection, signature digest replay rejection, old-owner invalidation
and rejection after NFT transfer, cancelled and expired preparation rejection,
insufficient-balance fault-injection into `RecoveryRequired`, and invalid
recipient rejection. `SourceTransferCompleted` records only the successful
local NEP-141 transfer callback; it does not mean provider deposit acceptance,
swap execution, destination settlement, or refund. There is no supported
production dispatch mode; the feature-enabled test artifact must never be
deployed.

The production/default quote authorization method independently verifies the
provider signature over the SDK's stable-JSON SHA-256/Base58 message using the
NEAR Ed25519 host function and the single public key embedded by SDK 0.1.26.
The adapter still verifies the provider response before presenting it. The
SDK signature projection overwrites the request's `deadline` with the quote's
`deadline`; the distinct request deadline is owner-selected, not provider
signed, and is bounded on-chain to the signed provider quote deadline. The SDK
protocol has no key ID or rotation endpoint, so a provider key change requires
an audited code update. Signature verification authenticates quote data only:
it does not prove a deposit, provider acceptance, destination settlement, or
refund, and production dispatch remains disabled pending independent
settlement/refund verification.

## Stage H architecture and boundary

The canonical subaccount controller has a parent-only `execute_payment`
method. It can dispatch only NEP-141 `ft_transfer` and `ft_transfer_call`,
attaches exactly 1 yoctoNEAR, and uses explicit gas budgets. The parent records
the RELAY token, canonical account, owner at dispatch, token contract,
receiver, amount, nonce, opaque payment reference, optional deadline, and
resolver result. The canonical controller is the FT sender and therefore the
standard resolver's refund recipient. It locks NFT transfer, credit redemption,
another payment, and other controller operations until a terminal outcome.

Payment records keep `token_transfer_status` separate from
`checkout_status`. Full amount used is `TokenTransferCompleted`; zero used is
`TokenTransferRefunded`; partial use is `TokenTransferPartiallyRefunded`;
direct transfer receipt failure is `TokenTransferFailed`. A transfer-call or
resolver receipt failure with ambiguous state is `RecoveryRequired` and remains
locked. Every Stage H record has `checkout_status: null`: a completed local
token transfer is not evidence that a checkout was settled. An optional
deadline is a future NEAR block timestamp in nanoseconds; reaching it does not
unlock the token or assert a refund. Stale/duplicate callbacks cannot resolve a
different nonce or alter an already terminal/recovery-required record. If a
future checkout is explicitly marked `CheckoutPending`, resolving the NEP-141
transfer does not unlock the NFT; only `CheckoutSettled` or `CheckoutRefunded`
is modeled as terminal for that checkout lock. No checkout transition method is
currently implemented.

NEP-141 `ft_on_transfer` returns the **unused** amount. The token contract's
`ft_resolve_transfer` returns the **amount used** after its refund logic. A
receiver callback failure is treated by the pinned standard resolver as all
amount unused, so the resolver attempts to return it to `sender_id`. The
resolver runs in a later receipt; successful state changes in that receipt
restore the sender's balance. If the resolver receipt itself fails, its state
changes roll back and the receiver may still hold the transferred tokens.
Stage H injects that failure and demonstrates the resulting permanent lock.

The NEP-141 refund account is the `sender_id` supplied by the token contract,
which for this flow is the canonical RELAY subaccount/controller. There is no
configurable `refund_destination` field; the standard token resolver does not
read one. This is not equivalent to a NEAR Intents `refundType: INTENTS`
refund. Production refund behavior is not verified.

These semantics were checked against
[NEP-141, `ft_on_transfer` and `ft_resolve_transfer`](https://github.com/near/NEPs/blob/master/neps/nep-0141.md#ft_on_transfer)
and the pinned `near-contract-standards` 5.30.0 source
`near-contract-standards/src/fungible_token/core_impl.rs`.

There is no backend reconciliation service in this repository. Stage H and the
read-only quote adapter accept no 1Click status value as contract authority.
Any future settlement adapter must separately pin and validate the current
status schema and decide which statuses are eligible even to consider. An
update must be bound to the RELAY contract, token ID, payment nonce, and
provider/deposit reference; only an authenticated, nonce-matching path may
submit evidence. Terminal success requires independently verified on-chain
settlement evidence, and refund requires on-chain proof of the actual refund
rather than an API assertion. Duplicates and stale nonces must be rejected.
API outages, timeouts, missing receipts, partial settlement, and conflicting
evidence remain locked in recovery. There is intentionally no recovery/unlock
endpoint: a current or former owner, administrator, or client
cannot manufacture evidence to clear the lock. Funds remain at whichever
account owns them after the last committed FT receipt, and the RELAY NFT stays
non-transferable until a future proof-based recovery design exists. Client-
supplied `SUCCESS` must never resolve payment state.

Operational handling for an ambiguous result is therefore manual and
non-mutating: retain the RELAY token ID/nonce and transaction receipt chain,
record available FT balances and contract logs as diagnostic evidence, do not
retry the transfer or mark the checkout paid, and keep the token locked. Those
observations do not authorize an on-chain unlock. If evidence cannot establish
one outcome, leave the payment permanently locked until a separately reviewed
contract/recovery design exists.

## Refund claim quarantine

The parent contract's NEAR refund claim has three effective states:

| State | Accounting | Allowed next step |
|---|---|---|
| Available | Amount remains in the owner's claimable balance and in global liabilities. | Owner may claim if liquid funds cover storage reserve and all liabilities. |
| ClaimPending / quarantined | Claimable balance is moved to a nonce-bound pending record; the amount remains in global liabilities. | Only the matching transfer callback can resolve it. A repeated claim is rejected. |
| Resolved | On callback `Ok(())`, the transfer succeeded and the liability is removed; on callback `Err`, the transfer failed and the amount is restored to Available. | A known failed transfer may be retried; a successful transfer is never re-credited. |

`Err` is actionable only when the callback receipt itself executes. If that
callback receipt fails or never commits, the contract has no safe way to tell
whether the earlier transfer succeeded. The claim therefore remains
quarantined indefinitely: it is not restored, paid again, timed out, or
cleared. NEAR contract execution exposes the result of the promise to its
callback, but does not let a later contract call inspect arbitrary historical
receipts. Without independently verifiable evidence or a runtime callback
result, manual/permissionless retry could double-pay; the contract provides no
such recovery operation. This can make the claimant's refund unavailable and
can keep global liabilities high enough to block other claims. Local unit tests
cover callback-not-committing quarantine, failed-transfer restoration, success,
stale/duplicate callbacks, and aggregate solvency. They do not simulate a real
callback receipt out-of-gas condition in Sandbox.

## Stage I quote authorization mechanics

Stage I exercises the separate, on-chain quote-authorization state machine
using local deterministic data. It verifies current-owner authorization,
canonical verified-account binding, a distinct monotonic quote nonce,
commitment-field binding, duplicate authorization rejection, transfer
availability while a quote is reserved, invalidation on NFT ownership change,
old-owner rejection, owner-funded storage growth with excess refund, and
authorization consumption by the new owner.

The fixture does not contact 1Click or verify an actual provider quote; the
feature-enabled contract verifies only the deterministic local fixture key.
The production/default adapter uses the official SDK to verify the quote
signature and reads the RELAY owner, binding, nonce, and active authorization
from one finalized RPC block. The production/default contract independently
verifies the provider signature and binds its signed fields to the commitment.
RPC responses are not cryptographic proofs of contract state.
`Consumed` is an authorization lifecycle state only and does not mean payment
succeeded, a refund occurred, or an NFT may be unlocked on settlement grounds.

Stage J connects the adapter to the actual local Sandbox contract. The harness
starts a separate native WSL Node process against the Sandbox RPC endpoint; the
adapter reads the owner, verified canonical account, quote nonce, and active
authorization from finalized contract state. A deterministic local Ed25519
fixture key signs a protocol-shaped quote fixture, and the pinned SDK verifier
checks it using that explicit test key. The feature-enabled contract artifact
independently verifies the fixture signature with the matching test-only key;
it does not use or demonstrate the provider's production key. A separate Rust
contract test verifies a genuine pinned-SDK quote fixture against the key
embedded in the production/default build. One Sandbox path supplies the fixture
signature without the optional `ed25519:` prefix, authorizes its canonical digest on the actual
contract, then proves a later prefixed representation cannot reuse that digest.
The adapter creates the commitment; the Sandbox owner submits those arguments,
and a fresh adapter process verifies the exact stored authorization. Stage J
also checks cancellation and cross-token replay, actual Sandbox time
fast-forward and persisted expiry, transfer invalidation and old-owner
rejection, fresh quote authorization by the new owner with the updated nonce,
and that no payment record is created. The fixture key and quote are test-only,
not production provider credentials or a live 1Click quote. Authorization and
`Consumed` status are not payment execution, settlement, refund, or NFT unlock
evidence.

## Task32P reconciliation boundary

The pinned SDK 0.1.26 exposes `GET /v0/status` and optional
`POST /v0/deposit/submit`. Its status enum is `KNOWN_DEPOSIT_TX`,
`PENDING_DEPOSIT`, `INCOMPLETE_DEPOSIT`, `PROCESSING`, `SUCCESS`, `REFUNDED`,
and `FAILED`. Status responses contain the original quote response and
provider-reported swap/transaction details, but are not themselves signed by
the quote-signing protocol. `/v0/deposit/submit` is a notification endpoint,
not source-chain verification.

The reconciliation module's deterministic tests use the authentic pinned-SDK
quote signature fixture and local status fixtures. It durably journals
observations and checks the RELAY payment, authorization, owner, binding, and
lock at one RPC block. Provider-reported status remains separate from source
transfer state; out-of-order observations are recorded without replacing newer
provider observations or promoting the payment. It does not interpret
provider status as chain evidence or permit an NFT unlock. Stage L executes
the local mock NEP-141 token, not production `wrap.near`; no independent
finalized source receipt or provider quote association is verified. The
Arbitrum destination and origin refund paths remain unsupported without
independent finality verifiers. These local fixtures are not provider-status
authentication or public-chain evidence.

Provider signature identity is SHA-256 over the decoded 64-byte Ed25519
signature, not the textual Base58 representation. The adapter strips the
optional `ed25519:` prefix exactly once; malformed Base58 and non-64-byte
signatures are rejected. The contract recomputes that lowercase 64-character
hex digest only after verifying the signature. It stores the identity in a
persistent global-used set for the RELAY contract, across token IDs and
authorization terminal states. The SDK signature has no key ID and the
contract has no runtime key-rotation method; changing the provider key
requires an audited code update. The adapter remains an early verification
and presentation boundary, but is no longer the sole authorization boundary:
a direct caller must provide a provider-signed canonical payload that matches
the exact contract authorization fields. The adapter's test-only manager-key
helper and feature-enabled contract artifact use the deterministic fixture
public key; production quote APIs use the SDK default verifier and the
ordinary/default contract build pins its corresponding key.

The pinned SDK protocol hashes a stable JSON serialization of selected request
and quote fields plus the response timestamp with SHA-256, Base58-encodes the
digest, and signs/verifies the UTF-8 bytes of that Base58 text with Ed25519.
The SDK has one embedded provider key and no key ID or rotation mechanism.
NEAR SDK 5.30.0 exposes the native `ed25519_verify` host wrapper, implemented
in the pinned `near-vm-runner` 0.38.0. The runtime schedule lists a 0.210 TGas
base plus 9,000,000 gas per message byte (396,000,000 gas for the 44-byte
Base58 digest), before input costs; this is not a
measured total. A deployment still must target a protocol version supporting
this host function. No public-network deployment was performed.

Excess authorization deposits are not pushed asynchronously. After measuring
the authorization and refund-map storage growth, the contract records any
remaining amount as the owner's unclaimed refund liability. The standard
claim path reserves liabilities before transfer, fails closed when liquid
funds do not cover all claims, and restores a failed claim once; stale or
duplicate claim callbacks are ignored. This pull-refund design avoids an
authorization-time refund callback that could leave the authorization and
refund accounting ambiguous.

NEP-141 custody, transfers, and resolver/refund mechanics are tested locally.
1Click deposit and settlement are NOT tested; production refund behavior is
NOT verified. RELAY has not completed Universal Checkout.

## Read-only 1Click quote adapter

The root `scripts/oneclick-quote-adapter.js` module requests a 1Click quote and
verifies it with the official `@defuse-protocol/one-click-sdk-typescript`
package, pinned exactly to **0.1.26** (official source commit
[`414467b879863661e736eab338b316f567db68fe`](https://github.com/defuse-protocol/one-click-sdk-typescript/tree/414467b879863661e736eab338b316f567db68fe)).
The SDK's
[`verifyQuoteSignature`](https://github.com/defuse-protocol/one-click-sdk-typescript/blob/414467b879863661e736eab338b316f567db68fe/src/quote-signature.ts)
uses Ed25519 over selected quote request/response fields serialized as stable
JSON and hashed with SHA-256/base58. Covered fields include the request's
assets, amount, recipient/refund policy, quote output, deposit address/memo,
quote deadline/inactivity deadline/estimate/fees, and timestamp. The SDK merges
the request and quote projections with object spread; since both contain a
`deadline` key, the quote deadline replaces the request deadline in the signed
payload. The request deadline is therefore owner-selected and is bounded by
the contract to the signed quote deadline. The SDK does not sign the entire API
response: correlation ID, app fees, and provider request extensions are not
covered by its hash. The adapter checks the
supported `depositMode`, confidentiality, insurance, and wait-time extension
values locally, but those checks are not a provider signature. The verifier
does not cover a later status response, and the adapter does not accept status
responses as settlement evidence.

Run the deterministic adapter tests from the repository root:

```powershell
npm install
npm run test:quotes
npm run test:preparation
npm run test:reconciliation
```

To make a public, read-only quote request (no credentials or transaction):

```powershell
npm run oneclick:quote -- --rpc-url https://rpc.testnet.near.org --token-id <token-id> --relay-contract <relay-contract.testnet> --recipient 0x2527D02599Ba641c19FEa793cD0F167589a0f10D --amount 100000000000000000000000
```

Replace the placeholders with a RELAY token and contract deployed on testnet.
The CLI accepts `--token-id`, `--relay-contract`, `--recipient`, and `--amount`,
plus optional `--rpc-url`; it derives the canonical associated account from the
token and contract IDs and reads the owner, account verification, and quote
nonce from RELAY RPC state. The request is public and read-only; it does not
send a transaction or use funds. The immutable local quote envelope is not
on-chain state, a provider-signed RELAY authorization, or durable replay
protection. Its one-use check is process-local only.

The initial quote allowlist is deliberately narrow: `nep141:wrap.near` as the
origin asset and
`nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near` as the
destination asset, with `ORIGIN_CHAIN` deposit/refund policy and an EVM
recipient. This allowlist does not imply custody of the asset or production dispatch.

A verified quote proves only that the official quote signature is valid for
the SDK-selected fields and that those fields match the caller's request. It
does not prove a deposit, execution, settlement, or refund. It cannot mark
`CheckoutSettled`/`CheckoutRefunded` or unlock a RELAY NFT.

The signed quote's `originAsset` is the protocol identifier
`nep141:wrap.near`; for `depositType: ORIGIN_CHAIN`, its `depositAddress` is
the origin-chain recipient, not a NEAR Intents verifier address. The
parent-mediated prepared-payment code uses the authorized `wrap.near`
NEP-141 token, exact signed amount and destination, and forwards optional
`depositMemo` unchanged to `ft_transfer` with one yoctoNEAR. `refundTo` is
requested as the canonical RELAY-associated account with `refundType:
ORIGIN_CHAIN`, but successful future refunds also depend on provider support
and the account's ability to receive the token; neither is proven by quote
verification.
The Sandbox fixture explicitly registers and funds the canonical account on
the mock FT contract. The source path does not issue a `storage_deposit` call
to production `wrap.near`; source-account registration/funding and refund
receipt must be verified before any real quote can safely rely on that
`refundTo`.

Stage L exercises those NEP-141 call semantics and exact memo forwarding using
an explicitly local mock wrapped-NEAR token. It does not use production
`wrap.near`, contact 1Click, or prove that a provider deposit address accepts
the transfer or associates it with the quote. The production/default contract
dispatch gate remains disabled. Source transfer callback success is not
provider acceptance, destination settlement, or refund evidence. Direct
deposits to the NEAR Intents Verifier are a different flow and require wNEAR
using that verifier's deposit mechanism.

References: [1Click quote quickstart](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request.md),
[1Click SDK](https://docs.near-intents.org/integration/distribution-channels/1click-api/sdk.md),
[NEAR token Verifier flow](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/near-token.md),
[Verifier deposits](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits.md),
[Verifier events](https://docs.near-intents.org/integration/verifier-contract/events.md),
[near-intents-examples](https://github.com/near-examples/near-intents-examples), and
[the pinned TypeScript SDK](https://github.com/defuse-protocol/one-click-sdk-typescript).

The adapter does not dispatch NEP-141 or native NEAR, call
`/v0/deposit/submit`, wrap/unwrap, initiate swaps, or treat `/v0/status` as
settlement evidence. The separate contract execution path is disabled in the
default production build. Deterministic fixtures exercise signature
verification and local NEP-141 transfer behavior; no live provider quote or
deposit has been requested.

## Checkout preparation and evidence boundary

`npm run checkout:prepare` defaults to a signed dry quote preview. `--non-dry`
must be explicit to request a quote containing its deposit address, but still
does not submit an authorization transaction or transfer. Evidence captures
the raw provider response, exact selected signed fields, SDK version and quote
hash, provider signature digest, token metadata, and the unsigned response
fields separately. Token metadata is fetched by exact asset ID and checked
against the on-chain authorization's fixed decimal allowlist. `--output`
creates a new file exclusively and refuses to overwrite an existing one.

The on-chain quote record is `Prepared`, includes creation block/time and an
explicit `Disabled` deposit-dispatch status, and is not a payment or success
state. Ownership changes invalidate it; cancellation and the earliest request,
provider quote, or signed inactivity deadline expire it. Preparation alone does
not lock the NFT. The feature-gated local test path consumes the authorization
and locks the NFT before dispatch; ordinary production builds and initializers
cannot enable that path.

| Future evidence transition | Evidence / trust | Required behavior |
|---|---|---|
| Quote → `Prepared` | The adapter verifies with the official SDK; the default contract independently verifies the signature and checks current owner/account/nonce and the owner-bound field commitment. A direct caller cannot bypass signature verification. | No payment inference and no lock at preparation; transfer invalidates preparation. Default production dispatch is disabled. |
| Source transfer completion | Successful NEAR transfer callback to the prepared address in the local test mode. | Verifies only source-chain transfer execution, not provider detection or quote association; token remains locked. This path is not a production feature. |
| Provider detection / swap execution | 1Click status or API response. | Provider-reported only; never sufficient to mark payment complete. |
| Destination settlement | Independently verified finalized transaction/event with exact chain, token, recipient, and amount. | Can establish delivery; quote-to-transaction association still needs a trusted or cryptographically bound source. |
| Refund completion | Independently verified finalized origin-chain refund, or applicable Verifier event for the Verifier route. | Prove recipient and amount; do not unlock on provider status alone. |
| RELAY completion | Trusted on-chain proof verifier records settlement or refund. | Unlock only on verified terminal evidence. Timeout, partial/duplicate/late deposits, and ambiguous execution remain locked in recovery. |

For Arbitrum settlement, verify the finalized transaction and relevant ERC-20
transfer/event against the committed recipient, asset, and amount. NEAR Verifier
events can establish deposits/withdrawals that use the Verifier flow; they do
not automatically prove an `ORIGIN_CHAIN` deposit to a 1Click address. An
ordinary RPC status string or transaction hash supplied by the provider does
not itself authenticate quote-to-transaction association.

## Future 1Click payment-dispatch policy boundary

The current generic custody action lets the authorized NFT owner select an FT
contract and receiver. Before using quotes for 1Click payment dispatch, add an
owner-approved token contract registry and bind each quote/deposit reference
to one token, payment nonce, exact approved deposit receiver/method, amount,
and expiry. Set explicit minimum/maximum amounts after checking token decimals
and quote constraints, and cap method gas/message size. Receiver identity must
The general-purpose custody action remains distinct from this fixed-source,
quote-bound execution path. The path is not a production dispatch mode, and
the quote adapter's narrow asset-pair allowlist is not a custody registry.

## Stage L prepared-quote execution with a local NEP-141 fixture

Stage L connects V2 owner-bound quote preparation records to RELAY's payment
lifecycle and the subaccount's NEP-141 `ft_transfer` path. It tests a local
mock wrapped-NEAR token deployed by Stage H, not the production `wrap.near`
contract. It is not a working Universal Checkout and sends no funds to a real
1Click deposit address or provider.

### Executable flow

1. **Mint and Provision:** Mint a RELAY NFT and provision its associated NEAR
   subaccount (`<token_id>.<parent_contract>`).
2. **Account Verification:** Confirm the associated account binding is verified.
3. **Quote Preparation:** Prepare an owner-bound quote fixture for
   `nep141:wrap.near` and a local fixture receiver. This is deterministic local
   test data, not a quote or deposit issued by the live provider.
4. **On-Chain Authorization:** The token owner authorizes the quote on-chain
   via `relay_authorize_quote`, storing a `Prepared` record with `Disabled`
   dispatch status.
5. **Local-Test Execution Dispatch:** Only the feature-enabled artifact
   initialized through `new_sandbox_checkout_test` may execute
   `relay_execute_prepared_payment`. The ordinary initializer leaves dispatch
   disabled, and default builds omit the feature. The contract does not identify
   Sandbox; do not deploy the feature-enabled artifact. In local test mode:
   - Validates predecessor is current token owner and token lifecycle is `Unlocked`.
   - Validates quote authorization exists, belongs to this token/owner/associated account,
     is in `Prepared` status with `Disabled` dispatch status, and has matching nonce.
   - Validates unexpired quote deadlines, the origin-chain receiver as a NEAR
     account ID, positive amount, and the supported `nep141:wrap.near` source
     token; the optional signed `deposit_memo` is forwarded unchanged.
   - Atomically locks token lifecycle in `TokenLifecycle::LockedForSubaccount { nonce, initiator }`.
   - Transitions quote authorization status to `Consumed` and dispatch status to `Dispatched`.
   - Creates a `PaymentRecord` with `TokenTransferPending` and `CheckoutPending`.
   - Advances monotonic `token_nonce`.
   - Dispatches `execute_nep141_deposit` to call `ft_transfer` on the configured
     source FT contract using the authorized receiver, amount, and memo.
6. **Cross-Contract Callback Resolution:** The parent callback `on_prepared_payment_resolved`:
   - Checks matching generation nonce, commitment hash, payment pending state, and lifecycle lock.
   - On success (`PaymentExecutionResult::TransferSucceeded`): updates payment `token_transfer_status` to `TokenTransferCompleted`,
     retains the authorized amount in `PaymentRecord.amount`, leaves the
     NEP-141-only `resolved_amount_used` unset, sets `checkout_status` to
     `SourceTransferCompleted`, and updates authorization dispatch status to
     `SourceTransferCompleted`.
   - **Crucial invariant:** The token remains locked in `LockedForSubaccount` because
     source-chain transfer completion is NOT provider acceptance, final checkout settlement,
     or proof of destination delivery.
     `nft_transfer` and `relay_use_credit` remain strictly blocked.
7. **Negative and Fault-Injection Invariants:**
   - Duplicate execution / replay of consumed quote is rejected.
   - Re-authorization of used provider signature digest is globally rejected.
   - NFT ownership change invalidates prepared quotes; old owner execution is rejected;
     new owner cannot execute an invalidated old-owner preparation.
   - Cancelled and expired authorizations are rejected from payment execution.
   - Insufficient subaccount balance / storage-reserve violations fail subaccount execution;
     a definitive FT rejection records `TokenTransferFailed`, while checkout and quote
     authorization enter `RecoveryRequired`, preserving the token lifecycle lock.
   - Quotes specifying the parent contract or associated account as deposit recipient are rejected.

### What Stage L proves vs. what remains provider-dependent

| Domain | What the Sandbox test proves | What remains provider-dependent |
|---|---|---|
| Authorization binding | Only the current owner can dispatch execution for an active, unexpired, nonce-matching prepared quote bound to their canonical subaccount. | 1Click production API accepts the quote and registers the intent. |
| Transfer execution | The subaccount controller successfully executes `ft_transfer` against the local NEP-141 mock token to the prepared fixture receiver, with exact token balance accounting and the native storage reserve preserved. | The provider accepts, monitors, or detects a deposit sent to its returned address; Stage L does not test this. |
| Lifecycle lock | The NFT is locked upon local-test dispatch and remains locked in `SourceTransferCompleted` after transfer success; no premature unlock occurs. | Provider acceptance, destination-chain settlement, cross-chain delivery proof, or origin-chain refund. |
| Idempotency & Faults | Consumed authorizations cannot be re-executed; used provider signature digests cannot be reused; insufficient funds safely enter `RecoveryRequired` without losing lock. | Handling edge cases like reorgs, RPC outages, partial fills, or mismatched exchange rates. |

### Requirements before live 1Click dispatch

Before sending real funds or enabling production 1Click dispatch:
1. **Settlement Verifier:** An independent on-chain or multi-attested verifier proving destination-chain asset delivery to the committed recipient.
2. **Refund Verifier:** Verifiable proof of origin-chain refund to the canonical associated account when an intent expires or fails.
3. **Receipt Association:** Protocol verification associating the exact NEP-141 source transfer receipt with the 1Click quote/intent identifier.
4. **Live Provider Credentials:** Configured API keys and credentials for production/testnet 1Click API endpoints (currently gated and absent in this environment).

## Fixture limitations

`fungible-token/` uses `near-contract-standards` 5.30.0 and supports metadata,
storage registration, minting, transfer, transfer-call, balance queries, and
the standard transfer resolver. `payment-receiver/` records sender, amount,
message, accept/reject behavior; the token fixture records transfer and
resolver amounts. These are local protocol-mechanics fixtures only.

The token fixture also has an owner-gated resolver-failure switch to demonstrate
an ambiguous receipt outcome. This fault-injection branch is deliberately not
standard token behavior. Neither fixture implements or proves NEAR Intents,
1Click deposits, production verification, settlement, or refund semantics.
No testnet or mainnet deployment, API credential, or real asset transfer is
used.
