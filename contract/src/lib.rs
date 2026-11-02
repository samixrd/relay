/*!
RELAY — Stateful NFT Contract for NEAR

Each RELAY NFT is associated with a real NEAR account. The associated account's
native balance, attached NEP-171 NFT inventory, and consumable credits persist
across ownership transfers.

## Standards implemented
- NEP-171 (Core Non-Fungible Token)
- NEP-177 (NFT Metadata)
- NEP-178 (NFT Approval Management)
- NEP-181 (NFT Enumeration)

## RELAY extensions
- Each token stores an `associated_account_id` (the real NEAR sub-account).
- Each token stores consumable `credits` (initialized on mint, decremented on use).
- On transfer, the associated account and credits travel with the token.

## Security notes
- Only the contract owner can mint.
- Only the current NFT owner can consume credits.
- Access-key rotation on the associated sub-account is NOT yet implemented
  (planned for a future task).
*/

use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::core::{
    NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NFT_METADATA_SPEC, NonFungibleTokenMetadataProvider, TokenMetadata,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::collections::{LazyOption, LookupMap};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Storage key prefixes
// ---------------------------------------------------------------------------

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    NonFungibleToken,
    Metadata,
    TokenMetadata,
    Enumeration,
    Approval,
    AssociatedAccounts,
    Credits,
    TokenLifecycles,
    TokenNonces,
}

// ---------------------------------------------------------------------------
// RELAY-specific per-token data
// ---------------------------------------------------------------------------

/// On-chain credit state for a single RELAY token.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CreditState {
    /// Total credits initially granted.
    pub total: u32,
    /// Credits remaining (decremented on each use).
    pub remaining: u32,
}

/// Token-bound account binding state for a RELAY token.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AccountBinding {
    /// The associated canonical NEAR sub-account ID (<token_id>.<contract_account_id>).
    pub account_id: AccountId,
    /// Whether the associated account has been verified on-chain.
    /// Initialized to false at mint. Becomes true only when the associated sub-account
    /// confirms its identity via a verified cross-contract handshake (`relay_verify_associated_account`).
    pub is_verified: bool,
}

/// Lifecycle state of a RELAY token across asynchronous operations and transfers.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum TokenLifecycle {
    /// Token is unlocked and available for transfers, operations, and credit consumption.
    Unlocked,
    /// Token has an active in-flight sub-account operation with the given generation nonce and initiator.
    LockedForSubaccount {
        nonce: u64,
        initiator: AccountId,
    },
    /// Token is awaiting asynchronous receiver resolution in an NEP-171 `nft_transfer_call`.
    LockedForTransferCall {
        nonce: u64,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
    },
}

/// Typed, bounded operations that an authorized RELAY owner can execute via the associated sub-account.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum SubaccountAction {
    /// Transfers native NEAR balance out of the sub-account.
    TransferNear {
        receiver_id: AccountId,
        amount: NearToken,
    },
    /// Calls nft_transfer on a child NEP-171 NFT held in the sub-account's custody.
    TransferNep171 {
        nft_contract_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
    },
}

#[near_sdk::ext_contract(ext_subaccount)]
pub trait ExtSubaccount {
    fn execute(&mut self, action: SubaccountAction) -> PromiseOrValue<bool>;
}

// ---------------------------------------------------------------------------
// Contract state
// ---------------------------------------------------------------------------

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    /// Standard NEP-171 token data.
    tokens: NonFungibleToken,
    /// Contract-level NFT metadata (NEP-177).
    metadata: LazyOption<NFTContractMetadata>,
    /// Mapping: token_id → associated NEAR account binding.
    associated_accounts: LookupMap<TokenId, AccountBinding>,
    /// Mapping: token_id → credit state.
    credits: LookupMap<TokenId, CreditState>,
    /// Mapping: token_id → lifecycle lock state (prevents TOCTOU transfer during in-flight operations).
    token_lifecycles: LookupMap<TokenId, TokenLifecycle>,
    /// Mapping: token_id → monotonic generation nonce for operation isolation.
    token_nonces: LookupMap<TokenId, u64>,
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

