import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const key = 'promptlab-session-v1';
const legacyKeys = [key, 'promptlab-auth-token', 'promptlab-auth-user'];
const user = { id: 'account-a', email: 'a@example.com', provider: 'password' };
const session = { token: 'a'.repeat(64), user };
const newCode = 'c'.repeat(64);
const empty = { favorites: [], links: [], collections: [] };
const localData = { favorites: [{ id: 'keep', text: 'à conserver', mode: 'generate', createdAt: '2026-01-01' }], links: [], collections: [] };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
const wait = () => new Promise(resolve => setTimeout(resolve, 15));

async function boot(t, { persistent = {}, tab = {}, blockedTab = false, meStatus = 200, recoverResponse = response({ ok: true, recoveryCode: newCode }), recoverGate = null, recoverError = null, logoutReply = async () => response({ ok: true }), loginSession = session } = {}) {
  const dom = new JSDOM(html, { url: 'https://ndiayeelage0508-cloud.github.io/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.Headers = Headers;
  w.confirm = () => true;
  w.open = () => {};
  w.navigator.clipboard = { writeText: async () => {} };
  for (const name of ['showModal', 'close']) w.HTMLDialogElement.prototype[name] = function () { this.open = name === 'showModal'; };
  w.localStorage.setItem('promptlab-combined-v1', JSON.stringify(localData));
  w.localStorage.setItem('promptlab-library-account-a', JSON.stringify({ data: localData, base: localData }));
  for (const [k, v] of Object.entries(persistent)) w.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(tab)) w.sessionStorage.setItem(k, v);
  if (blockedTab) Object.defineProperty(w, 'sessionStorage', { get() { throw new Error('storage blocked'); } });
  const calls = [];
  w.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, opts });
    if (path === '/api/auth/config') return response({ googleClientId: null });
    if (path === '/api/auth/me') return response(meStatus === 200 ? { user } : { error: 'expirée' }, meStatus);
    if (path === '/api/library') return response({ data: localData, revision: 1 });
    if (path === '/api/auth/login' || path === '/api/auth/register') return response({ ...loginSession, ...(path.endsWith('register') ? { recoveryCode: 'b'.repeat(64) } : {}) });
    if (path === '/api/auth/logout') return logoutReply(opts);
    if (path === '/api/auth/recover') {
      if (recoverGate) await recoverGate;
      if (recoverError) throw recoverError;
      return recoverResponse;
    }
    throw Error(`Unexpected request: ${path}`);
  };
  w.eval(app);
  await wait();
  return { w, calls, el: id => w.document.getElementById(id) };
}
function submit(h, id) { h.el(id).dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true })); }
function recoveryInputs(h) {
  h.el('accountEmail').value = user.email;
  h.el('recoveryCode').value = 'b'.repeat(64);
  h.el('recoveryPassword').value = 'new-password-123';
}
function assertNoPersistentAuth(w) {
  for (const k of legacyKeys) assert.equal(w.localStorage.getItem(k), null, k);
}
function oldAtomic() { return { [key]: JSON.stringify(session), 'promptlab-auth-token': session.token, 'promptlab-auth-user': JSON.stringify(user) }; }

test('login stores one tab-scoped session, no persistent token, and clears the password', async t => {
  const h = await boot(t);
  h.el('accountEmail').value = user.email;
  h.el('accountPassword').value = 'password-12345';
  submit(h, 'accountForm');
  await wait();
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(key)), session);
  assertNoPersistentAuth(h.w);
  assert.equal(h.w.sessionStorage.length, 1);
  assert.equal(h.el('accountPassword').value, '');
  assert.equal(h.w.localStorage.getItem('promptlab-combined-v1'), JSON.stringify(localData));
});

for (const format of ['atomic', 'split']) test(`migrates legacy ${format} storage once without deleting libraries`, async t => {
  const persistent = oldAtomic();
  if (format === 'split') delete persistent[key];
  const h = await boot(t, { persistent });
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(key)), session);
  assertNoPersistentAuth(h.w);
  assert.equal(h.el('accountLoggedIn').hidden, false);
  assert.equal(JSON.parse(h.w.localStorage.getItem('promptlab-library-account-a')).data.favorites[0].text, 'à conserver');
  assert.equal(h.w.localStorage.getItem('promptlab-combined-v1'), JSON.stringify(localData));
});

