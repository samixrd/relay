'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createConfig } = require('./app-config');
const { createAppServer, verifyFinalizedTransferTransaction } = require('./app-server');
const { createClaimJournal } = require('./claim-journal');

async function withServer(server, run) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

function jsonResponse(result) {
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 'relay-app', result }) };
}

function getWithHeaders(url, headers) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, { headers }, (response) => {
            response.resume();
            response.on('end', () => resolve(response));
        });
        request.on('error', reject);
    });
}

test('serves static app and public config without browser-facing credentials', async () => {
    const config = createConfig({ RELAY_CONTRACT_ID: 'relay.testnet', NEAR_AUTH_SPONSOR_PRIVATE_KEY: 'ed25519:do-not-expose' });
    const server = createAppServer({ config });
    await withServer(server, async (base) => {
        const [pageResponse, configResponse] = await Promise.all([
            fetch(base),
            fetch(`${base}/api/config`),
        ]);
        assert.equal(pageResponse.status, 200);
        assert.equal(pageResponse.headers.get('x-frame-options'), 'DENY');
        assert.match(pageResponse.headers.get('content-security-policy'), /default-src 'self'/);
        assert.match(await pageResponse.text(), /RELAY — A card that carries an account/);
        const publicValues = await configResponse.json();
        assert.equal(JSON.stringify(publicValues).includes('do-not-expose'), false);
        assert.equal(publicValues.near.relayContractId, 'relay.testnet');
        assert.equal(Object.hasOwn(publicValues, 'oneClick'), false);
        assert.equal(Object.hasOwn(publicValues, 'baseSepolia'), false);
        assert.equal(configResponse.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(configResponse.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
    });

});

test('reports NEAR Testnet status only, without Base or 1Click claims', async () => {
    const config = createConfig({});
    const calls = [];
    const fetchImpl = async (_url, options) => {
        const body = JSON.parse(options.body);
        calls.push(body.method);
        if (body.method === 'status') return jsonResponse({ chain_id: 'testnet' });
        throw new Error(`unexpected RPC ${body.method}`);
    };
    const server = createAppServer({ config, fetchImpl });
    await withServer(server, async (base) => {
        const response = await fetch(`${base}/api/status`);
        const status = await response.json();
        assert.deepEqual(status.rpcChecks.map((item) => item.label), ['NEAR RPC']);
        assert.equal(status.rpcChecks[0].status, 'available');
        assert.equal(status.contract.status, 'unconfigured');
        assert.equal(status.nearAuth.status, 'google-auth0-mpc-ed25519');
        assert.equal(Object.hasOwn(status, 'oneClick'), false);
        assert.equal(Object.hasOwn(status, 'chainSignatures'), false);
        assert.ok(calls.includes('status'));
        assert.ok(!calls.includes('sendTransaction'));
    });
});

test('rejects hostile Host and cross-origin headers without adding CORS access', async () => {
    const server = createAppServer({ config: createConfig({}) });
    await withServer(server, async (base) => {
        const hostileHost = await getWithHeaders(base, { host: 'attacker.example' });
        assert.equal(hostileHost.statusCode, 403);
        const hostileOrigin = await fetch(`${base}/api/config`, { headers: { origin: 'http://attacker.example' } });
        assert.equal(hostileOrigin.status, 403);
        const local = await fetch(`${base}/api/config`);
        assert.equal(local.status, 200);
        assert.equal(local.headers.get('access-control-allow-origin'), null);
    });
});

test('does not return upstream RPC error messages to the browser', async () => {
    const config = createConfig({});
    const fetchImpl = async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.method === 'status') {
            return {
                ok: true,
                status: 200,
                json: async () => ({ error: { message: 'credential=secret-value' } }),
            };
        }
        if (body.method === 'eth_chainId') return jsonResponse('0x14a34');
        throw new Error(`unexpected RPC ${body.method}`);
    };
    const server = createAppServer({ config, fetchImpl });
    await withServer(server, async (base) => {
        const text = await (await fetch(`${base}/api/status`)).text();
        assert.equal(text.includes('secret-value'), false);
        assert.match(text, /Configured endpoint did not pass its read-only check/);
    });
});

