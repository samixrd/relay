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
- Anyone may mint to themselves (`relay_mint` with `token_owner_id == predecessor`).
  The contract owner may additionally mint to any recipient.
- Token IDs beginning with `u-` are reserved for RELAY-issued user accounts and
  can only be minted by the contract owner.
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
use near_sdk::json_types::{U128, U64};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};
use near_sdk::serde_json::{self, Value};
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
    ControllerCode,
    ProvisioningStates,
    UnclaimedRefunds,
    PendingRefundClaims,
    RefundClaimNonces,
    Payments,
    QuoteNonces,
    QuoteAuthorizations,
    ActiveQuoteCommitments,
    UsedProviderQuoteHashes,
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
    /// Token is locked while provisioning its associated sub-account.
    LockedForProvisioning {
        nonce: u64,
        initiator: AccountId,
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
    /// Calls ft_transfer on a bounded NEP-141 token contract.
    TransferNep141 {
        ft_contract_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    },
    /// Calls ft_transfer_call on a bounded NEP-141 token contract.
    TransferNep141Call {
        ft_contract_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
        msg: String,
    },
    /// Registers the sub-account for NEP-141 storage at a token contract so it
    /// can receive and later transfer that token.
    RegisterNep141 {
        ft_contract_id: AccountId,
        storage_deposit: NearToken,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum TokenTransferStatus {
    Pending,
    TokenTransferCompleted,
    TokenTransferRefunded,
    TokenTransferPartiallyRefunded,
    TokenTransferFailed,
    RecoveryRequired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum CheckoutStatus {
    CheckoutPending,
    SourceTransferCompleted,
    CheckoutSettled,
    CheckoutRefunded,
    RecoveryRequired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PaymentRecord {
    pub token_id: TokenId,
    pub associated_account_id: AccountId,
    pub owner_at_dispatch: AccountId,
    pub source_ft_contract: Option<AccountId>,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub nonce: u64,
    pub payment_id: String,
    /// Optional NEAR block timestamp deadline, in nanoseconds.
    pub deadline: Option<U64>,
    pub transfer_call: bool,
    /// NEP-141 resolver amount-used result. Does not prove checkout settlement.
    pub resolved_amount_used: Option<U128>,
    pub token_transfer_status: TokenTransferStatus,
    /// None means no checkout integration has been dispatched.
    pub checkout_status: Option<CheckoutStatus>,
    pub commitment_hash: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct QuoteAuthorizationInput {
    pub provider_signature_hash: String,
    pub provider_signature: Vec<u8>,
    pub provider_signed_payload: String,
    pub commitment_hash: String,
    pub source_asset: String,
    pub source_decimals: u8,
    pub deposit_type: String,
    pub source_amount: U128,
    pub destination_asset: String,
    pub destination_decimals: u8,
    pub expected_output: U128,
    pub minimum_output: U128,
    pub recipient: String,
    pub deposit_address: String,
    pub deposit_memo: Option<String>,
    pub refund_address: AccountId,
    pub refund_type: String,
    pub request_deadline: U64,
    pub provider_quote_deadline: U64,
    pub provider_inactive_deadline: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum QuoteAuthorizationStatus {
    Prepared,
    Consumed,
    Cancelled,
    Expired,
    InvalidatedOwnership,
    InvalidatedContext,
    RecoveryRequired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum DepositDispatchStatus {
    Disabled,
    Dispatched,
    SourceTransferCompleted,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct QuoteAuthorization {
    pub token_id: TokenId,
    pub parent_contract_id: AccountId,
    pub associated_account_id: AccountId,
    pub owner_at_authorization: AccountId,
    pub nonce: U64,
    pub provider_signature_hash: String,
    pub commitment_hash: String,
    pub account_binding_verified: bool,
    pub source_asset: String,
    pub source_decimals: u8,
    pub deposit_type: String,
    pub source_amount: U128,
    pub destination_asset: String,
    pub destination_decimals: u8,
    pub expected_output: U128,
    pub minimum_output: U128,
    pub recipient: String,
    pub deposit_address: String,
    pub deposit_memo: Option<String>,
    pub refund_address: AccountId,
    pub refund_type: String,
    pub request_deadline: U64,
    pub provider_quote_deadline: U64,
    pub provider_inactive_deadline: Option<U64>,
    pub created_block_height: U64,
    pub created_timestamp: U64,
    pub deposit_dispatch_status: DepositDispatchStatus,
    pub status: QuoteAuthorizationStatus,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub enum PaymentExecutionResult {
    TransferSucceeded,
    TransferFailed,
    TransferCallResolved { amount_used: U128 },
    RecoveryRequired,
}

/// Provisioning state for a RELAY token's associated sub-account.
/// Tracks the lifecycle of on-chain account creation, controller deployment,
/// and initialization.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ProvisioningState {
    /// Default: NFT minted, sub-account not yet created on-chain.
    NotStarted,
    /// Provisioning batch dispatched; awaiting async callback.
    Pending {
        /// The generation nonce for this provisioning attempt.
        nonce: u64,
        /// The account that initiated (and funded) provisioning.
        initiator: AccountId,
        /// The attached deposit (yoctoNEAR) to refund on failure.
        deposit: NearToken,
    },
    /// Emergency recovery was requested; awaiting in-flight receipt outcome.
    /// Invariant: attached deposit cannot be refunded until NEAR runtime returns it.
    RecoveryPending {
        /// The generation nonce for this provisioning attempt.
        nonce: u64,
        /// The account that initiated (and funded) provisioning.
        initiator: AccountId,
        /// The attached deposit (yoctoNEAR) to refund if the receipt fails.
        deposit: NearToken,
    },
    /// Provisioning failed; deposit refunded; retryable.
    Failed {
        /// The nonce of the failed attempt.
        nonce: u64,
    },
    /// Provisioning succeeded; sub-account is live and verified.
    Completed,
}

/// Unresolved refund claim for an account.
///
/// The amount remains a liability while the transfer and its callback are unresolved.
/// If the callback receipt itself does not commit, this record is a quarantine: the
/// contract cannot determine whether the transfer succeeded and must not retry it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ClaimPending {
    /// Monotonically increasing nonce for this account's claim attempt.
    pub nonce: u64,
    /// Amount of yoctoNEAR reserved until a matching transfer result commits.
    pub amount: NearToken,
    /// Block height at which the claim was initiated.
    pub block_height: u64,
}

#[near_sdk::ext_contract(ext_subaccount)]
pub trait ExtSubaccount {
    fn execute(&mut self, action: SubaccountAction) -> PromiseOrValue<bool>;
    fn execute_payment(
        &mut self,
        ft_contract_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
        transfer_call: bool,
        msg: String,
    ) -> Promise;
    fn execute_nep141_deposit(
        &mut self,
        ft_contract_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
        deposit_memo: Option<String>,
    ) -> Promise;
    fn get_token_id(&self) -> TokenId;
    fn get_parent_contract(&self) -> AccountId;
    fn get_controller_state(&self) -> (AccountId, TokenId);
}

fn append_quote_commitment_field(bytes: &mut Vec<u8>, value: &str) {
    let value_bytes = value.as_bytes();
    bytes.extend_from_slice(&(value_bytes.len() as u32).to_be_bytes());
    bytes.extend_from_slice(value_bytes);
}

#[cfg(any(test, feature = "sandbox-checkout-dispatch"))]
const PROVIDER_QUOTE_PUBLIC_KEY: [u8; 32] = [
    0x79, 0xb5, 0x56, 0x2e, 0x8f, 0xe6, 0x54, 0xf9, 0x40, 0x78, 0xb1, 0x12, 0xe8, 0xa9, 0x8b,
    0xa7, 0x90, 0x1f, 0x85, 0x3a, 0xe6, 0x95, 0xbe, 0xd7, 0xe0, 0xe3, 0x91, 0x0b, 0xad, 0x04,
    0x96, 0x64,
];

#[cfg(not(any(test, feature = "sandbox-checkout-dispatch")))]
const PROVIDER_QUOTE_PUBLIC_KEY: [u8; 32] = [
    0x0c, 0xb7, 0xe9, 0x49, 0xe3, 0x87, 0x1e, 0xcf, 0x28, 0x4a, 0x50, 0xb8, 0xe7, 0x74, 0xab,
    0x29, 0xb3, 0xf7, 0xb2, 0x36, 0x3e, 0x39, 0x8c, 0xef, 0x1d, 0xf2, 0xe9, 0x44, 0x57, 0xb7,
    0xe9, 0x43,
];

fn provider_signed_string<'a>(payload: &'a Value, field: &str) -> &'a str {
    payload
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_else(|| env::panic_str("Provider quote signed payload is missing a string field"))
}

fn provider_signed_deadline(payload: &Value, field: &str) -> u64 {
    parse_provider_deadline_nanos(provider_signed_string(payload, field))
        .unwrap_or_else(|| env::panic_str("Provider quote contains an invalid signed deadline"))
}

fn parse_provider_deadline_nanos(value: &str) -> Option<u64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let number = |start: usize, end: usize| -> Option<i64> {
        let part = std::str::from_utf8(bytes.get(start..end)?).ok()?;
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    if !(1..=12).contains(&month)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=59).contains(&second)
    {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=days_in_month).contains(&day) {
        return None;
    }

    let mut cursor = 19;
    let mut fractional_nanos = 0i64;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        let digits = std::str::from_utf8(bytes.get(start..cursor)?).ok()?;
        if digits.is_empty() || digits.len() > 9 {
            return None;
        }
        fractional_nanos = digits.parse::<i64>().ok()?;
        for _ in digits.len()..9 {
            fractional_nanos *= 10;
        }
    }

    let offset_seconds = match bytes.get(cursor)? {
        b'Z' if cursor + 1 == bytes.len() => 0i64,
        b'+' | b'-' if bytes.len() == cursor + 6 && bytes.get(cursor + 3) == Some(&b':') => {
            let offset_hour = number(cursor + 1, cursor + 3)?;
            let offset_minute = number(cursor + 4, cursor + 6)?;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            let direction = if bytes[cursor] == b'+' { 1 } else { -1 };
            direction * (offset_hour * 3600 + offset_minute * 60)
        }
        _ => return None,
    };

    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days_since_epoch = era * 146097 + day_of_era - 719468;
    let seconds = days_since_epoch
        .checked_mul(86_400)?
        .checked_add(hour * 3600 + minute * 60 + second)?
        .checked_sub(offset_seconds)?;
    let nanos = i128::from(seconds) * 1_000_000_000 + i128::from(fractional_nanos);
    u64::try_from(nanos).ok()
}

fn verify_provider_quote(quote: &QuoteAuthorizationInput) -> String {
    verify_provider_quote_with_key(quote, &PROVIDER_QUOTE_PUBLIC_KEY)
}

fn verify_provider_quote_with_key(
    quote: &QuoteAuthorizationInput,
    public_key: &[u8; 32],
) -> String {
    require!(
        quote.provider_signed_payload.len() <= 16_384,
        "Provider quote signed payload is too large"
    );
    require!(
        quote.provider_signature.len() == 64,
        "Provider Ed25519 signature must be exactly 64 bytes"
    );
    let payload: Value = serde_json::from_str(&quote.provider_signed_payload)
        .unwrap_or_else(|_| env::panic_str("Provider quote signed payload is invalid JSON"));
    let canonical_payload =
        serde_json::to_string(&payload).expect("Serializing a parsed JSON value cannot fail");
    require!(
        payload.is_object() && canonical_payload == quote.provider_signed_payload,
        "Provider quote signed payload is not canonical JSON"
    );
    let object = payload.as_object().unwrap();
    const ALLOWED_FIELDS: &[&str] = &[
        "amount", "amountIn", "amountInFormatted", "amountInUsd", "amountOut",
        "amountOutFormatted", "amountOutUsd", "deadline", "depositAddress", "depositMemo",
        "depositType", "destinationAsset", "dry", "minAmountIn", "minAmountOut", "originAsset",
        "recipient", "recipientType", "refundFee", "refundTo", "refundType", "slippageTolerance",
        "swapType", "timeEstimate", "timeWhenInactive", "timestamp", "withdrawFee",
    ];
    require!(
        object.keys().all(|field| ALLOWED_FIELDS.contains(&field.as_str())),
        "Provider quote signed payload contains unsupported fields"
    );
    require!(
        payload.get("dry").and_then(Value::as_bool) == Some(false)
            && provider_signed_string(&payload, "swapType") == "EXACT_INPUT"
            && payload
                .get("slippageTolerance")
                .and_then(Value::as_u64)
                .is_some_and(|value| (1..=5000).contains(&value))
            && provider_signed_string(&payload, "originAsset") == quote.source_asset
            && provider_signed_string(&payload, "depositType") == quote.deposit_type
            && provider_signed_string(&payload, "destinationAsset") == quote.destination_asset
            && provider_signed_string(&payload, "amount") == quote.source_amount.0.to_string()
            && provider_signed_string(&payload, "refundTo") == quote.refund_address.as_str()
            && provider_signed_string(&payload, "refundType") == quote.refund_type
            && provider_signed_string(&payload, "recipient") == quote.recipient
            && provider_signed_string(&payload, "recipientType") == "DESTINATION_CHAIN"
            && provider_signed_string(&payload, "amountIn") == quote.source_amount.0.to_string()
            && provider_signed_string(&payload, "minAmountIn") == quote.source_amount.0.to_string()
            && provider_signed_string(&payload, "amountOut") == quote.expected_output.0.to_string()
            && provider_signed_string(&payload, "minAmountOut") == quote.minimum_output.0.to_string()
            && provider_signed_string(&payload, "depositAddress") == quote.deposit_address,
        "Provider-signed quote fields do not match the authorized quote"
    );
    match quote.deposit_memo.as_deref() {
        Some(memo) => require!(
            payload.get("depositMemo").and_then(Value::as_str) == Some(memo),
            "Provider-signed deposit memo does not match the authorized quote"
        ),
        None => require!(
            payload.get("depositMemo").is_none(),
            "Provider quote contains an unbound deposit memo"
        ),
    }
    require!(
        provider_signed_deadline(&payload, "deadline") == quote.provider_quote_deadline.0,
        "Provider-signed quote deadline does not match the authorized deadline"
    );
    match quote.provider_inactive_deadline {
        Some(deadline) => require!(
            payload
                .get("timeWhenInactive")
                .and_then(Value::as_str)
                .and_then(parse_provider_deadline_nanos)
                == Some(deadline.0),
            "Provider-signed inactivity deadline does not match the authorized deadline"
        ),
        None => require!(
            payload.get("timeWhenInactive").is_none(),
            "Provider quote contains an unbound inactivity deadline"
        ),
    }
    require!(
        quote.request_deadline.0 <= quote.provider_quote_deadline.0,
        "Request deadline cannot exceed the provider-signed quote deadline"
    );
    for field in [
        "amountInFormatted",
        "amountInUsd",
        "amountOutFormatted",
        "amountOutUsd",
        "refundFee",
        "timestamp",
        "withdrawFee",
    ] {
        if let Some(value) = payload.get(field) {
            require!(
                value
                    .as_str()
                    .is_some_and(|value| value.len() <= 256),
                "Provider quote signed field is malformed"
            );
        } else {
            require!(
                field == "timestamp",
                "Provider quote is missing its signed timestamp"
            );
        }
    }
    if let Some(time_estimate) = payload.get("timeEstimate") {
        require!(
            time_estimate.is_number(),
            "Provider quote signed time estimate is malformed"
        );
    }

    let signature: &[u8; 64] = quote.provider_signature.as_slice().try_into().unwrap();
    let digest = env::sha256(quote.provider_signed_payload.as_bytes());
    let message = bs58::encode(digest).into_string();
    require!(
        env::ed25519_verify(signature, message.as_bytes(), public_key),
        "Provider Ed25519 signature is invalid"
    );
    let signature_digest = env::sha256(&quote.provider_signature);
    let mut signature_hash = String::with_capacity(signature_digest.len() * 2);
    for byte in signature_digest {
        use std::fmt::Write;
        write!(&mut signature_hash, "{byte:02x}").expect("writing to a string cannot fail");
    }
    require!(
        quote.provider_signature_hash == signature_hash,
        "Provider signature digest does not match the verified signature"
    );
    signature_hash
}

fn quote_commitment_hash(
    token_id: &TokenId,
    parent_contract_id: &AccountId,
    associated_account_id: &AccountId,
    owner_id: &AccountId,
    nonce: u64,
    quote: &QuoteAuthorizationInput,
) -> String {
    let mut bytes = Vec::new();
    // Field order and u32 big-endian length prefixes mirror the quote adapter.
    let fields = [
        "RELAY-1CLICK-QUOTE-AUTH-V2".to_string(),
        token_id.clone(),
        parent_contract_id.to_string(),
        associated_account_id.to_string(),
        owner_id.to_string(),
        nonce.to_string(),
        quote.provider_signature_hash.clone(),
        quote.source_asset.clone(),
        quote.source_decimals.to_string(),
        quote.deposit_type.clone(),
        quote.source_amount.0.to_string(),
        quote.destination_asset.clone(),
        quote.destination_decimals.to_string(),
        quote.expected_output.0.to_string(),
        quote.minimum_output.0.to_string(),
        quote.recipient.clone(),
        quote.deposit_address.clone(),
        if quote.deposit_memo.is_some() {
            "1".to_string()
        } else {
            "0".to_string()
        },
        quote.deposit_memo.clone().unwrap_or_default(),
        quote.refund_address.to_string(),
        quote.refund_type.clone(),
        quote.request_deadline.0.to_string(),
        quote.provider_quote_deadline.0.to_string(),
        if quote.provider_inactive_deadline.is_some() {
            "1".to_string()
        } else {
            "0".to_string()
        },
        quote
            .provider_inactive_deadline
            .map(|deadline| deadline.0.to_string())
            .unwrap_or_default(),
    ];
    for field in fields {
        append_quote_commitment_field(&mut bytes, &field);
    }
    let digest = env::sha256(&bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        write!(&mut hex, "{byte:02x}").expect("writing to a string cannot fail");
    }
    hex
}

fn quote_authorization_deadline(
    request_deadline: u64,
    provider_quote_deadline: u64,
    provider_inactive_deadline: Option<U64>,
) -> u64 {
    provider_inactive_deadline
        .map(|deadline| deadline.0)
        .unwrap_or(u64::MAX)
        .min(request_deadline)
        .min(provider_quote_deadline)
}

#[cfg(feature = "sandbox-checkout-dispatch")]
fn prepared_wrapped_near_contract_id() -> AccountId {
    "stage-h-ft.sandbox"
        .parse()
        .expect("Local Sandbox wrapped-NEAR fixture account ID is valid")
}

#[cfg(not(feature = "sandbox-checkout-dispatch"))]
fn prepared_wrapped_near_contract_id() -> AccountId {
    "wrap.near"
        .parse()
        .expect("Wrapped-NEAR contract account ID is valid")
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
    /// On-chain storage for the relay_subaccount.wasm controller binary.
    /// Stored once by the contract owner; used during sub-account provisioning.
    controller_code: LazyOption<Vec<u8>>,
    /// Mapping: token_id → provisioning state for the associated sub-account.
    provisioning_states: LookupMap<TokenId, ProvisioningState>,
    /// Unclaimed refunds credited to users if an asynchronous refund transfer fails.
    unclaimed_refunds: LookupMap<AccountId, NearToken>,
    /// In-flight refund claims awaiting transfer outcome.
    pending_refund_claims: LookupMap<AccountId, ClaimPending>,
    /// Monotonic claim nonces per account to isolate concurrent or stale claim callbacks.
    refund_claim_nonces: LookupMap<AccountId, u64>,
    /// Total outstanding refund liabilities (unclaimed + in-flight pending) across all accounts.
    total_refund_liabilities: NearToken,
    /// Count of active in-flight provisioning operations (locks code updates during operations).
    pending_provisioning_count: u32,
    /// Token-bound payment records. A pending record is also protected by the lifecycle lock.
    payments: LookupMap<TokenId, PaymentRecord>,
    /// Independent monotonically increasing nonce for quote authorizations.
    quote_nonces: LookupMap<TokenId, u64>,
    /// Durable quote authorization history, keyed by the complete commitment hash.
    quote_authorizations: LookupMap<String, QuoteAuthorization>,
    /// At most one currently authorized quote per RELAY token.
    active_quote_commitments: LookupMap<TokenId, String>,
    /// Globally consumes canonical SHA-256 digests of decoded provider signature bytes.
    /// Entries are permanent across cancellation, expiration, and ownership changes.
    used_provider_signature_hashes: LookupMap<String, bool>,
    /// Enabled only by the feature-gated initializer used by the local Sandbox harness.
    local_sandbox_checkout_dispatch_enabled: bool,
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
            controller_code: LazyOption::new(StorageKey::ControllerCode, None),
            provisioning_states: LookupMap::new(StorageKey::ProvisioningStates),
            unclaimed_refunds: LookupMap::new(StorageKey::UnclaimedRefunds),
            pending_refund_claims: LookupMap::new(StorageKey::PendingRefundClaims),
            refund_claim_nonces: LookupMap::new(StorageKey::RefundClaimNonces),
            total_refund_liabilities: NearToken::from_near(0),
            pending_provisioning_count: 0,
            payments: LookupMap::new(StorageKey::Payments),
            quote_nonces: LookupMap::new(StorageKey::QuoteNonces),
            quote_authorizations: LookupMap::new(StorageKey::QuoteAuthorizations),
            active_quote_commitments: LookupMap::new(StorageKey::ActiveQuoteCommitments),
            used_provider_signature_hashes: LookupMap::new(StorageKey::UsedProviderQuoteHashes),
            local_sandbox_checkout_dispatch_enabled: false,
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

    #[cfg(feature = "sandbox-checkout-dispatch")]
    #[init]
    pub fn new_sandbox_checkout_test(owner_id: AccountId) -> Self {
        let mut contract = Self::new_default_meta(owner_id);
        contract.local_sandbox_checkout_dispatch_enabled = true;
        contract
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
        require!(
            subaccount_candidate.len() <= 64,
            "Canonical sub-account ID exceeds NEAR 64-character limit"
        );
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
    /// Anyone may mint a token to themselves. The contract owner may mint to any
    /// recipient. Token IDs beginning with `u-` are reserved for RELAY-issued
    /// user accounts and may only be minted by the contract owner.
    ///
    /// The attached deposit must cover the exact storage growth of the mint and
    /// any excess is refunded to the predecessor.
    #[payable]
    pub fn relay_mint(
        &mut self,
        token_id: TokenId,
        token_owner_id: AccountId,
        token_metadata: TokenMetadata,
        associated_account_id: AccountId,
        initial_credits: u32,
    ) -> Token {
        let predecessor = env::predecessor_account_id();
        let is_contract_owner = predecessor == self.tokens.owner_id;
        if !is_contract_owner {
            require!(
                token_owner_id == predecessor,
                "Only the contract owner can mint to another account"
            );
            require!(
                !token_id.starts_with("u-"),
                "Token IDs beginning with u- are reserved for RELAY user accounts"
            );
        }

        // Bound metadata so a mint cannot consume unbounded storage.
        if let Some(title) = &token_metadata.title {
            require!(
                !title.is_empty() && title.len() <= 64,
                "Title must contain 1 to 64 bytes"
            );
        }
        if let Some(description) = &token_metadata.description {
            require!(description.len() <= 1024, "Description exceeds 1024 bytes");
        }
        if let Some(media) = &token_metadata.media {
            require!(media.len() <= 1024, "Media URL exceeds 1024 bytes");
        }
        if let Some(reference) = &token_metadata.reference {
            require!(reference.len() <= 1024, "Reference exceeds 1024 bytes");
        }
        if let Some(extra) = &token_metadata.extra {
            require!(extra.len() <= 2048, "Extra metadata exceeds 2048 bytes");
        }

        // Enforce canonical sub-account namespace binding
        let canonical_account = self.relay_canonical_account_id(&token_id);
        require!(
            associated_account_id == canonical_account,
            "associated_account_id must match canonical sub-account format: <token_id>.<contract_id>"
        );

        let initial_storage_usage = env::storage_usage();

        // Store RELAY-specific data (initialized as unverified pending on-chain handshake)
        self.associated_accounts.insert(
            &token_id,
            &AccountBinding {
                account_id: associated_account_id,
                is_verified: false,
            },
        );
        self.provisioning_states
            .insert(&token_id, &ProvisioningState::NotStarted);
        self.credits.insert(
            &token_id,
            &CreditState {
                total: initial_credits,
                remaining: initial_credits,
            },
        );

        // Mint via standard NEP-171 without the standard refund: RELAY measures the
        // whole storage delta (including its own token maps) and refunds once below.
        let token = self.tokens.internal_mint_with_refund(
            token_id.clone(),
            token_owner_id,
            Some(token_metadata),
            None,
        );
        near_contract_standards::non_fungible_token::events::NftMint {
            owner_id: token.owner_id.as_ref(),
            token_ids: &[token_id.as_str()],
            memo: None,
        }
        .emit();

        let storage_bytes = env::storage_usage().saturating_sub(initial_storage_usage);
        let required_deposit = NearToken::from_yoctonear(
            (storage_bytes as u128).saturating_mul(env::storage_byte_cost().as_yoctonear()),
        );
        let attached_deposit = env::attached_deposit();
        require!(
            attached_deposit >= required_deposit,
            format!(
                "Insufficient attached deposit for mint storage: required {} yoctoNEAR, attached {} yoctoNEAR",
                required_deposit.as_yoctonear(),
                attached_deposit.as_yoctonear()
            )
        );
        let excess = attached_deposit.saturating_sub(required_deposit);
        if excess.as_yoctonear() > 0 {
            let _ = Promise::new(predecessor).transfer(excess);
        }

        token
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
        require!(
            self.token_lifecycle(&token_id) == TokenLifecycle::Unlocked,
            "Cannot verify associated account while token is locked pending an operation or transfer"
        );
        require!(
            !binding.is_verified,
            "Associated sub-account is already verified"
        );
        self.associated_accounts.insert(
            &token_id,
            &AccountBinding {
                account_id: binding.account_id,
                is_verified: true,
            },
        );
        self.provisioning_states
            .insert(&token_id, &ProvisioningState::Completed);
    }

    /// View the credit state for a RELAY token.
    pub fn relay_credits(&self, token_id: TokenId) -> Option<CreditState> {
        self.credits.get(&token_id)
    }

    /// Returns the token-bound payment record, if one has been dispatched.
    pub fn relay_payment(&self, token_id: TokenId) -> Option<PaymentRecord> {
        self.payments.get(&token_id)
    }

    /// Returns the next nonce available for a quote authorization.
    pub fn relay_quote_nonce(&self, token_id: TokenId) -> U64 {
        U64(self.quote_nonces.get(&token_id).unwrap_or(0))
    }

    /// Returns a quote authorization and its effective status at the current chain state.
    pub fn relay_quote_authorization(
        &self,
        token_id: TokenId,
        commitment_hash: String,
    ) -> Option<QuoteAuthorization> {
        let mut authorization = self.quote_authorizations.get(&commitment_hash)?;
        if authorization.token_id != token_id {
            return None;
        }
        if authorization.status == QuoteAuthorizationStatus::Prepared {
            let current_owner = self
                .tokens
                .nft_token(token_id.clone())
                .map(|token| token.owner_id);
            if current_owner.as_ref() != Some(&authorization.owner_at_authorization) {
                authorization.status = QuoteAuthorizationStatus::InvalidatedOwnership;
            } else if env::block_timestamp()
                >= quote_authorization_deadline(
                    authorization.request_deadline.0,
                    authorization.provider_quote_deadline.0,
                    authorization.provider_inactive_deadline,
                )
            {
                authorization.status = QuoteAuthorizationStatus::Expired;
            }
        }
        Some(authorization)
    }

    /// Returns the currently active authorization for a token, if any.
    pub fn relay_active_quote_authorization(
        &self,
        token_id: TokenId,
    ) -> Option<QuoteAuthorization> {
        let commitment_hash = self.active_quote_commitments.get(&token_id)?;
        self.relay_quote_authorization(token_id, commitment_hash)
    }

    /// Records the current owner's explicit authorization for one exact, signed quote.
    ///
    /// This reserves quote context only. It does not initiate a token transfer or payment.
    #[payable]
    pub fn relay_authorize_quote(
        &mut self,
        token_id: TokenId,
        expected_nonce: U64,
        quote: QuoteAuthorizationInput,
    ) -> PromiseOrValue<QuoteAuthorization> {
        let initial_storage_usage = env::storage_usage();
        let token = self.tokens.nft_token(token_id.clone()).expect("Token not found");
        require!(
            env::predecessor_account_id() == token.owner_id,
            "Only the current token owner can authorize a quote"
        );
        require!(
            self.token_lifecycle(&token_id) == TokenLifecycle::Unlocked,
            "Cannot authorize a quote while the token is locked"
        );
        let binding = self
            .associated_accounts
            .get(&token_id)
            .expect("Associated account not found");
        require!(
            binding.is_verified,
            "Associated sub-account has not completed on-chain verification"
        );
        require!(
            binding.account_id == self.relay_canonical_account_id(&token_id),
            "Associated account binding is not canonical"
        );
        if let Some(payment) = self.payments.get(&token_id) {
            require!(
                payment.token_transfer_status != TokenTransferStatus::Pending
                    && payment.token_transfer_status != TokenTransferStatus::RecoveryRequired
                    && !matches!(
                        payment.checkout_status,
                        Some(CheckoutStatus::CheckoutPending | CheckoutStatus::RecoveryRequired)
                    ),
                "Cannot authorize a quote while a payment is unresolved"
            );
        }

        let now = env::block_timestamp();
        require!(
            quote.request_deadline.0 > now,
            "Quote request deadline must be in the future"
        );
        require!(
            quote.provider_quote_deadline.0 > now,
            "Provider quote deadline must be in the future"
        );
        require!(
            quote
                .provider_inactive_deadline
                .map(|deadline| deadline.0 > now)
                .unwrap_or(true),
            "Provider inactivity deadline must be in the future"
        );
        let is_allowed_pair = (quote.source_asset == "nep141:wrap.near"
            && quote.destination_asset
                == "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near"
            && quote.source_decimals == 24
            && quote.destination_decimals == 18)
            || (quote.source_asset == "nep141:wrap.near"
                && quote.destination_asset
                    == "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
                && quote.source_decimals == 24
                && quote.destination_decimals == 6)
            || (quote.source_asset == "nep141:wrap.near"
                && quote.destination_asset
                    == "nep141:base-0x4200000000000000000000000000000000000006.omft.near"
                && quote.source_decimals == 24
                && quote.destination_decimals == 18);
        require!(
            is_allowed_pair,
            "Quote asset pair is not in the on-chain authorization allowlist"
        );
        require!(
            quote.deposit_type == "ORIGIN_CHAIN",
            "Quote deposit type is not supported"
        );
        require!(quote.source_amount.0 > 0, "Quote source amount must be positive");
        require!(
            quote.expected_output.0 > 0
                && quote.minimum_output.0 > 0
                && quote.minimum_output.0 <= quote.expected_output.0,
            "Quote output amounts are invalid"
        );
        require!(
            quote.refund_address == binding.account_id && quote.refund_type == "ORIGIN_CHAIN",
            "Quote refund policy must return to the canonical account on the origin chain"
        );
        require!(
            quote.deposit_address.len() <= 256
                && !quote.deposit_address.is_empty()
                && !quote.deposit_address.bytes().any(|byte| byte.is_ascii_whitespace()),
            "Quote deposit address is malformed"
        );
        require!(
            quote
                .deposit_memo
                .as_ref()
                .map(|memo| !memo.is_empty() && memo.len() <= 1024)
                .unwrap_or(true),
            "Quote deposit memo is malformed"
        );
        require!(
            quote.recipient.len() == 42
                && quote.recipient.starts_with("0x")
                && quote.recipient[2..].bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Quote recipient must be a 20-byte EVM address"
        );
        let verified_signature_hash = verify_provider_quote(&quote);
        require!(
            quote.provider_signature_hash == verified_signature_hash
                && Self::is_lower_hex_digest(&quote.provider_signature_hash)
                && Self::is_lower_hex_digest(&quote.commitment_hash),
            "Quote hashes must be canonical 32-byte lowercase hex digests"
        );

        if let Some(active_hash) = self.active_quote_commitments.get(&token_id) {
            if let Some(mut active) = self.quote_authorizations.get(&active_hash) {
                if active.status == QuoteAuthorizationStatus::Prepared {
                    if active.owner_at_authorization != token.owner_id {
                        active.status = QuoteAuthorizationStatus::InvalidatedOwnership;
                    } else if now
                        >= quote_authorization_deadline(
                            active.request_deadline.0,
                            active.provider_quote_deadline.0,
                            active.provider_inactive_deadline,
                        )
                    {
                        active.status = QuoteAuthorizationStatus::Expired;
                    } else {
                        env::panic_str("A quote authorization is already active for this token");
                    }
                    self.quote_authorizations.insert(&active_hash, &active);
                }
            }
            self.active_quote_commitments.remove(&token_id);
        }

        let nonce = self.quote_nonces.get(&token_id).unwrap_or(0);
        require!(
            expected_nonce.0 == nonce,
            "Quote authorization nonce is stale"
        );
        require!(
            !self
                .used_provider_signature_hashes
                .get(&quote.provider_signature_hash)
                .unwrap_or(false),
            "Provider quote signature has already been authorized"
        );
        let expected_commitment = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &binding.account_id,
            &token.owner_id,
            nonce,
            &quote,
        );
        require!(
            quote.commitment_hash == expected_commitment,
            "Quote commitment does not match the authorized context"
        );
        let next_nonce = nonce.checked_add(1).expect("Quote nonce overflow");
        let authorization = QuoteAuthorization {
            token_id: token_id.clone(),
            parent_contract_id: env::current_account_id(),
            associated_account_id: binding.account_id,
            owner_at_authorization: token.owner_id.clone(),
            nonce: U64(nonce),
            provider_signature_hash: quote.provider_signature_hash.clone(),
            commitment_hash: quote.commitment_hash.clone(),
            account_binding_verified: true,
            source_asset: quote.source_asset,
            source_decimals: quote.source_decimals,
            deposit_type: quote.deposit_type,
            source_amount: quote.source_amount,
            destination_asset: quote.destination_asset,
            destination_decimals: quote.destination_decimals,
            expected_output: quote.expected_output,
            minimum_output: quote.minimum_output,
            recipient: quote.recipient,
            deposit_address: quote.deposit_address,
            deposit_memo: quote.deposit_memo,
            refund_address: quote.refund_address,
            refund_type: quote.refund_type,
            request_deadline: quote.request_deadline,
            provider_quote_deadline: quote.provider_quote_deadline,
            provider_inactive_deadline: quote.provider_inactive_deadline,
            created_block_height: U64(env::block_height()),
            created_timestamp: U64(now),
            deposit_dispatch_status: DepositDispatchStatus::Disabled,
            status: QuoteAuthorizationStatus::Prepared,
        };
        self.quote_authorizations
            .insert(&authorization.commitment_hash, &authorization);
        self.active_quote_commitments
            .insert(&token_id, &authorization.commitment_hash);
        self.used_provider_signature_hashes
            .insert(&authorization.provider_signature_hash, &true);
        self.quote_nonces.insert(&token_id, &next_nonce);
        let storage_bytes = env::storage_usage().saturating_sub(initial_storage_usage);
        let storage_byte_cost = env::storage_byte_cost().as_yoctonear();
        let required_deposit =
            NearToken::from_yoctonear((storage_bytes as u128).saturating_mul(storage_byte_cost));
        let attached_deposit = env::attached_deposit();
        require!(
            attached_deposit >= required_deposit,
            format!(
                "Insufficient attached deposit for quote authorization storage: required {} yoctoNEAR, attached {} yoctoNEAR",
                required_deposit.as_yoctonear(),
                attached_deposit.as_yoctonear()
            )
        );

        if attached_deposit > required_deposit {
            let had_refund_record = self.unclaimed_refunds.get(&token.owner_id).is_some();
            let current_refund = self
                .unclaimed_refunds
                .get(&token.owner_id)
                .unwrap_or(NearToken::from_near(0));
            if !had_refund_record {
                self.unclaimed_refunds
                    .insert(&token.owner_id, &NearToken::from_near(0));
            }

            let refund_storage_bytes = env::storage_usage().saturating_sub(initial_storage_usage);
            let refund_storage_cost = NearToken::from_yoctonear(
                (refund_storage_bytes as u128).saturating_mul(storage_byte_cost),
            );
            require!(
                attached_deposit > refund_storage_cost,
                "Attached deposit must cover quote storage and leave a positive claimable excess"
            );
            let excess = attached_deposit.saturating_sub(refund_storage_cost);
            let updated_refund = NearToken::from_yoctonear(
                current_refund
                    .as_yoctonear()
                    .checked_add(excess.as_yoctonear())
                    .expect("Quote storage refund balance overflow"),
            );
            self.unclaimed_refunds.insert(&token.owner_id, &updated_refund);
            self.total_refund_liabilities = NearToken::from_yoctonear(
                self.total_refund_liabilities
                    .as_yoctonear()
                    .checked_add(excess.as_yoctonear())
                    .expect("Total refund liability overflow"),
            );
        }
        PromiseOrValue::Value(authorization)
    }

    /// Cancels an authorization. Cancellation does not affect payment or settlement state.
    pub fn relay_cancel_quote_authorization(
        &mut self,
        token_id: TokenId,
        commitment_hash: String,
    ) -> bool {
        let token = self.tokens.nft_token(token_id.clone()).expect("Token not found");
        require!(
            env::predecessor_account_id() == token.owner_id,
            "Only the current token owner can cancel a quote authorization"
        );
        let mut authorization = match self.quote_authorizations.get(&commitment_hash) {
            Some(authorization) if authorization.token_id == token_id => authorization,
            _ => return false,
        };
        if authorization.status != QuoteAuthorizationStatus::Prepared
            || authorization.owner_at_authorization != token.owner_id
        {
            return false;
        }
        authorization.status = QuoteAuthorizationStatus::Cancelled;
        self.quote_authorizations
            .insert(&commitment_hash, &authorization);
        if self.active_quote_commitments.get(&token_id).as_ref() == Some(&commitment_hash) {
            self.active_quote_commitments.remove(&token_id);
        }
        true
    }

    /// Permissionlessly expires an authorization at the earliest bound deadline.
    pub fn relay_expire_quote_authorization(
        &mut self,
        token_id: TokenId,
        commitment_hash: String,
    ) -> bool {
        let mut authorization = match self.quote_authorizations.get(&commitment_hash) {
            Some(authorization) if authorization.token_id == token_id => authorization,
            _ => return false,
        };
        if authorization.status != QuoteAuthorizationStatus::Prepared
            || env::block_timestamp()
                < quote_authorization_deadline(
                    authorization.request_deadline.0,
                    authorization.provider_quote_deadline.0,
                    authorization.provider_inactive_deadline,
                )
        {
            return false;
        }
        authorization.status = QuoteAuthorizationStatus::Expired;
        self.quote_authorizations
            .insert(&commitment_hash, &authorization);
        if self.active_quote_commitments.get(&token_id).as_ref() == Some(&commitment_hash) {
            self.active_quote_commitments.remove(&token_id);
        }
        true
    }

    /// Marks a quote consumed by the current owner. This is not a payment or settlement action.
    pub fn relay_consume_quote_authorization(
        &mut self,
        token_id: TokenId,
        commitment_hash: String,
    ) -> bool {
        let token = self.tokens.nft_token(token_id.clone()).expect("Token not found");
        require!(
            env::predecessor_account_id() == token.owner_id,
            "Only the current token owner can consume a quote authorization"
        );
        let mut authorization = match self.quote_authorizations.get(&commitment_hash) {
            Some(authorization) if authorization.token_id == token_id => authorization,
            _ => return false,
        };
        if authorization.status != QuoteAuthorizationStatus::Prepared
            || authorization.owner_at_authorization != token.owner_id
            || self.quote_nonces.get(&token_id).unwrap_or(0) != authorization.nonce.0 + 1
            || env::block_timestamp()
                >= quote_authorization_deadline(
                    authorization.request_deadline.0,
                    authorization.provider_quote_deadline.0,
                    authorization.provider_inactive_deadline,
                )
            || self.token_lifecycle(&token_id) != TokenLifecycle::Unlocked
        {
            return false;
        }
        authorization.status = QuoteAuthorizationStatus::Consumed;
        self.quote_authorizations
            .insert(&commitment_hash, &authorization);
        if self.active_quote_commitments.get(&token_id).as_ref() == Some(&commitment_hash) {
            self.active_quote_commitments.remove(&token_id);
        }
        true
    }

    fn is_lower_hex_digest(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn invalidate_quote_authorization_on_transfer(&mut self, token_id: &TokenId) {
        self.invalidate_quote_authorization(
            token_id,
            QuoteAuthorizationStatus::InvalidatedOwnership,
        );
    }

    fn invalidate_quote_authorization_for_context_change(&mut self, token_id: &TokenId) {
        self.invalidate_quote_authorization(
            token_id,
            QuoteAuthorizationStatus::InvalidatedContext,
        );
    }

    fn invalidate_quote_authorization(
        &mut self,
        token_id: &TokenId,
        status: QuoteAuthorizationStatus,
    ) {
        if let Some(commitment_hash) = self.active_quote_commitments.get(token_id) {
            if let Some(mut authorization) = self.quote_authorizations.get(&commitment_hash) {
                if authorization.status == QuoteAuthorizationStatus::Prepared {
                    authorization.status = status;
                    self.quote_authorizations
                        .insert(&commitment_hash, &authorization);
                }
            }
            self.active_quote_commitments.remove(token_id);
        }
        let next_nonce = self
            .quote_nonces
            .get(token_id)
            .unwrap_or(0)
            .checked_add(1)
            .expect("Quote nonce overflow");
        self.quote_nonces.insert(token_id, &next_nonce);
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
        require!(
            !matches!(
                &action,
                SubaccountAction::TransferNep141 { .. }
                    | SubaccountAction::TransferNep141Call { .. }
            ),
            "NEP-141 transfers must use relay_start_payment"
        );
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

        self.invalidate_quote_authorization_for_context_change(&token_id);
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
            .with_static_gas(Gas::from_tgas(45))
            .execute(action)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .on_subaccount_executed(token_id, next_nonce, token.owner_id),
            )
    }

    /// Starts a token-bound NEP-141 payment through the associated sub-account.
    ///
    /// Payment actions are deliberately separate from generic sub-account execution
    /// so every transfer has an on-chain nonce, destination policy, and lifecycle lock.
    pub fn relay_start_payment(
        &mut self,
        token_id: TokenId,
        source_ft_contract: AccountId,
        receiver_id: AccountId,
        amount: U128,
        payment_id: String,
        deadline: Option<U64>,
        transfer_call: bool,
        msg: String,
    ) -> Promise {
        let token = self.tokens.nft_token(token_id.clone()).expect("Token not found");
        require!(
            env::predecessor_account_id() == token.owner_id,
            "Only current token owner can start a payment"
        );
        require!(
            self.token_lifecycle(&token_id) == TokenLifecycle::Unlocked,
            "Token is currently locked pending another operation or transfer"
        );
        require!(!payment_id.is_empty(), "Payment identifier cannot be empty");
        require!(
            payment_id.len() <= 128
                && payment_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte)),
            "Payment identifier must be a non-secret reference of at most 128 safe characters"
        );
        require!(amount.0 > 0, "Payment amount must be positive");
        require!(
            deadline
                .map(|timestamp| timestamp.0 > env::block_timestamp())
                .unwrap_or(true),
            "Payment deadline must be in the future"
        );
        require!(
            source_ft_contract != env::current_account_id(),
            "Token contract cannot be the RELAY contract"
        );
        let binding = self
            .associated_accounts
            .get(&token_id)
            .expect("Associated account not found");
        require!(
            binding.is_verified,
            "Associated sub-account has not completed on-chain verification handshake"
        );
        require!(
            source_ft_contract != binding.account_id && receiver_id != binding.account_id,
            "Token contract and receiver must be distinct from the associated account"
        );
        require!(msg.len() <= 1024, "Payment message exceeds 1024 bytes");

        self.invalidate_quote_authorization_for_context_change(&token_id);
        let next_nonce = self.token_nonce(&token_id) + 1;
        self.token_nonces.insert(&token_id, &next_nonce);
        self.token_lifecycles.insert(
            &token_id,
            &TokenLifecycle::LockedForSubaccount {
                nonce: next_nonce,
                initiator: token.owner_id.clone(),
            },
        );
        self.payments.insert(
            &token_id,
            &PaymentRecord {
                token_id: token_id.clone(),
                associated_account_id: binding.account_id.clone(),
                owner_at_dispatch: token.owner_id.clone(),
                source_ft_contract: Some(source_ft_contract.clone()),
                receiver_id: receiver_id.clone(),
                amount,
                nonce: next_nonce,
                payment_id,
                deadline,
                transfer_call,
                resolved_amount_used: None,
                token_transfer_status: TokenTransferStatus::Pending,
                checkout_status: None,
                commitment_hash: None,
            },
        );

        ext_subaccount::ext(binding.account_id)
            .with_static_gas(Gas::from_tgas(75))
            .execute_payment(
                source_ft_contract,
                receiver_id,
                amount,
                transfer_call,
                msg,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_payment_resolved(token_id, next_nonce),
            )
    }

    /// Resolves a payment only when its nonce still matches the pending record.
    #[private]
    pub fn on_payment_resolved(
        &mut self,
        token_id: TokenId,
        expected_nonce: u64,
        #[callback_result] result: Result<PaymentExecutionResult, near_sdk::PromiseError>,
    ) -> bool {
        let mut payment = match self.payments.get(&token_id) {
            Some(payment) => payment,
            None => return false,
        };
        if payment.nonce != expected_nonce
            || payment.token_transfer_status != TokenTransferStatus::Pending
        {
            return false;
        }
        if !matches!(
            self.token_lifecycle(&token_id),
            TokenLifecycle::LockedForSubaccount { nonce, .. } if nonce == expected_nonce
        ) {
            return false;
        }

        let (status, resolved_amount_used) = match result {
            Ok(PaymentExecutionResult::TransferSucceeded) => {
                (TokenTransferStatus::TokenTransferCompleted, Some(payment.amount))
            }
            Ok(PaymentExecutionResult::TransferFailed) => {
                (TokenTransferStatus::TokenTransferFailed, None)
            }
            Ok(PaymentExecutionResult::TransferCallResolved { amount_used })
                if amount_used == payment.amount =>
            {
                (TokenTransferStatus::TokenTransferCompleted, Some(amount_used))
            }
            Ok(PaymentExecutionResult::TransferCallResolved { amount_used })
                if amount_used.0 == 0 =>
            {
                (TokenTransferStatus::TokenTransferRefunded, Some(amount_used))
            }
            Ok(PaymentExecutionResult::TransferCallResolved { amount_used }) => {
                (TokenTransferStatus::TokenTransferPartiallyRefunded, Some(amount_used))
            }
            Ok(PaymentExecutionResult::RecoveryRequired) | Err(_) => {
                (TokenTransferStatus::RecoveryRequired, None)
            }
        };
        payment.token_transfer_status = status.clone();
        payment.resolved_amount_used = resolved_amount_used;
        self.payments.insert(&token_id, &payment);

        let transfer_terminal = status != TokenTransferStatus::RecoveryRequired;
        let checkout_terminal = matches!(
            payment.checkout_status.as_ref(),
            None
                | Some(CheckoutStatus::CheckoutSettled)
                | Some(CheckoutStatus::CheckoutRefunded)
        );
        if transfer_terminal && checkout_terminal {
            self.token_lifecycles
                .insert(&token_id, &TokenLifecycle::Unlocked);
        }
        status == TokenTransferStatus::TokenTransferCompleted
    }

    /// Executes a NEP-141 wrapped-NEAR transfer to a prepared quote deposit address.
    ///
    /// The parameters (recipient, amount, deadlines) are bound to the on-chain QuoteAuthorization
    /// record created during checkout preparation, preventing caller parameter substitution.
    pub fn relay_execute_prepared_payment(
        &mut self,
        token_id: TokenId,
        commitment_hash: String,
    ) -> Promise {
        let token = self.tokens.nft_token(token_id.clone()).expect("Token not found");
        require!(
            env::predecessor_account_id() == token.owner_id,
            "Only current token owner can execute a prepared payment"
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

        let mut authorization = self
            .quote_authorizations
            .get(&commitment_hash)
            .expect("Quote authorization not found");
        require!(
            authorization.token_id == token_id,
            "Quote authorization belongs to different token"
        );
        require!(
            authorization.owner_at_authorization == token.owner_id,
            "Quote authorization belongs to different owner"
        );
        require!(
            authorization.associated_account_id == binding.account_id,
            "Quote authorization belongs to different associated account"
        );
        require!(
            authorization.status == QuoteAuthorizationStatus::Prepared,
            "Quote authorization is not in Prepared status"
        );
        require!(
            authorization.deposit_dispatch_status == DepositDispatchStatus::Disabled,
            "Deposit dispatch is already executed or not eligible"
        );
        require!(
            self.quote_nonces.get(&token_id).unwrap_or(0) == authorization.nonce.0 + 1,
            "Quote authorization is stale for current nonce"
        );
        require!(
            self.active_quote_commitments.get(&token_id).as_ref() == Some(&commitment_hash),
            "Quote authorization is not the active quote commitment"
        );

        let deadline = quote_authorization_deadline(
            authorization.request_deadline.0,
            authorization.provider_quote_deadline.0,
            authorization.provider_inactive_deadline,
        );
        require!(
            env::block_timestamp() < deadline,
            "Quote authorization has expired"
        );

        require!(
            authorization.source_asset == "nep141:wrap.near",
            "Unsupported source asset for wrapped-NEAR transfer"
        );
        require!(
            authorization.source_decimals == 24,
            "Invalid source asset decimals for wrapped-NEAR transfer"
        );
        require!(
            authorization.deposit_type == "ORIGIN_CHAIN",
            "Unsupported deposit type for wrapped-NEAR transfer"
        );

        let receiver_id: AccountId = authorization
            .deposit_address
            .parse()
            .expect("Invalid deposit address in quote authorization");
        require!(
            receiver_id != env::current_account_id() && receiver_id != binding.account_id,
            "Invalid recipient account"
        );

        require!(authorization.source_amount.0 > 0, "Transfer amount must be positive");
        require!(
            cfg!(feature = "sandbox-checkout-dispatch")
                && self.local_sandbox_checkout_dispatch_enabled,
            "Prepared quote dispatch is disabled in this contract build"
        );

        // Mark authorization consumed and dispatched to permanently prevent re-entry / replay
        authorization.status = QuoteAuthorizationStatus::Consumed;
        authorization.deposit_dispatch_status = DepositDispatchStatus::Dispatched;
        self.quote_authorizations
            .insert(&commitment_hash, &authorization);
        self.active_quote_commitments.remove(&token_id);

        let next_nonce = self.token_nonce(&token_id) + 1;
        self.token_nonces.insert(&token_id, &next_nonce);
        self.token_lifecycles.insert(
            &token_id,
            &TokenLifecycle::LockedForSubaccount {
                nonce: next_nonce,
                initiator: token.owner_id.clone(),
            },
        );

        let payment_id = if commitment_hash.len() >= 16 {
            format!("prepared-{}", &commitment_hash[..16])
        } else {
            format!("prepared-{}", commitment_hash)
        };

        self.payments.insert(
            &token_id,
            &PaymentRecord {
                token_id: token_id.clone(),
                associated_account_id: binding.account_id.clone(),
                owner_at_dispatch: token.owner_id.clone(),
                source_ft_contract: Some(prepared_wrapped_near_contract_id()),
                receiver_id: receiver_id.clone(),
                amount: authorization.source_amount,
                nonce: next_nonce,
                payment_id,
                deadline: Some(U64(deadline)),
                transfer_call: false,
                resolved_amount_used: None,
                token_transfer_status: TokenTransferStatus::Pending,
                checkout_status: Some(CheckoutStatus::CheckoutPending),
                commitment_hash: Some(commitment_hash.clone()),
            },
        );

        ext_subaccount::ext(binding.account_id)
            .with_static_gas(Gas::from_tgas(75))
            .execute_nep141_deposit(
                prepared_wrapped_near_contract_id(),
                receiver_id,
                authorization.source_amount,
                authorization.deposit_memo.clone(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_prepared_payment_resolved(token_id, next_nonce, commitment_hash),
            )
    }

    /// Starts a prepared payment. Alias for relay_execute_prepared_payment.
    pub fn relay_start_prepared_payment(
        &mut self,
        token_id: TokenId,
        commitment_hash: String,
    ) -> Promise {
        self.relay_execute_prepared_payment(token_id, commitment_hash)
    }

    /// Resolves a prepared wrapped-NEAR payment callback.
    #[private]
    pub fn on_prepared_payment_resolved(
        &mut self,
        token_id: TokenId,
        expected_nonce: u64,
        commitment_hash: String,
        #[callback_result] result: Result<PaymentExecutionResult, near_sdk::PromiseError>,
    ) -> bool {
        let mut payment = match self.payments.get(&token_id) {
            Some(payment) => payment,
            None => return false,
        };
        if payment.nonce != expected_nonce
            || payment.token_transfer_status != TokenTransferStatus::Pending
            || payment.commitment_hash.as_ref() != Some(&commitment_hash)
        {
            return false;
        }
        if !matches!(
            self.token_lifecycle(&token_id),
            TokenLifecycle::LockedForSubaccount { nonce, .. } if nonce == expected_nonce
        ) {
            return false;
        }

        let (transfer_status, checkout_status, dispatch_status) = match result {
            Ok(PaymentExecutionResult::TransferSucceeded) => (
                TokenTransferStatus::TokenTransferCompleted,
                CheckoutStatus::SourceTransferCompleted,
                DepositDispatchStatus::SourceTransferCompleted,
            ),
            Ok(PaymentExecutionResult::TransferFailed) => (
                TokenTransferStatus::TokenTransferFailed,
                CheckoutStatus::RecoveryRequired,
                DepositDispatchStatus::Dispatched,
            ),
            Ok(PaymentExecutionResult::RecoveryRequired)
            | Ok(PaymentExecutionResult::TransferCallResolved { .. })
            | Err(_) => (
                TokenTransferStatus::RecoveryRequired,
                CheckoutStatus::RecoveryRequired,
                DepositDispatchStatus::Dispatched,
            ),
        };

        payment.token_transfer_status = transfer_status.clone();
        payment.checkout_status = Some(checkout_status);
        self.payments.insert(&token_id, &payment);

        if let Some(mut auth) = self.quote_authorizations.get(&commitment_hash) {
            auth.deposit_dispatch_status = dispatch_status;
            if transfer_status != TokenTransferStatus::TokenTransferCompleted {
                auth.status = QuoteAuthorizationStatus::RecoveryRequired;
            }
            self.quote_authorizations.insert(&commitment_hash, &auth);
        }

        // Token remains locked because CheckoutStatus is SourceTransferCompleted or RecoveryRequired,
        // neither of which is terminal settlement (CheckoutSettled / CheckoutRefunded).
        // Preserves the critical distinction between source transfer and settlement!

        transfer_status == TokenTransferStatus::TokenTransferCompleted
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
        #[callback_result] result: Result<(), near_sdk::PromiseError>,
    ) -> bool {
        if let TokenLifecycle::LockedForSubaccount { nonce, ref initiator } = self.token_lifecycle(&token_id) {
            if nonce == expected_nonce && initiator == &expected_initiator {
                self.token_lifecycles
                    .insert(&token_id, &TokenLifecycle::Unlocked);
            }
        }
        result.is_ok()
    }

    /// Owner-only recovery for a sub-account operation whose callback could not
    /// be processed (for example, a callback that failed to deserialize the
    /// controller result). Unlocks the token; it never moves funds.
    ///
    /// This does not replace the normal callback path. It exists so a trapped
    /// callback cannot permanently brick a token, and it is restricted to the
    /// contract owner because only they can audit the stuck operation.
    pub fn relay_recover_stuck_subaccount(&mut self, token_id: TokenId) {
        require!(
            env::predecessor_account_id() == self.tokens.owner_id,
            "Only the contract owner can recover a stuck sub-account operation"
        );
        match self.token_lifecycle(&token_id) {
            TokenLifecycle::LockedForSubaccount { .. } => {
                self.token_lifecycles
                    .insert(&token_id, &TokenLifecycle::Unlocked);
            }
            _ => env::panic_str("Token is not locked for a sub-account operation"),
        }
    }

    // -----------------------------------------------------------------------
    // Real Associated-Account Provisioning Methods
    // -----------------------------------------------------------------------

    /// Stores the compiled controller WASM binary (`relay_subaccount.wasm`) into contract storage.
    /// Only the contract owner may call this.
    ///
    /// Requires an attached deposit sufficient to cover the exact storage stake increase on the parent contract.
    /// Any excess deposit is refunded back to the contract owner.
    /// Rejects code updates if any provisioning operations are currently in-flight.
    /// Returns the length in bytes of the stored bytecode.
    #[payable]
    pub fn store_controller_code(&mut self, code: Vec<u8>) -> u64 {
        assert_eq!(
            env::predecessor_account_id(),
            self.tokens.owner_id,
            "Only the contract owner can store controller code"
        );
        require!(!code.is_empty(), "Controller code cannot be empty");
        require!(
            self.pending_provisioning_count == 0,
            "Cannot update controller code while provisioning operations are in-flight"
        );

        let initial_storage = env::storage_usage();
        let len = code.len() as u64;
        self.controller_code.set(&code);
        let final_storage = env::storage_usage();

        if final_storage > initial_storage {
            let storage_increase = (final_storage - initial_storage) as u128;
            let required_deposit = NearToken::from_yoctonear(
                storage_increase.saturating_mul(env::storage_byte_cost().as_yoctonear()),
            );
            let attached = env::attached_deposit();
            require!(
                attached >= required_deposit,
                format!(
                    "Insufficient attached deposit for storing controller code: required {} yoctoNEAR, attached {} yoctoNEAR",
                    required_deposit.as_yoctonear(),
                    attached.as_yoctonear()
                )
            );
            let excess = attached.saturating_sub(required_deposit);
            if excess.as_yoctonear() > 0 {
                let _ = Promise::new(env::predecessor_account_id()).transfer(excess);
            }
        } else {
            let attached = env::attached_deposit();
            if attached.as_yoctonear() > 0 {
                let _ = Promise::new(env::predecessor_account_id()).transfer(attached);
            }
        }
        len
    }

    /// Returns the size in bytes of the stored controller contract WASM, if set.
    pub fn get_controller_code_len(&self) -> Option<u64> {
        self.controller_code.get().map(|c| c.len() as u64)
    }

    /// Computes the minimum deposit required to provision a sub-account.
    ///
    /// The required funding covers:
    /// - WASM binary bytecode storage stake on the sub-account (10^19 yoctoNEAR / byte)
    /// - Account creation & base storage overhead (20,000 bytes conservative estimate)
    /// - Minimum spendable native balance reserve (0.05 NEAR estimate)
    pub fn get_provision_minimum_deposit(&self) -> NearToken {
        let wasm_len = self
            .controller_code
            .get()
            .map(|c| c.len() as u128)
            .expect("Subaccount controller WASM code is not stored");

        let storage_byte_cost = env::storage_byte_cost().as_yoctonear();
        // 20,000 bytes is an estimated conservative allowance covering:
        // - Base NEAR account metadata record (~182 bytes)
        // - State trie overhead and key-value records for SubaccountController (~1,000 bytes)
        // - Headroom for future state and receipt records
        let account_overhead_bytes: u128 = 20_000;
        let storage_needed_yocto =
            (wasm_len + account_overhead_bytes).saturating_mul(storage_byte_cost);
        // 0.05 NEAR is an estimated spendable reserve for initial sub-account operations
        let min_spendable_reserve = NearToken::from_millinear(50).as_yoctonear();

        NearToken::from_yoctonear(storage_needed_yocto.saturating_add(min_spendable_reserve))
    }

    /// View the provisioning state of a RELAY token's associated sub-account.
    pub fn relay_provisioning_state(&self, token_id: TokenId) -> ProvisioningState {
        if let Some(state) = self.provisioning_states.get(&token_id) {
            state
        } else if let Some(binding) = self.associated_accounts.get(&token_id) {
            if binding.is_verified {
                ProvisioningState::Completed
            } else {
                ProvisioningState::NotStarted
            }
        } else {
            ProvisioningState::NotStarted
        }
    }

    /// Initiates real on-chain provisioning for the token's canonical sub-account.
    ///
    /// Atomic action receipt creates the child account, transfers the attached deposit,
    /// deploys the stored `relay_subaccount.wasm` bytecode, and initializes it with
    /// `new(parent_contract_id, token_id)`.
    ///
    /// A private callback (`on_provision_complete`) validates the generation nonce,
    /// marks the account verified on success, or unlocks the token and refunds the deposit
    /// to the initiator on failure.
    #[payable]
    pub fn relay_provision_subaccount(&mut self, token_id: TokenId) -> Promise {
        let token = self.tokens.nft_token(token_id.clone()).expect("Token not found");
        require!(
            env::predecessor_account_id() == token.owner_id,
            "Only token owner can provision sub-account"
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
            !binding.is_verified,
            "Associated sub-account is already verified"
        );

        let current_state = self.relay_provisioning_state(token_id.clone());
        require!(
            matches!(current_state, ProvisioningState::NotStarted | ProvisioningState::Failed { .. }),
            "Sub-account provisioning is already in progress or completed"
        );

        let wasm_code = self
            .controller_code
            .get()
            .expect("Subaccount controller WASM code is not stored");

        let min_deposit = self.get_provision_minimum_deposit();
        let attached_deposit = env::attached_deposit();
        require!(
            attached_deposit >= min_deposit,
            format!(
                "Insufficient attached deposit for provisioning: required {} yoctoNEAR, attached {} yoctoNEAR",
                min_deposit.as_yoctonear(),
                attached_deposit.as_yoctonear()
            )
        );

        let canonical_account = self.relay_canonical_account_id(&token_id);
        require!(
            binding.account_id == canonical_account,
            "Binding account ID does not match canonical sub-account ID"
        );

        // Advance monotonic generation nonce and lock token in LockedForProvisioning state
        let next_nonce = self.token_nonce(&token_id) + 1;
        self.token_nonces.insert(&token_id, &next_nonce);
        self.token_lifecycles.insert(
            &token_id,
            &TokenLifecycle::LockedForProvisioning {
                nonce: next_nonce,
                initiator: token.owner_id.clone(),
            },
        );

        // Record provisioning state as Pending and increment in-flight count
        self.provisioning_states.insert(
            &token_id,
            &ProvisioningState::Pending {
                nonce: next_nonce,
                initiator: token.owner_id.clone(),
                deposit: attached_deposit,
            },
        );
        self.pending_provisioning_count += 1;

        let init_args = near_sdk::serde_json::json!({
            "parent_contract_id": env::current_account_id(),
            "token_id": token_id,
        })
        .to_string()
        .into_bytes();

        // Single atomic Action Receipt: create_account + transfer + deploy_contract + function_call
        Promise::new(canonical_account)
            .create_account()
            .transfer(attached_deposit)
            .deploy_contract(wasm_code)
            .function_call(
                "new".to_string(),
                init_args,
                NearToken::from_near(0),
                Gas::from_tgas(30),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(40))
                    .on_provision_complete(token_id, next_nonce, token.owner_id, attached_deposit),
            )
    }

    /// Private callback invoked when the atomic provisioning batch finishes on NEAR runtime.
    ///
    /// Validates the generation nonce and stored pending state.
    /// - On success: transitions to Completed, verifies binding, unlocks token.
    /// - On failure: transitions to Failed (retryable), unlocks token, refunds attached deposit to initiator.
    ///   If the refund transfer fails on the network, the callback catches it and credits unclaimed_refunds.
    /// - Stale / duplicate callbacks are safely ignored without altering newer state.
    #[private]
    pub fn on_provision_complete(
        &mut self,
        token_id: TokenId,
        expected_nonce: u64,
        expected_initiator: AccountId,
        deposit_amount: NearToken,
        #[callback_result] result: Result<(), near_sdk::PromiseError>,
    ) -> bool {
        let current_state = self.relay_provisioning_state(token_id.clone());
        let current_lifecycle = self.token_lifecycle(&token_id);

        let matches_pending = match current_state {
            ProvisioningState::Pending {
                nonce,
                ref initiator,
                deposit,
            }
            | ProvisioningState::RecoveryPending {
                nonce,
                ref initiator,
                deposit,
            } => {
                nonce == expected_nonce
                    && initiator == &expected_initiator
                    && deposit == deposit_amount
            }
            _ => false,
        };

        let matches_lifecycle = match current_lifecycle {
            TokenLifecycle::LockedForProvisioning {
                nonce,
                ref initiator,
            } => nonce == expected_nonce && initiator == &expected_initiator,
            _ => false,
        };

        if !matches_pending || !matches_lifecycle {
            // Stale or duplicate callback! Safely ignore without modifying state.
            return false;
        }

        self.pending_provisioning_count = self.pending_provisioning_count.saturating_sub(1);

        match result {
            Ok(()) => {
                self.provisioning_states
                    .insert(&token_id, &ProvisioningState::Completed);
                if let Some(mut binding) = self.associated_accounts.get(&token_id) {
                    binding.is_verified = true;
                    self.associated_accounts.insert(&token_id, &binding);
                }
                self.token_lifecycles
                    .insert(&token_id, &TokenLifecycle::Unlocked);
                true
            }
            Err(_) => {
                self.provisioning_states.insert(
                    &token_id,
                    &ProvisioningState::Failed {
                        nonce: expected_nonce,
                    },
                );
                self.token_lifecycles
                    .insert(&token_id, &TokenLifecycle::Unlocked);
                if deposit_amount.as_yoctonear() > 0 {
                    let current = self
                        .unclaimed_refunds
                        .get(&expected_initiator)
                        .unwrap_or(NearToken::from_near(0));
                    let updated = NearToken::from_yoctonear(
                        current.as_yoctonear().saturating_add(deposit_amount.as_yoctonear()),
                    );
                    self.unclaimed_refunds.insert(&expected_initiator, &updated);
                    self.total_refund_liabilities = NearToken::from_yoctonear(
                        self.total_refund_liabilities.as_yoctonear().saturating_add(deposit_amount.as_yoctonear()),
                    );
                }
                false
            }
        }
    }

    /// Callback for refund transfer. Kept for manual push transfers or test mocks.
    /// If the refund transfer bounces or fails on NEAR, credits the amount to unclaimed_refunds.
    #[private]
    pub fn on_refund_executed(
        &mut self,
        recipient: AccountId,
        amount: NearToken,
        #[callback_result] result: Result<(), near_sdk::PromiseError>,
    ) -> bool {
        if result.is_err() {
            let current = self
                .unclaimed_refunds
                .get(&recipient)
                .unwrap_or(NearToken::from_near(0));
            let updated = NearToken::from_yoctonear(
                current.as_yoctonear().saturating_add(amount.as_yoctonear()),
            );
            self.unclaimed_refunds.insert(&recipient, &updated);
            self.total_refund_liabilities = NearToken::from_yoctonear(
                self.total_refund_liabilities.as_yoctonear().saturating_add(amount.as_yoctonear()),
            );
            false
        } else {
            true
        }
    }

    /// Returns the current claim nonce for an account.
    pub fn get_claim_nonce(&self, account_id: AccountId) -> u64 {
        self.refund_claim_nonces.get(&account_id).unwrap_or(0)
    }

    /// Returns any unclaimed refund balance credited to an account.
    pub fn get_unclaimed_refund(&self, account_id: AccountId) -> NearToken {
        self.unclaimed_refunds
            .get(&account_id)
            .unwrap_or(NearToken::from_near(0))
    }

    /// Returns the unresolved, liability-reserving refund claim for an account, if any.
    ///
    /// If the transfer callback receipt fails to commit, this record remains a
    /// quarantine. No timeout or missing callback can safely make it claimable again.
    pub fn get_pending_refund_claim(&self, account_id: AccountId) -> Option<ClaimPending> {
        self.pending_refund_claims.get(&account_id)
    }

    /// Returns the total refund liability owed to an account (available + unresolved claim).
    pub fn get_total_refund_liability(&self, account_id: AccountId) -> NearToken {
        let available = self
            .unclaimed_refunds
            .get(&account_id)
            .unwrap_or(NearToken::from_near(0))
            .as_yoctonear();
        let pending = self
            .pending_refund_claims
            .get(&account_id)
            .map(|p| p.amount.as_yoctonear())
            .unwrap_or(0);
        NearToken::from_yoctonear(available.saturating_add(pending))
    }

    /// Returns the global total of outstanding refund liabilities (unclaimed + in-flight pending) across all accounts.
    pub fn get_total_refund_liabilities(&self) -> NearToken {
        self.total_refund_liabilities
    }

    /// Allows an account to withdraw their accumulated unclaimed refunds.
    ///
    /// At-Most-Once Payment Invariant & Balance Backing:
    /// - Asserts no refund claim is currently in-flight for this account (`pending_refund_claims`).
    /// - Requires prepaid gas for the transfer and callback; this cannot prevent a callback receipt failure.
    /// - Asserts that the contract's liquid balance above storage staking requirements is sufficient to disburse the refund.
    /// - Atomically moves the available liability to `ClaimPending` with a monotonic nonce and block height.
    /// - Dispatches a transfer and nonce-bound callback. If the callback receipt itself fails,
    ///   the claim remains quarantined because transfer success cannot be inferred safely.
    pub fn claim_refund(&mut self) -> Promise {
        let caller = env::predecessor_account_id();
        require!(
            self.pending_refund_claims.get(&caller).is_none(),
            "A refund claim is unresolved for this account and cannot be retried safely."
        );
        let amount = self
            .unclaimed_refunds
            .get(&caller)
            .expect("No unclaimed refund available");
        require!(amount.as_yoctonear() > 0, "No unclaimed refund available");

        require!(
            env::prepaid_gas() >= Gas::from_tgas(30),
            "Insufficient prepaid gas attached for refund claim and safe callback execution"
        );

        // Fail-closed liquid balance check: ensure contract holds sufficient liquid balance
        // above required storage staking reserves to cover ALL outstanding refund liabilities
        // (both unclaimed balances across all users and any in-flight pending claims).
        let storage_stake = NearToken::from_yoctonear(
            (env::storage_usage() as u128).saturating_mul(env::storage_byte_cost().as_yoctonear()),
        );
        let account_balance = env::account_balance();
        require!(
            account_balance > storage_stake,
            "Contract has no liquid balance above storage staking requirements"
        );
        let liquid_balance = NearToken::from_yoctonear(
            account_balance.as_yoctonear().saturating_sub(storage_stake.as_yoctonear()),
        );
        require!(
            liquid_balance >= self.total_refund_liabilities,
            format!(
                "Insufficient liquid balance to disburse refund: liquid balance {} yoctoNEAR, total liabilities {} yoctoNEAR",
                liquid_balance.as_yoctonear(),
                self.total_refund_liabilities.as_yoctonear()
            )
        );

        self.unclaimed_refunds.remove(&caller);

        let next_nonce = self.get_claim_nonce(caller.clone()) + 1;
        self.refund_claim_nonces.insert(&caller, &next_nonce);
        self.pending_refund_claims.insert(
            &caller,
            &ClaimPending {
                nonce: next_nonce,
                amount,
                block_height: env::block_height(),
            },
        );

        Promise::new(caller.clone())
            .transfer(amount)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_claim_refund_executed(caller, next_nonce, amount),
            )
    }

    /// Callback for claim_refund transfer.
    ///
    /// This callback can resolve a claim only if the callback receipt itself executes.
    /// No timeout or missing callback is evidence that the underlying transfer failed.
    /// Nonce-isolated settlement:
    /// - Validates that `pending_refund_claims` exists and matches `expected_nonce` and `expected_amount`.
    /// - Stale or duplicate callbacks are safely ignored without altering state.
    /// - On transfer success (`Ok(())`): removes the pending claim; liability is extinguished (exactly 1 payout).
    /// - On transfer failure (`Err(_)`): the runtime returned the funds, so clears the pending claim
    ///   and restores the amount to `unclaimed_refunds`.
    #[private]
    pub fn on_claim_refund_executed(
        &mut self,
        recipient: AccountId,
        expected_nonce: u64,
        expected_amount: NearToken,
        #[callback_result] result: Result<(), near_sdk::PromiseError>,
    ) -> bool {
        let pending = match self.pending_refund_claims.get(&recipient) {
            Some(p) => p,
            None => {
                // Stale or already reconciled callback! Safely ignore without modifying state.
                return false;
            }
        };

        if pending.nonce != expected_nonce || pending.amount != expected_amount {
            // Mismatched nonce or amount: stale callback. Safely ignore.
            return false;
        }

        self.pending_refund_claims.remove(&recipient);

        match result {
            Ok(()) => {
                // Transfer succeeded on NEAR runtime. Liability extinguished.
                // At-most-once payment invariant preserved: exactly 1 payout for this liability.
                self.total_refund_liabilities = NearToken::from_yoctonear(
                    self.total_refund_liabilities.as_yoctonear().saturating_sub(expected_amount.as_yoctonear()),
                );
                true
            }
            Err(_) => {
                // Transfer failed on NEAR runtime (funds returned to contract balance).
                // Safely restore liability back to unclaimed_refunds so user can retry.
                // Total liability remains unchanged.
                let current = self
                    .unclaimed_refunds
                    .get(&recipient)
                    .unwrap_or(NearToken::from_near(0));
                let updated = NearToken::from_yoctonear(
                    current.as_yoctonear().saturating_add(expected_amount.as_yoctonear()),
                );
                self.unclaimed_refunds.insert(&recipient, &updated);
                false
            }
        }
    }

    /// Emergency recovery for stuck provisioning operations.
    /// Can only be called by the contract owner.
    /// Dispatches an active probe cross-contract query to the canonical child account (`get_token_id`)
    /// to determine on-chain reality without guessing or relying on local timeouts.
    /// Idempotent: can be safely re-called if a previous probe or callback never committed.
    pub fn relay_recover_stuck_provisioning(&mut self, token_id: TokenId) -> Promise {
        assert_eq!(
            env::predecessor_account_id(),
            self.tokens.owner_id,
            "Only the contract owner can recover stuck provisioning"
        );
        let current_state = self.relay_provisioning_state(token_id.clone());
        let current_lifecycle = self.token_lifecycle(&token_id);

        let (nonce, initiator, deposit) = match current_state {
            ProvisioningState::Pending { nonce, initiator, deposit }
            | ProvisioningState::RecoveryPending { nonce, initiator, deposit } => {
                if let TokenLifecycle::LockedForProvisioning { nonce: lock_nonce, .. } = current_lifecycle {
                    require!(
                        nonce == lock_nonce,
                        "Pending state and lock nonce mismatch"
                    );
                } else {
                    env::panic_str("Token lifecycle is not LockedForProvisioning");
                }
                self.provisioning_states.insert(
                    &token_id,
                    &ProvisioningState::RecoveryPending { nonce, initiator: initiator.clone(), deposit },
                );
                (nonce, initiator, deposit)
            }
            _ => {
                env::panic_str("Token is not in pending provisioning state");
            }
        };

        let canonical_account = self.relay_canonical_account_id(&token_id);
        ext_subaccount::ext(canonical_account)
            .with_static_gas(Gas::from_tgas(10))
            .get_controller_state()
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_provision_probe_complete(token_id, nonce, initiator, deposit),
            )
    }

    /// Authoritative reconciliation callback invoked by relay_recover_stuck_provisioning.
    /// Probes the canonical sub-account to determine on-chain reality if the primary callback failed.
    /// - If the child account exists and confirms BOTH parent_contract_id and token_id:
    ///   marks Completed, verifies binding, unlocks token, decrements pending count, NO refund.
    /// - If the child account does not exist or has mismatched state (probe fails):
    ///   does NOT authorize a refund or unlock the token, because the original provisioning
    ///   receipt may still be in-flight in a delayed queue. Safe reconciliation is deferred
    ///   to the primary callback which holds custody of any returned funds.
    #[private]
    pub fn on_provision_probe_complete(
        &mut self,
        token_id: TokenId,
        expected_nonce: u64,
        expected_initiator: AccountId,
        deposit_amount: NearToken,
        #[callback_result] result: Result<(AccountId, TokenId), near_sdk::PromiseError>,
    ) -> bool {
        let current_state = self.relay_provisioning_state(token_id.clone());
        let current_lifecycle = self.token_lifecycle(&token_id);

        let matches_pending = match current_state {
            ProvisioningState::RecoveryPending {
                nonce,
                ref initiator,
                deposit,
            } => {
                nonce == expected_nonce
                    && initiator == &expected_initiator
                    && deposit == deposit_amount
            }
            _ => false,
        };

        let matches_lifecycle = match current_lifecycle {
            TokenLifecycle::LockedForProvisioning {
                nonce,
                ref initiator,
            } => nonce == expected_nonce && initiator == &expected_initiator,
            _ => false,
        };

        if !matches_pending || !matches_lifecycle {
            // Already reconciled by primary callback or superseded
            return false;
        }

        match result {
            Ok((parent, ret_token_id))
                if parent == env::current_account_id() && ret_token_id == token_id =>
            {
                self.pending_provisioning_count =
                    self.pending_provisioning_count.saturating_sub(1);
                self.provisioning_states
                    .insert(&token_id, &ProvisioningState::Completed);
                if let Some(mut binding) = self.associated_accounts.get(&token_id) {
                    binding.is_verified = true;
                    self.associated_accounts.insert(&token_id, &binding);
                }
                self.token_lifecycles
                    .insert(&token_id, &TokenLifecycle::Unlocked);
                true
            }
            _ => {
                // A probe failure or unexpected controller state does NOT prove that
                // the original provisioning batch (R1) failed. R1 may still be delayed
                // in cross-shard congestion buffers.
                //
                // Authorizing a refund or unlocking the token here would introduce an unbacked
                // liability and allow double-spend if R1 subsequently executes.
                //
                // Therefore, we DO NOT refund, DO NOT unlock the token, and DO NOT decrement
                // the pending counter. The operation remains in RecoveryPending until the primary
                // callback (C1) arrives to definitively settle the outcome with returned funds.
                false
            }
        }
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
        let previous_owner = self
            .tokens
            .nft_token(token_id.clone())
            .expect("Token not found")
            .owner_id;
        self.tokens
            .nft_transfer(receiver_id, token_id.clone(), approval_id, memo);
        let current_owner = self
            .tokens
            .nft_token(token_id.clone())
            .expect("Token not found")
            .owner_id;
        if current_owner != previous_owner {
            self.invalidate_quote_authorization_on_transfer(&token_id);
        }
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
        if transferred_to_receiver {
            self.invalidate_quote_authorization_on_transfer(&token_id);
        }

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
    use ed25519_dalek::{Signer, SigningKey};

    const MINT_STORAGE_COST: NearToken = NearToken::from_yoctonear(10000000000000000000000u128);

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
    fn test_permissionless_self_mint_and_storage_refund() {
        let mut context = get_context(accounts(1));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(1))
            .build());

        let token_id = "self-mint-1".to_string();
        let canonical_account = contract.relay_canonical_account_id(&token_id);
        let token = contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical_account,
            3,
        );
        assert_eq!(token.owner_id, accounts(1));
        assert_eq!(contract.relay_credits(token_id).unwrap().remaining, 3);
    }

    #[test]
    #[should_panic(expected = "Only the contract owner can mint to another account")]
    fn test_non_owner_cannot_mint_to_another_account() {
        let mut context = get_context(accounts(1));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(1))
            .build());

        let token_id = "gift-1".to_string();
        let canonical_account = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id,
            accounts(2),
            sample_token_metadata(),
            canonical_account,
            3,
        );
    }

    #[test]
    #[should_panic(expected = "reserved for RELAY user accounts")]
    fn test_non_owner_cannot_mint_reserved_u_prefix() {
        let mut context = get_context(accounts(1));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(1))
            .build());

        let token_id = "u-0123456789abcdef".to_string();
        let canonical_account = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id,
            accounts(1),
            sample_token_metadata(),
            canonical_account,
            3,
        );
    }

    #[test]
    #[should_panic(expected = "Insufficient attached deposit for mint storage")]
    fn test_mint_requires_storage_deposit() {
        let mut context = get_context(accounts(1));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(1))
            .build());

        let token_id = "underfunded-1".to_string();
        let canonical_account = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id,
            accounts(1),
            sample_token_metadata(),
            canonical_account,
            3,
        );
    }

    #[test]
    #[should_panic(expected = "Title must contain 1 to 64 bytes")]
    fn test_mint_rejects_oversized_title() {
        let mut context = get_context(accounts(1));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(1))
            .build());

        let mut metadata = sample_token_metadata();
        metadata.title = Some("x".repeat(65));
        let token_id = "big-title-1".to_string();
        let canonical_account = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(token_id, accounts(1), metadata, canonical_account, 3);
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
    fn test_owner_recovers_stuck_subaccount_lock() {
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

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

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

        contract.relay_recover_stuck_subaccount(token_id.clone());
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);

        // Normal owner operations work again after recovery.
        let _ = contract.relay_use_credit(token_id);
    }

    #[test]
    #[should_panic(expected = "Only the contract owner can recover a stuck sub-account operation")]
    fn test_non_owner_cannot_recover_stuck_subaccount_lock() {
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

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

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

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(1))
            .build());
        contract.relay_recover_stuck_subaccount(token_id);
    }

    #[test]
    fn test_on_subaccount_executed_accepts_unit_controller_result() {
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

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

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

        // NEP-141 storage_deposit resolves to JSON `true`; the callback must
        // accept any JSON value rather than assuming a unit result.
        #[allow(deprecated)]
        testing_env_with_promise_results(
            context
                .storage_usage(env::storage_usage())
                .predecessor_account_id(accounts(0))
                .build(),
            PromiseResult::Successful(b"true".to_vec()),
        );
        assert!(contract.on_subaccount_executed(
            token_id.clone(),
            1,
            accounts(0),
            Result::Ok(()),
        ));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
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
        let _ = contract.on_subaccount_executed(token_id.clone(), 1, accounts(0), Result::Ok(()));
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
        let _ = contract.on_subaccount_executed(token_id.clone(), 1, accounts(0), Result::Ok(()));
        assert!(contract.is_token_locked(&token_id));

        // Mismatched initiator callback arrives -> must NOT unlock!
        let _ = contract.on_subaccount_executed(token_id.clone(), 2, accounts(1), Result::Ok(()));
        assert!(contract.is_token_locked(&token_id));

        // Matching nonce 2 and accounts(0) arrives -> unlocks!
        let unlocked = contract.on_subaccount_executed(token_id.clone(), 2, accounts(0), Result::Ok(()));
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
        let _ = contract.on_subaccount_executed(token_id.clone(), 99, accounts(0), Result::Ok(()));
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
        let res1 = contract.on_subaccount_executed(token_id.clone(), 1, accounts(0), Result::Ok(()));
        assert!(res1);
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);

        // Duplicate callback arriving later for the same nonce 1 has NO effect (token is already Unlocked)
        let res2 = contract.on_subaccount_executed(token_id.clone(), 1, accounts(0), Result::Ok(()));
        assert!(res2);
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
    }

    // -----------------------------------------------------------------------
    // Task 7 & Task 8 Provisioning Unit Tests & Adversarial Audit
    // -----------------------------------------------------------------------

    fn sample_controller_wasm() -> Vec<u8> {
        vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
    }

    #[test]
    fn test_valid_provisioning_request_flow() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        // Contract owner stores controller code with attached deposit for storage
        let wasm = sample_controller_wasm();
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        let stored_len = contract.store_controller_code(wasm.clone());
        assert_eq!(stored_len, wasm.len() as u64);
        assert_eq!(contract.get_controller_code_len(), Some(wasm.len() as u64));

        // Mint NFT to accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::NotStarted
        );
        let min_deposit = contract.get_provision_minimum_deposit();
        assert!(min_deposit.as_yoctonear() > 0);

        // Token owner (accounts(1)) provisions sub-account with sufficient deposit
        let provision_deposit = NearToken::from_near(2);
        assert!(provision_deposit >= min_deposit);
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(provision_deposit)
            .predecessor_account_id(accounts(1))
            .build());

        let _promise = contract.relay_provision_subaccount(token_id.clone());

        // Token must be locked in LockedForProvisioning state
        assert!(contract.is_token_locked(&token_id));
        assert_eq!(
            contract.token_lifecycle(&token_id),
            TokenLifecycle::LockedForProvisioning {
                nonce: 1,
                initiator: accounts(1),
            }
        );
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Pending {
                nonce: 1,
                initiator: accounts(1),
                deposit: provision_deposit,
            }
        );

        // Callback arrives with success: Result::Ok(())
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        let ok = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            provision_deposit,
            Ok(()),
        );
        assert!(ok);

        // Subaccount is now verified, state is Completed, and token is Unlocked
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Completed
        );
        let binding = contract.relay_account_binding(token_id.clone()).unwrap();
        assert!(binding.is_verified);
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
        assert!(!contract.is_token_locked(&token_id));
    }

    #[test]
    #[should_panic(expected = "Only token owner can provision sub-account")]
    fn test_unauthorized_provisioning_request() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        // Mint to accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        // accounts(2) (not owner) tries to provision
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(2))
            .build());

        let _ = contract.relay_provision_subaccount(token_id);
    }

    #[test]
    #[should_panic(expected = "Subaccount controller WASM code is not stored")]
    fn test_provision_without_stored_controller_code() {
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

        // Attempt to provision before owner calls store_controller_code
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.relay_provision_subaccount(token_id);
    }

    #[test]
    #[should_panic(expected = "Subaccount controller WASM code is not stored")]
    fn test_cannot_calculate_minimum_deposit_before_storing_code() {
        let context = get_context(accounts(0));
        testing_env!(context.build());
        let contract = Contract::new_default_meta(accounts(0));

        contract.get_provision_minimum_deposit();
    }

    #[test]
    #[should_panic(expected = "Insufficient attached deposit for storing controller code")]
    fn test_store_controller_code_insufficient_deposit() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        // Attached deposit 0 is insufficient for storing code
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(0))
            .build());
        contract.store_controller_code(sample_controller_wasm());
    }

    #[test]
    #[should_panic(expected = "Cannot update controller code while provisioning operations are in-flight")]
    fn test_store_controller_code_blocked_while_provisioning_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

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

        // Start provisioning
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_provision_subaccount(token_id);

        // Owner attempts to update controller code while operation is in-flight -> must panic!
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());
    }

    #[test]
    #[should_panic(expected = "Insufficient attached deposit for provisioning")]
    fn test_provision_insufficient_attached_deposit() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

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

        // Attach 0 deposit (required is > 0)
        testing_env!(context
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());

        let _ = contract.relay_provision_subaccount(token_id);
    }

    #[test]
    #[should_panic(expected = "Token is currently locked pending another operation or transfer")]
    fn test_duplicate_provisioning_request_while_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

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

        // First provisioning call succeeds in dispatching batch
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Duplicate call while still Pending must panic!
        let _ = contract.relay_provision_subaccount(token_id);
    }

    #[test]
    fn test_failed_provisioning_does_not_verify_and_allows_recovery() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        // Mint to accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Provisioning attempt 1
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Pending {
                nonce: 1,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );

        // Callback arrives with failure: PromiseError::Failed
        testing_env!(context
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());
        let res = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!res);

        // Binding must NOT be verified! State transitions to Failed, token is Unlocked
        assert!(!contract.relay_account_binding(token_id.clone()).unwrap().is_verified);
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Failed { nonce: 1 }
        );
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);

        // RECOVERY: Owner can retry provisioning with a new deposit
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Nonce advanced to 2
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Pending {
                nonce: 2,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );
        assert_eq!(
            contract.token_lifecycle(&token_id),
            TokenLifecycle::LockedForProvisioning {
                nonce: 2,
                initiator: accounts(1),
            }
        );

        // Second attempt succeeds
        testing_env!(context
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());
        let ok = contract.on_provision_complete(
            token_id.clone(),
            2,
            accounts(1),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(ok);

        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Completed
        );
        assert!(contract.relay_account_binding(token_id.clone()).unwrap().is_verified);
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
    }

    #[test]
    fn test_stale_or_duplicate_provisioning_callback_ignored() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Attempt 1 -> fails
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());
        let _ = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );

        // Attempt 2 -> pending nonce 2
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Stale success callback for nonce 1 arrives -> must be ignored!
        testing_env!(context
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(accounts(0))
            .build());
        let stale_res = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(!stale_res);

        // State remains Pending with nonce 2!
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Pending {
                nonce: 2,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );
        assert!(contract.is_token_locked(&token_id));

        // Callback with mismatched initiator is also ignored!
        let bad_initiator_res = contract.on_provision_complete(
            token_id.clone(),
            2,
            accounts(2),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(!bad_initiator_res);
        assert!(contract.is_token_locked(&token_id));

        // Legitimate callback for nonce 2 arrives -> succeeds!
        let ok = contract.on_provision_complete(
            token_id.clone(),
            2,
            accounts(1),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(ok);
        assert_eq!(
            contract.relay_provisioning_state(token_id),
            ProvisioningState::Completed
        );
    }

    #[test]
    fn test_refund_executed_failure_credits_unclaimed_refunds_and_allows_claim() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        // Simulate a failed refund transfer callback
        let recipient = accounts(1);
        let refund_amount = NearToken::from_near(2);
        assert_eq!(contract.get_unclaimed_refund(recipient.clone()), NearToken::from_near(0));

        // on_refund_executed with Err: credits unclaimed_refunds
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let recorded = contract.on_refund_executed(
            recipient.clone(),
            refund_amount,
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!recorded);

        // Unclaimed refund is now credited!
        assert_eq!(contract.get_unclaimed_refund(recipient.clone()), refund_amount);

        // User claims their refund
        testing_env!(context
            .predecessor_account_id(recipient.clone())
            .build());
        let _promise = contract.claim_refund();

        // After claiming, balance is 0
        assert_eq!(contract.get_unclaimed_refund(recipient), NearToken::from_near(0));
    }

    #[test]
    fn test_relay_recover_stuck_provisioning_case_a_late_success() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        // Mint to accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Start provisioning (deposit 2 NEAR)
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());
        assert!(contract.is_token_locked(&token_id));
        assert_eq!(contract.pending_provisioning_count, 1);

        // Owner initiates recovery for stuck operation
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_recover_stuck_provisioning(token_id.clone());

        // State is RecoveryPending; token remains locked; NO unbacked refund credited!
        assert!(contract.is_token_locked(&token_id));
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::RecoveryPending {
                nonce: 1,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );
        assert_eq!(
            contract.get_unclaimed_refund(accounts(1)),
            NearToken::from_near(0)
        );
        assert_eq!(contract.pending_provisioning_count, 1);

        // Case A: Delayed receipt SUCCEEDS on NEAR runtime!
        let late_res = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(late_res);

        // Subaccount is verified! State is Completed! Token is Unlocked!
        assert!(!contract.is_token_locked(&token_id));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Completed
        );
        let binding = contract.relay_account_binding(token_id).unwrap();
        assert!(binding.is_verified);

        // CRITICAL INVARIANT: User does NOT receive a refund (no double benefit)
        // Parent contract balance suffers NO unbacked deficit!
        assert_eq!(
            contract.get_unclaimed_refund(accounts(1)),
            NearToken::from_near(0)
        );
        assert_eq!(contract.pending_provisioning_count, 0);
    }

    #[test]
    fn test_relay_recover_stuck_provisioning_case_b_late_failure() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        // Mint to accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Start provisioning (deposit 2 NEAR)
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());
        assert!(contract.is_token_locked(&token_id));

        // Owner initiates recovery
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_recover_stuck_provisioning(token_id.clone());

        // Case B: Delayed receipt FAILS on NEAR runtime!
        let late_res = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!late_res);

        // Token unlocked! State is Failed! Binding remains unverified!
        assert!(!contract.is_token_locked(&token_id));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Failed { nonce: 1 }
        );
        let binding = contract.relay_account_binding(token_id).unwrap();
        assert!(!binding.is_verified);
        assert_eq!(contract.pending_provisioning_count, 0);

        // In the new architecture, on_provision_complete directly and durably credits unclaimed_refunds
        assert_eq!(
            contract.get_unclaimed_refund(accounts(1)),
            NearToken::from_near(2)
        );

        // User can claim their refund
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .build());
        let _claim_promise = contract.claim_refund();
        assert_eq!(
            contract.get_unclaimed_refund(accounts(1)),
            NearToken::from_near(0)
        );
    }

    #[test]
    fn test_relay_recover_stuck_provisioning_duplicate_recovery_is_idempotent() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // First recovery call dispatches probe
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let _p1 = contract.relay_recover_stuck_provisioning(token_id.clone());
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::RecoveryPending {
                nonce: 1,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );

        // Second recovery call on same token in RecoveryPending does NOT panic!
        // It is idempotent and safely re-dispatches the probe:
        let _p2 = contract.relay_recover_stuck_provisioning(token_id.clone());
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::RecoveryPending {
                nonce: 1,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );
        assert!(contract.is_token_locked(&token_id));

        // When the probe callback resolves, it successfully reconciles:
        let probe_res = contract.on_provision_probe_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok((accounts(0), token_id.clone())),
        );
        assert!(probe_res);
        assert_eq!(
            contract.relay_provisioning_state(token_id),
            ProvisioningState::Completed
        );
    }

    #[test]
    #[should_panic(expected = "Token is not in pending provisioning state")]
    fn test_relay_recover_stuck_provisioning_not_pending_panics() {
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
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Attempting recovery on NotStarted token must panic
        let _ = contract.relay_recover_stuck_provisioning(token_id);
    }

    #[test]
    #[should_panic(expected = "Only the contract owner can recover stuck provisioning")]
    fn test_relay_recover_stuck_provisioning_unauthorized_panics() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Attacker attempts recovery
        testing_env!(context
            .predecessor_account_id(accounts(2))
            .build());
        let _ = contract.relay_recover_stuck_provisioning(token_id);
    }

    #[test]
    fn test_stale_callback_during_recovery_pending_ignored() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_recover_stuck_provisioning(token_id.clone());

        // Callback with invalid nonce (e.g. 99)
        let stale_res = contract.on_provision_complete(
            token_id.clone(),
            99,
            accounts(1),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(!stale_res);

        // State remains RecoveryPending, token locked, count intact
        assert!(contract.is_token_locked(&token_id));
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::RecoveryPending {
                nonce: 1,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );
        assert_eq!(contract.pending_provisioning_count, 1);
    }

    #[test]
    fn test_claim_refund_failure_and_retry_restores_balance() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund_amount = NearToken::from_near(3);

        // Credit 3 NEAR to user's unclaimed refunds
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.on_refund_executed(
            user.clone(),
            refund_amount,
            Err(near_sdk::PromiseError::Failed),
        );
        assert_eq!(contract.get_unclaimed_refund(user.clone()), refund_amount);

        // User initiates claim_refund
        testing_env!(context
            .predecessor_account_id(user.clone())
            .build());
        let _promise = contract.claim_refund();
        // Balance removed pending transfer
        assert_eq!(contract.get_unclaimed_refund(user.clone()), NearToken::from_near(0));

        // Transfer fails on NEAR: on_claim_refund_executed callback receives Err
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let restored = contract.on_claim_refund_executed(
            user.clone(),
            1,
            refund_amount,
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!restored);

        // User balance is RESTORED! No funds lost!
        assert_eq!(contract.get_unclaimed_refund(user.clone()), refund_amount);
        assert_eq!(contract.get_pending_refund_claim(user.clone()), None);

        // User retries claim_refund
        testing_env!(context
            .predecessor_account_id(user.clone())
            .build());
        let _retry_promise = contract.claim_refund();
        assert_eq!(contract.get_unclaimed_refund(user.clone()), NearToken::from_near(0));
        assert!(contract.get_pending_refund_claim(user.clone()).is_some());
        assert_eq!(contract.get_claim_nonce(user.clone()), 2);

        // This time transfer succeeds on NEAR
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let success = contract.on_claim_refund_executed(
            user.clone(),
            2,
            refund_amount,
            Ok(()),
        );
        assert!(success);
        assert_eq!(contract.get_unclaimed_refund(user.clone()), NearToken::from_near(0));
        assert_eq!(contract.get_pending_refund_claim(user), None);
    }

    #[test]
    fn test_pending_provisioning_count_integrity_across_interleaved_ops() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        // Mint token-1, token-2, token-3
        for i in 1..=3 {
            testing_env!(context
                .storage_usage(env::storage_usage())
                .attached_deposit(MINT_STORAGE_COST)
                .predecessor_account_id(accounts(0))
                .build());
            let token_id = format!("relay-{}", i);
            let canonical = contract.relay_canonical_account_id(&token_id);
            contract.relay_mint(
                token_id,
                accounts(i),
                sample_token_metadata(),
                canonical,
                3,
            );
        }

        // Start provisioning for all 3 tokens
        for i in 1..=3 {
            testing_env!(context
                .attached_deposit(NearToken::from_near(2))
                .predecessor_account_id(accounts(i))
                .build());
            let _ = contract.relay_provision_subaccount(format!("relay-{}", i));
        }
        assert_eq!(contract.pending_provisioning_count, 3);

        // Recover token-1: count remains 3 (still in flight)
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_recover_stuck_provisioning("relay-1".to_string());
        assert_eq!(contract.pending_provisioning_count, 3);

        // Token-2 resolves successfully: count decrements to 2
        let ok2 = contract.on_provision_complete(
            "relay-2".to_string(),
            1,
            accounts(2),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(ok2);
        assert_eq!(contract.pending_provisioning_count, 2);

        // Token-1 resolves late successfully (Case A): count decrements to 1
        let ok1 = contract.on_provision_complete(
            "relay-1".to_string(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(ok1);
        assert_eq!(contract.pending_provisioning_count, 1);

        // Token-3 resolves with failure: count decrements to 0
        let fail3 = contract.on_provision_complete(
            "relay-3".to_string(),
            1,
            accounts(3),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!fail3);
        assert_eq!(contract.pending_provisioning_count, 0);

        // Duplicate or stale callbacks do NOT decrement or underflow count!
        let stale = contract.on_provision_complete(
            "relay-1".to_string(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(!stale);
        assert_eq!(contract.pending_provisioning_count, 0);
    }

    #[test]
    fn test_old_callback_cannot_unlock_newer_reprovisioning() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Attempt 1: Start provisioning (nonce 1)
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Attempt 1 fails: on_provision_complete(..., Err)
        let _ = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        assert_eq!(contract.relay_provisioning_state(token_id.clone()), ProvisioningState::Failed { nonce: 1 });
        assert!(!contract.is_token_locked(&token_id));

        // Attempt 2: User reprovisions token (nonce 2)
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Pending {
                nonce: 2,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );
        assert!(contract.is_token_locked(&token_id));

        // Stale callback from attempt 1 arrives late with Ok(())
        let stale_res = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(!stale_res);

        // State is NOT unlocked and remains Pending { nonce: 2 }!
        assert!(contract.is_token_locked(&token_id));
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Pending {
                nonce: 2,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );

        // Real callback for attempt 2 arrives with Ok(())
        let real_res = contract.on_provision_complete(
            token_id.clone(),
            2,
            accounts(1),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(real_res);
        assert_eq!(contract.relay_provisioning_state(token_id), ProvisioningState::Completed);
    }

    #[test]
    #[should_panic(expected = "Cannot verify associated account while token is locked pending an operation or transfer")]
    fn test_verify_associated_account_blocked_while_provisioning_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

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

        // Start provisioning -> token is locked in LockedForProvisioning
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // An out-of-order relay_verify_associated_account call from canonical must be blocked!
        testing_env!(context
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id);
    }

    #[test]
    #[should_panic(expected = "Cannot transfer token while an operation or transfer is pending")]
    fn test_ownership_transfer_blocked_while_provisioning_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

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

        // Start provisioning
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());
        assert!(contract.is_token_locked(&token_id));

        // Direct nft_transfer must be blocked!
        testing_env!(context
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());
        contract.nft_transfer(accounts(1), token_id, None, None);
    }

    #[test]
    #[should_panic(expected = "Cannot transfer token while an operation or transfer is pending")]
    fn test_transfer_call_blocked_while_provisioning_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

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

        // Start provisioning
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // nft_transfer_call must be blocked!
        testing_env!(context
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.nft_transfer_call(accounts(1), token_id, None, None, "msg".to_string());
    }

    #[test]
    #[should_panic(expected = "Cannot use credits while token is locked pending an operation or transfer")]
    fn test_credit_use_blocked_while_provisioning_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

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

        // Start provisioning
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Attempt to consume credit while provisioning is pending
        contract.relay_use_credit(token_id);
    }

    #[test]
    #[should_panic(expected = "Associated sub-account is already verified")]
    fn test_cannot_provision_already_verified_subaccount() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

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

        // Verification handshake completes
        testing_env!(context
            .attached_deposit(NearToken::from_near(0))
            .predecessor_account_id(canonical)
            .build());
        contract.relay_verify_associated_account(token_id.clone());

        // Attempting to provision an already verified account must panic
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_provision_subaccount(token_id);
    }

    #[test]
    fn test_recovery_probe_reconciles_when_primary_callback_never_completes_case_a() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        // Mint to accounts(1)
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        // Start provisioning (deposit 2 NEAR)
        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());
        assert!(contract.is_token_locked(&token_id));
        assert_eq!(contract.pending_provisioning_count, 1);

        // SCENARIO: on_provision_complete ran out of gas or never committed!
        // The token is stuck in Pending. Owner initiates emergency recovery:
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let _promise = contract.relay_recover_stuck_provisioning(token_id.clone());

        // State is RecoveryPending; active probe has been dispatched
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::RecoveryPending {
                nonce: 1,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );
        assert_eq!(contract.pending_provisioning_count, 1);

        // Probe callback on_provision_probe_complete arrives:
        // Child account exists and returns Ok((accounts(0), "relay-1"))!
        let probe_res = contract.on_provision_probe_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok((accounts(0), token_id.clone())),
        );
        assert!(probe_res);

        // Token is unlocked, binding is verified, state is Completed!
        assert!(!contract.is_token_locked(&token_id));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Completed
        );
        assert!(contract.relay_account_binding(token_id).unwrap().is_verified);

        // Zero unbacked refund credited (NO double benefit)
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(0));
        assert_eq!(contract.pending_provisioning_count, 0);
    }

    #[test]
    fn test_recovery_probe_reconciles_when_primary_callback_never_completes_case_b() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Primary callback never committed. Owner initiates recovery:
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let _promise = contract.relay_recover_stuck_provisioning(token_id.clone());

        // Probe callback arrives: child account does NOT exist (PromiseError::Failed)
        let probe_res = contract.on_provision_probe_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!probe_res);

        // Under Task 12 architecture: probe failure DOES NOT unlock token and DOES NOT refund deposit!
        // The token remains locked in RecoveryPending:
        assert!(contract.is_token_locked(&token_id));
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::RecoveryPending {
                nonce: 1,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(0));
        assert_eq!(contract.pending_provisioning_count, 1);

        // When the primary callback arrives with Err (the runtime carries the refunded tokens):
        let callback_res = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!callback_res);

        // NOW the operation is definitively failed: token unlocked, deposit credited to unclaimed_refunds!
        assert!(!contract.is_token_locked(&token_id));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Failed { nonce: 1 }
        );
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(2));
        assert_eq!(contract.pending_provisioning_count, 0);

        // User claims their refund
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .build());
        let _claim_promise = contract.claim_refund();
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(0));
    }

    #[test]
    fn test_recovery_probe_rejects_foreign_parent_controller() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical.clone(),
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Primary callback never committed. Owner initiates recovery:
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let _promise = contract.relay_recover_stuck_provisioning(token_id.clone());

        // Adversarial probe callback arrives: child account exists and returns token_id,
        // BUT parent controller is a rogue foreign contract accounts(5), NOT accounts(0)!
        let probe_res = contract.on_provision_probe_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok((accounts(5), token_id.clone())),
        );
        assert!(!probe_res);

        // Verification must be rejected: subaccount NOT bound, token remains locked, NO premature refund!
        assert!(contract.is_token_locked(&token_id));
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::RecoveryPending {
                nonce: 1,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );
        assert!(!contract.relay_account_binding(token_id.clone()).map(|b| b.is_verified).unwrap_or(false));
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(0));
        assert_eq!(contract.pending_provisioning_count, 1);
    }

    #[test]
    fn test_delayed_provisioning_receipt_succeeds_after_failed_probe_prevents_double_benefit() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Probe executes while R1 is delayed in cross-shard queue (account does not exist yet):
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let _promise = contract.relay_recover_stuck_provisioning(token_id.clone());
        let probe_res = contract.on_provision_probe_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!probe_res);

        // CRITICAL CHECK: User has NOT been credited a refund, token is NOT unlocked:
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(0));
        assert!(contract.is_token_locked(&token_id));

        // Now, the delayed provisioning receipt R1 completes on-chain and C1 arrives with Ok(()):
        let callback_res = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok(()),
        );
        assert!(callback_res);

        // Subaccount is completed, verified, token is unlocked, AND REFUND REMAINS ZERO!
        assert_eq!(contract.relay_provisioning_state(token_id.clone()), ProvisioningState::Completed);
        assert!(contract.relay_account_binding(token_id.clone()).map(|b| b.is_verified).unwrap_or(false));
        assert!(!contract.is_token_locked(&token_id));
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(0));
        assert_eq!(contract.pending_provisioning_count, 0);
    }

    #[test]
    fn test_duplicate_callback_and_probe_reconciliation_attempts() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_recover_stuck_provisioning(token_id.clone());

        // Probe reconciles first:
        let probe_res = contract.on_provision_probe_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok((accounts(0), token_id.clone())),
        );
        assert!(probe_res);
        assert_eq!(contract.relay_provisioning_state(token_id.clone()), ProvisioningState::Completed);

        // Delayed primary callback on_provision_complete arrives later:
        let late_primary = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok(()),
        );
        // Safely ignored! Does not alter state or decrement count again!
        assert!(!late_primary);
        assert_eq!(contract.relay_provisioning_state(token_id.clone()), ProvisioningState::Completed);
        assert_eq!(contract.pending_provisioning_count, 0);

        // Duplicate probe arriving later is also safely ignored:
        let dup_probe = contract.on_provision_probe_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok((accounts(0), token_id.clone())),
        );
        assert!(!dup_probe);
        assert_eq!(contract.pending_provisioning_count, 0);
    }

    #[test]
    fn test_direct_failure_credit_eliminates_push_refund_drop() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Primary callback executes with Err:
        let fail_res = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!fail_res);

        // In the new architecture, unclaimed_refunds is credited directly and durably in storage!
        // No push transfer or secondary callback can drop this refund!
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(2));
        assert_eq!(contract.pending_provisioning_count, 0);
    }

    #[test]
    #[should_panic(expected = "A refund claim is unresolved for this account")]
    fn test_duplicate_claim_refund_blocked_while_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund_amount = NearToken::from_near(3);

        // Credit refund to user
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(
            user.clone(),
            refund_amount,
            Err(near_sdk::PromiseError::Failed),
        );
        assert_eq!(contract.get_unclaimed_refund(user.clone()), refund_amount);

        // User initiates claim_refund
        testing_env!(context.predecessor_account_id(user.clone()).build());
        let _promise = contract.claim_refund();
        assert!(contract.get_pending_refund_claim(user.clone()).is_some());

        // Concurrent or duplicate claim_refund attempt must panic immediately!
        let _ = contract.claim_refund();
    }

    #[test]
    #[should_panic(expected = "Insufficient prepaid gas attached for refund claim")]
    fn test_claim_refund_insufficient_gas_blocked() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund_amount = NearToken::from_near(3);

        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(
            user.clone(),
            refund_amount,
            Err(near_sdk::PromiseError::Failed),
        );

        // User attempts claim with only 20 TGas attached (< 30 TGas requirement)
        testing_env!(context
            .predecessor_account_id(user)
            .prepaid_gas(Gas::from_tgas(20))
            .build());
        let _ = contract.claim_refund();
    }

    #[test]
    fn test_claim_refund_stale_or_mismatched_nonce_ignored() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund_amount = NearToken::from_near(3);

        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(
            user.clone(),
            refund_amount,
            Err(near_sdk::PromiseError::Failed),
        );

        // User claims refund (nonce 1)
        testing_env!(context.predecessor_account_id(user.clone()).build());
        let _ = contract.claim_refund();
        assert_eq!(contract.get_claim_nonce(user.clone()), 1);

        // Mismatched nonce callback arrives (e.g. nonce 99)
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let stale_ok = contract.on_claim_refund_executed(
            user.clone(),
            99,
            refund_amount,
            Ok(()),
        );
        assert!(!stale_ok);

        // Claim remains in pending_refund_claims; total liability intact
        assert!(contract.get_pending_refund_claim(user.clone()).is_some());
        assert_eq!(contract.get_total_refund_liability(user.clone()), refund_amount);

        // Mismatched amount callback also safely ignored
        let stale_err = contract.on_claim_refund_executed(
            user.clone(),
            1,
            NearToken::from_near(999),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!stale_err);
        assert!(contract.get_pending_refund_claim(user.clone()).is_some());
    }

    #[test]
    fn test_unresolved_claim_remains_pending_and_blocks_retries() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund_amount = NearToken::from_near(2);

        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(
            user.clone(),
            refund_amount,
            Err(near_sdk::PromiseError::Failed),
        );

        // User initiates claim_refund
        testing_env!(context.predecessor_account_id(user.clone()).build());
        let _ = contract.claim_refund();

        // SCENARIO: Transfer is dispatched, but callback does not commit.
        // Under fail-closed design without unsafe manual resolution:
        // The claim remains in ClaimPending indefinitely.
        assert_eq!(
            contract.get_pending_refund_claim(user.clone()),
            Some(ClaimPending {
                nonce: 1,
                amount: refund_amount,
                block_height: 0,
            })
        );
        assert_eq!(contract.get_unclaimed_refund(user.clone()), NearToken::from_near(0));

        // Retrying claim_refund is strictly blocked (fail-closed, prevents duplicate transfer)
        let retry_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c = contract;
            let _ = c.claim_refund();
        }));
        assert!(retry_result.is_err(), "Must block re-claim while previous claim is pending");
    }

    #[test]
    fn test_claim_refund_fails_closed_when_liquid_balance_insufficient() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund_amount = NearToken::from_near(10);

        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(
            user.clone(),
            refund_amount,
            Err(near_sdk::PromiseError::Failed),
        );

        // Set account balance lower than required liquid balance + storage stake
        let storage_stake = NearToken::from_yoctonear(env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear());
        // Set account balance such that liquid balance is less than refund_amount (e.g. storage_stake + 5 NEAR)
        let inadequate_balance = storage_stake.saturating_add(NearToken::from_near(5));
        testing_env!(context
            .predecessor_account_id(user.clone())
            .account_balance(inadequate_balance)
            .build());

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c = contract;
            let _ = c.claim_refund();
        }));
        assert!(result.is_err(), "Must panic when liquid balance above storage stake is insufficient");
    }

    #[test]
    fn test_negative_probe_leaves_provisioning_stuck_in_recovery_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Primary callback never commits. Owner initiates recovery probe:
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.relay_recover_stuck_provisioning(token_id.clone());

        // Probe callback arrives with Err (subaccount does not exist or call failed)
        let probe_res = contract.on_provision_probe_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!probe_res);

        // FAIL-CLOSED INVARIANT:
        // Probe failure leaves token locked in RecoveryPending indefinitely.
        // No manual override can unlock it or restore a refund.
        assert!(contract.is_token_locked(&token_id));
        assert_eq!(contract.pending_provisioning_count, 1);
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::RecoveryPending {
                nonce: 1,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(0));
    }

    #[test]
    fn test_positive_probe_completes_and_unlocks_without_refund() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Primary callback never commits. Owner initiates probe:
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.relay_recover_stuck_provisioning(token_id.clone());

        // Probe callback succeeds with matching controller state (parent, token_id)
        let probe_res = contract.on_provision_probe_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok((accounts(0), token_id.clone())),
        );
        assert!(probe_res);

        // Token unlocked, state Completed, binding verified, NO refund credited!
        assert!(!contract.is_token_locked(&token_id));
        assert_eq!(contract.token_lifecycle(&token_id), TokenLifecycle::Unlocked);
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::Completed
        );
        assert!(contract.relay_account_binding(token_id.clone()).unwrap().is_verified);
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(0));
        assert_eq!(contract.pending_provisioning_count, 0);
    }

    #[test]
    fn test_stale_provisioning_callback_after_completed_probe_ignored() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Probe recovers and completes provisioning
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.relay_recover_stuck_provisioning(token_id.clone());
        let _ = contract.on_provision_probe_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Ok((accounts(0), token_id.clone())),
        );
        assert_eq!(contract.relay_provisioning_state(token_id.clone()), ProvisioningState::Completed);

        // Now, a delayed primary callback from attempt 1 arrives with Err (failure)
        let late_err = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        // Stale callback MUST be rejected; must not flip state to Failed or credit refund!
        assert!(!late_err);
        assert_eq!(contract.relay_provisioning_state(token_id.clone()), ProvisioningState::Completed);
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(0));
        assert_eq!(contract.pending_provisioning_count, 0);
    }

    #[test]
    fn test_total_refund_liabilities_accounting() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund_amount = NearToken::from_near(3);

        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(0));

        // When a refund is credited (e.g. provisioning failure or refund execution failure)
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(
            user.clone(),
            refund_amount,
            Err(near_sdk::PromiseError::Failed),
        );
        assert_eq!(contract.get_total_refund_liabilities(), refund_amount);

        // User claims refund
        testing_env!(context.predecessor_account_id(user.clone()).build());
        let _ = contract.claim_refund();
        // While claim is pending, total liabilities remain unchanged
        assert_eq!(contract.get_total_refund_liabilities(), refund_amount);

        // Transfer callback succeeds
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_claim_refund_executed(
            user.clone(),
            1,
            refund_amount,
            Ok(()),
        );
        // Total liabilities are decremented to 0
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(0));
    }

    #[test]
    fn test_invariant_at_most_once_payout_enforced_by_nonce_and_pending_claim() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund_amount = NearToken::from_near(5);

        // Fund user's unclaimed refund
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(
            user.clone(),
            refund_amount,
            Err(near_sdk::PromiseError::Failed),
        );
        assert_eq!(contract.get_total_refund_liability(user.clone()), refund_amount);

        // User initiates claim (nonce 1)
        testing_env!(context.predecessor_account_id(user.clone()).build());
        let _ = contract.claim_refund();
        assert_eq!(contract.get_total_refund_liability(user.clone()), refund_amount);
        assert_eq!(contract.get_unclaimed_refund(user.clone()), NearToken::from_near(0));
        assert!(contract.get_pending_refund_claim(user.clone()).is_some());

        // Transfer succeeds and callback commits
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let callback_res = contract.on_claim_refund_executed(
            user.clone(),
            1,
            refund_amount,
            Ok(()),
        );
        assert!(callback_res);

        // Liability is extinguished: both pending and unclaimed are zero
        assert_eq!(contract.get_total_refund_liability(user.clone()), NearToken::from_near(0));
        assert_eq!(contract.get_pending_refund_claim(user.clone()), None);

        // A second claim is blocked because unclaimed refund is zero
        testing_env!(context.predecessor_account_id(user.clone()).build());
        let re_claim_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c = contract;
            let _ = c.claim_refund();
        }));
        assert!(re_claim_result.is_err(), "Must reject re-claim when liability is 0");
    }

    #[test]
    fn test_invariant_negative_probe_never_authorizes_refund_or_unlocks() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Initiate probe recovery
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.relay_recover_stuck_provisioning(token_id.clone());

        // Negative probe (e.g. subaccount doesn't exist yet or timeout)
        let probe_failed = contract.on_provision_probe_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!probe_failed);

        // INVARIANT CHECK: Probe failure must NOT unlock and must NOT refund
        assert!(contract.is_token_locked(&token_id));
        assert_eq!(
            contract.token_lifecycle(&token_id),
            TokenLifecycle::LockedForProvisioning { nonce: 1, initiator: accounts(1) }
        );
        assert_eq!(
            contract.relay_provisioning_state(token_id.clone()),
            ProvisioningState::RecoveryPending {
                nonce: 1,
                initiator: accounts(1),
                deposit: NearToken::from_near(2),
            }
        );
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(0));
        assert_eq!(contract.pending_provisioning_count, 1);
    }

    #[test]
    fn test_task17_competing_refunds_fail_closed_if_total_liabilities_exceed_liquid() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user1 = accounts(1);
        let user2 = accounts(2);
        let refund1 = NearToken::from_near(5);
        let refund2 = NearToken::from_near(5);

        // Credit refund to user1 (5 NEAR) and user2 (5 NEAR). Total liabilities = 10 NEAR.
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(user1.clone(), refund1, Err(near_sdk::PromiseError::Failed));
        let _ = contract.on_refund_executed(user2.clone(), refund2, Err(near_sdk::PromiseError::Failed));
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(10));

        // Suppose contract has storage stake + 8 NEAR liquid balance.
        // User1 asks for 5 NEAR. If contract only checked 8 >= 5, user1 could drain, leaving user2 stranded with only 3 NEAR.
        // But our enforced invariant requires liquid_balance >= total_refund_liabilities (10 NEAR).
        let storage_stake = NearToken::from_yoctonear(env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear());
        let liquid_balance_8_near = storage_stake.saturating_add(NearToken::from_near(8));

        testing_env!(context.predecessor_account_id(user1.clone()).account_balance(liquid_balance_8_near).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c = contract;
            let _ = c.claim_refund();
        }));
        assert!(result.is_err(), "Must block claim if liquid balance does not cover TOTAL outstanding liabilities");
    }

    #[test]
    fn test_task17_competing_refunds_succeed_when_fully_solvent() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user1 = accounts(1);
        let user2 = accounts(2);
        let refund1 = NearToken::from_near(5);
        let refund2 = NearToken::from_near(5);

        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(user1.clone(), refund1, Err(near_sdk::PromiseError::Failed));
        let _ = contract.on_refund_executed(user2.clone(), refund2, Err(near_sdk::PromiseError::Failed));
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(10));

        // Contract has storage stake + 10 NEAR liquid balance (fully solvent)
        let storage_stake = NearToken::from_yoctonear(env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear());
        let solvent_balance = storage_stake.saturating_add(NearToken::from_near(10));

        testing_env!(context.predecessor_account_id(user1.clone()).account_balance(solvent_balance).build());
        let _ = contract.claim_refund();
        assert_eq!(contract.get_unclaimed_refund(user1.clone()), NearToken::from_near(0));
        assert!(contract.get_pending_refund_claim(user1.clone()).is_some());
    }

    #[test]
    fn test_task17_storage_growth_reduces_liquid_balance_and_fails_closed() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund = NearToken::from_near(5);

        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(user.clone(), refund, Err(near_sdk::PromiseError::Failed));
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(5));

        // Fixed total account balance of 10 NEAR
        let fixed_account_balance = NearToken::from_near(10);

        // Scenario A: low storage usage (e.g. 100 bytes = 0.001 NEAR stake) -> liquid balance ~ 9.999 NEAR >= 5 NEAR
        testing_env!(context
            .predecessor_account_id(user.clone())
            .storage_usage(100)
            .account_balance(fixed_account_balance)
            .build());
        // Can claim safely
        let _ = contract.claim_refund();

        // Callback resolves
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_claim_refund_executed(user.clone(), 1, refund, Ok(()));
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(0));

        // Scenario B: credit again, but storage grows heavily to 800,000 bytes (~8 NEAR stake)
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(user.clone(), refund, Err(near_sdk::PromiseError::Failed));
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(5));

        // 800,000 bytes * 10^19 yoctoNEAR = 8 * 10^24 yoctoNEAR = 8 NEAR stake.
        // Out of 10 NEAR fixed balance, liquid balance is only 2 NEAR (< 5 NEAR liability).
        testing_env!(context
            .predecessor_account_id(user.clone())
            .storage_usage(800_000)
            .account_balance(fixed_account_balance)
            .build());

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c = contract;
            let _ = c.claim_refund();
        }));
        assert!(result.is_err(), "Storage growth eating liquid reserves must cause claim_refund to fail closed");
    }

    #[test]
    fn test_task17_on_provision_complete_failure_records_refund_liability() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            accounts(1),
            sample_token_metadata(),
            canonical,
            3,
        );

        testing_env!(context
            .attached_deposit(NearToken::from_near(2))
            .predecessor_account_id(accounts(1))
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // on_provision_complete callback executes with Err (e.g. create_account failed or out-of-gas)
        let complete_res = contract.on_provision_complete(
            token_id.clone(),
            1,
            accounts(1),
            NearToken::from_near(2),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!complete_res);

        // Verify that liability was recorded
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(2));
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), NearToken::from_near(2));
    }

    // =========================================================================
    // TASK 18 ADVERSARIAL TESTS: PENDING REFUNDS AND EVERY NEAR OUTFLOW
    // =========================================================================

    #[test]
    fn test_task18_multiple_claimants_multiple_claims_pending_liability_conservation() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user1 = accounts(1);
        let user2 = accounts(2);
        let user3 = accounts(3);

        // Credit 3 separate users with 2 NEAR each. Total liabilities = 6 NEAR.
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(user1.clone(), NearToken::from_near(2), Err(near_sdk::PromiseError::Failed));
        let _ = contract.on_refund_executed(user2.clone(), NearToken::from_near(2), Err(near_sdk::PromiseError::Failed));
        let _ = contract.on_refund_executed(user3.clone(), NearToken::from_near(2), Err(near_sdk::PromiseError::Failed));

        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(6));

        // Contract has 10 NEAR liquid balance above storage stake
        let storage_stake = NearToken::from_yoctonear(env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear());
        let liquid_balance_10_near = storage_stake.saturating_add(NearToken::from_near(10));

        // User 1 claims refund -> moves to ClaimPending
        testing_env!(context.predecessor_account_id(user1.clone()).account_balance(liquid_balance_10_near).build());
        let _ = contract.claim_refund();
        assert_eq!(contract.get_unclaimed_refund(user1.clone()), NearToken::from_near(0));
        assert!(contract.get_pending_refund_claim(user1.clone()).is_some());
        // Invariant: total_refund_liabilities MUST remain 6 NEAR (covering unclaimed + pending)
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(6));

        // User 2 claims refund -> also moves to ClaimPending
        testing_env!(context.predecessor_account_id(user2.clone()).account_balance(liquid_balance_10_near).build());
        let _ = contract.claim_refund();
        assert_eq!(contract.get_unclaimed_refund(user2.clone()), NearToken::from_near(0));
        assert!(contract.get_pending_refund_claim(user2.clone()).is_some());
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(6));

        // User 1 cannot claim again while pending
        let mut contract_safe = std::panic::AssertUnwindSafe(&mut contract);
        let double_claim = std::panic::catch_unwind(move || {
            let _ = contract_safe.claim_refund();
        });
        assert!(double_claim.is_err(), "Duplicate claim while in ClaimPending must be blocked");

        // User 1 callback succeeds -> extinguishes 2 NEAR liability
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_claim_refund_executed(user1.clone(), 1, NearToken::from_near(2), Ok(()));
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(4));
        assert!(contract.get_pending_refund_claim(user1.clone()).is_none());

        // User 2 callback fails -> restores 2 NEAR back to unclaimed_refunds; total liability remains 4 NEAR
        let _ = contract.on_claim_refund_executed(user2.clone(), 1, NearToken::from_near(2), Err(near_sdk::PromiseError::Failed));
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(4));
        assert_eq!(contract.get_unclaimed_refund(user2.clone()), NearToken::from_near(2));
        assert!(contract.get_pending_refund_claim(user2.clone()).is_none());
    }

    #[test]
    fn test_claim_callback_receipt_not_committing_quarantines_liability() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund = NearToken::from_near(3);

        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(user.clone(), refund, Err(near_sdk::PromiseError::Failed));
        assert_eq!(contract.get_total_refund_liabilities(), refund);

        // User claims refund
        let storage_stake = NearToken::from_yoctonear(env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear());
        testing_env!(context.predecessor_account_id(user.clone()).account_balance(storage_stake.saturating_add(refund)).build());
        let _ = contract.claim_refund();

        // A missing callback does not reveal whether the transfer committed.
        // The unresolved amount therefore remains quarantined, not claimable.
        assert!(contract.get_pending_refund_claim(user.clone()).is_some());
        assert_eq!(contract.get_total_refund_liabilities(), refund);
        assert_eq!(contract.get_total_refund_liability(user.clone()), refund);
        assert_eq!(contract.get_unclaimed_refund(user.clone()), NearToken::from_near(0));
        assert_eq!(contract.get_claim_nonce(user.clone()), 1);

        // Claimant retries: strictly blocked
        let mut retry_safe = std::panic::AssertUnwindSafe(&mut contract);
        let retry = std::panic::catch_unwind(move || {
            let _ = retry_safe.claim_refund();
        });
        assert!(retry.is_err(), "Must reject retry while earlier claim is unresolved");

        // Another owner's liability remains separately accounted for.
        let user2 = accounts(2);
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(user2.clone(), NearToken::from_near(2), Err(near_sdk::PromiseError::Failed));
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(5));
        assert_eq!(contract.get_total_refund_liability(user.clone()), refund);
        assert_eq!(contract.get_total_refund_liability(user2.clone()), NearToken::from_near(2));

        // An insolvent claim cannot spend funds backing the unresolved liability.
        let current_storage_stake = NearToken::from_yoctonear(
            env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear(),
        );
        testing_env!(context
            .predecessor_account_id(user2.clone())
            .account_balance(current_storage_stake.saturating_add(NearToken::from_near(4)))
            .build());
        let mut user2_safe = std::panic::AssertUnwindSafe(&mut contract);
        let user2_claim = std::panic::catch_unwind(move || {
            let _ = user2_safe.claim_refund();
        });
        assert!(user2_claim.is_err(), "Must reserve funds for all outstanding liabilities");
        assert_eq!(contract.get_unclaimed_refund(user2.clone()), NearToken::from_near(2));
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(5));
        assert!(contract.get_pending_refund_claim(user.clone()).is_some());
        assert_eq!(contract.get_pending_refund_claim(user2.clone()), None);

        // If all liabilities are backed, user2 can claim independently while user1
        // remains quarantined. The global liability is unchanged until callbacks commit.
        let current_storage_stake = NearToken::from_yoctonear(
            env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear(),
        );
        testing_env!(context
            .predecessor_account_id(user2.clone())
            .account_balance(current_storage_stake.saturating_add(NearToken::from_near(5)))
            .build());
        let _other_claim = contract.claim_refund();
        assert_eq!(contract.get_unclaimed_refund(user2.clone()), NearToken::from_near(0));
        assert_eq!(
            contract.get_pending_refund_claim(user2.clone()).unwrap().amount,
            NearToken::from_near(2)
        );
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(5));
        assert_eq!(contract.get_total_refund_liability(user.clone()), refund);
        assert_eq!(contract.get_total_refund_liability(user2), NearToken::from_near(2));
    }

    #[test]
    fn test_task18_store_controller_code_cannot_spend_preexisting_contract_balance() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund = NearToken::from_near(5);

        // Pre-existing refund liability: 5 NEAR
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(user.clone(), refund, Err(near_sdk::PromiseError::Failed));
        assert_eq!(contract.get_total_refund_liabilities(), refund);

        // Owner calls store_controller_code with attached deposit covering storage delta
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        let wasm = sample_controller_wasm();
        contract.store_controller_code(wasm);

        // Invariant: total_refund_liabilities is completely untouched
        assert_eq!(contract.get_total_refund_liabilities(), refund);
    }

    #[test]
    fn test_task18_provisioning_outflow_is_user_funded_and_preserves_refund_liabilities() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));

        let user = accounts(1);
        let refund = NearToken::from_near(5);

        // Pre-existing refund liability: 5 NEAR
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let _ = contract.on_refund_executed(user.clone(), refund, Err(near_sdk::PromiseError::Failed));
        assert_eq!(contract.get_total_refund_liabilities(), refund);

        // Store controller code
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(2))
            .build());
        contract.store_controller_code(sample_controller_wasm());

        // Mint token to user2
        let user2 = accounts(2);
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.relay_mint(
            token_id.clone(),
            user2.clone(),
            sample_token_metadata(),
            canonical,
            3,
        );

        // User2 provisions subaccount by attaching their own deposit (2 NEAR)
        let provision_deposit = NearToken::from_near(2);
        testing_env!(context
            .attached_deposit(provision_deposit)
            .predecessor_account_id(user2.clone())
            .build());
        let _ = contract.relay_provision_subaccount(token_id.clone());

        // Invariant: Provisioning outflow is funded by caller's attached deposit.
        // Pre-existing total_refund_liabilities is preserved at 5 NEAR.
        assert_eq!(contract.get_total_refund_liabilities(), refund);

        // If provisioning fails, callback adds provision_deposit to liabilities (5 + 2 = 7 NEAR)
        let _ = contract.on_provision_complete(
            token_id.clone(),
            1,
            user2.clone(),
            provision_deposit,
            Err(near_sdk::PromiseError::Failed),
        );
        assert_eq!(contract.get_total_refund_liabilities(), NearToken::from_near(7));
        assert_eq!(contract.get_unclaimed_refund(user2), provision_deposit);
        assert_eq!(contract.get_unclaimed_refund(user), refund);
    }

    #[test]
    #[should_panic(expected = "Token is currently locked pending another operation or transfer")]
    fn test_second_payment_is_rejected_while_payment_is_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical.clone(),
            1,
        );
        contract.associated_accounts.insert(
            &token_id,
            &AccountBinding {
                account_id: canonical.clone(),
                is_verified: true,
            },
        );
        contract.token_lifecycles.insert(
            &token_id,
            &TokenLifecycle::LockedForSubaccount {
                nonce: 1,
                initiator: accounts(0),
            },
        );
        contract.payments.insert(
            &token_id,
            &PaymentRecord {
                token_id: token_id.clone(),
                associated_account_id: canonical.clone(),
                owner_at_dispatch: accounts(0),
                source_ft_contract: Some(accounts(1)),
                receiver_id: accounts(2),
                amount: U128(10),
                nonce: 1,
                payment_id: "pending".to_string(),
                deadline: None,
                transfer_call: false,
                resolved_amount_used: None,
                token_transfer_status: TokenTransferStatus::Pending,
                checkout_status: None,
                commitment_hash: None,
            },
        );

        testing_env!(context
            .attached_deposit(NearToken::from_yoctonear(0))
            .predecessor_account_id(accounts(0))
            .build());
        let _ = contract.relay_start_payment(
            token_id,
            accounts(1),
            accounts(2),
            U128(1),
            "second".to_string(),
            None,
            false,
            String::new(),
        );
    }

    #[test]
    #[should_panic(expected = "Cannot transfer token while an operation or transfer is pending")]
    fn test_nft_transfer_is_rejected_while_payment_is_pending() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);

        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        contract.relay_mint(
            token_id.clone(),
            accounts(0),
            sample_token_metadata(),
            canonical,
            1,
        );
        contract.token_lifecycles.insert(
            &token_id,
            &TokenLifecycle::LockedForSubaccount {
                nonce: 1,
                initiator: accounts(0),
            },
        );

        testing_env!(context
            .attached_deposit(NearToken::from_yoctonear(1))
            .predecessor_account_id(accounts(0))
            .build());
        contract.nft_transfer(accounts(1), token_id, None, None);
    }

    #[test]
    #[should_panic(expected = "Cannot transfer token while an operation or transfer is pending")]
    fn test_token_transfer_completion_does_not_settle_pending_checkout() {
        let mut context = get_context(accounts(1));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        contract.payments.insert(
            &token_id,
            &PaymentRecord {
                token_id: token_id.clone(),
                associated_account_id: canonical,
                owner_at_dispatch: accounts(1),
                source_ft_contract: Some(accounts(2)),
                receiver_id: accounts(3),
                amount: U128(10),
                nonce: 1,
                payment_id: "checkout-pending".to_string(),
                deadline: None,
                transfer_call: true,
                resolved_amount_used: None,
                token_transfer_status: TokenTransferStatus::Pending,
                checkout_status: Some(CheckoutStatus::CheckoutPending),
                commitment_hash: None,
            },
        );
        contract.token_lifecycles.insert(
            &token_id,
            &TokenLifecycle::LockedForSubaccount {
                nonce: 1,
                initiator: accounts(1),
            },
        );

        assert!(contract.on_payment_resolved(
            token_id.clone(),
            1,
            Ok(PaymentExecutionResult::TransferCallResolved {
                amount_used: U128(10),
            }),
        ));
        let payment = contract.payments.get(&token_id).unwrap();
        assert_eq!(
            payment.token_transfer_status,
            TokenTransferStatus::TokenTransferCompleted
        );
        assert_eq!(
            payment.checkout_status,
            Some(CheckoutStatus::CheckoutPending)
        );
        assert!(contract.is_token_locked(&token_id));

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        contract.nft_transfer(accounts(2), token_id, None, None);
    }

    #[test]
    fn test_payment_callback_nonce_replay_and_recovery_lock() {
        let context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "relay-1".to_string();
        let canonical = contract.relay_canonical_account_id(&token_id);
        let mut payment = PaymentRecord {
            token_id: token_id.clone(),
            associated_account_id: canonical.clone(),
            owner_at_dispatch: accounts(1),
            source_ft_contract: Some(accounts(2)),
            receiver_id: accounts(3),
            amount: U128(10),
            nonce: 4,
            payment_id: "nonce-4".to_string(),
            deadline: None,
            transfer_call: true,
            resolved_amount_used: None,
            token_transfer_status: TokenTransferStatus::Pending,
            checkout_status: None,
            commitment_hash: None,
        };
        contract.payments.insert(&token_id, &payment);
        contract.token_lifecycles.insert(
            &token_id,
            &TokenLifecycle::LockedForSubaccount {
                nonce: 4,
                initiator: accounts(1),
            },
        );

        assert!(!contract.on_payment_resolved(
            token_id.clone(),
            3,
            Ok(PaymentExecutionResult::TransferSucceeded),
        ));
        assert_eq!(contract.payments.get(&token_id), Some(payment.clone()));

        assert!(!contract.on_payment_resolved(
            token_id.clone(),
            4,
            Ok(PaymentExecutionResult::RecoveryRequired),
        ));
        payment.token_transfer_status = TokenTransferStatus::RecoveryRequired;
        assert_eq!(contract.payments.get(&token_id), Some(payment.clone()));
        assert!(contract.is_token_locked(&token_id));

        assert!(!contract.on_payment_resolved(
            token_id.clone(),
            4,
            Ok(PaymentExecutionResult::TransferSucceeded),
        ));
        assert_eq!(contract.payments.get(&token_id), Some(payment.clone()));

        payment.nonce = 5;
        payment.payment_id = "nonce-5".to_string();
        payment.token_transfer_status = TokenTransferStatus::Pending;
        payment.resolved_amount_used = None;
        contract.payments.insert(&token_id, &payment);
        contract.token_lifecycles.insert(
            &token_id,
            &TokenLifecycle::LockedForSubaccount {
                nonce: 5,
                initiator: accounts(1),
            },
        );
        assert!(!contract.on_payment_resolved(
            token_id.clone(),
            4,
            Ok(PaymentExecutionResult::TransferCallResolved {
                amount_used: U128(0),
            }),
        ));
        assert_eq!(contract.payments.get(&token_id), Some(payment.clone()));
        assert!(!contract.on_payment_resolved(
            token_id.clone(),
            5,
            Ok(PaymentExecutionResult::TransferCallResolved {
                amount_used: U128(0),
            }),
        ));
        let resolved = contract.payments.get(&token_id).unwrap();
        assert_eq!(
            resolved.token_transfer_status,
            TokenTransferStatus::TokenTransferRefunded
        );
        assert_eq!(resolved.resolved_amount_used, Some(U128(0)));
        assert!(!contract.is_token_locked(&token_id));
        assert!(!contract.on_payment_resolved(
            token_id.clone(),
            5,
            Ok(PaymentExecutionResult::TransferSucceeded),
        ));
        assert_eq!(contract.payments.get(&token_id), Some(resolved));
    }

    fn test_quote_input(token_id: &TokenId, owner_id: &AccountId, nonce: u64, signature_byte: char) -> QuoteAuthorizationInput {
        let parent = env::current_account_id();
        let associated: AccountId = format!("{token_id}.{parent}").parse().unwrap();
        let mut quote = QuoteAuthorizationInput {
            provider_signature_hash: String::new(),
            provider_signature: Vec::new(),
            provider_signed_payload: String::new(),
            commitment_hash: String::new(),
            source_asset: "nep141:wrap.near".to_string(),
            source_decimals: 24,
            deposit_type: "ORIGIN_CHAIN".to_string(),
            source_amount: U128(100),
            destination_asset:
                "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near"
                    .to_string(),
            destination_decimals: 18,
            expected_output: U128(50),
            minimum_output: U128(45),
            recipient: "0x1111111111111111111111111111111111111111".to_string(),
            deposit_address: "0x2222222222222222222222222222222222222222".to_string(),
            deposit_memo: Some("memo-1".to_string()),
            refund_address: associated.clone(),
            refund_type: "ORIGIN_CHAIN".to_string(),
            request_deadline: U64(100_000_000_000),
            provider_quote_deadline: U64(200_000_000_000),
            provider_inactive_deadline: Some(U64(150_000_000_000)),
        };
        resign_test_quote(&mut quote, signature_byte);
        quote.commitment_hash = quote_commitment_hash(
            token_id,
            &parent,
            &associated,
            owner_id,
            nonce,
            &quote,
        );
        quote
    }

    fn test_iso_timestamp(timestamp_nanos: u64) -> String {
        let total_seconds = timestamp_nanos / 1_000_000_000;
        let hours = total_seconds / 3600;
        let minutes = (total_seconds % 3600) / 60;
        let seconds = total_seconds % 60;
        let fractional_nanos = timestamp_nanos % 1_000_000_000;
        format!("1970-01-01T{hours:02}:{minutes:02}:{seconds:02}.{fractional_nanos:09}Z")
    }

    fn resign_test_quote(quote: &mut QuoteAuthorizationInput, signature_byte: char) {
        let mut payload = serde_json::json!({
            "dry": false,
            "swapType": "EXACT_INPUT",
            "slippageTolerance": 100,
            "originAsset": quote.source_asset,
            "depositType": quote.deposit_type,
            "destinationAsset": quote.destination_asset,
            "amount": quote.source_amount.0.to_string(),
            "refundTo": quote.refund_address.as_str(),
            "refundType": quote.refund_type,
            "recipient": quote.recipient,
            "recipientType": "DESTINATION_CHAIN",
            "amountIn": quote.source_amount.0.to_string(),
            "amountInFormatted": "0.0001",
            "amountInUsd": "0.1",
            "minAmountIn": quote.source_amount.0.to_string(),
            "amountOut": quote.expected_output.0.to_string(),
            "amountOutFormatted": "0.00000000000000005",
            "amountOutUsd": "0.2",
            "minAmountOut": quote.minimum_output.0.to_string(),
            "depositAddress": quote.deposit_address,
            "depositMemo": quote.deposit_memo,
            "deadline": test_iso_timestamp(quote.provider_quote_deadline.0),
            "timeWhenInactive": quote.provider_inactive_deadline.map(|deadline| test_iso_timestamp(deadline.0)),
            "timeEstimate": 1,
            "refundFee": "0",
            "withdrawFee": "0",
            "timestamp": test_iso_timestamp((signature_byte as u64) * 1_000_000_000),
        });
        if quote.deposit_memo.is_none() {
            payload.as_object_mut().unwrap().remove("depositMemo");
        }
        if quote.provider_inactive_deadline.is_none() {
            payload.as_object_mut().unwrap().remove("timeWhenInactive");
        }
        quote.provider_signed_payload = serde_json::to_string(&payload).unwrap();
        let message = bs58::encode(env::sha256(quote.provider_signed_payload.as_bytes())).into_string();
        let seed: [u8; 32] = std::array::from_fn(|index| (index + 1) as u8);
        quote.provider_signature = SigningKey::from_bytes(&seed)
            .sign(message.as_bytes())
            .to_bytes()
            .to_vec();
        quote.provider_signature_hash = env::sha256(&quote.provider_signature)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
    }

    fn official_provider_quote_fixture() -> QuoteAuthorizationInput {
        let provider_signed_payload = r#"{"amount":"100000000000000000000000","amountIn":"100000000000000000000000","amountInFormatted":"0.1","amountInUsd":"0.382000000000","amountOut":"2199174653740536027","amountOutFormatted":"2.199174653740536027","amountOutUsd":"0.377316793692","deadline":"2026-11-09T14:57:14.745Z","depositAddress":"18069aa84ccc07e70cfa776e0f73ab14aaafc6b3ddacab9fdcf4b8506834598f","depositType":"ORIGIN_CHAIN","destinationAsset":"nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near","dry":false,"minAmountIn":"100000000000000000000000","minAmountOut":"2177182907203130666","originAsset":"nep141:wrap.near","recipient":"0x2527D02599Ba641c19FEa793cD0F167589a0f10D","recipientType":"DESTINATION_CHAIN","refundFee":"0","refundTo":"user.near","refundType":"ORIGIN_CHAIN","slippageTolerance":100,"swapType":"EXACT_INPUT","timeEstimate":21,"timeWhenInactive":"2026-11-09T14:57:14.745Z","timestamp":"2026-11-06T14:54:13.454Z","withdrawFee":"10000000000000000"}"#;
        let provider_signature =
            bs58::decode("21wH7uDZnhrJsgvJaG2DhwTHQ6fPymAY4fjicQVk3y9itjmM9QoToF3kfh73T9xbPRnx1d8hv6wDzXAayj7UDDM5")
                .into_vec()
                .unwrap();
        let signature_hash = env::sha256(&provider_signature)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let mut quote = QuoteAuthorizationInput {
            provider_signature_hash: signature_hash,
            provider_signature,
            provider_signed_payload: provider_signed_payload.to_string(),
            commitment_hash: String::new(),
            source_asset: "nep141:wrap.near".to_string(),
            source_decimals: 24,
            deposit_type: "ORIGIN_CHAIN".to_string(),
            source_amount: U128(100_000_000_000_000_000_000_000),
            destination_asset:
                "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near"
                    .to_string(),
            destination_decimals: 18,
            expected_output: U128(2_199_174_653_740_536_027),
            minimum_output: U128(2_177_182_907_203_130_666),
            recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D".to_string(),
            deposit_address: "18069aa84ccc07e70cfa776e0f73ab14aaafc6b3ddacab9fdcf4b8506834598f"
                .to_string(),
            deposit_memo: None,
            refund_address: "user.near".parse().unwrap(),
            refund_type: "ORIGIN_CHAIN".to_string(),
            request_deadline: U64(
                parse_provider_deadline_nanos("2026-11-06T14:57:14.745Z").unwrap(),
            ),
            provider_quote_deadline: U64(
                parse_provider_deadline_nanos("2026-11-09T14:57:14.745Z").unwrap(),
            ),
            provider_inactive_deadline: Some(U64(
                parse_provider_deadline_nanos("2026-11-09T14:57:14.745Z").unwrap(),
            )),
        };
        quote.commitment_hash.clear();
        quote
    }

    fn official_provider_public_key() -> [u8; 32] {
        [
            0x0c, 0xb7, 0xe9, 0x49, 0xe3, 0x87, 0x1e, 0xcf, 0x28, 0x4a, 0x50, 0xb8, 0xe7, 0x74,
            0xab, 0x29, 0xb3, 0xf7, 0xb2, 0x36, 0x3e, 0x39, 0x8c, 0xef, 0x1d, 0xf2, 0xe9, 0x44,
            0x57, 0xb7, 0xe9, 0x43,
        ]
    }

    fn mint_verified_quote_token(
        contract: &mut Contract,
        context: &mut VMContextBuilder,
        token_id: &TokenId,
        owner_id: &AccountId,
    ) {
        let canonical = contract.relay_canonical_account_id(token_id);
        testing_env!(context
            .storage_usage(env::storage_usage())
            .attached_deposit(MINT_STORAGE_COST)
            .predecessor_account_id(accounts(0))
            .build());
        contract.relay_mint(
            token_id.clone(),
            owner_id.clone(),
            sample_token_metadata(),
            canonical.clone(),
            1,
        );
        contract.associated_accounts.insert(
            token_id,
            &AccountBinding {
                account_id: canonical,
                is_verified: true,
            },
        );
    }

    fn assert_official_provider_quote_rejected(
        quote: QuoteAuthorizationInput,
        public_key: &[u8; 32],
    ) {
        let result = std::panic::catch_unwind(|| {
            verify_provider_quote_with_key(&quote, public_key);
        });
        assert!(result.is_err());
    }

    #[test]
    fn accepts_the_actual_pinned_sdk_provider_signature_fixture() {
        let quote = official_provider_quote_fixture();
        assert_eq!(
            verify_provider_quote_with_key(&quote, &official_provider_public_key()),
            quote.provider_signature_hash
        );
    }

    #[test]
    fn rejects_official_signature_with_modified_deposit_address() {
        let mut quote = official_provider_quote_fixture();
        quote.deposit_address = "attacker.near".to_string();
        assert_official_provider_quote_rejected(quote, &official_provider_public_key());
    }

    #[test]
    fn rejects_official_signature_with_modified_amount() {
        let mut quote = official_provider_quote_fixture();
        quote.source_amount = U128(100_000_000_000_000_000_000_001);
        assert_official_provider_quote_rejected(quote, &official_provider_public_key());
    }

    #[test]
    fn rejects_official_signature_with_modified_refund_destination() {
        let mut quote = official_provider_quote_fixture();
        quote.refund_address = accounts(2);
        assert_official_provider_quote_rejected(quote, &official_provider_public_key());
    }

    #[test]
    fn rejects_official_signature_with_modified_deadline() {
        let mut quote = official_provider_quote_fixture();
        quote.provider_quote_deadline.0 += 1;
        assert_official_provider_quote_rejected(quote, &official_provider_public_key());
    }

    #[test]
    fn rejects_provider_deadline_supplied_in_milliseconds() {
        let mut quote = official_provider_quote_fixture();
        quote.provider_quote_deadline = U64(1_800_259_634_745);
        assert_official_provider_quote_rejected(quote, &official_provider_public_key());
    }

    #[test]
    fn rejects_unknown_provider_key_id_field() {
        let mut quote = official_provider_quote_fixture();
        let mut payload: Value = serde_json::from_str(&quote.provider_signed_payload).unwrap();
        payload
            .as_object_mut()
            .unwrap()
            .insert("keyId".to_string(), Value::String("untrusted-key".to_string()));
        quote.provider_signed_payload = serde_json::to_string(&payload).unwrap();
        assert_official_provider_quote_rejected(quote, &official_provider_public_key());
    }

    #[test]
    fn rejects_invalid_and_wrong_key_provider_signatures() {
        let quote = official_provider_quote_fixture();
        let mut invalid_signature = quote.clone();
        invalid_signature.provider_signature[0] ^= 1;
        assert_official_provider_quote_rejected(invalid_signature, &official_provider_public_key());

        let wrong_key = [0u8; 32];
        assert_official_provider_quote_rejected(quote, &wrong_key);
    }

    #[test]
    fn rejects_malformed_signature_and_caller_supplied_signature_digest() {
        let mut malformed_signature = official_provider_quote_fixture();
        malformed_signature.provider_signature.pop();
        assert_official_provider_quote_rejected(
            malformed_signature,
            &official_provider_public_key(),
        );

        let mut arbitrary_digest = official_provider_quote_fixture();
        arbitrary_digest.provider_signature_hash = "a".repeat(64);
        assert_official_provider_quote_rejected(arbitrary_digest, &official_provider_public_key());
    }

    #[test]
    fn quote_authorization_is_owner_bound_and_uses_its_own_monotonic_nonce() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-token".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let quote = test_quote_input(&token_id, &accounts(1), 0, 'a');
        assert_eq!(
            quote.commitment_hash,
            "a23a9edc60131a519749d01b7aa89264a6f911a11cfd21984004d7030796f8a0"
        );

        testing_env!(context.predecessor_account_id(accounts(2)).build());
        let unauthorized = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone())
        }));
        assert!(unauthorized.is_err());

        let mut invalid_deposit_type = quote.clone();
        invalid_deposit_type.deposit_type = "INTENTS".to_string();
        invalid_deposit_type.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &invalid_deposit_type.refund_address,
            &accounts(1),
            0,
            &invalid_deposit_type,
        );
        testing_env!(
            context
                .predecessor_account_id(accounts(1))
                .attached_deposit(NearToken::from_near(1))
                .build()
        );
        let invalid_deposit_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_authorize_quote(
                token_id.clone(),
                U64(0),
                invalid_deposit_type,
            )
        }));
        assert!(invalid_deposit_result.is_err());

        let mut invalid_decimals = quote.clone();
        invalid_decimals.source_decimals = 18;
        invalid_decimals.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &invalid_decimals.refund_address,
            &accounts(1),
            0,
            &invalid_decimals,
        );
        testing_env!(
            context
                .predecessor_account_id(accounts(1))
                .attached_deposit(NearToken::from_near(1))
                .build()
        );
        let invalid_decimals_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_authorize_quote(token_id.clone(), U64(0), invalid_decimals)
        }));
        assert!(invalid_decimals_result.is_err());

        testing_env!(
            context
                .predecessor_account_id(accounts(1))
                .attached_deposit(NearToken::from_near(1))
                .build()
        );
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());
        let authorization = contract
            .relay_quote_authorization(token_id.clone(), quote.commitment_hash.clone())
            .unwrap();
        assert_eq!(authorization.status, QuoteAuthorizationStatus::Prepared);
        assert!(authorization.account_binding_verified);
        assert_eq!(authorization.source_decimals, 24);
        assert_eq!(authorization.destination_decimals, 18);
        assert_eq!(
            authorization.provider_inactive_deadline,
            quote.provider_inactive_deadline
        );
        assert_eq!(authorization.created_block_height, U64(env::block_height()));
        assert_eq!(authorization.created_timestamp, U64(env::block_timestamp()));
        assert_eq!(
            authorization.deposit_dispatch_status,
            DepositDispatchStatus::Disabled
        );
        assert_eq!(authorization.nonce, U64(0));
        assert_eq!(contract.relay_quote_nonce(token_id.clone()), U64(1));
        assert_eq!(
            contract
                .relay_quote_authorization(token_id.clone(), quote.commitment_hash.clone())
                .unwrap(),
            authorization
        );
        assert!(contract.relay_consume_quote_authorization(
            token_id.clone(),
            quote.commitment_hash.clone()
        ));
        assert_eq!(
            contract
                .relay_quote_authorization(token_id, quote.commitment_hash)
                .unwrap()
                .status,
            QuoteAuthorizationStatus::Consumed
        );
    }

    #[test]
    fn accepts_base_usdc_quote_pair() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "base-quote-token".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 'c');
        quote.destination_asset =
            "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".to_string();
        quote.destination_decimals = 6;
        resign_test_quote(&mut quote, 'c');
        let parent = env::current_account_id();
        let associated: AccountId = format!("{token_id}.{parent}").parse().unwrap();
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &parent,
            &associated,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(
            context
                .predecessor_account_id(accounts(1))
                .attached_deposit(NearToken::from_near(1))
                .build()
        );
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());
        let authorization = contract
            .relay_quote_authorization(token_id, quote.commitment_hash)
            .unwrap();
        assert_eq!(authorization.status, QuoteAuthorizationStatus::Prepared);
        assert_eq!(
            authorization.destination_asset,
            "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
        );
        assert_eq!(authorization.destination_decimals, 6);
    }

    #[test]
    fn quote_authorization_is_invalidated_by_nft_transfer_without_blocking_transfer() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-token".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let quote = test_quote_input(&token_id, &accounts(1), 0, 'b');

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        contract.nft_transfer(accounts(2), token_id.clone(), None, None);

        assert_eq!(contract.relay_quote_nonce(token_id.clone()), U64(2));
        assert_eq!(
            contract
                .relay_quote_authorization(token_id.clone(), quote.commitment_hash.clone())
                .unwrap()
                .status,
            QuoteAuthorizationStatus::InvalidatedOwnership
        );
        testing_env!(context.predecessor_account_id(accounts(2)).build());
        assert!(!contract.relay_consume_quote_authorization(token_id, quote.commitment_hash));
    }

    #[test]
    fn accepted_nft_transfer_call_invalidates_quote_authorization() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-call".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let quote = test_quote_input(&token_id, &accounts(1), 0, 'e');
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        let _ = contract.nft_transfer_call(
            accounts(2),
            token_id.clone(),
            None,
            None,
            "accept".to_string(),
        );
        #[allow(deprecated)]
        testing_env_with_promise_results(
            context.predecessor_account_id(accounts(0)).build(),
            PromiseResult::Successful(b"false".to_vec()),
        );
        assert!(contract.nft_resolve_transfer(
            accounts(1),
            accounts(2),
            token_id.clone(),
            None,
        ));
        assert_eq!(
            contract
                .relay_quote_authorization(token_id.clone(), quote.commitment_hash.clone())
                .unwrap()
                .status,
            QuoteAuthorizationStatus::InvalidatedOwnership
        );
        assert_eq!(contract.relay_quote_nonce(token_id), U64(2));
    }

    #[test]
    fn starting_a_payment_invalidates_active_quote_context() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-payment".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let quote = test_quote_input(&token_id, &accounts(1), 0, 'f');

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let _ = contract.relay_start_payment(
            token_id.clone(),
            accounts(2),
            accounts(3),
            U128(1),
            "new-payment".to_string(),
            None,
            false,
            String::new(),
        );
        assert_eq!(contract.relay_quote_nonce(token_id.clone()), U64(2));
        assert_eq!(
            contract
                .relay_quote_authorization(token_id, quote.commitment_hash)
                .unwrap()
                .status,
            QuoteAuthorizationStatus::InvalidatedContext
        );
    }

    #[test]
    fn quote_authorization_can_be_cancelled_or_permissionlessly_expired() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let cancelled_token = "quote-cancel".to_string();
        mint_verified_quote_token(
            &mut contract,
            &mut context,
            &cancelled_token,
            &accounts(1),
        );
        let cancelled = test_quote_input(&cancelled_token, &accounts(1), 0, 'c');
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(cancelled_token.clone(), U64(0), cancelled.clone());
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        assert!(contract.relay_cancel_quote_authorization(
            cancelled_token.clone(),
            cancelled.commitment_hash.clone()
        ));
        assert!(!contract.relay_cancel_quote_authorization(
            cancelled_token.clone(),
            cancelled.commitment_hash.clone()
        ));

        let expiring_token = "quote-expire".to_string();
        mint_verified_quote_token(
            &mut contract,
            &mut context,
            &expiring_token,
            &accounts(1),
        );
        let mut expiring = test_quote_input(&expiring_token, &accounts(1), 0, 'd');
        expiring.request_deadline = U64(100);
        expiring.provider_quote_deadline = U64(200);
        expiring.provider_inactive_deadline = Some(U64(10));
        resign_test_quote(&mut expiring, 'd');
        expiring.commitment_hash = quote_commitment_hash(
            &expiring_token,
            &env::current_account_id(),
            &expiring.refund_address,
            &accounts(1),
            0,
            &expiring,
        );
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .block_timestamp(0)
            .build());
        let _ = contract.relay_authorize_quote(expiring_token.clone(), U64(0), expiring.clone());
        testing_env!(context
            .predecessor_account_id(accounts(2))
            .block_timestamp(10)
            .build());
        assert!(contract.relay_expire_quote_authorization(
            expiring_token.clone(),
            expiring.commitment_hash.clone()
        ));
        assert!(!contract.relay_expire_quote_authorization(
            expiring_token.clone(),
            expiring.commitment_hash.clone()
        ));
        assert_eq!(
            contract
                .relay_quote_authorization(expiring_token, expiring.commitment_hash)
                .unwrap()
                .status,
            QuoteAuthorizationStatus::Expired
        );
    }

    #[test]
    fn canonical_provider_signature_digest_is_globally_consumed_permanently() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let cancelled_token = "quote-cancel-replay".to_string();
        let expired_token = "quote-expire-replay".to_string();
        let transferred_token = "quote-transfer-replay".to_string();
        let consumed_token = "quote-consume-replay".to_string();
        let other_token = "quote-other-replay".to_string();
        for token_id in [
            &cancelled_token,
            &expired_token,
            &transferred_token,
            &consumed_token,
            &other_token,
        ] {
            mint_verified_quote_token(&mut contract, &mut context, token_id, &accounts(1));
        }

        let mut cancelled = test_quote_input(&cancelled_token, &accounts(1), 0, 'g');
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(cancelled_token.clone(), U64(0), cancelled.clone());
        assert!(contract.relay_cancel_quote_authorization(
            cancelled_token.clone(),
            cancelled.commitment_hash.clone()
        ));
        let cancelled_signature_hash = cancelled.provider_signature_hash.clone();
        cancelled.commitment_hash = quote_commitment_hash(
            &cancelled_token,
            &env::current_account_id(),
            &cancelled.refund_address,
            &accounts(1),
            1,
            &cancelled,
        );
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let cancelled_replay = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_authorize_quote(cancelled_token.clone(), U64(1), cancelled.clone())
        }));
        assert!(cancelled_replay.is_err());

        let mut cross_token = test_quote_input(&other_token, &accounts(1), 0, 'h');
        cross_token.provider_signature_hash = cancelled_signature_hash.clone();
        cross_token.provider_signature = cancelled.provider_signature.clone();
        cross_token.provider_signed_payload = cancelled.provider_signed_payload.clone();
        cross_token.commitment_hash = quote_commitment_hash(
            &other_token,
            &env::current_account_id(),
            &cross_token.refund_address,
            &accounts(1),
            0,
            &cross_token,
        );
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let cross_token_replay = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_authorize_quote(other_token.clone(), U64(0), cross_token.clone())
        }));
        assert!(cross_token_replay.is_err());

        let mut expiring = test_quote_input(&expired_token, &accounts(1), 0, 'i');
        expiring.request_deadline = U64(10);
        expiring.provider_quote_deadline = U64(20);
        resign_test_quote(&mut expiring, 'i');
        expiring.commitment_hash = quote_commitment_hash(
            &expired_token,
            &env::current_account_id(),
            &expiring.refund_address,
            &accounts(1),
            0,
            &expiring,
        );
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .block_timestamp(0)
            .build());
        let _ = contract.relay_authorize_quote(expired_token.clone(), U64(0), expiring.clone());
        testing_env!(context
            .predecessor_account_id(accounts(2))
            .block_timestamp(10)
            .build());
        assert!(contract.relay_expire_quote_authorization(
            expired_token.clone(),
            expiring.commitment_hash.clone()
        ));
        expiring.request_deadline = U64(100_000_000_000);
        expiring.provider_quote_deadline = U64(200_000_000_000);
        expiring.commitment_hash = quote_commitment_hash(
            &expired_token,
            &env::current_account_id(),
            &expiring.refund_address,
            &accounts(1),
            1,
            &expiring,
        );
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .block_timestamp(10)
            .build());
        let expired_replay = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_authorize_quote(expired_token.clone(), U64(1), expiring.clone())
        }));
        assert!(expired_replay.is_err());

        let transferred = test_quote_input(&transferred_token, &accounts(1), 0, 'j');
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(
            transferred_token.clone(),
            U64(0),
            transferred.clone(),
        );
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        contract.nft_transfer(accounts(2), transferred_token.clone(), None, None);
        let mut transferred_replay = transferred.clone();
        transferred_replay.commitment_hash = quote_commitment_hash(
            &transferred_token,
            &env::current_account_id(),
            &transferred_replay.refund_address,
            &accounts(2),
            2,
            &transferred_replay,
        );
        testing_env!(context
            .predecessor_account_id(accounts(2))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let transferred_replay_result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                contract.relay_authorize_quote(
                    transferred_token.clone(),
                    U64(2),
                    transferred_replay.clone(),
                )
            }));
        assert!(transferred_replay_result.is_err());

        let consumed = test_quote_input(&consumed_token, &accounts(1), 0, 'k');
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(consumed_token.clone(), U64(0), consumed.clone());
        assert!(contract.relay_consume_quote_authorization(
            consumed_token.clone(),
            consumed.commitment_hash.clone()
        ));
        let mut consumed_replay = consumed.clone();
        consumed_replay.commitment_hash = quote_commitment_hash(
            &consumed_token,
            &env::current_account_id(),
            &consumed_replay.refund_address,
            &accounts(1),
            1,
            &consumed_replay,
        );
        let consumed_replay_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_authorize_quote(consumed_token, U64(1), consumed_replay)
        }));
        assert!(consumed_replay_result.is_err());
    }

    #[test]
    fn quote_authorization_requires_a_canonical_fixed_length_signature_digest() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-bad-signature-hash".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 'm');
        quote.provider_signature_hash = "A".repeat(64);
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let uppercase = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone())
        }));
        assert!(uppercase.is_err());

        quote.provider_signature_hash = "a".repeat(63);
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let wrong_length = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_authorize_quote(token_id, U64(0), quote)
        }));
        assert!(wrong_length.is_err());
    }

    #[test]
    fn quote_storage_excess_is_a_backed_pull_refund_with_retry_safe_callbacks() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-refund".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let quote = test_quote_input(&token_id, &accounts(1), 0, 'l');

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let authorization = contract.relay_authorize_quote(token_id.clone(), U64(0), quote);
        assert!(matches!(authorization, PromiseOrValue::Value(_)));
        let refund = contract.get_unclaimed_refund(accounts(1));
        assert!(refund.as_yoctonear() > 0);
        assert_eq!(contract.get_total_refund_liabilities(), refund);

        let storage_stake = NearToken::from_yoctonear(
            (env::storage_usage() as u128).saturating_mul(env::storage_byte_cost().as_yoctonear()),
        );
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .account_balance(NearToken::from_near(0))
            .build());
        let insolvent_claim = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.claim_refund()
        }));
        assert!(insolvent_claim.is_err());
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), refund);

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .account_balance(storage_stake.saturating_add(refund))
            .build());
        let _ = contract.claim_refund();
        let pending = contract.get_pending_refund_claim(accounts(1)).unwrap();
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        assert!(!contract.on_claim_refund_executed(
            accounts(1),
            pending.nonce,
            refund,
            Err(near_sdk::PromiseError::Failed),
        ));
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), refund);
        assert_eq!(contract.get_total_refund_liabilities(), refund);
        assert!(!contract.on_claim_refund_executed(
            accounts(1),
            pending.nonce,
            refund,
            Err(near_sdk::PromiseError::Failed),
        ));
        assert_eq!(contract.get_unclaimed_refund(accounts(1)), refund);

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .account_balance(storage_stake.saturating_add(refund))
            .build());
        let _ = contract.claim_refund();
        let retry = contract.get_pending_refund_claim(accounts(1)).unwrap();
        assert!(retry.nonce > pending.nonce);
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        assert!(!contract.on_claim_refund_executed(
            accounts(1),
            pending.nonce,
            refund,
            Ok(()),
        ));
        assert!(contract.get_pending_refund_claim(accounts(1)).is_some());
        assert!(contract.on_claim_refund_executed(
            accounts(1),
            retry.nonce,
            refund,
            Ok(()),
        ));
        assert_eq!(
            contract.get_total_refund_liabilities(),
            NearToken::from_near(0)
        );
        assert!(!contract.on_claim_refund_executed(
            accounts(1),
            retry.nonce,
            refund,
            Ok(()),
        ));
    }

    #[test]
    #[cfg(feature = "sandbox-checkout-dispatch")]
    fn test_prepared_quote_payment_lifecycle_success() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_sandbox_checkout_test(accounts(0));
        assert!(contract.local_sandbox_checkout_dispatch_enabled);
        let token_id = "quote-exec-success".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 'n');
        quote.deposit_memo = Some("quote-bound-memo".to_string());
        quote.deposit_address = accounts(3).to_string();
        resign_test_quote(&mut quote, 'n');
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .block_timestamp(1_000)
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());

        let commitment = quote.commitment_hash.clone();
        let auth_before = contract.relay_quote_authorization(token_id.clone(), commitment.clone()).unwrap();
        assert_eq!(auth_before.status, QuoteAuthorizationStatus::Prepared);
        assert_eq!(auth_before.deposit_dispatch_status, DepositDispatchStatus::Disabled);

        // Execute prepared payment
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(0))
            .block_timestamp(2_000)
            .build());
        let _ = contract.relay_execute_prepared_payment(token_id.clone(), commitment.clone());
        let receipts = near_sdk::test_utils::get_created_receipts();
        let subaccount_call = receipts
            .iter()
            .flat_map(|receipt| receipt.actions.iter())
            .find_map(|action| match action {
                near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name, args, ..
                } if method_name == b"execute_nep141_deposit" => Some(args),
                _ => None,
            })
            .expect("prepared payment must dispatch to the NEP-141 deposit controller method");
        let args: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_slice(subaccount_call).unwrap();
        assert_eq!(
            args["ft_contract_id"],
            prepared_wrapped_near_contract_id().as_str()
        );
        assert_eq!(args["receiver_id"], accounts(3).as_str());
        assert_eq!(args["amount"], quote.source_amount.0.to_string());
        assert_eq!(args["deposit_memo"], "quote-bound-memo");

        // Authorization is immediately consumed and dispatched
        let auth_dispatched = contract.relay_quote_authorization(token_id.clone(), commitment.clone()).unwrap();
        assert_eq!(auth_dispatched.status, QuoteAuthorizationStatus::Consumed);
        assert_eq!(auth_dispatched.deposit_dispatch_status, DepositDispatchStatus::Dispatched);
        assert!(contract.relay_active_quote_authorization(token_id.clone()).is_none());

        // Token is locked
        assert!(contract.is_token_locked(&token_id));
        let payment_pending = contract.relay_payment(token_id.clone()).unwrap();
        assert_eq!(payment_pending.token_transfer_status, TokenTransferStatus::Pending);
        assert_eq!(payment_pending.checkout_status, Some(CheckoutStatus::CheckoutPending));
        assert_eq!(payment_pending.receiver_id, accounts(3));
        assert_eq!(payment_pending.amount, quote.source_amount);
        assert_eq!(
            payment_pending.source_ft_contract,
            Some(prepared_wrapped_near_contract_id())
        );
        assert_eq!(payment_pending.commitment_hash, Some(commitment.clone()));

        let attempted_transfer = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.nft_transfer(accounts(2), token_id.clone(), None, None)
        }));
        assert!(attempted_transfer.is_err());
        let attempted_credit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_use_credit(token_id.clone())
        }));
        assert!(attempted_credit.is_err());
        let attempted_subaccount_action =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                contract.relay_execute_subaccount(
                    token_id.clone(),
                    SubaccountAction::TransferNear {
                        receiver_id: accounts(2),
                        amount: NearToken::from_yoctonear(1),
                    },
                )
            }));
        assert!(attempted_subaccount_action.is_err());

        let stale_callback = contract.on_prepared_payment_resolved(
            token_id.clone(),
            payment_pending.nonce + 1,
            commitment.clone(),
            Ok(PaymentExecutionResult::TransferSucceeded),
        );
        assert!(!stale_callback);
        assert_eq!(
            contract.relay_payment(token_id.clone()).unwrap().token_transfer_status,
            TokenTransferStatus::Pending
        );
        assert!(contract.is_token_locked(&token_id));

        // Resolve callback successfully
        testing_env!(context
            .predecessor_account_id(accounts(0))
            .block_timestamp(3_000)
            .build());
        let resolved = contract.on_prepared_payment_resolved(
            token_id.clone(),
            payment_pending.nonce,
            commitment.clone(),
            Ok(PaymentExecutionResult::TransferSucceeded),
        );
        assert!(resolved);

        let payment_done = contract.relay_payment(token_id.clone()).unwrap();
        assert_eq!(payment_done.token_transfer_status, TokenTransferStatus::TokenTransferCompleted);
        assert_eq!(payment_done.checkout_status, Some(CheckoutStatus::SourceTransferCompleted));
        assert_eq!(payment_done.resolved_amount_used, None);

        let auth_done = contract.relay_quote_authorization(token_id.clone(), commitment.clone()).unwrap();
        assert_eq!(auth_done.status, QuoteAuthorizationStatus::Consumed);
        assert_eq!(auth_done.deposit_dispatch_status, DepositDispatchStatus::SourceTransferCompleted);

        // CRITICAL INVARIANT: Source transfer is not final settlement.
        assert!(contract.is_token_locked(&token_id));

        // Duplicate callback is safely ignored without state change
        let dup = contract.on_prepared_payment_resolved(
            token_id.clone(),
            payment_pending.nonce,
            commitment.clone(),
            Ok(PaymentExecutionResult::TransferSucceeded),
        );
        assert!(!dup);
    }

    #[test]
    #[cfg(not(feature = "sandbox-checkout-dispatch"))]
    fn prepared_quote_dispatch_is_disabled_in_default_contract_build() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-disabled".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 'z');
        quote.deposit_memo = None;
        quote.deposit_address = accounts(3).to_string();
        resign_test_quote(&mut quote, 'z');
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(
            context
                .predecessor_account_id(accounts(1))
                .attached_deposit(NearToken::from_near(1))
                .block_timestamp(1_000)
                .build()
        );
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());

        testing_env!(
            context
                .predecessor_account_id(accounts(1))
                .attached_deposit(NearToken::from_yoctonear(0))
                .block_timestamp(2_000)
                .build()
        );
        let dispatch = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_execute_prepared_payment(
                token_id.clone(),
                quote.commitment_hash.clone(),
            )
        }));
        assert!(dispatch.is_err());
        let authorization = contract
            .relay_quote_authorization(token_id.clone(), quote.commitment_hash)
            .unwrap();
        assert_eq!(authorization.status, QuoteAuthorizationStatus::Prepared);
        assert_eq!(authorization.deposit_dispatch_status, DepositDispatchStatus::Disabled);
        assert_eq!(contract.relay_payment(token_id.clone()), None);
        assert!(!contract.is_token_locked(&token_id));
    }

    #[test]
    #[cfg(feature = "sandbox-checkout-dispatch")]
    fn production_initializer_keeps_dispatch_disabled_in_feature_enabled_build() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        assert!(!contract.local_sandbox_checkout_dispatch_enabled);
        let token_id = "quote-production-disabled".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 'd');
        quote.deposit_memo = None;
        quote.deposit_address = accounts(3).to_string();
        resign_test_quote(&mut quote, 'd');
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .block_timestamp(1_000)
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(0))
            .block_timestamp(2_000)
            .build());
        let dispatch = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.relay_execute_prepared_payment(
                token_id.clone(),
                quote.commitment_hash.clone(),
            )
        }));
        assert!(dispatch.is_err());
        let authorization = contract
            .relay_quote_authorization(token_id.clone(), quote.commitment_hash)
            .unwrap();
        assert_eq!(authorization.status, QuoteAuthorizationStatus::Prepared);
        assert_eq!(authorization.deposit_dispatch_status, DepositDispatchStatus::Disabled);
        assert_eq!(contract.relay_payment(token_id.clone()), None);
        assert!(!contract.is_token_locked(&token_id));
    }

    #[test]
    #[should_panic(expected = "Token is currently locked")]
    #[cfg(feature = "sandbox-checkout-dispatch")]
    fn test_prepared_quote_payment_rejects_duplicate_dispatch() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_sandbox_checkout_test(accounts(0));
        let token_id = "quote-dup-dispatch".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 'o');
        quote.deposit_memo = None;
        quote.deposit_address = accounts(3).to_string();
        resign_test_quote(&mut quote, 'o');
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let _ = contract.relay_execute_prepared_payment(token_id.clone(), quote.commitment_hash.clone());

        // Duplicate call while locked panics!
        let _ = contract.relay_execute_prepared_payment(token_id, quote.commitment_hash);
    }

    #[test]
    #[should_panic(expected = "Quote authorization is not in Prepared status")]
    fn test_prepared_quote_payment_rejects_cancelled_quote() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-exec-cancelled".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 'p');
        quote.deposit_memo = None;
        quote.deposit_address = accounts(3).to_string();
        resign_test_quote(&mut quote, 'p');
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());
        assert!(contract.relay_cancel_quote_authorization(token_id.clone(), quote.commitment_hash.clone()));

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let _ = contract.relay_execute_prepared_payment(token_id, quote.commitment_hash);
    }

    #[test]
    #[should_panic(expected = "Quote authorization has expired")]
    fn test_prepared_quote_payment_rejects_expired_quote() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-exec-expired".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 'q');
        quote.deposit_memo = None;
        quote.deposit_address = accounts(3).to_string();
        quote.request_deadline = U64(5_000);
        quote.provider_quote_deadline = U64(10_000);
        resign_test_quote(&mut quote, 'q');
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .block_timestamp(1_000)
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(0))
            .block_timestamp(6_000)
            .build());
        let _ = contract.relay_execute_prepared_payment(token_id, quote.commitment_hash);
    }

    #[test]
    #[should_panic(expected = "Quote request deadline must be in the future")]
    fn test_prepared_quote_payment_rejects_millisecond_deadline_units() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-deadline-units".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 'u');
        quote.deposit_memo = None;
        quote.deposit_address = accounts(3).to_string();
        quote.request_deadline = U64(1_800_000_000_000);
        quote.provider_quote_deadline = U64(1_800_000_100_000);
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(
            context
                .predecessor_account_id(accounts(1))
                .attached_deposit(NearToken::from_near(1))
                .block_timestamp(1_800_000_000_000_000_000)
                .build()
        );
        let _ = contract.relay_authorize_quote(token_id, U64(0), quote);
    }

    #[test]
    #[should_panic(expected = "Only current token owner can execute a prepared payment")]
    fn test_prepared_quote_payment_rejects_old_owner() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-exec-old-owner".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 'r');
        quote.deposit_memo = None;
        quote.deposit_address = accounts(3).to_string();
        resign_test_quote(&mut quote, 'r');
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());

        // Transfer token to accounts(2)
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        contract.nft_transfer(accounts(2), token_id.clone(), None, None);

        // Old owner accounts(1) attempts to execute
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let _ = contract.relay_execute_prepared_payment(token_id, quote.commitment_hash);
    }

    #[test]
    #[should_panic(expected = "Prepared quote dispatch is disabled in this contract build")]
    fn test_prepared_quote_payment_with_memo_remains_disabled_in_default_build() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_default_meta(accounts(0));
        let token_id = "quote-exec-memo".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 's');
        quote.deposit_memo = Some("memo-not-supported".to_string());
        quote.deposit_address = accounts(3).to_string();
        resign_test_quote(&mut quote, 's');
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let _ = contract.relay_execute_prepared_payment(token_id, quote.commitment_hash);
    }

    #[test]
    #[cfg(feature = "sandbox-checkout-dispatch")]
    fn test_prepared_quote_payment_callback_error_recovery_required() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_sandbox_checkout_test(accounts(0));
        let token_id = "quote-exec-err".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 't');
        quote.deposit_memo = None;
        quote.deposit_address = accounts(3).to_string();
        resign_test_quote(&mut quote, 't');
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let _ = contract.relay_execute_prepared_payment(token_id.clone(), quote.commitment_hash.clone());

        let payment = contract.relay_payment(token_id.clone()).unwrap();

        // Callback fails
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        let resolved = contract.on_prepared_payment_resolved(
            token_id.clone(),
            payment.nonce,
            quote.commitment_hash.clone(),
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!resolved);

        let payment_after = contract.relay_payment(token_id.clone()).unwrap();
        assert_eq!(payment_after.token_transfer_status, TokenTransferStatus::RecoveryRequired);
        assert_eq!(payment_after.checkout_status, Some(CheckoutStatus::RecoveryRequired));

        let auth_after = contract.relay_quote_authorization(token_id.clone(), quote.commitment_hash).unwrap();
        assert_eq!(auth_after.status, QuoteAuthorizationStatus::RecoveryRequired);

        // Token remains locked in recovery
        assert!(contract.is_token_locked(&token_id));
    }

    #[test]
    #[cfg(feature = "sandbox-checkout-dispatch")]
    fn test_prepared_quote_transfer_failure_never_marks_source_completed() {
        let mut context = get_context(accounts(0));
        testing_env!(context.build());
        let mut contract = Contract::new_sandbox_checkout_test(accounts(0));
        let token_id = "quote-transfer-failed".to_string();
        mint_verified_quote_token(&mut contract, &mut context, &token_id, &accounts(1));
        let mut quote = test_quote_input(&token_id, &accounts(1), 0, 'u');
        quote.deposit_memo = None;
        quote.deposit_address = accounts(3).to_string();
        resign_test_quote(&mut quote, 'u');
        quote.commitment_hash = quote_commitment_hash(
            &token_id,
            &env::current_account_id(),
            &quote.refund_address,
            &accounts(1),
            0,
            &quote,
        );

        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_near(1))
            .build());
        let _ = contract.relay_authorize_quote(token_id.clone(), U64(0), quote.clone());
        testing_env!(context
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let _ = contract.relay_execute_prepared_payment(
            token_id.clone(),
            quote.commitment_hash.clone(),
        );

        let payment = contract.relay_payment(token_id.clone()).unwrap();
        testing_env!(context.predecessor_account_id(accounts(0)).build());
        assert!(!contract.on_prepared_payment_resolved(
            token_id.clone(),
            payment.nonce,
            quote.commitment_hash.clone(),
            Ok(PaymentExecutionResult::TransferFailed),
        ));

        let payment_after = contract.relay_payment(token_id.clone()).unwrap();
        assert_eq!(
            payment_after.token_transfer_status,
            TokenTransferStatus::TokenTransferFailed
        );
        assert_eq!(
            payment_after.checkout_status,
            Some(CheckoutStatus::RecoveryRequired)
        );
        assert!(contract.is_token_locked(&token_id));
    }
}
