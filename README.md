# RELAY

**RELAY** is a stateful NFT on NEAR intended to be bound to a real NEAR account. Its design target is that its native NEAR balance, attached NEP-171 NFT inventory, and remaining consumable credits stay associated with the same token item across ownership changes. When ownership transfers, the new owner gains authorized control, and the previous owner's RELAY-controlled authority is revoked.

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

## Implementation & Verification Status

| Component | Status | Verified Capabilities / Evidence |
|---|---|---|
| **Repository Scaffolding** | **Verified** | Git version control, npm scripts, Rust contract workspace targeting `wasm32-unknown-unknown`. |
| **NEP-171 Smart Contract Core** | **Verified** | Implements NEP-171 (Core), NEP-177 (Metadata), NEP-178 (Approval Management), NEP-181 (Enumeration) via `near-contract-standards` 5.30.0. Passing unit tests. |
| **Canonical Sub-account Binding** | **Verified in Contract** | Deterministic canonical derivation enforced: `<token_id>.<contract_id>`. Rejects non-canonical or arbitrary external accounts. |
| **Bidirectional Handshake Mechanism** | **Verified in Contract** | `AccountBinding` records `{ account_id, is_verified }`. Starts as `false` at mint; flips to `true` strictly when invoked by the sub-account itself via `relay_verify_associated_account`. Unauthorized callers rejected. |
| **Consumable Credits Engine** | **Verified in Contract** | On-chain credit tracking (`total`, `remaining`). Only current NFT owner can consume credits; decrements atomically; enforces positive balance. |
| **Live Sub-Account Creation & Handshake** | **Unverified / Planned** | Requires testnet execution where parent account executes `CreateAccount` protocol action. Dry-run planned in `scripts/bootstrap.js`. |
| **Real Asset Continuity (Balance & Child NFTs)** | **Unverified / Planned** | Contract associates sub-account ID; custody of native NEAR and child NEP-171 inventory inside the sub-account is architecturally designed but pending live chain validation. |
| **Dynamic Transfer Authorization / Revocation** | **Unverified / Planned** | NFT transfer changes token `owner_id`. Sub-account execution controller to reject previous owner is designed, pending sub-account smart contract deployment. |
| **Google / NEAR Auth (FastAuth)** | **Planned** | MPC-based Google login session and transaction signing flow not yet integrated. |
| **Web Frontend** | **Planned** | User interface for claiming, redeeming, and transferring. |

## Building & Testing

### Prerequisites
- Node.js (v24+) & npm
- Rust (v1.95+ with `wasm32-unknown-unknown` target)
- `near-cli-rs` (`near` CLI)

### Build Contract (WASM)
```bash
npm run build
# Compiles contract/src/lib.rs to contract/target/wasm32-unknown-unknown/release/relay_contract.wasm
```

### Run Unit Tests
```bash
npm test
# Executes 9 automated unit tests verifying NEP-171, canonical binding, verification handshake, credit engine, and transfer state.
```

### Dry-Run Deployment & Bootstrap Simulation
```bash
npm run plan:bootstrap
# Validates binary artifacts, configuration, and logs step-by-step deployment plan without submitting any network transactions.
```
