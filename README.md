# RELAY

**RELAY** is a stateful NFT on NEAR intended to be bound to a real NEAR sub-account. Its design target is that its native NEAR balance, attached NEP-171 NFT inventory, and remaining consumable credits stay associated with the same token item across ownership changes. When ownership transfers, the new owner gains authorized control, and the previous owner's RELAY-controlled authority is revoked.

> **Status Notice**: This repository is under active development for the NEAR Hackathon. Features marked as "Verified" are supported by passing automated tests and WASM builds. Features marked as "Planned" or "Unverified" describe the target product goal and are not yet established on a live network.

## Prior Art & Acknowledgments
RELAY builds on concepts established in earlier systems across Web3:
- **ERC-6551 (Token Bound Accounts)**: Pioneered non-fungible token-bound accounts on EVM using a permissionless registry and deterministic proxies.
- **Clubhouse & Vemo**: Early experiments and implementations of account-owning assets and delegate control.
- **NEAR TLA (Top-Level Accounts / Subaccounts & Access Key Management)**: Native NEAR hierarchical account model (`<subaccount>.<parent>`) where accounts natively hold assets and manage access keys.

## Target Product Journey
1. **Create RELAY NFT**: Mint a RELAY token bound to an associated real NEAR account.
2. **Fund Associated Account**: Deposit native NEAR to the associated account.
3. **Attach NEP-171 NFT**: Transfer an external NEP-171 NFT into the associated account's custody.
4. **Initialize Consumable Credits**: Configure on-chain consumable credits attached to the RELAY NFT.
5. **Authenticate & Claim**: Recipient authenticates via NEAR Auth / Google login and claims the RELAY NFT.
6. **Redeem Credit**: Redeem an on-chain credit via a real transaction.
7. **Transfer RELAY NFT**: Transfer the token to another owner.
8. **Verify Persistence**: Associated account balance, attached NFT inventory, and remaining credits persist with the token.
9. **Verify Authorization**: The new owner can act using the token; the previous owner's access is revoked.

## Architecture & Trust Boundaries

```
[User / Owner]
      │
      │ 1. relay_execute_subaccount(token_id, action) OR nft_transfer_call(...)
      ▼
┌──────────────────────────────────────────────────────────────────┐
│  RELAY Core Contract (relay.testnet)                             │
│  - Verifies caller == nft_token(token_id).owner_id               │
│  - Manages TokenLifecycle state machine & generation nonces:     │
│      * Unlocked                                                  │
│      * LockedForSubaccount { nonce }                             │
│      * LockedForTransferCall { nonce, prev_owner, receiver }     │
│  - Blocks concurrent nft_transfer, nft_transfer_call,            │
│    subaccount ops, and credit usage while locked                 │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           │ 2. execute(action) via cross-contract call
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Sub-Account Controller (1.relay.testnet)                        │
│  - Asserts predecessor == parent_contract_id                     │
│  - Rejects all direct user calls (fail closed)                   │
│  - Executes bounded action:                                      │
│      * TransferNear(recipient, amount)                           │
│      * TransferNep171(nft_contract, recipient, token)            │
│  - Holds NEP-171 custody via nft_on_transfer                     │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           │ 3. Callback (on_subaccount_executed / nft_resolve_transfer)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  RELAY Core Contract (relay.testnet)                             │
│  - Nonce validation ensures only matching callback unlocks       │
│  - Discards stale/outdated callbacks safely                      │
│  - Resolves transfer_call lock cleanly                           │
└──────────────────────────────────────────────────────────────────┘
```

## Implementation & Verification Status

| Component | Status | Verified Capabilities / Evidence |
|---|---|---|
| **Repository Scaffolding** | **Verified** | Cargo workspace linking `contract/` and `subaccount/`, npm scripts, WASM compilation. |
| **NEP-171 Smart Contract Core** | **Unit-Tested / Standards Wrapped** | Wraps `near-contract-standards` 5.30.0 Core, Metadata, Approval, and Enumeration with lifecycle checks. 26 passing unit tests in `relay-contract`. Full marketplace integration requires testnet validation. |
| **Sub-Account Controller Contract** | **Unit-Tested in Contract** | Companion contract `relay-subaccount` with strict parent-only dispatch, canonical initialization validation, typed bounded execution (`TransferNear`, `TransferNep171`), storage reserve preservation, and `nft_on_transfer` custody receiver. 8 passing unit tests. |
| **TOCTOU Transfer Coordination** | **Unit-Tested in Contract** | Generation-nonced `TokenLifecycle` locks token during sub-account execution and `nft_transfer_call`. Blocks `nft_transfer`, `nft_transfer_call`, approval changes, subaccount operations, and credit consumption while locked. Stale or unexpected callbacks safely ignored. |
| **Canonical Sub-account Binding** | **Unit-Tested in Contract** | Deterministic canonical derivation enforced: `<token_id>.<contract_id>`. Rejects non-canonical or arbitrary external accounts. |
| **Bidirectional Handshake Mechanism** | **Unit-Tested in Contract** | `AccountBinding` records `{ account_id, is_verified }`. Starts as `false` at mint; flips to `true` strictly when invoked by the sub-account itself via `relay_verify_associated_account`. Unauthorized callers rejected. |
| **Consumable Credits Engine** | **Unit-Tested in Contract** | On-chain credit tracking (`total`, `remaining`). Only current NFT owner can consume credits; decrements atomically; enforces positive balance; blocked when token is locked. |
| **Live Sub-Account Creation & Handshake** | **Unverified / Planned** | Requires live NEAR runtime where parent account executes protocol-level `CreateAccount` action. Dry-run planned in `scripts/bootstrap.js`. |
| **Real Asset Continuity on Testnet** | **Unverified / Planned** | Unit tests prove simulated state and promise dispatch; live testnet integration proof required to demonstrate balance and child NFT preservation across owner rotation. |
| **Google / NEAR Auth (FastAuth)** | **Planned** | MPC-based Google login session and transaction signing flow not yet integrated. |
| **Web Frontend** | **Planned** | User interface for claiming, redeeming, and transferring. |

## Building & Testing

### Prerequisites
- Node.js (v24+) & npm
- Rust (v1.95+ with `wasm32-unknown-unknown` target)
- `near-cli-rs` (`near` CLI)

### Build Contracts (WASM)
```bash
npm run build
# Compiles both relay_contract.wasm (355 KB) and relay_subaccount.wasm (131 KB)
```

### Run Unit Tests
```bash
npm test
# Executes 34 automated unit tests (26 for relay-contract, 8 for relay-subaccount)
```

### Dry-Run Deployment & Bootstrap Simulation
```bash
npm run plan:bootstrap
# Validates both binary artifacts, configuration, and logs step-by-step deployment plan without submitting any network transactions.
```
