/**
 * Minimal browser shim for Node's `Buffer`, injected by esbuild into the
 * wallet-selector and NEAR Auth bundles.
 *
 * Several dependencies (near-api-js, borsh serialization, the wallet modules)
 * reference the `Buffer` global directly. esbuild bundles the `buffer` package
 * but does not make its export global, so without this shim the page throws
 * `Buffer is not defined` the moment a wallet action runs.
 *
 * Only the standard `buffer` polyfill is exposed; it has no filesystem or
 * environment access.
 */
import { Buffer } from 'buffer';

if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = Buffer;
}

export { Buffer };
