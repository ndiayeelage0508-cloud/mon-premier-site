import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(source))).default;
const origin = 'https://ndiayeelage0508-cloud.github.io';
const password = 'correct-horse-123';
const nextPassword = 'new-correct-horse-456';
const empty = { favorites: [], links: [], collections: [] };

class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(fs.readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
    this.db.exec(fs.readFileSync(new URL('../worker/accounts-schema.sql', import.meta.url), 'utf8'));
    this.failAfter = null;
  }
  prepare(sql) {
    return { bind: (...args) => ({
      first: async () => this.db.prepare(sql).get(...args) ?? null,
      run: async () => {
        const result = this.db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) } };
      },
    }) };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const results = [];
      for (let i = 0; i < statements.length; i++) {
        results.push(await statements[i].run());
        if (this.failAfter === i + 1) throw new Error('simulated D1 batch failure');
      }
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function harness(d1 = new D1()) {
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(Promise.resolve(promise)); } };
  const env = { QUOTAS: d1 };
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Request('https://worker.test' + path, {
    method,
    headers: new Headers({ Origin: origin, 'CF-Connecting-IP': '198.51.100.10', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }),
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { db: d1, env, ctx, request, async drain() { await Promise.all(pending.splice(0)); } };
}

async function call(h, path, options = {}) {
  const response = await worker.fetch(h.request(path, options), h.env, h.ctx);
  const text = await response.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { response, json };
}
async function recover(h, email, password, recoveryCode, protocol = 2) {
  const body = { email, password, recoveryCode };
  if (protocol !== null) body.recoveryProtocol = protocol;
  return call(h, '/api/auth/recover', { method: 'POST', body });
}
async function register(h, email) {
  return (await call(h, '/api/auth/register', { method: 'POST', body: { email, password } })).json;
}
function auth(token) { return { Authorization: `Bearer ${token}` }; }
function snapshot(h, id) {
  return {
    user: h.db.db.prepare('SELECT password_hash,password_salt,recovery_hash FROM account_users WHERE id=?').get(id),
    sessions: h.db.db.prepare('SELECT token_hash,user_id,expires_at FROM account_sessions WHERE user_id=? ORDER BY token_hash').all(id),
    library: h.db.db.prepare('SELECT data,revision FROM account_libraries WHERE user_id=?').get(id) ?? null,
  };
}
async function saveLibrary(h, token) {
  return call(h, '/api/library', { method: 'POST', headers: auth(token), body: {
    revision: 0,
    data: { favorites: [{ id: 'kept', text: 'private', mode: 'generate', createdAt: '2026-01-01' }], links: [], collections: [] },
  } });
}

// The update and session revocation are one D1 transaction, while the update itself is a recovery-hash CAS.
test('recovery rotates both secrets, revokes sessions, preserves library, and returns only the new code', async () => {
  const h = harness();
  const first = await register(h, 'rotate@example.com');
  const secondSession = await call(h, '/api/auth/login', { method: 'POST', body: { email: 'rotate@example.com', password } });
  assert.equal((await saveLibrary(h, first.token)).response.status, 200);
  const recovered = await recover(h, 'rotate@example.com', nextPassword, first.recoveryCode);
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.json.ok, true);
  assert.match(recovered.json.recoveryCode, /^[a-f0-9]{64}$/);
  assert.equal(recovered.response.headers.get('Cache-Control'), 'no-store');
  const stored = snapshot(h, first.user.id).user.recovery_hash;
  const encoded = new TextEncoder().encode(recovered.json.recoveryCode);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))].map(x => x.toString(16).padStart(2, '0')).join('');
  assert.equal(stored, digest);
  assert.notEqual(stored, recovered.json.recoveryCode);
  assert.equal(Object.hasOwn(recovered.json, 'token'), false);
  assert.equal((await call(h, '/api/auth/me', { headers: auth(first.token) })).response.status, 401);
  assert.equal((await call(h, '/api/auth/me', { headers: auth(secondSession.json.token) })).response.status, 401);
  assert.equal((await call(h, '/api/auth/login', { method: 'POST', body: { email: 'rotate@example.com', password } })).response.status, 401);
  assert.equal((await call(h, '/api/auth/login', { method: 'POST', body: { email: 'rotate@example.com', password: nextPassword } })).response.status, 200);
  const library = await call(h, '/api/library', { headers: auth((await call(h, '/api/auth/login', { method: 'POST', body: { email: 'rotate@example.com', password: nextPassword } })).json.token) });
  assert.deepEqual(library.json.data.favorites[0].text, 'private');
  assert.equal(library.json.revision, 1);
  assert.equal((await recover(h, 'rotate@example.com', password, first.recoveryCode)).response.status, 401);
  assert.equal((await recover(h, 'rotate@example.com', password, recovered.json.recoveryCode)).response.status, 200);
  await h.drain();
});

