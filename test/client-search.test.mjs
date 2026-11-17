import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createStore } from '../store.mjs';
import { createAppServer } from '../server.mjs';

test('后台客户检索按业务范围、姓名及手机号分页，权限和输入均受校验', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'huzi-client-search-'));
  const database = join(directory, 'search.sqlite');
  const credentials = { username: 'search-admin', password: 'search-admin-password', name: '检索测试管理员' };
  const store = createStore(database, { seed: true, admin: credentials });
  const adminIdentity = store.verifyLogin(credentials);
  const adminToken = store.createSession(adminIdentity.id);
  const investorId = store.registerInvestor({ phone: '19900008800', password: 'investor-password' });
  const investorToken = store.createSession(investorId);
  store.openSalesAccount({ role: 'admin', id: adminIdentity.subjectId }, { salesId: 'sales-a', name: '检索测试销售', username: 'search-sales', password: 'sales-password' });
  const salesToken = store.createSession(store.verifyLogin({ username: 'search-sales', password: 'sales-password' }).id);
  const brokerToken = store.createSession(store.verifyLogin({ username: 'broker-a', password: 'demo-broker-a' }).id);
  store.close();
  const fixture = new DatabaseSync(database);
  const password = fixture.prepare('SELECT password FROM identities WHERE id = ?').get(investorId).password;
  const insert = (id, name, phone, brokerId, account, hasLead = true) => {
    fixture.prepare('INSERT INTO clients VALUES (?,?,?,?,?,?)').run(id, name, phone, brokerId, brokerId, '2026-11-17T00:00:00.000Z');
    fixture.prepare('INSERT INTO identities(username,password,role,subjectId,name) VALUES (?,?,?,?,?)').run(account, password, 'investor', id, name || account);
    if (hasLead) fixture.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?)').run(`lead-${id}`, id, '虚构股票', 'TEST', '2024 年至今', '2026-11-17T00:00:00.000Z');
  };
  insert('same-a', '精确客户', '19900001001', 'broker-a', '19900009001');
  insert('same-b', '精确客户', '19900001002', 'broker-b', '19900009002');
  insert('same-natural', '精确客户', '19900001003', null, '19900009003');
  insert('partial', '精确客户附加', '19900001004', 'broker-a', '19900009004');
  insert('no-lead', '尚未留资客户', '19900001005', 'broker-a', '19900009005', false);
  insert('unnamed', null, null, 'broker-a', '19900009006', false);
  insert('literal', '百分%_客户', '19900001007', 'broker-a', '19900009007');
  fixture.prepare('UPDATE clients SET firstBrokerId = ? WHERE id = ?').run('broker-b', 'same-a');
  fixture.prepare('INSERT INTO signings VALUES (?,?,?)').run('same-a', '2026-11-17', '虚构签约凭据');
  for (const [id, name, code] of [['extra-one', '唯一本地股票', 'STOCK-A'], ['extra-repeat', '唯一本地股票', 'STOCK-A'], ['extra-two', '另一只股票', 'STOCK-B']]) {
    fixture.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?)').run(id, 'same-a', name, code, '2024 年至今', '2026-11-17T00:00:00.000Z');
  }
  for (let i = 0; i < 27; i++) {
    const suffix = String(i).padStart(2, '0');
    insert(`page-${suffix}`, `分页客户 ${suffix}`, `199000020${suffix}`, 'broker-a', `199000080${suffix}`);
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
  const request = (query, token = adminToken) => fetch(`${base}/api/clients/search?${new URLSearchParams(query)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const search = async query => {
    const response = await request(query);
    const value = await response.json();
    assert.equal(response.status, 200, value.message);
    return value;
  };

  await t.test('仅管理员可检索，PC 专用会话前缀可用', async () => {
    const query = { scope: 'signing', q: '精确客户' };
    assert.equal((await request(query, null)).status, 401);
    for (const token of [investorToken, salesToken, brokerToken]) assert.equal((await request(query, token)).status, 403);
    const login = await fetch(`${base}/api/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${base}/api/admin/clients/search?${new URLSearchParams(query)}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).total, 4);
  });

  await t.test('同名客户保留独立身份，完整姓名优先，可按电话和注册账号找到', async () => {
    const result = await search({ scope: 'signing', q: ' 精确客户 ' });
    assert.equal(result.total, 4);
    assert.ok(result.items.slice(0, 3).every(item => item.name === '精确客户'));
    assert.equal(result.items.at(-1).name, '精确客户附加');
    assert.equal(new Set(result.items.map(item => item.phone)).size, 4);
    assert.equal(new Set(result.items.map(item => item.account)).size, 4);
    assert.deepEqual(Object.keys(result.items[0]).sort(), ['account', 'brokerId', 'brokerName', 'id', 'name', 'phone']);
    const phone = await search({ scope: 'signing', q: '19900001002' });
    assert.deepEqual(phone.items.map(item => item.id), ['same-b']);
    const account = await search({ scope: 'signing', q: '19900009003' });
    assert.equal(account.items[0].id, 'same-natural');
    assert.equal(account.items[0].brokerId, null);
  });

  await t.test('调整归属只含有渠道客户，实际签约只含有真实留资客户', async () => {
    const assigned = await search({ scope: 'reassign', q: '精确客户' });
    assert.equal(assigned.total, 3);
    assert.ok(assigned.items.every(item => item.brokerId));
    assert.equal((await search({ scope: 'reassign', q: '尚未留资客户' })).total, 1);
    assert.equal((await search({ scope: 'signing', q: '尚未留资客户' })).total, 0);
    assert.equal((await search({ scope: 'reassign', q: '19900009006' })).items[0].id, 'unnamed');
    assert.equal((await search({ scope: 'signing', q: '19900009006' })).total, 0);
  });

  await t.test('每页固定 20 条，稳定翻页不重复且不返回全量空搜索', async () => {
    const first = await search({ scope: 'reassign', q: '分页客户' });
    const second = await search({ scope: 'reassign', q: '分页客户', offset: 20 });
    assert.equal(first.total, 27);
    assert.equal(first.limit, 20);
    assert.equal(first.items.length, 20);
    assert.equal(first.hasMore, true);
    assert.equal(second.offset, 20);
    assert.equal(second.items.length, 7);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 27);
    assert.deepEqual((await search({ scope: 'reassign', q: '分页客户' })).items, first.items);
    assert.equal((await search({ scope: 'reassign', q: '分页客户', offset: 27 })).items.length, 0);
    for (const q of ['', '   ']) assert.deepEqual(await search({ scope: 'signing', q }), { items: [], total: 0, offset: 0, limit: 20, hasMore: false });
  });

  await t.test('搜索字面值不触发 SQL 通配符，拒绝无效范围和分页参数', async () => {
    assert.equal((await search({ scope: 'reassign', q: '%' })).items[0].id, 'literal');
    assert.equal((await search({ scope: 'reassign', q: '%' })).total, 1);
    assert.equal((await search({ scope: 'reassign', q: "' OR 1=1 --" })).total, 0);
    for (const query of [
      { scope: 'all', q: '精确客户' }, { q: '精确客户' }, { scope: 'signing', q: '字'.repeat(101) },
      ...['-1', '1.5', 'Infinity', 'NaN', '9007199254740992', ''].map(offset => ({ scope: 'signing', q: '精确客户', offset })),
    ]) assert.equal((await request(query)).status, 400);
  });

  await t.test('客户记录按股票、姓名、电话、账号和首次或当前券商检索，每个客户只返回一行', async () => {
    for (const q of ['唯一本地股票', 'stock-a', '另一只股票', 'STOCK-B', '19900001001', '19900009001']) {
      const result = await search({ scope: 'records', q });
      assert.equal(result.total, 1);
      assert.deepEqual(result.items.map(item => item.id), ['same-a']);
      const client = result.items[0];
      assert.equal(client.firstBrokerName, '示例券商 B');
      assert.equal(client.brokerName, '示例券商 A');
      assert.equal(client.signedOn, '2026-11-17');
      assert.equal(client.stocks.length, 3, 'all stocks are returned even when one stock matched');
      assert.equal(client.stocks.find(stock => stock.stockCode === 'STOCK-A').leadCount, 2);
      assert.equal(client.stocks.find(stock => stock.stockCode === 'STOCK-B').leadCount, 1);
    }
    assert.equal((await search({ scope: 'records', q: '精确客户' })).total, 4);
    for (const q of ['示例券商 A', '示例券商 B']) {
      const result = await search({ scope: 'records', q });
      const all = [...result.items];
      for (let offset = 20; offset < result.total; offset += 20) all.push(...(await search({ scope: 'records', q, offset })).items);
      assert.ok(all.some(item => item.id === 'same-a'));
      assert.equal(new Set(all.map(item => item.id)).size, result.total);
    }
    const blankStock = await search({ scope: 'records', q: '尚未留资客户' });
    assert.deepEqual(blankStock.items[0].stocks, []);
    assert.equal((await request({ scope: 'records', q: '唯一本地股票' }, investorToken)).status, 403);
  });

  await t.test('客户记录的空搜索分页列出原范围客户，股票多条不会扩大总人数', async () => {
    const first = await search({ scope: 'records', q: '' });
    const second = await search({ scope: 'records', q: '  ', offset: 20 });
    assert.equal(first.limit, 20);
    assert.equal(first.items.length, 20);
    assert.equal(first.hasMore, true);
    assert.equal(first.total, 36);
    assert.equal(second.items.length, 16);
    assert.equal(second.hasMore, false);
    const combined = [...first.items, ...second.items];
    assert.equal(new Set(combined.map(item => item.id)).size, 36);
    assert.ok(combined.every(item => Array.isArray(item.stocks)));
    assert.ok(!combined.some(item => item.account === '19900008800'), 'unattributed unqualified registration excluded');
    assert.deepEqual((await search({ scope: 'records' })).items, first.items);
  });
});
