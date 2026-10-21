import fs from 'node:fs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const source = fs.readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(source))).default;
const origin = 'https://ndiayeelage0508-cloud.github.io';
const otherOrigin = 'https://evil.example';
const empty = { favorites: [], links: [], collections: [] };
const hash = email => createHash('sha256').update(email).digest('hex');

class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(fs.readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
    this.db.exec(fs.readFileSync(new URL('../worker/accounts-schema.sql', import.meta.url), 'utf8'));
    this.failAfter = null;
  }
  prepare(sql) {
    const db = this.db;
    return { bind: (...args) => ({
      first: async () => db.prepare(sql).get(...args) ?? null,
      run: async () => {
        const r = db.prepare(sql).run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
    }) };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      for (let i = 0; i < statements.length; i++) {
        if (this.failAfter !== null && i >= this.failAfter) throw new Error('injected batch failure');
        await statements[i].run();
      }
      this.db.exec('COMMIT');
      return [];
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
function harness(ip = '198.51.100.10', requestOrigin = origin) {
  const db = new D1();
  const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
  const env = { QUOTAS: db };
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Request('https://worker.test' + path, {
    method,
    headers: new Headers({ Origin: requestOrigin, 'CF-Connecting-IP': ip, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { db, env, ctx, request };
}
async function call(h, path, opts = {}) {
  const r = await worker.fetch(h.request(path, opts), h.env, h.ctx);
  return { r, j: await r.json().catch(() => ({})) };
}
async function register(h, email, password = '123456789012') {
  return (await call(h, '/api/auth/register', { method: 'POST', body: { email, password } })).j;
}
function rows(h, sql, ...args) { return h.db.db.prepare(sql).all(...args); }
function seedLibrary(h, token) {
  return call(h, '/api/library', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: {
    revision: 0,
    data: { favorites: [{ id: 'secret', text: 'private', mode: 'generate', createdAt: '2026-01-01' }], links: [], collections: [] },
  } });
}

const h = harness();
const email = 'delete-me@example.com';
const first = await register(h, email);
const firstId = first.user.id;
assert.equal((await seedLibrary(h, first.token)).r.status, 200);
// A second login creates another session; deletion must invalidate all sessions.
const login = await call(h, '/api/auth/login', { method: 'POST', body: { email, password: '123456789012' } });
assert.equal(login.r.status, 200);
const secondSession = login.j.token;
const recoveryHash = h.db.db.prepare('SELECT recovery_hash FROM account_users WHERE id=?').get(firstId).recovery_hash;
// No auth and invalid GET are rejected; an untrusted origin is rejected before auth.
assert.equal((await call(h, '/api/library')).r.status, 401);
assert.equal((await call(h, '/api/auth/delete', { method: 'GET', headers: { Authorization: `Bearer ${first.token}` } })).r.status, 405);
const hostile = harness('198.51.100.11', otherOrigin);
assert.equal((await call(hostile, '/api/auth/delete', { method: 'POST', headers: { Authorization: `Bearer ${first.token}` }, body: { confirmation: 'SUPPRIMER' } })).r.status, 403);
assert.equal((await call(h, '/api/auth/delete', { method: 'POST', headers: { Authorization: `Bearer ${first.token}` }, body: { confirmation: 'supprimer' } })).r.status, 400);
// Existing free quota state is unrelated to account deletion and must survive.
h.db.db.prepare('INSERT INTO free_usage(day,client,generations,optimizations,window_start,minute_used) VALUES (?,?,?,?,?,?)').run('2099-01-01', 'seed-client', 2, 1, 0, 1);
const accountLimit = 'library:' + firstId;
h.db.db.prepare('INSERT INTO auth_limits(key,bucket,count,expires_at) VALUES (?,?,?,?)').run(accountLimit, 1, 3, Date.now() + 60000);
const emailKey = 'email:' + hash(email);
h.db.db.prepare('INSERT INTO auth_limits(key,bucket,count,expires_at) VALUES (?,?,?,?)').run(emailKey, 1, 4, Date.now() + 60000);
// Inject a failure inside the deletion batch: BEGIN/ROLLBACK preserves every row.
h.db.failAfter = 2;
assert.equal((await call(h, '/api/auth/delete', { method: 'POST', headers: { Authorization: `Bearer ${first.token}` }, body: { confirmation: 'SUPPRIMER' } })).r.status, 503);
h.db.failAfter = null;
assert.equal(rows(h, 'SELECT * FROM account_users WHERE id=?', firstId).length, 1);
assert.equal(rows(h, 'SELECT * FROM account_sessions WHERE user_id=?', firstId).length, 2);
assert.equal(rows(h, 'SELECT * FROM account_libraries WHERE user_id=?', firstId).length, 1);
assert.equal(rows(h, 'SELECT * FROM free_usage WHERE day=? AND client=?', '2099-01-01', 'seed-client').length, 1);
// Add an unrelated account: its account, session, library and global limits remain.
const other = await register(h, 'keep-me@example.com');
await seedLibrary(h, other.token);
h.db.db.prepare('INSERT INTO auth_limits(key,bucket,count,expires_at) VALUES (?,?,?,?)').run('auth:global', 1, 5, Date.now() + 60000);
assert.equal((await call(h, '/api/auth/delete', { method: 'POST', headers: { Authorization: `Bearer ${first.token}` }, body: { confirmation: 'SUPPRIMER' } })).r.status, 200);
assert.equal(rows(h, 'SELECT * FROM account_users WHERE id=?', firstId).length, 0);
assert.equal(rows(h, 'SELECT * FROM account_sessions WHERE user_id=?', firstId).length, 0);
assert.equal(rows(h, 'SELECT * FROM account_libraries WHERE user_id=?', firstId).length, 0);
assert.equal(rows(h, 'SELECT * FROM auth_limits WHERE key=?', accountLimit).length, 0);
assert.equal(rows(h, 'SELECT recovery_hash FROM account_users WHERE id=?', firstId).length, 0);
assert.equal(rows(h, 'SELECT * FROM account_users WHERE id=?', other.user.id).length, 1);
assert.equal(rows(h, 'SELECT * FROM account_libraries WHERE user_id=?', other.user.id).length, 1);
assert.equal(rows(h, 'SELECT * FROM auth_limits WHERE key=?', 'auth:global').length, 1);
assert.equal(rows(h, 'SELECT * FROM free_usage WHERE day=? AND client=?', '2099-01-01', 'seed-client').length, 1);
// With no remaining account for this e-mail, its non-shared e-mail counter is removed.
assert.equal(rows(h, 'SELECT * FROM auth_limits WHERE key=?', emailKey).length, 0);
assert.equal((await call(h, '/api/auth/me', { headers: { Authorization: `Bearer ${first.token}` } })).r.status, 401);
assert.equal((await call(h, '/api/auth/me', { headers: { Authorization: `Bearer ${secondSession}` } })).r.status, 401);
// A deleted password account cannot recover; its old recovery hash is gone.
assert.equal((await call(h, '/api/auth/recover', { method: 'POST', body: { email, recoveryCode: 'a'.repeat(64), password: 'new-password-123' } })).r.status, 401);
assert.equal((await call(h, '/api/auth/login', { method: 'POST', body: { email, password: '123456789012' } })).r.status, 401);
// FK protection means stale sessions/library rows cannot recreate a deleted user.
assert.throws(() => h.db.db.prepare('INSERT INTO account_libraries(user_id,data,revision,updated_at) VALUES (?,?,?,?)').run(firstId, JSON.stringify(empty), 0, Date.now()), /FOREIGN KEY/);
assert.throws(() => h.db.db.prepare('INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run('stale', firstId, Date.now() + 10000), /FOREIGN KEY/);
assert.equal(recoveryHash.length, 64);
console.log('delete-account.test.mjs: all assertions passed');
