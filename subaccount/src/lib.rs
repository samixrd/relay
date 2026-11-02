/*!
RELAY — Token-Bound Sub-Account Controller Contract

This contract is deployed directly onto the per-item canonical NEAR sub-account
(`<token_id>.<parent_contract_id>`). It holds custody of native NEAR balances
and child NEP-171 NFTs.

## Trust Boundary & Authorization Flow
1. Ownership authority is maintained strictly by the parent RELAY NFT contract.
2. The sub-account controller has NO user FullAccess keys.
3. Protected operations (`execute`) are accepted ONLY when `env::predecessor_account_id()`
   is the permanently bound `parent_contract_id`. Direct calls from users (even the NFT owner)
   are rejected.
4. The parent contract locks the token during dispatch to eliminate TOCTOU races between
   in-flight operations and NFT ownership transfers.
5. Bidirectional handshake (`register_with_parent`) calls the parent's
   `relay_verify_associated_account`, proving on-chain existence.
*/

use near_contract_standards::non_fungible_token::core::NonFungibleTokenReceiver;
use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

// ---------------------------------------------------------------------------
// External Interfaces
// ---------------------------------------------------------------------------

#[near_sdk::ext_contract(ext_parent_relay)]
pub trait ExtParentRelay {
    fn relay_verify_associated_account(&mut self, token_id: TokenId);
}

#[near_sdk::ext_contract(ext_nep171_core)]
pub trait ExtNep171Core {
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    );
}

// ---------------------------------------------------------------------------
// Typed Sub-Account Operations
// ---------------------------------------------------------------------------

/// Typed, bounded operations that an authorized RELAY owner can execute via this sub-account.
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

// ---------------------------------------------------------------------------
// Contract State
// ---------------------------------------------------------------------------

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct SubaccountController {
    /// The parent RELAY NFT contract ID this sub-account is bound to.
    parent_contract_id: AccountId,
    /// The specific token ID this sub-account is bound to.
    token_id: TokenId,
}

// ---------------------------------------------------------------------------
// Initialization & Core Methods
// ---------------------------------------------------------------------------

#[near]
impl SubaccountController {
    /// Initializes the controller and permanently binds it to a parent contract and token ID.
    ///
    /// Cryptographically enforces that this contract's own account ID strictly matches
    /// the canonical sub-account pattern: `<token_id>.<parent_contract_id>`.
    #[init]
    pub fn new(parent_contract_id: AccountId, token_id: TokenId) -> Self {
        require!(!env::state_exists(), "Already initialized");
        let expected_account_id = format!("{}.{}", token_id, parent_contract_id);
        require!(
            env::current_account_id().as_str() == expected_account_id.as_str(),
            "Sub-account cannot be initialized: account ID does not match canonical <token_id>.<parent_contract_id>"
        );
        Self {
            parent_contract_id,
            token_id,
        }
    }

    /// Triggers the on-chain handshake with the parent contract to prove existence.
    /// Can only be called by the parent contract itself or by the sub-account.
    pub fn register_with_parent(&mut self) -> Promise {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.parent_contract_id || caller == env::current_account_id(),
            "Only the parent RELAY contract or the sub-account itself can trigger registration"
        );
        ext_parent_relay::ext(self.parent_contract_id.clone())
            .with_static_gas(Gas::from_tgas(20))
            .relay_verify_associated_account(self.token_id.clone())
    }

    /// Executes a typed, bounded operation dispatched by the parent contract.
    ///
    /// SECURITY: Only `parent_contract_id` can call this method! Direct calls from
    /// external users, even the token owner, are rejected.
    pub fn execute(&mut self, action: SubaccountAction) -> PromiseOrValue<bool> {
        require!(
            env::predecessor_account_id() == self.parent_contract_id,
            "Unauthorized: Only the parent RELAY contract can dispatch operations to this sub-account"
        );

        match action {
            SubaccountAction::TransferNear {
                receiver_id,
                amount,
            } => {
                require!(
                    env::account_balance() >= amount,
                    "Insufficient native NEAR balance in sub-account"
                );
                Promise::new(receiver_id).transfer(amount).into()
            }
            SubaccountAction::TransferNep171 {
                nft_contract_id,
                receiver_id,
                token_id,
            } => {
                ext_nep171_core::ext(nft_contract_id)
                    .with_attached_deposit(NearToken::from_yoctonear(1))
                    .with_static_gas(Gas::from_tgas(20))
                    .nft_transfer(receiver_id, token_id, None, None)
                    .into()
            }
        }
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    pub fn get_parent_contract(&self) -> AccountId {
        self.parent_contract_id.clone()
    }

    pub fn get_token_id(&self) -> TokenId {
        self.token_id.clone()
    }

    pub fn get_native_balance(&self) -> NearToken {
        env::account_balance()
    }
}

// ---------------------------------------------------------------------------
// NEP-171 Receiver Implementation
// ---------------------------------------------------------------------------

