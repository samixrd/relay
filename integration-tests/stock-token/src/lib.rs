//! Minimal NEP-141 test token used by the RELAY stock/commodity demo.
//!
//! Unlike the Stage H fixture, metadata is supplied at initialization time so
//! the same WASM can back AAPL, TSLA, GOLD, and OIL on Testnet. The owner can
//! mint the treasury supply; transfers and storage management are the standard
//! `near-contract-standards` implementation.

use near_contract_standards::fungible_token::{
    core::FungibleTokenCore,
    metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC},
    resolver::FungibleTokenResolver,
    FungibleToken,
};
use near_sdk::{
    borsh::BorshSerialize, env, near, require, AccountId, NearToken, PanicOnDefault,
    PromiseOrValue,
};

#[derive(BorshSerialize, near_sdk::BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    FungibleToken,
    Metadata,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: near_sdk::collections::LazyOption<FungibleTokenMetadata>,
    owner_id: AccountId,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, name: String, symbol: String, decimals: u8) -> Self {
        require!(!env::state_exists(), "Already initialized");
        require!(decimals <= 24, "Decimals must be at most 24");
        Self {
            token: FungibleToken::new(StorageKey::FungibleToken),
            metadata: near_sdk::collections::LazyOption::new(
                StorageKey::Metadata,
                Some(&FungibleTokenMetadata {
                    spec: FT_METADATA_SPEC.to_string(),
                    name,
                    symbol,
                    icon: None,
                    reference: None,
                    reference_hash: None,
                    decimals,
                }),
            ),
            owner_id,
        }
    }

    /// Mint new supply. Only the token owner (the RELAY treasury) can call it.
    pub fn mint(&mut self, account_id: AccountId, amount: near_sdk::json_types::U128) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the token owner can mint"
        );
        self.token.internal_deposit(&account_id, amount.0);
    }

    /// Burn supply from an account. Only the token owner can call it.
    pub fn burn(&mut self, account_id: AccountId, amount: near_sdk::json_types::U128) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the token owner can burn"
        );
        self.token.internal_withdraw(&account_id, amount.0);
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(
        &mut self,
        receiver_id: AccountId,
        amount: near_sdk::json_types::U128,
        memo: Option<String>,
    ) {
        self.token.ft_transfer(receiver_id, amount, memo);
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: near_sdk::json_types::U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<near_sdk::json_types::U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_balance_of(&self, account_id: AccountId) -> near_sdk::json_types::U128 {
        self.token.ft_balance_of(account_id)
    }

    fn ft_total_supply(&self) -> near_sdk::json_types::U128 {
        self.token.ft_total_supply()
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: near_sdk::json_types::U128,
    ) -> near_sdk::json_types::U128 {
        let (amount_used, _) = self
            .token
            .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        amount_used.into()
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

#[near]
impl near_contract_standards::storage_management::StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> near_contract_standards::storage_management::StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(
        &mut self,
        amount: Option<NearToken>,
    ) -> near_contract_standards::storage_management::StorageBalance {
        self.token.storage_withdraw(amount)
    }

    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.storage_unregister(force)
    }

    fn storage_balance_bounds(
        &self,
    ) -> near_contract_standards::storage_management::StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(
        &self,
        account_id: AccountId,
    ) -> Option<near_contract_standards::storage_management::StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}
