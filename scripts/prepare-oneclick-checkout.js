#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const stableStringify = require('json-stable-stringify');
const { loadEnvFile } = require('./app-config');
const {
    DESTINATION_ASSET,
    ORIGIN_ASSET,
    requestRelayQuote,
} = require('./oneclick-quote-adapter');
const {
    buildPreparationEvidence,
    fetchTokenMetadata,
} = require('./oneclick-checkout-preparation');

function parseArguments(argv) {
    const values = new Map();
    let nonDry = false;
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--non-dry') {
            if (nonDry) throw new Error('--non-dry may be specified only once');
            nonDry = true;
            continue;
        }
        const value = argv[index + 1];
        if (!flag.startsWith('--') || value === undefined || value.startsWith('--') || values.has(flag)) {
            throw new Error('Provide each option exactly once with a value; --non-dry is a switch');
        }
        values.set(flag, value);
        index += 1;
    }
    const required = [
        '--token-id',
        '--relay-contract',
        '--recipient',
        '--amount',
        '--origin-asset',
        '--destination-asset',
        '--rpc-url',
    ];
    const supported = new Set([...required, '--output']);
    const missing = required.filter((flag) => !values.has(flag));
    const unexpected = [...values.keys()].filter((flag) => !supported.has(flag));
    if (missing.length || unexpected.length) {
        throw new Error(
            `Missing options: ${missing.join(', ') || 'none'}; unexpected options: ${unexpected.join(', ') || 'none'}`,
        );
    }
    const args = Object.fromEntries(
        [...values].map(([flag, value]) => [flag.slice(2).replaceAll('-', ''), value]),
    );
    if (args.originasset !== ORIGIN_ASSET || args.destinationasset !== DESTINATION_ASSET) {
        throw new Error('Requested assets are outside the current RELAY quote allowlist');
    }
    return { ...args, nonDry };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
    loadEnvFile(path.resolve(__dirname, '..', '.env'));
    const args = parseArguments(argv);
    const tokenMetadata = await (dependencies.fetchTokenMetadata || fetchTokenMetadata)({
        fetchImpl: dependencies.tokenFetchImpl || globalThis.fetch,
    });
    const deadline = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    const request = {
        dry: !args.nonDry,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: args.originasset,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: args.destinationasset,
        amount: args.amount,
        refundTo: `${args.tokenid}.${args.relaycontract}`,
        refundType: 'ORIGIN_CHAIN',
        recipient: args.recipient,
        recipientType: 'DESTINATION_CHAIN',
        deadline,
    };
    const result = await (dependencies.requestRelayQuote || requestRelayQuote)({
        request,
        tokenId: args.tokenid,
        relayContractId: args.relaycontract,
        rpcUrl: args.rpcurl,
        apiKey: process.env.ONECLICK_JWT || undefined,
        providerFetchImpl: dependencies.providerFetchImpl || globalThis.fetch,
        rpcFetchImpl: dependencies.rpcFetchImpl || globalThis.fetch,
    });
    const evidence = buildPreparationEvidence({ result, tokenMetadata, request });
    const output = `${stableStringify(evidence, { space: 2 })}\n`;
    if (args.output) {
        const outputPath = path.resolve(args.output);
        await fs.writeFile(outputPath, output, { encoding: 'utf8', flag: 'wx' });
        process.stdout.write(`Evidence written without overwriting: ${outputPath}\n`);
    } else {
        process.stdout.write(output);
    }
    process.stdout.write(
        'No deposit, transaction, authorization call, or payment dispatch was performed.\n',
    );
    return evidence;
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(
            `${JSON.stringify({
                error: error.message,
                code: error.code || 'CHECKOUT_PREPARATION_FAILED',
                conditions: error.conditions,
            })}\n`,
        );
        process.exitCode = 1;
    });
}

module.exports = { main, parseArguments };
