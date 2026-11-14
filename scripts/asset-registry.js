'use strict';

/**
 * RELAY Multichain Asset Registry
 *
 * Explicitly partitions assets across NEAR and Base networks into:
 * 1. Verified real network assets (live 1Click provider supported on Mainnet)
 * 2. Testnet assets (portfolio-readable only; provider unsupported)
 * 3. Explicit test fixtures (clearly tagged with zero monetary value notes)
 * 4. Local Sandbox test tokens (isolated to sandbox feature builds)
 *
 * Strict constraint: Sol and non-NEAR/Base chains are prohibited.
 */

const NETWORKS = Object.freeze({
    NEAR_MAINNET: 'near-mainnet',
    NEAR_TESTNET: 'near-testnet',
    BASE_MAINNET: 'base-mainnet',
    BASE_SEPOLIA: 'base-sepolia',
    NEAR_SANDBOX: 'near-sandbox',
});

const ASSET_REGISTRY = Object.freeze({
    // --- 1. Verified Real Network Assets (NEAR + Base Mainnet) ---
    'nep141:wrap.near': Object.freeze({
        assetId: 'nep141:wrap.near',
        network: NETWORKS.NEAR_MAINNET,
        chainId: null,
        tokenContract: 'wrap.near',
        decimals: 24,
        symbol: 'wNEAR',
        name: 'Wrapped NEAR',
        blockchain: 'near',
        providerSupported: true,
        canSourceCheckout: true,
        canDestinationCheckout: true,
        portfolioOnly: false,
        isTestFixture: false,
        status: 'VERIFIED_MAINNET',
    }),
    'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near': Object.freeze({
        assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
        network: NETWORKS.BASE_MAINNET,
        chainId: 8453,
        tokenContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
        symbol: 'USDC',
        name: 'USD Coin (Base)',
        blockchain: 'base',
        providerSupported: true,
        canSourceCheckout: true,
        canDestinationCheckout: true,
        portfolioOnly: false,
        isTestFixture: false,
        status: 'VERIFIED_MAINNET',
    }),
    'nep141:base-0x4200000000000000000000000000000000000006.omft.near': Object.freeze({
        assetId: 'nep141:base-0x4200000000000000000000000000000000000006.omft.near',
        network: NETWORKS.BASE_MAINNET,
        chainId: 8453,
        tokenContract: '0x4200000000000000000000000000000000000006',
        decimals: 18,
        symbol: 'WETH',
        name: 'Wrapped Ether (Base)',
        blockchain: 'base',
        providerSupported: true,
        canSourceCheckout: true,
        canDestinationCheckout: true,
        portfolioOnly: false,
        isTestFixture: false,
        status: 'VERIFIED_MAINNET',
    }),
    // Legacy allowlist asset preserved for backwards compatibility with existing test fixtures
    'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near': Object.freeze({
        assetId: 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near',
        network: 'arb-mainnet',
        chainId: 42161,
        tokenContract: '0x912CE59144191C1204E64559FE8253a0e49E6548',
        decimals: 18,
        symbol: 'ARB',
        name: 'Arbitrum (Legacy Allowlist)',
        blockchain: 'arb',
        providerSupported: true,
        canSourceCheckout: false,
        canDestinationCheckout: true,
        portfolioOnly: false,
        isTestFixture: false,
        status: 'LEGACY_ALLOWLIST',
    }),

    // --- 2. Testnet Assets (Portfolio-Readable Only; Provider Unsupported) ---
    'nep141:wrap.testnet': Object.freeze({
        assetId: 'nep141:wrap.testnet',
        network: NETWORKS.NEAR_TESTNET,
        chainId: null,
        tokenContract: 'wrap.testnet',
        decimals: 24,
        symbol: 'wNEAR',
        name: 'Wrapped NEAR (Testnet)',
        blockchain: 'near',
        providerSupported: false,
        canSourceCheckout: false,
        canDestinationCheckout: false,
        portfolioOnly: true,
        isTestFixture: false,
        status: 'TESTNET_PORTFOLIO_ONLY',
    }),
    'native:near-testnet': Object.freeze({
        assetId: 'native:near-testnet',
        network: NETWORKS.NEAR_TESTNET,
        chainId: null,
        tokenContract: null,
        decimals: 24,
        symbol: 'NEAR',
        name: 'NEAR Native (Testnet)',
        blockchain: 'near',
        providerSupported: false,          // 1Click provider NOT supported on Testnet
        canSourceCheckout: true,           // Supported via relay_execute_subaccount → TransferNear
        canDestinationCheckout: false,     // Not a valid destination in this demo
        portfolioOnly: false,              // Can be spent via testnet-native direct transfer
        isTestFixture: false,
        checkoutArchitecture: 'NEAR_TESTNET_DIRECT_TRANSFER',
        checkoutNote: 'Testnet-native direct NEAR transfer via relay_execute_subaccount → TransferNear. NOT a 1Click/NEAR Intents route.',
        status: 'TESTNET_NATIVE_TRANSFER',
    }),
    'native:base-sepolia-eth': Object.freeze({
        assetId: 'native:base-sepolia-eth',
        network: NETWORKS.BASE_SEPOLIA,
        chainId: 84532,
        tokenContract: null,
        decimals: 18,
        symbol: 'ETH',
        name: 'Sepolia Ether (Base)',
        blockchain: 'base',
        providerSupported: false,
        canSourceCheckout: false,
        canDestinationCheckout: false,
        portfolioOnly: true,
        isTestFixture: false,
        status: 'TESTNET_PORTFOLIO_ONLY',
    }),

    // --- 3. Explicit Test Fixtures (Zero Monetary Value Mock Tokens) ---
    'nep141:usdc.fakes.testnet': Object.freeze({
        assetId: 'nep141:usdc.fakes.testnet',
        network: NETWORKS.NEAR_TESTNET,
        chainId: null,
        tokenContract: 'usdc.fakes.testnet',
        decimals: 6,
        symbol: 'USDC.e',
        name: 'Bridged USDC (Test Fixture)',
        blockchain: 'near',
        providerSupported: false,
        canSourceCheckout: false,
        canDestinationCheckout: false,
        portfolioOnly: true,
        isTestFixture: true,
        fixtureNote: 'Rainbow Bridge faucet test fixture — zero monetary value. Never a genuine stablecoin.',
        status: 'TESTNET_MOCK_FIXTURE',
    }),
    'nep141:usdt.fakes.testnet': Object.freeze({
        assetId: 'nep141:usdt.fakes.testnet',
        network: NETWORKS.NEAR_TESTNET,
        chainId: null,
        tokenContract: 'usdt.fakes.testnet',
        decimals: 6,
        symbol: 'USDT.e',
        name: 'Tether USD (Test Fixture)',
        blockchain: 'near',
        providerSupported: false,
        canSourceCheckout: false,
        canDestinationCheckout: false,
        portfolioOnly: true,
        isTestFixture: true,
        fixtureNote: 'Rainbow Bridge faucet test fixture — zero monetary value. Never a genuine stablecoin.',
        status: 'TESTNET_MOCK_FIXTURE',
    }),
    'erc20:base-sepolia-0x036cbd53842c5426634e7929541ec2318f3dcf7e': Object.freeze({
        assetId: 'erc20:base-sepolia-0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        network: NETWORKS.BASE_SEPOLIA,
        chainId: 84532,
        tokenContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
        symbol: 'USDC',
        name: 'Circle Testnet USDC (Base Sepolia)',
        blockchain: 'base',
        providerSupported: false,
        canSourceCheckout: false,
        canDestinationCheckout: false,
        portfolioOnly: true,
        isTestFixture: true,
        fixtureNote: 'Circle Base Sepolia test fixture — zero monetary value.',
        status: 'TESTNET_MOCK_FIXTURE',
    }),

    // --- 4. Explicit Local Sandbox Mock Token (Sandbox Only) ---
    'nep141:mock-token.sandbox': Object.freeze({
        assetId: 'nep141:mock-token.sandbox',
        network: NETWORKS.NEAR_SANDBOX,
        chainId: null,
        tokenContract: 'mock-token.sandbox',
        decimals: 24,
        symbol: 'MOCK-NEP141',
        name: 'Local Sandbox Mock NEP-141',
        blockchain: 'near',
        providerSupported: false,
        canSourceCheckout: true, // test-only in Sandbox
        canDestinationCheckout: false,
        portfolioOnly: false,
        isTestFixture: true,
        fixtureNote: 'Local Sandbox unit/integration test token ONLY. Never deploy to Testnet or Mainnet.',
        status: 'SANDBOX_MOCK_ONLY',
    }),
});

