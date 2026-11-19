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
const counts = result => Object.fromEntries(result.metrics.map(row => [row.key, row.value]));
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE sales_staff(id TEXT,name TEXT);
    CREATE TABLE brokers(id TEXT,name TEXT,salesId TEXT,signedOn TEXT);
    CREATE TABLE identities(id INTEGER,role TEXT,subjectId TEXT,status TEXT,username TEXT,name TEXT);
    CREATE TABLE clients(id TEXT,name TEXT,phone TEXT,brokerId TEXT,createdAt TEXT);
    CREATE TABLE leads(id TEXT,clientId TEXT,stockName TEXT,stockCode TEXT,createdAt TEXT);
    CREATE TABLE lead_assignments(leadId TEXT,salesId TEXT,contactName TEXT,contactPhone TEXT,version INTEGER,legacy INTEGER);
    CREATE TABLE lead_followups(leadId TEXT,salesId TEXT,assignmentVersion INTEGER);
    CREATE TABLE report_numbers(kind TEXT,subjectId TEXT,number INTEGER);
    CREATE TABLE case_numbers(caseId TEXT,number INTEGER);
    CREATE TABLE cases(id TEXT,leadId TEXT,title TEXT,openedOn TEXT,status TEXT);
    CREATE TABLE signings(clientId TEXT,signedOn TEXT);
    CREATE TABLE company_record_progress(kind TEXT,record_id TEXT,stage TEXT,node TEXT,contract_number TEXT,completed_nodes TEXT);
    CREATE TABLE registry_links(type TEXT,source_name TEXT,source_phone TEXT,identity_id INTEGER);
    CREATE TABLE registry_entries(entry_key TEXT,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
      stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,stage TEXT,progress_stage TEXT,progress_node TEXT);
    CREATE TABLE registry_meta(key TEXT,value TEXT);
    INSERT INTO registry_meta VALUES ('source_name','synthetic.xlsx'),('imported_at','2026-11-19T00:00:00Z');
    INSERT INTO sales_staff VALUES ('a','销售甲'),('b','销售乙'),('c','销售丙');
    INSERT INTO identities VALUES (1,'sales','a','active','sales-a','销售甲'),(2,'sales','b','closed','sales-b','销售乙'),
      (3,'investor','alice','active','alice','甲客户'),(4,'investor','bob','active','bob','乙客户');
    INSERT INTO brokers VALUES ('ba','Alpha','a','2020-01-01'),('bb','Beta','b','2020-01-01'),('bc','本月空渠道','a','2026-11-19');
    INSERT INTO clients VALUES ('alice','甲客户','19900000001','ba','2020-01-01'),('bob','乙客户','19900000002','bb','2020-01-01');
    INSERT INTO leads VALUES ('la','alice','股票甲','000001','2026-11-01T00:00:00Z'),
      ('lb','alice','其他经办股票','000002','2026-11-02T00:00:00Z'),('lc','bob','股票乙','000003','2026-11-03T00:00:00Z');
    INSERT INTO lead_assignments VALUES ('la','a','甲客户','19900000001',2,0),('lb','b','甲客户','19900000001',1,1),
      ('lc','c','乙客户','19900000002',1,0);
    INSERT INTO lead_followups VALUES ('la','a',1);
    INSERT INTO report_numbers VALUES ('lead','la',1),('lead','lb',2),('lead','lc',3);
    INSERT INTO cases VALUES ('ka','la','早期结案','2020-01-01','已结案'),('kb','lb','另一销售案件','2026-11-01','已结案'),
      ('kc','lc','在办案件','2026-11-01','诉讼中');
    INSERT INTO case_numbers VALUES ('ka',1),('kb',2),('kc',3);
    INSERT INTO registry_links VALUES ('sales','销售甲','',1),('sales','*销售甲','',1),('sales','销售乙','',2);
    INSERT INTO signings VALUES ('alice','2020-01-01');`);
  const insert = db.prepare('INSERT INTO registry_entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  let serial = 2;
  const entry = (id, options = {}) => insert.run(id, ++serial, options.name ?? '甲客户', options.phone ?? '19900000001',
    options.sales ?? '销售甲', options.stock ?? '历史股票', options.code ?? '000010', options.source ?? 'Ａｌｐｈａ',
    options.date ?? '2025-01-01', options.status ?? '', options.stage ?? '', options.node ?? '');
  const model = createAdminSales(db, { requireValue: (condition, message, status = 400) => {
    if (!condition) throw new RequestError(status, message);
  }, transaction: callback => callback(), today: () => '2026-11-19' });
  return { db, entry, model, board: input => model.platformBoard(admin, input) };
}

test('总览复用全部历史与系统数据，八卡和明细一致，未知跟进不等于待分配', t => {
  const { db, entry, board } = fixture(t);
  entry('r1', { status: '已立案未开庭' });
  entry('r2', { sales: '*销售甲', stock: '第二股票', status: '已结案' });
  entry('r3', { sales: '主任', name: '待关联客户', phone: '19900000003', source: '历史渠道' });
  entry('r4', { sales: '销售乙', name: '注销销售客户', phone: '19900000004', source: '历史渠道' });
  const result = board();
  assert.deepEqual(counts(result), { records: 7, customers: 4, channels: 4, pending: 4, ongoing: 2, closed: 3, registry: 4, signed: 1 });
  for (const metric of result.metrics) assert.equal(board({ metric: metric.key }).total, metric.value, metric.key);
  assert.deepEqual(result.queues.map(row => row.value), [1, 1, 2]);
  for (const queue of result.queues) assert.equal(board({ metric: 'pending', queue: queue.key }).total, queue.value);
  assert.equal(board({ metric: 'pending', queue: 'registry_unlinked' }).items.length, 2);
  assert.equal(result.meta.registryTotal, 4); assert.equal(result.meta.registryUnlinked, 1);
  assert.equal(result.meta.registryLinked, 3); assert.equal(result.meta.registryCount, 4);
  assert.equal(result.meta.systemRecordCount, 3); assert.equal(result.recent.length, 6);
  assert.deepEqual(result, board(), '重复读取不会创建渠道、客户或业务记录');
  assert.equal(db.prepare('SELECT count(*) AS n FROM brokers').get().n, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM clients').get().n, 2);
  assert.ok(board({ metric: 'closed' }).items.some(row => row.number === 'AJ-000001'), '旧案件计入累计，按留资日期取范围');
});

test('平台跨销售全局去重，完整身份优先，冲突账号及缺少姓名电话的档案不误合并', t => {
  const { db, entry, board, model } = fixture(t);
  entry('across-sales', { sales: '销售乙', date: '2025-05-01' });
  entry('unknown-one', { phone: '', sales: '主任' });
  entry('unknown-two', { phone: '', sales: '主任' });
  assert.equal(counts(board()).customers, 4);
  const alice = board({ metric: 'customers', q: '19900000001' });
  assert.equal(alice.total, 1); assert.equal(alice.items[0].recordCount, 3);
  assert.equal(alice.items[0].sales, '销售甲、销售乙');
  assert.equal(board({ metric: 'customers', period: 'custom', from: '2025-01-01', to: '2025-12-31', q: '19900000001' }).items[0].id,
    alice.items[0].id, '先全局核对身份再筛日期，不能因隐藏有身份的记录而换档案ID');
  assert.ok(model.overview(admin).rows.reduce((sum, row) => sum + row.customerCount, 0) > counts(board()).customers - 2,
    '不能简单相加各销售的客户数');
  db.exec(`INSERT INTO identities VALUES (5,'investor','other','active','other','甲客户');
    INSERT INTO clients VALUES ('other','甲客户','19900000001','ba','2020-01-01');
    INSERT INTO leads VALUES ('other-lead','other','另一身份股票','000099','2026-11-03T00:00:00Z');
    INSERT INTO lead_assignments VALUES ('other-lead','a','甲客户','19900000001',1,0);`);
  const conflicted = board({ metric: 'customers', q: '19900000001' });
  assert.equal(conflicted.total, 3, '两个明确不同账号和无法决定归属的历史档案分开');
  assert.equal(counts(board()).customers, 6);
  db.exec("INSERT INTO registry_links VALUES ('investor','甲客户','',3)");
  assert.equal(counts(board()).customers, 4, '明确关联可以合并缺手机号的历史档案');
});

test('全部、本月及自选日期按上海登记日期含边界筛选，未来和无日期有明确口径', t => {
  const { db, entry, board } = fixture(t);
  entry('previous', { name: '前月客户', date: '2026-10-31T15:59:59Z' });
  entry('month-start', { name: '月初客户', date: '2026-10-31T16:00:00Z', status: '诉讼中', source: '月初来源' });
  entry('today-end', { name: '今天客户', date: '2026-11-19T15:59:59Z', status: '已结案' });
  entry('future', { name: '未来客户', date: '2026-11-19T16:00:00Z' });
  entry('unknown-date', { name: '无日期客户', date: '', source: '无日期来源' });
  entry('invalid-date', { name: '无效日期客户', date: '2026-02-30' });
  db.exec("INSERT INTO brokers VALUES ('bf','未来空渠道','a','2026-11-20')");
  const all = board(), month = board({ period: 'month' });
  assert.equal(counts(all).records, 8); assert.equal(counts(month).records, 5);
  assert.equal(all.meta.registrySourceTotal, 6); assert.equal(all.meta.registryTotal, 5);
  assert.equal(all.meta.futureRegistryCount, 1); assert.equal(all.meta.unknownDateCount, 2);
  assert.deepEqual([month.from, month.to, month.today], ['2026-11-01', '2026-11-19', '2026-11-19']);
  assert.equal(month.meta.registryCount, 2); assert.equal(month.meta.registryTotal, 5);
  assert.equal(counts(month).ongoing, 2); assert.equal(counts(month).closed, 3);
  assert.ok(!JSON.stringify(all.items).includes('未来客户'));
  assert.ok(!JSON.stringify(board({ metric: 'channels' }).items).includes('未来空渠道'));
  assert.ok(!JSON.stringify(month.items).includes('无日期客户'));
  assert.ok(all.notes.some(note => note.includes('2 条记录缺少有效登记日期')));
  const first = board({ period: 'custom', from: '2026-11-01', to: '2026-11-01' });
  assert.equal(counts(first).records, 2); assert.equal(counts(first).closed, 1, '旧案件按关联留资日期而非建案日');
  assert.equal(counts(first).ongoing, 1);
  assert.ok(first.items.every(row => row.registeredOn === '2026-11-01'));
  assert.equal(board({ period: 'custom', from: '2026-11-19', to: '2026-11-19' }).total, 1);
  assert.equal(board({ period: 'custom', from: '2026-10-01', to: '2026-10-31' }).total, 1);
  assert.ok(month.recent.every(row => row.registeredOn >= month.from && row.registeredOn <= month.to));
});

test('签约只依据真实签约或明确同步节点，不从结案、立案或合同文字推定，日期范围展示当前状态', t => {
  const { db, entry, board } = fixture(t);
  const unique = (id, options = {}) => entry(id, { name: id, phone: '', ...options });
  unique('closed-only', { status: '已结案' }); unique('filed-only', { status: '已立案未开庭' });
  unique('contract-only'); unique('signed-import', { stage: 'intake', node: 'signed' });
  unique('signed-snapshot'); unique('completed-snapshot');
  unique('cleared', { stage: 'intake', node: 'signed_waiting_filing' });
  unique('invalid-completed');
  entry('alice-old-record', { date: '2025-05-10' });
  db.exec(`INSERT INTO company_record_progress VALUES
    ('registry','contract-only','','','signed-contract','[]'),
    ('registry','signed-snapshot','intake','signed_waiting_filing','secret','[]'),
    ('registry','completed-snapshot','intake','lead_received','secret','["signed"]'),
    ('registry','cleared','','','secret','[]'),
    ('registry','invalid-completed','intake','lead_received','secret','broken-json');
    INSERT INTO signings VALUES ('bob','2026-11-20');`);
  let signed = board({ metric: 'signed' });
  assert.equal(signed.total, 4); assert.ok(signed.items.every(row => row.status === '已签约'));
  assert.equal(signed.items.find(row => row.title === '甲客户').signedOn, '2020-01-01');
  assert.equal(signed.items.find(row => row.title === 'signed-import').signedOn, '', '无证据的真实签约日不编造');
  assert.equal(board({ metric: 'signed', period: 'custom', from: '2025-05-10', to: '2025-05-10' }).total, 1,
    '按期间登记客户集合展示现在的签约状态，不按签约日期筛选');
  assert.equal(board({ metric: 'signed', period: 'month' }).total, 1);
  db.exec("INSERT INTO company_record_progress VALUES ('case','kc','intake','signed','secret','[]')");
  signed = board({ metric: 'signed' });
  assert.equal(signed.total, 5, '系统案件明确同步签约可回连客户');
  assert.ok(!JSON.stringify(signed).includes('secret'));
  assert.ok(!signed.items.some(row => row.title === 'closed-only' || row.title === 'filed-only' || row.title === 'cleared'));
});

test('分页搜索遵循选定期间且不改变卡片数量，返回可读编号及有限公共字段', t => {
  const { entry, board } = fixture(t);
  for (let n = 0; n < 45; n++) entry('page-' + n, { name: '分页客户' + n, phone: '1990000' + String(1000 + n),
    source: n % 2 ? 'Alpha' : 'Beta', date: '2026-11-01', status: '已结案' });
  entry('literal', { name: '百分%股', phone: '', date: '2025-01-01' });
  const first = board(), second = board({ offset: 20 }), last = board({ offset: 999999 });
  assert.equal(first.total, 49); assert.equal(first.items.length, 20); assert.equal(second.items.length, 20);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 40);
  assert.equal(last.offset, 40); assert.equal(last.items.length, 9);
  assert.equal(board({ q: '%' }).total, 1); assert.equal(board({ q: '%', period: 'month' }).total, 0);
  const searched = board({ q: '19900001001' });
  assert.equal(searched.total, 1); assert.deepEqual(searched.metrics, first.metrics);
  assert.equal(board({ metric: 'customers', q: '其他经办股票' }).items[0].recordCount, 2);
  for (const row of [...first.items, ...board({ metric: 'pending' }).items, ...board({ metric: 'customers' }).items]) {
    assert.ok(!['internalId', 'identity', 'clientId', 'salesId', 'personKey', 'searchText', '_signed', '_legacy', '_needsAssociation'].some(field => field in row));
  }
  assert.ok(first.items.every(row => /^(LZ|DJ)-\d+/.test(row.number)));
  assert.equal(board({ q: 'not-found', offset: 20 }).offset, 0);
});

test('总览严格校验日期、分类和分页，限制管理员且支持尚未导入历史数据的环境', t => {
  const { db, board, model } = fixture(t);
  for (const input of [{ period: 'bad' }, { metric: 'bad' }, { queue: 'bad' }, { q: 'x'.repeat(101) },
    { offset: -1 }, { offset: '1.5' }, { offset: '9007199254740992' },
    { period: 'custom' }, { period: 'custom', from: '2026-02-30', to: '2026-03-01' },
    { period: 'custom', from: '2026-11-01T00:00:00Z', to: '2026-11-19' },
    { period: 'custom', from: '2026-11-19', to: '2026-11-18' }, { period: 'custom', from: '2026-11-19', to: '2026-11-20' }]) {
    assert.throws(() => board(input), error => error.status === 400, JSON.stringify(input));
  }
  for (const actor of [{ role: 'sales' }, { role: 'broker' }, { role: 'investor' }, { ...admin, passwordChangeRequired: true }]) {
    assert.throws(() => model.platformBoard(actor), error => error.status === 403);
  }
  db.exec('DROP TABLE registry_entries');
  assert.equal(board().total, 3); assert.equal(counts(board()).registry, 0);
});

test('渠道、客户案件、报表共享总览全源集合，状态筛选和跨入口不丢失历史记录', t => {
  const { db, entry, board, model } = fixture(t);
  const report = input => model.recordsReport(admin, input);
  entry('ongoing', { status: '已立案未开庭', source: '历史合作渠道', sales: '主任' });
  entry('closed', { status: '已结案', source: '历史合作渠道' });
  entry('other', { status: '未立案', source: '' });
  entry('unknown', { source: '' });
  const total = counts(board());
  for (const type of ['records', 'customers', 'channels', 'signed']) assert.equal(report({ type }).total, total[type]);
  assert.equal(report({ type: 'cases' }).total, 7);
  assert.equal(report({ type: 'cases', status: 'ongoing' }).total, total.ongoing);
  assert.equal(report({ type: 'cases', status: 'closed' }).total, total.closed);
  assert.equal(report({ type: 'cases', status: 'unknown' }).total, 1);
  assert.equal(report({ type: 'cases', status: 'other' }).total, 1);
  const channels = report({ type: 'channels' });
  const source = channels.items.find(row => row.title === '历史合作渠道');
  assert.equal(source.recordCount, 2); assert.equal(source.ongoing, 1); assert.equal(source.closed, 1);
  assert.equal(source.sales, '主任、销售甲');
  assert.equal(report({ type: 'records', sourceKey: source.sourceKey }).total, source.recordCount);
  assert.equal(report({ type: 'cases', sourceKey: source.sourceKey, status: 'ongoing' }).total, source.ongoing);
  assert.equal(report({ type: 'records', sourceKey: '__unknown__' }).total, 2);
  assert.equal(report({ type: 'records', salesId: '__unlinked__' }).total, 1);
  assert.equal(report({ type: 'records', origin: 'registry' }).total, 4);
  assert.equal(report({ type: 'records', origin: 'system' }).total, 3);
  assert.equal(report({ type: 'records', period: 'month' }).total, counts(board({ period: 'month' })).records);
  assert.equal(report({ type: 'customers', status: 'signed' }).total, total.signed);
  assert.equal(report({ type: 'customers', status: 'unsigned' }).total, total.customers - total.signed);
  assert.ok(channels.filters.sources.some(row => row.key === '__unknown__'));
  assert.ok(channels.filters.sales.some(row => row.id === '__unlinked__'));
  assert.ok(channels.columns.every(column => column.key && column.label));
  const sales = report({ type: 'sales' });
  assert.equal(sales.items.reduce((sum, row) => sum + row.recordCount, 0), total.records);
  assert.equal(sales.items.find(row => row.id === '__unlinked__').recordCount, 1);
  assert.ok(sales.definition.includes('不能直接相加'));
  db.exec("INSERT INTO leads VALUES ('no-case','alice','尚未建案股票','000999','2026-11-10')");
  const noCase = report({ type: 'records', origin: 'system', status: 'other' });
  assert.equal(noCase.total, 1); assert.equal(noCase.items[0].caseStatus, '尚未建案');
  assert.equal(model.recordsReport(admin, { type: 'records', origin: 'system', status: 'other' }, true).total, 1);
  assert.equal(report({ type: 'cases', origin: 'system', status: 'other' }).total, 0, '未建案记录可检索但不伪造案件');
});

test('数据报表导出使用同筛选全量记录，分页不截断导出，客户多股票搜索保留全档案', t => {
  const { entry, model } = fixture(t);
  const input = { type: 'records', origin: 'registry', q: '历史%' };
  for (let n = 0; n < 45; n++) entry('export-' + n, { name: '历史%' + n, phone: '', date: '2025-08-01' });
  entry('not-matching', { name: '其他', phone: '', date: '2026-11-01' });
  const page = model.recordsReport(admin, input), exported = model.recordsReport(admin, { ...input, offset: 20 }, true);
  assert.equal(page.total, 45); assert.equal(page.items.length, 20);
  assert.equal(exported.total, page.total); assert.equal(exported.items.length, 45); assert.equal(exported.offset, 0);
  assert.deepEqual(exported.items.slice(0, 20), page.items);
  assert.equal(model.recordsReport(admin, { ...input, period: 'month' }, true).items.length, 0);
  const customer = model.recordsReport(admin, { type: 'customers', q: '其他经办股票' });
  assert.equal(customer.total, 1); assert.equal(customer.items[0].recordCount, 2);
  for (const input of [{ type: 'bad' }, { type: 'channels', status: 'closed' }, { origin: 'bad' }, { sourceKey: 'bad' },
    { salesId: 'missing' }, { type: 'cases', status: 'signed' }]) assert.throws(() => model.recordsReport(admin, input));
  assert.throws(() => model.recordsReport({ role: 'broker' }, {}, true), error => error.status === 403);
});

test('销售摘要先正常再待开户最后注销，同组按档案量排序，分页和全量导出不丢注销记录', t => {
  const { db, entry, model } = fixture(t);
  for (let n = 0; n < 24; n++) {
    const id = 'sort-sales-' + String(n).padStart(2, '0'), label = '来源销售' + n;
    db.prepare('INSERT INTO sales_staff VALUES (?,?)').run(id, '同名销售');
    if (n === 1) continue;
    db.prepare('INSERT INTO identities VALUES (?,?,?,?,?,?)').run(100 + n, 'sales', id, n === 0 ? 'closed' : 'active', 'order-sales-' + n, '同名销售');
    db.prepare('INSERT INTO registry_links VALUES (?,?,?,?)').run('sales', label, '', 100 + n);
    entry('sorting-' + n, { sales: label, name: '客户' + n, phone: '1990001' + String(n).padStart(4, '0') });
    if (n === 0) for (let j = 0; j < 20; j++) entry('closed-big-' + j, { sales: label, name: '注销名下' + j, phone: '1990002' + String(j).padStart(4, '0') });
    if (n === 2) for (let j = 0; j < 2; j++) entry('repeat-' + j, { sales: label, name: '客户2', phone: '19900010002', stock: '重复客户股票' + j });
    if (n === 3) entry('second-customer', { sales: label, name: '另一客户', phone: '19900019999' });
  }
  const exported = model.recordsReport(admin, { type: 'sales' }, true);
  assert.equal(exported.total, 27);
  assert.deepEqual(exported.items.slice(0, 2).map(row => row.id), ['sort-sales-03','sort-sales-02'], '客户档案数优先于重复登记条数');
  assert.ok(exported.items.slice(0, 23).every(row => row.status === '正常'));
  assert.ok(exported.items.slice(23, 25).every(row => row.status === '待开户'));
  assert.ok(exported.items.slice(25).every(row => row.status === '已注销'));
  assert.equal(exported.items.find(row => row.id === 'sort-sales-00').recordCount, 21, '注销销售的大量业务仍完整保留');
  const first = model.recordsReport(admin, { type: 'sales' }), second = model.recordsReport(admin, { type: 'sales', offset: 20 });
  assert.deepEqual([...first.items, ...second.items], exported.items);
  assert.deepEqual(model.overview(admin).rows.map(row => row.id), exported.items.map(row => row.id));
  assert.match(first.orderLabel, /已注销在后/);
});

test('来源按有效、待开户、仅注销分组，历史同名来源仍有效，分页和导出顺序一致', t => {
  const { db, entry, board, model } = fixture(t);
  db.exec("INSERT INTO identities VALUES (11,'broker','ba','active','alpha','Alpha'),(12,'broker','bb','closed','beta','Beta')");
  for (let n = 0; n < 23; n++) entry('source-order-' + n, { name: '来源客户' + n, phone: '', source: '历史来源' + n });
  let all = model.recordsReport(admin, { type: 'channels' }, true);
  assert.equal(all.total, 26);
  assert.equal(all.items.at(-1).title, 'Beta'); assert.equal(all.items.at(-1).status, '券商已注销');
  assert.equal(all.items.at(-2).title, '本月空渠道'); assert.equal(all.items.at(-2).status, '券商待开户');
  assert.ok(all.items.slice(0, -2).every(row => row.sourceStatus === 'active'));
  assert.deepEqual([...model.recordsReport(admin, { type: 'channels' }).items,
    ...model.recordsReport(admin, { type: 'channels', offset: 20 }).items], all.items);
  assert.deepEqual([...board({ metric: 'channels' }).items, ...board({ metric: 'channels', offset: 20 }).items].map(row => row.id), all.items.map(row => row.id));
  entry('history-with-closed-broker-name', { source: 'Beta' });
  all = model.recordsReport(admin, { type: 'channels' }, true);
  assert.equal(all.items[0].title, 'Beta'); assert.equal(all.items[0].sourceStatus, 'active');
  assert.equal(all.items[0].status, '历史来源 / 含合作券商', '不能因为同名券商注销把历史来源也标为注销');
  assert.equal(all.items.at(-1).sourceStatus, 'pending');
  assert.match(all.orderLabel, /有效来源在前/);
});

test('待处理按队列及登记旧到新，普通同日案件按稳定顺序跨页且导出一致', t => {
  const { db, entry, board, model } = fixture(t);
  db.exec("INSERT INTO leads VALUES ('new-old','alice','新队列较早','N1','2026-11-01'),('new-new','alice','新队列较新','N2','2026-11-18')");
  entry('pending-old', { sales: '主任', date: '2001-01-01', stock: '历史待关联较早' });
  entry('pending-new', { sales: '主任', date: '2025-01-01', stock: '历史待关联较新' });
  entry('pending-unknown', { sales: '主任', date: '', stock: '历史待关联缺日期' });
  const pending = board({ metric: 'pending' });
  assert.deepEqual(pending.items.map(row => row.queue), ['system_new','system_new','system_new','system_legacy','registry_unlinked','registry_unlinked','registry_unlinked']);
  assert.deepEqual(pending.items.slice(0, 3).map(row => row.stockName), ['新队列较早','股票乙','新队列较新']);
  assert.deepEqual(pending.items.slice(4).map(row => row.stockName), ['历史待关联较早','历史待关联较新','历史待关联缺日期']);
  assert.match(pending.orderLabel, /优先处理登记时间较早/);
  for (let n = 0; n < 45; n++) entry('same-date-' + n, { name: '同日同名案件', phone: '', date: '2026-11-10', stock: '股票' + n, status: '已结案' });
  const filter = { type: 'cases', origin: 'registry', q: '同日同名案件' };
  const all = model.recordsReport(admin, filter, true), pages = [0, 20, 40].flatMap(offset => model.recordsReport(admin, { ...filter, offset }).items);
  assert.equal(all.total, 45); assert.deepEqual(pages, all.items);
  assert.equal(new Set(pages.map(row => row.id)).size, 45);
  assert.deepEqual(all.items.map(row => row.id), all.items.map(row => row.id).sort(), '同日同名以唯一ID兜底，不能依赖数据库读出顺序');
  assert.deepEqual(model.recordsReport(admin, filter, true).items, all.items);
});

test('总览及全源数据HTTP接口使用独立后台会话、限制其他角色，导出支持CSV和Excel', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-overview-')), path = join(dir, 'fixture.sqlite');
  const credentials = { username: 'overview-admin', password: 'fictional-admin', name: '测试管理员' };
  const store = createStore(path, { seed: true, admin: credentials });
  const actor = store.getSession(store.createSession(store.verifyLogin(credentials).id));
  store.openSalesAccount(actor, { salesId: 'sales-a', name: '测试销售', username: 'overview-sales' });
  activateStoredAccount(store, 'overview-sales', 'fictional-sales');
  activateStoredAccount(store, 'broker-a', 'fictional-broker');
  const tokens = ['overview-sales', 'broker-a'].map((username, i) => store.createSession(store.verifyLogin({ username, password: i ? 'fictional-broker' : 'fictional-sales' }).id));
  const server = createAppServer({ database: path });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); unlinkSync(path); rmdirSync(dir); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(base + '/api/admin/overview?period=month&metric=customers', { headers: { cookie } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.metrics.length, 8); assert.equal(result.selected, 'customers'); assert.equal(result.period, 'month');
  assert.equal((await fetch(base + '/api/admin/overview?period=custom&from=bad&to=bad', { headers: { cookie } })).status, 400);
  assert.equal((await fetch(base + '/api/admin/overview')).status, 401);
  const report = await fetch(base + '/api/admin/data?type=records', { headers: { cookie } });
  assert.equal(report.status, 200);
  const reportBody = await report.json();
  assert.equal(reportBody.items.length, reportBody.total);
  const csv = await fetch(base + '/api/admin/data/export?type=records', { headers: { cookie } });
  assert.equal(csv.status, 200); assert.ok(csv.headers.get('content-type').includes('text/csv'));
  const csvBytes = new Uint8Array(await csv.arrayBuffer());
  assert.deepEqual([...csvBytes.slice(0, 3)], [239, 187, 191]);
  const csvText = new TextDecoder().decode(csvBytes);
  assert.ok(csvText.includes('记录编号')); assert.ok(csvText.includes('股票代码'));
  for (const row of reportBody.items) assert.ok(csvText.includes(row.number));
  const xlsx = await fetch(base + '/api/admin/data/export?type=records&format=xlsx', { headers: { cookie } });
  assert.equal(xlsx.status, 200); assert.ok(xlsx.headers.get('content-type').includes('spreadsheetml'));
  assert.equal(new TextDecoder().decode(new Uint8Array(await xlsx.arrayBuffer()).slice(0, 2)), 'PK');
  assert.equal((await fetch(base + '/api/admin/data?type=bad', { headers: { cookie } })).status, 400);
  for (const token of tokens) {
    const headers = { Authorization: 'Bearer ' + token };
    assert.equal((await fetch(base + '/api/overview', { headers })).status, 403);
    assert.equal((await fetch(base + '/api/admin/overview', { headers })).status, 401, '后台路径不接受使用端Bearer会话');
    assert.equal((await fetch(base + '/api/admin/overview', { headers: { cookie: 'huzi_pc=' + token } })).status, 403);
    assert.equal((await fetch(base + '/api/data', { headers })).status, 403);
    assert.equal((await fetch(base + '/api/data/export', { headers })).status, 403);
    assert.equal((await fetch(base + '/api/view', { headers })).status, 200);
  }
});
