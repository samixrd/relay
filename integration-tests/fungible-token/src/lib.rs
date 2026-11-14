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

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TransferObservation {
    pub method: String,
    pub sender_id: AccountId,
    pub receiver_id: AccountId,
    pub amount: near_sdk::json_types::U128,
    pub memo: Option<String>,
    pub msg: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ResolutionObservation {
    pub sender_id: AccountId,
    pub receiver_id: AccountId,
    pub amount: near_sdk::json_types::U128,
    pub amount_used: near_sdk::json_types::U128,
    pub amount_refunded: near_sdk::json_types::U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: near_sdk::collections::LazyOption<FungibleTokenMetadata>,
    owner_id: AccountId,
    fail_resolver: bool,
    last_transfer: Option<TransferObservation>,
    last_resolution: Option<ResolutionObservation>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        require!(!env::state_exists(), "Already initialized");
        Self {
            token: FungibleToken::new(StorageKey::FungibleToken),
            metadata: near_sdk::collections::LazyOption::new(
                StorageKey::Metadata,
                Some(&FungibleTokenMetadata {
                    spec: FT_METADATA_SPEC.to_string(),
                    name: "RELAY Stage H Fixture Token".to_string(),
                    symbol: "HFT".to_string(),
                    icon: None,
                    reference: None,
                    reference_hash: None,
                    decimals: 6,
                }),
            ),
            owner_id,
            fail_resolver: false,
            last_transfer: None,
            last_resolution: None,
        }
    }

    pub fn mint(&mut self, account_id: AccountId, amount: near_sdk::json_types::U128) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the fixture owner can mint"
        );
        self.token.internal_deposit(&account_id, amount.0);
    }

    pub fn set_resolver_failure(&mut self, fail: bool) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the fixture owner can configure resolver failure"
        );
        self.fail_resolver = fail;
    }

    pub fn last_transfer(&self) -> Option<TransferObservation> {
        self.last_transfer.clone()
    }

    pub fn last_resolution(&self) -> Option<ResolutionObservation> {
        self.last_resolution.clone()
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
        let sender_id = env::predecessor_account_id();
        self.token
            .ft_transfer(receiver_id.clone(), amount, memo.clone());
        self.last_transfer = Some(TransferObservation {
            method: "ft_transfer".to_string(),
            sender_id,
            receiver_id,
            amount,
            memo,
            msg: None,
        });
        self.last_resolution = None;
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: near_sdk::json_types::U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<near_sdk::json_types::U128> {
        let sender_id = env::predecessor_account_id();
        let result = self
            .token
            .ft_transfer_call(receiver_id.clone(), amount, memo.clone(), msg.clone());
        self.last_transfer = Some(TransferObservation {
            method: "ft_transfer_call".to_string(),
            sender_id,
            receiver_id,
            amount,
            memo,
            msg: Some(msg),
        });
        self.last_resolution = None;
        result
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
        require!(!self.fail_resolver, "Fixture resolver failure enabled");
        let (amount_used, _) = self.token.internal_ft_resolve_transfer(
            &sender_id,
            receiver_id.clone(),
            amount,
        );
        self.last_resolution = Some(ResolutionObservation {
            sender_id,
            receiver_id,
            amount,
            amount_used: amount_used.into(),
            amount_refunded: (amount.0 - amount_used).into(),
        });
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