test('tab session wins over stale persistent session, survives reload, and is not restored in an empty new tab', async t => {
  const stale = { token: 'b'.repeat(64), user: { ...user, id: 'old' } };
  const h = await boot(t, { persistent: { [key]: JSON.stringify(stale) }, tab: { [key]: JSON.stringify(session) } });
  assert.equal(JSON.parse(h.w.sessionStorage.getItem(key)).token, session.token);
  const reload = await boot(t, { tab: { [key]: h.w.sessionStorage.getItem(key) } });
  assert.equal(reload.el('accountLoggedIn').hidden, false);
  const fresh = await boot(t);
  assert.equal(fresh.el('accountLoggedOut').hidden, false);
  assert.equal(fresh.calls.filter(x => x.path === '/api/auth/me').length, 0);
});

test('blocked session storage uses memory only, including legacy migration', async t => {
  const h = await boot(t, { blockedTab: true, persistent: oldAtomic() });
  assertNoPersistentAuth(h.w);
  assert.equal(h.el('accountLoggedIn').hidden, false);
  h.el('accountEmail').value = user.email;
  h.el('accountPassword').value = 'password-12345';
  submit(h, 'accountForm');
  await wait();
  assertNoPersistentAuth(h.w);
  assert.equal(h.el('accountLoggedIn').hidden, false);
});

test('malformed sessions are removed without authentication calls or cache deletion', async t => {
  const h = await boot(t, { persistent: { [key]: '{invalid' }, tab: { [key]: JSON.stringify({ ...session, token: 'bad' }) } });
  assertNoPersistentAuth(h.w);
  assert.equal(h.w.sessionStorage.getItem(key), null);
  assert.equal(h.calls.some(x => x.path === '/api/auth/me'), false);
  assert.notEqual(h.w.localStorage.getItem('promptlab-library-account-a'), null);
});

for (const action of ['logout', 'expired']) test(`${action} removes both storage formats and preserves libraries`, async t => {
  const h = await boot(t, { persistent: oldAtomic(), meStatus: action === 'expired' ? 401 : 200 });
  if (action === 'logout') { h.el('logoutBtn').click(); await wait(); }
  assertNoPersistentAuth(h.w);
  assert.equal(h.w.sessionStorage.getItem(key), null);
  assert.equal(h.el('accountLoggedOut').hidden, false);
  assert.notEqual(h.w.localStorage.getItem('promptlab-library-account-a'), null);
  assert.equal(h.w.localStorage.getItem('promptlab-combined-v1'), JSON.stringify(localData));
});

test('recovery displays the replacement once, clears submitted secrets and never stores the recovery code', async t => {
  const h = await boot(t);
  recoveryInputs(h);
  submit(h, 'recoveryForm');
  await wait();
  const sentRecovery = h.calls.find(x => x.path === '/api/auth/recover');
  assert.equal(JSON.parse(sentRecovery.opts.body).recoveryProtocol, 2);
  assert.equal(h.el('recoveryCodeLabel').textContent, newCode);
  assert.equal(h.el('recoveryOnce').hidden, false);
  assert.equal(h.el('recoveryCode').value, '');
  assert.equal(h.el('recoveryPassword').value, '');
  assert.match(h.el('accountStatus').textContent, /l’ancien ne fonctionne plus/);
  for (const storage of [h.w.localStorage, h.w.sessionStorage]) {
    for (let i = 0; i < storage.length; i++) assert.ok(!storage.getItem(storage.key(i)).includes(newCode));
  }
  assert.equal(h.el('accountLoggedOut').hidden, false);
});

test('double recovery submission and concurrent login cannot consume the replacement or hide its response', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await boot(t, { recoverGate: gate });
  recoveryInputs(h);
  submit(h, 'recoveryForm');
  submit(h, 'recoveryForm');
  h.el('accountPassword').value = 'password-12345';
  submit(h, 'accountForm');
  assert.equal(h.calls.filter(x => x.path === '/api/auth/recover').length, 1);
  assert.equal(h.calls.filter(x => x.path === '/api/auth/login').length, 0);
  assert.equal(h.el('recoveryForm').querySelector('button').disabled, true);
  release();
  await wait();
  assert.equal(h.el('recoveryCodeLabel').textContent, newCode);
  assert.equal(h.el('recoveryForm').querySelector('button').disabled, false);
});