test('serves real account reads at one finalized block and makes unavailable inventories explicit', async () => {
    const config = createConfig({ RELAY_CONTRACT_ID: 'relay.testnet' });
    const fetchImpl = async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.method === 'status') return jsonResponse({ chain_id: 'testnet' });
        if (body.method === 'block') return jsonResponse({ header: { hash: 'final-hash', height: 88 } });
        if (body.method !== 'query') throw new Error(`unexpected RPC ${body.method}`);
        const params = body.params;
        if (params.request_type === 'view_account') {
            assert.equal(params.account_id, 'item.relay.testnet');
            return jsonResponse({ amount: '1234500000000000000000000', locked: '1000000000000000000000', storage_usage: 500 });
        }
        assert.equal(params.block_id, 'final-hash');
        const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
        const values = {
            nft_token: { owner_id: 'owner.testnet', metadata: { title: 'Example RELAY' } },
            relay_account_binding: { account_id: 'item.relay.testnet', is_verified: true },
            is_token_locked: false,
            relay_credits: { total: 3, remaining: 2 },
            relay_payment: null,
            relay_active_quote_authorization: null,
        };
        assert.equal(args.token_id, 'item');
        return jsonResponse({ result: [...Buffer.from(JSON.stringify(values[params.method_name]))], block_hash: 'final-hash' });
    };
    const server = createAppServer({ config, fetchImpl });
    await withServer(server, async (base) => {
        const response = await fetch(`${base}/api/accounts/item`);
        assert.equal(response.status, 200);
        const account = await response.json();
        assert.equal(account.token.ownerId, 'owner.testnet');
        assert.equal(account.associatedAccount.isVerified, true);
        assert.equal(account.associatedAccount.nearBalanceYocto, '1234500000000000000000000');
        assert.equal(account.assetInventory.childNfts, 'unavailable-no-cross-contract-inventory-index');
        assert.equal(account.payment, null);
    });
});

test('reports an absent associated account distinctly from an RPC outage', async () => {
    const config = createConfig({ RELAY_CONTRACT_ID: 'relay.testnet' });
    const fetchImpl = async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.method === 'status') return jsonResponse({ chain_id: 'testnet' });
        if (body.method === 'block') return jsonResponse({ header: { hash: 'final-hash', height: 88 } });
        if (body.method !== 'query') throw new Error(`unexpected RPC ${body.method}`);
        if (body.params.request_type === 'view_account') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: 'relay-app',
                    error: { message: 'Account item.relay.testnet does not exist while viewing' },
                }),
            };
        }
        const value = body.params.method_name === 'nft_token'
            ? { owner_id: 'owner.testnet' }
            : { account_id: 'item.relay.testnet', is_verified: true };
        return jsonResponse({ result: [...Buffer.from(JSON.stringify(value))], block_hash: 'final-hash' });
    };
    const server = createAppServer({ config, fetchImpl });
    await withServer(server, async (base) => {
        const response = await fetch(`${base}/api/accounts/item`);
        assert.equal(response.status, 404);
        const body = await response.json();
        assert.equal(body.code, 'ASSOCIATED_ACCOUNT_NOT_FOUND');
        assert.match(body.error, /does not exist at the finalized block/);
    });
});


test('NEAR account reads fail closed when the RPC chain does not match configuration', async () => {
    const config = createConfig({ RELAY_CONTRACT_ID: 'relay.testnet' });
    const server = createAppServer({
        config,
        fetchImpl: async () => jsonResponse({ chain_id: 'mainnet' }),
    });
    await withServer(server, async (base) => {
        const response = await fetch(`${base}/api/accounts/item`);
        assert.equal(response.status, 503);
        assert.match((await response.json()).error, /expected testnet/);
    });
});

test('rejects malformed inputs and prevents path traversal', async () => {
    const server = createAppServer({ config: createConfig({ RELAY_CONTRACT_ID: 'relay.testnet' }) });
    await withServer(server, async (base) => {
        const missing = await fetch(`${base}/api/accounts/invalid.id`);
        assert.equal(missing.status, 400);
        const traversal = await fetch(`${base}/..%5c.env`);
        assert.equal(traversal.status, 400);
        // Removed Base/1Click surfaces must not answer.
        const checkout = await fetch(`${base}/api/checkout/assets`);
        assert.equal(checkout.status, 404);
        const quotes = await fetch(`${base}/api/quotes/preview`, { method: 'POST' });
        assert.equal(quotes.status, 405);
    });
});

