import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createStore } from '../store.mjs';
import { activateStoredAccount } from '../test-support/business-account.mjs';
import { createAppServer } from '../server.mjs';

test('券商合作与开户检索支持状态统计、待开户优先与固定分页', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'huzi-broker-search-'));
  const database = join(directory, 'search.sqlite');
  const credentials = { username: 'broker-search-admin', password: 'search-admin-password', name: '券商检索管理员' };
  const store = createStore(database, { seed: true, admin: credentials });
  const adminIdentity = store.verifyLogin(credentials);
  const adminToken = store.createSession(adminIdentity.id);
  const investorToken = store.createSession(store.registerInvestor({ phone: '19900007800', password: 'investor-password' }));
  store.openSalesAccount({ role: 'admin', id: adminIdentity.subjectId }, { salesId: 'sales-a', name: '合作负责甲', username: 'broker-search-sales' });
  activateStoredAccount(store, 'broker-search-sales', 'sales-password');
  activateStoredAccount(store, 'broker-a', 'demo-broker-a');
  const salesToken = store.createSession(store.verifyLogin({ username: 'broker-search-sales', password: 'sales-password' }).id);
  const brokerToken = store.createSession(store.verifyLogin({ username: 'broker-a', password: 'demo-broker-a' }).id);
  store.close();
  const fixture = new DatabaseSync(database);
  const password = fixture.prepare("SELECT password FROM identities WHERE username = 'broker-a'").get().password;
  fixture.prepare('UPDATE sales_staff SET name = ? WHERE id = ?').run('合作负责乙', 'sales-b');
  for (const [status, count] of [['pending', 24], ['active', 3], ['closed', 2]]) {
    for (let i = 0; i < count; i++) {
      const suffix = String(i).padStart(2, '0');
      const id = `${status}-${suffix}`;
      const name = `测试渠道 ${status === 'pending' ? 'Z待开户' : status === 'active' ? 'A正常' : 'B注销'} ${suffix}`;
      fixture.prepare('INSERT INTO brokers VALUES (?,?,?,?,?,?)').run(id, name, 'sales-a', '2026-11-17', 99, `promo-${id}`);
      if (status !== 'pending') fixture.prepare('INSERT INTO identities(username,password,role,subjectId,name,status) VALUES (?,?,?,?,?,?)')
        .run(`fixture-${id}`, password, 'broker', id, name, status);
    }
  }
  fixture.close();
  const server = createAppServer({ database });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    unlinkSync(database);
    rmdirSync(directory);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (query, token = adminToken) => fetch(`${base}/api/brokers/search?${new URLSearchParams(query)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const search = async query => {
    const response = await request(query);
    const body = await response.json();
    assert.equal(response.status, 200, body.message);
    return body;
  };

  await t.test('仅管理员可用，兼容运营后台独立会话前缀', async () => {
    assert.equal((await request({}, null)).status, 401);
    for (const token of [investorToken, salesToken, brokerToken]) assert.equal((await request({}, token)).status, 403);
    const login = await fetch(`${base}/api/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
    assert.equal(login.status, 200);
    const response = await fetch(`${base}/api/admin/brokers/search`, { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).total, 31);
  });

  await t.test('空搜索分页展示待开户、正常、注销，分组优先且翻页不重复', async () => {
    const first = await search({ q: '' });
    const second = await search({ offset: 20 });
    assert.equal(first.limit, 20);
    assert.equal(first.items.length, 20);
    assert.equal(first.total, 31);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.counts, { pending: 24, active: 5, closed: 2 });
    assert.equal(second.items.length, 11);
    assert.equal(second.hasMore, false);
    const combined = [...first.items, ...second.items];
    assert.equal(new Set(combined.map(row => row.id)).size, 31);
    assert.ok(combined.slice(0, 24).every(row => row.accountStatus === 'pending' && row.username === null));
    assert.ok(combined.slice(24, 29).every(row => row.accountStatus === 'active'));
    assert.ok(combined.slice(29).every(row => row.accountStatus === 'closed'));
    for (const status of ['pending', 'active', 'closed']) {
      const names = combined.filter(row => row.accountStatus === status).map(row => row.name);
      assert.deepEqual(names, [...names].sort());
    }
    assert.deepEqual((await search({ limit: 1000 })).items, first.items);
    assert.equal((await search({ offset: 31 })).items.length, 0);
  });

  await t.test('按券商名称、账号及合作销售姓名筛选，统计不受状态选项影响', async () => {
    const all = await search({ q: ' 测试渠道 ' });
    assert.equal(all.total, 29);
    assert.deepEqual(all.counts, { pending: 24, active: 3, closed: 2 });
    for (const status of ['pending', 'active', 'closed']) {
      const filtered = await search({ q: '测试渠道', status });
      assert.equal(filtered.total, all.counts[status]);
      assert.deepEqual(filtered.counts, all.counts);
      assert.ok(filtered.items.every(row => row.accountStatus === status));
    }
    const account = await search({ q: 'FIXTURE-ACTIVE-02' });
    assert.equal(account.total, 1);
    assert.equal(account.items[0].id, 'active-02');
    const emptyStatus = await search({ q: 'fixture-active-02', status: 'pending' });
    assert.equal(emptyStatus.total, 0);
    assert.equal(emptyStatus.items.length, 0);
    assert.deepEqual(emptyStatus.counts, { pending: 0, active: 1, closed: 0 });
    const owner = await search({ q: '合作负责乙' });
    assert.equal(owner.total, 1);
    assert.equal(owner.items[0].id, 'broker-b');
  });

  await t.test('不返回财务和密码字段，搜索字符按字面值处理并校验参数', async () => {
    const page = await search({ q: '测试渠道', status: 'active' });
    assert.deepEqual(Object.keys(page.items[0]).sort(), ['accountStatus', 'id', 'name', 'salesId', 'salesName', 'signedOn', 'username']);
    assert.ok(!JSON.stringify(page).includes(password));
    for (const q of ['%', "' OR 1=1 --", '完全不存在']) {
      const result = await search({ q });
      assert.equal(result.total, 0);
      assert.deepEqual(result.counts, { pending: 0, active: 0, closed: 0 });
    }
    for (const query of [{ status: 'enabled' }, { q: '字'.repeat(101) },
      ...['-1', '1.2', 'NaN', 'Infinity', '9007199254740992', ''].map(offset => ({ offset }))]) {
      assert.equal((await request(query)).status, 400);
    }
  });
});
