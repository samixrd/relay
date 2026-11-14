use near_contract_standards::non_fungible_token::{
    core::{NonFungibleTokenCore, NonFungibleTokenResolver},
    metadata::{NFTContractMetadata, NonFungibleTokenMetadataProvider},
    NonFungibleToken, Token, TokenId,
};
use std::collections::HashMap;
use near_sdk::{
    borsh::BorshSerialize, env, near, require, AccountId, PanicOnDefault, PromiseOrValue,
};

#[derive(BorshSerialize, near_sdk::BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    OwnerById,
    TokenMetadata,
    Metadata,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    tokens: NonFungibleToken,
    metadata: near_sdk::collections::LazyOption<NFTContractMetadata>,
    owner_id: AccountId,
}

#[near]
impl Contract {
    #[init]
    pub fn new_default_meta(owner_id: AccountId) -> Self {
        Self::new(
            owner_id,
            NFTContractMetadata {
                spec: "nft-1.0.0".to_string(),
                name: "RELAY External Test NFT".to_string(),
                symbol: "RELAYTEST".to_string(),
                icon: None,
                base_uri: None,
                reference: None,
                reference_hash: None,
            },
        )
    }

    #[init]
    pub fn new(owner_id: AccountId, metadata: NFTContractMetadata) -> Self {
        require!(!env::state_exists(), "Already initialized");
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::OwnerById,
                owner_id.clone(),
                Some(StorageKey::TokenMetadata),
                None::<StorageKey>,
                None::<StorageKey>,
            ),
            metadata: near_sdk::collections::LazyOption::new(
                StorageKey::Metadata,
                Some(&metadata),
            ),
            owner_id,
        }
    }

    #[payable]
    pub fn mint(
        &mut self,
        token_id: TokenId,
        token_owner_id: AccountId,
        token_metadata: near_contract_standards::non_fungible_token::metadata::TokenMetadata,
    ) -> Token {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the NFT contract owner can mint"
        );
        self.tokens.internal_mint(
            token_id,
            token_owner_id,
            Some(token_metadata),
        )
    }

}

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
            .nft_transfer(receiver_id, token_id, approval_id, memo)
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

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap()
    }
}
