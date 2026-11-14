'use strict';

/*
 * Some bundled browser dependencies read `process.env` at runtime.
 * Browsers do not define `process`, so the Wallet Selector bundle throws
 * before it can expose its bridge. This shim provides only an inert,
 * read-only environment object. It adds no Node.js behaviour.
 */
(function provideProcessShim(root) {
  if (!root || typeof root.process !== 'undefined') return;
  root.process = Object.freeze({ env: Object.freeze({ NODE_ENV: 'production' }) });
})(typeof window !== 'undefined' ? window : null);
