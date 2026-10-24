import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8');
// Export the internal helper only in this in-memory test module, never in the Worker.
const { default: worker, issueSession } = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(source + '\nexport { issueSession };'));
const origin = 'https://ndiayeelage0508-cloud.github.io';
const password = 'correct-horse-123';

class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(fs.readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
    this.db.exec(fs.readFileSync(new URL('../worker/accounts-schema.sql', import.meta.url), 'utf8'));
    this.beforeBatch = null;
    this.failAfter = null;
  }
  prepare(sql) {
    return { bind: (...args) => ({
      first: async () => this.db.prepare(sql).get(...args) ?? null,
      run: async () => ({ meta: { changes: Number(this.db.prepare(sql).run(...args).changes) } }),
    }) };
  }
  async batch(statements) {
    const hook = this.beforeBatch;
    this.beforeBatch = null;
    if (hook) await hook(this);
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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { db: d1, env, ctx, request, async drain() { await Promise.all(pending.splice(0)); } };
}
async function call(h, path, options = {}) {
  const response = await worker.fetch(h.request(path, options), h.env, h.ctx);
  const text = await response.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { response, json };
}
async function register(h, email) {
  return (await call(h, '/api/auth/register', { method: 'POST', body: { email, password } })).json;
}
function sessions(h, id) { return h.db.db.prepare('SELECT token_hash,user_id,expires_at FROM account_sessions WHERE user_id=? ORDER BY token_hash').all(id); }
async function passwordHash(value, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// The hook is immediately before the issuance batch, after login has verified the old row.
test('login snapshot loses to recovery changing the salt, even when password is unchanged', async () => {
  const h = harness();
  const first = await register(h, 'same-password@example.com');
  const oldSessions = sessions(h, first.user.id);
  const nextSalt = 'f'.repeat(64);
  const nextHash = await passwordHash(password, nextSalt);
  h.db.beforeBatch = d1 => d1.db.prepare('UPDATE account_users SET password_hash=?,password_salt=? WHERE id=?').run(nextHash, nextSalt, first.user.id);
  const result = await call(h, '/api/auth/login', { method: 'POST', body: { email: 'same-password@example.com', password } });
  assert.equal(result.response.status, 401);
  assert.equal(result.json.token, undefined);
  assert.deepEqual(sessions(h, first.user.id), oldSessions);
  await h.drain();
});

test('account deleted before issuance gets no session and does not clean existing sessions', async () => {
  const h = harness();
  const first = await register(h, 'deleted-before-issue@example.com');
  const oldSessions = sessions(h, first.user.id);
  h.db.beforeBatch = d1 => d1.db.prepare('DELETE FROM account_users WHERE id=?').run(first.user.id);
  const result = await call(h, '/api/auth/login', { method: 'POST', body: { email: 'deleted-before-issue@example.com', password } });
  assert.equal(result.response.status, 401);
  assert.equal(result.json.token, undefined);
  // The account deletion itself cascades its sessions; issuance must not add a
  // token or perform any cap/cleanup beyond that concurrent deletion.
  assert.equal(oldSessions.length, 1);
  assert.equal(sessions(h, first.user.id).length, 0);
  assert.equal(h.db.db.prepare('SELECT 1 FROM account_users WHERE id=?').get(first.user.id), undefined);
  await h.drain();
});

test('registration issuance loses to a credential change without returning a token', async () => {
  const h = harness();
  const email = 'register-race@example.com';
  const replacementSalt = 'e'.repeat(64);
  const replacementHash = await passwordHash('replacement-password-456', replacementSalt);
  h.db.beforeBatch = d1 => {
    const id = d1.db.prepare('SELECT id FROM account_users WHERE email=?').get(email).id;
    d1.db.prepare('UPDATE account_users SET password_hash=?,password_salt=? WHERE id=?').run(replacementHash, replacementSalt, id);
  };
  const result = await call(h, '/api/auth/register', { method: 'POST', body: { email, password } });
  assert.equal(result.response.status, 401);
  assert.equal(result.json.token, undefined);
  const row = h.db.db.prepare('SELECT password_hash,password_salt FROM account_users WHERE email=?').get(email);
  assert.equal(row.password_salt, replacementSalt);
  assert.equal(sessions(h, h.db.db.prepare('SELECT id FROM account_users WHERE email=?').get(email).id).length, 0);
  await h.drain();
});

test('successful issuance retains only the newest ten sessions', async () => {
  const h = harness();
  const first = await register(h, 'cap@example.com');
  const originalNow = Date.now;
  try {
    for (let i = 0; i < 9; i++) {
      const result = await call(h, '/api/auth/login', { method: 'POST', body: { email: 'cap@example.com', password } });
      assert.equal(result.response.status, 200);
      assert.match(result.json.token, /^[a-f0-9]{64}$/);
    }
    Date.now = () => originalNow() + 60001;
    for (let i = 0; i < 3; i++) {
      const result = await call(h, '/api/auth/login', { method: 'POST', body: { email: 'cap@example.com', password } });
      assert.equal(result.response.status, 200);
      assert.match(result.json.token, /^[a-f0-9]{64}$/);
    }
  } finally {
    Date.now = originalNow;
  }
  assert.equal(sessions(h, first.user.id).length, 10);
  await h.drain();
});

test('issuance batch failure rolls back insertion and leaves sessions unchanged', async () => {
  const h = harness();
  const first = await register(h, 'issuance-rollback@example.com');
  const before = sessions(h, first.user.id);
  h.db.failAfter = 1;
  const result = await call(h, '/api/auth/login', { method: 'POST', body: { email: 'issuance-rollback@example.com', password } });
  assert.equal(result.response.status, 503);
  assert.equal(result.json.token, undefined);
  assert.deepEqual(sessions(h, first.user.id), before);
  h.db.failAfter = null;
  await h.drain();
});

console.log('session-issuance-race.test.mjs: session issuance assertions passed');

test('equal session timestamps never evict the token just returned to the user', async () => {
  const originalNow = Date.now;
  const now = originalNow();
  Date.now = () => now;
  try {
    const h = harness();
    const first = await register(h, 'equal-timestamps@example.com');
    const expires = now + 30 * 86400000;
    for (let i = 1; i <= 9; i++) h.db.db.prepare('INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(String(i).repeat(64), first.user.id, expires);
    const result = await call(h, '/api/auth/login', { method: 'POST', body: { email: 'equal-timestamps@example.com', password } });
    assert.equal(result.response.status, 200);
    assert.equal(sessions(h, first.user.id).length, 10);
    const me = await call(h, '/api/auth/me', { headers: { Authorization: `Bearer ${result.json.token}` } });
    assert.equal(me.response.status, 200);
    assert.equal(me.json.user.id, first.user.id);
    await h.drain();
  } finally { Date.now = originalNow; }
});

test('a real recovery and fresh login win over an already verified old-password login', async () => {
  const h = harness();
  const email = 'real-recovery-race@example.com';
  const first = await register(h, email);
  await h.drain();
  let afterRecovery;
  let freshToken;
  h.db.beforeBatch = async () => {
    const recovered = await call(h, '/api/auth/recover', { method: 'POST', body: { email, password: 'replacement-password-456', recoveryCode: first.recoveryCode, recoveryProtocol: 2 } });
    assert.equal(recovered.response.status, 200);
    await h.drain();
    const fresh = await call(h, '/api/auth/login', { method: 'POST', body: { email, password: 'replacement-password-456' } });
    assert.equal(fresh.response.status, 200);
    freshToken = fresh.json.token;
    await h.drain();
    // Exceed the cap artificially to prove a refused issuance cannot even prune
    // sessions belonging to the newer credential state.
    for (let i = 0; i < 11; i++) h.db.db.prepare('INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(`fixture-${i}`, first.user.id, Date.now() + 86400000);
    afterRecovery = sessions(h, first.user.id);
  };
  const stale = await call(h, '/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(stale.response.status, 401);
  assert.equal(stale.json.token, undefined);
  assert.equal(stale.json.recoveryCode, undefined);
  assert.deepEqual(sessions(h, first.user.id), afterRecovery);
  assert.equal((await call(h, '/api/auth/me', { headers: { Authorization: `Bearer ${freshToken}` } })).response.status, 200);
  assert.equal((await call(h, '/api/auth/me', { headers: { Authorization: `Bearer ${first.token}` } })).response.status, 401);
  await h.drain();
});

test('Google issuance requires the synthetic verified account to still exist', async () => {
  const h = harness();
  const user = { id: 'google-fixture', email: 'google@example.com', provider: 'google' };
  h.db.db.prepare("INSERT INTO account_users(id,provider,subject,email,created_at) VALUES (?,'google',?,?,?)").run(user.id, 'google-sub-fixture', user.email, Date.now());
  const first = await issueSession(h.db, user);
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal(sessions(h, user.id).length, 1);
  h.db.beforeBatch = d1 => d1.db.prepare('DELETE FROM account_users WHERE id=?').run(user.id);
  await assert.rejects(issueSession(h.db, user), error => error.status === 401);
  assert.equal(sessions(h, user.id).length, 0);
  await h.drain();
});
