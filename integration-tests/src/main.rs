use near_api::{
    Account, AccountId, Contract, NearToken, NetworkConfig, Signer, Tokens, signer,
};
use near_api_types::transaction::result::TransactionResult;
use near_sandbox::{GenesisAccount, Sandbox};
use serde_json::{Value, json};
use std::sync::Arc;

const CONTRACT_WASM: &str =
    "/mnt/d/relay/target/wasm32-unknown-unknown/release/relay_contract.wasm";
const CONTROLLER_WASM: &str =
    "/mnt/d/relay/target/wasm32-unknown-unknown/release/relay_subaccount.wasm";
const EXTERNAL_NFT_MANIFEST: &str = "/mnt/d/relay/integration-tests/external-nft/Cargo.toml";
const EXTERNAL_NFT_WASM: &str =
    "/mnt/d/relay/integration-tests/external-nft/target/wasm32-unknown-unknown/release/relay_external_nft.wasm";
const RECEIVER_MANIFEST: &str = "/mnt/d/relay/integration-tests/receiver/Cargo.toml";
const RECEIVER_WASM: &str =
    "/mnt/d/relay/integration-tests/receiver/target/wasm32-unknown-unknown/release/relay_transfer_receiver.wasm";
const FUNGIBLE_TOKEN_MANIFEST: &str =
    "/mnt/d/relay/integration-tests/fungible-token/Cargo.toml";
const FUNGIBLE_TOKEN_WASM: &str =
    "/mnt/d/relay/integration-tests/fungible-token/target/wasm32-unknown-unknown/release/relay_test_ft.wasm";
const PAYMENT_RECEIVER_MANIFEST: &str =
    "/mnt/d/relay/integration-tests/payment-receiver/Cargo.toml";
const PAYMENT_RECEIVER_WASM: &str =
    "/mnt/d/relay/integration-tests/payment-receiver/target/wasm32-unknown-unknown/release/relay_payment_receiver.wasm";
const NODE_RUNTIME: &str = "node";
const SANDBOX_ADAPTER_SCRIPT: &str = "/mnt/d/relay/scripts/oneclick-sandbox-integration.js";

type TestResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

struct TestAccount {
    id: AccountId,
    signer: Arc<Signer>,
}

async fn create_account(
    network: &NetworkConfig,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    name: &str,
) -> TestResult<TestAccount> {
    let id: AccountId = format!("{name}.sandbox").parse()?;
    let secret = signer::generate_secret_key()?;
    let account_signer = Signer::from_secret_key(secret.clone())?;

    Account::create_account(id.clone())
        .fund_myself(
            genesis.account_id.as_str().parse()?,
            NearToken::from_near(30),
        )
        .with_public_key(secret.public_key())
        .with_signer(genesis_signer.clone())
        .send_to(network)
        .await?
        .assert_success();

    Ok(TestAccount {
        id,
        signer: account_signer,
    })
}

async fn view(contract: &AccountId, method: &str, args: Value, network: &NetworkConfig) -> TestResult<Value> {
    let result: near_api::Data<Value> = Contract(contract.clone())
        .call_function(method, args)
        .read_only()
        .fetch_from(network)
        .await?;
    Ok(result.data)
}

fn assert_success(label: &str, result: TransactionResult) {
    println!("{label}: {result:?}");
    result.assert_success();
}

fn read_wasm(path: &str) -> TestResult<Vec<u8>> {
    let bytes = std::fs::read(path)?;
    if bytes.is_empty() {
        return Err(format!("WASM artifact is empty: {path}").into());
    }

    println!(
        "artifact: path={path}, bytes={}, sha256={}",
        bytes.len(),
        sha256::digest(&bytes)
    );
    Ok(bytes)
}

fn build_external_nft() -> TestResult<()> {
    let status = std::process::Command::new("cargo")
        .env("CARGO_BUILD_JOBS", "1")
        .args([
            "build",
            "--manifest-path",
            EXTERNAL_NFT_MANIFEST,
            "--target",
            "wasm32-unknown-unknown",
            "--release",
        ])
        .status()?;
    if !status.success() {
        return Err("external NFT contract build failed".into());
    }
    Ok(())
}

fn build_receiver() -> TestResult<()> {
    let status = std::process::Command::new("cargo")
        .env("CARGO_BUILD_JOBS", "1")
        .args([
            "build",
            "--manifest-path",
            RECEIVER_MANIFEST,
            "--target",
            "wasm32-unknown-unknown",
            "--release",
        ])
        .status()?;
    if !status.success() {
        return Err("receiver contract build failed".into());
    }

    Ok(())
}

fn build_fixture(manifest: &str, label: &str) -> TestResult<()> {
    let status = std::process::Command::new("cargo")
        .env("CARGO_BUILD_JOBS", "1")
        .args([
            "build",
            "--manifest-path",
            manifest,
            "--target",
            "wasm32-unknown-unknown",
            "--release",
        ])
        .status()?;
    if !status.success() {
        return Err(format!("{label} contract build failed").into());
    }
    Ok(())
}

async fn send_contract_call(
    contract: &AccountId,
    signer_id: &AccountId,
    account_signer: &Arc<Signer>,
    method: &str,
    args: Value,
    deposit: NearToken,
    network: &NetworkConfig,
) -> TestResult<TransactionResult> {
    Ok(Contract(contract.clone())
        .call_function(method, args)
        .transaction()
        .max_gas()
        .deposit(deposit)
        .with_signer(signer_id.clone(), account_signer.clone())
        .send_to(network)
        .await?)
}

async fn stage_a(
    network: &NetworkConfig,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    contract: &TestAccount,
) -> TestResult<(TestAccount, TestAccount)> {
    let owner = create_account(network, genesis, genesis_signer, "alice-relay").await?;
    let recipient = create_account(network, genesis, genesis_signer, "bob-relay").await?;
    let operator = create_account(network, genesis, genesis_signer, "operator-relay").await?;

    let init = Contract::deploy(contract.id.clone())
        .use_code(read_wasm(CONTRACT_WASM)?)
        .with_init_call(
            "new_sandbox_checkout_test",
            json!({ "owner_id": genesis.account_id }),
        )?
        .max_gas()
        .with_signer(contract.signer.clone())
        .send_to(network)
        .await?;
    assert_success("stage-a deploy/init", init);

    let token_id = "token-1";
    let canonical = format!("{}.{}", token_id, contract.id);
    let mint = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "relay_mint",
        json!({
            "token_id": token_id,
            "token_owner_id": owner.id,
            "token_metadata": {
                "title": "RELAY Token One",
                "description": "Sandbox integration token",
                "media": null,
                "media_hash": null,
                "copies": null,
                "issued_at": null,
                "expires_at": null,
                "starts_at": null,
                "updated_at": null,
                "extra": null,
                "reference": null,
                "reference_hash": null
            },
            "associated_account_id": canonical,
            "initial_credits": 2
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-a mint", mint);

    let token = view(
        &contract.id,
        "nft_token",
        json!({ "token_id": token_id }),
        network,
    )
    .await?;
    assert_eq!(token["owner_id"], owner.id.to_string());
    assert_eq!(token["metadata"]["title"], "RELAY Token One");
    println!("stage-a token view: {token}");

    let approval = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "nft_approve",
        json!({ "token_id": token_id, "account_id": operator.id }),
        NearToken::from_millinear(1),
        network,
    )
    .await?;
    assert_success("stage-a approval", approval);
    let approved = view(
        &contract.id,
        "nft_is_approved",
        json!({
            "token_id": token_id,
            "approved_account_id": operator.id,
            "approval_id": null
        }),
        network,
    )
    .await?;
    assert_eq!(approved, true);

    let transfer = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "nft_transfer",
        json!({
            "receiver_id": recipient.id,
            "token_id": token_id,
            "approval_id": null,
            "memo": null
        }),
        NearToken::from_yoctonear(1),
        network,
    )
    .await?;
    assert_success("stage-a transfer", transfer);

    let transferred = view(
        &contract.id,
        "nft_token",
        json!({ "token_id": token_id }),
        network,
    )
    .await?;
    assert_eq!(transferred["owner_id"], recipient.id.to_string());

    let old_owner_attempt = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_use_credit",
        json!({ "token_id": token_id }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    println!(
        "stage-a old-owner restriction: status={:?}",
        old_owner_attempt.is_failure()
    );
    assert!(old_owner_attempt.is_failure());

    let credits = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": token_id }),
        network,
    )
    .await?;
    assert_eq!(credits["remaining"], 2);
    println!("stage-a passed: NFT transfer and previous-owner checks");
    Ok((owner, recipient))
}

