use near_contract_standards::non_fungible_token::core::NonFungibleTokenReceiver;
use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::{env, near, require, AccountId, PanicOnDefault, PromiseOrValue};

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Receiver {
    reject: bool,
}

#[near]
impl Receiver {
    #[init]
    pub fn new(reject: bool) -> Self {
        require!(!env::state_exists(), "Already initialized");
        Self { reject }
    }

    pub fn should_reject(&self) -> bool {
        self.reject
    }
}

#[near]
impl NonFungibleTokenReceiver for Receiver {
    fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: TokenId,
        msg: String,
    ) -> PromiseOrValue<bool> {
        env::log_str(&format!(
            "receiver_args sender={} previous_owner={} token={} msg={}",
            sender_id, previous_owner_id, token_id, msg
        ));
        PromiseOrValue::Value(self.reject)
    }
}
