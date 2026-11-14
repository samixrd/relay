'use strict';

const path = require('node:path');

const DEFAULTS = Object.freeze({
    NEAR_NETWORK: 'testnet',
    NEAR_RPC_URL: 'https://rpc.testnet.near.org',
    NEAR_EXPLORER_BASE_URL: 'https://testnet.nearblocks.io',
    NEAR_SIGNER_CONTRACT_ID: 'v1.signer-prod.testnet',
    APP_PORT: '4173',
    PUBLIC_APP_URL: '',
});

function parseEnvText(text) {
    if (Buffer.isBuffer(text)) text = text.toString('utf8');
    if (typeof text !== 'string') throw new TypeError('.env contents must be text');
    const values = {};
    for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
        if (!match) throw new TypeError(`Invalid .env syntax on line ${index + 1}`);
        let value = match[2].trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        } else {
            value = value.replace(/\s+#.*$/, '').trim();
        }
        values[match[1]] = value;
    }
    return values;
}

function loadEnvFile(filePath, target = process.env, readFile = require('node:fs').readFileSync) {
    let text;
    try {
        text = readFile(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
    for (const [key, value] of Object.entries(parseEnvText(text))) {
        if (target[key] === undefined) target[key] = value;
    }
    return true;
}

function parseUrl(value, name, errors, protocols = ['https:']) {
    try {
        const url = new URL(value);
        if (!protocols.includes(url.protocol) || url.username || url.password) {
            errors.push(`${name} must be a ${protocols.join(' or ')} URL without embedded credentials.`);
            return null;
        }
        return url;
    } catch {
        errors.push(`${name} must be a valid URL.`);
        return null;
    }
}

function createConfig(source = process.env) {
    const env = { ...DEFAULTS, ...source };
    const errors = [];
    if (!['testnet', 'mainnet'].includes(env.NEAR_NETWORK)) {
        errors.push('NEAR_NETWORK must be testnet or mainnet.');
    }
    const nearRpcUrl = parseUrl(env.NEAR_RPC_URL, 'NEAR_RPC_URL', errors, ['https:', 'http:']);
    if (
        nearRpcUrl?.protocol === 'http:' &&
        !['localhost', '127.0.0.1'].includes(nearRpcUrl.hostname.toLowerCase())
    ) {
        errors.push('NEAR_RPC_URL may use HTTP only for a local loopback endpoint.');
    }
    if (
        nearRpcUrl &&
        ((env.NEAR_NETWORK === 'testnet' && /(^|\.)rpc\.mainnet\.near\.org$/i.test(nearRpcUrl.hostname)) ||
            (env.NEAR_NETWORK === 'mainnet' && /(^|\.)rpc\.testnet\.near\.org$/i.test(nearRpcUrl.hostname)))
    ) {
        errors.push('NEAR_RPC_URL does not match NEAR_NETWORK.');
    }
    const defaultNearExplorer = env.NEAR_NETWORK === 'mainnet'
        ? 'https://nearblocks.io'
        : 'https://testnet.nearblocks.io';
    const nearExplorer = parseUrl(
        source.NEAR_EXPLORER_BASE_URL || defaultNearExplorer,
        'NEAR_EXPLORER_BASE_URL',
        errors,
    );
    if (
        nearExplorer &&
        ((env.NEAR_NETWORK === 'testnet' && nearExplorer.hostname === 'nearblocks.io') ||
            (env.NEAR_NETWORK === 'mainnet' && nearExplorer.hostname === 'testnet.nearblocks.io'))
    ) {
        errors.push('NEAR_EXPLORER_BASE_URL does not match NEAR_NETWORK.');
    }
    if (
        env.NEAR_SIGNER_CONTRACT_ID !==
        (env.NEAR_NETWORK === 'testnet' ? 'v1.signer-prod.testnet' : 'v1.signer')
    ) {
        errors.push('NEAR_SIGNER_CONTRACT_ID does not match the selected NEAR network.');
    }
    const relayContractId = env.RELAY_CONTRACT_ID || '';
    if (relayContractId && !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(relayContractId)) {
        errors.push('RELAY_CONTRACT_ID must be a valid NEAR account ID.');
    }
    const relayControllerWasmPath = env.RELAY_CONTROLLER_WASM_PATH
        ? path.resolve(process.cwd(), env.RELAY_CONTROLLER_WASM_PATH)
        : '';
    if (env.NEAR_NETWORK !== 'testnet') {
        errors.push('RELAY is a NEAR Testnet product; NEAR_NETWORK must be testnet.');
    }
    const port = Number(env.PORT || env.APP_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('APP_PORT must be between 1 and 65535.');

    const rawPublic = env.PUBLIC_APP_URL || env.RENDER_EXTERNAL_URL;
    const publicAppUrl = rawPublic ? rawPublic.trim() : null;
    if (publicAppUrl) {
        try {
            const parsedPublic = new URL(publicAppUrl);
            if (!['https:', 'http:'].includes(parsedPublic.protocol) || parsedPublic.username || parsedPublic.password) {
                errors.push('PUBLIC_APP_URL must be an http: or https: URL without credentials.');
            }
        } catch {
            errors.push('PUBLIC_APP_URL must be a valid URL.');
        }
    }

    return Object.freeze({
        valid: errors.length === 0,
        errors: Object.freeze(errors),
        app: Object.freeze({
            port,
            publicAppUrl: publicAppUrl || null,
        }),
        near: Object.freeze({
            network: env.NEAR_NETWORK,
            rpcUrl: nearRpcUrl?.toString() || env.NEAR_RPC_URL,
            explorerBaseUrl: nearExplorer?.toString().replace(/\/$/, '') || '',
            signerContractId: env.NEAR_SIGNER_CONTRACT_ID,
            relayContractId,
            controllerWasmPath: relayControllerWasmPath,
            deployerAccountConfigured: Boolean(env.NEAR_ACCOUNT_ID),
        }),
        rawEnv: Object.freeze({ ...env }),
    });
}

function publicConfig(config) {
    return {
        app: config.app,
        near: {
            network: config.near.network,
            explorerBaseUrl: config.near.explorerBaseUrl,
            signerContractId: config.near.signerContractId,
            relayContractId: config.near.relayContractId,
        },
    };
}

module.exports = { createConfig, loadEnvFile, parseEnvText, publicConfig };
