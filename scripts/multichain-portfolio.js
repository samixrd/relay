'use strict';

const crypto = require('node:crypto');
const bs58 = require('bs58');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { keccak_256 } = require('@noble/hashes/sha3.js');

// Verified NEAR Testnet MPC root public key from v1.signer-prod.testnet::public_key()
const DEFAULT_TESTNET_MPC_ROOT_KEY = 'secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3';
const DEFAULT_SIGNER_CONTRACT_ID = 'v1.signer-prod.testnet';
const DEFAULT_DERIVATION_PATH = 'relay-v1';
const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_CHAIN_ID_HEX = '0x14a34';

const EPSILON_DERIVATION_PREFIX = 'near-mpc-recovery v0.1.0 epsilon derivation:';

// Chain-specific derivation path mapping for versioned migrations
const CHAIN_DERIVATION_PATHS = Object.freeze({
    'base-sepolia': DEFAULT_DERIVATION_PATH,
    'base-sepolia-v2': 'base-sepolia-v1',
});

// Explicit token registries distinguishing verified core assets from test fixtures
const NEAR_TOKEN_REGISTRY = Object.freeze([
    {
        id: 'native-near',
        symbol: 'NEAR',
        name: 'NEAR Native',
        decimals: 24,
        contractId: null,
        type: 'native',
        chain: 'near-testnet',
        category: 'core',
        isTestFixture: false,
        verified: true,
    },
    {
        id: 'wrap.testnet',
        symbol: 'wNEAR',
        name: 'Wrapped NEAR',
        decimals: 24,
        contractId: 'wrap.testnet',
        type: 'nep141',
        chain: 'near-testnet',
        category: 'core',
        isTestFixture: false,
        verified: true,
    },
    {
        id: 'usdc.fakes.testnet',
        symbol: 'USDC.e',
        name: 'Bridged USDC (Test Fixture)',
        decimals: 6,
        contractId: 'usdc.fakes.testnet',
        type: 'nep141',
        chain: 'near-testnet',
        category: 'testnet-fixture',
        isTestFixture: true,
        fixtureNote: 'Rainbow Bridge faucet test fixture — zero monetary value',
        verified: true,
    },
    {
        id: 'usdt.fakes.testnet',
        symbol: 'USDT.e',
        name: 'Tether USD (Test Fixture)',
        decimals: 6,
        contractId: 'usdt.fakes.testnet',
        type: 'nep141',
        chain: 'near-testnet',
        category: 'testnet-fixture',
        isTestFixture: true,
        fixtureNote: 'Rainbow Bridge faucet test fixture — zero monetary value',
        verified: true,
    },
]);

const BASE_SEPOLIA_TOKEN_REGISTRY = Object.freeze([
    {
        id: 'native-eth',
        symbol: 'ETH',
        name: 'Ether (Sepolia)',
        decimals: 18,
        address: null,
        type: 'native',
        chain: 'base-sepolia',
        category: 'core',
        isTestFixture: false,
        verified: true,
    },
    {
        id: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        symbol: 'USDC',
        name: 'USD Coin (Base Sepolia)',
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        type: 'erc20',
        chain: 'base-sepolia',
        category: 'core',
        isTestFixture: false,
        contractLabel: 'Circle Testnet USDC',
        verified: true,
    },
    {
        id: '0x4200000000000000000000000000000000000006',
        symbol: 'WETH',
        name: 'Wrapped Ether (Base Sepolia)',
        decimals: 18,
        address: '0x4200000000000000000000000000000000000006',
        type: 'erc20',
        chain: 'base-sepolia',
        category: 'core',
        isTestFixture: false,
        contractLabel: 'Base Sepolia WETH',
        verified: true,
    },
]);

function failure(message) {
    return new Error(message);
}