// Verified route combinations allowed for Universal Checkout
const ALLOWED_CHECKOUT_PAIRS = Object.freeze([
    // --- Testnet-Native Direct Transfer (Real Demo Route) ---
    // NEAR Testnet native transfer via relay_execute_subaccount → TransferNear
    // This is NOT a 1Click/NEAR Intents route. It is a direct on-chain transfer
    // from the canonical associated subaccount to any valid NEAR Testnet receiver.
    Object.freeze({
        sourceAsset: 'native:near-testnet',
        destinationAsset: 'native:near-testnet',
        architecture: 'NEAR_TESTNET_DIRECT_TRANSFER',
        sourceDecimals: 24,
        destinationDecimals: 24,
        networkPair: 'near-testnet -> near-testnet',
        supported: true,
        tesnetNative: true,
        mainnentOneClickUnsupported: true,
        note: 'Direct native NEAR transfer on NEAR Testnet. Owner-authorized via relay_execute_subaccount.',
    }),

    // --- Mainnet-Only 1Click Routes (DISABLED for Testnet demo) ---
    // NEAR Source -> Base USDC Destination (1Click deposit address flow)
    Object.freeze({
        sourceAsset: 'nep141:wrap.near',
        destinationAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
        architecture: '1CLICK_DEPOSIT_ADDRESS',
        sourceDecimals: 24,
        destinationDecimals: 6,
        networkPair: 'near-mainnet -> base-mainnet',
        supported: true,
        mainnentOneClickUnsupported: false, // Mainnet only — not available in testnet demo
    }),
    // NEAR Source -> Base WETH Destination (1Click deposit address flow)
    Object.freeze({
        sourceAsset: 'nep141:wrap.near',
        destinationAsset: 'nep141:base-0x4200000000000000000000000000000000000006.omft.near',
        architecture: '1CLICK_DEPOSIT_ADDRESS',
        sourceDecimals: 24,
        destinationDecimals: 18,
        networkPair: 'near-mainnet -> base-mainnet',
        supported: true,
    }),
    // Base Source -> NEAR wNEAR Destination (Chain Signatures derived-account flow)
    Object.freeze({
        sourceAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
        destinationAsset: 'nep141:wrap.near',
        architecture: 'CHAIN_SIGNATURES_DERIVED_ACCOUNT',
        sourceDecimals: 6,
        destinationDecimals: 24,
        networkPair: 'base-mainnet -> near-mainnet',
        supported: true,
    }),
    // Legacy pair preserved for backwards compatibility with tests
    Object.freeze({
        sourceAsset: 'nep141:wrap.near',
        destinationAsset: 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near',
        architecture: '1CLICK_DEPOSIT_ADDRESS',
        sourceDecimals: 24,
        destinationDecimals: 18,
        networkPair: 'near-mainnet -> arb-mainnet',
        supported: true,
    }),
]);

