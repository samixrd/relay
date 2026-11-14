/**
 * Minimal browser shim for Node's `process`, injected by esbuild into any
 * bundled module that references it (for example the `util` polyfill).
 *
 * It intentionally exposes only read-only, harmless fields. No secrets and no
 * filesystem or environment access from the page.
 */
const processShim = globalThis.process || {
    browser: true,
    env: {},
    argv: [],
    execArgv: [],
    pid: 1,
    version: '',
    versions: {},
    platform: 'browser',
    nextTick(fn, ...args) {
        setTimeout(() => fn(...args), 0);
    },
};

globalThis.process = processShim;

export const process = processShim;