async fn stage_b(
    network: &NetworkConfig,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    contract: &TestAccount,
    new_owner: &TestAccount,
) -> TestResult<()> {
    let controller = read_wasm(CONTROLLER_WASM)?;
    let controller_len = controller.len();

    let store = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "store_controller_code",
        json!({ "code": controller }),
        NearToken::from_near(10),
        network,
    )
    .await?;
    assert_success("stage-b store controller code", store);
    let stored_len = view(
        &contract.id,
        "get_controller_code_len",
        json!({}),
        network,
    )
    .await?;
    assert_eq!(stored_len, controller_len);

    let minimum: Value = view(
        &contract.id,
        "get_provision_minimum_deposit",
        json!({}),
        network,
    )
    .await?;
    let minimum_yocto = minimum
        .get("0")
        .and_then(Value::as_str)
        .or_else(|| minimum.as_str())
        .ok_or("unexpected NearToken JSON shape")?
        .parse::<u128>()?;
    println!("stage-b minimum deposit: {minimum_yocto} yoctoNEAR");
    let provisioning_deposit =
        minimum_yocto + NearToken::from_near(2).as_yoctonear();

    let provision = send_contract_call(
        &contract.id,
        &new_owner.id,
        &new_owner.signer,
        "relay_provision_subaccount",
        json!({ "token_id": "token-1" }),
        NearToken::from_yoctonear(provisioning_deposit),
        network,
    )
    .await?;
    println!("stage-b provisioning and callback: {provision:?}");
    assert_success("stage-b provisioning and callback", provision);

    let child: AccountId = format!("token-1.{}", contract.id).parse()?;
    let binding = view(
        &contract.id,
        "relay_account_binding",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    println!("stage-b binding: {binding}");
    let token_view = view(&contract.id, "nft_token", json!({ "token_id": "token-1" }), network).await?;
    println!("stage-b token: {token_view}");
    assert_eq!(binding["account_id"], child.to_string());
    assert_eq!(binding["is_verified"], true);

    let state = view(
        &contract.id,
        "relay_provisioning_state",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    assert_eq!(state, json!("Completed"));

    let controller_state = view(
        &child,
        "get_controller_state",
        json!({}),
        network,
    )
    .await?;
    assert_eq!(controller_state[0], contract.id.to_string());
    assert_eq!(controller_state[1], "token-1");

    let child_balance = Tokens::account(child.clone())
        .near_balance()
        .fetch_from(network)
        .await?;
    println!(
        "stage-b child controller: account={}, state={}, balance={}",
        child, controller_state, child_balance.total
    );
    println!("stage-b passed; callback outcome recorded above");
    Ok(())
}

async fn stage_c(
    network: &NetworkConfig,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    contract: &TestAccount,
    previous_owner: &TestAccount,
    current_owner: &TestAccount,
) -> TestResult<TestAccount> {
    let recipient = create_account(network, genesis, genesis_signer, "carol-relay").await?;
    let child: AccountId = format!("token-1.{}", contract.id).parse()?;
    let transfer_amount = NearToken::from_near(1);

    let child_before = Tokens::account(child.clone())
        .near_balance()
        .fetch_from(network)
        .await?
        .total;
    let recipient_before = Tokens::account(recipient.id.clone())
        .near_balance()
        .fetch_from(network)
        .await?
        .total;
    assert!(
        child_before > transfer_amount,
        "child account must retain storage reserve after Stage C transfer"
    );

    let dispatch = send_contract_call(
        &contract.id,
        &current_owner.id,
        &current_owner.signer,
        "relay_execute_subaccount",
        json!({
            "token_id": "token-1",
            "action": {
                "TransferNear": {
                    "receiver_id": recipient.id,
                    "amount": transfer_amount.as_yoctonear().to_string()
                }
            }
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-c owner native transfer", dispatch);

    let child_after = Tokens::account(child.clone())
        .near_balance()
        .fetch_from(network)
        .await?
        .total;
    let recipient_after = Tokens::account(recipient.id.clone())
        .near_balance()
        .fetch_from(network)
        .await?
        .total;
    assert_eq!(
        child_before.as_yoctonear() - child_after.as_yoctonear(),
        transfer_amount.as_yoctonear(),
        "child balance must decrease by the dispatched amount"
    );
    assert_eq!(
        recipient_after.as_yoctonear() - recipient_before.as_yoctonear(),
        transfer_amount.as_yoctonear(),
        "recipient balance must increase by the dispatched amount"
    );

    let unauthorized = send_contract_call(
        &contract.id,
        &previous_owner.id,
        &previous_owner.signer,
        "relay_execute_subaccount",
        json!({
            "token_id": "token-1",
            "action": {
                "TransferNear": {
                    "receiver_id": recipient.id,
                    "amount": transfer_amount.as_yoctonear().to_string()
                }
            }
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    println!(
        "stage-c previous-owner dispatch rejected: status={:?}",
        unauthorized.is_failure()
    );
    assert!(unauthorized.is_failure());

    let lifecycle = view(
        &contract.id,
        "is_token_locked",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    assert_eq!(lifecycle, false, "successful callback must unlock the token");
    println!(
        "stage-c passed: child={} recipient={} amount={}",
        child, recipient.id, transfer_amount
    );
    Ok(recipient)
}

async fn stage_d(
    network: &NetworkConfig,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    contract: &TestAccount,
    previous_relay_owner: &TestAccount,
) -> TestResult<TestAccount> {
    let external_nft = create_account(network, genesis, genesis_signer, "external-nft").await?;
    let nft_owner = create_account(network, genesis, genesis_signer, "nft-owner-relay").await?;
    let nft_recipient =
        create_account(network, genesis, genesis_signer, "nft-recipient-relay").await?;
    let next_relay_owner =
        create_account(network, genesis, genesis_signer, "dana-relay").await?;
    let external_wasm = read_wasm(EXTERNAL_NFT_WASM)?;

    let deploy = Contract::deploy(external_nft.id.clone())
        .use_code(external_wasm)
        .with_init_call(
            "new_default_meta",
            json!({ "owner_id": genesis.account_id }),
        )?
        .max_gas()
        .with_signer(external_nft.signer.clone())
        .send_to(network)
        .await?;
    assert_success("stage-d external NFT deploy/init", deploy);

    let token_id = "attached-1";
    let mint = send_contract_call(
        &external_nft.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "mint",
        json!({
            "token_id": token_id,
            "token_owner_id": nft_owner.id,
            "token_metadata": {
                "title": "Attached Test NFT",
                "description": "Custody continuity test asset",
                "media": null,
                "media_hash": null,
                "copies": null,
                "issued_at": null,
                "expires_at": null,
                "starts_at": null,
                "updated_at": null,
                "extra": null,
                "reference": null,
                "reference_hash": null
            }
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-d external NFT mint", mint);

    let child: AccountId = format!("token-1.{}", contract.id).parse()?;
    let custody = send_contract_call(
        &external_nft.id,
        &nft_owner.id,
        &nft_owner.signer,
        "nft_transfer",
        json!({
            "receiver_id": child,
            "token_id": token_id,
            "approval_id": null,
            "memo": null
        }),
        NearToken::from_yoctonear(1),
        network,
    )
    .await?;
    assert_success("stage-d transfer NFT into child", custody);

    let owned_by_child = view(
        &external_nft.id,
        "nft_token",
        json!({ "token_id": token_id }),
        network,
    )
    .await?;
    assert_eq!(owned_by_child["owner_id"], child.to_string());
    println!(
        "stage-d external owner before RELAY transfer: {}",
        owned_by_child["owner_id"]
    );

    let relay_transfer = send_contract_call(
        &contract.id,
        &previous_relay_owner.id,
        &previous_relay_owner.signer,
        "nft_transfer",
        json!({
            "receiver_id": next_relay_owner.id,
            "token_id": "token-1",
            "approval_id": null,
            "memo": null
        }),
        NearToken::from_yoctonear(1),
        network,
    )
    .await?;
    assert_success("stage-d RELAY NFT transfer", relay_transfer);

    let binding = view(
        &contract.id,
        "relay_account_binding",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    assert_eq!(binding["account_id"], child.to_string());
    assert_eq!(binding["is_verified"], true);

    let owned_after_relay_transfer = view(
        &external_nft.id,
        "nft_token",
        json!({ "token_id": token_id }),
        network,
    )
    .await?;
    assert_eq!(owned_after_relay_transfer["owner_id"], child.to_string());
    println!(
        "stage-d external owner after RELAY transfer: {}",
        owned_after_relay_transfer["owner_id"]
    );
    println!("stage-d associated subaccount before/after: {}", child);

    let unauthorized = send_contract_call(
        &contract.id,
        &previous_relay_owner.id,
        &previous_relay_owner.signer,
        "relay_execute_subaccount",
        json!({
            "token_id": "token-1",
            "action": {
                "TransferNep171": {
                    "nft_contract_id": external_nft.id,
                    "receiver_id": nft_recipient.id,
                    "token_id": token_id
                }
            }
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    println!(
        "stage-d previous-owner dispatch rejected: status={:?}",
        unauthorized.is_failure()
    );
    assert!(unauthorized.is_failure());

    let transfer_out = send_contract_call(
        &contract.id,
        &next_relay_owner.id,
        &next_relay_owner.signer,
        "relay_execute_subaccount",
        json!({
            "token_id": "token-1",
            "action": {
                "TransferNep171": {
                    "nft_contract_id": external_nft.id,
                    "receiver_id": nft_recipient.id,
                    "token_id": token_id
                }
            }
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-d current-owner transfer NFT out", transfer_out);

    let transferred_out = view(
        &external_nft.id,
        "nft_token",
        json!({ "token_id": token_id }),
        network,
    )
    .await?;
    assert_eq!(transferred_out["owner_id"], nft_recipient.id.to_string());
    let lifecycle = view(
        &contract.id,
        "is_token_locked",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    assert_eq!(lifecycle, false);
    println!(
        "stage-d passed: external NFT {} transferred from child {} to {}",
        token_id, child, nft_recipient.id
    );
    Ok(next_relay_owner)
}

async fn stage_e(
    network: &NetworkConfig,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    contract: &TestAccount,
    current_owner: &TestAccount,
) -> TestResult<TestAccount> {
    let next_owner = create_account(network, genesis, genesis_signer, "credit-owner-relay").await?;

    let initial = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    assert_eq!(initial["total"], 2);
    assert_eq!(initial["remaining"], 2);
    println!("stage-e initial credits: {}", initial["remaining"]);

    let first_use = send_contract_call(
        &contract.id,
        &current_owner.id,
        &current_owner.signer,
        "relay_use_credit",
        json!({ "token_id": "token-1" }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-e current-owner first credit use", first_use);

    let after_first = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    assert_eq!(after_first["remaining"], 1);
    println!("stage-e credits after first use: {}", after_first["remaining"]);

    let transfer = send_contract_call(
        &contract.id,
        &current_owner.id,
        &current_owner.signer,
        "nft_transfer",
        json!({
            "receiver_id": next_owner.id,
            "token_id": "token-1",
            "approval_id": null,
            "memo": null
        }),
        NearToken::from_yoctonear(1),
        network,
    )
    .await?;
    assert_success("stage-e RELAY NFT transfer", transfer);

    let after_transfer = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    assert_eq!(after_transfer["remaining"], 1);
    println!(
        "stage-e credits after RELAY transfer: {}",
        after_transfer["remaining"]
    );

    let previous_owner_attempt = send_contract_call(
        &contract.id,
        &current_owner.id,
        &current_owner.signer,
        "relay_use_credit",
        json!({ "token_id": "token-1" }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    println!(
        "stage-e previous-owner credit use rejected: status={:?}",
        previous_owner_attempt.is_failure()
    );
    assert!(previous_owner_attempt.is_failure());

    let after_rejection = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    assert_eq!(after_rejection["remaining"], 1);
    println!(
        "stage-e credits after rejected use: {}",
        after_rejection["remaining"]
    );

    let second_use = send_contract_call(
        &contract.id,
        &next_owner.id,
        &next_owner.signer,
        "relay_use_credit",
        json!({ "token_id": "token-1" }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-e current-owner second credit use", second_use);

    let final_credits = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    assert_eq!(final_credits["remaining"], 0);
    println!("stage-e final credits: {}", final_credits["remaining"]);
    println!("stage-e passed: credits remained token-bound and owner-authorized");
    Ok(next_owner)
}

async fn stage_f(
    network: &NetworkConfig,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    contract: &TestAccount,
) -> TestResult<()> {
    let second_token_owner =
        create_account(network, genesis, genesis_signer, "second-credit-owner-relay").await?;
    let unauthorized =
        create_account(network, genesis, genesis_signer, "unauthorized-credit-relay").await?;
    let second_token = "token-2";
    let second_canonical = format!("{}.{}", second_token, contract.id);

    let mint = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "relay_mint",
        json!({
            "token_id": second_token,
            "token_owner_id": second_token_owner.id,
            "token_metadata": {
                "title": "RELAY Token Two",
                "description": "Credit isolation test token",
                "media": null,
                "media_hash": null,
                "copies": null,
                "issued_at": null,
                "expires_at": null,
                "starts_at": null,
                "updated_at": null,
                "extra": null,
                "reference": null,
                "reference_hash": null
            },
            "associated_account_id": second_canonical,
            "initial_credits": 2
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-f second token mint", mint);

    let first_initial = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    let second_initial = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": second_token }),
        network,
    )
    .await?;
    assert_eq!(first_initial["remaining"], 0);
    assert_eq!(second_initial["remaining"], 2);
    println!(
        "stage-f initial credits: token-1={}, token-2={}",
        first_initial["remaining"], second_initial["remaining"]
    );

    let unauthorized_attempt = send_contract_call(
        &contract.id,
        &unauthorized.id,
        &unauthorized.signer,
        "relay_use_credit",
        json!({ "token_id": second_token }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    println!(
        "stage-f unauthorized caller rejected: status={:?}",
        unauthorized_attempt.is_failure()
    );
    assert!(unauthorized_attempt.is_failure());

    let after_unauthorized = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": second_token }),
        network,
    )
    .await?;
    assert_eq!(after_unauthorized["remaining"], 2);

    let first_owner_use = send_contract_call(
        &contract.id,
        &second_token_owner.id,
        &second_token_owner.signer,
        "relay_use_credit",
        json!({ "token_id": second_token }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-f token-2 first credit use", first_owner_use);

    let after_isolated_use = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": second_token }),
        network,
    )
    .await?;
    let first_after_isolated_use = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    assert_eq!(after_isolated_use["remaining"], 1);
    assert_eq!(first_after_isolated_use["remaining"], 0);
    println!(
        "stage-f after token-2 use: token-1={}, token-2={}",
        first_after_isolated_use["remaining"], after_isolated_use["remaining"]
    );

    let second_owner_use = send_contract_call(
        &contract.id,
        &second_token_owner.id,
        &second_token_owner.signer,
        "relay_use_credit",
        json!({ "token_id": second_token }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-f token-2 exhaustion use", second_owner_use);

    let exhausted = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": second_token }),
        network,
    )
    .await?;
    assert_eq!(exhausted["remaining"], 0);

    let exhausted_attempt = send_contract_call(
        &contract.id,
        &second_token_owner.id,
        &second_token_owner.signer,
        "relay_use_credit",
        json!({ "token_id": second_token }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    println!(
        "stage-f exhausted credit rejected: status={:?}",
        exhausted_attempt.is_failure()
    );
    assert!(exhausted_attempt.is_failure());

    let final_first = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": "token-1" }),
        network,
    )
    .await?;
    let final_second = view(
        &contract.id,
        "relay_credits",
        json!({ "token_id": second_token }),
        network,
    )
    .await?;
    assert_eq!(final_first["remaining"], 0);
    assert_eq!(final_second["remaining"], 0);
    println!(
        "stage-f final credits: token-1={}, token-2={}",
        final_first["remaining"], final_second["remaining"]
    );
    println!("stage-f passed: authorization, exhaustion, and token isolation");
    Ok(())
}

async fn deploy_receiver(
    network: &NetworkConfig,
    account: &TestAccount,
    reject: bool,
) -> TestResult<()> {
    let deploy = Contract::deploy(account.id.clone())
        .use_code(read_wasm(RECEIVER_WASM)?)
        .with_init_call("new", json!({ "reject": reject }))?
        .max_gas()
        .with_signer(account.signer.clone())
        .send_to(network)
        .await?;
    assert_success("receiver deploy/init", deploy);
    Ok(())
}

async fn probe_receiver(
    network: &NetworkConfig,
    receiver: &TestAccount,
    sender: &TestAccount,
) -> TestResult<()> {
    let result = send_contract_call(
        &receiver.id,
        &sender.id,
        &sender.signer,
        "nft_on_transfer",
        json!({
            "sender_id": sender.id,
            "previous_owner_id": sender.id,
            "token_id": "probe",
            "msg": "direct"
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("receiver direct nft_on_transfer probe", result);
    Ok(())
}

async fn stage_g(
    network: &NetworkConfig,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    contract: &TestAccount,
    provisioned_owner: &TestAccount,
    previous_owner: &TestAccount,
) -> TestResult<TestAccount> {
    let wrapped_near_fixture = stage_h(
        network,
        genesis,
        genesis_signer,
        contract,
        provisioned_owner,
        previous_owner,
    )
    .await?;
    let owner = create_account(network, genesis, genesis_signer, "stage-g-owner").await?;
    let approval = create_account(network, genesis, genesis_signer, "stage-g-approval").await?;
    let accept = create_account(network, genesis, genesis_signer, "stage-g-accept").await?;
    let reject = create_account(network, genesis, genesis_signer, "stage-g-reject").await?;
    deploy_receiver(network, &accept, false).await?;
    deploy_receiver(network, &reject, true).await?;

    for token_id in ["token-3", "token-4"] {
        let mint = send_contract_call(
            &contract.id,
            &genesis.account_id.as_str().parse()?,
            genesis_signer,
            "relay_mint",
            json!({
                "token_id": token_id,
                "token_owner_id": owner.id,
                "token_metadata": {
                    "title": token_id,
                    "description": "Stage G transfer-call test",
                    "media": null, "media_hash": null, "copies": null,
                    "issued_at": null, "expires_at": null, "starts_at": null,
                    "updated_at": null, "extra": null, "reference": null,
                    "reference_hash": null
                },
                "associated_account_id": format!("{}.{}", token_id, contract.id),
                "initial_credits": 1
            }),
            NearToken::from_near(1),
            network,
        )
        .await?;
        assert_success("stage-g RELAY mint", mint);
    }

    async fn deploy_payment_receiver(
        network: &NetworkConfig,
        account: &TestAccount,
        mode: &str,
    ) -> TestResult<()> {
        let deploy = Contract::deploy(account.id.clone())
            .use_code(read_wasm(PAYMENT_RECEIVER_WASM)?)
            .with_init_call("new", json!({ "mode": mode }))?
            .max_gas()
            .with_signer(account.signer.clone())
            .send_to(network)
            .await?;
        assert_success("stage-h payment receiver deploy/init", deploy);
        Ok(())
    }

    async fn stage_h(
        network: &NetworkConfig,
        genesis: &GenesisAccount,
        genesis_signer: &Arc<Signer>,
        contract: &TestAccount,
        owner: &TestAccount,
        previous_owner: &TestAccount,
    ) -> TestResult<TestAccount> {
        build_fixture(FUNGIBLE_TOKEN_MANIFEST, "fungible token")?;
        build_fixture(PAYMENT_RECEIVER_MANIFEST, "payment receiver")?;

        let token = create_account(network, genesis, genesis_signer, "stage-h-ft").await?;
        let accepting = create_account(network, genesis, genesis_signer, "stage-h-accept").await?;
        let rejecting = create_account(network, genesis, genesis_signer, "stage-h-reject").await?;
        let partial = create_account(network, genesis, genesis_signer, "stage-h-partial").await?;
        let callback_failure =
            create_account(network, genesis, genesis_signer, "stage-h-callback-failure").await?;
        let unrelated = create_account(network, genesis, genesis_signer, "stage-h-unrelated").await?;
        let unregistered =
            create_account(network, genesis, genesis_signer, "stage-h-unregistered").await?;
        let next_owner = create_account(network, genesis, genesis_signer, "stage-h-next").await?;
        deploy_payment_receiver(network, &accepting, "accept").await?;
        deploy_payment_receiver(network, &rejecting, "reject").await?;
        deploy_payment_receiver(network, &partial, "partial").await?;
        deploy_payment_receiver(network, &callback_failure, "fail").await?;
        let token_deploy = Contract::deploy(token.id.clone())
            .use_code(read_wasm(FUNGIBLE_TOKEN_WASM)?)
            .with_init_call("new", json!({ "owner_id": token.id }))?
            .max_gas()
            .with_signer(token.signer.clone())
            .send_to(network)
            .await?;
        assert_success("stage-h token deploy/init", token_deploy);

        let binding = view(
            &contract.id,
            "relay_account_binding",
            json!({ "token_id": "token-1" }),
            network,
        )
        .await?;
        let canonical: AccountId = binding["account_id"].as_str().ok_or("missing canonical account")?.parse()?;
        assert_eq!(binding["is_verified"], true);

        let insufficient_storage = send_contract_call(
            &token.id,
            &unregistered.id,
            &unregistered.signer,
            "storage_deposit",
            json!({ "account_id": unregistered.id, "registration_only": true }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert!(insufficient_storage.is_failure());

        let storage = send_contract_call(
            &token.id,
            &owner.id,
            &owner.signer,
            "storage_deposit",
            json!({ "account_id": canonical, "registration_only": true }),
            NearToken::from_near(1),
            network,
        )
        .await?;
        assert_success("stage-h canonical FT storage registration", storage);
        for receiver in [&accepting, &rejecting, &partial, &callback_failure] {
            let registration = send_contract_call(
                &token.id,
                &receiver.id,
                &receiver.signer,
                "storage_deposit",
                json!({ "account_id": receiver.id, "registration_only": true }),
                NearToken::from_near(1),
                network,
            )
            .await?;
            assert_success("stage-h receiver FT storage registration", registration);
        }

        let mint = send_contract_call(
            &token.id,
            &token.id,
            &token.signer,
            "mint",
            json!({ "account_id": canonical, "amount": "1000" }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert_success("stage-h mint canonical FT balance", mint);
        let balance = view(
            &token.id,
            "ft_balance_of",
            json!({ "account_id": canonical }),
            network,
        )
        .await?;
        assert_eq!(balance, json!("1000"));
        let current_token = view(
            &contract.id,
            "nft_token",
            json!({ "token_id": "token-1" }),
            network,
        )
        .await?;
        assert_eq!(current_token["owner_id"], owner.id.to_string());
        assert_eq!(
            view(&contract.id, "is_token_locked", json!({ "token_id": "token-1" }), network).await?,
            json!(false)
        );

        let direct_payment = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": accepting.id,
                "amount": "100",
                "payment_id": "stage-h-direct",
                "deadline": null,
                "transfer_call": false,
                "msg": ""
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert_success("stage-h bounded ft_transfer payment", direct_payment);
        let direct_record = view(&token.id, "last_transfer", json!({}), network).await?;
        assert_eq!(direct_record["method"], "ft_transfer");
        assert_eq!(direct_record["sender_id"], canonical.to_string());
        assert_eq!(direct_record["receiver_id"], accepting.id.to_string());
        assert_eq!(direct_record["amount"], json!("100"));
        let payment = view(&contract.id, "relay_payment", json!({ "token_id": "token-1" }), network).await?;
        assert_eq!(
            payment["token_transfer_status"],
            json!("TokenTransferCompleted")
        );
        assert_eq!(payment["checkout_status"], Value::Null);
        let canonical_balance = view(&token.id, "ft_balance_of", json!({ "account_id": canonical }), network).await?;
        let receiver_balance = view(&token.id, "ft_balance_of", json!({ "account_id": accepting.id }), network).await?;
        assert_eq!(canonical_balance, json!("900"));
        assert_eq!(receiver_balance, json!("100"));

        let accepted_call = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": accepting.id,
                "amount": "100",
                "payment_id": "stage-h-accepted-call",
                "deadline": null,
                "transfer_call": true,
                "msg": "accept"
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert_success("stage-h accepted ft_transfer_call", accepted_call);
        let payment = view(&contract.id, "relay_payment", json!({ "token_id": "token-1" }), network).await?;
        assert_eq!(
            payment["token_transfer_status"],
            json!("TokenTransferCompleted")
        );
        assert_eq!(payment["checkout_status"], Value::Null);
        let receiver_record = view(&accepting.id, "last_transfer", json!({}), network).await?;
        assert_eq!(receiver_record["sender_id"], canonical.to_string());
        assert_eq!(receiver_record["amount"], json!("100"));
        assert_eq!(receiver_record["msg"], "accept");
        assert_eq!(receiver_record["accepted"], true);
        let resolution = view(&token.id, "last_resolution", json!({}), network).await?;
        assert_eq!(resolution["sender_id"], canonical.to_string());
        assert_eq!(resolution["receiver_id"], accepting.id.to_string());
        assert_eq!(resolution["amount_used"], json!("100"));
        assert_eq!(resolution["amount_refunded"], json!("0"));
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": canonical }), network).await?, json!("800"));
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": accepting.id }), network).await?, json!("200"));
        assert_eq!(view(&contract.id, "is_token_locked", json!({ "token_id": "token-1" }), network).await?, json!(false));

        let partial_call = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": partial.id,
                "amount": "40",
                "payment_id": "stage-h-partial",
                "deadline": null,
                "transfer_call": true,
                "msg": "partial"
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert_success("stage-h partial-use ft_transfer_call", partial_call);
        let payment = view(&contract.id, "relay_payment", json!({ "token_id": "token-1" }), network).await?;
        assert_eq!(
            payment["token_transfer_status"],
            json!("TokenTransferPartiallyRefunded")
        );
        assert_eq!(payment["resolved_amount_used"], json!("20"));
        assert_eq!(payment["checkout_status"], Value::Null);
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": canonical }), network).await?, json!("780"));
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": partial.id }), network).await?, json!("20"));
        assert_eq!(view(&contract.id, "is_token_locked", json!({ "token_id": "token-1" }), network).await?, json!(false));

        let failed_receiver_call = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": callback_failure.id,
                "amount": "30",
                "payment_id": "stage-h-receiver-failure",
                "deadline": null,
                "transfer_call": true,
                "msg": "fail"
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert_success("stage-h receiver callback failure is resolver-refunded", failed_receiver_call);
        let payment = view(&contract.id, "relay_payment", json!({ "token_id": "token-1" }), network).await?;
        assert_eq!(
            payment["token_transfer_status"],
            json!("TokenTransferRefunded")
        );
        assert_eq!(payment["resolved_amount_used"], json!("0"));
        assert_eq!(payment["checkout_status"], Value::Null);
        let resolution = view(&token.id, "last_resolution", json!({}), network).await?;
        assert_eq!(resolution["amount_used"], json!("0"));
        assert_eq!(resolution["amount_refunded"], json!("30"));
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": canonical }), network).await?, json!("780"));
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": callback_failure.id }), network).await?, json!("0"));

        let rejected = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": rejecting.id,
                "amount": "50",
                "payment_id": "stage-h-rejected",
                "deadline": null,
                "transfer_call": true,
                "msg": "reject"
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert_success("stage-h rejected payment/refund", rejected);
        let payment = view(&contract.id, "relay_payment", json!({ "token_id": "token-1" }), network).await?;
        assert_eq!(
            payment["token_transfer_status"],
            json!("TokenTransferRefunded")
        );
        assert_eq!(payment["resolved_amount_used"], json!("0"));
        assert_eq!(payment["checkout_status"], Value::Null);
        let reject_record = view(&rejecting.id, "last_transfer", json!({}), network).await?;
        assert_eq!(reject_record["sender_id"], canonical.to_string());
        assert_eq!(reject_record["amount"], json!("50"));
        assert_eq!(reject_record["msg"], "reject");
        assert_eq!(reject_record["accepted"], false);
        let resolution = view(&token.id, "last_resolution", json!({}), network).await?;
        assert_eq!(resolution["amount_used"], json!("0"));
        assert_eq!(resolution["amount_refunded"], json!("50"));
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": canonical }), network).await?, json!("780"));
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": rejecting.id }), network).await?, json!("0"));

        let direct_controller = send_contract_call(
            &canonical,
            &unrelated.id,
            &unrelated.signer,
            "execute",
            json!({
                "action": {
                    "TransferNear": {
                        "receiver_id": unrelated.id,
                        "amount": "1"
                    }
                }
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert!(direct_controller.is_failure());

        let unauthorized_payment = send_contract_call(
            &contract.id,
            &unrelated.id,
            &unrelated.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": accepting.id,
                "amount": "10",
                "payment_id": "stage-h-unrelated",
                "deadline": null,
                "transfer_call": false,
                "msg": ""
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert!(unauthorized_payment.is_failure());
        let previous_owner_attempt = send_contract_call(
            &contract.id,
            &previous_owner.id,
            &previous_owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": accepting.id,
                "amount": "10",
                "payment_id": "stage-h-previous-owner",
                "deadline": null,
                "transfer_call": false,
                "msg": ""
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert!(previous_owner_attempt.is_failure());

        let raw_transfer_without_yocto = send_contract_call(
            &token.id,
            &unrelated.id,
            &unrelated.signer,
            "ft_transfer",
            json!({ "receiver_id": accepting.id, "amount": "1", "memo": null }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert!(raw_transfer_without_yocto.is_failure());

        let unregistered_receiver_payment = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": unregistered.id,
                "amount": "10",
                "payment_id": "stage-h-unregistered",
                "deadline": null,
                "transfer_call": false,
                "msg": ""
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert_success("stage-h unregistered receiver fails without success status", unregistered_receiver_payment);
        let payment = view(&contract.id, "relay_payment", json!({ "token_id": "token-1" }), network).await?;
        assert_eq!(
            payment["token_transfer_status"],
            json!("TokenTransferFailed")
        );
        assert_eq!(payment["checkout_status"], Value::Null);
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": canonical }), network).await?, json!("780"));
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": unregistered.id }), network).await?, json!("0"));

        let insufficient_balance = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": accepting.id,
                "amount": "10000",
                "payment_id": "stage-h-insufficient-balance",
                "deadline": null,
                "transfer_call": false,
                "msg": ""
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert_success("stage-h insufficient token balance fails without success status", insufficient_balance);
        let payment = view(&contract.id, "relay_payment", json!({ "token_id": "token-1" }), network).await?;
        assert_eq!(
            payment["token_transfer_status"],
            json!("TokenTransferFailed")
        );
        assert_eq!(payment["checkout_status"], Value::Null);
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": canonical }), network).await?, json!("780"));
        assert_eq!(view(&token.id, "ft_balance_of", json!({ "account_id": accepting.id }), network).await?, json!("200"));

        let binding_before_transfer = view(
            &contract.id,
            "relay_account_binding",
            json!({ "token_id": "token-1" }),
            network,
        )
        .await?;
        let nft_transfer = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "nft_transfer",
            json!({
                "receiver_id": next_owner.id,
                "token_id": "token-1",
                "approval_id": null,
                "memo": null
            }),
            NearToken::from_yoctonear(1),
            network,
        )
        .await?;
        assert_success("stage-h transfer RELAY NFT after terminal payment", nft_transfer);
        let binding_after_transfer = view(
            &contract.id,
            "relay_account_binding",
            json!({ "token_id": "token-1" }),
            network,
        )
        .await?;
        assert_eq!(binding_before_transfer["account_id"], binding_after_transfer["account_id"]);

        let old_owner_payment = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": accepting.id,
                "amount": "10",
                "payment_id": "stage-h-old-after-transfer",
                "deadline": null,
                "transfer_call": false,
                "msg": ""
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert!(old_owner_payment.is_failure());
        let new_owner_payment = send_contract_call(
            &contract.id,
            &next_owner.id,
            &next_owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": accepting.id,
                "amount": "25",
                "payment_id": "stage-h-new-owner",
                "deadline": null,
                "transfer_call": false,
                "msg": ""
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert_success("stage-h new RELAY owner payment", new_owner_payment);

        let transfer_back = send_contract_call(
            &contract.id,
            &next_owner.id,
            &next_owner.signer,
            "nft_transfer",
            json!({
                "receiver_id": owner.id,
                "token_id": "token-1",
                "approval_id": null,
                "memo": null
            }),
            NearToken::from_yoctonear(1),
            network,
        )
        .await?;
        assert_success("stage-h transfer RELAY NFT back to preserve later stages", transfer_back);
        assert_eq!(
            view(&contract.id, "relay_account_binding", json!({ "token_id": "token-1" }), network).await?["account_id"],
            canonical.to_string()
        );

        let enable_resolver_failure = send_contract_call(
            &token.id,
            &token.id,
            &token.signer,
            "set_resolver_failure",
            json!({ "fail": true }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert_success("stage-h enable explicit local resolver failure", enable_resolver_failure);
        let unresolved_payment = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": accepting.id,
                "amount": "20",
                "payment_id": "stage-h-unresolved",
                "deadline": null,
                "transfer_call": true,
                "msg": "accept-but-resolver-fails"
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert_success("stage-h unresolved transfer-call enters recovery", unresolved_payment);
        let payment = view(&contract.id, "relay_payment", json!({ "token_id": "token-1" }), network).await?;
        assert_eq!(
            payment["token_transfer_status"],
            json!("RecoveryRequired")
        );
        assert_eq!(payment["checkout_status"], Value::Null);
        assert_eq!(view(&contract.id, "is_token_locked", json!({ "token_id": "token-1" }), network).await?, json!(true));
        assert_eq!(
            view(&token.id, "ft_balance_of", json!({ "account_id": canonical }), network).await?,
            json!("735")
        );
        assert_eq!(
            view(&token.id, "ft_balance_of", json!({ "account_id": accepting.id }), network).await?,
            json!("245")
        );
        let fabricated_recovery_by_owner = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "on_payment_resolved",
            json!({
                "token_id": "token-1",
                "expected_nonce": payment["nonce"]
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert!(fabricated_recovery_by_owner.is_failure());
        let fabricated_recovery_by_previous_owner = send_contract_call(
            &contract.id,
            &previous_owner.id,
            &previous_owner.signer,
            "on_payment_resolved",
            json!({
                "token_id": "token-1",
                "expected_nonce": payment["nonce"]
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert!(fabricated_recovery_by_previous_owner.is_failure());
        let payment_after_forgery = view(
            &contract.id,
            "relay_payment",
            json!({ "token_id": "token-1" }),
            network,
        )
        .await?;
        assert_eq!(
            payment_after_forgery["token_transfer_status"],
            json!("RecoveryRequired")
        );
        assert_eq!(
            view(&contract.id, "is_token_locked", json!({ "token_id": "token-1" }), network).await?,
            json!(true)
        );
        let blocked_transfer = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "nft_transfer",
            json!({
                "receiver_id": next_owner.id,
                "token_id": "token-1",
                "approval_id": null,
                "memo": null
            }),
            NearToken::from_yoctonear(1),
            network,
        )
        .await?;
        assert!(blocked_transfer.is_failure());
        let blocked_second_payment = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_start_payment",
            json!({
                "token_id": "token-1",
                "source_ft_contract": token.id,
                "receiver_id": accepting.id,
                "amount": "1",
                "payment_id": "stage-h-blocked-second",
                "deadline": null,
                "transfer_call": false,
                "msg": ""
            }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert!(blocked_second_payment.is_failure());
        let blocked_credit = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_use_credit",
            json!({ "token_id": "token-1" }),
            NearToken::from_yoctonear(0),
            network,
        )
        .await?;
        assert!(blocked_credit.is_failure());
        assert_eq!(
            view(&token.id, "ft_balance_of", json!({ "account_id": canonical }), network).await?,
            json!("735")
        );
        assert_eq!(
            view(&token.id, "ft_balance_of", json!({ "account_id": accepting.id }), network).await?,
            json!("245")
        );
        assert_eq!(
            view(&token.id, "ft_balance_of", json!({ "account_id": unrelated.id }), network).await?,
            json!("0")
        );
        println!("stage-h passed: NEP-141 custody, authorization, accepted/refunded/failed/recovery outcomes, and ownership continuity");
        Ok(token)
    }

    let approve_accept = send_contract_call(
        &contract.id, &owner.id, &owner.signer, "nft_approve",
        json!({"token_id":"token-3","account_id":approval.id}),
        NearToken::from_millinear(1), network,
    ).await?;
    assert_success("stage-g acceptance approval", approve_accept);
    let before_accept = view(&contract.id, "nft_is_approved", json!({
        "token_id":"token-3","approved_account_id":approval.id,"approval_id":null
    }), network).await?;

    let accept_call = send_contract_call(
        &contract.id, &owner.id, &owner.signer, "nft_transfer_call",
        json!({"receiver_id":accept.id,"token_id":"token-3","approval_id":null,
               "memo":null,"msg":"accept"}),
        NearToken::from_yoctonear(1), network,
    ).await?;
    assert_success("stage-g acceptance transfer-call", accept_call);
    let accept_token = view(&contract.id, "nft_token", json!({"token_id":"token-3"}), network).await?;
    let accept_locked = view(&contract.id, "is_token_locked", json!({"token_id":"token-3"}), network).await?;
    let after_accept = view(&contract.id, "nft_is_approved", json!({
        "token_id":"token-3","approved_account_id":approval.id,"approval_id":null
    }), network).await?;
    assert_eq!(accept_token["owner_id"], accept.id.to_string());
    assert_eq!(accept_locked, false);
    assert_eq!(after_accept, false);
    let old_owner = send_contract_call(
        &contract.id, &owner.id, &owner.signer, "relay_use_credit",
        json!({"token_id":"token-3"}), NearToken::from_yoctonear(0), network,
    ).await?;
    assert!(old_owner.is_failure());
    println!("stage-g acceptance: final_owner={}, approval_before={}, approval_after={}, locked={}, old_owner_rejected={}",
        accept_token["owner_id"], before_accept, after_accept, accept_locked, old_owner.is_failure());

    let approve_reject = send_contract_call(
        &contract.id, &owner.id, &owner.signer, "nft_approve",
        json!({"token_id":"token-4","account_id":approval.id}),
        NearToken::from_millinear(1), network,
    ).await?;
    assert_success("stage-g rejection approval", approve_reject);
    let before_reject = view(&contract.id, "nft_is_approved", json!({
        "token_id":"token-4","approved_account_id":approval.id,"approval_id":null
    }), network).await?;
    let reject_call = send_contract_call(
        &contract.id, &owner.id, &owner.signer, "nft_transfer_call",
        json!({"receiver_id":reject.id,"token_id":"token-4","approval_id":null,
               "memo":null,"msg":"reject"}),
        NearToken::from_yoctonear(1), network,
    ).await?;
    assert_success("stage-g rejection transfer-call", reject_call);
    let reject_token = view(&contract.id, "nft_token", json!({"token_id":"token-4"}), network).await?;
    let reject_locked = view(&contract.id, "is_token_locked", json!({"token_id":"token-4"}), network).await?;
    let after_reject = view(&contract.id, "nft_is_approved", json!({
        "token_id":"token-4","approved_account_id":approval.id,"approval_id":null
    }), network).await?;
    assert_eq!(reject_token["owner_id"], owner.id.to_string());
    assert_eq!(reject_locked, false);
    assert_eq!(after_reject, true);
    let owner_action = send_contract_call(
        &contract.id, &owner.id, &owner.signer, "relay_use_credit",
        json!({"token_id":"token-4"}), NearToken::from_yoctonear(0), network,
    ).await?;
    assert_success("stage-g owner action after rejection", owner_action);
    println!("stage-g rejection: final_owner={}, approval_before={}, approval_after={}, locked={}, owner_action_succeeded=true",
        reject_token["owner_id"], before_reject, after_reject, reject_locked);
    println!("stage-g passed: acceptance and rejection resolver paths completed");
    Ok(wrapped_near_fixture)
}

fn quote_commitment(
    token_id: &str,
    parent_contract_id: &AccountId,
    associated_account_id: &AccountId,
    owner_id: &AccountId,
    nonce: u64,
    provider_signature_hash: &str,
    source_amount: &str,
    expected_output: &str,
    minimum_output: &str,
    recipient: &str,
    deposit_address: &str,
    deposit_memo: &str,
    request_deadline: &str,
    provider_quote_deadline: &str,
    provider_inactive_deadline: Option<&str>,
) -> String {
    let fields = [
        "RELAY-1CLICK-QUOTE-AUTH-V2".to_string(),
        token_id.to_string(),
        parent_contract_id.to_string(),
        associated_account_id.to_string(),
        owner_id.to_string(),
        nonce.to_string(),
        provider_signature_hash.to_string(),
        "nep141:wrap.near".to_string(),
        "24".to_string(),
        "ORIGIN_CHAIN".to_string(),
        source_amount.to_string(),
        "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near".to_string(),
        "18".to_string(),
        expected_output.to_string(),
        minimum_output.to_string(),
        recipient.to_string(),
        deposit_address.to_string(),
        "1".to_string(),
        deposit_memo.to_string(),
        associated_account_id.to_string(),
        "ORIGIN_CHAIN".to_string(),
        request_deadline.to_string(),
        provider_quote_deadline.to_string(),
        if provider_inactive_deadline.is_some() {
            "1".to_string()
        } else {
            "0".to_string()
        },
        provider_inactive_deadline.unwrap_or_default().to_string(),
    ];
    let mut bytes = Vec::new();
    for field in fields {
        let value = field.as_bytes();
        bytes.extend_from_slice(&(value.len() as u32).to_be_bytes());
        bytes.extend_from_slice(value);
    }
    sha256::digest(&bytes)
}

async fn stage_i(
    network: &NetworkConfig,
    rpc_url: &str,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    contract: &TestAccount,
) -> TestResult<()> {
    let owner = create_account(network, genesis, genesis_signer, "stage-i-owner").await?;
    let next_owner = create_account(network, genesis, genesis_signer, "stage-i-next").await?;
    let unrelated = create_account(network, genesis, genesis_signer, "stage-i-unrelated").await?;
    let token_id = "quoteauth";
    let canonical: AccountId = format!("{token_id}.{}", contract.id).parse()?;
    let mint = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "relay_mint",
        json!({
            "token_id": token_id,
            "token_owner_id": owner.id,
            "token_metadata": {
                "title": "Quote authorization fixture",
                "description": "Sandbox quote authorization mechanics only",
                "media": null, "media_hash": null, "copies": null,
                "issued_at": null, "expires_at": null, "starts_at": null,
                "updated_at": null, "extra": null, "reference": null,
                "reference_hash": null
            },
            "associated_account_id": canonical,
            "initial_credits": 1
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-i mint quote authorization token", mint);

    let minimum: Value = view(
        &contract.id,
        "get_provision_minimum_deposit",
        json!({}),
        network,
    )
    .await?;
    let minimum_yocto = minimum
        .get("0")
        .and_then(Value::as_str)
        .or_else(|| minimum.as_str())
        .ok_or("unexpected NearToken JSON shape")?
        .parse::<u128>()?;
    let provision = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_provision_subaccount",
        json!({ "token_id": token_id }),
        NearToken::from_yoctonear(minimum_yocto + NearToken::from_near(2).as_yoctonear()),
        network,
    )
    .await?;
    assert_success("stage-i provision canonical account", provision);
    assert_eq!(
        view(
            &contract.id,
            "relay_account_binding",
            json!({ "token_id": token_id }),
            network,
        )
        .await?["is_verified"],
        true
    );

    let prepared = run_sandbox_adapter_fixture(
        "prepare",
        rpc_url,
        &contract.id,
        token_id,
        "primary",
    )?;
    let authorization_args = prepared["authorizationArgs"].clone();
    let quote_args = authorization_args["quote"].clone();
    let commitment = quote_args["commitment_hash"]
        .as_str()
        .ok_or("adapter omitted quote commitment")?
        .to_string();

    let unauthorized = send_contract_call(
        &contract.id,
        &unrelated.id,
        &unrelated.signer,
        "relay_authorize_quote",
        authorization_args.clone(),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(unauthorized.is_failure());
    let previous_owner_attempt = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "relay_authorize_quote",
        authorization_args.clone(),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(previous_owner_attempt.is_failure());

    let authorized = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        authorization_args.clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-i current owner authorizes exact quote commitment", authorized);
    assert_eq!(
        view(&contract.id, "relay_quote_nonce", json!({ "token_id": token_id }), network)
            .await?,
        json!("1")
    );
    let duplicate = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        authorization_args.clone(),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(duplicate.is_failure());

    let transferred = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "nft_transfer",
        json!({
            "receiver_id": next_owner.id,
            "token_id": token_id,
            "approval_id": null,
            "memo": null
        }),
        NearToken::from_yoctonear(1),
        network,
    )
    .await?;
    assert_success("stage-i NFT transfer remains available with a quote reservation", transferred);
    let old_authorization = view(
        &contract.id,
        "relay_quote_authorization",
        json!({ "token_id": token_id, "commitment_hash": commitment }),
        network,
    )
    .await?;
    assert_eq!(old_authorization["status"], json!("InvalidatedOwnership"));
    assert_eq!(
        view(&contract.id, "relay_quote_nonce", json!({ "token_id": token_id }), network)
            .await?,
        json!("2")
    );
    let old_owner_consumption = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_consume_quote_authorization",
        json!({ "token_id": token_id, "commitment_hash": commitment }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(old_owner_consumption.is_failure());

    let next_prepared = run_sandbox_adapter_fixture(
        "prepare",
        rpc_url,
        &contract.id,
        token_id,
        "alternate",
    )?;
    let next_authorization_args = next_prepared["authorizationArgs"].clone();
    let next_quote = next_authorization_args["quote"].clone();
    let next_commitment = next_quote["commitment_hash"]
        .as_str()
        .ok_or("adapter omitted new-owner quote commitment")?
        .to_string();
    let next_authorized = send_contract_call(
        &contract.id,
        &next_owner.id,
        &next_owner.signer,
        "relay_authorize_quote",
        next_authorization_args,
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-i new owner authorizes a fresh nonce-bound quote", next_authorized);
    let consumed = send_contract_call(
        &contract.id,
        &next_owner.id,
        &next_owner.signer,
        "relay_consume_quote_authorization",
        json!({ "token_id": token_id, "commitment_hash": next_commitment }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-i current owner consumes quote authorization", consumed);
    assert_eq!(
        view(
            &contract.id,
            "relay_quote_authorization",
            json!({ "token_id": token_id, "commitment_hash": next_commitment }),
            network,
        )
        .await?["status"],
        json!("Consumed")
    );
    println!("stage-i passed: chain-bound quote nonce, exact commitment, owner authorization, transfer invalidation, and replay checks");
    Ok(())
}

fn run_sandbox_adapter_fixture(
    mode: &str,
    rpc_url: &str,
    relay_contract_id: &AccountId,
    token_id: &str,
    variant: &str,
) -> TestResult<Value> {
    run_sandbox_adapter_fixture_with_format(
        mode,
        rpc_url,
        relay_contract_id,
        token_id,
        variant,
        "prefixed",
    )
}

fn run_sandbox_adapter_fixture_with_format(
    mode: &str,
    rpc_url: &str,
    relay_contract_id: &AccountId,
    token_id: &str,
    variant: &str,
    signature_format: &str,
) -> TestResult<Value> {
    let output = std::process::Command::new(NODE_RUNTIME)
        .args([
            SANDBOX_ADAPTER_SCRIPT,
            mode,
            rpc_url,
            relay_contract_id.as_str(),
            token_id,
            variant,
            signature_format,
        ])
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "Sandbox adapter fixture {mode} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn run_sandbox_adapter_fixture_full(
    mode: &str,
    rpc_url: &str,
    relay_contract_id: &AccountId,
    token_id: &str,
    variant: &str,
    signature_format: &str,
    deposit_address: Option<&str>,
    deposit_memo: Option<&str>,
    amount: Option<&str>,
) -> TestResult<Value> {
    let mut cmd = std::process::Command::new(NODE_RUNTIME);
    cmd.args([
        SANDBOX_ADAPTER_SCRIPT,
        mode,
        rpc_url,
        relay_contract_id.as_str(),
        token_id,
        variant,
        signature_format,
    ]);
    if let Some(addr) = deposit_address {
        cmd.arg(addr);
        if let Some(memo) = deposit_memo {
            cmd.arg(memo);
        } else {
            cmd.arg("null");
        }
        if let Some(amt) = amount {
            cmd.arg(amt);
        }
    }
    let output = cmd.output()?;
    if !output.status.success() {
        return Err(format!(
            "Sandbox adapter fixture {mode} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn run_sandbox_adapter_fixture_expect_failure(
    mode: &str,
    rpc_url: &str,
    relay_contract_id: &AccountId,
    token_id: &str,
    variant: &str,
) -> TestResult<String> {
    let output = std::process::Command::new(NODE_RUNTIME)
        .args([
            SANDBOX_ADAPTER_SCRIPT,
            mode,
            rpc_url,
            relay_contract_id.as_str(),
            token_id,
            variant,
        ])
        .output()?;
    if output.status.success() {
        return Err(format!("Sandbox adapter fixture {mode} unexpectedly succeeded").into());
    }
    Ok(String::from_utf8_lossy(&output.stderr).into_owned())
}

async fn stage_j(
    sandbox: &Sandbox,
    network: &NetworkConfig,
    rpc_url: &str,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    contract: &TestAccount,
) -> TestResult<()> {
    let owner = create_account(network, genesis, genesis_signer, "stage-j-owner").await?;
    let next_owner = create_account(network, genesis, genesis_signer, "stage-j-next").await?;
    let token_id = "adapterquote";
    let canonical: AccountId = format!("{token_id}.{}", contract.id).parse()?;
    let mint = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "relay_mint",
        json!({
            "token_id": token_id,
            "token_owner_id": owner.id,
            "token_metadata": {
                "title": "Adapter Sandbox quote fixture",
                "description": "Local deterministic signature fixture only",
                "media": null, "media_hash": null, "copies": null,
                "issued_at": null, "expires_at": null, "starts_at": null,
                "updated_at": null, "extra": null, "reference": null,
                "reference_hash": null
            },
            "associated_account_id": canonical,
            "initial_credits": 1
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-j mint adapter integration token", mint);

    let minimum: Value = view(
        &contract.id,
        "get_provision_minimum_deposit",
        json!({}),
        network,
    )
    .await?;
    let minimum_yocto = minimum
        .get("0")
        .and_then(Value::as_str)
        .or_else(|| minimum.as_str())
        .ok_or("unexpected NearToken JSON shape")?
        .parse::<u128>()?;
    let provision = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_provision_subaccount",
        json!({ "token_id": token_id }),
        NearToken::from_yoctonear(minimum_yocto + NearToken::from_near(2).as_yoctonear()),
        network,
    )
    .await?;
    assert_success("stage-j provision adapter integration account", provision);

    let prepared = run_sandbox_adapter_fixture_with_format(
        "prepare",
        rpc_url,
        &contract.id,
        token_id,
        "primary",
        "prefixless",
    )?;
    assert_eq!(prepared["fixtureLabel"], "local deterministic signed quote fixture; not a provider quote");
    assert_eq!(prepared["signatureFormat"], "prefixless");
    assert_eq!(prepared["canonicalPrefixMatch"], true);
    assert_eq!(
        prepared["providerSignatureHash"],
        prepared["alternateProviderSignatureHash"]
    );
    assert_eq!(prepared["context"]["ownerAccountId"], owner.id.as_str());
    assert_eq!(
        prepared["context"]["associatedAccountId"],
        canonical.as_str()
    );
    assert_eq!(prepared["context"]["quoteNonce"], "0");

    let authorization_args = prepared["authorizationArgs"].clone();
    let quote = authorization_args["quote"].clone();
    let authorize = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        authorization_args.clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-j adapter-generated quote authorized on Sandbox", authorize);
    let commitment = quote["commitment_hash"]
        .as_str()
        .ok_or("adapter omitted quote commitment")?;
    let stored = view(
        &contract.id,
        "relay_quote_authorization",
        json!({ "token_id": token_id, "commitment_hash": commitment }),
        network,
    )
    .await?;
    assert_eq!(stored["status"], json!("Prepared"));
    assert_eq!(stored["account_binding_verified"], true);
    assert_eq!(stored["source_decimals"], 24);
    assert_eq!(stored["destination_decimals"], 18);
    assert_eq!(stored["deposit_dispatch_status"], json!("Disabled"));
    assert!(stored["created_block_height"].is_string());
    assert!(stored["created_timestamp"].is_string());
    assert_eq!(
        stored["provider_inactive_deadline"],
        quote["provider_inactive_deadline"]
    );
    assert_eq!(stored["provider_signature_hash"], quote["provider_signature_hash"]);
    assert_eq!(stored["owner_at_authorization"], owner.id.as_str());
    assert_eq!(stored["associated_account_id"], canonical.as_str());
    assert_eq!(stored["nonce"], "0");

    let readback = run_sandbox_adapter_fixture(
        "verify",
        rpc_url,
        &contract.id,
        token_id,
        "primary",
    )?;
    assert_eq!(readback["relayStateVerified"], true);
    assert_eq!(readback["status"], "Prepared");
    assert_eq!(readback["providerSignatureHash"], quote["provider_signature_hash"]);

    let cancel = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_cancel_quote_authorization",
        json!({ "token_id": token_id, "commitment_hash": commitment }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-j cancel quote without releasing signature identity", cancel);
    assert_eq!(
        view(
            &contract.id,
            "relay_quote_authorization",
            json!({ "token_id": token_id, "commitment_hash": commitment }),
            network,
        )
        .await?["status"],
        json!("Cancelled")
    );

    let restarted = run_sandbox_adapter_fixture(
        "prepare",
        rpc_url,
        &contract.id,
        token_id,
        "primary",
    )?;
    assert_eq!(
        restarted["providerSignatureHash"],
        quote["provider_signature_hash"]
    );
    assert_eq!(restarted["context"]["quoteNonce"], "1");
    assert_eq!(
        restarted["providerSignatureHash"],
        quote["provider_signature_hash"]
    );
    assert_eq!(
        restarted["authorizationArgs"]["quote"]["provider_signature_hash"],
        quote["provider_signature_hash"]
    );
    let replay_after_restart = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        restarted["authorizationArgs"].clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert!(replay_after_restart.is_failure());

    let other_token = "adapterquoteother";
    let other_canonical: AccountId = format!("{other_token}.{}", contract.id).parse()?;
    let other_mint = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "relay_mint",
        json!({
            "token_id": other_token,
            "token_owner_id": owner.id,
            "token_metadata": {
                "title": "Global replay fixture",
                "description": "Local protocol-mechanics fixture",
                "media": null, "media_hash": null, "copies": null,
                "issued_at": null, "expires_at": null, "starts_at": null,
                "updated_at": null, "extra": null, "reference": null,
                "reference_hash": null
            },
            "associated_account_id": other_canonical,
            "initial_credits": 1
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-j mint cross-token replay fixture", other_mint);
    let other_provision = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_provision_subaccount",
        json!({ "token_id": other_token }),
        NearToken::from_yoctonear(minimum_yocto + NearToken::from_near(2).as_yoctonear()),
        network,
    )
    .await?;
    assert_success("stage-j provision cross-token replay fixture", other_provision);
    let mut cross_token_quote = quote.clone();
    cross_token_quote["refund_address"] = json!(other_canonical);
    cross_token_quote["commitment_hash"] = json!(quote_commitment(
        other_token,
        &contract.id,
        &other_canonical,
        &owner.id,
        0,
        quote["provider_signature_hash"].as_str().ok_or("missing signature hash")?,
        quote["source_amount"].as_str().ok_or("missing source amount")?,
        quote["expected_output"].as_str().ok_or("missing expected output")?,
        quote["minimum_output"].as_str().ok_or("missing minimum output")?,
        quote["recipient"].as_str().ok_or("missing recipient")?,
        quote["deposit_address"].as_str().ok_or("missing deposit address")?,
        quote["deposit_memo"].as_str().ok_or("missing deposit memo")?,
        quote["request_deadline"].as_str().ok_or("missing request deadline")?,
        quote["provider_quote_deadline"]
            .as_str()
            .ok_or("missing provider deadline")?,
        quote["provider_inactive_deadline"].as_str(),
    ));
    let cross_token_replay = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        json!({
            "token_id": other_token,
            "expected_nonce": "0",
            "quote": cross_token_quote
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert!(cross_token_replay.is_failure());

    let alternate = run_sandbox_adapter_fixture(
        "prepare",
        rpc_url,
        &contract.id,
        token_id,
        "alternate",
    )?;
    let alternate_args = alternate["authorizationArgs"].clone();
    let alternate_commitment = alternate_args["quote"]["commitment_hash"]
        .as_str()
        .ok_or("alternate quote omitted commitment")?
        .to_string();
    let alternate_authorize = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        alternate_args,
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-j authorize distinct fixture before ownership change", alternate_authorize);
    let transfer = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "nft_transfer",
        json!({
            "receiver_id": next_owner.id,
            "token_id": token_id,
            "approval_id": null,
            "memo": null
        }),
        NearToken::from_yoctonear(1),
        network,
    )
    .await?;
    assert_success("stage-j transfer NFT invalidates active quote authorization", transfer);
    assert_eq!(
        view(
            &contract.id,
            "relay_quote_authorization",
            json!({ "token_id": token_id, "commitment_hash": alternate_commitment }),
            network,
        )
        .await?["status"],
        json!("InvalidatedOwnership")
    );
    let old_owner_consume = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_consume_quote_authorization",
        json!({ "token_id": token_id, "commitment_hash": alternate_commitment }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(old_owner_consume.is_failure());
    let stale_adapter_read = run_sandbox_adapter_fixture_expect_failure(
        "verify",
        rpc_url,
        &contract.id,
        token_id,
        "alternate",
    )?;
    assert!(
        stale_adapter_read.contains("ONCHAIN_AUTHORIZATION_MISMATCH"),
        "expected the adapter to reject the stale authorization, got: {stale_adapter_read}"
    );
    assert_eq!(
        view(&contract.id, "relay_payment", json!({ "token_id": token_id }), network)
            .await?,
        Value::Null
    );

    let new_owner_prepared = run_sandbox_adapter_fixture(
        "prepare",
        rpc_url,
        &contract.id,
        token_id,
        "new-owner",
    )?;
    assert_eq!(
        new_owner_prepared["context"]["ownerAccountId"],
        next_owner.id.as_str()
    );
    assert_eq!(new_owner_prepared["context"]["quoteNonce"], "3");
    let old_owner_authorize_after_transfer = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        new_owner_prepared["authorizationArgs"].clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert!(old_owner_authorize_after_transfer.is_failure());
    let new_owner_quote = new_owner_prepared["authorizationArgs"]["quote"].clone();
    let new_owner_commitment = new_owner_quote["commitment_hash"]
        .as_str()
        .ok_or("new-owner quote omitted commitment")?;
    let new_owner_authorize = send_contract_call(
        &contract.id,
        &next_owner.id,
        &next_owner.signer,
        "relay_authorize_quote",
        new_owner_prepared["authorizationArgs"].clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success(
        "stage-j new owner authorizes a fresh adapter quote after transfer",
        new_owner_authorize,
    );
    let new_owner_readback = run_sandbox_adapter_fixture(
        "verify",
        rpc_url,
        &contract.id,
        token_id,
        "new-owner",
    )?;
    assert_eq!(new_owner_readback["relayStateVerified"], true);
    assert_eq!(new_owner_readback["ownerAtAuthorization"], next_owner.id.as_str());
    assert_eq!(new_owner_readback["status"], "Prepared");
    assert_ne!(
        new_owner_quote["provider_signature_hash"],
        quote["provider_signature_hash"]
    );

    let cancel_new_owner = send_contract_call(
        &contract.id,
        &next_owner.id,
        &next_owner.signer,
        "relay_cancel_quote_authorization",
        json!({ "token_id": token_id, "commitment_hash": new_owner_commitment }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success(
        "stage-j cancel new-owner authorization before expiry case",
        cancel_new_owner,
    );

    let expiring = run_sandbox_adapter_fixture(
        "prepare",
        rpc_url,
        &contract.id,
        token_id,
        "expiring",
    )?;
    assert_eq!(expiring["context"]["ownerAccountId"], next_owner.id.as_str());
    assert_eq!(expiring["context"]["quoteNonce"], "4");
    let expiring_quote = expiring["authorizationArgs"]["quote"].clone();
    let expiring_commitment = expiring_quote["commitment_hash"]
        .as_str()
        .ok_or("expiring quote omitted commitment")?;
    let authorize_expiring = send_contract_call(
        &contract.id,
        &next_owner.id,
        &next_owner.signer,
        "relay_authorize_quote",
        expiring["authorizationArgs"].clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-j authorize quote before Sandbox expiry", authorize_expiring);

    sandbox.fast_forward(60).await?;
    assert_eq!(
        view(
            &contract.id,
            "relay_quote_authorization",
            json!({ "token_id": token_id, "commitment_hash": expiring_commitment }),
            network,
        )
        .await?["status"],
        json!("Expired")
    );
    let persist_expiry = send_contract_call(
        &contract.id,
        &next_owner.id,
        &next_owner.signer,
        "relay_expire_quote_authorization",
        json!({ "token_id": token_id, "commitment_hash": expiring_commitment }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-j persist expired quote transition", persist_expiry);
    assert_eq!(
        view(
            &contract.id,
            "relay_active_quote_authorization",
            json!({ "token_id": token_id }),
            network,
        )
        .await?,
        Value::Null
    );
    let expired_consume = send_contract_call(
        &contract.id,
        &next_owner.id,
        &next_owner.signer,
        "relay_consume_quote_authorization",
        json!({ "token_id": token_id, "commitment_hash": expiring_commitment }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success(
        "stage-j reject consumption of expired authorization",
        expired_consume,
    );
    assert_eq!(
        view(
            &contract.id,
            "relay_quote_authorization",
            json!({ "token_id": token_id, "commitment_hash": expiring_commitment }),
            network,
        )
        .await?["status"],
        json!("Expired")
    );

    let expired_nonce: u64 = view(
        &contract.id,
        "relay_quote_nonce",
        json!({ "token_id": token_id }),
        network,
    )
    .await?
    .as_str()
    .ok_or("quote nonce view did not return a string")?
    .parse()?;
    let mut expired_digest_replay = expiring_quote;
    let replay_request_deadline = "4102444700000000000";
    let replay_provider_deadline = "4102444800000000000";
    expired_digest_replay["provider_inactive_deadline"] = json!(replay_provider_deadline);
    let replay_commitment = quote_commitment(
        token_id,
        &contract.id,
        &canonical,
        &next_owner.id,
        expired_nonce,
        expired_digest_replay["provider_signature_hash"]
            .as_str()
            .ok_or("expired quote omitted signature digest")?,
        expired_digest_replay["source_amount"]
            .as_str()
            .ok_or("expired quote omitted source amount")?,
        expired_digest_replay["expected_output"]
            .as_str()
            .ok_or("expired quote omitted expected output")?,
        expired_digest_replay["minimum_output"]
            .as_str()
            .ok_or("expired quote omitted minimum output")?,
        expired_digest_replay["recipient"]
            .as_str()
            .ok_or("expired quote omitted recipient")?,
        expired_digest_replay["deposit_address"]
            .as_str()
            .ok_or("expired quote omitted deposit address")?,
        expired_digest_replay["deposit_memo"]
            .as_str()
            .ok_or("expired quote omitted deposit memo")?,
        replay_request_deadline,
        replay_provider_deadline,
        expired_digest_replay["provider_inactive_deadline"].as_str(),
    );
    expired_digest_replay["request_deadline"] = json!(replay_request_deadline);
    expired_digest_replay["provider_quote_deadline"] = json!(replay_provider_deadline);
    expired_digest_replay["commitment_hash"] = json!(replay_commitment);
    let expired_signature_replay = send_contract_call(
        &contract.id,
        &next_owner.id,
        &next_owner.signer,
        "relay_authorize_quote",
        json!({
            "token_id": token_id,
            "expected_nonce": expired_nonce.to_string(),
            "quote": expired_digest_replay
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert!(expired_signature_replay.is_failure());
    assert_eq!(
        view(&contract.id, "relay_payment", json!({ "token_id": token_id }), network)
            .await?,
        Value::Null
    );
    println!("stage-j passed: finalized Sandbox state, SDK-verified prefixless signature and prefixed replay rejection, cancellation/cross-token/expiry replay retention, and old/new-owner authorization");
    Ok(())
}

async fn stage_k(
    network: &NetworkConfig,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    contract: &TestAccount,
) -> TestResult<()> {
    let owner = create_account(network, genesis, genesis_signer, "stage-k-owner").await?;
    let receiver = create_account(network, genesis, genesis_signer, "stage-k-receiver").await?;
    let token_id = "nativeprep";
    let canonical: AccountId = format!("{token_id}.{}", contract.id).parse()?;
    let mint = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "relay_mint",
        json!({
            "token_id": token_id,
            "token_owner_id": owner.id,
            "token_metadata": {
                "title": "Local native NEAR transfer fixture",
                "description": "Sandbox transfer mechanics only; not a 1Click deposit",
                "media": null, "media_hash": null, "copies": null,
                "issued_at": null, "expires_at": null, "starts_at": null,
                "updated_at": null, "extra": null, "reference": null,
                "reference_hash": null
            },
            "associated_account_id": canonical,
            "initial_credits": 0
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-k mint local transfer fixture", mint);

    let minimum: Value = view(
        &contract.id,
        "get_provision_minimum_deposit",
        json!({}),
        network,
    )
    .await?;
    let minimum_yocto = minimum
        .get("0")
        .and_then(Value::as_str)
        .or_else(|| minimum.as_str())
        .ok_or("unexpected NearToken JSON shape")?
        .parse::<u128>()?;
    let provision = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_provision_subaccount",
        json!({ "token_id": token_id }),
        NearToken::from_yoctonear(minimum_yocto + NearToken::from_near(2).as_yoctonear()),
        network,
    )
    .await?;
    assert_success("stage-k provision local controller", provision);
    let binding = view(
        &contract.id,
        "relay_account_binding",
        json!({ "token_id": token_id }),
        network,
    )
    .await?;
    assert_eq!(binding["account_id"], canonical.to_string());
    assert_eq!(binding["is_verified"], true);

    let child_before = Tokens::account(canonical.clone())
        .near_balance()
        .fetch_from(network)
        .await?
        .total;
    let receiver_before = Tokens::account(receiver.id.clone())
        .near_balance()
        .fetch_from(network)
        .await?
        .total;
    let amount = NearToken::from_millinear(100);
    let dispatch = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_execute_subaccount",
        json!({
            "token_id": token_id,
            "action": {
                "TransferNear": {
                    "receiver_id": receiver.id,
                    "amount": amount.as_yoctonear().to_string()
                }
            }
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success(
        "stage-k owner native NEAR transfer to controlled account",
        dispatch,
    );

    let child_after = Tokens::account(canonical)
        .near_balance()
        .fetch_from(network)
        .await?
        .total;
    let receiver_after = Tokens::account(receiver.id)
        .near_balance()
        .fetch_from(network)
        .await?
        .total;
    assert_eq!(
        child_before.as_yoctonear() - child_after.as_yoctonear(),
        amount.as_yoctonear()
    );
    assert_eq!(
        receiver_after.as_yoctonear() - receiver_before.as_yoctonear(),
        amount.as_yoctonear()
    );
    println!(
        "stage-k passed: local parent-mediated native NEAR transfer only; no provider request or 1Click deposit"
    );
    Ok(())
}

async fn stage_l(
    sandbox: &Sandbox,
    network: &NetworkConfig,
    rpc_url: &str,
    genesis: &GenesisAccount,
    genesis_signer: &Arc<Signer>,
    contract: &TestAccount,
    wrapped_near_fixture: &TestAccount,
) -> TestResult<()> {
    let owner = create_account(network, genesis, genesis_signer, "stage-l-owner").await?;
    let receiver = create_account(network, genesis, genesis_signer, "stage-l-receiver").await?;
    let new_owner = create_account(network, genesis, genesis_signer, "stage-l-new-owner").await?;
    let token_id = "stage-l-checkout";
    let canonical: AccountId = format!("{token_id}.{}", contract.id).parse()?;

    // 1. Mint and provision RELAY NFT/account
    let mint = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "relay_mint",
        json!({
            "token_id": token_id,
            "token_owner_id": owner.id,
            "token_metadata": {
                "title": "Task32P Local NEP-141 Checkout Fixture",
                "description": "Local Sandbox mock wrapped-NEAR execution; not a live 1Click deposit",
                "media": null, "media_hash": null, "copies": null,
                "issued_at": null, "expires_at": null, "starts_at": null,
                "updated_at": null, "extra": null, "reference": null,
                "reference_hash": null
            },
            "associated_account_id": canonical,
            "initial_credits": 1
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-l mint token", mint);

    let minimum: Value = view(
        &contract.id,
        "get_provision_minimum_deposit",
        json!({}),
        network,
    )
    .await?;
    let minimum_yocto = minimum
        .get("0")
        .and_then(Value::as_str)
        .or_else(|| minimum.as_str())
        .ok_or("unexpected NearToken JSON shape")?
        .parse::<u128>()?;

    let provision = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_provision_subaccount",
        json!({ "token_id": token_id }),
        NearToken::from_yoctonear(minimum_yocto + NearToken::from_near(2).as_yoctonear()),
        network,
    )
    .await?;
    assert_success("stage-l provision associated subaccount", provision);

    // 2. Verify associated account binding
    let binding = view(
        &contract.id,
        "relay_account_binding",
        json!({ "token_id": token_id }),
        network,
    )
    .await?;
    assert_eq!(binding["account_id"], canonical.to_string());
    assert_eq!(binding["is_verified"], true);

    // Stage H deploys this local NEP-141 fixture; it is not the production wrap.near contract.
    for account_id in [&canonical, &receiver.id] {
        let storage = send_contract_call(
            &wrapped_near_fixture.id,
            &owner.id,
            &owner.signer,
            "storage_deposit",
            json!({ "account_id": account_id, "registration_only": true }),
            NearToken::from_near(1),
            network,
        )
        .await?;
        assert_success("stage-l register wrapped-NEAR fixture account", storage);
    }

    // 3. Prepare and authorize a quote fixture for 0.1 local wrapped-NEAR tokens.
    let transfer_amount_yocto = NearToken::from_millinear(100).as_yoctonear();
    let mint_wrapped_near = send_contract_call(
        &wrapped_near_fixture.id,
        &wrapped_near_fixture.id,
        &wrapped_near_fixture.signer,
        "mint",
        json!({ "account_id": canonical, "amount": transfer_amount_yocto.to_string() }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-l mint local wrapped-NEAR fixture balance", mint_wrapped_near);
    let prepared = run_sandbox_adapter_fixture_full(
        "prepare",
        rpc_url,
        &contract.id,
        token_id,
        "wrapped-near-stage-l",
        "prefixed",
        Some(receiver.id.as_str()),
        Some("stage-l-deposit-memo"),
        Some(&transfer_amount_yocto.to_string()),
    )?;
    assert_eq!(prepared["context"]["ownerAccountId"], owner.id.as_str());
    assert_eq!(prepared["context"]["associatedAccountId"], canonical.as_str());
    assert_eq!(prepared["context"]["quoteNonce"], "0");

    let auth_args = prepared["authorizationArgs"].clone();
    let commitment_hash = auth_args["quote"]["commitment_hash"]
        .as_str()
        .ok_or("missing commitment hash")?
        .to_string();

    for (field, replacement) in [
        ("source_amount", json!("1")),
        ("deposit_address", json!(owner.id)),
        ("deposit_memo", json!("substituted-memo")),
        ("deposit_type", json!("INTENTS")),
    ] {
        let mut substituted = auth_args.clone();
        substituted["quote"][field] = replacement;
        let attempted_substitution = send_contract_call(
            &contract.id,
            &owner.id,
            &owner.signer,
            "relay_authorize_quote",
            substituted,
            NearToken::from_near(1),
            network,
        )
        .await?;
        assert!(
            attempted_substitution.is_failure(),
            "prepared quote commitment must reject substituted {field}"
        );
    }

    let authorize = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        auth_args,
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-l authorize quote fixture", authorize);

    let stored_auth = view(
        &contract.id,
        "relay_quote_authorization",
        json!({ "token_id": token_id, "commitment_hash": commitment_hash }),
        network,
    )
    .await?;
    assert_eq!(stored_auth["status"], json!("Prepared"));
    assert_eq!(stored_auth["deposit_dispatch_status"], json!("Disabled"));

    // 4. Start and execute the prepared NEP-141 payment.
    let receiver_ft_before: Value = view(
        &wrapped_near_fixture.id,
        "ft_balance_of",
        json!({ "account_id": receiver.id }),
        network,
    )
    .await?;
    let receiver_ft_before = receiver_ft_before
        .as_str()
        .ok_or("stage-l fixture FT balance was not a string")?
        .parse::<u128>()?;
    let child_ft_before: Value = view(
        &wrapped_near_fixture.id,
        "ft_balance_of",
        json!({ "account_id": canonical }),
        network,
    )
    .await?;
    let child_ft_before = child_ft_before
        .as_str()
        .ok_or("stage-l child FT balance was not a string")?
        .parse::<u128>()?;

    let execute = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_execute_prepared_payment",
        json!({
            "token_id": token_id,
            "commitment_hash": commitment_hash,
            "source_amount": "1",
            "deposit_address": owner.id
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-l execute mock wrapped-NEAR transfer via prepared quote", execute);

    // 5. Verify exact mock-token sender and receiver balance changes.
    let child_after = Tokens::account(canonical.clone())
        .near_balance()
        .fetch_from(network)
        .await?
        .total;
    let receiver_ft_after: Value = view(
        &wrapped_near_fixture.id,
        "ft_balance_of",
        json!({ "account_id": receiver.id }),
        network,
    )
    .await?;
    let receiver_ft_after = receiver_ft_after
        .as_str()
        .ok_or("stage-l fixture FT balance was not a string")?
        .parse::<u128>()?;
    let child_ft_after: Value = view(
        &wrapped_near_fixture.id,
        "ft_balance_of",
        json!({ "account_id": canonical }),
        network,
    )
    .await?;
    let child_ft_after = child_ft_after
        .as_str()
        .ok_or("stage-l child FT balance was not a string")?
        .parse::<u128>()?;
    assert_eq!(
        child_ft_before - child_ft_after,
        transfer_amount_yocto,
        "child wrapped-NEAR fixture balance must decrease by the exact amount"
    );
    assert_eq!(
        receiver_ft_after - receiver_ft_before,
        transfer_amount_yocto,
        "receiver wrapped-NEAR fixture balance must increase by the exact amount"
    );
    let transfer_observation = view(
        &wrapped_near_fixture.id,
        "last_transfer",
        json!({}),
        network,
    )
    .await?;
    assert_eq!(transfer_observation["method"], "ft_transfer");
    assert_eq!(transfer_observation["sender_id"], canonical.as_str());
    assert_eq!(transfer_observation["receiver_id"], receiver.id.as_str());
    assert_eq!(
        transfer_observation["amount"],
        transfer_amount_yocto.to_string()
    );
    assert_eq!(
        transfer_observation["memo"],
        "stage-l-deposit-memo",
        "the quote-bound memo must reach the local NEP-141 transfer unchanged"
    );

    // 6. Verify storage reserve remains intact
    assert!(
        child_after.as_yoctonear() >= minimum_yocto,
        "child account must retain required storage reserve after transfer"
    );

    // 7. Verify payment record and NFT lifecycle state
    let payment = view(
        &contract.id,
        "relay_payment",
        json!({ "token_id": token_id }),
        network,
    )
    .await?;
    assert_eq!(payment["token_transfer_status"], json!("TokenTransferCompleted"));
    assert_eq!(payment["checkout_status"], json!("SourceTransferCompleted"));
    assert_eq!(payment["amount"], json!(transfer_amount_yocto.to_string()));
    assert_eq!(payment["resolved_amount_used"], Value::Null);
    assert_eq!(payment["receiver_id"], receiver.id.as_str());
    assert_eq!(payment["commitment_hash"], commitment_hash.as_str());
    assert_eq!(
        payment["source_ft_contract"],
        wrapped_near_fixture.id.as_str()
    );

    let auth_after = view(
        &contract.id,
        "relay_quote_authorization",
        json!({ "token_id": token_id, "commitment_hash": commitment_hash }),
        network,
    )
    .await?;
    assert_eq!(auth_after["status"], json!("Consumed"));
    assert_eq!(auth_after["deposit_dispatch_status"], json!("SourceTransferCompleted"));

    let active_auth = view(
        &contract.id,
        "relay_active_quote_authorization",
        json!({ "token_id": token_id }),
        network,
    )
    .await?;
    assert_eq!(active_auth, Value::Null);

    // 8. CRITICAL: Verify no premature unlock or false settlement
    let is_locked: bool = view(
        &contract.id,
        "is_token_locked",
        json!({ "token_id": token_id }),
        network,
    )
    .await?
    .as_bool()
    .ok_or("is_token_locked did not return boolean")?;
    assert!(is_locked, "token must remain locked after source transfer completion");

    let blocked_transfer = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "nft_transfer",
        json!({
            "receiver_id": new_owner.id,
            "token_id": token_id,
            "approval_id": null,
            "memo": null
        }),
        NearToken::from_yoctonear(1),
        network,
    )
    .await?;
    assert!(
        blocked_transfer.is_failure(),
        "NFT transfer must be rejected while source transfer is unresolved for checkout"
    );

    let blocked_credit = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_use_credit",
        json!({ "token_id": token_id }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(
        blocked_credit.is_failure(),
        "credit use must be rejected while source transfer is unresolved for checkout"
    );

    let blocked_direct_subaccount_execution = send_contract_call(
        &canonical,
        &owner.id,
        &owner.signer,
        "execute",
        json!({
            "action": {
                "TransferNear": {
                    "receiver_id": owner.id,
                    "amount": "1"
                }
            }
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(
        blocked_direct_subaccount_execution.is_failure(),
        "NFT owner must not bypass the parent lifecycle lock through direct subaccount execution"
    );

    // 9. Verify duplicate dispatch and replay rejection
    let dup_dispatch = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_execute_prepared_payment",
        json!({
            "token_id": token_id,
            "commitment_hash": commitment_hash
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(dup_dispatch.is_failure(), "duplicate execution of consumed quote must be rejected");

    let dup_authorize = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        prepared["authorizationArgs"].clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert!(dup_authorize.is_failure(), "re-authorization of used provider signature digest must be rejected");

    // 10. Verify old-owner rejection after NFT ownership changes
    let token_old_owner = "stage-l-old-owner-token";
    let canonical_oo: AccountId = format!("{token_old_owner}.{}", contract.id).parse()?;
    let mint_oo = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "relay_mint",
        json!({
            "token_id": token_old_owner,
            "token_owner_id": owner.id,
            "token_metadata": {
                "title": "Stage L Old Owner Fixture", "description": "Test ownership changes",
                "media": null, "media_hash": null, "copies": null,
                "issued_at": null, "expires_at": null, "starts_at": null,
                "updated_at": null, "extra": null, "reference": null, "reference_hash": null
            },
            "associated_account_id": canonical_oo,
            "initial_credits": 0
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-l mint old owner token", mint_oo);

    let prov_oo = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_provision_subaccount",
        json!({ "token_id": token_old_owner }),
        NearToken::from_yoctonear(minimum_yocto + NearToken::from_near(2).as_yoctonear()),
        network,
    )
    .await?;
    assert_success("stage-l provision old owner token subaccount", prov_oo);

    let prep_oo = run_sandbox_adapter_fixture_full(
        "prepare",
        rpc_url,
        &contract.id,
        token_old_owner,
        "native-old-owner",
        "prefixed",
        Some(receiver.id.as_str()),
        None,
        Some(&transfer_amount_yocto.to_string()),
    )?;
    let commit_oo = prep_oo["authorizationArgs"]["quote"]["commitment_hash"]
        .as_str()
        .ok_or("missing commitment hash")?
        .to_string();

    let auth_oo = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        prep_oo["authorizationArgs"].clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-l authorize old owner quote", auth_oo);

    // Transfer token to new_owner
    let transfer_oo = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "nft_transfer",
        json!({
            "receiver_id": new_owner.id,
            "token_id": token_old_owner,
            "approval_id": null,
            "memo": null
        }),
        NearToken::from_yoctonear(1),
        network,
    )
    .await?;
    assert_success("stage-l transfer token invalidates quote", transfer_oo);

    let status_oo = view(
        &contract.id,
        "relay_quote_authorization",
        json!({ "token_id": token_old_owner, "commitment_hash": commit_oo }),
        network,
    )
    .await?;
    assert_eq!(status_oo["status"], json!("InvalidatedOwnership"));

    // Old owner attempts execution -> rejected!
    let old_owner_exec = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_execute_prepared_payment",
        json!({
            "token_id": token_old_owner,
            "commitment_hash": commit_oo
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(old_owner_exec.is_failure(), "old owner must be rejected from executing payment");

    // New owner attempts execution of invalidated quote -> rejected!
    let new_owner_exec = send_contract_call(
        &contract.id,
        &new_owner.id,
        &new_owner.signer,
        "relay_execute_prepared_payment",
        json!({
            "token_id": token_old_owner,
            "commitment_hash": commit_oo
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(new_owner_exec.is_failure(), "new owner cannot execute invalidated quote of old owner");

    // 11. Verify cancelled and expired preparation rejection
    let token_ce = "stage-l-cancel-expire";
    let canonical_ce: AccountId = format!("{token_ce}.{}", contract.id).parse()?;
    let mint_ce = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "relay_mint",
        json!({
            "token_id": token_ce,
            "token_owner_id": owner.id,
            "token_metadata": {
                "title": "Stage L Cancel Expire Fixture", "description": "Test cancellation and expiry",
                "media": null, "media_hash": null, "copies": null,
                "issued_at": null, "expires_at": null, "starts_at": null,
                "updated_at": null, "extra": null, "reference": null, "reference_hash": null
            },
            "associated_account_id": canonical_ce,
            "initial_credits": 0
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-l mint cancel/expire token", mint_ce);

    let prov_ce = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_provision_subaccount",
        json!({ "token_id": token_ce }),
        NearToken::from_yoctonear(minimum_yocto + NearToken::from_near(2).as_yoctonear()),
        network,
    )
    .await?;
    assert_success("stage-l provision cancel/expire token", prov_ce);

    let prep_ce = run_sandbox_adapter_fixture_full(
        "prepare",
        rpc_url,
        &contract.id,
        token_ce,
        "native-cancel",
        "prefixed",
        Some(receiver.id.as_str()),
        None,
        Some(&transfer_amount_yocto.to_string()),
    )?;
    let commit_ce = prep_ce["authorizationArgs"]["quote"]["commitment_hash"]
        .as_str()
        .ok_or("missing commitment hash")?
        .to_string();

    let auth_ce = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        prep_ce["authorizationArgs"].clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-l authorize cancel quote", auth_ce);

    let cancel_ce = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_cancel_quote_authorization",
        json!({
            "token_id": token_ce,
            "commitment_hash": commit_ce
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert_success("stage-l cancel quote", cancel_ce);

    let exec_cancelled = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_execute_prepared_payment",
        json!({
            "token_id": token_ce,
            "commitment_hash": commit_ce
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(exec_cancelled.is_failure(), "cancelled quote execution must be rejected");

    // Expired quote rejection
    let prep_exp = run_sandbox_adapter_fixture_full(
        "prepare",
        rpc_url,
        &contract.id,
        token_ce,
        "expiring",
        "prefixed",
        Some(receiver.id.as_str()),
        None,
        Some(&transfer_amount_yocto.to_string()),
    )?;
    let commit_exp = prep_exp["authorizationArgs"]["quote"]["commitment_hash"]
        .as_str()
        .ok_or("missing commitment hash")?
        .to_string();

    let auth_exp = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        prep_exp["authorizationArgs"].clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-l authorize expiring quote", auth_exp);

    sandbox.fast_forward(60).await?;

    let exec_expired = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_execute_prepared_payment",
        json!({
            "token_id": token_ce,
            "commitment_hash": commit_exp
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(exec_expired.is_failure(), "expired quote execution must be rejected");

    // 12. Verify insufficient balance and recovery-required handling
    let token_ib = "stage-l-insufficient";
    let canonical_ib: AccountId = format!("{token_ib}.{}", contract.id).parse()?;
    let mint_ib = send_contract_call(
        &contract.id,
        &genesis.account_id.as_str().parse()?,
        genesis_signer,
        "relay_mint",
        json!({
            "token_id": token_ib,
            "token_owner_id": owner.id,
            "token_metadata": {
                "title": "Stage L Insufficient Balance Fixture", "description": "Test subaccount balance failure",
                "media": null, "media_hash": null, "copies": null,
                "issued_at": null, "expires_at": null, "starts_at": null,
                "updated_at": null, "extra": null, "reference": null, "reference_hash": null
            },
            "associated_account_id": canonical_ib,
            "initial_credits": 0
        }),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-l mint insufficient balance token", mint_ib);

    // Provision with bare minimum deposit so available balance above storage reserve is 0
    let prov_ib = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_provision_subaccount",
        json!({ "token_id": token_ib }),
        NearToken::from_yoctonear(minimum_yocto),
        network,
    )
    .await?;
    assert_success("stage-l provision bare minimum subaccount", prov_ib);

    // Prepare quote for 0.5 NEAR (which canonical_ib does not have available)
    let amount_ib_yocto = NearToken::from_millinear(500).as_yoctonear();
    let prep_ib = run_sandbox_adapter_fixture_full(
        "prepare",
        rpc_url,
        &contract.id,
        token_ib,
        "native-ib",
        "prefixed",
        Some(receiver.id.as_str()),
        None,
        Some(&amount_ib_yocto.to_string()),
    )?;
    let commit_ib = prep_ib["authorizationArgs"]["quote"]["commitment_hash"]
        .as_str()
        .ok_or("missing commitment hash")?
        .to_string();

    let auth_ib = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        prep_ib["authorizationArgs"].clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-l authorize quote with insufficient subaccount balance", auth_ib);

    let exec_ib = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_execute_prepared_payment",
        json!({
            "token_id": token_ib,
            "commitment_hash": commit_ib
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    // The execution dispatch transaction commits, but subaccount execution panics and callback records RecoveryRequired
    let payment_ib = view(
        &contract.id,
        "relay_payment",
        json!({ "token_id": token_ib }),
        network,
    )
    .await?;
    assert_eq!(payment_ib["token_transfer_status"], json!("TokenTransferFailed"));
    assert_eq!(payment_ib["checkout_status"], json!("RecoveryRequired"));

    let auth_ib_view = view(
        &contract.id,
        "relay_quote_authorization",
        json!({ "token_id": token_ib, "commitment_hash": commit_ib }),
        network,
    )
    .await?;
    assert_eq!(auth_ib_view["status"], json!("RecoveryRequired"));

    // Token must remain locked in RecoveryRequired
    let is_ib_locked: bool = view(
        &contract.id,
        "is_token_locked",
        json!({ "token_id": token_ib }),
        network,
    )
    .await?
    .as_bool()
    .ok_or("is_token_locked did not return boolean")?;
    assert!(is_ib_locked, "token must remain locked in RecoveryRequired");

    let _ = exec_ib;

    // 13. Verify invalid recipient (parent contract or associated account) rejection
    let prep_inv_recip = run_sandbox_adapter_fixture_full(
        "prepare",
        rpc_url,
        &contract.id,
        token_ce,
        "native-inv-recip",
        "prefixed",
        Some(contract.id.as_str()),
        None,
        Some(&transfer_amount_yocto.to_string()),
    )?;
    let commit_inv_recip = prep_inv_recip["authorizationArgs"]["quote"]["commitment_hash"]
        .as_str()
        .ok_or("missing commitment hash")?
        .to_string();

    let auth_inv_recip = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_authorize_quote",
        prep_inv_recip["authorizationArgs"].clone(),
        NearToken::from_near(1),
        network,
    )
    .await?;
    assert_success("stage-l authorize quote with contract recipient", auth_inv_recip);

    let exec_inv_recip = send_contract_call(
        &contract.id,
        &owner.id,
        &owner.signer,
        "relay_execute_prepared_payment",
        json!({
            "token_id": token_ce,
            "commitment_hash": commit_inv_recip
        }),
        NearToken::from_yoctonear(0),
        network,
    )
    .await?;
    assert!(exec_inv_recip.is_failure(), "quote with parent contract as recipient must be rejected");

    println!("stage-l passed: local prepared-quote source transfer, balance verification, lifecycle locking, replay rejection, and failure quarantine; no checkout settlement is claimed");
    Ok(())
}

#[tokio::main]
async fn main() -> TestResult<()> {
    build_external_nft()?;
    build_receiver()?;
    let sandbox = Sandbox::start_sandbox().await?;
    println!("sandbox: rpc={}", sandbox.rpc_addr);
    let rpc_url = sandbox.rpc_addr.to_string();
    let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let genesis = GenesisAccount::default();
    let genesis_id: AccountId = genesis.account_id.as_str().parse()?;
    let genesis_signer = Arc::new(Signer::from_secret_key(genesis.private_key.parse()?)?);
    let contract = create_account(&network, &genesis, &genesis_signer, "relay-compat").await?;

    let (previous_owner, new_owner) =
        stage_a(&network, &genesis, &genesis_signer, &contract).await?;
    stage_b(
        &network,
        &genesis,
        &genesis_signer,
        &contract,
        &new_owner,
    )
    .await?;
    stage_c(
        &network,
        &genesis,
        &genesis_signer,
        &contract,
        &previous_owner,
        &new_owner,
    )
    .await?;
    let credit_owner = stage_e(
        &network,
        &genesis,
        &genesis_signer,
        &contract,
        &new_owner,
    )
    .await?;
    stage_f(
        &network,
        &genesis,
        &genesis_signer,
        &contract,
    )
    .await?;
    let receiver_probe = create_account(
        &network,
        &genesis,
        &genesis_signer,
        "receiver-probe",
    )
    .await?;
    let receiver = create_account(
        &network,
        &genesis,
        &genesis_signer,
        "receiver-compat",
    )
    .await?;
    deploy_receiver(&network, &receiver, false).await?;
    probe_receiver(&network, &receiver, &receiver_probe).await?;
    probe_receiver(&network, &receiver, &contract).await?;
    let final_owner = stage_d(
        &network,
        &genesis,
        &genesis_signer,
        &contract,
        &credit_owner,
    )
    .await?;
    let wrapped_near_fixture = stage_g(
        &network,
        &genesis,
        &genesis_signer,
        &contract,
        &final_owner,
        &credit_owner,
    )
    .await?;
    stage_i(
        &network,
        &rpc_url,
        &genesis,
        &genesis_signer,
        &contract,
    )
    .await?;
    stage_j(
        &sandbox,
        &network,
        &rpc_url,
        &genesis,
        &genesis_signer,
        &contract,
    )
    .await?;
    stage_k(
        &network,
        &genesis,
        &genesis_signer,
        &contract,
    )
    .await?;
    stage_l(
        &sandbox,
        &network,
        &rpc_url,
        &genesis,
        &genesis_signer,
        &contract,
        &wrapped_near_fixture,
    )
    .await?;
    println!("PASS: Stages A, B, C, D, E, F, G, H, I, J, K, and L completed on disposable Sandbox");
    let _ = genesis_id;
    Ok(())
}

mod sha256 {
    pub fn digest(bytes: &[u8]) -> String {
        let output = std::process::Command::new("sha256sum")
            .arg("/dev/stdin")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(bytes)?;
                child.wait_with_output()
            })
            .expect("sha256sum must be available");
        String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string()
    }
}