function toChecksumAddress(addressHex) {
    const clean = addressHex.toLowerCase().replace(/^0x/, '');
    if (clean.length !== 40 || !/^[0-9a-f]{40}$/.test(clean)) {
        throw failure(`Invalid EVM address length for checksum: ${addressHex}`);
    }
    const hash = Buffer.from(keccak_256(Buffer.from(clean, 'utf8'))).toString('hex');
    let checksum = '0x';
    for (let i = 0; i < clean.length; i++) {
        checksum += parseInt(hash[i], 16) >= 8 ? clean[i].toUpperCase() : clean[i];
    }
    return checksum;
}

function formatUnits(rawAmount, decimals, maxFraction = 6) {
    if (rawAmount === null || rawAmount === undefined) return '—';
    try {
        const amount = BigInt(rawAmount);
        const negative = amount < 0n;
        const abs = negative ? -amount : amount;
        const base = 10n ** BigInt(decimals);
        const whole = abs / base;
        const remainder = abs % base;
        if (remainder === 0n) return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}`;
        const fractionFull = remainder.toString().padStart(decimals, '0');
        const fractionCut = fractionFull.slice(0, maxFraction).replace(/0+$/, '');
        return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}${fractionCut ? `.${fractionCut}` : ''}`;
    } catch {
        return '—';
    }
}

function parseMpcRootPublicKey(rootKeyStr) {
    if (!rootKeyStr || typeof rootKeyStr !== 'string') {
        throw failure('MPC root public key must be a valid string.');
    }
    const parts = rootKeyStr.split(':');
    if (parts.length !== 2 || parts[0] !== 'secp256k1') {
        throw failure(`Invalid MPC key format ${rootKeyStr}; expected secp256k1:<base58>.`);
    }
    const decoded = bs58.decode(parts[1]);
    if (decoded.length !== 64) {
        throw failure(`Invalid decoded secp256k1 public key byte length: ${decoded.length}, expected 64.`);
    }
    const uncompressedHex = `04${Buffer.from(decoded).toString('hex')}`;
    return secp256k1.Point.fromHex(uncompressedHex);
}

function deriveBaseAddress(predecessorAccountId, path = DEFAULT_DERIVATION_PATH, rootKeyStr = DEFAULT_TESTNET_MPC_ROOT_KEY) {
    if (!predecessorAccountId || typeof predecessorAccountId !== 'string') {
        throw failure('Derivation requires a valid NEAR predecessor account ID.');
    }
    if (typeof path !== 'string' || path.length === 0) {
        throw failure('Derivation path must be a non-empty string.');
    }

    const rootPoint = parseMpcRootPublicKey(rootKeyStr);
    const message = `${EPSILON_DERIVATION_PREFIX}${predecessorAccountId},${path}`;
    const tweakHash = crypto.createHash('sha3-256').update(message).digest();
    const tweakScalar = BigInt(`0x${tweakHash.toString('hex')}`) % secp256k1.Point.Fn.ORDER;

    const tweakPoint = secp256k1.Point.BASE.multiply(tweakScalar);
    const childPoint = rootPoint.add(tweakPoint);
    const childUncompressed = childPoint.toBytes(false); // 65 bytes: 0x04 + 64 bytes
    const childRaw64 = childUncompressed.slice(1);

    const childPublicKeyBase58 = `secp256k1:${bs58.encode(childRaw64)}`;
    const childPublicKeyHex = Buffer.from(childRaw64).toString('hex');

    const evmPubHash = Buffer.from(keccak_256(childRaw64));
    const addressBytes = evmPubHash.slice(-20);
    const rawAddress = `0x${addressBytes.toString('hex')}`;
    const checksummedAddress = toChecksumAddress(rawAddress);

    return {
        address: checksummedAddress,
        derivationPath: path,
        predecessorAccountId,
        mpcRootPublicKey: rootKeyStr,
        childPublicKeyBase58,
        childPublicKeyHex,
    };
}

