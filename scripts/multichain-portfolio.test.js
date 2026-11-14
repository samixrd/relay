'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    BASE_SEPOLIA_CHAIN_ID,
    BASE_SEPOLIA_TOKEN_REGISTRY,
    DEFAULT_DERIVATION_PATH,
    DEFAULT_SIGNER_CONTRACT_ID,
    DEFAULT_TESTNET_MPC_ROOT_KEY,
    NEAR_TOKEN_REGISTRY,
    deriveBaseAddress,
    fetchBaseSepoliaAssets,
    fetchNearAssets,
    formatUnits,
    getMultiChainPortfolio,
    parseMpcRootPublicKey,
    toChecksumAddress,
    verifyMpcDerivationOnChain,
} = require('./multichain-portfolio');

test('toChecksumAddress produces correct EIP-55 checksum', () => {
    const raw = '0x38abe88c03ff091c05c2998255629d0757bfbf71';
    const checksummed = toChecksumAddress(raw);
    assert.equal(checksummed, '0x38ABE88c03FF091C05c2998255629D0757BFBF71');

    assert.throws(() => toChecksumAddress('0x123'), /Invalid EVM address length/);
    assert.throws(() => toChecksumAddress('invalid-hex-address-that-is-forty-characters!'), /Invalid EVM address length/);
});

test('formatUnits formats amounts across 24, 18, and 6 decimal tokens', () => {
    // 24 decimals (NEAR)
    assert.equal(formatUnits('1749930000000000000000000', 24), '1.74993');
    assert.equal(formatUnits('10000000000000000000000', 24), '0.01');
    assert.equal(formatUnits('0', 24), '0');

    // 18 decimals (ETH / WETH)
    assert.equal(formatUnits('1500000000000000000', 18), '1.5');
    assert.equal(formatUnits('0', 18), '0');

    // 6 decimals (USDC)
    assert.equal(formatUnits('50000000', 6), '50');
    assert.equal(formatUnits('1234567', 6), '1.234567');

    assert.equal(formatUnits(null, 18), '—');
    assert.equal(formatUnits('not-a-number', 18), '—');
});

test('parseMpcRootPublicKey parses secp256k1 base58 public keys', () => {
    const point = parseMpcRootPublicKey(DEFAULT_TESTNET_MPC_ROOT_KEY);
    assert.ok(point);
    assert.equal(typeof point.x, 'bigint');
    assert.equal(typeof point.y, 'bigint');

    assert.throws(() => parseMpcRootPublicKey('ed25519:something'), /Invalid MPC key format/);
    assert.throws(() => parseMpcRootPublicKey(''), /valid string/);
});

test('deriveBaseAddress derives deterministic Base address from NEAR account', () => {
    const subaccount = 'relay-test-1.relay.spellman.testnet';
    const result1 = deriveBaseAddress(subaccount, 'relay-v1');
    const result2 = deriveBaseAddress(subaccount, 'relay-v1');

    // Deterministic: repeated derivation yields identical address and child public key
    assert.equal(result1.address, result2.address);
    assert.equal(result1.childPublicKeyBase58, result2.childPublicKeyBase58);
    assert.equal(result1.derivationPath, 'relay-v1');
    assert.equal(result1.predecessorAccountId, subaccount);
    assert.match(result1.address, /^0x[0-9a-fA-F]{40}$/);

    // Domain separation: different derivation paths produce different Base addresses
    const resultDiffPath = deriveBaseAddress(subaccount, 'relay-v2');
    assert.notEqual(result1.address, resultDiffPath.address);

    // Domain separation: different predecessor accounts produce different Base addresses
    const resultDiffAccount = deriveBaseAddress('other-token.relay.spellman.testnet', 'relay-v1');
    assert.notEqual(result1.address, resultDiffAccount.address);

    assert.throws(() => deriveBaseAddress('', 'relay-v1'), /valid NEAR predecessor account ID/);
    assert.throws(() => deriveBaseAddress(subaccount, ''), /non-empty string/);
});

test('deriveBaseAddress preserves identical Base address across NFT ownership handoff', () => {
    const canonicalSubaccount = 'relay-test-1.relay.spellman.testnet';

    // Before transfer (when owned by Owner A: spellman.testnet)
    const baseAddressOwnerA = deriveBaseAddress(canonicalSubaccount, 'relay-v1');

    // After transfer (when owned by Owner B: relay-owner-b.spellman.testnet)
    const baseAddressOwnerB = deriveBaseAddress(canonicalSubaccount, 'relay-v1');

    // Ownership handoff MUST NOT alter the derived Base address!
    assert.equal(baseAddressOwnerA.address, baseAddressOwnerB.address);
    assert.equal(baseAddressOwnerA.childPublicKeyBase58, baseAddressOwnerB.childPublicKeyBase58);
});