#[near]
impl NonFungibleTokenReceiver for SubaccountController {
    /// Handles incoming NEP-171 NFTs transferred via `nft_transfer_call`.
    /// Returns false to instruct the calling NFT contract to retain the token in this sub-account.
    fn nft_on_transfer(
        &mut self,
        _sender_id: AccountId,
        _previous_owner_id: AccountId,
        _token_id: TokenId,
        _msg: String,
    ) -> PromiseOrValue<bool> {
        // Return false to accept and retain custody of the attached child NFT
        PromiseOrValue::Value(false)
    }
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn get_context(current_account_id: AccountId, predecessor_account_id: AccountId) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(current_account_id)
            .signer_account_id(predecessor_account_id.clone())
            .predecessor_account_id(predecessor_account_id);
        builder
    }

    #[test]
    fn test_init_success() {
        let parent = accounts(0);
        let token_id = "relay-1".to_string();
        let subaccount: AccountId = format!("{}.{}", token_id, parent).parse().unwrap();

        let context = get_context(subaccount.clone(), parent.clone());
        testing_env!(context.build());

        let contract = SubaccountController::new(parent.clone(), token_id.clone());
        assert_eq!(contract.get_parent_contract(), parent);
        assert_eq!(contract.get_token_id(), token_id);
    }

    #[test]
    #[should_panic(expected = "account ID does not match canonical")]
    fn test_init_rejects_mismatched_account_id() {
        let parent = accounts(0);
        let token_id = "relay-1".to_string();
        // Current account ID does NOT match <token_id>.<parent>
        let wrong_account: AccountId = "unrelated.near".parse().unwrap();

        let context = get_context(wrong_account, parent.clone());
        testing_env!(context.build());

        SubaccountController::new(parent, token_id);
    }

    #[test]
    #[should_panic(expected = "Unauthorized: Only the parent RELAY contract can dispatch operations")]
    fn test_execute_rejects_unauthorized_direct_caller() {
        let parent = accounts(0);
        let token_id = "relay-1".to_string();
        let subaccount: AccountId = format!("{}.{}", token_id, parent).parse().unwrap();

        let mut context = get_context(subaccount, parent.clone());
        testing_env!(context.build());
        let mut contract = SubaccountController::new(parent, token_id);

        // A direct caller (e.g. accounts(1) - even if they are the NFT owner) tries to call execute directly
        testing_env!(context.predecessor_account_id(accounts(1)).build());

        let _ = contract.execute(SubaccountAction::TransferNear {
            receiver_id: accounts(2),
            amount: NearToken::from_near(1),
        });
    }

    #[test]
    fn test_execute_transfer_near_authorized() {
        let parent = accounts(0);
        let token_id = "relay-1".to_string();
        let subaccount: AccountId = format!("{}.{}", token_id, parent).parse().unwrap();

        let mut context = get_context(subaccount, parent.clone());
        testing_env!(context
            .account_balance(NearToken::from_near(10))
            .build());
        let mut contract = SubaccountController::new(parent.clone(), token_id);

        // Called by parent contract
        testing_env!(context
            .predecessor_account_id(parent)
            .account_balance(NearToken::from_near(10))
            .build());

        let res = contract.execute(SubaccountAction::TransferNear {
            receiver_id: accounts(2),
            amount: NearToken::from_near(2),
        });

        match res {
            PromiseOrValue::Promise(_) => {}
            _ => panic!("Expected PromiseOrValue::Promise"),
        }
    }

    #[test]
    #[should_panic(expected = "Insufficient native NEAR balance")]
    fn test_execute_transfer_near_insufficient_balance() {
        let parent = accounts(0);
        let token_id = "relay-1".to_string();
        let subaccount: AccountId = format!("{}.{}", token_id, parent).parse().unwrap();

        let mut context = get_context(subaccount, parent.clone());
        testing_env!(context
            .account_balance(NearToken::from_near(1))
            .build());
        let mut contract = SubaccountController::new(parent.clone(), token_id);

        testing_env!(context
            .predecessor_account_id(parent)
            .account_balance(NearToken::from_near(1))
            .build());

        let _ = contract.execute(SubaccountAction::TransferNear {
            receiver_id: accounts(2),
            amount: NearToken::from_near(5),
        });
    }

    #[test]
    fn test_execute_transfer_nep171_authorized() {
        let parent = accounts(0);
        let token_id = "relay-1".to_string();
        let subaccount: AccountId = format!("{}.{}", token_id, parent).parse().unwrap();

        let mut context = get_context(subaccount, parent.clone());
        testing_env!(context.build());
        let mut contract = SubaccountController::new(parent.clone(), token_id);

        testing_env!(context
            .predecessor_account_id(parent)
            .build());

        let res = contract.execute(SubaccountAction::TransferNep171 {
            nft_contract_id: "external-nft.near".parse().unwrap(),
            receiver_id: accounts(2),
            token_id: "child-nft-99".to_string(),
        });

        match res {
            PromiseOrValue::Promise(_) => {}
            _ => panic!("Expected PromiseOrValue::Promise"),
        }
    }

    #[test]
    fn test_nft_on_transfer_accepts_custody() {
        let parent = accounts(0);
        let token_id = "relay-1".to_string();
        let subaccount: AccountId = format!("{}.{}", token_id, parent).parse().unwrap();

        let context = get_context(subaccount, parent.clone());
        testing_env!(context.build());
        let mut contract = SubaccountController::new(parent, token_id);

        let result = contract.nft_on_transfer(
            accounts(1),
            accounts(2),
            "external-token-42".to_string(),
            "".to_string(),
        );

        // Returns Value(false) to indicate the sub-account accepts and keeps custody of the NFT
        match result {
            PromiseOrValue::Value(val) => assert!(!val),
            _ => panic!("Expected PromiseOrValue::Value(false)"),
        }
    }
}