test('failed recovery shows no replacement and re-enables the form', async t => {
  const h = await boot(t, { recoverResponse: response({ error: 'Code invalide' }, 401) });
  recoveryInputs(h);
  submit(h, 'recoveryForm');
  await wait();
  assert.equal(h.el('recoveryOnce').hidden, true);
  assert.equal(h.el('recoveryCodeLabel').textContent, '');
  assert.match(h.el('accountStatus').textContent, /Code invalide/);
  assert.equal(h.el('recoveryForm').querySelector('button').disabled, false);
});

test('upgrade-required recovery response tells the user to reload without claiming success', async t => {
  const h = await boot(t, { recoverResponse: response({ error: 'Cette version du site est ancienne. Recharge la page puis réessaie la récupération.' }, 426) });
  recoveryInputs(h);
  submit(h, 'recoveryForm');
  await wait();
  assert.equal(h.el('recoveryOnce').hidden, true);
  assert.match(h.el('accountStatus').textContent, /Recharge la page/);
  assert.doesNotMatch(h.el('accountStatus').textContent, /Mot de passe réinitialisé/);
});

test('missing replacement in a successful response produces an explicit warning, not a reusable-code claim', async t => {
  const h = await boot(t, { recoverResponse: response({ ok: true }) });
  recoveryInputs(h);
  submit(h, 'recoveryForm');
  await wait();
  assert.equal(h.el('recoveryOnce').hidden, true);
  assert.match(h.el('accountStatus').textContent, /nouveau code n’a pas été reçu/);
});

test('successful recovery of the current password account clears its revoked local session, not its library', async t => {
  const h = await boot(t, { tab: { [key]: JSON.stringify(session) } });
  recoveryInputs(h);
  submit(h, 'recoveryForm');
  await wait();
  assert.equal(h.w.sessionStorage.getItem(key), null);
  assert.equal(h.el('accountLoggedOut').hidden, false);
  assert.equal(h.el('recoveryCodeLabel').textContent, newCode);
  assert.notEqual(h.w.localStorage.getItem('promptlab-library-account-a'), null);
});

test('logout clears local credentials and stops focus sync before the server responds', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await boot(t, { tab: { [key]: JSON.stringify(session) }, logoutReply: async () => { await gate; return response({ ok: true }); } });
  h.el('accountPassword').value = 'secret-password-123';
  h.el('recoveryCode').value = 'b'.repeat(64);
  h.el('recoveryPassword').value = 'another-password-123';
  const pending = h.w.endSession(true);
  // No await: the local token must already be gone before network completion.
  assert.equal(h.w.sessionStorage.getItem(key), null);
  assertNoPersistentAuth(h.w);
  assert.equal(h.el('accountLoggedOut').hidden, false);
  assert.equal(h.el('accountPassword').value, '');
  assert.equal(h.el('recoveryCode').value, '');
  assert.equal(h.el('recoveryPassword').value, '');
  const logout = h.calls.find(x => x.path === '/api/auth/logout');
  assert.equal(logout.opts.headers.get('Authorization'), `Bearer ${session.token}`);
  assert.equal(logout.opts.signal.aborted, false);
  const before = h.calls.filter(x => x.path === '/api/library').length;
  h.w.dispatchEvent(new h.w.Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(h.calls.filter(x => x.path === '/api/library').length, before);
  assert.notEqual(h.w.localStorage.getItem('promptlab-library-account-a'), null);
  assert.equal(h.w.localStorage.getItem('promptlab-combined-v1'), JSON.stringify(localData));
  release();
  await pending;
  assert.match(h.el('accountStatus').textContent, /révoquée ou déjà expirée/);
});