async function verifyMpcDerivationOnChain({
    rpcUrl,
    predecessorAccountId,
    path = DEFAULT_DERIVATION_PATH,
    signerContractId = DEFAULT_SIGNER_CONTRACT_ID,
    expectedAddress = null,
    fetchImpl = globalThis.fetch,
}) {
    if (!rpcUrl) throw failure('NEAR RPC URL required for on-chain verification.');
    if (!predecessorAccountId) throw failure('Predecessor account ID required.');

    // 1. Query root public_key from MPC contract
    const rootRes = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'mpc-root-key',
            method: 'query',
            params: {
                request_type: 'call_function',
                account_id: signerContractId,
                method_name: 'public_key',
                args_base64: Buffer.from('{}').toString('base64'),
                finality: 'final',
            },
        }),
    });
    const rootBody = await rootRes.json();
    if (!rootBody.result?.result) {
        throw failure(`Failed to read public_key from signer contract ${signerContractId}`);
    }
    const contractRootKey = JSON.parse(Buffer.from(rootBody.result.result).toString('utf8'));

    // 2. Query derived_public_key from MPC contract (Domain ID 0 for ECDSA/secp256k1)
    const derivedRes = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'mpc-derived-key',
            method: 'query',
            params: {
                request_type: 'call_function',
                account_id: signerContractId,
                method_name: 'derived_public_key',
                args_base64: Buffer.from(JSON.stringify({
                    path,
                    predecessor: predecessorAccountId,
                    domain_id: 0,
                })).toString('base64'),
                finality: 'final',
            },
        }),
    });
    const derivedBody = await derivedRes.json();
    if (!derivedBody.result?.result) {
        throw failure(`Failed to read derived_public_key from signer contract ${signerContractId}`);
    }
    const contractChildKey = JSON.parse(Buffer.from(derivedBody.result.result).toString('utf8'));

    // 3. Compute EVM address from contract returned child key
    const decodedBytes = bs58.decode(contractChildKey.split(':')[1]);
    if (decodedBytes.length !== 64) {
        throw failure(`Contract returned invalid child key length: ${decodedBytes.length}`);
    }
    const evmHash = Buffer.from(keccak_256(decodedBytes));
    const contractDerivedAddress = toChecksumAddress(`0x${evmHash.slice(-20).toString('hex')}`);

    // 4. Run local derivation
    const localDerived = deriveBaseAddress(predecessorAccountId, path, contractRootKey);

    // 5. Cross-check assertions
    const rootKeyMatches = contractRootKey === DEFAULT_TESTNET_MPC_ROOT_KEY;
    const childKeyMatches = contractChildKey === localDerived.childPublicKeyBase58;
    const addressMatches = contractDerivedAddress === localDerived.address;

    if (!childKeyMatches || !addressMatches) {
        throw failure(`MPC cross-check mismatch! Contract key: ${contractChildKey}, local key: ${localDerived.childPublicKeyBase58}, contract addr: ${contractDerivedAddress}, local addr: ${localDerived.address}`);
    }

    if (expectedAddress && expectedAddress.toLowerCase() !== contractDerivedAddress.toLowerCase()) {
        throw failure(`Derived address mismatch: expected ${expectedAddress}, got ${contractDerivedAddress}`);
    }

    return {
        verified: true,
        signerContractId,
        contractRootKey,
        rootKeyMatches,
        contractChildKey,
        childKeyMatches,
        derivedAddress: contractDerivedAddress,
        addressMatches,
        predecessorAccountId,
        derivationPath: path,
    };
}

