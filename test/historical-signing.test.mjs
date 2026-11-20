import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAppServer } from '../server.mjs';
import { createStore, today } from '../store.mjs';
import { activateStoredAccount } from '../test-support/business-account.mjs';

test('历史签约证据按销售权限去重，后台、券商及导出保持一致，进度测试不能改变业务统计', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'historical-signing-'));
  const database = join(dir, 'fixture.sqlite');
  const credentials = { username: 'history-admin', password: 'history-admin-test!', name: '合成管理员' };
  const store = createStore(database, { admin: credentials, cutoff: '2000-01-01', progressTestEnabled: true });
  const db = new DatabaseSync(database);
  const server = createAppServer({ database });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
    db.close();
    for (const file of readdirSync(dir)) unlinkSync(join(dir, file));
    rmdirSync(dir);
  });
  function session(username, password) {
    const identity = store.verifyLogin({ username, password }).id;
    const token = store.createSession(identity);
    return { identity, token, actor: store.getSession(token) };
  }
  const admin = session(credentials.username, credentials.password).actor;
  function seller(name, username) {
    const password = 'history-sales-test!';
    store.openSalesAccount(admin, { name, username });
    activateStoredAccount(store, username, password);
    const result = session(username, password);
    db.prepare("INSERT INTO registry_links VALUES ('sales',?,'',?)").run(name, result.identity);
    return result;
  }
  const a = seller('销售甲', 'history-sales-a'), b = seller('销售乙', 'history-sales-b');
  const broker = store.registerBroker(a.actor, { name: '合成券商', signedOn: today() });
  store.openAccount(admin, { brokerId: broker.id, username: 'history-broker' });
  activateStoredAccount(store, 'history-broker', 'history-broker-test!');
  const channel = session('history-broker', 'history-broker-test!');
  const code = db.prepare('SELECT code FROM brokers WHERE id=?').get(broker.id).code;
  function linkInvestor(name, phone) {
    const identity = store.registerInvestor({ phone, password: 'history-investor-test!' });
    const investor = store.getSession(store.createSession(identity));
    store.renameInvestor(investor, { name });
    db.prepare('UPDATE clients SET name=?,phone=? WHERE id=?').run(name, phone, investor.id);
    store.scan(investor, { code });
    db.prepare("INSERT INTO registry_links VALUES ('investor',?,?,?)").run(name, phone, identity);
  }
  const phone = '19900009001';
  linkInvestor('共同客户', phone);
  db.exec(`CREATE TABLE registry_entries(entry_key TEXT PRIMARY KEY,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
    stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,filed_on TEXT,stage TEXT,progress_stage TEXT,progress_node TEXT);
    CREATE TABLE registry_meta(key TEXT PRIMARY KEY,value TEXT)`);
  let serial = 0;
  const insert = db.prepare("INSERT INTO registry_entries VALUES(?,?,?,?,?,?,?,'合成券商',?,?,?,'','')");
  function entry(key, name, raw, { sales = '销售甲', registered = today(), filed = '' } = {}) {
    const row = ++serial;
    insert.run(key, row, name, name === '共同客户' ? phone : String(19901000000 + row), sales,
      '测试股票' + row, String(row).padStart(6, '0'), registered, filed, raw);
  }
  entry('shared-a', '共同客户', '已立案', { registered: '2020-01-05' });
  entry('shared-a-second', '共同客户', '已结案', { registered: '2020-02-06' });
  entry('shared-b', '共同客户', '未立案', { sales: '销售乙', registered: '2020-02-07' });
  entry('actual-date', '有效日期', '重整债权已申报', { filed: '2020-02-29' });
  entry('unfiled', '尚未立案', '未立案', { filed: '2020-02-29' });
  entry('returned', '已退回', '立案退回', { filed: '2020-02-29' });
  entry('conflict', '冲突待核对', '案件进度待核对', { filed: '2020-02-29' });
  entry('invalid-date', '错误日期', '重整债权已申报', { filed: '2023-02-30' });
  entry('future-date', '未来日期', '重整债权已申报', { filed: '2999-01-01' });
  entry('future-registration', '未来登记', '已结案', { registered: '2999-01-01' });
  entry('corrected', '正式更正', '未立案');
  entry('cleared', '正式清空', '已结案');
  entry('submitted', '仅已提交', '已结案', { filed: '2020-02-29' });
  linkInvestor('尚未立案', db.prepare("SELECT phone FROM registry_entries WHERE entry_key='unfiled'").get().phone);
  store.syncProgress([
    { kind: 'registry', id: 'corrected', revision: 1, stage: 'first_hearing', node: 'awaiting_hearing' },
    { kind: 'registry', id: 'cleared', revision: 1, stage: null, node: null },
    { kind: 'registry', id: 'submitted', revision: 1, stage: 'filing', node: 'submitted' },
  ]);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await fetch(base + '/admin/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function get(path, owner) {
    const headers = owner ? { Authorization: 'Bearer ' + owner.token } : { cookie };
    const response = await fetch(base + path, { headers });
    const data = await response.json();
    assert.equal(response.status, 200, data.message);
    return data;
  }
  const sales = (owner, filter = '') => get('/sales/board?metric=effective' + filter, owner);
  const report = (owner, filter = '') => get('/admin/data?type=signed' + (owner ? '&salesId=' + owner.actor.id : '') + filter);
  const names = result => result.items.map(row => row.title).sort();
  async function verifyBusinessEvidence() {
    const expected = ['共同客户', '有效日期', '正式更正'].sort();
    for (const result of [await sales(a), await report(a), await report()]) {
      assert.deepEqual(names(result), expected);
      assert.equal(result.total, 3);
      assert.ok(result.items.every(row => row.signedOn === ''), '阶段只证明签约，实际签约日期仍空');
    }
    const total = (await get('/admin/overview')).metrics.find(row => row.key === 'signed').value;
    assert.equal(total, expected.length);
    const aCard = (await sales(a)).metrics.find(row => row.key === 'effective').value;
    assert.equal(aCard, expected.length);
    const bBoard = await sales(b);
    assert.equal(bBoard.total, 0);
    assert.equal(bBoard.metrics.find(row => row.key === 'effective').value, 0);
    assert.equal((await report(b)).total, 0, '另一销售同一客户的已立案股票不授予乙签约业绩');
    assert.deepEqual(names(await get('/broker/board?metric=effective', channel)), ['共同客户']);
    const ledger = await get('/records?ledger=signed', channel);
    assert.equal(ledger.total, 3);
    assert.ok(ledger.items.every(row => row.customer === '共同客户'), '只列出券商明确关联且有正式签约证据的客户记录');
    assert.equal(db.prepare('SELECT count(*) AS n FROM signings').get().n, 0);
  }
  await verifyBusinessEvidence();
  assert.deepEqual(names(await sales(a, '&period=month')), ['有效日期', '正式更正'].sort());
  assert.deepEqual(names(await report(a, '&period=month')), ['有效日期', '正式更正'].sort());
  const custom = '&period=custom&from=2020-01-01&to=2020-12-31';
  assert.deepEqual(names(await sales(a, custom)), ['共同客户']);
  assert.deepEqual(names(await report(a, custom)), ['共同客户']);
  const csv = await fetch(base + '/admin/data/export?type=signed&salesId=' + a.actor.id, { headers: { cookie } });
  assert.equal(csv.status, 200);
  const [header, ...lines] = (await csv.text()).trim().split(/\r?\n/).map(line => line.split(',').map(cell => cell.replace(/^"|"$/g, '')));
  assert.equal(lines.length, 3);
  const dateIndex = header.indexOf('实际签约日期');
  assert.ok(dateIndex >= 0);
  assert.ok(lines.every(line => line[dateIndex] === ''));
  assert.deepEqual(lines.map(line => line[header.indexOf('客户')]).sort(), ['共同客户', '有效日期', '正式更正'].sort());
  assert.equal((await get('/broker/board?metric=signings&period=month', channel)).total, 0);
  const sellerHeaders = { Authorization: 'Bearer ' + b.token };
  assert.equal((await fetch(base + '/admin/data?type=signed', { headers: sellerHeaders })).status, 401);
  assert.equal((await fetch(base + '/data?type=signed', { headers: sellerHeaders })).status, 403);
  function simulate(key, stage, node) {
    const target = { kind: 'registry', id: createHash('sha256').update(key).digest('hex') };
    const { revision } = store.adminProgressTest.detail(admin, target);
    store.adminProgressTest.save(admin, { ...target, revision, stage, node });
  }
  simulate('unfiled', 'closure', 'closed');
  await verifyBusinessEvidence();
  simulate('corrected', 'filing', 'preparing');
  await verifyBusinessEvidence();
});