test('verifyMpcDerivationOnChain cross-checks local derivation against official signer contract views', async () => {
    const predecessorAccountId = 'relay-test-1.relay.spellman.testnet';
    const path = 'relay-v1';
    const expectedChildKey = 'secp256k1:5iHA5aR6wwEvLES6AZ8HNMKvoKqHKdR6gvnzJBN3rnXKHsaAqES7CYaXMp28azoHPEchV6Efwj1DZ5sDajHPiTR4';
    const expectedAddress = '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D';

    const mockFetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.id === 'mpc-root-key') {
            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        result: Array.from(Buffer.from(JSON.stringify(DEFAULT_TESTNET_MPC_ROOT_KEY))),
                    },
                }),
            };
        }
        if (body.id === 'mpc-derived-key') {
            assert.equal(body.params.account_id, DEFAULT_SIGNER_CONTRACT_ID);
            const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString('utf8'));
            assert.equal(args.path, path);
            assert.equal(args.predecessor, predecessorAccountId);
            assert.equal(args.domain_id, 0);

            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        result: Array.from(Buffer.from(JSON.stringify(expectedChildKey))),
                    },
                }),
            };
        }
        throw new Error(`Unexpected mock call: ${body.id}`);
    };

    const crossCheck = await verifyMpcDerivationOnChain({
        rpcUrl: 'https://mock.near',
        predecessorAccountId,
        path,
        expectedAddress,
        fetchImpl: mockFetch,
    });

    assert.equal(crossCheck.verified, true);
    assert.equal(crossCheck.rootKeyMatches, true);
    assert.equal(crossCheck.childKeyMatches, true);
    assert.equal(crossCheck.addressMatches, true);
    assert.equal(crossCheck.derivedAddress, expectedAddress);
    assert.equal(crossCheck.contractChildKey, expectedChildKey);
});

test('verifyMpcDerivationOnChain rejects child key or address mismatch', async () => {
    const mockMismatchedFetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.id === 'mpc-root-key') {
            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        result: Array.from(Buffer.from(JSON.stringify(DEFAULT_TESTNET_MPC_ROOT_KEY))),
                    },
                }),
            };
        }
        if (body.id === 'mpc-derived-key') {
            // Return a mismatched key
            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        result: Array.from(Buffer.from(JSON.stringify('secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3'))),
                    },
                }),
            };
        }
        throw new Error('Unexpected call');
    };

    await assert.rejects(
        () => verifyMpcDerivationOnChain({
            rpcUrl: 'https://mock.near',
            predecessorAccountId: 'relay-test-1.relay.spellman.testnet',
            fetchImpl: mockMismatchedFetch,
        }),
        /MPC cross-check mismatch/
    );
});

test('token registries distinguish core verified assets from testnet fixtures', () => {
    // Core NEAR assets
    const nativeNear = NEAR_TOKEN_REGISTRY.find(t => t.id === 'native-near');
    assert.equal(nativeNear.isTestFixture, false);
    assert.equal(nativeNear.category, 'core');

    const wnear = NEAR_TOKEN_REGISTRY.find(t => t.id === 'wrap.testnet');
    assert.equal(wnear.isTestFixture, false);
    assert.equal(wnear.category, 'core');

    // Test fixtures
    const usdcFake = NEAR_TOKEN_REGISTRY.find(t => t.id === 'usdc.fakes.testnet');
    assert.equal(usdcFake.isTestFixture, true);
    assert.equal(usdcFake.category, 'testnet-fixture');
    assert.match(usdcFake.fixtureNote, /faucet test fixture/);

    const usdtFake = NEAR_TOKEN_REGISTRY.find(t => t.id === 'usdt.fakes.testnet');
    assert.equal(usdtFake.isTestFixture, true);
    assert.equal(usdtFake.category, 'testnet-fixture');

    // Base Sepolia core assets
    const baseEth = BASE_SEPOLIA_TOKEN_REGISTRY.find(t => t.id === 'native-eth');
    assert.equal(baseEth.isTestFixture, false);
    assert.equal(baseEth.category, 'core');

    const baseUsdc = BASE_SEPOLIA_TOKEN_REGISTRY.find(t => t.symbol === 'USDC');
    assert.equal(baseUsdc.isTestFixture, false);
    assert.equal(baseUsdc.contractLabel, 'Circle Testnet USDC');
});

test('fetchNearAssets reads native balance and NEP-141 registry tokens', async () => {
    const mockFetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.method === 'query' && body.params.request_type === 'view_account') {
            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        amount: '1749930000000000000000000',
                        storage_usage: 150180,
                    },
                }),
            };
        }
        if (body.method === 'query' && body.params.request_type === 'call_function') {
            const token = body.params.account_id;
            const balanceMap = {
                'wrap.testnet': '500000000000000000000000', // 0.5 wNEAR
                'usdc.fakes.testnet': '25000000', // 25 USDC
                'usdt.fakes.testnet': '0',
            };
            const balance = balanceMap[token] || '0';
            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        result: Array.from(Buffer.from(JSON.stringify(balance))),
                    },
                }),
            };
        }
        throw new Error('Unexpected RPC call');
    };

    const assets = await fetchNearAssets('https://mock.rpc', 'relay-test-1.relay.spellman.testnet', mockFetch);
    assert.equal(assets.length, 4);

    const native = assets.find(a => a.id === 'native-near');
    assert.equal(native.symbol, 'NEAR');
    assert.equal(native.formattedBalance, '1.74993');
    assert.equal(native.formattedSpendable, '0.24813');
    assert.equal(native.status, 'verified');

    const wnear = assets.find(a => a.id === 'wrap.testnet');
    assert.equal(wnear.symbol, 'wNEAR');
    assert.equal(wnear.formattedBalance, '0.5');

    const usdc = assets.find(a => a.id === 'usdc.fakes.testnet');
    assert.equal(usdc.symbol, 'USDC.e');
    assert.equal(usdc.formattedBalance, '25');
    assert.equal(usdc.isTestFixture, true);
});