async function fetchNearAssets(rpcUrl, associatedAccountId, fetchImpl = globalThis.fetch) {
    if (!associatedAccountId) throw failure('Associated account ID required.');
    const assets = [];

    // 1. Native NEAR balance
    try {
        const response = await fetchImpl(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'near-native-balance',
                method: 'query',
                params: {
                    request_type: 'view_account',
                    account_id: associatedAccountId,
                    finality: 'final',
                },
            }),
        });
        const body = await response.json();
        if (body.result && body.result.amount !== undefined) {
            const rawAmount = body.result.amount;
            const storageUsage = body.result.storage_usage || 0;
            const storageCostYocto = BigInt(storageUsage) * (10n ** 19n);
            const totalBalance = BigInt(rawAmount);
            const spendableYocto = totalBalance > storageCostYocto ? totalBalance - storageCostYocto : 0n;

            assets.push({
                id: 'native-near',
                symbol: 'NEAR',
                name: 'NEAR Native',
                contractId: null,
                decimals: 24,
                rawBalance: rawAmount,
                spendableRawBalance: spendableYocto.toString(),
                storageReserveRawBalance: storageCostYocto.toString(),
                formattedBalance: formatUnits(rawAmount, 24),
                formattedSpendable: formatUnits(spendableYocto.toString(), 24),
                type: 'native',
                category: 'core',
                isTestFixture: false,
                status: 'verified',
            });
        } else {
            assets.push({
                id: 'native-near',
                symbol: 'NEAR',
                name: 'NEAR Native',
                contractId: null,
                decimals: 24,
                rawBalance: '0',
                formattedBalance: '0',
                type: 'native',
                category: 'core',
                isTestFixture: false,
                status: 'account_not_found',
            });
        }
    } catch (error) {
        assets.push({
            id: 'native-near',
            symbol: 'NEAR',
            name: 'NEAR Native',
            contractId: null,
            decimals: 24,
            rawBalance: null,
            formattedBalance: '—',
            type: 'native',
            category: 'core',
            isTestFixture: false,
            status: 'rpc_error',
            error: error.message,
        });
    }

    // 2. NEP-141 Registry
    const ftTokens = NEAR_TOKEN_REGISTRY.filter(t => t.type === 'nep141');
    for (const token of ftTokens) {
        try {
            const response = await fetchImpl(rpcUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: `ft-balance-${token.contractId}`,
                    method: 'query',
                    params: {
                        request_type: 'call_function',
                        account_id: token.contractId,
                        method_name: 'ft_balance_of',
                        args_base64: Buffer.from(JSON.stringify({ account_id: associatedAccountId })).toString('base64'),
                        finality: 'final',
                    },
                }),
            });
            const body = await response.json();
            if (body.result && Array.isArray(body.result.result)) {
                const utf8 = Buffer.from(body.result.result).toString('utf8');
                const rawBalance = JSON.parse(utf8);
                assets.push({
                    id: token.id,
                    symbol: token.symbol,
                    name: token.name,
                    contractId: token.contractId,
                    decimals: token.decimals,
                    rawBalance: String(rawBalance),
                    formattedBalance: formatUnits(String(rawBalance), token.decimals),
                    type: 'nep141',
                    category: token.category,
                    isTestFixture: token.isTestFixture,
                    fixtureNote: token.fixtureNote || null,
                    status: 'verified',
                });
            } else {
                assets.push({
                    id: token.id,
                    symbol: token.symbol,
                    name: token.name,
                    contractId: token.contractId,
                    decimals: token.decimals,
                    rawBalance: '0',
                    formattedBalance: '0',
                    type: 'nep141',
                    category: token.category,
                    isTestFixture: token.isTestFixture,
                    fixtureNote: token.fixtureNote || null,
                    status: 'zero_balance',
                });
            }
        } catch (error) {
            assets.push({
                id: token.id,
                symbol: token.symbol,
                name: token.name,
                contractId: token.contractId,
                decimals: token.decimals,
                rawBalance: null,
                formattedBalance: '—',
                type: 'nep141',
                category: token.category,
                isTestFixture: token.isTestFixture,
                fixtureNote: token.fixtureNote || null,
                status: 'rpc_error',
                error: error.message,
            });
        }
    }

    return assets;
}

