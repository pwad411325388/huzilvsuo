import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAppServer } from '../server.mjs';
import { createStore } from '../store.mjs';
import { activateStoredAccount } from '../test-support/business-account.mjs';

test('登记表按组关联账号，受角色、当前会话、显式确认和数据版本限制', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'registry-api-'));
  const path = join(directory, 'test.sqlite');
  const credentials = { username: 'admin-fixture', password: 'admin-fixture-password', name: '模拟管理员' };
  const store = createStore(path, { seed: true, admin: credentials });
  const admin = store.getSession(store.createSession(store.verifyLogin(credentials).id));
  const session = (username, password) => store.createSession(store.verifyLogin({ username, password }).id);
  const adminToken = session(credentials.username, credentials.password);
  const mobile = '19900005551';
  const investorId = store.registerInvestor({ phone: mobile, password: 'investor-fixture-password' });
  const investor = store.createSession(investorId);
  const otherId = store.registerInvestor({ phone: '19900005552', password: 'other-fixture-password' });
  store.renameInvestor(store.getSession(investor), { name: '模拟股民' });
  for (const [subject, username] of [['sales-a', 'fixture-staff'], ['sales-b', 'other-staff']]) {
    store.openSalesAccount(admin, { salesId: subject, name: '模拟销售', username });
    activateStoredAccount(store, username, 'staff-fixture-password');
  }
  const sales = session('fixture-staff', 'staff-fixture-password');
  const otherSales = session('other-staff', 'staff-fixture-password');
  activateStoredAccount(store, 'broker-a', 'demo-broker-a');
  const broker = session('broker-a', 'demo-broker-a');
  store.close();
  const server = createAppServer({ database: path });
  const db = new DatabaseSync(path);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close(); unlinkSync(path); rmdirSync(directory);
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (token, url = '/registry', input) => {
    const response = await fetch(base + url, { method: input ? 'POST' : 'GET', headers: {
      ...(token && { Authorization: 'Bearer ' + token }), ...(input && { 'Content-Type': 'application/json' }),
    }, body: input && JSON.stringify(input) });
    return [response.status, await response.json()];
  };
  assert.equal((await request(null))[0], 401);
  assert.equal((await request(broker))[0], 403);
  assert.deepEqual((await request(adminToken))[1].items, []);
  db.exec(`CREATE TABLE registry_meta(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO registry_meta VALUES ('source_name','模拟表格.xlsx'),('imported_at','2026-11-18T00:00:00Z');
    CREATE TABLE registry_entries(entry_key TEXT PRIMARY KEY,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
    stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,filed_on TEXT,stage TEXT)`);
  const insert = db.prepare("INSERT INTO registry_entries VALUES (?,?,?,?,?,'测试股票','000001','测试来源','','','')");
  for (let i = 0; i < 21; i++) insert.run('g' + i, i + 3, '模拟股民', mobile, '模拟销售');
  insert.run('unrelated', 25, '模拟股民', '19900006663', '其他销售');
  insert.run('missing', 26, '模拟股民', '', '模拟销售、其他销售');
  const list = (await request(adminToken))[1];
  assert.equal(list.total, 23); assert.equal(list.items.length, 20); assert.equal(list.sourceName, '模拟表格.xlsx');
  const page = (await request(adminToken, '/registry?offset=20'))[1];
  assert.equal(page.items.length, 3); assert.equal(page.items[0].sourceRow, 23);
  for (const token of [investor, sales, otherSales]) {
    assert.equal((await request(token, '/registry?q=' + mobile))[1].total, 0);
    assert.equal((await request(token, '/registry/candidates?type=sales&entryKey=g0'))[0], 403);
  }
  for (const type of ['sales', 'investor']) {
    assert.equal((await request(adminToken, `/registry/candidates?type=${type}&entryKey=missing`))[0], 400);
  }
  for (const [type, query, token] of [['investor', mobile, investor], ['sales', 'fixture-staff', sales]]) {
    const path = `/registry/candidates?type=${type}&entryKey=g0`;
    const group = (await request(adminToken, path))[1];
    assert.equal(group.items.length, 0); assert.equal(group.affectedCount, 21); assert.equal(group.currentLink, null);
    const candidate = (await request(adminToken, path + '&q=' + query))[1].items[0];
    const payload = { type, entryKey: 'g0', sourceToken: group.sourceToken, identityId: candidate.identityId,
      previousIdentityId: null, confirmed: true };
    const link = values => request(adminToken, '/registry/link', { ...payload, ...values });
    assert.equal((await link({ confirmed: false }))[0], 400);
    assert.equal((await link({ sourceToken: 'stale' }))[0], 409);
    if (type === 'sales') assert.equal((await link({ identityId: investorId }))[0], 400);
    assert.equal((await request(token, '/registry/link', payload))[0], 403);
    assert.equal((await link({}))[0], 200);
    assert.equal((await link({}))[0], 409, '第二个管理员不能覆盖已变化的关联');
    const linked = (await request(token))[1];
    assert.equal(linked.total,21); assert.equal(linked.items.length,20);
    assert.ok(linked.items.every(row => row.customer === '模拟股民' && row.phone === mobile && row.sales === '模拟销售'));
    assert.ok(!('sourceName' in linked || 'importedAt' in linked));
    assert.ok(linked.items.every(row => row.rowKey && !('sourceRow' in row || 'entryKey' in row || 'salesLink' in row || 'investorLink' in row)));
    assert.equal((await request(otherSales))[1].total,0);
    const updated = (await request(adminToken, path))[1];
    assert.equal(updated.currentLink.identityId, candidate.identityId);
    assert.equal((await request(adminToken))[1].items[0][type + 'Link'].identityId, candidate.identityId);
    if (type === 'investor') assert.equal((await link({ previousIdentityId: investorId, identityId: otherId }))[0],409);
    assert.equal((await link({ previousIdentityId: candidate.identityId, identityId: null }))[0],200);
    assert.equal((await request(token))[1].total,0);
  }
  const changedScope = (await request(adminToken, '/registry/candidates?type=investor&entryKey=g0'))[1];
  insert.run('added', 28, '模拟股民', mobile, '其他销售');
  assert.equal((await request(adminToken, '/registry/link', { type:'investor', entryKey:'g0', identityId:investorId,
    previousIdentityId:null, confirmed:true, sourceToken:changedScope.sourceToken }))[0],409);
  db.prepare('UPDATE identities SET passwordChangeRequired=1 WHERE id=?').run(investorId);
  assert.equal((await request(investor))[0],403);
  const audit = db.prepare("SELECT * FROM audit WHERE action LIKE '%登记台账%'").all();
  assert.equal(audit.length,4); assert.ok(!JSON.stringify(audit).includes(mobile));
  insert.run('unknown-name', 29, '股民姓名待核对', mobile, '未登记');
  insert.run('marked',30,'股民乙','19900006667','*模拟销售');
  insert.run('masked',31,'股民丙','19900006668','模**');
  assert.equal((await request(adminToken, '/registry/candidates?type=investor&entryKey=unknown-name'))[0],400);
  assert.equal((await request(adminToken, '/registry/candidates?type=sales&entryKey=masked'))[0],400);
  const marked = (await request(adminToken, '/registry/candidates?type=sales&entryKey=marked&q=fixture-staff'))[1];
  assert.equal(marked.sourceLabel,'*模拟销售'); assert.equal(marked.affectedCount,1);
  assert.equal((await request(adminToken, '/registry/link', { type:'sales', entryKey:'marked', identityId:marked.items[0].identityId,
    previousIdentityId:null, confirmed:true, sourceToken:marked.sourceToken }))[0],200);
  const visible = (await request(sales))[1];
  assert.equal(visible.total,1);
  assert.equal(visible.items[0].sales,'*模拟销售');
});
