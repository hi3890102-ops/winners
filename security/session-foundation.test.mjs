import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

// Execute the functions from the proposed single source, with network/DOM stubs.
// No live credentials, database requests or real user records are used.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(m => m[1]).filter(s => s.trim());
for (const code of scripts) new Script(code);

function slice(start, end) {
  const begin = html.indexOf(start);
  const finish = html.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin);
  return html.slice(begin, finish);
}
const code = [
  slice('  async function loadStoreList(', '  function currentStoreId('),
  slice('  async function findOwnerRequestById(', '  async function findApprovedOwnerRequest('),
  slice('  async function restoreManeeAuthOwner(', '  async function becomeHq('),
  slice('  async function enterAuthenticatedOwner(', '  function startStoreOwnerFlow('),
  slice('  function switchUser(', '  async function goToStaffTab('),
].join('\n');

function harness(options = {}) {
  const calls = [];
  const storage = new Map(Object.entries(options.storage || {}));
  const rows = {
    profiles: [{ user_id: 'user-A', username: 'owner-A', status: 'active' }],
    store_memberships: [
      { user_id: 'user-A', store_id: 'store-A', role: 'owner', status: 'active' },
      { user_id: 'user-A', store_id: 'store-B', role: 'owner', status: 'active' },
      { user_id: 'user-A', store_id: 'store-C', role: 'owner', status: 'active' },
      { user_id: 'user-A', store_id: 'store-X', role: 'owner', status: 'revoked' },
    ],
    stores: [
      { id: 'store-A', name: '매장 A', archived_at: null },
      { id: 'store-B', name: '매장 B', archived_at: null },
      { id: 'store-C', name: '매장 C', archived_at: null },
      { id: 'store-X', name: '다른 매장', archived_at: null },
    ],
    owner_requests: [],
    ...options.rows,
  };
  let callback;
  const state = { role: 'landing', loading: false, storeList: [], storeIdMap: {}, ...options.state };
  const db = {
    auth: {
      async getSession() {
        calls.push('getSession');
        if(options.sessionError) return { data: null, error: new Error('offline') };
        return { data: { session: options.noSession ? null : { user: { id: 'untrusted-storage-user' } } }, error: null };
      },
      async getUser() {
        calls.push('getUser');
        return options.badUser ? { data: {}, error: new Error('invalid') } : { data: { user: { id: 'user-A' } }, error: null };
      },
      async signOut(value) {
        calls.push(['signOut', value.scope]);
        return { error: options.signOutError ? new Error('offline') : null };
      },
    },
    from(table) {
      calls.push(['table', table]);
      let data = [...(rows[table] || [])];
      let single = false;
      const query = {
        select() { return this; },
        order() { return this; },
        eq(key, value) { data = data.filter(r => r[key] === value); return this; },
        is(key, value) { data = data.filter(r => (r[key] ?? null) === value); return this; },
        in(key, values) { calls.push(['in', key, [...values]]); data = data.filter(r => values.includes(r[key])); return this; },
        maybeSingle() { single = true; return this; },
        insert() { calls.push('INSERT_ATTEMPT'); throw new Error('Unexpected data mutation'); },
        then(resolve, reject) {
          return Promise.resolve({ data: single ? data[0] ?? null : data, error: options.queryError === table ? new Error('query failed') : null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const ctx = createContext({
    db, state, Set, JSON, DEFAULT_STORES: ['sample'], DEFAULT_BUSINESS_DAY_CUTOFF_HOUR: 6,
    localGet(key) { calls.push(['localGet', key]); return storage.has(key) ? { value: storage.get(key) } : null; },
    localSet(key, value) { storage.set(key, value); },
    localDelete(key) { storage.delete(key); },
    async becomeStoreOwner(store) { state.store = store; state.role = 'storeOwner'; state.loading = false; calls.push(['enterOwner', store]); },
    async loadStaffHome() { state.loading = false; calls.push('enterLegacyStaff'); },
    async loadAllForStore() { calls.push('loadAllForStore'); },
    async ensureStoreInList() {}, async computeMyStoresDb() { return []; },
    requestRowToObj(row) { return { ...row, store: row.store_name }; },
    askConfirm(message, cb) { callback = cb; },
    render() { calls.push(['render', state.role]); },
    showToast(message) { calls.push(['toast', message]); },
  });
  new Script(code).runInContext(ctx);
  return { ctx, calls, state, storage, async confirmSwitch() { ctx.switchUser(); await callback(); } };
}

test('verified Auth owner takes priority over stale staff identity and keeps exactly three allowed stores', async () => {
  const h = harness({ storage: { 'my-link': '{"store":"fake","crewId":"other"}', 'my-request-id': 'old-request' } });
  await h.ctx.resolveIdentity();
  assert.equal(h.state.role, 'storeOwner');
  assert.deepEqual([...h.state.myStores], ['매장 A', '매장 B', '매장 C']);
  assert.equal(h.state.myUsername, 'owner-A');
  assert.equal(h.calls.includes('enterLegacyStaff'), false);
  assert.equal(h.storage.has('my-link'), false);
  assert.ok(h.calls.indexOf('getSession') < h.calls.indexOf('getUser'));
});

for (const [name, opts] of [
  ['invalid server-verified identity', { badUser: true }],
  ['session network error', { sessionError: true }],
  ['membership query error', { queryError: 'store_memberships' }],
  ['suspended account', { rows: { profiles: [{ user_id: 'user-A', username: 'owner-A', status: 'suspended' }] } }],
  ['revoked or missing memberships', { rows: { store_memberships: [] } }],
]) test(name + ' never falls back to cached legacy identity', async () => {
  const h = harness({ ...opts, storage: { 'my-link': '{"store":"fake","crewId":"other"}', 'my-request-id': 'old' } });
  await h.ctx.resolveIdentity();
  assert.equal(h.state.role, 'landing');
  assert.equal(h.state.loading, false);
  assert.equal(h.calls.includes('enterLegacyStaff'), false);
  assert.equal(h.calls.some(c => Array.isArray(c) && c[0] === 'localGet'), false);
});

test('Auth store lookup failure cannot insert sample stores', async () => {
  const h = harness({ queryError: 'stores' });
  await h.ctx.resolveIdentity();
  assert.equal(h.state.role, 'landing');
  assert.equal(h.calls.includes('INSERT_ATTEMPT'), false);
});

test('a revoked preferred store is not selected at login', async () => {
  const h = harness();
  await h.ctx.enterAuthenticatedOwner('untrusted-name', '다른 매장');
  assert.equal(h.state.store, '매장 A');
  assert.equal(h.state.myUsername, 'owner-A');
});

test('migrated and partially migrated requests cannot restore an owner without Auth', async () => {
  for (const migration of [{ auth_user_id: 'user-A', auth_migrated_at: '2026-09-11' }, { auth_user_id: 'user-A', auth_migrated_at: null }, { auth_user_id: null, auth_migrated_at: '2026-09-11' }]) {
    const h = harness({ noSession: true, storage: { 'my-request-id': 'old' }, rows: { owner_requests: [{ id: 'old', username: 'owner-A', status: 'approved', ...migration }] } });
    await h.ctx.resolveIdentity();
    assert.equal(h.state.role, 'landing');
    assert.equal(h.calls.includes('loadAllForStore'), false);
  }
});

test('legacy staff remain usable when no Auth session exists until the separate cutover', async () => {
  const h = harness({ noSession: true, storage: { 'my-link': '{"store":"legacy store","crewId":"legacy crew","storeId":"legacy store id"}' } });
  await h.ctx.resolveIdentity();
  assert.equal(h.state.role, 'staff');
  assert.equal(h.calls.includes('enterLegacyStaff'), true);
});

test('switch user ends only the current Auth session and clears legacy/upgrade identity', async () => {
  const h = harness({ storage: { 'my-link': '{}', 'my-role': 'hq', 'my-request-id': 'old', 'my-franchise-id': 'old' }, state: { role: 'storeOwner', legacyPasswordUpgrade: { placeholder: true } } });
  await h.confirmSwitch();
  assert.deepEqual(h.calls.find(c => Array.isArray(c) && c[0] === 'signOut'), ['signOut', 'local']);
  assert.equal(h.state.role, 'landing');
  assert.equal(h.state.legacyPasswordUpgrade, null);
  assert.equal(h.storage.size, 0);
});

test('logout failure remains visible and cannot claim a successful user switch', async () => {
  const h = harness({ signOutError: true, storage: { 'my-request-id': 'old' }, state: { role: 'storeOwner' } });
  await h.confirmSwitch();
  assert.equal(h.state.role, 'storeOwner');
  assert.equal(h.storage.has('my-request-id'), true);
  assert.ok(h.calls.some(c => Array.isArray(c) && c[0] === 'toast'));
});