function getAsset(assetId) {
    if (typeof assetId !== 'string') return null;
    return ASSET_REGISTRY[assetId] || null;
}

function isSpendableThroughCheckout(assetId) {
    const asset = getAsset(assetId);
    return Boolean(asset && asset.canSourceCheckout && !asset.portfolioOnly);
}

function isDestinationSupported(assetId) {
    const asset = getAsset(assetId);
    return Boolean(asset && asset.canDestinationCheckout && !asset.portfolioOnly);
}

function findCheckoutPair(sourceAssetId, destinationAssetId) {
    return ALLOWED_CHECKOUT_PAIRS.find(
        (pair) => pair.sourceAsset === sourceAssetId && pair.destinationAsset === destinationAssetId
    ) || null;
}

function validateCheckoutRoute(sourceAssetId, destinationAssetId) {
    const sourceAsset = getAsset(sourceAssetId);
    const destAsset = getAsset(destinationAssetId);

    if (!sourceAsset) {
        throw new TypeError(`Source asset '${sourceAssetId}' is not recognized in the RELAY asset registry.`);
    }
    if (!destAsset) {
        throw new TypeError(`Destination asset '${destinationAssetId}' is not recognized in the RELAY asset registry.`);
    }
    if (sourceAsset.portfolioOnly) {
        throw new TypeError(
            `Source asset '${sourceAsset.symbol}' (${sourceAssetId}) is marked portfolio-only (${sourceAsset.status}). It cannot be spent through Universal Checkout.`
        );
    }
    if (sourceAsset.isTestFixture && sourceAsset.status !== 'SANDBOX_MOCK_ONLY') {
        throw new TypeError(
            `Source asset '${sourceAsset.symbol}' is an explicit test fixture with zero monetary value (${sourceAsset.fixtureNote}). Checkout is prohibited.`
        );
    }

    // Testnet-native direct transfer routes bypass the 1Click provider check.
    // They use relay_execute_subaccount → TransferNear, not NEAR Intents.
    const isTestnetNativePair = sourceAsset.status === 'TESTNET_NATIVE_TRANSFER' ||
        sourceAsset.checkoutArchitecture === 'NEAR_TESTNET_DIRECT_TRANSFER';

    if (!isTestnetNativePair && !sourceAsset.providerSupported && sourceAsset.status !== 'SANDBOX_MOCK_ONLY') {
        throw new TypeError(
            `Source asset '${sourceAsset.symbol}' is not supported by the 1Click provider for live checkout execution. ` +
            `For Testnet demo, use 'native:near-testnet' (direct transfer) instead.`
        );
    }

    const pair = findCheckoutPair(sourceAssetId, destinationAssetId);
    if (!pair) {
        throw new TypeError(
            `Route from '${sourceAssetId}' to '${destinationAssetId}' is not an authorized Universal Checkout pair.`
        );
    }

    return pair;
}

module.exports = {
    NETWORKS,
    ASSET_REGISTRY,
    ALLOWED_CHECKOUT_PAIRS,
    getAsset,
    isSpendableThroughCheckout,
    isDestinationSupported,
    findCheckoutPair,
    validateCheckoutRoute,
};