async function fetchBaseSepoliaAssets(rpcUrl, evmAddress, fetchImpl = globalThis.fetch) {
    if (!evmAddress) throw failure('EVM address required.');
    const assets = [];

    // 0. Verify chain ID
    const chainIdRes = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'base-chain-id',
            method: 'eth_chainId',
            params: [],
        }),
    });
    const chainIdBody = await chainIdRes.json();
    const currentChainId = parseInt(chainIdBody.result, 16);
    if (currentChainId !== BASE_SEPOLIA_CHAIN_ID) {
        throw failure(`Base RPC returned chain ID ${currentChainId}, expected ${BASE_SEPOLIA_CHAIN_ID}.`);
    }

    // 1. Native ETH balance
    try {
        const response = await fetchImpl(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'eth-balance',
                method: 'eth_getBalance',
                params: [evmAddress, 'latest'],
            }),
        });
        const body = await response.json();
        if (body.result) {
            const rawWei = BigInt(body.result).toString();
            assets.push({
                id: 'native-eth',
                symbol: 'ETH',
                name: 'Ether (Sepolia)',
                address: null,
                decimals: 18,
                rawBalance: rawWei,
                formattedBalance: formatUnits(rawWei, 18),
                type: 'native',
                category: 'core',
                isTestFixture: false,
                status: 'verified',
            });
        } else {
            assets.push({
                id: 'native-eth',
                symbol: 'ETH',
                name: 'Ether (Sepolia)',
                address: null,
                decimals: 18,
                rawBalance: null,
                formattedBalance: '—',
                type: 'native',
                category: 'core',
                isTestFixture: false,
                status: 'rpc_error',
            });
        }
    } catch (error) {
        assets.push({
            id: 'native-eth',
            symbol: 'ETH',
            name: 'Ether (Sepolia)',
            address: null,
            decimals: 18,
            rawBalance: null,
            formattedBalance: '—',
            type: 'native',
            category: 'core',
            isTestFixture: false,
            status: 'rpc_error',
            error: error.message,
        });
    }

    // 2. ERC-20 Registry
    const erc20Tokens = BASE_SEPOLIA_TOKEN_REGISTRY.filter(t => t.type === 'erc20');
    const cleanAddress = evmAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const balanceOfCallData = `0x70a08231${cleanAddress}`;

    for (const token of erc20Tokens) {
        try {
            const response = await fetchImpl(rpcUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: `erc20-balance-${token.address}`,
                    method: 'eth_call',
                    params: [{ to: token.address, data: balanceOfCallData }, 'latest'],
                }),
            });
            const body = await response.json();
            if (body.result && body.result !== '0x') {
                const rawAmount = BigInt(body.result).toString();
                assets.push({
                    id: token.id,
                    symbol: token.symbol,
                    name: token.name,
                    address: token.address,
                    decimals: token.decimals,
                    rawBalance: rawAmount,
                    formattedBalance: formatUnits(rawAmount, token.decimals),
                    type: 'erc20',
                    category: token.category,
                    isTestFixture: token.isTestFixture,
                    contractLabel: token.contractLabel || null,
                    status: 'verified',
                });
            } else {
                assets.push({
                    id: token.id,
                    symbol: token.symbol,
                    name: token.name,
                    address: token.address,
                    decimals: token.decimals,
                    rawBalance: '0',
                    formattedBalance: '0',
                    type: 'erc20',
                    category: token.category,
                    isTestFixture: token.isTestFixture,
                    contractLabel: token.contractLabel || null,
                    status: 'zero_balance',
                });
            }
        } catch (error) {
            assets.push({
                id: token.id,
                symbol: token.symbol,
                name: token.name,
                address: token.address,
                decimals: token.decimals,
                rawBalance: null,
                formattedBalance: '—',
                type: 'erc20',
                category: token.category,
                isTestFixture: token.isTestFixture,
                contractLabel: token.contractLabel || null,
                status: 'rpc_error',
                error: error.message,
            });
        }
    }

    return assets;
}