test('serves finalized card bundles and NEAR Auth config without Base or 1Click surfaces', async () => {
    const config = createConfig({ RELAY_CONTRACT_ID: 'relay.testnet' });
    const resultJson = (value) => jsonResponse({
        result: Array.from(Buffer.from(JSON.stringify(value))),
    });
    const fetchImpl = async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.method === 'status') return jsonResponse({ chain_id: 'testnet' });
        if (body.method === 'block') {
            return jsonResponse({ header: { hash: '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f', height: 276800000 } });
        }
        if (body.params?.request_type === 'call_function') {
            const method = body.params.method_name;
            const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString('utf8'));
            if (method === 'nft_token') {
                return resultJson({ token_id: args.token_id, owner_id: 'owner.testnet', metadata: { title: 'Test Token' } });
            }
            if (method === 'relay_account_binding') {
                return resultJson({ account_id: `${args.token_id}.relay.testnet`, is_verified: true });
            }
            if (method === 'is_token_locked') return resultJson(false);
            if (method === 'relay_credits') return resultJson({ total: 3, remaining: 3 });
            if (method === 'relay_payment') return resultJson(null);
            if (method === 'relay_active_quote_authorization') return resultJson(null);
            if (method === 'token_lifecycle') return resultJson('Unlocked');
            if (method === 'relay_provisioning_state') return resultJson('Completed');
        }
        if (body.params?.request_type === 'view_account') {
            return jsonResponse({ amount: '2000000000000000000000000', storage_usage: 1000 });
        }
        throw new Error(`Unexpected mock call: ${JSON.stringify(body)}`);
    };

    const server = createAppServer({ config, fetchImpl });
    await withServer(server, async (base) => {
        const cardRes = await fetch(`${base}/api/cards/test-1`);
        assert.equal(cardRes.status, 200);
        const card = await cardRes.json();
        assert.equal(card.token.id, 'test-1');
        assert.equal(card.token.ownerId, 'owner.testnet');
        assert.equal(card.binding.accountId, 'test-1.relay.testnet');
        assert.equal(card.binding.isVerified, true);
        assert.equal(card.network, 'testnet');
        assert.equal(Object.hasOwn(card, 'baseSepolia'), false);

        const authRes = await fetch(`${base}/api/auth/config`);
        assert.equal(authRes.status, 200);
        const auth = await authRes.json();
        assert.equal(auth.provider, 'google');

        const nearAuthRes = await fetch(`${base}/api/auth/near/config`);
        assert.equal(nearAuthRes.status, 200);
        const nearAuth = await nearAuthRes.json();
        assert.equal(nearAuth.network, 'testnet');
        assert.equal(nearAuth.flow, 'google-auth0-mpc-ed25519');
    });
});