for (const status of [200, 401, 503]) test(`a late logout response ${status} cannot clear a new login or replace its message`, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const next = { token: 'd'.repeat(64), user };
  const h = await boot(t, {
    tab: { [key]: JSON.stringify(session) }, loginSession: next,
    logoutReply: async () => { await gate; return response({ ok: status === 200 }, status); },
  });
  const pending = h.w.endSession(true);
  h.el('accountEmail').value = user.email;
  h.el('accountPassword').value = 'password-12345';
  submit(h, 'accountForm');
  await wait();
  const message = h.el('accountStatus').textContent;
  assert.match(message, /Compte connecté/);
  release();
  await pending;
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(key)), next);
  assert.equal(h.el('accountLoggedIn').hidden, false);
  assert.equal(h.el('accountStatus').textContent, message);
});

for (const mode of ['network', 'server']) test(`logout ${mode} failure does not restore local credentials and warns about unconfirmed revocation`, async t => {
  const h = await boot(t, {
    tab: { [key]: JSON.stringify(session) },
    logoutReply: async () => { if (mode === 'network') throw new TypeError('Failed to fetch'); return response({}, 503); },
  });
  await h.w.endSession(true);
  assert.equal(h.w.sessionStorage.getItem(key), null);
  assertNoPersistentAuth(h.w);
  assert.equal(h.el('accountLoggedOut').hidden, false);
  assert.match(h.el('accountStatus').textContent, /révocation serveur n’a pas été confirmée/);
  assert.equal(h.calls.filter(x => x.path === '/api/auth/logout').length, 1);
});

test('logout timeout aborts only the revocation request and keeps the local session cleared', async t => {
  let expire;
  const h = await boot(t, {
    tab: { [key]: JSON.stringify(session) },
    logoutReply: opts => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const set = h.w.setTimeout.bind(h.w);
  const clear = h.w.clearTimeout.bind(h.w);
  h.w.setTimeout = (callback, delay, ...args) => {
    if (delay === 10000) { expire = callback; return -10000; }
    return set(callback, delay, ...args);
  };
  h.w.clearTimeout = id => { if (id !== -10000) clear(id); };
  const pending = h.w.endSession(true);
  assert.equal(h.w.sessionStorage.getItem(key), null);
  assert.equal(typeof expire, 'function');
  expire();
  await pending;
  assert.equal(h.calls.find(x => x.path === '/api/auth/logout').opts.signal.aborted, true);
  assert.match(h.el('accountStatus').textContent, /révocation serveur n’a pas été confirmée/);
});

for (const mode of ['network', 'server', 'invalid-json', 'null-json']) test(`ambiguous recovery ${mode} warns without retrying or claiming confirmed success`, async t => {
  const opts = mode === 'network' ? { recoverError: new TypeError('Failed to fetch') }
    : mode === 'server' ? { recoverResponse: response({ error: 'indisponible' }, 503) }
    : mode === 'null-json' ? { recoverResponse: response(null) }
    : { recoverResponse: { ok: true, status: 200, async json() { throw new SyntaxError('invalid JSON'); } } };
  const h = await boot(t, opts);
  recoveryInputs(h);
  submit(h, 'recoveryForm');
  await wait();
  const message = h.el('accountStatus').textContent;
  assert.match(message, /nouveau mot de passe/);
  assert.match(message, /Ne relance pas automatiquement/);
  assert.doesNotMatch(message, /Mot de passe réinitialisé/);
  assert.equal(h.el('recoveryOnce').hidden, true);
  assert.equal(h.el('recoveryForm').querySelector('button').disabled, false);
  assert.equal(h.calls.filter(x => x.path === '/api/auth/recover').length, 1);
  assert.equal(h.calls.filter(x => x.path === '/api/auth/login').length, 0);
});

test('an explicit recovery refusal preserves its specific error rather than claiming an ambiguous success', async t => {
  const h = await boot(t, { recoverResponse: response({ error: 'Trop de tentatives' }, 429) });
  recoveryInputs(h);
  submit(h, 'recoveryForm');
  await wait();
  assert.equal(h.el('accountStatus').textContent, 'Trop de tentatives');
  assert.equal(h.el('recoveryOnce').hidden, true);
  assert.equal(h.calls.filter(x => x.path === '/api/auth/recover').length, 1);
});