#[near]
impl Contract {
    /// Initialize the RELAY contract with full metadata.
    #[init]
    pub fn new(owner_id: AccountId, metadata: NFTContractMetadata) -> Self {
        require!(!env::state_exists(), "Already initialized");
        metadata.assert_valid();
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::NonFungibleToken,
                owner_id,
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                Some(StorageKey::Approval),
            ),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            associated_accounts: LookupMap::new(StorageKey::AssociatedAccounts),
            credits: LookupMap::new(StorageKey::Credits),
            token_lifecycles: LookupMap::new(StorageKey::TokenLifecycles),
            token_nonces: LookupMap::new(StorageKey::TokenNonces),
        }
    }

    /// Initialize with default RELAY metadata (convenience for testing).
    #[init]
    pub fn new_default_meta(owner_id: AccountId) -> Self {
        Self::new(
            owner_id,
            NFTContractMetadata {
                spec: NFT_METADATA_SPEC.to_string(),
                name: "RELAY".to_string(),
                symbol: "RELAY".to_string(),
                icon: None,
                base_uri: None,
                reference: None,
                reference_hash: None,
            },
        )
    }

    // -----------------------------------------------------------------------
    // RELAY-specific methods
    // -----------------------------------------------------------------------

    /// Derives the canonical sub-account ID for a given token ID.
    /// The sub-account is strictly of the form: `<token_id>.<contract_account_id>`
    pub fn relay_canonical_account_id(&self, token_id: &TokenId) -> AccountId {
        require!(
            !token_id.is_empty() && token_id.len() <= 32,
            "Token ID length must be between 1 and 32 characters to form a valid sub-account"
        );
        let subaccount_candidate = format!("{}.{}", token_id, env::current_account_id());
        subaccount_candidate.parse().unwrap_or_else(|_| {
            env::panic_str("Token ID cannot form a valid NEAR account ID (must contain only lowercase alphanumeric, '-' or '_')")
        })
    }

    /// Mint a new RELAY NFT.
    ///
    /// - `token_id`: unique string identifier.
    /// - `token_owner_id`: initial owner.
    /// - `token_metadata`: NEP-177 metadata for the token.
    /// - `associated_account_id`: must match `relay_canonical_account_id(token_id)`.
    /// - `initial_credits`: number of consumable credits to grant.
    ///
    /// Only the contract owner (set during `new`) may call this.
    #[payable]
    pub fn relay_mint(
        &mut self,
        token_id: TokenId,
        token_owner_id: AccountId,
        token_metadata: TokenMetadata,
        associated_account_id: AccountId,
        initial_credits: u32,
    ) -> Token {
        assert_eq!(
            env::predecessor_account_id(),
            self.tokens.owner_id,
            "Only the contract owner can mint"
        );

        // Enforce canonical sub-account namespace binding
        let canonical_account = self.relay_canonical_account_id(&token_id);
        require!(
            associated_account_id == canonical_account,
            "associated_account_id must match canonical sub-account format: <token_id>.<contract_id>"
        );

        // Store RELAY-specific data (initialized as unverified pending on-chain handshake)
        self.associated_accounts.insert(
            &token_id,
            &AccountBinding {
                account_id: associated_account_id,
                is_verified: false,
            },
        );
        self.credits.insert(
            &token_id,
            &CreditState {
                total: initial_credits,
                remaining: initial_credits,
            },
        );

        // Mint via standard NEP-171
        self.tokens
            .internal_mint(token_id, token_owner_id, Some(token_metadata))
    }

    /// View the associated NEAR account for a RELAY token.
    pub fn relay_associated_account(&self, token_id: TokenId) -> Option<AccountId> {
        self.associated_accounts.get(&token_id).map(|b| b.account_id)
    }

    /// View the full account binding state for a RELAY token.
    pub fn relay_account_binding(&self, token_id: TokenId) -> Option<AccountBinding> {
        self.associated_accounts.get(&token_id)
    }

    /// Called by the associated sub-account itself to establish bidirectional proof
    /// that the sub-account is alive, deployed, and acknowledges this RELAY NFT.
    pub fn relay_verify_associated_account(&mut self, token_id: TokenId) {
        let binding = self
            .associated_accounts
            .get(&token_id)
            .expect("Token not found");
        require!(
            env::predecessor_account_id() == binding.account_id,
            "Only the associated sub-account itself can verify this binding"
        );
        self.associated_accounts.insert(
            &token_id,
            &AccountBinding {
                account_id: binding.account_id,
                is_verified: true,
            },
        );
    }

    /// View the credit state for a RELAY token.
    pub fn relay_credits(&self, token_id: TokenId) -> Option<CreditState> {
        self.credits.get(&token_id)
    }

    /// Consume one credit from a RELAY token.
    ///
    /// Only the current owner of the token may call this.
    /// Panics if no credits remain.
    pub fn relay_use_credit(&mut self, token_id: TokenId) {
        require!(
            self.token_lifecycle(&token_id) == TokenLifecycle::Unlocked,
            "Cannot use credits while token is locked pending an operation or transfer"
        );
        let token = self
            .tokens
            .nft_token(token_id.clone())
            .expect("Token not found");
        assert_eq!(
            env::predecessor_account_id(),
            token.owner_id,
            "Only the token owner can use credits"
        );

        // Decrement credits
        let mut state = self.credits.get(&token_id).expect("Credit state not found");
        require!(state.remaining > 0, "No credits remaining");
        state.remaining -= 1;
        self.credits.insert(&token_id, &state);
    }

    /// Returns the lifecycle lock state for a given token.
    pub fn token_lifecycle(&self, token_id: &TokenId) -> TokenLifecycle {
        self.token_lifecycles
            .get(token_id)
            .unwrap_or(TokenLifecycle::Unlocked)
    }

    /// Returns true if the token is currently locked due to an active in-flight operation or transfer.
    pub fn is_token_locked(&self, token_id: &TokenId) -> bool {
        self.token_lifecycle(token_id) != TokenLifecycle::Unlocked
    }

    /// Returns the current operation generation nonce for a given token.
    pub fn token_nonce(&self, token_id: &TokenId) -> u64 {
        self.token_nonces.get(token_id).unwrap_or(0)
    }

    /// Dispatches a typed operation to the token's associated sub-account.
    /// Atomically locks the token on the parent contract, preventing any concurrent
    /// or stale `nft_transfer` until the sub-account operation completes.
    pub fn relay_execute_subaccount(
        &mut self,
        token_id: TokenId,
        action: SubaccountAction,
    ) -> Promise {
        let token = self.tokens.nft_token(token_id.clone()).expect("Token not found");
        require!(
            env::predecessor_account_id() == token.owner_id,
            "Only current token owner can execute operations on associated sub-account"
        );
        require!(
            self.token_lifecycle(&token_id) == TokenLifecycle::Unlocked,
            "Token is currently locked pending another operation or transfer"
        );
        let binding = self
            .associated_accounts
            .get(&token_id)
            .expect("Associated account not found");
        require!(
            binding.is_verified,
            "Associated sub-account has not completed on-chain verification handshake"
        );

        // Advance monotonic generation nonce and lock token
        let next_nonce = self.token_nonce(&token_id) + 1;
        self.token_nonces.insert(&token_id, &next_nonce);
        self.token_lifecycles.insert(
            &token_id,
            &TokenLifecycle::LockedForSubaccount {
                nonce: next_nonce,
                initiator: token.owner_id.clone(),
            },
        );

        ext_subaccount::ext(binding.account_id)
            .with_static_gas(Gas::from_tgas(30))
            .execute(action)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .on_subaccount_executed(token_id, next_nonce, token.owner_id),
            )
    }

    /// Callback invoked when the sub-account operation completes.
    /// Releases the lock ONLY if the current lock generation nonce and initiator match expected values.
    /// Stale or duplicate callbacks are safely ignored without altering newer state.
    #[private]
    pub fn on_subaccount_executed(
        &mut self,
        token_id: TokenId,
        expected_nonce: u64,
        expected_initiator: AccountId,
        #[callback_result] result: Result<bool, near_sdk::PromiseError>,
    ) -> bool {
        if let TokenLifecycle::LockedForSubaccount { nonce, ref initiator } = self.token_lifecycle(&token_id) {
            if nonce == expected_nonce && initiator == &expected_initiator {
                self.token_lifecycles
                    .insert(&token_id, &TokenLifecycle::Unlocked);
            }
        }
        result.unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// NEP-171 Core
// ---------------------------------------------------------------------------

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        require!(
            self.token_lifecycle(&token_id) == TokenLifecycle::Unlocked,
            "Cannot transfer token while an operation or transfer is pending"
        );
        self.tokens
            .nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        require!(
            self.token_lifecycle(&token_id) == TokenLifecycle::Unlocked,
            "Cannot transfer token while an operation or transfer is pending"
        );

        let token = self.tokens.nft_token(token_id.clone()).expect("Token not found");
        let previous_owner_id = token.owner_id;

        // Advance nonce and lock token in LockedForTransferCall state
        let next_nonce = self.token_nonce(&token_id) + 1;
        self.token_nonces.insert(&token_id, &next_nonce);
        self.token_lifecycles.insert(
            &token_id,
            &TokenLifecycle::LockedForTransferCall {
                nonce: next_nonce,
                previous_owner_id,
                receiver_id: receiver_id.clone(),
            },
        );

        self.tokens
            .nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

// ---------------------------------------------------------------------------
// NEP-171 Resolver (for transfer_call callbacks)
// ---------------------------------------------------------------------------

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let transferred_to_receiver = self.tokens.nft_resolve_transfer(
            previous_owner_id.clone(),
            receiver_id.clone(),
            token_id.clone(),
            approved_account_ids,
        );

        // Safely release the LockedForTransferCall lock upon resolution
        if let TokenLifecycle::LockedForTransferCall {
            nonce: _,
            previous_owner_id: ref expected_prev,
            receiver_id: ref expected_recv,
        } = self.token_lifecycle(&token_id)
        {
            if expected_prev == &previous_owner_id && expected_recv == &receiver_id {
                self.token_lifecycles
                    .insert(&token_id, &TokenLifecycle::Unlocked);
            }
        }

        transferred_to_receiver
    }
}

