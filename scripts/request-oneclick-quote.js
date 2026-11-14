#!/usr/bin/env node
'use strict';

const {
    DESTINATION_ASSET,
    ORIGIN_ASSET,
    requestRelayQuote,
} = require('./oneclick-quote-adapter');
const path = require('node:path');
const { loadEnvFile } = require('./app-config');

function parseArguments(args) {
    const values = new Map();
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!flag || !flag.startsWith('--') || value === undefined || values.has(flag)) {
            throw new Error('Provide each required flag exactly once with a value');
        }
        values.set(flag, value);
    }
    const required = ['--token-id', '--relay-contract', '--recipient', '--amount'];
    const supported = [...required, '--rpc-url'];
    const unexpected = [...values.keys()].filter((flag) => !supported.includes(flag));
    const missing = required.filter((flag) => !values.has(flag));
    if (unexpected.length || missing.length) {
        throw new Error(`Missing flags: ${missing.join(', ') || 'none'}; unexpected flags: ${unexpected.join(', ') || 'none'}`);
    }
    return Object.fromEntries([...values].map(([flag, value]) => [flag.slice(2).replaceAll('-', ''), value]));
}

function defaultRpcUrl(args, env = process.env) {
    return args.rpcurl || env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
}

async function main() {
    loadEnvFile(path.resolve(__dirname, '..', '.env'));
    const args = parseArguments(process.argv.slice(2));
    const associatedAccountId = `${args.tokenid}.${args.relaycontract}`;
    const deadline = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    const result = await requestRelayQuote({
        tokenId: args.tokenid,
        relayContractId: args.relaycontract,
        rpcUrl: defaultRpcUrl(args),
        apiKey: process.env.ONECLICK_JWT || undefined,
        request: {
            dry: false,
            swapType: 'EXACT_INPUT',
            slippageTolerance: 100,
            originAsset: ORIGIN_ASSET,
            depositType: 'ORIGIN_CHAIN',
            destinationAsset: DESTINATION_ASSET,
            amount: args.amount,
            refundTo: associatedAccountId,
            refundType: 'ORIGIN_CHAIN',
            recipient: args.recipient,
            recipientType: 'DESTINATION_CHAIN',
            deadline,
        },
    });
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(JSON.stringify({
            error: error.message,
            code: error.code || 'INVALID_ARGUMENTS',
            conditions: error.conditions,
            details: error.details,
        }, null, 2));
        process.exitCode = 1;
    });
}

module.exports = { defaultRpcUrl, main, parseArguments };