test('handles claim session creation, verification, transfer preparation, and mpc verify endpoints', async () => {
    let lifecycleState = 'Unlocked';
    const config = createConfig({
        RELAY_CONTRACT_ID: 'relay.spellman.testnet',
        PUBLIC_APP_URL: 'https://relay.example.com',
    });

    const rootKeyStr = 'secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3';
    const childKeyStr = 'secp256k1:5iHA5aR6wwEvLES6AZ8HNMKvoKqHKdR6gvnzJBN3rnXKHsaAqES7CYaXMp28azoHPEchV6Efwj1DZ5sDajHPiTR4';

    const fetchImpl = async (_url, options) => {
        const body = JSON.parse(options.body);

        // Status check
        if (body.method === 'status') {
            return jsonResponse({ chain_id: 'testnet' });
        }

        // Block header
        if (body.method === 'block') {
            return jsonResponse({
                header: {
                    hash: '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f',
                    height: 276800000,
                },
            });
        }

        // View calls
        if (body.params?.request_type === 'call_function') {
            const method = body.params.method_name;
            if (method === 'nft_token') {
                return jsonResponse({
                    result: Array.from(Buffer.from(JSON.stringify({
                        token_id: 'relay-test-1',
                        owner_id: 'relay-owner-b.spellman.testnet',
                        metadata: { title: 'Test Token' },
                    }))),
                });
            }
            if (method === 'token_lifecycle') {
                return jsonResponse({
                    result: Array.from(Buffer.from(JSON.stringify(lifecycleState))),
                });
            }
            if (method === 'token_associated_subaccount' || method === 'relay_account_binding') {
                return jsonResponse({
                    result: Array.from(Buffer.from(JSON.stringify({
                        account_id: 'relay-test-1.relay.spellman.testnet',
                        is_verified: true,
                    }))),
                });
            }
            if (method === 'public_key') {
                return jsonResponse({
                    result: Array.from(Buffer.from(JSON.stringify(rootKeyStr))),
                });
            }
            if (method === 'derived_public_key') {
                return jsonResponse({
                    result: Array.from(Buffer.from(JSON.stringify(childKeyStr))),
                });
            }
            if (method === 'ft_balance_of') {
                return jsonResponse({
                    result: Array.from(Buffer.from(JSON.stringify('0'))),
                });
            }
        }

        // View account
        if (body.params?.request_type === 'view_account') {
            const acc = body.params.account_id;
            if (acc === 'recipient.testnet') {
                return jsonResponse({ amount: '5000000000000000000000000', storage_usage: 1000 });
            }
            if (acc === 'relay-test-1.relay.spellman.testnet') {
                return jsonResponse({ amount: '1749930000000000000000000', storage_usage: 100000 });
            }
            return jsonResponse({ error: 'Account does not exist' });
        }

        // Ethereum RPC calls
        if (body.method === 'eth_chainId') return jsonResponse('0x14a34');
        if (body.method === 'eth_getBalance' || body.method === 'eth_call') return jsonResponse('0x0');

        throw new Error(`Unexpected mock call: ${JSON.stringify(body)}`);
    };

    const server = createAppServer({ config, fetchImpl, journal: createClaimJournal() });
    await withServer(server, async (base) => {
        // 1. Create claim session
        const sessionRes = await fetch(`${base}/api/claim/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                tokenId: 'relay-test-1',
                intendedRecipient: 'recipient.testnet',
            }),
        });
        assert.equal(sessionRes.status, 200);
        const sessionData = await sessionRes.json();
        assert.equal(sessionData.tokenId, 'relay-test-1');
        assert.equal(sessionData.expectedOwner, 'relay-owner-b.spellman.testnet');
        assert.ok(sessionData.claimUrl.startsWith('https://relay.example.com/'));
        assert.ok(sessionData.sessionToken);

        // 2. Query claim session details
        const sessionGetRes = await fetch(`${base}/api/claim/session/${sessionData.sessionToken}`);
        assert.equal(sessionGetRes.status, 200);
        const sessionPreview = await sessionGetRes.json();
        assert.equal(sessionPreview.claimStatus, 'ready_for_recipient');
        assert.equal(sessionPreview.token.id, 'relay-test-1');
        assert.equal(sessionPreview.accounts.near, 'relay-test-1.relay.spellman.testnet');
        assert.equal(Object.hasOwn(sessionPreview.accounts, 'base'), false);

        // 3. Prepare transfer successfully
        const prepRes = await fetch(`${base}/api/claim/prepare-transfer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                tokenId: 'relay-test-1',
                recipientAccountId: 'recipient.testnet',
                sessionToken: sessionData.sessionToken,
            }),
        });
        assert.equal(prepRes.status, 200);
        const prepData = await prepRes.json();
        assert.equal(prepData.prepared, true);
        assert.equal(prepData.transactionPlan.methodName, 'nft_transfer');
        assert.equal(prepData.transactionPlan.args.receiver_id, 'recipient.testnet');
        assert.equal(prepData.transactionPlan.requiredSigner, 'relay-owner-b.spellman.testnet');
        assert.equal(prepData.transactionPlan.args.enforce_subaccount_unlocked, true);

        // 4. Reject transfer if lifecycle is locked
        lifecycleState = { Locked: { reason: 'OneClickCheckout' } };
        const lockedRes = await fetch(`${base}/api/claim/prepare-transfer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                tokenId: 'relay-test-1',
                recipientAccountId: 'recipient.testnet',
                sessionToken: sessionData.sessionToken,
            }),
        });
        assert.equal(lockedRes.status, 409);
        const lockedData = await lockedRes.json();
        assert.equal(lockedData.code, 'TOKEN_LOCKED');
        lifecycleState = 'Unlocked';

        // 5. Removed Base/MPC portfolio surface must not exist.
        const mpcRes = await fetch(`${base}/api/mpc/verify?tokenId=relay-test-1`);
        assert.equal(mpcRes.status, 404);
    });
});

test('Task 37 friend claim journey: Google auth flow, account linking, creator approval, and finality verification', async () => {
    let currentTokenOwner = 'relay-owner-b.spellman.testnet';
    let currentMockNonce = null;
    const config = createConfig({
        RELAY_CONTRACT_ID: 'relay.spellman.testnet',
        PUBLIC_APP_URL: 'https://relay.example.com',
        GOOGLE_CLIENT_ID: 'mock-client.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'mock-secret',
        GOOGLE_REDIRECT_URI: 'https://relay.example.com/api/auth/google/callback',
    });

    const rawJsonResponse = (data) => ({
        ok: true,
        status: 200,
        json: async () => data,
        text: async () => JSON.stringify(data),
    });

    const mockFetch = async (url, options) => {
        // Handle Google Token Exchange
        if (typeof url === 'string' && url.includes('oauth2.googleapis.com/token')) {
            const idPayload = {
                iss: 'https://accounts.google.com',
                aud: 'mock-client.apps.googleusercontent.com',
                sub: 'google-sub-user-999',
                email: 'friend@example.com',
                email_verified: true,
                name: 'Test Friend',
                nonce: currentMockNonce,
                exp: Math.floor(Date.now() / 1000) + 3600,
            };
            const idToken = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(idPayload)).toString('base64url')}.mock-sig`;
            return rawJsonResponse({
                id_token: idToken,
                access_token: 'mock-access-token',
                expires_in: 3600,
                token_type: 'Bearer',
            });
        }

        // Handle Google Tokeninfo
        if (typeof url === 'string' && url.includes('oauth2.googleapis.com/tokeninfo')) {
            return rawJsonResponse({
                aud: 'mock-client.apps.googleusercontent.com',
                sub: 'google-sub-user-999',
            });
        }

        const body = JSON.parse(options.body);

        if (body.method === 'status') {
            return jsonResponse({ chain_id: 'testnet' });
        }

        if (body.method === 'block') {
            return jsonResponse({
                header: {
                    hash: '4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f',
                    height: 276800000,
                },
            });
        }

        if (body.params?.request_type === 'call_function') {
            const method = body.params.method_name;
            if (method === 'nft_token') {
                return jsonResponse({
                    result: Array.from(Buffer.from(JSON.stringify({
                        token_id: 'relay-test-1',
                        owner_id: currentTokenOwner,
                        metadata: { title: 'Test Token' },
                    }))),
                });
            }
            if (method === 'token_lifecycle') {
                return jsonResponse({
                    result: Array.from(Buffer.from(JSON.stringify('Unlocked'))),
                });
            }
            if (method === 'token_associated_subaccount' || method === 'relay_account_binding') {
                return jsonResponse({
                    result: Array.from(Buffer.from(JSON.stringify({
                        account_id: 'relay-test-1.relay.spellman.testnet',
                        is_verified: true,
                    }))),
                });
            }
            if (method === 'ft_balance_of') {
                return jsonResponse({
                    result: Array.from(Buffer.from(JSON.stringify('0'))),
                });
            }
        }

        if (body.params?.request_type === 'view_account') {
            const acc = body.params.account_id;
            if (acc === 'friend.testnet' || acc === 'relay-test-1.relay.spellman.testnet') {
                return jsonResponse({ amount: '2000000000000000000000000', storage_usage: 1000 });
            }
            return jsonResponse({ error: 'Account does not exist' });
        }

        if (body.method === 'tx') {
            return jsonResponse({
                status: { SuccessValue: '' },
                transaction: {
                    hash: body.params[0],
                    signer_id: 'relay-owner-b.spellman.testnet',
                    receiver_id: 'relay.spellman.testnet',
                    actions: [{
                        FunctionCall: {
                            method_name: 'nft_transfer',
                            args: Buffer.from(JSON.stringify({
                                token_id: 'relay-test-1',
                                receiver_id: 'friend.testnet',
                            })).toString('base64'),
                            deposit: '1',
                            gas: '30000000000000',
                        },
                    }],
                },
                receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }],
                final_execution_status: 'FINAL',
            });
        }

        if (body.method === 'eth_chainId') return jsonResponse('0x14a34');
        if (body.method === 'eth_getBalance' || body.method === 'eth_call') return jsonResponse('0x0');

        throw new Error(`Unexpected mock call: ${JSON.stringify(body)}`);
    };

    const server = createAppServer({ config, fetchImpl: mockFetch, journal: createClaimJournal() });
    await withServer(server, async (base) => {
        // 1. Check Google Login Start Endpoint
        const loginRes = await fetch(`${base}/api/auth/google/login?claimSessionId=session-test-1`, {
            redirect: 'manual',
        });
        assert.equal(loginRes.status, 302);
        const loginRedirect = loginRes.headers.get('location');
        assert.ok(loginRedirect.includes('accounts.google.com'));
        assert.ok(loginRedirect.includes('code_challenge='));
        const flowCookie = loginRes.headers.get('set-cookie');
        assert.ok(flowCookie);

        // Extract state and nonce from loginRedirect
        const redirectUrlObj = new URL(loginRedirect);
        const stateParam = redirectUrlObj.searchParams.get('state');
        currentMockNonce = redirectUrlObj.searchParams.get('nonce');

        // 2. Simulate Google Callback
        const callbackRes = await fetch(`${base}/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateParam)}`, {
            redirect: 'manual',
            headers: {
                cookie: flowCookie.split(';')[0],
            },
        });
        assert.equal(callbackRes.status, 302);
        const sessionCookie = callbackRes.headers.get('set-cookie');
        assert.ok(sessionCookie);

        // 3. Inspect Session Status Endpoint
        const sessionRes = await fetch(`${base}/api/auth/session`, {
            headers: { cookie: sessionCookie.split(';')[0] },
        });
        assert.equal(sessionRes.status, 200);
        const sessionData = await sessionRes.json();
        assert.equal(sessionData.authenticated, true);
        assert.equal(sessionData.user.sub, 'google-sub-user-999');
        assert.equal(sessionData.user.email, 'friend@example.com');

        // 4. Create an open claim session (no intended recipient pre-set)
        const createRes = await fetch(`${base}/api/claim/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tokenId: 'relay-test-1' }),
        });
        assert.equal(createRes.status, 200);
        const createdSession = await createRes.json();
        assert.ok(createdSession.sessionId);

        // 5. Recipient links their NEAR account
        const linkRes = await fetch(`${base}/api/claim/link-account`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                sessionId: createdSession.sessionId,
                sessionToken: createdSession.sessionToken,
                nearAccountId: 'friend.testnet',
            }),
        });
        assert.equal(linkRes.status, 200);
        const linkData = await linkRes.json();
        assert.equal(linkData.linked, true);
        assert.equal(linkData.nearAccountId, 'friend.testnet');

        // 6. Creator approves the linked recipient
        const approveRes = await fetch(`${base}/api/claim/approve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                sessionId: createdSession.sessionId,
                sessionToken: createdSession.sessionToken,
            }),
        });
        assert.equal(approveRes.status, 200);
        const approveData = await approveRes.json();
        assert.equal(approveData.approved, true);
        assert.equal(approveData.approvedRecipient, 'friend.testnet');

        // 7. Prepare transfer (now permitted because creator approved)
        const prepRes = await fetch(`${base}/api/claim/prepare-transfer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                tokenId: 'relay-test-1',
                recipientAccountId: 'friend.testnet',
                sessionToken: createdSession.sessionToken,
            }),
        });
        assert.equal(prepRes.status, 200);
        const prepData = await prepRes.json();
        assert.equal(prepData.prepared, true);
        assert.equal(prepData.transactionPlan.args.receiver_id, 'friend.testnet');

        // 8. Attempt finalize before ownership updates on-chain (should return AWAITING_FINALITY)
        const pendingFinalize = await fetch(`${base}/api/claim/finalize`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                sessionId: createdSession.sessionId,
                transactionHash: '5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U',
            }),
        });
        assert.equal(pendingFinalize.status, 202);
        const pendingData = await pendingFinalize.json();
        assert.equal(pendingData.finalized, false);
        assert.equal(pendingData.state, 'AWAITING_FINALITY');

        // 9. Ownership updates on-chain to friend.testnet -> finalize succeeds!
        currentTokenOwner = 'friend.testnet';
        const finalRes = await fetch(`${base}/api/claim/finalize`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                sessionId: createdSession.sessionId,
                transactionHash: '5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U',
            }),
        });
        assert.equal(finalRes.status, 200);
        const finalData = await finalRes.json();
        assert.equal(finalData.finalized, true);
        assert.equal(finalData.state, 'TRANSFER_FINALIZED');
        assert.equal(finalData.newOwner, 'friend.testnet');

        // 10. Logout
        const logoutRes = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
        assert.equal(logoutRes.status, 200);
        const logoutData = await logoutRes.json();
        assert.equal(logoutData.loggedOut, true);
    });
});

test('verifyFinalizedTransferTransaction enforces 30 TGas policy and validation rules', async () => {
    const validHash = '5QhcvrP44GkavdwX8wfwTAxdVGCtdGRUJ7A9Ec8SC1U';
    const signer = 'creator.testnet';
    const contract = 'relay.spellman.testnet';
    const tokenId = 'relay-test-1';
    const receiver = 'recipient.testnet';

    function buildTxMock(gasValue) {
        return async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                jsonrpc: '2.0',
                id: 'tx_status',
                result: {
                    status: { SuccessValue: '' },
                    final_execution_status: 'FINAL',
                    transaction: {
                        hash: validHash,
                        signer_id: signer,
                        receiver_id: contract,
                        actions: [{
                            FunctionCall: {
                                method_name: 'nft_transfer',
                                args: Buffer.from(JSON.stringify({
                                    token_id: tokenId,
                                    receiver_id: receiver,
                                })).toString('base64'),
                                deposit: '1',
                                ...(gasValue !== undefined ? { gas: gasValue } : {}),
                            },
                        }],
                    },
                    receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }],
                },
            }),
        });
    }

    // 1. Missing gas property throws GAS_MISMATCH
    await assert.rejects(
        async () => {
            await verifyFinalizedTransferTransaction({
                nearRpcUrl: 'https://rpc.testnet.near.org',
                relayContractId: contract,
                transactionHash: validHash,
                expectedSigner: signer,
                expectedTokenId: tokenId,
                expectedReceiver: receiver,
                fetchImpl: buildTxMock(undefined),
            });
        },
        (err) => {
            assert.equal(err.code, 'GAS_MISMATCH');
            assert.match(err.message, /30 TGas/);
            return true;
        }
    );

    // 2. Incorrect gas value throws GAS_MISMATCH
    await assert.rejects(
        async () => {
            await verifyFinalizedTransferTransaction({
                nearRpcUrl: 'https://rpc.testnet.near.org',
                relayContractId: contract,
                transactionHash: validHash,
                expectedSigner: signer,
                expectedTokenId: tokenId,
                expectedReceiver: receiver,
                fetchImpl: buildTxMock('100000000000000'), // 100 TGas instead of 30 TGas
            });
        },
        (err) => {
            assert.equal(err.code, 'GAS_MISMATCH');
            assert.match(err.message, /30 TGas/);
            return true;
        }
    );

    // 3. Exactly 30 TGas ('30000000000000') succeeds
    const result = await verifyFinalizedTransferTransaction({
        nearRpcUrl: 'https://rpc.testnet.near.org',
        relayContractId: contract,
        transactionHash: validHash,
        expectedSigner: signer,
        expectedTokenId: tokenId,
        expectedReceiver: receiver,
        fetchImpl: buildTxMock('30000000000000'),
    });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.finalized, true);
    assert.equal(result.transaction.hash, validHash);
});