test('fetchBaseSepoliaAssets validates chain ID and reads native ETH and ERC-20 tokens', async () => {
    const mockFetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.method === 'eth_chainId') {
            return {
                ok: true,
                json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x14a34' }), // 84532
            };
        }
        if (body.method === 'eth_getBalance') {
            return {
                ok: true,
                json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0xde0b6b3a7640000' }), // 1 ETH
            };
        }
        if (body.method === 'eth_call') {
            const tokenAddress = body.params[0].to;
            if (tokenAddress.toLowerCase() === '0x036cbd53842c5426634e7929541ec2318f3dcf7e') {
                return {
                    ok: true,
                    json: async () => ({
                        jsonrpc: '2.0',
                        id: body.id,
                        result: '0x0000000000000000000000000000000000000000000000000000000005f5e100', // 100 USDC
                    }),
                };
            }
            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: '0x0000000000000000000000000000000000000000000000000000000000000000',
                }),
            };
        }
        throw new Error('Unexpected Base RPC call');
    };

    const assets = await fetchBaseSepoliaAssets('https://mock.base', '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D', mockFetch);
    assert.equal(assets.length, 3);

    const eth = assets.find(a => a.id === 'native-eth');
    assert.equal(eth.symbol, 'ETH');
    assert.equal(eth.formattedBalance, '1');

    const usdc = assets.find(a => a.symbol === 'USDC');
    assert.equal(usdc.formattedBalance, '100');
    assert.equal(usdc.decimals, 6);
});

test('fetchBaseSepoliaAssets rejects invalid chain ID', async () => {
    const mockWrongChain = async () => ({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }), // Ethereum Mainnet (1) instead of Base Sepolia (84532)
    });

    await assert.rejects(
        () => fetchBaseSepoliaAssets('https://mock.base', '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D', mockWrongChain),
        /Base RPC returned chain ID 1, expected 84532/
    );
});

test('getMultiChainPortfolio compiles verified portfolio with testnet disclaimer', async () => {
    const mockFetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.id === 'portfolio-nft-token') {
            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        result: Array.from(Buffer.from(JSON.stringify({
                            token_id: 'relay-test-1',
                            owner_id: 'relay-owner-b.spellman.testnet',
                            metadata: { title: 'RELAY Test Token' },
                        }))),
                    },
                }),
            };
        }
        if (body.id === 'portfolio-binding') {
            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        result: Array.from(Buffer.from(JSON.stringify({
                            account_id: 'relay-test-1.relay.spellman.testnet',
                            is_verified: true,
                        }))),
                    },
                }),
            };
        }
        if (body.method === 'eth_chainId') {
            return {
                ok: true,
                json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x14a34' }),
            };
        }
        if (body.method === 'eth_getBalance') {
            return {
                ok: true,
                json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x0' }),
            };
        }
        if (body.method === 'eth_call') {
            return {
                ok: true,
                json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x0' }),
            };
        }
        if (body.method === 'query') {
            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        amount: '1749930000000000000000000',
                        storage_usage: 150180,
                    },
                }),
            };
        }
        throw new Error(`Unexpected mock call: ${body.method || body.id}`);
    };

    const portfolio = await getMultiChainPortfolio({
        tokenId: 'relay-test-1',
        relayContractId: 'relay.spellman.testnet',
        nearRpcUrl: 'https://mock.near',
        baseRpcUrl: 'https://mock.base',
        fetchImpl: mockFetch,
    });

    assert.equal(portfolio.tokenId, 'relay-test-1');
    assert.equal(portfolio.ownerId, 'relay-owner-b.spellman.testnet');
    assert.equal(portfolio.binding.accountId, 'relay-test-1.relay.spellman.testnet');
    assert.equal(portfolio.binding.isVerified, true);
    assert.equal(portfolio.chains.base.address, '0x7aE89c639BE3057CbD89441B9180E3c2EA882E2D');
    assert.equal(portfolio.chains.base.chainId, 84532);
    assert.ok(portfolio.chains.near.assets.length > 0);
    assert.ok(portfolio.chains.base.assets.length > 0);
    assert.match(portfolio.disclaimer, /TESTNET_ONLY/);
});