test('legacy or unknown recovery protocol is rejected before changing account state', async () => {
  const h = harness();
  const r = await register(h, 'legacy@example.com');
  const secondSession = await call(h, '/api/auth/login', { method: 'POST', body: { email: 'legacy@example.com', password } });
  await saveLibrary(h, r.token);
  const before = snapshot(h, r.user.id);
  const legacy = await recover(h, 'legacy@example.com', nextPassword, r.recoveryCode, null);
  assert.equal(legacy.response.status, 426);
  assert.match(legacy.json.error, /Recharge la page/);
  assert.deepEqual(snapshot(h, r.user.id), before);
  const unknown = await recover(h, 'legacy@example.com', nextPassword, r.recoveryCode, 99);
  assert.equal(unknown.response.status, 426);
  assert.match(unknown.json.error, /Recharge la page/);
  assert.deepEqual(snapshot(h, r.user.id), before);
  assert.equal((await call(h, '/api/auth/me', { headers: auth(secondSession.json.token) })).response.status, 200);
  const compatible = await recover(h, 'legacy@example.com', nextPassword, r.recoveryCode);
  assert.equal(compatible.response.status, 200);
  assert.match(compatible.json.recoveryCode, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot(h, r.user.id).library, before.library);
  await h.drain();
});

test('wrong recovery code or invalid password makes no mutation', async () => {
  const h = harness();
  const r = await register(h, 'nomutation@example.com');
  const before = snapshot(h, r.user.id);
  const wrongCode = await recover(h, 'nomutation@example.com', nextPassword, '0'.repeat(64));
  assert.equal(wrongCode.response.status, 401);
  assert.deepEqual(snapshot(h, r.user.id), before);
  const wrongPassword = await recover(h, 'nomutation@example.com', 'short', r.recoveryCode);
  assert.equal(wrongPassword.response.status, 400);
  assert.deepEqual(snapshot(h, r.user.id), before);
  await h.drain();
});

test('recovery is isolated to the selected account', async () => {
  const h = harness();
  const a = await register(h, 'a-rotation@example.com');
  const b = await register(h, 'b-rotation@example.com');
  const beforeB = snapshot(h, b.user.id);
  const result = await recover(h, 'a-rotation@example.com', nextPassword, a.recoveryCode);
  assert.equal(result.response.status, 200);
  assert.deepEqual(snapshot(h, b.user.id), beforeB);
  assert.equal((await call(h, '/api/auth/login', { method: 'POST', body: { email: 'b-rotation@example.com', password } })).response.status, 200);
  await h.drain();
});

test('double use of one recovery code has exactly one winner and only the winner gets a new code', async () => {
  const h = harness();
  const r = await register(h, 'race@example.com');
  const results = await Promise.all([
    recover(h, 'race@example.com', nextPassword, r.recoveryCode),
    recover(h, 'race@example.com', 'another-correct-789', r.recoveryCode),
  ]);
  assert.equal(results.filter(x => x.response.status === 200).length, 1);
  assert.equal(results.filter(x => x.response.status === 401).length, 1);
  assert.equal(results.filter(x => x.response.status === 200)[0].json.recoveryCode.length, 64);
  assert.equal(results.filter(x => x.response.status === 401)[0].json.recoveryCode, undefined);
  await h.drain();
});

for (const failAfter of [1, 2]) test(`batch failure after statement ${failAfter} rolls back password, recovery hash, and session revocation`, async () => {
  const h = harness();
  const r = await register(h, 'rollback@example.com');
  const before = snapshot(h, r.user.id);
  h.db.failAfter = failAfter;
  const failed = await recover(h, 'rollback@example.com', nextPassword, r.recoveryCode);
  assert.equal(failed.response.status, 503);
  assert.deepEqual(snapshot(h, r.user.id), before);
  h.db.failAfter = null;
  assert.equal((await call(h, '/api/auth/login', { method: 'POST', body: { email: 'rollback@example.com', password } })).response.status, 200);
  await h.drain();
});

console.log('recovery-rotation.test.mjs: recovery assertions passed');
