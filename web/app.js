'use strict';

/* RELAY product UI — one Google login, a sponsored NEAR account, real Testnet cards. */

(() => {
  const app = document.getElementById('app');
  const toastRegion = document.getElementById('toast-region');
  const dialogRoot = document.getElementById('dialog-root');

  const STORAGE = { theme: 'relay.theme' };
  const TOKEN_RE = /^[a-z0-9_-]{1,32}$/;

  const ICONS = {
    home: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7"/>',
    cards: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M7 14h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    fund: '<path d="M12 3v13m0 0 4-4m-4 4-4-4"/><path d="M4 19h16"/>',
    send: '<path d="M21 3 10.5 13.5M21 3l-6.8 18-3.7-7.5L3 9.8 21 3Z"/>',
    spend: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v10M9.2 9.2h4.2a1.8 1.8 0 0 1 0 3.6H9.8a1.8 1.8 0 0 0 0 3.6h4.6"/>',
    activity: '<path d="M4 19V5m0 14h16M7 15l4-4 3 2 5-6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    google: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5a3.5 3.5 0 1 0 0 7c2 0 3.2-1.2 3.2-3.2H12"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
    moon: '<path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z"/>',
    monitor: '<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8m-4-4v4"/>',
    arrow: '<path d="M4 12h15m0 0-5-5m5 5-5 5"/>',
    external: '<path d="M14 4h6v6M20 4 10 14M9 5H4v15h15v-5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V4H4v12h4"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V6l8-3Z"/><path d="m9 12 2 2 4-4"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1.6-1.6"/>',
    lock: '<rect x="4" y="10" width="16" height="10" rx="1.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8m-2 2 3 3m-6 0 3 3"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5L5 20"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4l3 2"/>',
    alert: '<path d="M12 4 2.6 20h18.8L12 4Z"/><path d="M12 10v4m0 3v.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5m0-8v.01"/>',
    refresh: '<path d="M20 11A8 8 0 0 0 6 6L4 8m0 0V4m0 4h4"/><path d="M4 13a8 8 0 0 0 14 5l2-2m0 0v4m0-4h-4"/>',
    logout: '<path d="M10 4H5v16h5"/><path d="M14 8l4 4-4 4m4-4H9"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/>',
  };

  const state = {
    config: null,
    authConfig: null,
    session: null,
    authLoaded: false,
    authError: null,
    cards: [],
    cardsLoaded: false,
    cardsError: null,
    owned: null,
    overviewKey: null,
    claims: null,
    claimDetail: null,
    claimCard: null,
    links: [],
    linksLoaded: false,
    cardCache: {},
    assets: {},
    activity: null,
    receipt: null,
    theme: readStorage(STORAGE.theme) || 'system',
    page: { path: '/', query: new URLSearchParams(), params: {} },
    renderKey: null,
    create: { imageUrl: null, uploadError: null, uploading: false, progress: 0, fileName: null, objectUrl: null, file: null, bytes: 0 },
    wallet: { loaded: false, connecting: false, session: null, accountId: null, providerId: null, publicKey: null, error: null },
    authMode: null,
    spend: { tokenId: null, assets: null, error: null },
    stocks: null,
    stocksCardId: null,
    detailKey: null,
    spendKey: null,
    claimKey: null,
  };

  /* ------------------------------------------------------------ utilities -- */

  function readStorage(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }
  function writeStorage(key, value) {
    try {
      if (!value) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch { /* storage may be unavailable */ }
  }
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function raw(value) { return String(value === null || value === undefined ? '' : value); }
  function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }
  function iconCircle(name) {
    return `<span class="feature__icon">${icon(name)}</span>`;
  }
  function shortId(value, head = 10, tail = 8) {
    const text = String(value || '');
    if (text.length <= head + tail + 1) return text;
    return `${text.slice(0, head)}…${text.slice(-tail)}`;
  }
  function fmtDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function timeAgo(value) {
    const ts = typeof value === 'number' ? value : Date.parse(value);
    if (!ts || Number.isNaN(ts)) return '—';
    const delta = Date.now() - ts;
    if (delta < 0) return fmtDate(ts);
    const mins = Math.floor(delta / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return fmtDate(ts);
  }
  function fmtNear(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value ?? '—');
    return number.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  function initials(value) {
    const words = String(value || 'RELAY').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'R';
    return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('');
  }
  function tag(label, tone = 'neutral') {
    return `<span class="tag ${esc(tone)}">${esc(label)}</span>`;
  }
  function notice(tone, title, body) {
    return `<div class="notice ${esc(tone)}"><div class="notice-body">${title ? `<strong>${esc(title)}</strong>` : ''}<div>${raw(body)}</div></div></div>`;
  }
  function mono(value) {
    return `<code class="break">${esc(value)}</code>`;
  }
  /**
   * Card art is stored on chain, so an old card can carry an absolute upload
   * URL for a different local port. Keep same-origin uploads relative so the
   * page CSP and the current dev port both work.
   */
  function mediaSrc(value) {
    if (!value || typeof value !== 'string') return null;
    try {
      const url = new URL(value, location.origin);
      if (url.pathname.startsWith('/uploads/')) {
        return `${url.pathname}${url.search}`;
      }
      return url.href;
    } catch {
      return value;
    }
  }
  /** Same masking rule the claim store uses, so the UI can warn before verify. */
  function maskEmailClient(email) {
    if (typeof email !== 'string' || !email.includes('@')) return null;
    const [local, domain] = email.split('@');
    return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(10, local.length - 1)))}@${domain}`;
  }
  function explorerTx(hash) {
    const base = state.config?.near?.explorerBaseUrl || 'https://testnet.nearblocks.io';
    return `${base}/txns/${encodeURIComponent(hash)}`;
  }
  function explorerAccount(accountId) {
    const base = state.config?.near?.explorerBaseUrl || 'https://testnet.nearblocks.io';
    return `${base}/account/${encodeURIComponent(accountId)}`;
  }
  function sessionAccount() {
    return googleAccount() || walletAccount();
  }
  function googleAccount() {
    return state.session?.authenticated ? (state.session.near?.accountId || null) : null;
  }
  function walletAccount() {
    return state.wallet?.session?.authenticated
      ? (state.wallet.session.account?.accountId || state.wallet.accountId || null)
      : null;
  }
  function linkedAccountIds() {
    return (state.links || []).map((entry) => entry.accountId).filter(Boolean);
  }
  function ownsAccount(accountId) {
    if (!accountId) return false;
    if (accountId === googleAccount()) return true;
    if (accountId === walletAccount()) return true;
    return linkedAccountIds().includes(accountId);
  }
  function isWalletAuthed() {
    return Boolean(state.wallet?.session?.authenticated && walletAccount());
  }
  function isAuthed() {
    return Boolean((state.session?.authenticated && googleAccount()) || isWalletAuthed());
  }
  function currentAuthMode() {
    if (state.session?.authenticated && googleAccount()) return 'google';
    if (isWalletAuthed()) return 'wallet';
    return null;
  }
  function walletBridge() {
    if (!window.RelayWalletSelectorBridge) {
      throw new Error('The wallet bundle did not load. Run npm run build:wallet and reload.');
    }
    return window.RelayWalletSelectorBridge;
  }
  function walletConfig() {
    return {
      networkId: 'testnet',
      contractId: state.authConfig?.contractId || state.config?.near?.relayContractId || 'relay.spellman.testnet',
    };
  }

  async function api(path, options = {}) {
    const opts = { credentials: 'same-origin', ...options };
    if (opts.body !== undefined && typeof opts.body !== 'string') {
      opts.headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }
    let response;
    try {
      response = await fetch(path, opts);
    } catch (error) {
      const wrapped = new Error('Could not reach the RELAY server. Is it running?');
      wrapped.cause = error;
      throw wrapped;
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(data?.error || `Request failed (${response.status}).`);
      error.status = response.status;
      error.code = data?.code || null;
      error.data = data;
      throw error;
    }
    return data;
  }

  function toast(title, message = '', tone = 'info', timeout = 6500) {
    const node = document.createElement('div');
    node.className = `toast ${tone}`;
    node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    node.innerHTML = `<div></div><div><strong>${esc(title)}</strong>${message ? `<p>${esc(message)}</p>` : ''}</div><button type="button" aria-label="Dismiss">×</button>`;
    node.querySelector('button').addEventListener('click', () => node.remove());
    toastRegion.appendChild(node);
    if (timeout > 0) window.setTimeout(() => node.remove(), timeout);
    return node;
  }

  function dialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', dangerous = false }) {
    return new Promise((resolve) => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = `
        <dialog class="relay-dialog">
          <div class="dialog-head">
            <h2>${esc(title)}</h2>
            <button type="button" class="dialog-close" data-dialog-cancel aria-label="Close">×</button>
          </div>
          <div class="dialog-body">${raw(body)}</div>
          <div class="dialog-foot">
            <button type="button" class="btn btn-outline" data-dialog-cancel>${esc(cancelLabel)}</button>
            <button type="button" class="btn ${dangerous ? 'btn-danger' : 'btn-primary'}" data-dialog-confirm>${esc(confirmLabel)}</button>
          </div>
        </dialog>`;
      const node = wrapper.firstElementChild;
      dialogRoot.appendChild(node);
      const close = (value) => {
        try { node.close(); } catch { /* ignore */ }
        node.remove();
        resolve(value);
      };
      node.querySelectorAll('[data-dialog-cancel]').forEach((btn) => btn.addEventListener('click', () => close(false)));
      node.querySelector('[data-dialog-confirm]').addEventListener('click', () => close(true));
      node.addEventListener('cancel', (event) => { event.preventDefault(); close(false); });
      node.addEventListener('click', (event) => { if (event.target === node) close(false); });
      if (typeof node.showModal === 'function') node.showModal();
      else node.setAttribute('open', '');
    });
  }

  async function copyText(value, label = 'Copied') {
    const text = String(value || '');
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        document.execCommand('copy');
        field.remove();
      }
      toast(label, '', 'success', 2600);
    } catch {
      toast('Copy failed', 'Select the text and copy it manually.', 'error');
    }
  }

  function busy(button, on) {
    if (!button) return;
    if (on) {
      button.dataset.label = button.textContent;
      button.disabled = true;
      button.textContent = 'Working…';
    } else {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  /* ---------------------------------------------------------------- theme -- */

  function applyTheme() {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const dark = state.theme === 'dark' || (state.theme === 'system' && prefersDark);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#141916' : '#f5f4ed');
  }
  function setTheme(theme) {
    state.theme = theme;
    writeStorage(STORAGE.theme, theme);
    applyTheme();
    render();
  }
  function themeButton() {
    const next = state.theme === 'system' ? 'light' : state.theme === 'light' ? 'dark' : 'system';
    const glyph = state.theme === 'dark' ? icon('moon') : state.theme === 'light' ? icon('sun') : icon('monitor');
    return `<button type="button" class="theme-toggle" data-act="theme" data-theme="${next}" title="Theme: ${esc(state.theme)}" aria-label="Change theme">${glyph}</button>`;
  }

  /* ----------------------------------------------------------------- auth -- */

  function setSession(payload) {
    if (!payload?.authenticated) {
      state.session = { authenticated: false, user: null, near: null };
      state.owned = null;
      state.claims = null;
      state.links = [];
      state.linksLoaded = false;
      state.overviewKey = null;
      state.authMode = currentAuthMode();
      return;
    }
    state.session = {
      authenticated: true,
      user: payload.user || null,
      near: payload.near || null,
      expiresAt: payload.expiresAt || null,
    };
    state.authMode = currentAuthMode();
  }
  async function loadLinks() {
    if (!state.session?.authenticated) {
      state.links = [];
      state.linksLoaded = true;
      return state.links;
    }
    try {
      const result = await api('/api/auth/near/links');
      state.links = Array.isArray(result?.accounts) ? result.accounts : [];
    } catch {
      state.links = [];
    }
    state.linksLoaded = true;
    return state.links;
  }
  async function loadSession() {
    try {
      const [session, authConfig] = await Promise.all([
        api('/api/auth/near/session'),
        api('/api/auth/near/config'),
      ]);
      setSession(session);
      state.authConfig = authConfig;
      state.authError = null;
      await loadLinks();
    } catch (error) {
      state.authError = error.message;
      state.authConfig = null;
      state.links = [];
      state.linksLoaded = true;
    }
    state.authLoaded = true;
  }

  function ensureNearAuth() {
    if (!window.RelayNearAuth) {
      throw new Error('The Google sign-in bundle did not load. Run npm run build:near-auth and reload.');
    }
    return window.RelayNearAuth;
  }

  async function initializeNearAuth() {
    if (!state.authConfig) return;
    const bridge = ensureNearAuth();
    try {
      await bridge.initialize({
        network: state.authConfig.network || 'testnet',
        clientId: state.authConfig.clientId,
        domain: state.authConfig.domain,
        signingAudience: state.authConfig.signingAudience,
        rpcUrl: state.authConfig.rpcUrl,
        mpcContractId: state.authConfig.mpcContractId,
        fastAuthContractId: state.authConfig.fastAuthContractId,
      });
    } catch (error) {
      state.authError = error.message;
    }
  }

  async function verifyIdentity(identity) {
    const result = await api('/api/auth/near/verify', {
      method: 'POST',
      body: { idToken: identity.idToken, publicKey: identity.publicKey },
    });
    setSession(result);
    await loadLinks();
    return result;
  }

  function currentReturnTo() {
    const target = `${location.pathname}${location.hash}`;
    if (!target.startsWith('/') || target.startsWith('//')) return '/#/overview';
    if (target.startsWith('/#/signin')) return '/#/overview';
    return target;
  }

  async function startSignIn(button = null) {
    if (!state.authConfig?.configured) {
      toast('Google sign-in is unavailable', state.authConfig?.reason || 'The server is not configured for NEAR Auth.', 'error', 9000);
      return;
    }
    busy(button, true);
    try {
      const bridge = ensureNearAuth();
      const identity = await bridge.login();
      const result = await verifyIdentity(identity);
      state.authError = null;
      toast('Signed in', result.near?.newAccount ? `Created sponsored account ${result.near.accountId}` : `Account ${result.near?.accountId || ''}`, 'success', 6000);
      state.overviewKey = null;
      const returnTo = state.page.query.get('returnTo');
      if (returnTo && returnTo.startsWith('/#/')) location.hash = returnTo.slice(1);
      else if (state.page.path === '/signin') location.hash = '#/overview';
      else render();
    } catch (error) {
      const message = /popup|closed|cancel/i.test(error.message)
        ? 'The Google window was closed before RELAY received a verified identity.'
        : error.message;
      toast('Sign-in did not complete', error.code ? `${message} (${error.code})` : message, 'error', 14000);
    } finally {
      busy(button, false);
    }
  }

  async function ensureLiveIdentity() {
    if (!isAuthed()) throw new Error('Sign in with Google to continue.');
    const bridge = ensureNearAuth();
    let loggedIn = false;
    try { loggedIn = await bridge.isLoggedIn(); } catch { loggedIn = false; }
    if (loggedIn) return;
    const identity = await bridge.ensureSession();
    const result = await verifyIdentity(identity);
    if (!result?.near?.accountId) throw new Error('RELAY could not verify the Google identity.');
    toast('Google reconnected', 'Signing the exact transaction RELAY prepared.', 'info', 5000);
  }

  async function signOut(button = null) {
    const confirmed = await dialog({
      title: 'Sign out?',
      body: '<p>This clears the RELAY session and the Google connection. Your sponsored NEAR account and every card stay on chain and can be recovered by signing in again.</p>',
      confirmLabel: 'Sign out',
      dangerous: true,
    });
    if (!confirmed) return;
    busy(button, true);
    try {
      await api('/api/auth/near/logout', { method: 'POST' });
      try { await ensureNearAuth().logout(); } catch { /* server session already cleared */ }
      setSession(null);
      state.cards = [];
      state.cardsLoaded = false;
      state.cardCache = {};
      toast('Signed out', 'The Google session was cleared.', 'info');
      location.hash = '#/';
      render();
    } catch (error) {
      toast('Sign out failed', error.message, 'error');
    } finally {
      busy(button, false);
    }
  }

  /* --------------------------------------------------------------- wallet -- */

  async function loadWalletSession() {
    try {
      const result = await api('/api/auth/wallet/session');
      if (result?.authenticated && result.account?.accountId) {
        state.wallet.session = result;
        state.wallet.accountId = result.account.accountId;
        state.wallet.publicKey = result.account.publicKey || null;
        state.wallet.providerId = result.account.providerId || null;
      } else {
        state.wallet.session = null;
      }
    } catch {
      state.wallet.session = null;
    }
    state.wallet.loaded = true;
    if (!state.authMode) state.authMode = currentAuthMode();
  }

  async function initializeWallet() {
    try {
      const bridge = walletBridge();
      await bridge.initialize(walletConfig());
      const restored = await bridge.restore(walletConfig());
      if (restored?.connected && restored.accountId && !isWalletAuthed()) {
        // The selector remembers the account, but RELAY still requires a valid
        // NEP-413 session before treating the wallet as authenticated.
        state.wallet.error = 'Wallet extension remembered. Confirm the sign-in message to restore the RELAY session.';
      }
    } catch (error) {
      state.wallet.error = error.message;
    }
  }

  async function finishWalletAuth(challengeId, accountId, providerId, signed) {
    const result = await api('/api/auth/wallet/verify', {
      method: 'POST',
      body: {
        challengeId,
        accountId,
        providerId: providerId || null,
        publicKey: signed.publicKey,
        signature: signed.signature,
      },
    });
    state.wallet.session = result;
    state.wallet.accountId = result.account.accountId;
    state.wallet.publicKey = result.account.publicKey || null;
    state.wallet.providerId = result.account.providerId || null;
    state.wallet.error = null;
    state.authMode = currentAuthMode();
    state.owned = null;
    state.overviewKey = null;
    state.cardsLoaded = false;
    sessionStorage.removeItem('relay_wallet_pending_auth');
    if (state.session?.authenticated) await loadLinks();
    toast(
      result.linked ? 'Wallet linked to Google' : 'Wallet connected',
      result.linked
        ? `${result.account.accountId} now counts as your Google account for ownership.`
        : result.account.accountId,
      'success',
      6000,
    );
    render();
    return result;
  }

  async function connectWallet(button = null) {
    busy(button, true);
    state.wallet.connecting = true;
    state.wallet.error = null;
    render();
    try {
      const bridge = walletBridge();
      await bridge.initialize(walletConfig());
      const connection = await bridge.connect(walletConfig());
      if (connection?.redirected) {
        toast('Approve in your wallet', 'The wallet is redirecting. Return to RELAY after approving.', 'info', 9000);
        return;
      }
      if (!connection?.connected || !connection.accountId) {
        throw new Error('The wallet did not return a NEAR account. Connection was not established.');
      }
      const challenge = await api('/api/auth/wallet/challenge', {
        method: 'POST',
        body: { accountId: connection.accountId },
      });
      const signed = await bridge.signMessage(walletConfig(), {
        message: challenge.message,
        recipient: challenge.recipient,
        nonce: challenge.nonce,
      });
      if (signed?.redirected) {
        sessionStorage.setItem('relay_wallet_pending_auth', JSON.stringify({
          challengeId: challenge.challengeId,
          accountId: connection.accountId,
          providerId: connection.walletId || null,
        }));
        toast('Approve the sign-in message', 'Your wallet is redirecting. RELAY will finish the session when you return.', 'info', 9000);
        return;
      }
      await finishWalletAuth(challenge.challengeId, connection.accountId, connection.walletId, signed);
    } catch (error) {
      const message = /closed|reject|cancel|denied|declined/i.test(error.message)
        ? 'The wallet connection was cancelled before RELAY received an account.'
        : error.message;
      state.wallet.error = message;
      toast('Wallet not connected', message, 'error', 9000);
      render();
    } finally {
      state.wallet.connecting = false;
      busy(button, false);
    }
  }

  async function linkWallet(button = null) {
    if (!state.session?.authenticated) {
      toast('Google sign-in required', 'Sign in with Google first, then link the wallet that owns your card.', 'warning');
      return;
    }
    const accountId = walletAccount();
    if (!accountId || !isWalletAuthed()) {
      toast('Connect a wallet first', 'Connect the NEAR wallet you want to bind to this Google identity.', 'warning');
      return;
    }
    busy(button, true);
    try {
      const bridge = walletBridge();
      await bridge.initialize(walletConfig());
      const challenge = await api('/api/auth/near/links/challenge', {
        method: 'POST',
        body: { accountId },
      });
      const signed = await bridge.signMessage(walletConfig(), {
        message: challenge.message,
        recipient: challenge.recipient,
        nonce: challenge.nonce,
      });
      if (signed?.redirected) {
        toast('Approve the link message', 'Your wallet is redirecting. Return to RELAY and link again.', 'info', 9000);
        return;
      }
      const result = await api('/api/auth/near/links/verify', {
        method: 'POST',
        body: {
          challengeId: challenge.challengeId,
          accountId,
          publicKey: signed.publicKey,
          signature: signed.signature,
          providerId: state.wallet.providerId,
        },
      });
      state.links = Array.isArray(result.accounts) ? result.accounts : [];
      state.cardsLoaded = false;
      state.overviewKey = null;
      toast('Wallet linked', `${accountId} is now bound to your Google identity.`, 'success', 8000);
      render();
    } catch (error) {
      toast('Wallet not linked', error.message, 'error', 10000);
    } finally {
      busy(button, false);
    }
  }

  async function unlinkWallet(accountId, button = null) {
    const confirmed = await dialog({
      title: 'Unlink this wallet?',
      body: `<p><code>${esc(accountId)}</code> will no longer count as your account for ownership checks. The wallet and its cards stay on chain.</p>`,
      confirmLabel: 'Unlink',
      dangerous: true,
    });
    if (!confirmed) return;
    busy(button, true);
    try {
      const result = await api('/api/auth/near/links/remove', {
        method: 'POST',
        body: { accountId },
      });
      state.links = Array.isArray(result.accounts) ? result.accounts : [];
      state.cardsLoaded = false;
      state.overviewKey = null;
      toast('Wallet unlinked', accountId, 'info');
      render();
    } catch (error) {
      toast('Could not unlink wallet', error.message, 'error');
    } finally {
      busy(button, false);
    }
  }

  async function disconnectWallet(button = null) {
    const confirmed = await dialog({
      title: 'Disconnect this wallet?',
      body: '<p>This clears the wallet session on the RELAY server. The wallet account and its cards stay on chain.</p>',
      confirmLabel: 'Disconnect',
      dangerous: true,
    });
    if (!confirmed) return;
    busy(button, true);
    try {
      await api('/api/auth/wallet/logout', { method: 'POST' });
    } catch { /* session may already be gone */ }
    try { await walletBridge().disconnect(walletConfig()); } catch { /* selector state */ }
    state.wallet = { loaded: true, connecting: false, session: null, accountId: null, providerId: null, publicKey: null, error: null };
    state.authMode = currentAuthMode();
    state.owned = null;
    state.cardsLoaded = false;
    state.overviewKey = null;
    toast('Wallet disconnected', 'The RELAY wallet session was cleared.', 'info');
    render();
  }

  async function resumeWalletRedirect() {
    const params = new URLSearchParams(location.search);
    const accountId = params.get('accountId');
    const publicKey = params.get('publicKey');
    const signature = params.get('signature');
    const pendingRaw = sessionStorage.getItem('relay_wallet_pending_auth');
    if (!accountId || !publicKey || !signature || !pendingRaw) return false;
    let pending;
    try { pending = JSON.parse(pendingRaw); } catch { return false; }
    if (pending.accountId !== accountId) return false;
    try {
      await finishWalletAuth(pending.challengeId, accountId, pending.providerId, { publicKey, signature });
      const clean = `${location.pathname}${location.hash}`;
      history.replaceState(null, '', clean);
      return true;
    } catch (error) {
      sessionStorage.removeItem('relay_wallet_pending_auth');
      toast('Wallet sign-in failed', error.message, 'error', 10000);
      return false;
    }
  }

  async function resumeWalletAction() {
    const params = new URLSearchParams(location.search);
    const hashes = params.get('transactionHashes');
    const errorCode = params.get('errorCode');
    const errorMessage = params.get('errorMessage');
    const pendingRaw = sessionStorage.getItem('relay_wallet_pending_action');
    if (!pendingRaw && !hashes && !errorCode) return false;
    let pending = null;
    try { pending = pendingRaw ? JSON.parse(pendingRaw) : null; } catch { pending = null; }

    const cleanUrl = () => {
      const clean = `${location.pathname}${location.hash}`;
      history.replaceState(null, '', clean);
    };

    if (errorCode || errorMessage) {
      sessionStorage.removeItem('relay_wallet_pending_action');
      cleanUrl();
      toast(
        'Wallet action was not approved',
        errorMessage || errorCode || 'The wallet returned an error before RELAY received a transaction.',
        'error',
        10000,
      );
      return false;
    }
    if (!hashes || !pending?.actionId) return false;

    const transactionHash = hashes.split(',')[0].trim();
    try {
      const result = await api('/api/near/wallet/confirm-action', {
        method: 'POST',
        body: { actionId: pending.actionId, transactionHash },
      });
      state.receipt = result;
      refetchAfter({ summary: result.summary });
      sessionStorage.removeItem('relay_wallet_pending_action');
      cleanUrl();
      toast('Finalized on NEAR Testnet', shortId(result.transactionHash, 12, 8), 'success', 9000);
      render();
      return true;
    } catch (error) {
      sessionStorage.removeItem('relay_wallet_pending_action');
      cleanUrl();
      toast('Wallet action could not be verified', error.message, 'error', 11000);
      return false;
    }
  }

  /* --------------------------------------------------------- sponsored txs -- */

  async function cancelPrepared(actionId) {
    if (!actionId) return;
    await api('/api/near/cancel-action', { method: 'POST', body: { actionId } }).catch(() => {});
  }

  async function submitPrepared(prepared) {
    const bridge = ensureNearAuth();
    let signature;
    try {
      signature = await bridge.requestSignature(prepared.transactionBase64);
    } catch (error) {
      await cancelPrepared(prepared.actionId);
      throw new Error(/popup|closed|cancel/i.test(error.message)
        ? 'The Google signing window was closed. Nothing was submitted.'
        : error.message);
    }
    try {
      return await api('/api/near/submit-action', {
        method: 'POST',
        body: { actionId: prepared.actionId, ...signature },
      });
    } catch (error) {
      await cancelPrepared(prepared.actionId);
      throw error;
    }
  }

  /**
   * Wallet principal path: RELAY builds the exact action list, the connected
   * wallet signs and broadcasts it, then RELAY verifies finality, signer,
   * receiver, exact actions, and current ownership before accepting it.
   */
  async function runWalletAction(kind, params, options = {}) {
    const button = options.button || null;
    if (options.confirm) {
      const confirmed = await dialog({
        title: options.confirm.title,
        body: options.confirm.body,
        confirmLabel: options.confirm.confirmLabel || 'Continue',
        dangerous: Boolean(options.confirm.dangerous),
      });
      if (!confirmed) return null;
    }
    busy(button, true);
    try {
      const bridge = walletBridge();
      const prepared = await api('/api/near/wallet/prepare-action', {
        method: 'POST',
        body: { kind, ...params },
      });
      const sent = await bridge.signAndSendTransaction(walletConfig(), {
        receiverId: prepared.receiverId,
        actions: prepared.actions,
      });
      if (sent?.redirected) {
        sessionStorage.setItem('relay_wallet_pending_action', JSON.stringify({
          actionId: prepared.actionId,
          kind,
        }));
        toast('Approve in your wallet', 'The wallet is redirecting. RELAY will verify the transaction when you return.', 'info', 9000);
        return null;
      }
      if (!sent?.transactionHash) {
        throw new Error('The wallet did not return a transaction hash, so RELAY cannot verify finality.');
      }
      const result = await api('/api/near/wallet/confirm-action', {
        method: 'POST',
        body: { actionId: prepared.actionId, transactionHash: sent.transactionHash },
      });
      state.receipt = result;
      refetchAfter({ summary: prepared.summary });
      toast('Finalized on NEAR Testnet', shortId(result.transactionHash, 12, 8), 'success', 9000);
      if (options.after) await options.after(result);
      render();
      return result;
    } catch (error) {
      if (error.status === 401) {
        state.wallet.session = null;
        toast('Wallet session expired', 'Reconnect your NEAR wallet to continue.', 'warning', 9000);
        location.hash = `#/signin?returnTo=${encodeURIComponent(currentReturnTo().replace(/^\/#/, ''))}`;
      } else {
        toast('Action not completed', error.message, 'error', 11000);
      }
      return null;
    } finally {
      busy(button, false);
    }
  }


  /**
   * Google principal path: prepares a sponsored action server-side, asks Auth0
   * to authorize the exact transaction bytes, then submits. The sponsor pays the
   * signing deposit and gas top-ups; it never signs the user's transaction.
   */
  /**
   * Choose the signer for a card action. A card owned by the connected wallet
   * is always signed by that wallet, even when a Google session also exists:
   * the Google MPC key cannot sign for a wallet-owned account.
   */
  function actionModeFor(params) {
    const tokenId = params?.tokenId;
    const card = tokenId ? state.cardCache[tokenId] : null;
    const owner = card?.token?.ownerId;
    if (owner && ownsAccount(owner) && owner !== googleAccount()) return 'wallet';
    return currentAuthMode();
  }

  async function runAction(kind, params, options = {}) {
    const button = options.button || null;
    if (!isAuthed()) {
      toast('Sign in required', 'Use Google sign-in or connect a NEAR wallet to continue.', 'warning');
      location.hash = `#/signin?returnTo=${encodeURIComponent(currentReturnTo().replace(/^\/#/, ''))}`;
      return null;
    }
    if (actionModeFor(params) === 'wallet') return runWalletAction(kind, params, options);
    if (options.confirm) {
      const confirmed = await dialog({
        title: options.confirm.title,
        body: options.confirm.body,
        confirmLabel: options.confirm.confirmLabel || 'Continue',
        dangerous: Boolean(options.confirm.dangerous),
      });
      if (!confirmed) return null;
    }
    busy(button, true);
    try {
      await ensureLiveIdentity();
      const prepared = await api('/api/near/prepare-action', {
        method: 'POST',
        body: { kind, ...params },
      });
      const result = await submitPrepared(prepared);
      state.receipt = result;
      if (kind === 'mint') state.cardsLoaded = false;
      refetchAfter(result);
      toast('Finalized on NEAR Testnet', shortId(result.transactionHash, 12, 8), 'success', 9000);
      if (options.after) await options.after(result);
      render();
      return result;
    } catch (error) {
      if (error.status === 401) {
        setSession(null);
        toast('Session expired', 'Sign in with Google again to continue.', 'warning', 8000);
        location.hash = `#/signin?returnTo=${encodeURIComponent(currentReturnTo().replace(/^\/#/, ''))}`;
      } else {
        toast('Action not completed', error.message, 'error', 11000);
      }
      return null;
    } finally {
      busy(button, false);
    }
  }

  function refetchAfter(result) {
    state.cardsLoaded = false;
    state.overviewKey = null;
    state.claims = null;
    state.detailKey = null;
    state.spendKey = null;
    state.spend.assets = null;
    if (result?.summary?.tokenId) {
      delete state.cardCache[result.summary.tokenId];
      delete state.assets[result.summary.tokenId];
    }
  }

  /* ---------------------------------------------------------------- cards -- */

  let cardsInFlight = null;
  function loadCards(force = false) {
    if (state.cardsLoaded && !force) return Promise.resolve(state.cards);
    // Boot, the page mount, and a manual reload can all ask at once. Share one
    // request instead of fanning out near-duplicate chain reads.
    if (cardsInFlight) return cardsInFlight;
    cardsInFlight = (async () => {
      try {
        const result = await api('/api/cards?limit=24');
        state.cards = Array.isArray(result?.cards) ? result.cards.filter((card) => card?.token?.id) : [];
        state.cardsError = null;
      } catch (error) {
        state.cardsError = error.message;
        state.cards = [];
      }
      state.cardsLoaded = true;
      return state.cards;
    })().finally(() => { cardsInFlight = null; });
    return cardsInFlight;
  }

  async function loadCard(tokenId, force = false) {
    if (!TOKEN_RE.test(tokenId || '')) throw new Error('Invalid RELAY token ID.');
    if (!force && state.cardCache[tokenId]) return state.cardCache[tokenId];
    const card = await api(`/api/cards/${encodeURIComponent(tokenId)}`);
    state.cardCache[tokenId] = card;
    return card;
  }

  async function loadOwned(force = false) {
    const accounts = new Set();
    if (googleAccount()) accounts.add(googleAccount());
    if (walletAccount()) accounts.add(walletAccount());
    for (const accountId of linkedAccountIds()) accounts.add(accountId);
    if (accounts.size === 0) {
      state.owned = [];
      return [];
    }
    if (state.owned && !force) return state.owned;
    const ids = new Set();
    for (const accountId of accounts) {
      try {
        const owner = await api(`/api/owners/${encodeURIComponent(accountId)}`);
        for (const token of owner?.tokens || []) {
          if (TOKEN_RE.test(token.token_id)) ids.add(token.token_id);
        }
      } catch { /* fall back to the loaded card list below */ }
    }
    if (ids.size === 0) {
      for (const card of state.cards || []) {
        if (accounts.has(card?.token?.ownerId)) ids.add(card.token.id);
      }
    }
    const bundles = await Promise.all([...ids].map((id) => loadCard(id, force).catch(() => null)));
    state.owned = bundles.filter((card) => card && accounts.has(card.token.ownerId));
    return state.owned;
  }

  async function loadAssets(tokenId, force = false) {
    if (!TOKEN_RE.test(tokenId || '')) return [];
    if (!force && state.assets[tokenId]) return state.assets[tokenId];
    const result = await api(`/api/near/assets?tokenId=${encodeURIComponent(tokenId)}`);
    state.assets[tokenId] = result?.assets || [];
    return state.assets[tokenId];
  }

  /**
   * Claim a free demo stock into a card account. The treasury signs the
   * transfer, so this is a plain API call: no user transaction and no gas.
   */
  async function claimStock(tokenId, ftContractId, button = null) {
    if (!isAuthed()) {
      toast('Sign in required', 'Sign in or connect a wallet to claim test stock.', 'warning');
      return null;
    }
    busy(button, true);
    try {
      const result = await api('/api/near/ft/claim', {
        method: 'POST',
        body: { tokenId, ftContractId },
      });
      const amount = formatTokenAmount(result.amount, result.decimals);
      toast(
        'Test stock claimed',
        `${amount} ${result.symbol} added to ${result.tokenId}. Send it from the card or the Spend page.`,
        'success',
        10000,
      );
      delete state.assets[tokenId];
      state.detailKey = null;
      state.spendKey = null;
      state.spend.assets = null;
      await loadAssets(tokenId, true);
      render();
      return result;
    } catch (error) {
      if (error.status === 401) {
        toast('Sign in required', error.message, 'warning', 9000);
      } else {
        toast('Claim not completed', error.message, 'error', 12000);
      }
      return null;
    } finally {
      busy(button, false);
    }
  }

  async function loadClaims(force = false) {
    if (!isAuthed()) { state.claims = []; return []; }
    if (state.claims && !force) return state.claims;
    try {
      const result = await api('/api/near/claims');
      state.claims = result?.claims || [];
    } catch {
      state.claims = [];
    }
    return state.claims;
  }

  async function loadActivity(force = false) {
    if (state.activity && !force) return state.activity;
    try {
      const result = await api('/api/activity?limit=80');
      state.activity = result?.events || [];
    } catch {
      state.activity = [];
    }
    return state.activity;
  }

  /* ------------------------------------------------------------ components -- */

  function cardMarkup(card, options = {}) {
    if (!card?.token?.id) return '';
    const token = card.token;
    const meta = token.metadata || {};
    const title = meta.title || token.id;
    const description = meta.description || 'No description recorded on chain.';
    const media = mediaSrc(meta.media);
    const owner = token.ownerId || 'Unresolved';
    const href = options.href || `#/cards/${encodeURIComponent(token.id)}`;
    const compact = options.compact ? ' nft-card--compact' : '';
    const fallbackArt = `<div class="nft-card__art"><span class="nft-card__art-label">RELAY · NEAR TESTNET</span><span class="nft-card__art-mark"><span>${esc(initials(title))}</span></span></div>`;
    const mediaHtml = media
      ? `<img src="${esc(media)}" alt="" loading="lazy" onerror="const m=this.closest('.nft-card__media'); if(m){ m.classList.remove('has-image'); if(!m.querySelector('.nft-card__art')) m.insertAdjacentHTML('afterbegin', ${JSON.stringify(fallbackArt)}); this.remove(); }">`
      : fallbackArt;
    return `
      <a class="nft-card${compact}" href="${esc(href)}" aria-label="${esc(title)}">
        <div class="nft-card__media${media ? ' has-image' : ''}">
          ${mediaHtml}
          <span class="nft-card__seal">NEAR</span>
        </div>
        <div class="nft-card__body">
          <div class="nft-card__top">
            <span class="nft-card__id">${esc(token.id)}</span>
            ${tag(card.binding?.isVerified ? 'PROVISIONED' : 'CARD', card.binding?.isVerified ? 'success' : 'neutral')}
          </div>
          <h3 class="nft-card__title">${esc(title)}</h3>
          <p class="nft-card__desc">${esc(description)}</p>
          <div class="nft-card__foot">
            <span class="nft-card__owner">
              <span>Owner</span>
              <code>${esc(owner)}</code>
            </span>
            <span class="nft-card__chains" title="NEAR Testnet"><i class="near"></i></span>
          </div>
        </div>
      </a>`;
  }

  function cardSkeleton() {
    return `<div class="nft-card nft-card--skeleton" aria-hidden="true">
      <div class="nft-card__media"></div>
      <div class="nft-card__body"><div class="nft-card__id">LOADING</div><div class="nft-card__title">—</div></div>
    </div>`;
  }

  function emptyState({ title, text, action = '', iconName = 'cards' }) {
    return `<div class="empty-state">
      <div class="empty-icon">${icon(iconName)}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${action}
    </div>`;
  }

  function brand() {
    return `<a class="brand" href="#/">
      <img src="/relay-mark.svg" alt="" width="30" height="30">
      <span>RELAY<small>TESTNET</small></span>
    </a>`;
  }

  function accountChip() {
    if (isAuthed()) {
      const mode = currentAuthMode();
      const label = mode === 'google' ? (state.session.user?.email || sessionAccount()) : sessionAccount();
      return `<button type="button" class="account-chip" data-act="go-settings" title="${esc(`${mode === 'wallet' ? 'Wallet' : 'Google'} · ${sessionAccount()}`)}">
        <span class="avatar avatar-chip">${esc(initials(label))}</span>
        <code>${esc(shortId(sessionAccount(), 9, 6))}</code>
      </button>`;
    }
    return `<a class="btn btn-primary btn-sm" href="#/signin">${icon('google')} Sign in</a>`;
  }

  function netPill() {
    const contract = state.config?.near?.relayContractId;
    return `<span class="net-pill" title="${esc(contract || 'RELAY contract')}"><span class="live-dot"></span> NEAR TESTNET</span>`;
  }

  function testnetBanner() {
    return `<div class="testnet-banner" style="background: rgba(220, 160, 40, 0.12); color: var(--fg); border-bottom: 1px solid rgba(220, 160, 40, 0.3); font-size: 13px; text-align: center; padding: 6px 16px; font-weight: 500;">
      <span>⚠️ <strong>NEAR Testnet Mode:</strong> Public RPC nodes may experience intermittent latency or rate limits during finalized block reads.</span>
    </div>`;
  }

  function publicShell(active, content) {
    return `<div class="public-shell">
      ${testnetBanner()}
      <header class="public-header">
        <div class="public-header__inner">
          ${brand()}
          <nav class="public-nav" aria-label="Primary">
            <a href="#/" class="${active === 'home' ? 'active' : ''}">Home</a>
            <a href="#/how" class="${active === 'how' ? 'active' : ''}">How it works</a>
            <a href="#/overview" class="${active === 'app' ? 'active' : ''}">Open app</a>
          </nav>
          <div class="public-actions">${accountChip()}${themeButton()}</div>
        </div>
      </header>
      <main id="main" class="public-main">${content}</main>
      <footer class="public-footer">
        <div class="public-footer__inner">
          <div class="public-footer__brand">
            ${brand()}
            <p class="footer-note mt-12">A transferable NFT card with its own NEAR Testnet account. One Google login, sponsored gas, and direct on-chain custody. No mainnet, no cross-chain claims, no invented history.</p>
          </div>
          <div>
            <h4>Product</h4>
            <a href="#/overview">Overview</a>
            <a href="#/cards">Cards</a>
            <a href="#/create">Create a card</a>
            <a href="#/activity">Activity</a>
          </div>
          <div>
            <h4>Boundaries</h4>
            <a href="#/how">How it works</a>
            <a href="#/how#boundaries">What is live</a>
            <a href="#/signin">Google sign-in</a>
            <a href="#/settings">Settings</a>
          </div>
        </div>
        <div class="footer-bottom">
          <span>RELAY · NEAR TESTNET</span>
          <span>${esc(state.config?.near?.relayContractId || 'contract not loaded')}</span>
        </div>
      </footer>
    </div>`;
  }

  const RAIL_ITEMS = [
    { path: '/overview', label: 'Overview', icon: 'home' },
    { path: '/cards', label: 'Cards', icon: 'cards' },
    { path: '/create', label: 'Create card', icon: 'plus' },
    { path: '/fund', label: 'Add funds', icon: 'fund' },
    { path: '/send', label: 'Send', icon: 'send' },
    { path: '/spend', label: 'Spend', icon: 'spend' },
    { path: '/stocks', label: 'Test stocks', icon: 'fund' },
    { path: '/activity', label: 'Activity', icon: 'activity' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ];

  function railLinks(activePath) {
    return RAIL_ITEMS.map((item) => {
      const active = activePath === item.path || (item.path === '/cards' && activePath.startsWith('/cards/'));
      return `<a class="rail-link ${active ? 'active' : ''}" href="#${item.path}">${icon(item.icon)}<span>${esc(item.label)}</span></a>`;
    }).join('');
  }

  function appShell(content, title, crumb) {
    const activePath = state.page.path;
    return `<div class="app-shell">
      <aside class="app-rail" aria-label="Workspace">
        <div>${brand()}</div>
        <p class="rail-caption">Workspace</p>
        <nav class="rail-nav">${railLinks(activePath)}</nav>
        <div class="rail-spacer"></div>
        <div class="rail-card">
          <strong><span class="live-dot"></span> Live chain reads</strong>
          <p>Ownership, card accounts, native NEAR and NEP-141 balances are read at finalized blocks.</p>
        </div>
        <div class="rail-foot">
          <span>${esc(isAuthed() ? 'Google verified' : 'Signed out')}</span>
          ${themeButton()}
        </div>
      </aside>
      <div class="app-main">
        ${testnetBanner()}
        <header class="app-topbar">
          <button type="button" class="menu-button" data-act="open-drawer" aria-label="Open menu">${icon('menu')}</button>
          <div class="app-topbar__crumbs">${esc(crumb || 'RELAY')}<span>/</span>${esc(title)}</div>
          <div class="app-topbar__right">${netPill()}${accountChip()}</div>
        </header>
        <main id="main" class="app-content">
          ${receiptMarkup()}
          ${content}
        </main>
        <nav class="bottom-nav" aria-label="Mobile navigation">
          ${['/overview', '/cards', '/create', '/spend', '/stocks'].map((path) => RAIL_ITEMS.find((item) => item.path === path)).filter(Boolean).map((item) => {
            const active = activePath === item.path;
            return `<a href="#${item.path}" class="${active ? 'active' : ''}">${icon(item.icon)}<span>${esc(item.label.replace('Create ', ''))}</span></a>`;
          }).join('')}
        </nav>
      </div>
      <div class="mobile-drawer" id="mobile-drawer" hidden>
        <div class="mobile-drawer__panel">
          <div class="drawer-head">${brand()}<button type="button" class="btn btn-ghost btn-sm mobile-drawer__close" data-act="close-drawer" aria-label="Close menu">${icon('close')}</button></div>
          <nav class="rail-nav">${railLinks(activePath)}</nav>
        </div>
        <button type="button" class="mobile-drawer__scrim" data-act="close-drawer" aria-label="Close menu"></button>
      </div>
    </div>`;
  }

  function pageHead({ kicker, title, lede, actions = '' }) {
    return `<div class="page-head">
      <div>
        ${kicker ? `<p class="kicker">${raw(kicker)}</p>` : ''}
        <h1>${esc(title)}</h1>
        ${lede ? `<p class="lede">${esc(lede)}</p>` : ''}
      </div>
      ${actions ? `<div class="page-head__actions">${actions}</div>` : ''}
    </div>`;
  }

  function receiptMarkup() {
    const receipt = state.receipt;
    if (!receipt) return '';
    const summary = receipt.summary || {};
    const hash = receipt.transactionHash || '';
    return `<div class="page-section" style="margin-top:0">
      ${notice('success', summary.title || 'Finalized on NEAR Testnet',
        `${esc(summary.detail || 'The transaction was signed by your Google-derived key and finalized on chain.')}
         <div class="btn-row mt-12">
           ${hash ? `<a class="btn btn-sm btn-outline" href="${esc(explorerTx(hash))}" target="_blank" rel="noreferrer">${icon('external')} ${esc(shortId(hash, 12, 8))}</a>` : ''}
           <button type="button" class="btn btn-sm btn-ghost" data-act="dismiss-receipt">Dismiss</button>
         </div>`)}
    </div>`;
  }

  function gateMarkup({ title, text, returnTo = '/#/overview' }) {
    return `<div class="access-gate">
      <div>
        <p class="kicker">Access gate</p>
        <h2>${esc(title)}</h2>
        <p>${esc(text)}</p>
        <div class="access-gate__actions">
          <button type="button" class="btn btn-primary" data-act="sign-in">${icon('google')} Continue with Google</button>
          <button type="button" class="btn btn-outline" data-act="connect-wallet" ${state.wallet.connecting ? 'disabled' : ''}>${icon('key')} Connect NEAR Wallet</button>
          <a class="btn btn-ghost" href="#/how">How it works</a>
        </div>
        ${state.wallet.error ? notice('danger', 'Wallet connection', esc(state.wallet.error)) : ''}
        <p class="form-note mt-12">Return destination: <code>${esc(returnTo)}</code></p>
      </div>
      <div class="access-gate__checks">
        <div>${icon('check')}<span>Google sign-in needs no wallet or seed phrase.</span></div>
        <div>${icon('check')}<span>Wallet sign-in returns a real NEAR Testnet account.</span></div>
        <div>${icon('check')}<span>Every card action is signed and finalized on NEAR Testnet.</span></div>
      </div>
    </div>`;
  }

  function claimRow(claim, options = {}) {
    const tone = claim.status === 'claimed' ? 'success'
      : claim.status === 'ready' ? 'warning'
        : claim.status === 'expired' || claim.status === 'cancelled' ? 'danger' : 'neutral';
    const link = `${location.origin}${location.pathname}#/claim/near/${claim.id}`;
    return `<div class="invite-row">
      <div class="invite-row__state">${tag(String(claim.status || 'open').toUpperCase(), tone)}</div>
      <div class="invite-row__main">
        <strong>${esc(claim.tokenId)}</strong>
        <div class="meta">
          <span>${esc(claim.emailMasked || 'recipient email')}</span>
          <span>${esc(timeAgo(claim.createdAt))}</span>
          ${claim.transactionHash ? `<span>${esc(shortId(claim.transactionHash, 10, 6))}</span>` : ''}
        </div>
        ${options.link ? `<div class="invite-row__link"><input class="input mono" readonly value="${esc(link)}"><button type="button" class="btn btn-sm btn-outline" data-act="copy" data-copy="${esc(link)}">${icon('copy')} Copy</button></div>` : ''}
      </div>
      <div class="invite-row__actions">
        <a class="btn btn-sm btn-ghost" href="#/claim/near/${esc(claim.id)}">${icon('arrow')} Open</a>
      </div>
    </div>`;
  }

  function ownedCardsSelect(selected = '', cards = state.owned || []) {
    return cards.map((card) => `<option value="${esc(card.token.id)}" ${card.token.id === selected ? 'selected' : ''}>${esc(card.token.metadata?.title || card.token.id)} · ${esc(card.token.id)}</option>`).join('');
  }

  /* ------------------------------------------------------------- home page -- */

  function homePage() {
    const featured = state.cards[0] || null;
    const contract = state.config?.near?.relayContractId || 'loading';
    return `
      <section class="hero">
        <div class="wrap hero__grid">
          <div>
            <p class="kicker">NEAR Testnet <span class="dot">·</span> Google sign-in <span class="dot">·</span> sponsored gas</p>
            <h1 class="display">A card that<br><em>carries an account.</em></h1>
            <p class="lede">RELAY is a transferable NFT card. Each card has its own NEAR Testnet account, holds native NEAR and supported NEP-141 tokens, and can be claimed by a verified email address. No crypto wallet needed.</p>
            <div class="hero__actions">
              <a class="btn btn-primary btn-lg" href="#/create">Create a card ${icon('arrow')}</a>
              <a class="btn btn-outline btn-lg" href="#/how">How it works</a>
            </div>
            <div class="hero__meta">
              <span><span class="live-dot"></span> ${esc(contract)}</span>
              <span>${icon('key')} Google → MPC key</span>
              <span>${icon('shield')} Finalized chain state</span>
            </div>
          </div>
          <div class="hero__stage">
            <div id="home-featured">${featured ? cardMarkup(featured) : cardSkeleton()}</div>
            <div class="hero__stage-note" id="home-featured-note">
              <strong><span class="live-dot"></span> FINALIZED CHAIN STATE</strong>
              ${featured ? `Owner ${esc(shortId(featured.token.ownerId))}` : 'Reading the RELAY contract on NEAR Testnet…'}
            </div>
          </div>
        </div>
      </section>

      <section class="trust-strip">
        <div class="wrap trust-strip__inner">
          <div class="trust-strip__item">${icon('google')}<div><strong>One Google login</strong><span>Auth0 verifies the email; a NEAR MPC key signs.</span></div></div>
          <div class="trust-strip__item">${icon('key')}<div><strong>RELAY sponsors gas</strong><span>Supported actions need no NEAR from you.</span></div></div>
          <div class="trust-strip__item">${icon('layers')}<div><strong>One card, one account</strong><span>The account is bound to the NFT on chain.</span></div></div>
          <div class="trust-strip__item">${icon('mail')}<div><strong>Email-bound claims</strong><span>The owner approves; the recipient verifies an email.</span></div></div>
        </div>
      </section>

      <section class="section">
        <div class="wrap">
          <div class="section-head">
            <div>
              <p class="kicker">The object</p>
              <h2>Not a picture of an account.<br>The account itself.</h2>
              <p class="lede">The NFT is the ownership record. The card account is the thing that holds and spends value. RELAY keeps both tied together at finalized block state, and a transfer moves both.</p>
            </div>
            <a class="text-link" href="#/cards">Browse live cards</a>
          </div>
          <div class="feature-grid">
            <article class="feature">
              ${iconCircle('plus')}
              <h3>Create a real card</h3>
              <p>Sign in with Google, pick a name and artwork, and RELAY prepares the exact sponsored mint. The new card is owned by your Google-derived NEAR account.</p>
              <div class="feature__foot">Self-mint · sponsored storage deposit</div>
            </article>
            <article class="feature">
              ${iconCircle('fund')}
              <h3>Fund and spend</h3>
              <p>Send NEAR into the card account, or hold supported NEP-141 tokens. Spending uses the card account and is verified after finality.</p>
              <div class="feature__foot">Native NEAR · NEP-141 · direct custody</div>
            </article>
            <article class="feature">
              ${iconCircle('send')}
              <h3>Send it to a person</h3>
              <p>Create a claim bound to one email. The recipient signs in with that Google account, then the card owner approves the real on-chain transfer.</p>
              <div class="feature__foot">Verified email · owner approval · nft_transfer</div>
            </article>
          </div>
        </div>
      </section>

      <section class="section section-tight">
        <div class="wrap">
          <div class="status-strip" id="home-live">
            <div class="status-strip__cell"><div class="label">NEAR contract</div><div class="value"><span class="live-dot"></span> ${esc(shortId(contract, 14, 8))}</div></div>
            <div class="status-strip__cell"><div class="label">Cards readable</div><div class="value">${state.cardsLoaded ? `${state.cards.length} live token${state.cards.length === 1 ? '' : 's'}` : 'Reading…'}</div></div>
            <div class="status-strip__cell"><div class="label">Google sign-in</div><div class="value">${state.authConfig?.configured ? tag('CONFIGURED', 'success') : tag('NOT CONFIGURED', 'warning')}</div></div>
          </div>
        </div>
      </section>

      <section class="section-tight">
        <div class="wrap">
          <div class="cta-band">
            <div>
              <p class="kicker kicker--inherit">Start with the real object</p>
              <h2>Open the workspace. Sign in once.</h2>
              <p>One Google account creates or restores your sponsored NEAR account. Every supported action is signed by the MPC key derived for that identity.</p>
            </div>
            <div class="btn-row">
              <a class="btn btn-primary" href="#/overview">Open workspace</a>
              <a class="btn btn-outline btn-outline--dark" href="#/how">Read the boundaries</a>
            </div>
          </div>
        </div>
      </section>`;
  }

  async function homeMount() {
    if (!state.cardsLoaded) {
      await loadCards();
      render();
    }
  }

  /* ---------------------------------------------------------- how it works -- */

  function howPage() {
    const contract = state.config?.near?.relayContractId || 'not loaded';
    return `
      <section class="section-tight hairline">
        <div class="wrap-narrow">
          <p class="kicker">How RELAY works</p>
          <h1 class="mt-8">One identity.<br>One sponsored account.<br>One on-chain card.</h1>
          <p class="lede mt-16">This page describes exactly what the current build does and what it cannot do yet. The short version: RELAY runs on NEAR Testnet only. Google proves an email address; a NEAR MPC key derived for that identity authorizes the user's transactions; RELAY pays the gas.</p>
        </div>
      </section>

      <section class="section">
        <div class="wrap">
          <div class="split-grid">
            <div class="stack">
              <article class="panel panel-pad">
                <p class="kicker">01 · Identity</p>
                <h2 class="mb-10">Google in. No wallet setup.</h2>
                <p class="muted body-copy">RELAY uses official NEAR Auth on Testnet. Auth0 verifies the Google ID token, the RELAY server validates its signature and claims, and the NEAR MPC contract derives an ed25519 key for the exact identity path. That key controls a deterministic account named from the same path.</p>
                <div class="plan-box mt-16">
                  <div class="kv">
                    <div>Identity provider</div><div>Auth0 · login.testnet.fast-auth.com</div>
                    <div>Signing</div><div>NEAR MPC · v1.signer-prod.testnet</div>
                    <div>Account pattern</div><div class="mono">u-&lt;hash&gt;.${esc(contract)}</div>
                    <div>Network</div><div>NEAR Testnet only</div>
                  </div>
                </div>
                <p class="form-note mt-12">Google never becomes the NFT owner. The derived NEAR account owns the card, and only a signature over the exact prepared transaction can move it.</p>
              </article>

              <article class="panel panel-pad">
                <p class="kicker">02 · Sponsorship</p>
                <h2 class="mb-10">RELAY pays for gas. You approve each action.</h2>
                <p class="muted body-copy">The RELAY sponsor creates the user account, tops up gas when needed, and pays the FastAuth signing deposit. The sponsor never signs the user transaction. Every action is prepared server-side, authorized by Auth0 for exactly those bytes, signed by the MPC key, and broadcast to Testnet.</p>
                <div class="stack-sm mt-16">
                  ${notice('info', 'What the sponsor pays', 'Account creation, gas top-ups within a server-side hourly and per-account budget, and the FastAuth signing deposit. Storage deposits attached to mint and provisioning are funded from the sponsored user account.')}
                  ${notice('info', 'What the sponsor cannot do', 'Move a card, spend a card balance, or approve a claim. Those require the user key and the exact transaction the user authorized.')}
                </div>
              </article>
            </div>
            <div class="stack">
              <article class="panel panel-pad dark-panel">
                <p class="kicker text-dim">The card lifecycle</p>
                <h2 class="text-inherit mb-14">Every step is observable.</h2>
                <div class="step-list text-inherit">
                  ${[
                    ['Sign in', 'Google verifies the email; NEAR Auth derives the signing key and account.'],
                    ['Mint', 'The user key mints an NFT to itself with a 0.01 NEAR storage deposit.'],
                    ['Provision', 'A 1.95 NEAR deposit creates and verifies the card account.'],
                    ['Fund', 'Native NEAR or supported NEP-141 tokens move into the card account.'],
                    ['Claim', 'An email-bound claim is verified by the recipient and approved by the owner.'],
                    ['Spend or transfer', 'The card account spends, or nft_transfer moves the card and account.'],
                  ].map(([title, text], index) => `<div class="step-list__item">
                    <span class="step-list__num">${index + 1}</span>
                    <div class="step-list__body"><strong class="text-inherit">${esc(title)}</strong><p class="text-dim">${esc(text)}</p></div>
                  </div>`).join('')}
                </div>
              </article>
              <article class="panel panel-pad">
                <p class="kicker">03 · The money</p>
                <h3 class="mb-10">Direct NEAR Testnet custody.</h3>
                <p class="muted body-copy-sm">Funding is a native NEAR transfer into the card account. Spending is a contract call that locks the card, checks ownership, and sends from the card account. NEP-141 spending uses the same intent-bound payment record already implemented and verified on Testnet.</p>
                <ul class="small muted mt-12 list-loose">
                  <li>Native NEAR and supported NEP-141 assets only.</li>
                  <li>No bridge, no cross-chain swap, no mainnet settlement.</li>
                  <li>Every receipt links to a finalized Testnet transaction.</li>
                </ul>
              </article>
            </div>
          </div>
        </div>
      </section>

      <section class="section section-tight section--divided" id="boundaries">
        <div class="wrap">
          <div class="section-head">
            <div>
              <p class="kicker">Honest boundaries</p>
              <h2>What is live, what is not.</h2>
              <p class="lede">If a capability is not listed as live, the UI does not claim it.</p>
            </div>
          </div>
          <div class="plan-box mt-0">
            <div class="plan-box__head"><strong>Capability matrix</strong>${tag('TESTNET BUILD', 'neutral')}</div>
            <div class="kv">
              <div>Live</div><div>NEAR Testnet contract reads, card ownership, card accounts, native NEAR balances, permissionless self-mint, provisioning, email-bound claims, sponsored transaction submission, finalized receipts.</div>
              <div>Live with supported assets</div><div>NEP-141 storage registration and spending for the assets listed in the RELAY asset registry (currently <code>wrap.testnet</code>).</div>
              <div>Requires Google</div><div>Signing in creates or restores the derived account. Google popups must be allowed for the RELAY origin.</div>
              <div>Not supported</div><div>NEAR Mainnet, Base, Solana, 1Click, cross-chain intents, custodial recovery, email delivery, royalties, memberships, access passes, or credentials.</div>
              <div>Out of scope</div><div>Any use of a Google token as proof of NEAR account ownership without MPC verification, and any transaction the sponsor signs on the user's behalf.</div>
            </div>
          </div>
          <div class="split-grid split-grid--even mt-24">
            ${notice('warning', 'Testnet only', 'Every balance, card, and transaction on this site is on NEAR Testnet. Testnet tokens have no monetary value.')}
            ${notice('info', 'No email is sent', 'Claim links are displayed for the owner to share directly. RELAY does not send email.')}
          </div>
        </div>
      </section>

      <section class="section-tight">
        <div class="wrap-narrow">
          <div class="section-head"><div><p class="kicker">Questions</p><h2>Short answers.</h2></div></div>
          <div class="stack-sm">
            ${[
              ['Do I need a crypto wallet?', 'No. Sign in with Google. NEAR Auth derives an MPC signing key for your identity and RELAY sponsors gas for supported actions.'],
              ['Does Google own my card?', 'No. The card is owned by the derived NEAR account. Google is only used to authorize signatures over exact prepared transactions.'],
              ['Who pays for gas?', 'RELAY, through a server-side sponsor with hourly and per-account limits. The sponsor cannot sign user transactions.'],
              ['Can I receive a card by email?', 'Yes. The owner creates a claim bound to an email. You sign in with that Google account, then the owner approves the transfer.'],
              ['Is this multi-chain?', 'No. RELAY is NEAR Testnet only. Other chains may appear on a future roadmap but require separate implementation and are not part of this product.'],
            ].map(([q, a]) => `<details class="panel panel-pad details-panel">
              <summary class="details-summary">${esc(q)}</summary>
              <p class="muted mt-8 body-copy-sm">${esc(a)}</p>
            </details>`).join('')}
          </div>
        </div>
      </section>`;
  }

  /* --------------------------------------------------------------- sign in -- */

  function signinPage() {
    const configured = Boolean(state.authConfig?.configured);
    const reason = state.authConfig?.reason;
    const account = sessionAccount();
    const googleConnected = Boolean(state.session?.authenticated && googleAccount());
    const walletConnected = isWalletAuthed();
    return `
      <section class="section">
        <div class="wrap-narrow">
          <div class="split-grid split-grid--even">
            <div>
              <p class="kicker">Identity</p>
              <h1 class="mt-8">Two ways in.</h1>
              <p class="lede mt-16">Continue with Google for a sponsored NEAR Testnet account, or connect an existing NEAR wallet. The two identities stay separate unless you explicitly link them.</p>
              <div class="stack-sm mt-24">
                <div class="address-row"><span class="feature__icon icon-chip-sm">${icon('google')}</span><div class="address-row__body"><span>Google mode</span><code>Auth0 ID token → NEAR MPC ed25519</code></div></div>
                <div class="address-row"><span class="feature__icon icon-chip-sm">${icon('key')}</span><div class="address-row__body"><span>Wallet mode</span><code>NEP-413 signature · real Testnet account</code></div></div>
                <div class="address-row"><span class="feature__icon icon-chip-sm">${icon('shield')}</span><div class="address-row__body"><span>Ownership</span><code>Finalized NFT owner on chain</code></div></div>
              </div>
            </div>
            <div class="panel panel-pad">
              ${isAuthed() ? `
                <p class="kicker">Signed in</p>
                <h2 class="mb-8">${esc(
                  googleConnected
                    ? (state.session.user?.name || state.session.user?.email || 'Google account')
                    : (walletConnected ? 'NEAR wallet' : 'RELAY account'),
                )}</h2>
                <p class="muted small">${esc(
                  googleConnected
                    ? `${state.session.user?.email || ''} · email verified`
                    : (walletConnected ? `${account} · wallet signature verified` : ''),
                )}</p>
                <div class="plan-box mt-16">
                  <div class="kv">
                    <div>Mode</div><div>${googleConnected ? 'Google · sponsored' : 'External wallet'}</div>
                    <div>NEAR account</div><div class="mono">${esc(account)}</div>
                    <div>Network</div><div>NEAR Testnet</div>
                  </div>
                </div>
                <div class="form-actions">
                  <a class="btn btn-primary" href="#/overview">Open workspace</a>
                  ${googleConnected ? `<button type="button" class="btn btn-outline" data-act="sign-out">${icon('logout')} Sign out Google</button>` : ''}
                  ${walletConnected ? `<button type="button" class="btn btn-outline" data-act="disconnect-wallet">${icon('logout')} Disconnect wallet</button>` : ''}
                </div>
                ${!googleConnected ? `<button type="button" class="btn btn-outline btn-block mt-16" data-act="sign-in">${icon('google')} Continue with Google instead</button>` : ''}
                ${!walletConnected ? `<button type="button" class="btn btn-outline btn-block mt-12" data-act="connect-wallet" ${state.wallet.connecting ? 'disabled' : ''}>${icon('key')} Connect NEAR Wallet instead</button>` : ''}
              ` : `
                <p class="kicker">Choose an authentication mode</p>
                <h2 class="mb-8">Google or a NEAR wallet.</h2>
                <p class="muted small">Google opens the official NEAR Auth popup. Wallet opens the real NEAR Wallet Selector modal.</p>
                <button type="button" class="btn btn-primary btn-block btn-lg mt-24" data-act="sign-in" ${configured ? '' : 'disabled'}>${icon('google')} Continue with Google</button>
                <button type="button" class="btn btn-outline btn-block btn-lg mt-12" data-act="connect-wallet" ${state.wallet.connecting ? 'disabled' : ''}>${icon('key')} Connect NEAR Wallet</button>
                ${!configured ? notice('warning', 'NEAR Auth is not configured on this server', esc(reason || 'Set the sponsor key and contract ID, then restart the server.')) : ''}
                ${state.authError ? notice('danger', 'Google authentication error', esc(state.authError)) : ''}
                ${state.wallet.error ? notice('danger', 'Wallet connection error', esc(state.wallet.error)) : ''}
                <div class="form-actions">
                  <a class="text-link" href="#/overview">Browse without signing in</a>
                  <a class="text-link" href="#/how">Read the boundaries</a>
                </div>
                <p class="form-note mt-16">Google popups must be allowed for this site. Wallet extensions work on desktop; on mobile use a wallet's in-app browser or the wallet redirect flow.</p>
              `}
            </div>
          </div>
          <div class="mt-24">
            ${notice('info', 'What RELAY stores', 'A server session cookie per mode, the verified email or wallet account ID, and the public key. No Google password, no private key, no seed phrase. Google and wallet sessions are never merged automatically.')}
          </div>
        </div>
      </section>`;
  }

  /* -------------------------------------------------------------- overview -- */

  function overviewPage() {
    if (!isAuthed()) {
      return `<div class="wrap page-top">
        ${pageHead({ kicker: 'Workspace', title: 'Read first. Sign in when you want to act.', lede: 'Cards and chain state are public. Creating, funding, spending, and claiming need your Google-derived NEAR key.' })}
        ${gateMarkup({
          title: 'No Google identity yet',
          text: 'You can read every card without signing in. Sign in with Google to create or restore a sponsored NEAR Testnet account and act on cards you own.',
          returnTo: '/#/overview',
        })}
        <div class="page-section">
          <div class="page-section__head"><div><h2>Live cards</h2><p>Read from the RELAY contract at a finalized block.</p></div><a class="text-link" href="#/cards">All cards</a></div>
          ${state.cardsLoaded
            ? (state.cards.length
              ? `<div class="nft-card-grid">${state.cards.slice(0, 4).map((card) => cardMarkup(card)).join('')}</div>`
              : emptyState({ title: 'No cards readable', text: 'The contract responded without readable tokens.', iconName: 'cards' }))
            : `<div class="nft-card-grid">${cardSkeleton()}${cardSkeleton()}</div>`}
        </div>
      </div>`;
    }

    const cards = state.owned || [];
    const claims = state.claims || [];
    const openClaims = claims.filter((claim) => claim.status === 'open' || claim.status === 'ready');
    const totalNear = cards.reduce((sum, card) => sum + Number(card.associatedAccount?.balanceNear || 0), 0);
    const identity = `${state.session.user?.email || 'Google account'} · ${shortId(sessionAccount(), 12, 8)}`;

    return `<div class="wrap page-top">
      ${pageHead({
        kicker: 'Workspace',
        title: 'Overview',
        lede: 'Live ownership, card balances, and claims. No cached success states.',
        actions: `<a class="btn btn-outline" href="#/activity">${icon('activity')} Activity</a><a class="btn btn-primary" href="#/create">${icon('plus')} Create card</a>`,
      })}

      <div class="account-banner">
        <div class="account-banner__avatar">${esc(initials(state.session.user?.email || sessionAccount()))}</div>
        <div class="account-banner__body">
          <strong>${esc(state.session.user?.name || state.session.user?.email || 'Google account')}</strong>
          <span>${esc(identity)}</span>
        </div>
        <div class="account-banner__side">
          <span class="net-pill" title="Google-derived NEAR account">${icon('key')} ${esc(shortId(sessionAccount(), 10, 6))}</span>
          ${tag('SPONSORED', 'success')}
        </div>
      </div>

      <div class="stat-strip">
        <div class="stat"><div class="stat__label">Cards owned</div><div class="stat__value">${cards.length}</div><div class="stat__note">Resolved from finalized chain ownership</div></div>
        <div class="stat"><div class="stat__label">NEAR in card accounts</div><div class="stat__value">${fmtNear(totalNear)}<small>NEAR</small></div><div class="stat__note">Sum of existing card accounts</div></div>
        <div class="stat"><div class="stat__label">Open claims</div><div class="stat__value">${openClaims.length}</div><div class="stat__note">Email-bound claims awaiting verification or approval</div></div>
      </div>

      ${openClaims.length ? `<div class="page-section">
        <div class="page-section__head"><div><h2>Your claims</h2><p>Share the link directly. RELAY does not send email.</p></div>${tag(`${openClaims.length} OPEN`, 'warning')}</div>
        <div class="invite-list">${openClaims.map((claim) => claimRow(claim, { link: true })).join('')}</div>
      </div>` : ''}

      <div class="page-section">
        <div class="page-section__head"><div><h2>Your cards</h2><p>Each card resolves only if current finalized ownership matches your derived account.</p></div><a class="text-link" href="#/cards">All cards</a></div>
        ${cards.length
          ? `<div class="nft-card-grid">${cards.slice(0, 6).map((card) => cardMarkup(card)).join('')}</div>`
          : emptyState({
            title: 'No cards owned yet',
            text: 'Create the first card. RELAY sponsors the gas; the card is owned by your Google-derived NEAR account.',
            action: `<div class="btn-row center-x"><a class="btn btn-primary" href="#/create">Create a card</a><a class="btn btn-outline" href="#/cards">Browse cards</a></div>`,
            iconName: 'cards',
          })}
      </div>

      <div class="page-section">
        <div class="page-section__head"><div><h2>Next actions</h2><p>Each action ends in a finalized Testnet transaction or a verified chain read.</p></div></div>
        <div class="action-grid action-grid--4">
          <a class="action-tile" href="#/fund">${icon('fund')}<div><strong>Add funds</strong><span>Send NEAR into a card account.</span></div></a>
          <a class="action-tile" href="#/send">${icon('send')}<div><strong>Send a card</strong><span>Email-bound claim or direct transfer.</span></div></a>
          <a class="action-tile" href="#/spend">${icon('spend')}<div><strong>Spend</strong><span>Native NEAR or supported NEP-141.</span></div></a>
          <a class="action-tile" href="#/activity">${icon('activity')}<div><strong>Review activity</strong><span>Server journals and chain evidence.</span></div></a>
        </div>
      </div>
    </div>`;
  }

  async function overviewMount() {
    if (!isAuthed()) {
      if (!state.cardsLoaded) { await loadCards(); render(); }
      return;
    }
    const key = sessionAccount();
    if (state.overviewKey === key) return;
    await Promise.all([loadCards(), loadOwned(true), loadClaims(true)]);
    state.overviewKey = key;
    render();
  }

  /* ---------------------------------------------------------------- cards -- */

  function cardsPage() {
    const cards = state.cards;
    return `<div class="wrap page-top">
      ${pageHead({
        kicker: 'Collection',
        title: 'Cards on NEAR Testnet',
        lede: 'Every card below is read from the RELAY contract at a finalized block. Ownership and provisioning are chain facts.',
        actions: `<a class="btn btn-primary" href="#/create">${icon('plus')} Create card</a>`,
      })}
      ${state.cardsLoaded
        ? (cards.length
          ? `<div class="nft-card-grid">${cards.map((card) => cardMarkup(card)).join('')}</div>`
          : emptyState({ title: 'No cards yet', text: 'The contract responded without readable tokens. Create the first card.', action: '<a class="btn btn-primary" href="#/create">Create a card</a>', iconName: 'cards' }))
        : `<div class="nft-card-grid">${cardSkeleton()}${cardSkeleton()}${cardSkeleton()}</div>`}
      ${state.cardsError ? notice('danger', 'Could not read cards', esc(state.cardsError)) : ''}
    </div>`;
  }

  async function cardsMount() {
    if (!state.cardsLoaded || state.cardsError) { await loadCards(true); render(); }
  }
  /* ----------------------------------------------------------- card detail -- */

  function chainFactsPanel(card) {
    const token = card.token;
    const account = card.associatedAccount || {};
    const binding = card.binding || {};
    return `<div class="panel panel-pad">
      <div class="panel-head panel-head--tight">
        <h3 class="h-xs">Finalized chain read</h3>
        ${tag(binding.isVerified ? 'PROVISIONED' : 'UNPROVISIONED', binding.isVerified ? 'success' : 'warning')}
      </div>
      <div class="panel-body">
        <p class="muted small">Read from <code>${esc(card.contractId || state.config?.near?.relayContractId || 'the RELAY contract')}</code> at block <code>${esc(shortId(card.blockHash, 12, 8))}</code>.</p>
        <div class="kv mt-16">
          <div>Card</div><div>${esc(token.metadata?.title || token.id)}</div>
          <div>Token ID</div><div class="mono">${esc(token.id)}</div>
          <div>Owner</div><div class="mono">${esc(token.ownerId || '—')}</div>
          <div>Card account</div><div class="mono">${esc(account.accountId || binding.accountId || '—')} ${binding.isVerified ? tag('VERIFIED', 'success') : tag('UNVERIFIED', 'warning')}</div>
          <div>Account balance</div><div>${account.exists ? `${esc(account.balanceNear || '0')} NEAR` : 'Account not created'}${account.spendableNear ? `<span class="faint"> · ${esc(account.spendableNear)} est. spendable</span>` : ''}</div>
          <div>Provisioning</div><div>${tag(card.provisioning || 'UNKNOWN', card.provisioning === 'Completed' ? 'success' : 'neutral')}</div>
          <div>Credits</div><div>${esc(card.credits?.remaining ?? '—')} / ${esc(card.credits?.total ?? '—')} remaining</div>
          <div>Lifecycle</div><div>${tag(card.lifecycle || 'Unlocked', card.lifecycle === 'Unlocked' ? 'success' : 'warning')}</div>
        </div>
        <div class="btn-row mt-16">
          ${account.accountId ? `<a class="btn btn-outline btn-sm" href="${esc(explorerAccount(account.accountId))}" target="_blank" rel="noreferrer">${icon('external')} Card account</a>` : ''}
          ${card.explorer?.token ? `<a class="btn btn-outline btn-sm" href="${esc(card.explorer.token)}" target="_blank" rel="noreferrer">${icon('external')} NFT explorer</a>` : ''}
        </div>
      </div>
    </div>`;
  }

  function formatTokenAmount(baseUnits, decimals = 0) {
    if (baseUnits === null || baseUnits === undefined || baseUnits === '') return null;
    try {
      const value = BigInt(baseUnits);
      const places = Math.max(0, Math.min(24, Number(decimals) || 0));
      const scale = 10n ** BigInt(places);
      const whole = value / scale;
      const fraction = value % scale;
      if (!fraction) return whole.toString();
      return `${whole}.${fraction.toString().padStart(places, '0').replace(/0+$/, '')}`;
    } catch {
      return String(baseUnits);
    }
  }

  function assetsPanel(card) {
    const assets = state.assets[card.token.id];
    if (!assets) return `<div class="panel panel-pad"><p class="muted small">Reading supported NEP-141 assets…</p></div>`;
    const ownerReady = isOwner(card) && card.binding?.isVerified;
    return `<div class="panel panel-pad">
      <div class="panel-head panel-head--tight"><h3 class="h-xs">Supported NEP-141 assets</h3>${tag(`${assets.length} REGISTERED`, 'neutral')}</div>
      <div class="panel-body">
        ${assets.length ? `<div class="kv">
          ${assets.map((asset) => {
            const balance = formatTokenAmount(asset.balance, asset.decimals);
            const claimAmount = formatTokenAmount(asset.claimAmount, asset.decimals);
            const claimRemaining = formatTokenAmount(asset.claimRemaining, asset.decimals);
            const canClaim = Boolean(
              asset.claimable && ownerReady &&
              asset.claimRemaining !== null && asset.claimRemaining !== undefined &&
              BigInt(asset.claimRemaining) > 0n
            );
            return `
            <div>
              <strong>${esc(asset.symbol)}</strong>
              <div class="faint small">${esc(asset.name || '')}</div>
            </div>
            <div>
              <div class="mono">${esc(asset.contractId)}</div>
              <div class="mt-8">${asset.registered
                ? `${esc(balance)} ${esc(asset.symbol)}`
                : tag('NOT REGISTERED', 'warning')}
                ${!asset.registered && ownerReady ? `<button type="button" class="btn btn-sm btn-outline" data-act="register-ft" data-id="${esc(card.token.id)}" data-ft="${esc(asset.contractId)}">Register storage</button>` : ''}
              </div>
              ${asset.claimable ? `<div class="mt-8">
                ${canClaim
                  ? `<button type="button" class="btn btn-sm btn-primary" data-act="claim-stock" data-id="${esc(card.token.id)}" data-ft="${esc(asset.contractId)}">${icon('fund')} Claim ${esc(claimAmount)} ${esc(asset.symbol)}</button>`
                  : `<span class="faint small">${ownerReady ? 'Demo claim limit reached' : 'Owner can claim test stock'}</span>`}
                <span class="faint small">${esc(claimRemaining)} ${esc(asset.symbol)} left for this card</span>
              </div>` : ''}
            </div>`;
          }).join('')}
        </div>` : notice('info', 'No supported assets', 'The RELAY asset registry returned no NEP-141 metadata for this card.')}
        <p class="form-note mt-12">Balances are read with <code>ft_balance_of</code>. Registration uses the card account's <code>storage_deposit</code>. Test stocks are free demo tokens with no real-world value; claim them here, then send them from the card like any NEP-141 asset.</p>
      </div>
    </div>`;
  }

  function isOwner(card) {
    return Boolean(isAuthed() && ownsAccount(card?.token?.ownerId));
  }

  function ownerActionsPanel(card) {
    if (!isOwner(card)) {
      return `<div class="panel panel-pad">
        <p class="kicker">Read-only view</p>
        <h3 class="mb-8">This card belongs to another NEAR account.</h3>
        <p class="muted small">You can read every chain fact, but only the current owner key can provision, fund, spend, transfer, or create claims.</p>
        ${!isAuthed() ? `<div class="form-actions"><button type="button" class="btn btn-primary" data-act="sign-in">${icon('google')} Sign in to check your cards</button></div>` : ''}
      </div>`;
    }
    if (!card.binding?.isVerified) {
      return `<div class="panel panel-pad">
        <p class="kicker">Next step</p>
        <h3 class="mb-8">Provision the card account</h3>
        <p class="muted small">The NFT exists, but its associated account is not created and verified yet. Provisioning attaches a 1.95 NEAR deposit, creates <code>${esc(card.token.id)}.${esc(card.contractId || state.config?.near?.relayContractId || '')}</code>, and completes the on-chain handshake.</p>
        ${notice('info', 'Sponsored gas', 'RELAY tops up your account with the 1.95 NEAR deposit before you sign. The deposit becomes the card account balance.')}
        <div class="form-actions">
          <button type="button" class="btn btn-primary" data-act="provision" data-id="${esc(card.token.id)}">${icon('layers')} Provision card account</button>
        </div>
      </div>`;
    }
    return `<div class="panel panel-pad">
      <p class="kicker">Owner actions</p>
      <h3 class="mb-10">Operate the card account</h3>
      <div class="stack-sm">
        <form data-form="fund" data-id="${esc(card.token.id)}">
          <div class="field">
            <label for="detail-fund-amount">Add NEAR to the card account</label>
            <div class="input-suffix"><input class="input mono" id="detail-fund-amount" name="amountNear" placeholder="0.5" inputmode="decimal" required><span>NEAR</span></div>
            <span class="hint">A direct native NEAR transfer from your sponsored account into the card account.</span>
          </div>
          <button type="submit" class="btn btn-primary btn-block">${icon('fund')} Fund card</button>
        </form>
        <form data-form="spend" data-id="${esc(card.token.id)}">
          <div class="field">
            <label for="detail-spend-receiver">Send NEAR from the card</label>
            <input class="input mono" id="detail-spend-receiver" name="receiverId" placeholder="friend.testnet" required>
          </div>
          <div class="field">
            <label for="detail-spend-amount">Amount</label>
            <div class="input-suffix"><input class="input mono" id="detail-spend-amount" name="amountNear" placeholder="0.25" inputmode="decimal" required><span>NEAR</span></div>
          </div>
          <button type="submit" class="btn btn-outline btn-block">${icon('spend')} Send from card</button>
        </form>
        <form data-form="ft-spend" data-id="${esc(card.token.id)}">
          <div class="field">
            <label for="detail-ft-asset">Spend a NEP-141 asset</label>
            <select class="select" id="detail-ft-asset" name="ftContractId">
              ${(state.assets[card.token.id] || []).filter((asset) => asset.registered).map((asset) => `<option value="${esc(asset.contractId)}">${esc(asset.symbol)} · ${esc(asset.contractId)}</option>`).join('') || '<option value="">Register an asset first</option>'}
            </select>
          </div>
          <div class="field">
            <label for="detail-ft-receiver">Recipient</label>
            <input class="input mono" id="detail-ft-receiver" name="receiverId" placeholder="friend.testnet" required>
          </div>
          <div class="field">
            <label for="detail-ft-amount">Amount in base units</label>
            <input class="input mono" id="detail-ft-amount" name="amount" placeholder="100000000" required>
            <span class="hint">NEP-141 amounts are integers in the token's smallest unit. Test stocks use 6 decimals (1 share = 1,000,000 base units); wNEAR uses 24.</span>
          </div>
          <button type="submit" class="btn btn-outline btn-block">${icon('spend')} Spend token</button>
        </form>
        <form data-form="claim-create" data-id="${esc(card.token.id)}">
          <div class="field">
            <label for="detail-claim-email">Send this card by verified email</label>
            <input class="input" id="detail-claim-email" name="email" type="email" placeholder="friend@example.com" required>
            <span class="hint">The recipient signs in with this Google email, then you approve the transfer.</span>
          </div>
          <button type="submit" class="btn btn-outline btn-block">${icon('mail')} Create claim link</button>
        </form>
        <form data-form="transfer" data-id="${esc(card.token.id)}">
          <div class="field">
            <label for="detail-transfer-receiver">Transfer directly to a NEAR account</label>
            <input class="input mono" id="detail-transfer-receiver" name="receiverId" placeholder="friend.testnet" required>
            <span class="hint">Transfers the NFT and its card account immediately. There is no undo.</span>
          </div>
          <button type="submit" class="btn btn-outline btn-block">${icon('send')} Transfer card</button>
        </form>
      </div>
    </div>`;
  }

  function cardDetailPage() {
    const id = state.page.params.id;
    const card = state.cardCache[id];
    if (!card) {
      return `<div class="wrap page-top">
        ${pageHead({ kicker: 'Card', title: id || 'Card', lede: 'Reading the RELAY contract at a finalized block.' })}
        ${state.cardsError ? notice('danger', 'Could not read this card', esc(state.cardsError)) : `<div class="nft-card-grid">${cardSkeleton()}</div>`}
      </div>`;
    }
    return `<div class="wrap page-top">
      ${pageHead({
        kicker: `Card · ${card.lifecycle || 'Unlocked'}`,
        title: card.token.metadata?.title || card.token.id,
        lede: card.token.metadata?.description || 'No description recorded on chain.',
        actions: `<a class="btn btn-outline" href="#/cards">${icon('arrow')} All cards</a>`,
      })}
      <div class="overview-live">
        ${cardMarkup(card, { href: `#/cards/${encodeURIComponent(card.token.id)}` })}
        <div class="stack">
          ${chainFactsPanel(card)}
          ${ownerActionsPanel(card)}
          ${assetsPanel(card)}
        </div>
      </div>
    </div>`;
  }

  async function cardDetailMount() {
    const id = state.page.params.id;
    if (!TOKEN_RE.test(id || '')) return;
    const key = `card:${id}`;
    if (state.detailKey === key && state.cardCache[id] && state.assets[id]) return;
    try {
      await Promise.all([loadCard(id, true), loadAssets(id, true)]);
      state.cardsError = null;
      state.detailKey = key;
    } catch (error) {
      state.cardsError = error.message;
    }
    render();
  }

  /* ---------------------------------------------------------- create page -- */

  function createPage() {
    if (!isAuthed()) {
      return `<div class="wrap page-top">
        ${pageHead({ kicker: 'Creator studio', title: 'Create a card', lede: 'Sign in with Google to mint a card owned by your sponsored NEAR account.' })}
        ${gateMarkup({ title: 'Sign in to create', text: 'RELAY needs your Google-derived key to mint and provision the card. There is no wallet setup.', returnTo: '/#/create' })}
      </div>`;
    }
    const image = state.create.imageUrl;
    const preview = image || state.create.objectUrl;
    const previewCard = {
      token: { id: 'preview', ownerId: sessionAccount(), metadata: { title: 'Your card title', description: 'Your card description appears here.', media: preview } },
      binding: { isVerified: false },
    };
    return `<div class="wrap page-top">
      ${pageHead({ kicker: 'Creator studio', title: 'Create a card', lede: 'The card is minted to your derived account. RELAY sponsors gas; the 0.01 NEAR storage deposit comes from your sponsored balance.' })}
      <div class="split-grid">
        <div class="panel panel-pad">
          <form data-form="create">
            <div class="field">
              <label for="create-name">Card name</label>
              <input class="input" id="create-name" name="name" maxlength="64" placeholder="Night Shift" required data-role="create-name">
            </div>
            <div class="field">
              <label for="create-token">Token ID</label>
              <div class="input-action">
                <input class="input mono" id="create-token" name="tokenId" maxlength="32" pattern="[a-z0-9_-]{1,32}" placeholder="night-shift" required data-role="create-token">
                <button type="button" class="btn btn-outline" data-act="suggest-token">Suggest</button>
              </div>
              <span class="hint">1–32 lowercase letters, numbers, hyphens, or underscores. IDs beginning with <code>u-</code> are reserved.</span>
            </div>
            <div class="field">
              <label for="create-description">Description</label>
              <textarea class="textarea" id="create-description" name="description" maxlength="500" placeholder="What does this card carry?"></textarea>
            </div>
            <div class="field">
              <label for="create-credits">Initial credits</label>
              <input class="input mono" id="create-credits" name="initialCredits" type="number" min="0" max="100" value="3">
            </div>
            <div class="field">
              <label for="create-art">Artwork</label>
              ${preview ? `
                <div class="upload-preview">
                  <img src="${esc(preview)}" alt="Selected card artwork preview">
                  <div>
                    <strong>${esc(state.create.fileName || 'Artwork ready')}</strong>
                    ${state.create.bytes ? `<p class="hint">${(state.create.bytes / (1024 * 1024)).toFixed(2)} MB</p>` : ''}
                    ${image ? `<p class="hint break">Persistent URI: ${esc(image)}</p>` : '<p class="hint">Previewing the local file. RELAY has not stored it yet.</p>'}
                    <div class="btn-row mt-8">
                      <label class="btn btn-sm btn-outline" for="create-art">Replace</label>
                      <button type="button" class="btn btn-sm btn-ghost" data-act="clear-art">${icon('trash')} Remove</button>
                    </div>
                  </div>
                </div>
                <input class="sr-only" id="create-art" type="file" accept="image/jpeg,image/png,image/webp" data-role="art-file">
              ` : `
                <label class="upload" data-role="art-drop" for="create-art">
                  <input id="create-art" type="file" accept="image/jpeg,image/png,image/webp" data-role="art-file">
                  <span class="feature__icon icon-chip-sm">${icon('plus')}</span>
                  <strong>Choose or drop artwork</strong>
                  <span class="hint">JPEG, PNG, or WebP · max 10 MB</span>
                </label>
              `}
              ${state.create.uploading ? `
                <div class="upload-progress" role="status" aria-live="polite">
                  <div class="upload-progress__bar" id="upload-progress-bar" style="width:${Math.max(0, Math.min(100, state.create.progress || 0))}%"></div>
                </div>
                <span class="hint" id="upload-progress-label">Uploading ${esc(state.create.fileName || 'artwork')}… ${Math.round(state.create.progress || 0)}%</span>
              ` : '<span class="hint">Desktop: click the area or drag a file onto it. iPhone and Android: tap to open the photo library. The page never opens the camera automatically.</span>'}
            </div>
            ${state.create.uploadError ? `
              <div class="notice danger"><div class="notice-body">
                <strong>Upload failed</strong>
                <p>${esc(state.create.uploadError)}</p>
                ${state.create.file ? `<button type="button" class="btn btn-sm btn-outline mt-8" data-act="retry-art">Retry upload</button>` : ''}
              </div></div>
            ` : ''}
            <div class="form-actions">
              <button type="submit" class="btn btn-primary btn-lg">${icon('plus')} Mint card</button>
              <a class="btn btn-outline btn-lg" href="#/cards">Cancel</a>
            </div>
            <p class="form-note mt-12">Minting is a real Testnet transaction. After minting, provision the card account to enable funding and spending.</p>
          </form>
        </div>
        <div class="stack">
          <div class="nft-card">${cardMarkup(previewCard).replace(/^<a[^>]*>|<\/a>$/g, '')}</div>
          <div class="panel panel-pad">
            <p class="kicker">What happens</p>
            <div class="step-list">
              ${[
                ['Mint', 'relay_mint creates the NFT to your derived account.'],
                ['Provision', 'A second action creates the card account with 1.95 NEAR.'],
                ['Fund', 'Send NEAR into the card account whenever you want.'],
              ].map(([title, text], index) => `<div class="step-list__item">
                <span class="step-list__num">${index + 1}</span>
                <div class="step-list__body"><strong>${esc(title)}</strong><p>${esc(text)}</p></div>
              </div>`).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ------------------------------------------------------------- fund page -- */

  function fundPage() {
    if (!isAuthed()) {
      return `<div class="wrap page-top">${pageHead({ kicker: 'Funds', title: 'Add funds', lede: 'Sign in to fund a card account.' })}${gateMarkup({ title: 'Sign in to fund a card', text: 'Only the card owner can move value into or out of the card account.', returnTo: '/#/fund' })}</div>`;
    }
    const cards = (state.owned || []).filter((card) => card.binding?.isVerified);
    const unprovisioned = (state.owned || []).filter((card) => !card.binding?.isVerified);
    if (!cards.length) {
      const list = unprovisioned.length
        ? `<div class="stack mt-16">${unprovisioned.map((card) => `
            <div class="panel panel-pad">
              <p class="kicker">Minted</p>
              <h3 class="mb-8">${esc(card.token.metadata?.title || card.token.id)}</h3>
              <p class="muted small">${esc(card.token.id)} · card account not created yet</p>
              <div class="form-actions"><a class="btn btn-primary" href="#/cards/${encodeURIComponent(card.token.id)}">Provision card account</a></div>
            </div>`).join('')}</div>`
        : '';
      return `<div class="wrap page-top">
        ${pageHead({ kicker: 'Funds', title: 'Add funds', lede: 'Fund a provisioned card account with native NEAR.' })}
        ${unprovisioned.length
          ? notice('warning', 'Provision required', `${unprovisioned.length === 1 ? 'Your card is' : 'Your cards are'} minted but not provisioned. Minting only creates the NFT; the card account must be provisioned first, then it can hold NEAR.`)
          : emptyState({ title: 'No card yet', text: 'Create a card and provision its account before adding funds.', action: '<div class="btn-row center-x"><a class="btn btn-primary" href="#/create">Create a card</a><a class="btn btn-outline" href="#/cards">View cards</a></div>', iconName: 'fund' })}
        ${list}
      </div>`;
    }
    const fundOptions = [
      ...cards.map((card) => `<option value="${esc(card.token.id)}">${esc(card.token.metadata?.title || card.token.id)} · ${esc(card.token.id)}</option>`),
      ...unprovisioned.map((card) => `<option value="${esc(card.token.id)}" disabled>${esc(card.token.metadata?.title || card.token.id)} · ${esc(card.token.id)} — provision required</option>`),
    ].join('');
    return `<div class="wrap page-top">
      ${pageHead({ kicker: 'Funds', title: 'Add funds', lede: 'Send native NEAR from your sponsored account into a card account. The transfer is direct custody, not a cross-chain intent.' })}
      ${unprovisioned.length ? notice('warning', 'Provision required', `${unprovisioned.length === 1 ? '1 card is' : `${unprovisioned.length} cards are`} minted but not provisioned, so it cannot hold funds yet. Open <a href="#/cards">Cards</a>, select it, and choose <strong>Provision card account</strong>.`) : ''}
      <div class="split-grid">
        <div class="panel panel-pad">
          <form data-form="fund">
            <div class="field">
              <label for="fund-card">Card</label>
              <select class="select" id="fund-card" name="tokenId" required>${fundOptions}</select>
            </div>
            <div class="field">
              <label for="fund-amount">Amount</label>
              <div class="input-suffix"><input class="input mono" id="fund-amount" name="amountNear" placeholder="1.0" inputmode="decimal" required><span>NEAR</span></div>
              <span class="hint">Your sponsored account signs the transfer. RELAY pays the gas.</span>
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-primary btn-lg">${icon('fund')} Fund card</button></div>
          </form>
        </div>
        <div class="stack">
          ${notice('info', 'Free test stocks', 'Every provisioned card can claim 100 shares of AAPL, TSLA, GOLD, and OIL for free (1,000 shares per card, per token). Open a card, use the <strong>Supported NEP-141 assets</strong> panel, then send the tokens from the card.')}
          ${notice('info', 'Where the money goes', 'The card account is a real NEAR Testnet account bound to the NFT. Its balance is read directly from chain and moves with the card when the NFT is transferred.')}
          ${notice('warning', 'Testnet only', 'Testnet NEAR has no monetary value. The stock tokens are demo assets with no real-world value.')}
        </div>
      </div>
    </div>`;
  }

  async function fundMount() {
    if (!isAuthed()) return;
    if (!state.owned) { await loadOwned(true); render(); }
  }

  /* ------------------------------------------------------------- send page -- */

  function sendPage() {
    if (!isAuthed()) {
      return `<div class="wrap page-top">${pageHead({ kicker: 'Transfer', title: 'Send a card', lede: 'Sign in to send a card by email claim or direct transfer.' })}${gateMarkup({ title: 'Sign in to send a card', text: 'Sending requires the owner key over the exact transfer transaction.', returnTo: '/#/send' })}</div>`;
    }
    const cards = state.owned || [];
    if (!cards.length) {
      return `<div class="wrap page-top">${pageHead({ kicker: 'Transfer', title: 'Send a card', lede: 'You do not own a card yet.' })}${emptyState({ title: 'Nothing to send', text: 'Create or receive a card first.', action: '<a class="btn btn-primary" href="#/create">Create a card</a>', iconName: 'send' })}</div>`;
    }
    const claims = state.claims || [];
    const hasUnlinkedWalletCards = (state.owned || []).some((c) => c.token?.ownerId !== googleAccount() && !linkedAccountIds().includes(c.token?.ownerId));
    return `<div class="wrap page-top">
      ${pageHead({ kicker: 'Transfer', title: 'Send a card', lede: 'Choose an email-bound claim with owner approval, or transfer immediately to a NEAR account.' })}
      ${isAuthed() && !state.links.length && hasUnlinkedWalletCards ? notice('info', 'Owner tip', 'If you own cards across both Google and an external NEAR wallet, bind them in <a class="text-link" href="#/settings">Settings → Linked accounts</a> so you can manage and send all cards seamlessly from either identity.') : ''}
      <div class="split-grid split-grid--even">
        <div class="panel panel-pad">
          <p class="kicker">Email-bound claim</p>
          <h3 class="mb-8">The recipient verifies, you approve.</h3>
          <p class="muted small">RELAY does not send email. You share the generated link directly.</p>
          <form data-form="claim-create">
            <div class="field">
              <label for="send-claim-card">Card</label>
              <select class="select" id="send-claim-card" name="tokenId" required>${ownedCardsSelect()}</select>
            </div>
            <div class="field">
              <label for="send-claim-email">Recipient email</label>
              <input class="input" id="send-claim-email" name="email" type="email" placeholder="friend@example.com" required>
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-primary">${icon('mail')} Create claim link</button></div>
          </form>
        </div>
        <div class="panel panel-pad">
          <p class="kicker">Direct transfer</p>
          <h3 class="mb-8">Transfer now. No approval step.</h3>
          <p class="muted small">The NFT and its card account move to the recipient immediately.</p>
          <form data-form="transfer">
            <div class="field">
              <label for="send-transfer-card">Card</label>
              <select class="select" id="send-transfer-card" name="tokenId" required>${ownedCardsSelect()}</select>
            </div>
            <div class="field">
              <label for="send-transfer-receiver">Recipient NEAR account</label>
              <input class="input mono" id="send-transfer-receiver" name="receiverId" placeholder="friend.testnet" required>
              <span class="hint">A valid Testnet account. This cannot be undone.</span>
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-outline">${icon('send')} Transfer card</button></div>
          </form>
        </div>
      </div>
      <div class="page-section">
        <div class="page-section__head"><div><h2>Claims</h2><p>Claims you created. Share links directly.</p></div></div>
        ${claims.length ? `<div class="invite-list">${claims.map((claim) => claimRow(claim, { link: claim.status === 'open' })).join('')}</div>` : emptyState({ title: 'No claims yet', text: 'Create an email-bound claim above.', iconName: 'mail' })}
      </div>
    </div>`;
  }

  async function sendMount() {
    if (!isAuthed()) return;
    if (!state.owned || !state.claims) {
      await Promise.all([loadOwned(true), loadClaims(true)]);
      render();
    }
  }

  /* ------------------------------------------------------------ spend page -- */

  function spendPage() {
    if (!isAuthed()) {
      return `<div class="wrap page-top">${pageHead({ kicker: 'Payments', title: 'Spend', lede: 'Sign in to spend from a card account.' })}${gateMarkup({ title: 'Sign in to spend', text: 'Spending requires the owner key and an exact prepared transaction.', returnTo: '/#/spend' })}</div>`;
    }
    const cards = (state.owned || []).filter((card) => card.binding?.isVerified);
    if (!cards.length) {
      return `<div class="wrap page-top">${pageHead({ kicker: 'Payments', title: 'Spend', lede: 'Provision a card account first.' })}${emptyState({ title: 'No spendable card', text: 'Create a card and provision its account before spending.', action: '<a class="btn btn-primary" href="#/create">Create a card</a>', iconName: 'spend' })}</div>`;
    }
    const selected = state.spend.tokenId || cards[0].token.id;
    const selectedCard = cards.find((card) => card.token.id === selected) || cards[0];
    const cardAccount = selectedCard.associatedAccount?.accountId || selectedCard.binding?.accountId || `${selected}.${state.config?.near?.relayContractId || ''}`;
    const signer = currentAuthMode() === 'wallet' ? walletAccount() : googleAccount();
    const sponsored = currentAuthMode() !== 'wallet';
    const assets = state.spend.assets || [];
    const registered = assets.filter((asset) => asset.registered);
    return `<div class="wrap page-top">
      ${pageHead({ kicker: 'Payments', title: 'Spend', lede: 'Send native NEAR or a supported NEP-141 asset from a card account. Every payment is prepared, signed by your derived key, and verified after finality.' })}
      <div class="split-grid split-grid--even">
        <div class="panel panel-pad">
          <p class="kicker">Native NEAR</p>
          <h3 class="mb-8">Send from the card account</h3>
          <form data-form="spend">
            <div class="field">
              <label for="spend-card">Card</label>
              <select class="select" id="spend-card" name="tokenId" data-change="spend-card" required>${ownedCardsSelect(selected, cards)}</select>
            </div>
            <div class="field">
              <label for="spend-receiver">Recipient</label>
              <input class="input mono" id="spend-receiver" name="receiverId" placeholder="friend.testnet" required>
            </div>
            <div class="field">
              <label for="spend-amount">Amount</label>
              <div class="input-suffix"><input class="input mono" id="spend-amount" name="amountNear" placeholder="0.25" inputmode="decimal" required><span>NEAR</span></div>
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-primary">${icon('spend')} Send NEAR</button></div>
          </form>
        </div>
        <div class="panel panel-pad">
          <p class="kicker">NEP-141</p>
          <h3 class="mb-8">Spend a supported token</h3>
          ${registered.length ? `<form data-form="ft-spend">
            <div class="field">
              <label for="spend-ft-card">Card</label>
              <select class="select" id="spend-ft-card" name="tokenId" data-change="spend-card" required>${ownedCardsSelect(selected, cards)}</select>
            </div>
            <div class="field">
              <label for="spend-ft-asset">Asset</label>
              <select class="select" id="spend-ft-asset" name="ftContractId" required>
                ${registered.map((asset) => `<option value="${esc(asset.contractId)}">${esc(asset.symbol)} · ${esc(asset.contractId)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label for="spend-ft-receiver">Recipient</label>
              <input class="input mono" id="spend-ft-receiver" name="receiverId" placeholder="friend.testnet" required>
            </div>
            <div class="field">
              <label for="spend-ft-amount">Amount in base units</label>
              <input class="input mono" id="spend-ft-amount" name="amount" placeholder="100000000" required>
              <span class="hint">Test stocks use 6 decimals (1 share = 1,000,000 base units). wNEAR uses 24.</span>
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-primary">${icon('spend')} Send token</button></div>
          </form>` : notice('info', 'No registered NEP-141 asset', 'Open the card and register storage for a supported asset first.')}
          <p class="form-note mt-12">The selected card is <code>${esc(selected)}</code>.</p>
        </div>
      </div>
      <div class="page-section">
        <div class="page-section__head"><div><h2>Payment review</h2><p>What RELAY resolves from finalized chain state before it prepares a transaction.</p></div>${tag('CHAIN-RESOLVED', 'neutral')}</div>
        <div class="panel panel-pad">
          <div class="kv">
            <div>NFT owner</div><div class="mono">${esc(selectedCard.token.ownerId || '—')}</div>
            <div>Card account</div><div class="mono">${esc(cardAccount || '—')}</div>
            <div>Native asset source</div><div class="mono">${esc(cardAccount || '—')} <span class="faint">(card account balance)</span></div>
            <div>NEP-141 source</div><div class="mono">${esc(cardAccount || '—')} → registered token contract</div>
            <div>Signer</div><div class="mono">${esc(signer || '—')} ${sponsored ? tag('MPC', 'neutral') : tag('WALLET', 'neutral')}</div>
            <div>Gas sponsor</div><div>${sponsored ? 'RELAY sponsor pays gas only; it never signs for you.' : 'The connected wallet pays its own gas.'}</div>
            <div>Receiver</div><div>Entered per payment; must match the approved transaction byte for byte.</div>
            <div>Network</div><div>NEAR Testnet · <code>${esc(state.config?.near?.relayContractId || 'contract not loaded')}</code></div>
          </div>
          <p class="form-note mt-12">Ownership, card account, and provisioning are re-read from the finalized chain when the intent is prepared and again after it is signed. A change in ownership invalidates the pending intent.</p>
        </div>
      </div>
      <div class="page-section">
        <div class="page-section__head"><div><h2>Card assets</h2><p>Supported NEP-141 balances for the selected card.</p></div><a class="text-link" href="#/cards/${encodeURIComponent(selected)}">Open card</a></div>
        ${assets.length ? `<div class="plan-box"><div class="kv">
          ${assets.map((asset) => `<div>${esc(asset.symbol)}</div><div>${esc(asset.contractId)} · ${asset.registered ? `${esc(formatTokenAmount(asset.balance, asset.decimals))} ${esc(asset.symbol)}` : tag('NOT REGISTERED', 'warning')}</div>`).join('')}
        </div></div>` : `<div class="panel panel-pad"><p class="muted small">Reading assets…</p></div>`}
      </div>
    </div>`;
  }

  async function spendMount() {
    if (!isAuthed()) return;
    const key = `spend:${sessionAccount()}`;
    if (state.spendKey === key && state.spend.assets) return;
    if (!state.owned) await loadOwned(true);
    const tokenId = state.spend.tokenId || (state.owned || []).find((card) => card.binding?.isVerified)?.token.id;
    state.spend.tokenId = tokenId;
    if (tokenId) {
      try { state.spend.assets = await loadAssets(tokenId, true); } catch { state.spend.assets = []; }
    } else {
      state.spend.assets = [];
    }
    state.spendKey = key;
    render();
  }

  /* ------------------------------------------------------------ stocks page -- */

  function stocksPage() {
    if (!isAuthed()) {
      return `<div class="wrap page-top">${pageHead({ kicker: 'Demo assets', title: 'Test stocks & commodities', lede: 'Sign in to claim free demo tokens into a card account.' })}${gateMarkup({ title: 'Sign in to claim test stock', text: 'Claims go into a card account you own. Sign in with Google or connect a wallet.', returnTo: '/#/stocks' })}</div>`;
    }
    const stocks = state.stocks;
    if (!stocks) {
      return `<div class="wrap page-top">${pageHead({ kicker: 'Demo assets', title: 'Test stocks & commodities', lede: 'Reading the RELAY demo token registry.' })}<div class="panel panel-pad"><p class="muted small">Reading demo tokens…</p></div></div>`;
    }
    const cards = (state.owned || []).filter((card) => card.binding?.isVerified);
    const selected = state.stocksCardId || cards[0]?.token.id || '';
    const selectedCard = cards.find((card) => card.token.id === selected) || null;
    const assets = selected ? (state.assets[selected] || []) : [];
    return `<div class="wrap page-top">
      ${pageHead({ kicker: 'Demo assets', title: 'Test stocks & commodities', lede: 'Claim 100 free shares of each demo token into a card account, then send them from the card like any NEP-141 asset. Testnet only, no real-world value.' })}
      ${!cards.length ? notice('warning', 'Provision a card first', 'Claims go into a card account. Create a card and provision it, then come back. <a href="#/create">Create a card</a>') : ''}
      <div class="split-grid">
        <div class="panel panel-pad">
          <div class="panel-head panel-head--tight"><h3 class="h-xs">Claim into a card</h3>${tag(`${stocks.length} DEMO TOKENS`, 'neutral')}</div>
          ${cards.length ? `<div class="field">
            <label for="stocks-card">Card</label>
            <select class="select" id="stocks-card" data-change="stocks-card">
              ${cards.map((card) => `<option value="${esc(card.token.id)}" ${card.token.id === selected ? 'selected' : ''}>${esc(card.token.metadata?.title || card.token.id)} · ${esc(card.token.id)}</option>`).join('')}
            </select>
          </div>` : ''}
          <div class="stack-sm mt-16">
            ${stocks.map((stock) => {
              const asset = assets.find((entry) => entry.contractId === stock.contractId);
              const remaining = asset?.claimRemaining ?? stock.claimCap;
              const balance = asset?.registered ? formatTokenAmount(asset.balance, stock.decimals) : null;
              const canClaim = Boolean(selected && BigInt(remaining) > 0n);
              return `<div class="panel panel-pad" style="box-shadow:none;border:1px solid var(--line)">
                <div class="row-between">
                  <div><strong>${esc(stock.symbol)}</strong> <span class="faint small">${esc(stock.name)}</span></div>
                  ${asset?.registered ? tag(`${esc(balance)} ${esc(stock.symbol)}`, 'success') : tag('NOT IN CARD', 'neutral')}
                </div>
                <p class="muted small mt-8">Claim ${esc(formatTokenAmount(stock.claimAmount, stock.decimals))} ${esc(stock.symbol)} per click · ${esc(formatTokenAmount(remaining, stock.decimals))} ${esc(stock.symbol)} left for this card</p>
                <button type="button" class="btn btn-sm btn-primary" data-act="claim-stock" data-id="${esc(selected)}" data-ft="${esc(stock.contractId)}" ${canClaim ? '' : 'disabled'}>${icon('fund')} Claim ${esc(stock.symbol)}</button>
              </div>`;
            }).join('')}
          </div>
        </div>
        <div class="stack">
          ${notice('info', 'How the demo works', 'The treasury holds the supply and pays the token storage. A claim sends 100 shares into the selected card account. Then open the card or the Spend page to send them to any NEAR Testnet account.')}
          ${notice('warning', 'Not real assets', 'AAPL, TSLA, GOLD, and OIL here are test tokens with on-chain metadata only. They are not securities, not redeemable, and not connected to any real market.')}
          ${selectedCard ? `<div class="panel panel-pad"><p class="kicker">Selected card</p><h3 class="mb-8">${esc(selectedCard.token.metadata?.title || selectedCard.token.id)}</h3><p class="muted small mono">${esc(selectedCard.associatedAccount?.accountId || `${selectedCard.token.id}.${state.config?.near?.relayContractId || ''}`)}</p><a class="text-link mt-12" href="#/cards/${encodeURIComponent(selectedCard.token.id)}">Open card</a></div>` : ''}
        </div>
      </div>
    </div>`;
  }

  async function stocksMount() {
    if (!isAuthed()) return;
    let changed = false;
    if (!state.stocks) {
      try {
        const result = await api('/api/near/ft/stocks');
        state.stocks = result?.assets || [];
      } catch {
        state.stocks = [];
      }
      changed = true;
    }
    if (!state.owned) {
      await loadOwned(true);
      changed = true;
    }
    const cards = (state.owned || []).filter((card) => card.binding?.isVerified);
    const selected = state.stocksCardId || cards[0]?.token.id || null;
    if (selected !== state.stocksCardId) {
      state.stocksCardId = selected;
      changed = true;
    }
    if (selected && !state.assets[selected]) {
      try { await loadAssets(selected, true); } catch { state.assets[selected] = []; }
      changed = true;
    }
    if (changed) render();
  }

  /* ----------------------------------------------------------- activity page -- */

  function activityPage() {
    const events = state.activity;
    return `<div class="wrap page-top">
      ${pageHead({
        kicker: 'Evidence',
        title: 'Activity',
        lede: 'Only local/server journals and recorded Testnet evidence. No synthetic history.',
        actions: `<button type="button" class="btn btn-outline" data-act="reload-activity">${icon('refresh')} Reload</button>`,
      })}
      ${events === null ? `<div class="panel panel-pad"><p class="muted small">Reading journals…</p></div>`
        : events.length ? `<div class="activity-list">
          ${events.map((event) => `<div class="activity-row">
            <span class="activity-icon">${icon(event.type?.includes('spend') || event.type?.includes('fund') ? 'spend' : event.type?.includes('claim') ? 'mail' : 'check')}</span>
            <div class="activity-body">
              <strong>${esc(String(event.type || 'event').replace(/[._]/g, ' '))}</strong>
              <p>${esc(event.note || event.tokenId || event.source || 'Recorded event')}</p>
              <div class="activity-meta">
                <span>${esc(event.source || 'journal')}</span>
                ${event.tokenId ? `<span>token ${esc(event.tokenId)}</span>` : ''}
                ${event.transactionHash ? `<a href="${esc(explorerTx(event.transactionHash))}" target="_blank" rel="noreferrer">${esc(shortId(event.transactionHash, 10, 6))}</a>` : ''}
              </div>
            </div>
            <div class="activity-side"><time>${esc(timeAgo(event.timestamp))}</time>${event.status ? tag(event.status, event.status === 'FINAL' || event.status === 'SUCCESS' ? 'success' : 'neutral') : ''}</div>
          </div>`).join('')}
        </div>` : emptyState({ title: 'No recorded activity', text: 'Actions you take through RELAY will appear here after the server journal records them.', iconName: 'activity' })}
    </div>`;
  }

  async function activityMount() {
    if (state.activity === null) {
      await loadActivity(true);
      render();
    }
  }

  /* ----------------------------------------------------------- settings page -- */

  function settingsPage() {
    const account = sessionAccount();
    const contract = state.config?.near?.relayContractId || 'not loaded';
    const googleConnected = Boolean(state.session?.authenticated && googleAccount());
    const walletConnected = isWalletAuthed();
    return `<div class="wrap page-top">
      ${pageHead({ kicker: 'Settings', title: 'Identity and session', lede: 'Exactly what RELAY knows about each authentication mode.' })}
      <div class="split-grid split-grid--even">
        <div class="stack">
          <div class="panel panel-pad">
            <p class="kicker">Google identity</p>
            ${googleConnected ? `
              <h3 class="mb-8">${esc(state.session.user?.name || 'Google account')}</h3>
              <p class="muted small">${esc(state.session.user?.email || '')} · verified</p>
              <div class="plan-box mt-16"><div class="kv">
                <div>NEAR account</div><div class="mono">${esc(googleAccount())}</div>
                <div>Public key</div><div class="mono break">${esc(state.session.near?.publicKey || '—')}</div>
                <div>Balance</div><div>${esc(state.session.near?.balanceNear || '0')} NEAR</div>
                <div>Session expires</div><div>${esc(fmtDate(state.session.expiresAt))}</div>
              </div></div>
              <div class="form-actions">
                <a class="btn btn-outline" href="${esc(explorerAccount(googleAccount()))}" target="_blank" rel="noreferrer">${icon('external')} View account</a>
                <button type="button" class="btn btn-danger" data-act="sign-out">${icon('logout')} Sign out Google</button>
              </div>
            ` : `<h3 class="mb-8">Not connected</h3><p class="muted small">Continue with Google to create or restore your sponsored NEAR account. This mode signs with an MPC key derived for your verified Google identity.</p><div class="form-actions"><button type="button" class="btn btn-primary" data-act="sign-in">${icon('google')} Continue with Google</button></div>`}
          </div>
          <div class="panel panel-pad">
            <p class="kicker">NEAR wallet</p>
            ${walletConnected ? `
              <h3 class="mb-8">${esc(walletAccount())}</h3>
              <p class="muted small">NEP-413 signature verified against a FullAccess Testnet key.</p>
              <div class="plan-box mt-16"><div class="kv">
                <div>Account</div><div class="mono">${esc(walletAccount())}</div>
                <div>Public key</div><div class="mono break">${esc(state.wallet.publicKey || '—')}</div>
                <div>Wallet</div><div>${esc(state.wallet.providerId || 'Wallet Selector')}</div>
                <div>Session expires</div><div>${esc(fmtDate(state.wallet.session?.expiresAt))}</div>
              </div></div>
              <div class="form-actions">
                <a class="btn btn-outline" href="${esc(explorerAccount(walletAccount()))}" target="_blank" rel="noreferrer">${icon('external')} View account</a>
                <button type="button" class="btn btn-danger" data-act="disconnect-wallet">${icon('logout')} Disconnect wallet</button>
              </div>
            ` : `<h3 class="mb-8">Not connected</h3><p class="muted small">Connect Meteor Wallet, MyNearWallet, or a compatible injected wallet. RELAY opens the real Wallet Selector modal and requires a signed NEP-413 challenge before marking the session connected.</p>
              <div class="form-actions"><button type="button" class="btn btn-outline" data-act="connect-wallet" ${state.wallet.connecting ? 'disabled' : ''}>${icon('key')} Connect NEAR Wallet</button></div>
              ${state.wallet.error ? notice('warning', 'Wallet connection', esc(state.wallet.error)) : ''}`}
          </div>
          <div class="panel panel-pad">
            <p class="kicker">Linked accounts</p>
            ${googleConnected ? `
              <h3 class="mb-8">Bind a wallet to this Google identity</h3>
              <p class="muted small">When both Google and a NEAR wallet are connected in this browser, RELAY binds them automatically after the wallet signs a NEP-413 message. A bound wallet counts as yours for NFT ownership, so wallet-owned cards work without switching accounts. The wallet still signs its own transactions; the Google MPC key never signs for it.</p>
              ${state.links.length ? `<div class="plan-box mt-16"><div class="kv">
                ${state.links.map((entry) => `
                  <div class="mono">${esc(entry.accountId)}</div>
                  <div class="mono break">${esc(entry.publicKey || '—')}
                    <button type="button" class="btn btn-sm btn-outline" data-act="unlink-wallet" data-account="${esc(entry.accountId)}">Unlink</button>
                  </div>`).join('')}
              </div></div>` : '<p class="muted small mt-12">No wallet is linked yet.</p>'}
              <div class="form-actions">
                ${walletConnected
                  ? `<button type="button" class="btn btn-primary" data-act="link-wallet">${icon('link')} Link ${esc(walletAccount())}</button>`
                  : `<button type="button" class="btn btn-outline" data-act="connect-wallet" ${state.wallet.connecting ? 'disabled' : ''}>${icon('key')} Connect a wallet to link</button>`}
              </div>
              ${state.links.length ? notice('info', 'How approval works', 'For a wallet-owned card, the claim transfer is signed by that wallet. Reconnect it if the wallet session expired.') : ''}
            ` : `<h3 class="mb-8">Google account required</h3><p class="muted small">Sign in with Google first. Linking proves that a NEAR wallet belongs to the same person, and it is only stored after a NEP-413 wallet signature.</p>`}
          </div>
          <div class="panel panel-pad">
            <p class="kicker">Appearance</p>
            <h3 class="mb-8">Theme</h3>
            <div class="btn-row">
              <button type="button" class="btn ${state.theme === 'light' ? 'btn-primary' : 'btn-outline'}" data-act="theme" data-theme="light">${icon('sun')} Light</button>
              <button type="button" class="btn ${state.theme === 'dark' ? 'btn-primary' : 'btn-outline'}" data-act="theme" data-theme="dark">${icon('moon')} Dark</button>
              <button type="button" class="btn ${state.theme === 'system' ? 'btn-primary' : 'btn-outline'}" data-act="theme" data-theme="system">${icon('monitor')} System</button>
            </div>
          </div>
        </div>
        <div class="stack">
          <div class="panel panel-pad">
            <p class="kicker">Network</p>
            <div class="kv">
              <div>Network</div><div>NEAR Testnet</div>
              <div>Contract</div><div class="mono">${esc(contract)}</div>
              <div>Google signing</div><div>NEAR Auth → MPC ed25519</div>
              <div>Wallet signing</div><div>Wallet Selector → NEP-413 / direct transaction</div>
              <div>Gas</div><div>Google mode sponsored by RELAY; wallet mode pays its own gas</div>
              <div>Active account</div><div class="mono">${esc(account || '—')}</div>
            </div>
          </div>
          ${notice('info', 'Security model', 'RELAY never stores your Google password or an unencrypted identity token. Google and wallet sessions are separate cookies; a wallet is linked only after it signs a NEP-413 message, and the wallet still signs its own transactions. The sponsor cannot sign your transactions.')}
          ${notice('warning', 'Testnet only', 'This product is not connected to NEAR Mainnet or any other chain. Testnet assets have no monetary value.')}
        </div>
      </div>
    </div>`;
  }

  /* ---------------------------------------------------------------- claim -- */

  function claimPage() {
    const claim = state.claimDetail;
    const card = state.claimCard;
    if (!claim) {
      return `<section class="section"><div class="wrap-narrow center">
        <p class="kicker">Claim</p>
        <h1 class="mt-8">Reading the claim…</h1>
        <p class="lede mt-16 mx-auto">The claim record is fetched from the RELAY server. No ownership is inferred from the link.</p>
      </div></section>`;
    }
    const owner = card?.token?.ownerId;
    const iAmOwner = Boolean(isAuthed() && ownsAccount(owner));
    const signedEmail = state.session?.authenticated ? (state.session.user?.email || null) : null;
    const emailMatches = !signedEmail || !claim.emailMasked || maskEmailClient(signedEmail) === claim.emailMasked;
    const tone = claim.status === 'claimed' ? 'success' : claim.status === 'ready' ? 'warning' : claim.status === 'open' ? 'neutral' : 'danger';
    let action = '';
    if (claim.status === 'open') {
      if (!isAuthed()) {
        action = `<a class="btn btn-primary btn-lg" href="#/signin?returnTo=${encodeURIComponent(`/claim/near/${claim.id}`)}">${icon('google')} Sign in to verify this claim</a>`;
      } else if (!emailMatches) {
        action = `${notice('warning', 'Wrong Google account', `You are signed in as <code>${esc(signedEmail)}</code>, but this claim is for <code>${esc(claim.emailMasked)}</code>. Sign out and sign in with the exact email the claim was created for.`)}
          <p class="form-note mt-12">The claim email cannot be changed. The owner can cancel this claim and create a new one for another address.</p>`;
      } else {
        action = `<button type="button" class="btn btn-primary btn-lg" data-act="verify-claim" data-id="${esc(claim.id)}">${icon('shield')} Verify with my Google email</button>
           <p class="form-note mt-12">Signed in as <code>${esc(signedEmail || '')}</code>. The claim is for <code>${esc(claim.emailMasked)}</code>.</p>`;
      }
    } else if (claim.status === 'ready' && iAmOwner) {
      action = `<button type="button" class="btn btn-primary btn-lg" data-act="approve-claim" data-id="${esc(claim.id)}">${icon('send')} Approve on-chain transfer</button>
        <p class="form-note mt-12">The recipient verified the email. Approving signs the real <code>nft_transfer</code>.</p>`;
    } else if (claim.status === 'ready') {
      const ownerHint = owner ? `<p class="mt-8 small">This card is owned by <code>${esc(owner)}</code>. If that is your external NEAR wallet, connect or bind it in <a class="text-link" href="#/settings">Settings → Linked accounts</a> to approve this transfer.</p>` : '';
      action = `${notice('info', 'Verified. Waiting for the owner.', `The recipient email is verified. The card owner must approve the transfer from their account.${ownerHint}`)}`;
    } else if (claim.status === 'claimed') {
      action = claim.transactionHash
        ? notice('success', 'Claim complete', `The transfer was finalized on NEAR Testnet. <a class="text-link" href="${esc(explorerTx(claim.transactionHash))}" target="_blank" rel="noreferrer">View transaction</a>`)
        : notice('success', 'Claim complete', 'The transfer was recorded as complete.');
    } else {
      action = notice('danger', 'Claim unavailable', `This claim is ${esc(claim.status)}. Ask the owner to create a new one.`);
    }
    return `<section class="section">
      <div class="wrap">
        <div class="split-grid split-grid--even">
          <div>
            ${card ? cardMarkup(card, { href: `#/cards/${encodeURIComponent(card.token.id)}` }) : cardSkeleton()}
          </div>
          <div class="panel panel-pad">
            <p class="kicker">Email-bound claim</p>
            <div class="panel-head panel-head--tight"><h1 class="h-sm">Card ${esc(claim.tokenId)}</h1>${tag(String(claim.status).toUpperCase(), tone)}</div>
            <p class="muted small mt-12">This claim is bound to <code>${esc(claim.emailMasked)}</code>. The recipient must sign in with that verified Google email. The owner still approves the final transfer.</p>
            <div class="plan-box mt-16"><div class="kv">
              <div>Card</div><div class="mono">${esc(claim.tokenId)}</div>
              <div>Contract</div><div class="mono">${esc(claim.contractId)}</div>
              <div>Owner</div><div class="mono">${esc(owner || '—')}</div>
              <div>Created</div><div>${esc(fmtDate(claim.createdAt))}</div>
              <div>Expires</div><div>${esc(fmtDate(claim.expiresAt))}</div>
            </div></div>
            <div class="form-actions">${action}</div>
            ${iAmOwner && (claim.status === 'open' || claim.status === 'ready') ? `<div class="form-actions"><button type="button" class="btn btn-danger btn-sm" data-act="cancel-claim" data-id="${esc(claim.id)}">${icon('trash')} Cancel claim</button></div>` : ''}
            <div class="invite-row__link mt-16"><input class="input mono" readonly value="${esc(`${location.origin}${location.pathname}#/claim/near/${claim.id}`)}"><button type="button" class="btn btn-sm btn-outline" data-act="copy" data-copy="${esc(`${location.origin}${location.pathname}#/claim/near/${claim.id}`)}">${icon('copy')} Copy</button></div>
          </div>
        </div>
      </div>
    </section>`;
  }

  async function claimMount() {
    const id = state.page.params.id;
    if (!/^[a-f0-9]{32}$/.test(id || '')) {
      state.claimDetail = { id: 'invalid', tokenId: 'invalid', status: 'expired', contractId: '', createdAt: 0, expiresAt: 0 };
      render();
      return;
    }
    const key = `claim:${id}`;
    if (state.claimKey === key && state.claimDetail) return;
    try {
      const [claimResult, card] = await Promise.all([
        api(`/api/near/claims/${id}`),
        (async () => {
          const detail = await api(`/api/near/claims/${id}`);
          return detail?.claim?.tokenId ? loadCard(detail.claim.tokenId, true).catch(() => null) : null;
        })(),
      ]);
      state.claimDetail = claimResult.claim;
      state.claimCard = card;
      state.claimKey = key;
    } catch (error) {
      state.claimDetail = { id, tokenId: 'unavailable', status: 'expired', contractId: '', createdAt: 0, expiresAt: 0, error: error.message };
    }
    render();
  }
  /* --------------------------------------------------------------- routing -- */

  function parseRoute() {
    let value = location.hash.replace(/^#/, '');
    if (!value) value = '/';
    if (!value.startsWith('/')) value = `/${value}`;
    const query = new URLSearchParams();
    const queryIndex = value.indexOf('?');
    if (queryIndex >= 0) {
      new URLSearchParams(value.slice(queryIndex + 1)).forEach((v, k) => query.set(k, v));
      value = value.slice(0, queryIndex);
    }
    const parts = value.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const params = {};
    if (parts[0] === 'cards' && parts[1]) return { path: '/cards/detail', query, params: { id: parts.slice(1).join('/') } };
    if (parts[0] === 'claim' && parts[1] === 'near' && parts[2]) return { path: '/claim/near', query, params: { id: parts[2] } };
    return { path: `/${parts[0] || ''}`, query, params };
  }

  const PAGES = {
    '/': { name: 'home', public: true, render: homePage, mount: homeMount, title: 'Home' },
    '/how': { name: 'how', public: true, render: howPage, title: 'How it works' },
    '/signin': { name: 'signin', public: true, render: signinPage, title: 'Sign in' },
    '/claim/near': { name: 'claim', public: true, render: claimPage, mount: claimMount, title: 'Claim' },
    '/overview': { name: 'overview', render: overviewPage, mount: overviewMount, title: 'Overview', crumb: 'Workspace' },
    '/cards': { name: 'cards', render: cardsPage, mount: cardsMount, title: 'Cards', crumb: 'Workspace' },
    '/cards/detail': { name: 'card-detail', render: cardDetailPage, mount: cardDetailMount, title: 'Card', crumb: 'Cards' },
    '/create': { name: 'create', render: createPage, title: 'Create card', crumb: 'Creator studio' },
    '/fund': { name: 'fund', render: fundPage, mount: fundMount, title: 'Add funds', crumb: 'Workspace' },
    '/send': { name: 'send', render: sendPage, mount: sendMount, title: 'Send', crumb: 'Workspace' },
    '/spend': { name: 'spend', render: spendPage, mount: spendMount, title: 'Spend', crumb: 'Workspace' },
    '/stocks': { name: 'stocks', render: stocksPage, mount: stocksMount, title: 'Test stocks', crumb: 'Demo assets' },
    '/activity': { name: 'activity', render: activityPage, mount: activityMount, title: 'Activity', crumb: 'Workspace' },
    '/settings': { name: 'settings', render: settingsPage, title: 'Settings', crumb: 'Workspace' },
  };

  function resolvePage(route) {
    return PAGES[route.path] || {
      name: 'notfound',
      public: true,
      render: notFoundPage,
      title: 'Not found',
    };
  }

  function notFoundPage() {
    return `<section class="section"><div class="wrap-narrow center">
      <p class="kicker">404</p>
      <h1 class="mt-8">This page does not exist.</h1>
      <p class="lede mt-16 mx-auto">The route was not found. Nothing was fabricated to fill the space.</p>
      <div class="btn-row mt-24 center-x"><a class="btn btn-primary" href="#/">Go home</a><a class="btn btn-outline" href="#/overview">Open workspace</a></div>
    </div></section>`;
  }

  function render() {
    const route = parseRoute();
    const page = resolvePage(route);
    const nextKey = `${route.path}|${route.params.id || ''}|${route.query.toString()}`;
    const routeChanged = state.renderKey !== nextKey;
    state.renderKey = nextKey;
    state.page = route;
    const content = page.render(route);
    app.innerHTML = page.public
      ? publicShell(page.nav || (route.path === '/' ? 'home' : route.path === '/how' ? 'how' : ''), content)
      : appShell(content, page.title || 'RELAY', page.crumb || 'Workspace');
    if (routeChanged) {
      try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); } catch { window.scrollTo(0, 0); }
    }
    if (typeof page.mount === 'function') {
      Promise.resolve(page.mount(route)).catch((error) => {
        toast('Page could not finish loading', error.message, 'error', 9000);
      });
    }
  }
  /* --------------------------------------------------------------- actions -- */

  function reloadClaim(id) {
    state.claimKey = null;
    state.claimDetail = null;
    state.claimCard = null;
    render();
  }

  async function verifyClaim(id, button) {
    busy(button, true);
    try {
      const result = await api(`/api/near/claims/${encodeURIComponent(id)}/verify`, { method: 'POST' });
      toast('Email verified', result.claim?.status === 'ready' ? 'The owner can now approve the transfer.' : 'Claim updated.', 'success', 7000);
      state.claims = null;
      reloadClaim(id);
    } catch (error) {
      toast('Claim not verified', error.message, 'error', 9000);
    } finally {
      busy(button, false);
    }
  }

  async function approveClaim(id, button) {
    if (!isAuthed()) {
      toast('Sign in required', 'Only the claim owner can approve the transfer.', 'warning');
      return;
    }
    busy(button, true);
    let prepared;
    try {
      prepared = await api(`/api/near/claims/${encodeURIComponent(id)}/prepare`, { method: 'POST' });
    } catch (error) {
      busy(button, false);
      toast('Claim approval failed', error.message, 'error', 11000);
      return;
    }
    if (prepared?.mode === 'wallet') {
      // The NFT is owned by the linked wallet. The wallet must sign the exact
      // nft_transfer; the Google MPC key cannot sign for a wallet account.
      busy(button, false);
      const sent = await runWalletAction('transfer', {
        tokenId: prepared.tokenId,
        receiverId: prepared.receiverId,
      }, { button });
      if (!sent?.transactionHash) return;
      try {
        const completed = await api(`/api/near/claims/${encodeURIComponent(id)}/complete`, {
          method: 'POST',
          body: { transactionHash: sent.transactionHash },
        });
        state.receipt = completed;
        state.claims = null;
        state.cardsLoaded = false;
        state.overviewKey = null;
        toast('Claim approved and finalized', shortId(completed.transactionHash, 12, 8), 'success', 9000);
        reloadClaim(id);
      } catch (error) {
        toast('Claim completion failed', error.message, 'error', 11000);
      }
      return;
    }
    try {
      await ensureLiveIdentity();
      const result = await submitPrepared(prepared);
      state.receipt = result;
      state.claims = null;
      state.cardsLoaded = false;
      state.overviewKey = null;
      toast('Claim approved and finalized', shortId(result.transactionHash, 12, 8), 'success', 9000);
      reloadClaim(id);
    } catch (error) {
      toast('Claim approval failed', error.message, 'error', 11000);
    } finally {
      busy(button, false);
    }
  }

  async function cancelClaim(id, button) {
    const confirmed = await dialog({
      title: 'Cancel this claim?',
      body: '<p>The recipient will no longer be able to verify or claim this card. The card itself is unchanged.</p>',
      confirmLabel: 'Cancel claim',
      dangerous: true,
    });
    if (!confirmed) return;
    busy(button, true);
    try {
      await api(`/api/near/claims/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      toast('Claim cancelled', '', 'info');
      state.claims = null;
      reloadClaim(id);
    } catch (error) {
      toast('Could not cancel claim', error.message, 'error');
    } finally {
      busy(button, false);
    }
  }

  function suggestToken() {
    const name = document.getElementById('create-name');
    const token = document.getElementById('create-token');
    if (name && token) {
      token.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
      token.dataset.touched = '1';
    }
  }

  const ART_MAX_BYTES = 10 * 1024 * 1024;
  const ART_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

  function releaseArtworkPreview() {
    if (state.create.objectUrl) {
      try { URL.revokeObjectURL(state.create.objectUrl); } catch { /* already revoked */ }
    }
    state.create.objectUrl = null;
  }

  function clearArtwork() {
    releaseArtworkPreview();
    state.create.imageUrl = null;
    state.create.uploadError = null;
    state.create.uploading = false;
    state.create.progress = 0;
    state.create.fileName = null;
    state.create.file = null;
    state.create.bytes = 0;
    render();
  }

  function selectArtwork(file) {
    if (!file) return;
    if (!ART_TYPES.has(String(file.type || '').toLowerCase())) {
      state.create.uploadError = 'Choose a JPEG, PNG, or WebP image. SVG and other file types are rejected.';
      state.create.file = null;
      render();
      return;
    }
    if (file.size > ART_MAX_BYTES) {
      state.create.uploadError = 'Artwork must be 10 MB or smaller.';
      state.create.file = null;
      render();
      return;
    }
    releaseArtworkPreview();
    state.create.file = file;
    state.create.fileName = file.name || 'artwork';
    state.create.bytes = file.size;
    state.create.imageUrl = null;
    state.create.uploadError = null;
    state.create.objectUrl = URL.createObjectURL(file);
    uploadArtwork(file);
  }

  /**
   * Uploads the raw image bytes with progress. The server — not the browser —
   * validates the MIME type, the file signature, and the encoded structure.
   */
  function uploadArtwork(file) {
    state.create.uploading = true;
    state.create.uploadError = null;
    state.create.progress = 0;
    render();

    const xhr = new XMLHttpRequest();
    const account = sessionAccount();
    const uploadUrl = account ? `/api/uploads?accountId=${encodeURIComponent(account)}` : '/api/uploads';
    xhr.open('POST', uploadUrl);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('accept', 'application/json');
    if (account) xhr.setRequestHeader('x-near-account-id', account);

    const showProgress = (percent) => {
      state.create.progress = percent;
      const bar = document.getElementById('upload-progress-bar');
      const label = document.getElementById('upload-progress-label');
      if (bar) bar.style.width = `${percent}%`;
      if (label) label.textContent = `Uploading ${state.create.fileName || 'artwork'}… ${Math.round(percent)}%`;
    };

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        showProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    });

    const fail = (message) => {
      state.create.uploading = false;
      state.create.uploadError = message || 'The upload did not complete. Check your connection and retry.';
      render();
    };

    xhr.addEventListener('load', () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText || '{}'); } catch { body = null; }
      if (xhr.status >= 200 && xhr.status < 300 && body?.url) {
        state.create.uploading = false;
        state.create.progress = 100;
        state.create.imageUrl = body.url;
        state.create.uploadError = null;
        releaseArtworkPreview();
        toast('Artwork stored', body.storage === 'local' ? 'Stored locally for this Testnet build.' : 'Stored with the configured provider.', 'success', 4000);
        render();
        return;
      }
      const message = body?.error || (xhr.status === 413 ? 'Artwork must be 10 MB or smaller.' : `Upload failed (HTTP ${xhr.status}).`);
      fail(message);
    });
    xhr.addEventListener('error', () => fail('The network connection dropped during upload. Retry when you are back online.'));
    xhr.addEventListener('timeout', () => fail('The upload timed out. Retry the upload.'));
    xhr.addEventListener('abort', () => fail('The upload was cancelled.'));
    xhr.send(file);
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-act]');
    if (!target) return;
    const action = target.dataset.act;
    switch (action) {
      case 'theme':
        setTheme(target.dataset.theme || 'system');
        break;
      case 'sign-in':
        startSignIn(target).catch((error) => toast('Sign-in failed', error.message, 'error'));
        break;
      case 'sign-out':
        signOut(target);
        break;
      case 'connect-wallet':
        connectWallet(target);
        break;
      case 'disconnect-wallet':
        disconnectWallet(target);
        break;
      case 'link-wallet':
        linkWallet(target);
        break;
      case 'unlink-wallet':
        unlinkWallet(target.dataset.account, target);
        break;
      case 'go-settings':
        location.hash = '#/settings';
        break;
      case 'open-drawer': {
        const drawer = document.getElementById('mobile-drawer');
        if (drawer) drawer.hidden = false;
        break;
      }
      case 'close-drawer': {
        const drawer = document.getElementById('mobile-drawer');
        if (drawer) drawer.hidden = true;
        break;
      }
      case 'copy':
        copyText(target.dataset.copy, 'Copied');
        break;
      case 'dismiss-receipt':
        state.receipt = null;
        render();
        break;
      case 'suggest-token':
        suggestToken();
        break;
      case 'clear-art':
        clearArtwork();
        break;
      case 'retry-art':
        if (state.create.file) uploadArtwork(state.create.file);
        break;
      case 'provision':
        runAction('provision', { tokenId: target.dataset.id }, {
          button: target,
          confirm: {
            title: 'Provision this card account?',
            body: '<p>RELAY will top up your sponsored account with the 1.95 NEAR deposit, then your key creates and verifies the card account. The deposit becomes the card balance.</p>',
            confirmLabel: 'Provision',
          },
        });
        break;
      case 'register-ft':
        runAction('ft_register', { tokenId: target.dataset.id, ftContractId: target.dataset.ft }, { button: target });
        break;
      case 'claim-stock':
        claimStock(target.dataset.id, target.dataset.ft, target);
        break;
      case 'verify-claim':
        verifyClaim(target.dataset.id, target);
        break;
      case 'approve-claim':
        approveClaim(target.dataset.id, target);
        break;
      case 'cancel-claim':
        cancelClaim(target.dataset.id, target);
        break;
      case 'reload-activity':
        state.activity = null;
        loadActivity(true).then(() => render());
        break;
      default:
        break;
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.matches('[data-role="create-token"]')) event.target.dataset.touched = '1';
    if (event.target.matches('[data-role="create-name"]')) {
      const token = document.querySelector('[data-role="create-token"]');
      if (token && !token.dataset.touched) {
        token.value = event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
      }
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-role="art-file"]')) {
      const file = event.target.files?.[0];
      event.target.value = '';
      selectArtwork(file);
    }
    if (event.target.matches('[data-change="spend-card"]')) {
      const tokenId = event.target.value;
      state.spend.tokenId = tokenId;
      state.spendKey = null;
      state.spend.assets = null;
      render();
    }
    if (event.target.matches('[data-change="stocks-card"]')) {
      const tokenId = event.target.value;
      state.stocksCardId = tokenId;
      delete state.assets[tokenId];
      render();
    }
  });

  function artDropTarget(event) {
    return event.target?.closest?.('[data-role="art-drop"]') || null;
  }

  for (const name of ['dragenter', 'dragover']) {
    document.addEventListener(name, (event) => {
      const target = artDropTarget(event);
      if (!target) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      target.classList.add('is-dragover');
    });
  }

  for (const name of ['dragleave', 'dragend']) {
    document.addEventListener(name, (event) => {
      const target = artDropTarget(event);
      if (target) target.classList.remove('is-dragover');
    });
  }

  document.addEventListener('drop', (event) => {
    const target = artDropTarget(event);
    if (!target) return;
    event.preventDefault();
    target.classList.remove('is-dragover');
    const file = event.dataTransfer?.files?.[0];
    if (file) selectArtwork(file);
  });

  document.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    if (typeof form.reportValidity === 'function' && !form.reportValidity()) return;
    const kind = form.dataset.form;
    const fields = Object.fromEntries(new FormData(form).entries());
    const button = form.querySelector('button[type="submit"]');
    const tokenId = (fields.tokenId || form.dataset.id || '').trim().toLowerCase();

    if (kind === 'create') {
      const name = String(fields.name || '').trim();
      const token = String(fields.tokenId || '').trim().toLowerCase();
      if (!name) return toast('Card name required', 'Enter a name for the card.', 'warning');
      if (!TOKEN_RE.test(token)) return toast('Invalid token ID', 'Use 1–32 lowercase letters, numbers, hyphens, or underscores.', 'warning');
      if (token.startsWith('u-')) return toast('Reserved token ID', 'Token IDs beginning with u- belong to RELAY user accounts.', 'warning');
      runAction('mint', {
        tokenId: token,
        name,
        description: String(fields.description || '').trim(),
        imageUrl: state.create.imageUrl || '',
        initialCredits: Number(fields.initialCredits || 0),
      }, {
        button,
        after: async () => {
          state.create.imageUrl = null;
          location.hash = `#/cards/${encodeURIComponent(token)}`;
        },
      });
      return;
    }

    if (kind === 'fund') {
      runAction('fund', { tokenId, amountNear: String(fields.amountNear || '').trim() }, { button });
      return;
    }

    if (kind === 'spend') {
      const receiverId = String(fields.receiverId || '').trim();
      const amountNear = String(fields.amountNear || '').trim();
      runAction('spend', { tokenId, receiverId, amountNear }, {
        button,
        confirm: {
          title: 'Send NEAR from the card account?',
          body: `<p><strong>${esc(amountNear)} NEAR</strong> leaves the card account for <code>${esc(receiverId)}</code>.</p><p class="small muted">The NFT owner stays the same. The card account is the asset source. The transaction is prepared server-side and verified against finalized chain state.</p>`,
          confirmLabel: 'Sign and send',
          dangerous: true,
        },
      });
      return;
    }

    if (kind === 'ft-spend') {
      const receiverId = String(fields.receiverId || '').trim();
      const amount = String(fields.amount || '').trim();
      runAction('ft_spend', {
        tokenId,
        ftContractId: String(fields.ftContractId || '').trim(),
        receiverId,
        amount,
      }, {
        button,
        confirm: {
          title: 'Spend this NEP-141 asset?',
          body: `<p><strong>${esc(amount)} base units</strong> move from the card account to <code>${esc(receiverId)}</code>.</p><p class="small muted">The exact token contract, amount, and receiver are bound to the prepared intent.</p>`,
          confirmLabel: 'Sign and send',
          dangerous: true,
        },
      });
      return;
    }

    if (kind === 'transfer') {
      runAction('transfer', {
        tokenId,
        receiverId: String(fields.receiverId || '').trim(),
      }, {
        button,
        confirm: {
          title: 'Transfer this card?',
          body: `<p>The NFT and its card account move to <code>${esc(String(fields.receiverId || '').trim())}</code> immediately. This cannot be undone.</p>`,
          confirmLabel: 'Transfer card',
          dangerous: true,
        },
      });
      return;
    }

    if (kind === 'claim-create') {
      busy(button, true);
      api('/api/near/claims', {
        method: 'POST',
        body: { tokenId, email: String(fields.email || '').trim() },
      }).then((result) => {
        state.claims = null;
        toast('Claim link created', 'Share the link directly. The recipient must verify the email, then you approve.', 'success', 8000);
        location.hash = `#/claim/near/${result.claim.id}`;
      }).catch((error) => {
        toast('Could not create claim', error.message, 'error', 9000);
      }).finally(() => busy(button, false));
    }
  });
  /* ------------------------------------------------------------------ boot -- */

  async function boot() {
    applyTheme();

    // The chain read is the slowest part of boot. Start it immediately and let
    // the page mount share the same in-flight request instead of awaiting it
    // before the first paint.
    const cardsReady = loadCards().catch(() => { /* surfaced on the cards page */ });

    try {
      state.config = await api('/api/config');
    } catch (error) {
      state.config = null;
      toast('Server configuration unavailable', error.message, 'error', 9000);
    }

    await Promise.all([loadSession(), loadWalletSession()]);
    await Promise.all([initializeNearAuth(), initializeWallet()]);

    const resumedWalletAuth = await resumeWalletRedirect();
    if (!resumedWalletAuth) await resumeWalletAction();

    window.addEventListener('hashchange', () => render());

    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (media?.addEventListener) {
      media.addEventListener('change', () => {
        if (state.theme === 'system') applyTheme();
      });
    }

    render();

    // Paint the shell first, then swap in the on-chain cards when they land.
    await cardsReady;
    render();
  }

  boot().catch((error) => {
    app.innerHTML = `<div class="wrap page-top"><div class="notice danger"><div class="notice-body"><strong>RELAY could not start</strong><div>${esc(error.message)}</div><a class="btn btn-outline btn-sm mt-12" href="/">Reload</a></div></div></div>`;
  });
})();
