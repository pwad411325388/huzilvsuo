import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdminSales } from '../admin-sales.mjs';
import { createStore, RequestError } from '../store.mjs';
import { createAppServer } from '../server.mjs';
import { activateStoredAccount } from '../test-support/business-account.mjs';

const admin = { role: 'admin', id: 'admin' };
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE sales_staff(id TEXT,name TEXT);
    CREATE TABLE brokers(id TEXT,name TEXT,salesId TEXT,signedOn TEXT);
    CREATE TABLE identities(id INTEGER,role TEXT,subjectId TEXT,status TEXT,username TEXT,name TEXT);
    CREATE TABLE clients(id TEXT,name TEXT,phone TEXT,brokerId TEXT,createdAt TEXT);
    CREATE TABLE leads(id TEXT,clientId TEXT,stockName TEXT,stockCode TEXT,createdAt TEXT);
    CREATE TABLE lead_assignments(leadId TEXT,salesId TEXT,contactName TEXT,contactPhone TEXT,version INTEGER);
    CREATE TABLE lead_followups(leadId TEXT,salesId TEXT,assignmentVersion INTEGER);
    CREATE TABLE report_numbers(kind TEXT,subjectId TEXT,number INTEGER);
    CREATE TABLE case_numbers(caseId TEXT,number INTEGER);
    CREATE TABLE cases(id TEXT,leadId TEXT,title TEXT,openedOn TEXT,status TEXT);
    CREATE TABLE company_record_progress(kind TEXT,record_id TEXT,stage TEXT,node TEXT,contract_number TEXT);
    CREATE TABLE registry_links(type TEXT,source_name TEXT,source_phone TEXT,identity_id INTEGER);
    CREATE TABLE registry_entries(entry_key TEXT,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
      stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,stage TEXT,progress_stage TEXT,progress_node TEXT);
    CREATE TABLE registry_meta(key TEXT,value TEXT);
    INSERT INTO registry_meta VALUES ('source_name','synthetic.xlsx'),('imported_at','2026-11-19T00:00:00Z');
    INSERT INTO sales_staff VALUES ('a','销售甲'),('b','销售乙');
    INSERT INTO identities VALUES (1,'sales','a','active','sales-a','销售甲'),(2,'sales','b','closed','sales-b','销售乙'),
      (3,'investor','alice','active','alice','甲客户'),(4,'investor','bob','active','bob','乙客户');
    INSERT INTO brokers VALUES ('ba','Alpha','a','2020-01-01'),('bb','Beta','b','2020-01-01');
    INSERT INTO clients VALUES ('alice','甲客户','19900000001','ba','2020-01-01'),('bob','乙客户','19900000002','bb','2020-01-01');
    INSERT INTO leads VALUES ('la','alice','股票甲','000001','2026-11-01T00:00:00Z'),
      ('lb','alice','其他经办股票','000002','2026-11-02T00:00:00Z'),('lc','bob','股票乙','000003','2026-11-03T00:00:00Z');
    INSERT INTO lead_assignments VALUES ('la','a','甲客户','19900000001',2),('lb','b','甲客户','19900000001',1),
      ('lc','a','乙客户','19900000002',1);
    INSERT INTO lead_followups VALUES ('la','a',1),('lc','a',1);
    INSERT INTO report_numbers VALUES ('lead','la',1),('lead','lb',2),('lead','lc',3);
    INSERT INTO cases VALUES ('ka','la','早期结案','2020-01-01','已结案'),('kb','lb','另一销售案件','2026-11-01','已结案'),
      ('kc','lc','在办案件','2026-11-01','诉讼中');
    INSERT INTO case_numbers VALUES ('ka',1),('kb',2),('kc',3);
    INSERT INTO registry_links VALUES ('sales','销售甲','',1),('sales','*销售甲','',1),('sales','销售乙','',2);`);
  const insert = db.prepare('INSERT INTO registry_entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  let serial = 2;
  const entry = (id, options = {}) => insert.run(id, ++serial, options.name ?? '甲客户', options.phone ?? '19900000001',
    options.sales ?? '销售甲', options.stock ?? '历史股票', options.code ?? '000010', options.source ?? 'Ａｌｐｈａ',
    options.date ?? '2025-01-01', options.status ?? '', options.stage ?? '', options.node ?? '');
  const model = createAdminSales(db, { requireValue: (condition, message, status = 400) => {
    if (!condition) throw new RequestError(status, message);
  }, transaction: callback => callback(), today: () => '2026-11-19' });
  return { db, entry, overview: input => model.overview(admin, input), details: input => model.details(admin, { salesId: 'a', ...input }), model };
}

test('后台销售合并经办留资和已关联台账，重复同步不叠加，来源可跨销售且不会生成新券商', t => {
  const { db, entry, overview, details } = fixture(t);
  entry('r1'); entry('r2', { sales: '*销售甲', stock: '第二股票' });
  entry('r3', { phone: '', source: '' }); entry('r4', { phone: '' });
  entry('r5', { sales: '销售乙', name: '乙方历史', phone: '19900000005' });
  entry('r6', { sales: '主任', phone: '19900000006' });
  const first = overview();
  const a = first.rows.find(row => row.id === 'a'), b = first.rows.find(row => row.id === 'b');
  assert.equal(a.recordCount, 6); assert.equal(a.customerCount, 4);
  assert.equal(a.registryRecordCount, 4); assert.equal(a.systemRecordCount, 2);
  assert.equal(a.channelCount, 2); assert.equal(a.channelCustomers, 3);
  assert.equal(a.sourceUnknownCount, 1); assert.equal(a.unverifiedCustomerCount, 2);
  assert.equal(a.unassignedCount, 0);
  assert.doesNotMatch(JSON.stringify(first),/followUnknown|followed|"pending":|跟进/);
  assert.ok(details({metric:'records'}).items.every(row=>!('followStatus' in row) && row.assignmentStatus));
  assert.equal(db.prepare('SELECT count(*) AS n FROM lead_followups').get().n,2);
  assert.equal(b.registryRecordCount, 1); assert.equal(b.status, '已注销', '后台保留注销销售历史关系');
  assert.deepEqual(first.meta, { registryTotal: 6, registryLinked: 5, registryUnlinked: 1,
    registrySourceTotal: 6, futureRegistryCount: 0, sourceName: 'synthetic.xlsx', importedAt: '2026-11-19T00:00:00Z', today: '2026-11-19' });
  assert.deepEqual(overview(), first, '只读聚合不重复生成业务行');
  assert.equal(db.prepare('SELECT count(*) AS n FROM brokers').get().n, 2);
  const source = a.sources.find(row => row.name === 'Alpha');
  assert.equal(source.origin, 'mixed'); assert.equal(source.recordCount, 4); assert.equal(source.customerCount, 2);
  assert.equal(details({ metric: 'customers', sourceKey: '__known__' }).total, a.channelCustomers);
  assert.equal(details({ metric: 'records', sourceKey: '__unknown__' }).total, a.sourceUnknownCount);
  assert.equal(details({ metric: 'records', sourceKey: source.key }).total, source.recordCount);
  assert.equal(details({ metric: 'records', salesId: '__unlinked__' }).total, 1);
  db.exec("UPDATE registry_links SET identity_id=2 WHERE type='sales' AND source_name='*销售甲'");
  assert.equal(overview().rows.find(row => row.id === 'a').registryRecordCount, 3);
  db.exec("DELETE FROM registry_entries WHERE entry_key='r1'");
  assert.equal(overview().rows.find(row => row.id === 'a').recordCount, 4);
});

test('客户去重身份优先，缺号保持待核，明确不同账号不会因姓名电话一致而误合并', t => {
  const { db, entry, overview, details } = fixture(t);
  entry('r1', { phone: '' }); entry('r2', { phone: '' });
  assert.equal(overview().rows.find(row => row.id === 'a').customerCount, 4);
  db.exec("INSERT INTO registry_links VALUES ('investor','甲客户','',3)");
  assert.equal(overview().rows.find(row => row.id === 'a').customerCount, 2);
  db.exec(`INSERT INTO identities VALUES (5,'investor','other','active','other','甲客户');
    INSERT INTO clients VALUES ('other','甲客户','19900000001','ba','2020-01-01');
    INSERT INTO leads VALUES ('other-lead','other','另一身份股票','000099','2026-11-03T00:00:00Z');
    INSERT INTO lead_assignments VALUES ('other-lead','a','甲客户','19900000001',1);`);
  entry('ambiguous');
  assert.equal(details({ metric: 'customers' }).total, 4);
  assert.equal(details({ metric: 'customers', q: '19900000001' }).total, 3);
});

test('在办与结案采用明确当前证据，同客户的其他经办案件不会混入，显式清空不回退旧状态', t => {
  const { db, entry, overview, details } = fixture(t);
  entry('closed', { status: '已结案', stage: 'closure', node: 'closed' });
  entry('cleared', { status: '已结案', stage: 'closure', node: 'closed' });
  entry('filed', { status: '已立案未开庭' });
  entry('unfiled', { status: '未立案' });
  entry('unknown');
  entry('filing', { status: '已结案' });
  db.exec("INSERT INTO company_record_progress VALUES ('registry','cleared','','','secret-contract'),('registry','filing','filing','preparing','secret-contract')");
  const a = overview().rows.find(row => row.id === 'a');
  assert.equal(a.closed, 2, '包含旧系统案件和明确历史结案');
  assert.equal(a.ongoing, 2); assert.equal(a.unknownCaseCount, 2); assert.equal(a.otherCaseCount, 2);
  assert.equal(details({ metric: 'closed' }).total, a.closed);
  assert.equal(details({ metric: 'ongoing' }).total, a.ongoing);
  assert.equal(details({ metric: 'unknown' }).total, a.unknownCaseCount);
  assert.equal(details({ metric: 'other' }).total, a.otherCaseCount);
  assert.ok(!JSON.stringify(details({ metric: 'closed' })).includes('另一销售案件'));
  assert.ok(!JSON.stringify(details({ metric: 'records' })).includes('secret-contract'));
  assert.ok(details({ metric: 'closed' }).items.some(row => row.number === 'AJ-000001'));
});

test('20条分页、分类总数与明细同集合，字面搜索和来源过滤不泄露内部字段', t => {
  const { entry, overview, details } = fixture(t);
  for (let n = 0; n < 45; n++) entry('page-' + n, { name: '分页客户' + n, phone: '1990000' + String(1000 + n),
    source: n % 2 ? 'Alpha' : 'Beta', status: '已结案' });
  entry('literal', { name: '百分%股', phone: '' });
  const a = overview().rows.find(row => row.id === 'a');
  for (const [metric, field] of [['channels', 'channelCount'], ['records', 'recordCount'], ['customers', 'customerCount'], ['ongoing', 'ongoing'], ['closed', 'closed']]) {
    assert.equal(details({ metric }).total, a[field]);
  }
  const first = details(), second = details({ offset: 20 }), last = details({ offset: 999999 });
  assert.equal(first.items.length, 20); assert.equal(second.items.length, 20);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 40);
  assert.equal(last.offset, 40); assert.equal(last.items.length, 8);
  assert.equal(details({ q: '%' }).total, 1); assert.equal(details({ q: '19900001001' }).total, 1);
  assert.equal(details({ origin: 'registry' }).total, 46);
  assert.equal(details({ origin: 'system' }).total, 2);
  assert.ok(first.items.every(row => !['internalId', 'identity', 'personKey', 'searchText'].some(field => field in row)));
  assert.ok(first.items.every(row => /^(LZ|DJ)-\d+/.test(row.number)));
});

test('截至今天的来源元数据与未关联明细一致，未来记录单列，不纳入当前汇总', t => {
  const { entry, overview, details } = fixture(t);
  entry('unknown-date', { sales: '主任', date: '' });
  entry('today', { sales: '主任', date: '2026-11-19' });
  entry('future', { sales: '主任', date: '2026-11-20' });
  entry('linked-future', { date: '2026-11-20' });
  const result = overview();
  assert.equal(result.meta.registrySourceTotal, 4);
  assert.equal(result.meta.registryTotal, 2); assert.equal(result.meta.registryLinked, 0);
  assert.equal(result.meta.registryUnlinked, 2); assert.equal(result.meta.futureRegistryCount, 2);
  assert.equal(details({ salesId: '__unlinked__' }).total, result.meta.registryUnlinked);
});

test('输入受校验，未导入台账仍可读取系统记录，管理员改密前及其他角色不能访问', t => {
  const { db, details, overview, model } = fixture(t);
  for (const input of [{ salesId: 'missing' }, { metric: 'bad' }, { offset: -1 }, { offset: '1.1' }, { offset: '9007199254740992' },
    { origin: 'bad' }, { sourceKey: 'bad' }, { q: 'x'.repeat(101) }]) assert.throws(() => details(input));
  for (const actor of [{ role: 'sales' }, { role: 'broker' }, { role: 'investor' }, { ...admin, passwordChangeRequired: true }]) {
    assert.throws(() => model.overview(actor), error => error.status === 403);
    assert.throws(() => model.details(actor, { salesId: 'a' }), error => error.status === 403);
  }
  db.exec('DROP TABLE registry_entries');
  assert.equal(overview().meta.registryTotal, 0); assert.equal(details().total, 2);
});

test('后台销售汇总HTTP接口校验角色和独立后台会话，旧销售及券商接口继续可用', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-sales-')), path = join(dir, 'fixture.sqlite');
  const credentials = { username: 'report-admin', password: 'fictional-admin', name: '测试管理员' };
  const store = createStore(path, { seed: true, admin: credentials });
  const actor = store.getSession(store.createSession(store.verifyLogin(credentials).id));
  store.openSalesAccount(actor, { salesId: 'sales-a', name: '测试销售', username: 'report-sales' });
  activateStoredAccount(store, 'report-sales', 'fictional-sales');
  activateStoredAccount(store, 'broker-a', 'fictional-broker');
  const tokens = ['report-sales', 'broker-a'].map((username, i) => store.createSession(store.verifyLogin({ username, password: i ? 'fictional-broker' : 'fictional-sales' }).id));
  const server = createAppServer({ database: path });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); unlinkSync(path); rmdirSync(dir); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const overview = await fetch(base + '/api/admin/sales/overview', { headers: { cookie } });
  assert.equal(overview.status, 200);
  assert.ok(Array.isArray((await overview.json()).rows));
  assert.equal((await fetch(base + '/api/admin/sales/details?salesId=sales-a', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(base + '/api/sales/overview')).status, 401);
  for (const token of tokens) {
    const headers = { Authorization: 'Bearer ' + token };
    assert.equal((await fetch(base + '/api/sales/overview', { headers })).status, 403);
    assert.equal((await fetch(base + '/api/sales/details?salesId=sales-a', { headers })).status, 403);
    assert.equal((await fetch(base + '/api/view', { headers })).status, 200);
  }
  assert.equal((await fetch(base + '/api/sales/board', { headers: { Authorization: 'Bearer ' + tokens[0] } })).status, 200);
});

test('股票测试快照切换及恢复贯穿后台、销售和股民当前进度，不生成案件或泄露临时字段', t => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-progress-readers-')), path = join(dir, 'fixture.sqlite');
  const store = createStore(path, { seed: true, cutoff: '2000-01-01', progressTestEnabled:true });
  const db = new DatabaseSync(path);
  t.after(() => { store.close(); db.close(); unlinkSync(path); rmdirSync(dir); });
  const sales = { role: 'sales', id: 'sales-b' }, investor = { role: 'investor', id: 'customer-b' };
  db.prepare("UPDATE lead_assignments SET salesId='sales-b' WHERE leadId='lead-demo-b'").run();
  const cases = () => store.adminSales.recordsReport(admin, { type: 'cases' }).total;
  const initialCases = cases(), databaseCases = db.prepare('SELECT count(*) AS n FROM cases').get().n;
  const report = input => store.adminSales.recordsReport(admin, { type: 'records', q: '示例股票乙', ...input });
  function verify(expected, group) {
    const row = report().items[0];
    assert.equal(row.caseStatus, expected);
    assert.equal(report({ status: group }).total, 1, '股票筛选应按股票当前进度');
    assert.equal(store.adminSales.details(admin, { salesId: sales.id, metric: 'records' }).items[0].caseStatus, expected);
    for (const actor of [sales, investor]) {
      assert.equal(store.userRecords(actor, { q: '示例股票乙' }).items[0].status, expected);
      assert.equal(store.progress(actor, { kind: 'lead', id: 'lead-demo-b' }).current.label, expected);
    }
    assert.equal(cases(), initialCases, '股票节点不改变真实案件统计');
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, databaseCases);
    assert.ok(!['testing','hasSnapshot','progressStage','progressNode','completedNodes','nextState','sourceStatus'].some(field => field in row));
  }
  verify('已留资', 'other');
  const selected = {kind:'lead',id:'lead-demo-b'};
  let detail = store.adminProgressTest.detail(admin,selected);
  for (const [stage,node,expected,group] of [
    ['intake','signed_waiting_filing','已签约','other'],
    ['filing','preparing','立案材料准备中','other'],
    ['first_hearing','awaiting_hearing','一审待开庭','ongoing'],
    ['closure','closed','已结案','closed'],
  ]) {
    detail = store.adminProgressTest.save(admin,{...selected,revision:detail.revision,stage,node});
    assert.equal(detail.testing,true);
    verify(expected, group);
  }
  detail = store.adminProgressTest.restore(admin,{...selected,revision:detail.revision});
  assert.equal(detail.testing,false);
  verify('已留资', 'other');
});

test('后台股票采用与详情相同的同日案件排序，自有测试快照优先且关闭测试后恢复证据保护', t => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-case-readers-')), path = join(dir, 'fixture.sqlite');
  const store = createStore(path, { seed: true, cutoff: '2000-01-01', progressTestEnabled:true });
  const db = new DatabaseSync(path);
  t.after(() => { store.close(); db.close(); unlinkSync(path); rmdirSync(dir); });
  const actor = { role: 'sales', id: 'sales-a' };
  db.prepare("UPDATE lead_assignments SET salesId='sales-a' WHERE leadId='lead-demo-a'").run();
  const report = input => store.adminSales.recordsReport(admin, { type:'records', q:'示例股票甲', ...input });
  store.syncProgress([
    {kind:'case',id:'case-demo-1',revision:1,stage:'first_hearing',node:'awaiting_hearing'},
    {kind:'case',id:'case-demo-2',revision:1,stage:'closure',node:'closed'},
  ]);
  assert.equal(report().items[0].caseStatus, '一审待开庭');
  assert.equal(report().items[0].caseStatus, store.progress(actor, {kind:'lead',id:'lead-demo-a'}).current.label);
  assert.equal(report({status:'closed'}).total, 0, '旧子案结案不把当前一审的股票放入结案筛选');
  assert.equal(store.adminSales.recordsReport(admin, {type:'cases',q:'示例股票甲',status:'closed'}).total, 1);
  store.syncProgress([{kind:'lead',id:'lead-demo-a',revision:1,stage:'intake',node:'signed_waiting_filing'}]);
  const selected = {kind:'lead',id:'lead-demo-a'};
  const before = store.adminProgressTest.detail(admin,selected);
  const testing = store.adminProgressTest.save(admin,{...selected,revision:before.revision,stage:'intake',node:'signed_waiting_filing'});
  assert.equal(report().items[0].caseStatus, '已签约');
  assert.equal(store.progress(actor, {kind:'lead',id:'lead-demo-a'}).current.node, 'signed_waiting_filing');
  store.adminProgressTest.restore(admin,{...selected,revision:testing.revision});
  assert.equal(store.progress(actor, {kind:'lead',id:'lead-demo-a'}).current.node, 'signed');
  assert.equal(report().items[0].caseStatus, store.userRecords(actor, {q:'示例股票甲'}).items[0].status);
  assert.equal(db.prepare("SELECT testing,revision FROM company_record_progress WHERE kind='lead' AND record_id='lead-demo-a'").get().testing,0);
});
