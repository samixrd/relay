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
    env, near, require, AccountId, BorshStorageKey, PanicOnDefault, Promise, PromiseOrValue,
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
    /// Mapping: token_id → associated NEAR account ID.
    associated_accounts: LookupMap<TokenId, AccountId>,
    /// Mapping: token_id → credit state.
    credits: LookupMap<TokenId, CreditState>,
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

    /// Mint a new RELAY NFT.
    ///
    /// - `token_id`: unique string identifier.
    /// - `token_owner_id`: initial owner.
    /// - `token_metadata`: NEP-177 metadata for the token.
    /// - `associated_account_id`: the real NEAR account bound to this RELAY.
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

        // Store RELAY-specific data
        self.associated_accounts
            .insert(&token_id, &associated_account_id);
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
        self.associated_accounts.get(&token_id)
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
        // Verify the caller owns the token
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
        self.tokens.nft_resolve_transfer(
            previous_owner_id,
            receiver_id,
            token_id,
            approved_account_ids,
        )
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
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.tokens.nft_revoke(token_id, account_id);
    }

    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
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
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

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

        let associated: AccountId = "relay-1.testnet".parse().unwrap();
        let token = contract.relay_mint(
            "relay-1".to_string(),
            accounts(0),
            sample_token_metadata(),
            associated.clone(),
            3,
        );

        assert_eq!(token.token_id, "relay-1");
        assert_eq!(token.owner_id, accounts(0));

        // Verify RELAY extensions
        assert_eq!(
            contract.relay_associated_account("relay-1".to_string()),
            Some(associated)
        );
        let credits = contract.relay_credits("relay-1".to_string()).unwrap();
        assert_eq!(credits.total, 3);
        assert_eq!(credits.remaining, 3);
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

        let associated: AccountId = "relay-1.testnet".parse().unwrap();
        contract.relay_mint(
            "relay-1".to_string(),
            accounts(0),
            sample_token_metadata(),
            associated,
            3,
        );

        // Use one credit
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        contract.relay_use_credit("relay-1".to_string());

        let credits = contract.relay_credits("relay-1".to_string()).unwrap();
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

        let associated: AccountId = "relay-1.testnet".parse().unwrap();
        contract.relay_mint(
            "relay-1".to_string(),
            accounts(0),
            sample_token_metadata(),
            associated,
            3,
        );

        // Non-owner tries to use credit → should panic
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(1))
            .build());

        contract.relay_use_credit("relay-1".to_string());
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

        let associated: AccountId = "relay-1.testnet".parse().unwrap();
        contract.relay_mint(
            "relay-1".to_string(),
            accounts(0),
            sample_token_metadata(),
            associated.clone(),
            3,
        );

        // Use one credit as owner
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());
        contract.relay_use_credit("relay-1".to_string());

        // Transfer to accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());
        contract.nft_transfer(accounts(1), "relay-1".to_string(), None, None);

        // Verify token now owned by accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .is_view(true)
            .attached_deposit(NearToken::from_near(0))
            .build());

        let token = contract.nft_token("relay-1".to_string()).unwrap();
        assert_eq!(token.owner_id, accounts(1));

        // Associated account and credits preserved
        assert_eq!(
            contract.relay_associated_account("relay-1".to_string()),
            Some(associated)
        );
        let credits = contract.relay_credits("relay-1".to_string()).unwrap();
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

        let associated: AccountId = "relay-1.testnet".parse().unwrap();
        contract.relay_mint(
            "relay-1".to_string(),
            accounts(0),
            sample_token_metadata(),
            associated,
            1, // Only 1 credit
        );

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        // Use the only credit
        contract.relay_use_credit("relay-1".to_string());

        // Try to use again → should panic
        contract.relay_use_credit("relay-1".to_string());
    }
}
