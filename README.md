# RELAY

**RELAY** is a stateful NFT on NEAR associated with a real NEAR account. Its native NEAR balance, attached NEP-171 NFT inventory, and remaining consumable credits stay associated with the same token item across ownership changes. When ownership transfers, the new owner gains authorized control, and the previous owner's RELAY-controlled authority is revoked.

## Prior Art & Acknowledgments
RELAY builds on concepts established in earlier systems and standards across Web3:
- **ERC-6551 (Token Bound Accounts)**: Pioneered non-fungible token-bound accounts on EVM.
- **Clubhouse & Vemo**: Early experiments and implementations of account-owning assets and delegate control.
- **NEAR TLA (Top-Level Accounts / Subaccounts & Access Key Management)**: Native NEAR account model allowing sub-accounts and granular access key addition/deletion, enabling token-bound accounts natively on NEAR.

## Product Journey
1. **Create RELAY NFT**: Mint a RELAY token linked to an associated real NEAR account.
2. **Fund Associated Account**: Deposit native NEAR to the associated account.
3. **Attach NEP-171 NFT**: Transfer an external NEP-171 NFT into the associated account's custody.
4. **Initialize Consumable Credits**: Configure on-chain consumable credits attached to the RELAY NFT.
5. **Authenticate & Claim**: Recipient authenticates via NEAR Auth / Google login and claims the RELAY NFT.
6. **Redeem Credit**: Redeem an on-chain credit via a real transaction.
7. **Transfer RELAY NFT**: Transfer the token to another owner.
8. **Verify Persistence**: Associated account balance, attached NFT inventory, and remaining credits persist with the token.
9. **Verify Authorization**: The new owner can act using the token; the previous owner's access is revoked.

## Implementation Status

| Feature | Status | Notes |
|---|---|---|
| Repository Scaffolding | **Verified** | Git, package config, Rust contract workspace setup |
| Core NEP-171 Smart Contract | **In Progress** | Implements NEP-171, NEP-177, NEP-178, NEP-181 via `near-contract-standards` 5.30.0 |
| Associated Account Linking | **Implemented in Contract** | `relay_associated_account` links token ID to subaccount |
| Consumable Credits Engine | **Implemented in Contract** | `relay_credits` and `relay_use_credit` track on-chain credit consumption |
| Sub-account Key Rotation | **Planned** | Dynamic key rotation on ownership transfer |
| Google / NEAR Auth Integration | **Planned** | Real FastAuth/NEAR Auth authentication session |
| NEP-171 Inventory Cross-calls | **Planned** | Holding and delegating child NFTs |
| Web Frontend | **Planned** | User interface for claiming, redeeming, and transferring |

## Building & Testing

### Prerequisites
- Node.js (v24+) & npm
- Rust (v1.95+ with `wasm32-unknown-unknown` target)
- `near-cli-rs` (`near` CLI)

### Contract Compilation
```bash
cd contract
cargo build --target wasm32-unknown-unknown --release
```

### Unit Tests
```bash
cd contract
cargo test
```