// ---------------------------------------------------------------------------
// NEP-178 Approval Management
// ---------------------------------------------------------------------------

#[near]
impl NonFungibleTokenApproval for Contract {
    #[payable]
    fn nft_approve(
        &mut self,
        token_id: TokenId,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        require!(
            self.token_lifecycle(&token_id) == TokenLifecycle::Unlocked,
            "Cannot modify approvals while an operation or transfer is pending"
        );
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        require!(
            self.token_lifecycle(&token_id) == TokenLifecycle::Unlocked,
            "Cannot modify approvals while an operation or transfer is pending"
        );
        self.tokens.nft_revoke(token_id, account_id);
    }

    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        require!(
            self.token_lifecycle(&token_id) == TokenLifecycle::Unlocked,
            "Cannot modify approvals while an operation or transfer is pending"
        );
        self.tokens.nft_revoke_all(token_id);
    }

    fn nft_is_approved(
        &self,
        token_id: TokenId,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        self.tokens
            .nft_is_approved(token_id, approved_account_id, approval_id)
    }
}

// ---------------------------------------------------------------------------
// NEP-181 Enumeration
// ---------------------------------------------------------------------------

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
    }
}

// ---------------------------------------------------------------------------
// NEP-177 Metadata Provider
// ---------------------------------------------------------------------------

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap()
    }
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    #[allow(deprecated)]
    use near_sdk::test_utils::testing_env_with_promise_results;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken, PromiseResult};

    const MINT_STORAGE_COST: NearToken = NearToken::from_yoctonear(7000000000000000000000u128);

    fn get_context(predecessor_account_id: AccountId) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(accounts(0))
            .signer_account_id(predecessor_account_id.clone())
            .predecessor_account_id(predecessor_account_id);
        builder
    }

    fn sample_token_metadata() -> TokenMetadata {
        TokenMetadata {
            title: Some("RELAY #1".into()),
            description: Some("A stateful NFT with an associated NEAR account".into()),
            media: None,
            media_hash: None,
            copies: Some(1u64),
            issued_at: None,
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: None,
            reference: None,
            reference_hash: None,
        }
    }

    #[test]
    fn test_relay_mint_and_query() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical_account = contract.relay_canonical_account_id(&token_id);
        let token = contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical_account.clone(),
            3,
        );

        assert_eq!(token.token_id, "relay-1");
        assert_eq!(token.owner_id, accounts(0));

        // Verify RELAY extensions
        assert_eq!(
            contract.relay_associated_account(token_id.clone()),
            Some(canonical_account.clone())
        );

        // Binding must initially be unverified (declared, but not yet verified on-chain)
        let binding = contract.relay_account_binding(token_id.clone()).unwrap();
        assert_eq!(binding.account_id, canonical_account);
        assert!(!binding.is_verified);

        let credits = contract.relay_credits(token_id).unwrap();
        assert_eq!(credits.total, 3);
        assert_eq!(credits.remaining, 3);
    }

    #[test]
    #[should_panic(expected = "associated_account_id must match canonical sub-account format")]
    fn test_mint_rejects_non_canonical_subaccount() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        // Attempt to pass an arbitrary external account instead of canonical sub-account
        let fake_associated: AccountId = "binance.near".parse().unwrap();
        contract.relay_mint(
            "relay-1".to_string(),
            accounts(0),
            sample_token_metadata(),
            fake_associated,
            3,
        );
    }

    #[test]
    fn test_verify_associated_account_handshake() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical_account = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical_account.clone(),
            3,
        );

        assert!(!contract.relay_account_binding(token_id.clone()).unwrap().is_verified);

        // Associated sub-account executes the verification handshake call
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical_account)
            .build());

        contract.relay_verify_associated_account(token_id.clone());

        // Now verified on-chain!
        let binding = contract.relay_account_binding(token_id).unwrap();
        assert!(binding.is_verified);
    }

    #[test]
    #[should_panic(expected = "Only the associated sub-account itself can verify this binding")]
    fn test_verify_associated_account_unauthorized() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical_account = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical_account,
            3,
        );

        // Contract owner or another user (accounts(0)) tries to fake verification handshake
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        contract.relay_verify_associated_account(token_id);
    }

    #[test]
    #[should_panic(expected = "Token ID cannot form a valid NEAR account ID")]
    fn test_invalid_token_id_characters() {
        let context = get_context(accounts(0));
        testing_env!(context.build());
        let contract = Contract::new_default_meta(accounts(0));

        // Upper case and spaces are illegal in NEAR account IDs
        contract.relay_canonical_account_id(&"RELAY #1".to_string());
    }

    #[test]
    fn test_relay_use_credit() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Use one credit
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        contract.relay_use_credit(token_id.clone());

        let credits = contract.relay_credits(token_id).unwrap();
        assert_eq!(credits.remaining, 2);
    }

    #[test]
    #[should_panic(expected = "Only the token owner can use credits")]
    fn test_relay_use_credit_unauthorized() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Non-owner tries to use credit → should panic
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(1))
            .build());

        contract.relay_use_credit(token_id);
    }

    #[test]
    fn test_transfer_preserves_relay_state() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        // Mint
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        // Use one credit as owner
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());
        contract.relay_use_credit(token_id.clone());

        // Transfer to accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());
        contract.nft_transfer(accounts(1), token_id.clone(), None, None);

        // Verify token now owned by accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .is_view(true)
            .attached_deposit(NearToken::from_near(0))
            .build());

        let token = contract.nft_token(token_id.clone()).unwrap();
        assert_eq!(token.owner_id, accounts(1));

        // Associated account and credits preserved
        assert_eq!(
            contract.relay_associated_account(token_id.clone()),
            Some(canonical)
        );
        let credits = contract.relay_credits(token_id).unwrap();
        assert_eq!(credits.total, 3);
        assert_eq!(credits.remaining, 2); // 1 was used before transfer
    }

    #[test]
    #[should_panic(expected = "No credits remaining")]
    fn test_relay_no_credits_remaining() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            1, // Only 1 credit
        );

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        // Use the only credit
        contract.relay_use_credit(token_id.clone());

        // Try to use again → should panic
        contract.relay_use_credit(token_id);
    }

    #[test]
    #[should_panic(expected = "Only current token owner can execute operations")]
    fn test_relay_execute_subaccount_unauthorized() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Non-owner (accounts(1)) tries to dispatch sub-account execution
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(1))
            .build());

        let _ = contract.relay_execute_subaccount(
            token_id,
            SubaccountAction::TransferNear {
                receiver_id: accounts(2),
                amount: NearToken::from_near(1),
            },
        );
    }

    #[test]
    #[should_panic(expected = "Associated sub-account has not completed on-chain verification handshake")]
    fn test_relay_execute_subaccount_unverified() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Owner (accounts(0)) tries to dispatch before subaccount verification handshake
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.relay_execute_subaccount(
            token_id,
            SubaccountAction::TransferNear {
                receiver_id: accounts(2),
                amount: NearToken::from_near(1),
            },
        );
    }

    #[test]
    #[should_panic(expected = "Cannot transfer token while an operation or transfer is pending")]
    fn test_direct_transfer_blocked_while_subaccount_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        // Verification handshake
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

        // Sub-account operation initiated via real contract method
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.relay_execute_subaccount(
            token_id.clone(),
            SubaccountAction::TransferNear {
                receiver_id: accounts(2),
                amount: NearToken::from_near(1),
            },
        );
        assert!(contract.is_token_locked(&token_id));

        // Direct transfer must be blocked to prevent TOCTOU race
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());

        contract.nft_transfer(accounts(1), token_id, None, None);
    }

    #[test]
    #[should_panic(expected = "Cannot transfer token while an operation or transfer is pending")]
    fn test_transfer_call_blocked_while_subaccount_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        // Verification handshake
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

        // Sub-account operation initiated via real contract method
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.relay_execute_subaccount(
            token_id.clone(),
            SubaccountAction::TransferNear {
                receiver_id: accounts(2),
                amount: NearToken::from_near(1),
            },
        );

        // nft_transfer_call must be blocked
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.nft_transfer_call(accounts(1), token_id, None, None, "msg".to_string());
    }

    #[test]
    #[should_panic(expected = "Token is currently locked pending another operation or transfer")]
    fn test_transfer_call_locks_and_blocks_receiver_subaccount_op() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        // Verification handshake
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

        // Owner initiates real nft_transfer_call with 1 yocto deposit
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.nft_transfer_call(accounts(1), token_id.clone(), None, None, "msg".to_string());

        // In standard NEP-171, tokens.owner_by_id is now accounts(1) (optimistic receiver)
        assert_eq!(contract.nft_token(token_id.clone()).unwrap().owner_id, accounts(1));
        assert!(contract.is_token_locked(&token_id));

        // Optimistic receiver attempts to execute subaccount action while transfer_call is in-flight
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(1))
            .build());

        let _ = contract.relay_execute_subaccount(
            token_id,
            SubaccountAction::TransferNear {
                receiver_id: accounts(2),
                amount: NearToken::from_near(1),
            },
        );
    }

    #[test]
    #[should_panic(expected = "Cannot use credits while token is locked pending an operation or transfer")]
    fn test_transfer_call_locks_and_blocks_receiver_credit_use() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Owner initiates real nft_transfer_call
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.nft_transfer_call(accounts(1), token_id.clone(), None, None, "msg".to_string());

        // Optimistic receiver attempts to consume credits while transfer_call is unresolved
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(1))
            .build());

        contract.relay_use_credit(token_id);
    }

    #[test]
    #[should_panic(expected = "Cannot transfer token while an operation or transfer is pending")]
    fn test_transfer_call_locks_and_blocks_further_transfers() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Owner initiates real nft_transfer_call
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.nft_transfer_call(accounts(1), token_id.clone(), None, None, "msg".to_string());

        // Receiver attempts to transfer the token away before resolution
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(1))
            .build());

        contract.nft_transfer(accounts(2), token_id, None, None);
    }

    #[test]
    #[should_panic(expected = "Cannot modify approvals while an operation or transfer is pending")]
    fn test_modify_approvals_blocked_while_transfer_call_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Owner initiates real nft_transfer_call
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.nft_transfer_call(accounts(1), token_id.clone(), None, None, "msg".to_string());

        // Receiver attempts to approve another account while transfer_call is pending
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(1))
            .build());

        let _ = contract.nft_approve(token_id, accounts(2), None);
    }

    #[test]
    fn test_resolve_transfer_acceptance_authorizes_new_owner() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        // Verification handshake
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

        // Initiate real nft_transfer_call
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.nft_transfer_call(accounts(1), token_id.clone(), None, None, "msg".to_string());

        // Receiver accepted (returns false in nft_on_transfer -> do not rollback)
        #[allow(deprecated)]
        testing_env_with_promise_results(
            context
                .storage_usage(env::storage_usage())
                .predecessor_account_id(accounts(0))
                .build(),
            PromiseResult::Successful(b"false".to_vec()),
        );

        let transferred = contract.nft_resolve_transfer(accounts(0), accounts(1), token_id.clone(), None);
        assert!(transferred);
        assert!(!contract.is_token_locked(&token_id));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
        assert_eq!(contract.nft_token(token_id.clone()).unwrap().owner_id, accounts(1));

        // New owner (accounts(1)) is authorized to use credits
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(1))
            .build());

        contract.relay_use_credit(token_id.clone());
        assert_eq!(contract.relay_credits(token_id.clone()).unwrap().remaining, 2);

        // New owner is authorized to dispatch sub-account operations
        let _ = contract.relay_execute_subaccount(
            token_id,
            SubaccountAction::TransferNear {
                receiver_id: accounts(2),
                amount: NearToken::from_near(1),
            },
        );
    }

    #[test]
    fn test_resolve_transfer_rejection_restores_original_owner() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Initiate real nft_transfer_call
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.nft_transfer_call(accounts(1), token_id.clone(), None, None, "msg".to_string());

        // Receiver rejected (returns true in nft_on_transfer -> rollback to sender)
        #[allow(deprecated)]
        testing_env_with_promise_results(
            context
                .storage_usage(env::storage_usage())
                .predecessor_account_id(accounts(0))
                .build(),
            PromiseResult::Successful(b"true".to_vec()),
        );

        let transferred = contract.nft_resolve_transfer(accounts(0), accounts(1), token_id.clone(), None);
        assert!(!transferred);
        assert!(!contract.is_token_locked(&token_id));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
        assert_eq!(contract.nft_token(token_id.clone()).unwrap().owner_id, accounts(0));

        // Original owner remains authorized to use credits
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        contract.relay_use_credit(token_id);
        assert_eq!(contract.relay_credits("relay-1".to_string()).unwrap().remaining, 2);
    }

    #[test]
    fn test_resolve_transfer_failed_promise_restores_original_owner() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Initiate real nft_transfer_call
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.nft_transfer_call(accounts(1), token_id.clone(), None, None, "msg".to_string());

        // Receiver call panicked or failed on NEAR runtime
        #[allow(deprecated)]
        testing_env_with_promise_results(
            context
                .storage_usage(env::storage_usage())
                .predecessor_account_id(accounts(0))
                .build(),
            PromiseResult::Failed,
        );

        let transferred = contract.nft_resolve_transfer(accounts(0), accounts(1), token_id.clone(), None);
        assert!(!transferred);
        assert!(!contract.is_token_locked(&token_id));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
        assert_eq!(contract.nft_token(token_id.clone()).unwrap().owner_id, accounts(0));
    }

    #[test]
    fn test_failed_subaccount_call_recovers_unlocked_state() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        // Verification handshake
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

        // Dispatch real sub-account operation
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.relay_execute_subaccount(
            token_id.clone(),
            SubaccountAction::TransferNear {
                receiver_id: accounts(2),
                amount: NearToken::from_near(1),
            },
        );
        assert!(contract.is_token_locked(&token_id));

        // Subaccount cross-contract call fails with PromiseError::Failed
        testing_env!(context
            .storage_usage(env::storage_usage())
            .predecessor_account_id(accounts(0))
            .build());

        let res = contract.on_subaccount_executed(
            token_id.clone(),
            1,
            accounts(0),
            Result::Err(near_sdk::PromiseError::Failed),
        );
        assert!(!res);

        // CRITICAL: Token must safely recover to Unlocked state even after failure!
        assert!(!contract.is_token_locked(&token_id));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);

        // Owner can immediately continue using the token
        contract.relay_use_credit(token_id);
        assert_eq!(contract.relay_credits("relay-1".to_string()).unwrap().remaining, 2);
    }

    #[test]
    fn test_stale_callback_does_not_release_newer_lock() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        // Verification handshake
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

        // Operation 1 (nonce 1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.relay_execute_subaccount(
            token_id.clone(),
            SubaccountAction::TransferNear {
                receiver_id: accounts(2),
                amount: NearToken::from_near(1),
            },
        );

        // Operation 1 callback completes
        testing_env!(context
            .storage_usage(env::storage_usage())
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.on_subaccount_executed(token_id.clone(), 1, accounts(0), Result::Ok(true));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);

        // Operation 2 (nonce 2)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.relay_execute_subaccount(
            token_id.clone(),
            SubaccountAction::TransferNear {
                receiver_id: accounts(2),
                amount: NearToken::from_near(1),
            },
        );
        assert_eq!(
            contract.token_lifecycle(&token_id),
            TokenLifecycle::LockedForSubaccount {
                nonce: 2,
                initiator: accounts(0),
            }
        );

        // Stale callback for nonce 1 arrives -> must NOT unlock nonce 2!
        testing_env!(context
            .storage_usage(env::storage_usage())
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.on_subaccount_executed(token_id.clone(), 1, accounts(0), Result::Ok(true));
        assert!(contract.is_token_locked(&token_id));

        // Mismatched initiator callback arrives -> must NOT unlock!
        let _ = contract.on_subaccount_executed(token_id.clone(), 2, accounts(1), Result::Ok(true));
        assert!(contract.is_token_locked(&token_id));

        // Matching nonce 2 and accounts(0) arrives -> unlocks!
        let unlocked = contract.on_subaccount_executed(token_id.clone(), 2, accounts(0), Result::Ok(true));
        assert!(unlocked);
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
    }

    #[test]
    fn test_unexpected_resolver_or_callback_does_not_corrupt_state() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        // Verification handshake
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

        // Spurious callback on Unlocked token does not corrupt state
        testing_env!(context
            .storage_usage(env::storage_usage())
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.on_subaccount_executed(token_id.clone(), 99, accounts(0), Result::Ok(true));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);

        // Start sub-account operation (locks in LockedForSubaccount)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_execute_subaccount(
            token_id.clone(),
            SubaccountAction::TransferNear {
                receiver_id: accounts(2),
                amount: NearToken::from_near(1),
            },
        );

        // Spurious nft_resolve_transfer call arrives while LockedForSubaccount -> must NOT release the subaccount lock!
        #[allow(deprecated)]
        testing_env_with_promise_results(
            context
                .storage_usage(env::storage_usage())
                .predecessor_account_id(accounts(0))
                .build(),
            PromiseResult::Successful(b"false".to_vec()),
        );
        let _ = contract.nft_resolve_transfer(accounts(0), accounts(1), token_id.clone(), None);
        assert_eq!(
            contract.token_lifecycle(&token_id),
            TokenLifecycle::LockedForSubaccount {
                nonce: 1,
                initiator: accounts(0),
            }
        );
    }

    #[test]
    #[should_panic(expected = "Only current token owner can execute operations")]
    fn test_previous_owner_cannot_execute_after_transfer() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        // Verification handshake
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

        // Transfer token from accounts(0) to accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());
        contract.nft_transfer(accounts(1), token_id.clone(), None, None);

        // Previous owner accounts(0) attempts to execute on the sub-account
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.relay_execute_subaccount(
            token_id,
            SubaccountAction::TransferNear {
                receiver_id: accounts(0),
                amount: NearToken::from_near(1),
            },
        );
    }

    #[test]
    fn test_approval_restored_on_transfer_call_rejection_and_cleared_on_acceptance() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Approve accounts(2) with 0.01 NEAR attached deposit for storage
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_millinear(10))
            .predecessor_account_id(accounts(0))
            .build());

        contract.nft_approve(token_id.clone(), accounts(2), None);
        assert!(contract.nft_is_approved(token_id.clone(), accounts(2), None));

        // Owner initiates nft_transfer_call to accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.nft_transfer_call(accounts(1), token_id.clone(), None, None, "msg".to_string());

        // Scenario A: Receiver rejects (returns true -> rollback)
        #[allow(deprecated)]
        testing_env_with_promise_results(
            context
                .storage_usage(env::storage_usage())
                .predecessor_account_id(accounts(0))
                .build(),
            PromiseResult::Successful(b"true".to_vec()),
        );

        let mut prior_approvals = HashMap::new();
        prior_approvals.insert(accounts(2), 1u64);

        let transferred = contract.nft_resolve_transfer(
            accounts(0),
            accounts(1),
            token_id.clone(),
            Some(prior_approvals.clone()),
        );
        assert!(!transferred);
        assert_eq!(contract.nft_token(token_id.clone()).unwrap().owner_id, accounts(0));

        // Approvals ARE restored by standard resolver on revert!
        assert!(contract.nft_is_approved(token_id.clone(), accounts(2), None));

        // Scenario B: Owner initiates nft_transfer_call to accounts(1) again, receiver accepts (returns false)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.nft_transfer_call(accounts(1), token_id.clone(), None, None, "msg".to_string());

        #[allow(deprecated)]
        testing_env_with_promise_results(
            context
                .storage_usage(env::storage_usage())
                .predecessor_account_id(accounts(0))
                .build(),
            PromiseResult::Successful(b"false".to_vec()),
        );

        let transferred = contract.nft_resolve_transfer(
            accounts(0),
            accounts(1),
            token_id.clone(),
            Some(prior_approvals),
        );
        assert!(transferred);
        assert_eq!(contract.nft_token(token_id.clone()).unwrap().owner_id, accounts(1));

        // On successful transfer, previous approvals ARE cleared!
        assert!(!contract.nft_is_approved(token_id, accounts(2), None));
    }

    #[test]
    fn test_duplicate_callback_cannot_mutate_or_double_unlock() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());

        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        // Handshake
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

        // Dispatch subaccount action (nonce 1, initiator accounts(0))
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.relay_execute_subaccount(
            token_id.clone(),
            SubaccountAction::TransferNear {
                receiver_id: accounts(2),
                amount: NearToken::from_near(1),
            },
        );

        // First callback unlocks state
        testing_env!(context
            .storage_usage(env::storage_usage())
            .predecessor_account_id(accounts(0))
            .build());
        let res1 = contract.on_subaccount_executed(token_id.clone(), 1, accounts(0), Result::Ok(true));
        assert!(res1);
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);

        // Duplicate callback arriving later for the same nonce 1 has NO effect (token is already Unlocked)
        let res2 = contract.on_subaccount_executed(token_id.clone(), 1, accounts(0), Result::Ok(true));
        assert!(res2);
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
    }
}