async function getMultiChainPortfolio({
    tokenId,
    relayContractId,
    nearRpcUrl,
    baseRpcUrl,
    mpcRootKey = DEFAULT_TESTNET_MPC_ROOT_KEY,
    derivationPath = DEFAULT_DERIVATION_PATH,
    fetchImpl = globalThis.fetch,
}) {
    if (!tokenId) throw failure('Token ID is required.');
    if (!relayContractId) throw failure('RELAY contract ID is required.');

    // 1. Fetch token and binding from parent contract
    const argsToken = Buffer.from(JSON.stringify({ token_id: tokenId })).toString('base64');
    const [tokenRes, bindingRes] = await Promise.all([
        fetchImpl(nearRpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'portfolio-nft-token',
                method: 'query',
                params: {
                    request_type: 'call_function',
                    account_id: relayContractId,
                    method_name: 'nft_token',
                    args_base64: argsToken,
                    finality: 'final',
                },
            }),
        }),
        fetchImpl(nearRpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'portfolio-binding',
                method: 'query',
                params: {
                    request_type: 'call_function',
                    account_id: relayContractId,
                    method_name: 'relay_account_binding',
                    args_base64: argsToken,
                    finality: 'final',
                },
            }),
        }),
    ]);

    const tokenBody = await tokenRes.json();
    const bindingBody = await bindingRes.json();

    if (!tokenBody.result?.result || !bindingBody.result?.result) {
        throw Object.assign(new Error(`RELAY token ${tokenId} or associated binding not found.`), { status: 404 });
    }

    const nft = JSON.parse(Buffer.from(tokenBody.result.result).toString('utf8'));
    const binding = JSON.parse(Buffer.from(bindingBody.result.result).toString('utf8'));

    const canonicalSubaccountId = `${tokenId}.${relayContractId}`;
    if (binding.account_id !== canonicalSubaccountId) {
        throw failure(`Non-canonical binding detected: ${binding.account_id} != ${canonicalSubaccountId}`);
    }

    // 2. Deterministically derive Base address from canonical subaccount
    const baseDerivation = deriveBaseAddress(canonicalSubaccountId, derivationPath, mpcRootKey);

    // 3. Concurrently fetch assets from NEAR Testnet and Base Sepolia
    const [nearAssets, baseAssets] = await Promise.all([
        fetchNearAssets(nearRpcUrl, canonicalSubaccountId, fetchImpl),
        fetchBaseSepoliaAssets(baseRpcUrl, baseDerivation.address, fetchImpl),
    ]);

    return {
        tokenId,
        ownerId: nft.owner_id,
        metadata: nft.metadata || null,
        binding: {
            accountId: binding.account_id,
            isVerified: binding.is_verified === true,
            canonical: true,
        },
        chains: {
            near: {
                network: 'near-testnet',
                accountId: canonicalSubaccountId,
                explorerUrl: `https://testnet.nearblocks.io/account/${encodeURIComponent(canonicalSubaccountId)}`,
                assets: nearAssets,
            },
            base: {
                network: 'base-sepolia',
                chainId: BASE_SEPOLIA_CHAIN_ID,
                address: baseDerivation.address,
                childPublicKey: baseDerivation.childPublicKeyBase58,
                derivationPath: baseDerivation.derivationPath,
                mpcRootKey: baseDerivation.mpcRootPublicKey,
                explorerUrl: `https://sepolia.basescan.org/address/${encodeURIComponent(baseDerivation.address)}`,
                assets: baseAssets,
            },
        },
        disclaimer: 'TESTNET_ONLY: NEAR Testnet and Base Sepolia assets are strictly for demonstration and testing. They carry no real-world monetary value.',
        readAt: new Date().toISOString(),
    };
}

module.exports = {
    BASE_SEPOLIA_CHAIN_ID,
    BASE_SEPOLIA_CHAIN_ID_HEX,
    BASE_SEPOLIA_TOKEN_REGISTRY,
    CHAIN_DERIVATION_PATHS,
    DEFAULT_DERIVATION_PATH,
    DEFAULT_SIGNER_CONTRACT_ID,
    DEFAULT_TESTNET_MPC_ROOT_KEY,
    EPSILON_DERIVATION_PREFIX,
    NEAR_TOKEN_REGISTRY,
    deriveBaseAddress,
    fetchBaseSepoliaAssets,
    fetchNearAssets,
    formatUnits,
    getMultiChainPortfolio,
    parseMpcRootPublicKey,
    toChecksumAddress,
    verifyMpcDerivationOnChain,
};
