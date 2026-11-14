use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::{env, near, require, AccountId, PanicOnDefault, PromiseOrValue};
use near_sdk::json_types::U128;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ReceiverObservation {
    pub sender_id: AccountId,
    pub amount: U128,
    pub msg: String,
    pub accepted: bool,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Receiver {
    mode: String,
    last_transfer: Option<ReceiverObservation>,
}

#[near]
impl Receiver {
    #[init]
    pub fn new(mode: String) -> Self {
        require!(!env::state_exists(), "Already initialized");
        require!(
            matches!(mode.as_str(), "accept" | "reject" | "partial" | "fail"),
            "Unsupported local receiver mode"
        );
        Self {
            mode,
            last_transfer: None,
        }
    }

    pub fn should_reject(&self) -> bool {
        self.mode == "reject"
    }

    pub fn last_transfer(&self) -> Option<ReceiverObservation> {
        self.last_transfer.clone()
    }
}

#[near]
impl FungibleTokenReceiver for Receiver {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        env::log_str(&format!(
            "payment_receiver sender={} amount={} msg={} mode={}",
            sender_id, amount.0, msg, self.mode
        ));
        if self.mode == "fail" {
            env::panic_str("Injected local receiver callback failure");
        }
        let accepted = self.mode == "accept" || self.mode == "partial";
        self.last_transfer = Some(ReceiverObservation {
            sender_id,
            amount,
            msg,
            accepted,
        });
        match self.mode.as_str() {
            "accept" => PromiseOrValue::Value(U128(0)),
            "reject" => PromiseOrValue::Value(amount),
            "partial" => PromiseOrValue::Value(U128(amount.0 / 2)),
            _ => unreachable!(),
        }
    }
}
