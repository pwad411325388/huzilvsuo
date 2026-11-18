import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSalesBoard } from '../sales-board.mjs';
import { createStore, RequestError, today } from '../store.mjs';
import { createAppServer } from '../server.mjs';
import { activateStoredAccount } from '../test-support/business-account.mjs';

const sales = { role: 'sales', id: 'sales-a' };
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE brokers(id TEXT,name TEXT,salesId TEXT,signedOn TEXT);
    CREATE TABLE identities(id INTEGER,role TEXT,subjectId TEXT,status TEXT);
    CREATE TABLE clients(id TEXT,name TEXT,phone TEXT,brokerId TEXT,createdAt TEXT);
    CREATE TABLE leads(id TEXT,clientId TEXT,stockName TEXT,stockCode TEXT,createdAt TEXT);
    CREATE TABLE lead_assignments(leadId TEXT,salesId TEXT);
    CREATE TABLE signings(clientId TEXT,signedOn TEXT);
    CREATE TABLE cases(id TEXT,leadId TEXT,title TEXT,openedOn TEXT,status TEXT);
    CREATE TABLE company_record_progress(kind TEXT,record_id TEXT,stage TEXT,node TEXT,completed_nodes TEXT);
    CREATE TABLE registry_links(type TEXT,source_name TEXT,source_phone TEXT,identity_id INTEGER);
    CREATE TABLE registry_entries(entry_key TEXT,customer TEXT,phone TEXT,sales TEXT,stock_name TEXT,stock_code TEXT,
      source TEXT,registered_on TEXT,stage TEXT,progress_stage TEXT,progress_node TEXT);
    INSERT INTO identities VALUES (1,'sales','sales-a','active'),(2,'sales','sales-b','active'),
      (3,'investor','alice','active'),(4,'investor','bob','closed'),(5,'broker','b1','closed');
    INSERT INTO brokers VALUES ('b1','ALPHA','sales-a','2020-01-01'),('b2','Beta','sales-a','2026-11-10'),
      ('b3','Private channel','sales-b','2020-01-01');
    INSERT INTO clients VALUES ('alice','同名客户','19900000001','b1','2026-10-31T16:00:00Z'),
      ('bob','独立经办','19900000002','b3','2026-11-18T15:59:59Z'),
      ('outside','不能看到','19900000003','b3','2026-11-10T00:00:00Z');
    INSERT INTO leads VALUES ('la','alice','测试股票甲','000001','2026-11-01T00:00:00Z'),
      ('la2','alice','测试股票乙','000002','2026-11-02T00:00:00Z'),
      ('lb','bob','经办股票','000003','2026-11-18T00:00:00Z'),
      ('lo','outside','不可见股票','999999','2026-11-10T00:00:00Z');
    INSERT INTO lead_assignments VALUES ('la','sales-a'),('la2','sales-a'),('lb','sales-a'),('lo','sales-b');
    INSERT INTO signings VALUES ('alice','2026-11-15');
    INSERT INTO cases VALUES ('old-case','la','早期结案','2020-01-01','已结案'),
      ('new-case','lb','经办结案','2026-11-18','已结案'),('outside-case','lo','不能看到案件','2026-11-10','已结案');
    INSERT INTO registry_links VALUES ('sales','销售甲','','1'),('sales','销售乙','','2');`);
  const insert = db.prepare('INSERT INTO registry_entries VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const entry = (id, props = {}) => insert.run(id, props.name ?? '同名客户', props.phone ?? '19900000001',
    props.sales ?? '销售甲', props.stock ?? '测试股票甲', props.code ?? '000001', props.source ?? 'ａｌｐｈａ',
    props.date ?? '2026-11-01', props.status ?? '', props.stage ?? '', props.node ?? '');
  const board = createSalesBoard(db, { requireValue: (condition, message, status = 400) => {
    if (!condition) throw new RequestError(status, message);
  }, transaction: callback => callback(), today: () => '2026-11-18', caseCutoff: '2026-11-01' });
  return { db, entry, board: (input = {}, actor = sales) => board(actor, input) };
}

test('销售看板合并授权台账、合作渠道和经办客户；同名不能替代有效身份核对', t => {
  const { db, entry, board } = fixture(t);
  entry('same-person');
  entry('same-person-stock2', { stock: '另一股票', code: '000005' });
  entry('different-phone', { phone: '19900000004' });
  entry('different-name', { name: '另一客户' });
  entry('missing-phone-1', { phone: '' });
  entry('missing-phone-2', { phone: '' });
  entry('private', { name: '不能看到登记', sales: '销售乙', source: 'PRIVATE SOURCE' });
  entry('blank-source', { name: '缺来源客户', phone: '19900000005', source: '' });
  const snapshot = board({ metric: 'customers' });
  assert.equal(snapshot.period, 'all'); assert.equal(snapshot.from, ''); assert.equal(snapshot.to, '2026-11-18');
  assert.equal(snapshot.total, 7);
  assert.equal(snapshot.metrics.find(row => row.key === 'customers').value, snapshot.total);
  assert.equal(snapshot.metrics.find(row => row.key === 'channels').value, 2, 'NFKC名称归一但不会添加外部券商关系');
  const same = snapshot.items.filter(row => row.title === '同名客户' && row.phone === '19900000001');
  assert.equal(same.length, 1); assert.equal(same[0].recordCount, 4); assert.match(same[0].subtitle, /另一股票/);
  assert.equal(same[0].status, '已签约');
  assert.ok(snapshot.items.some(row => row.title === '独立经办'), '只属于经办范围也统计，账号注销保留客户');
  assert.ok(snapshot.notes.some(note => note.startsWith('2 条登记资料不完整')));
  assert.ok(!JSON.stringify(snapshot).includes('不能看到'));
  assert.ok(!JSON.stringify(board({ metric: 'channels' })).includes('PRIVATE SOURCE'));
  assert.equal(board({ metric: 'channels' }).items.find(row => row.title === 'ALPHA').status, '已注销');
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM brokers').get().n, 3);
});

test('确认身份优先：无手机号可通过关联合并，两个明确账号不会因同名同电话误合', t => {
  const { db, entry, board } = fixture(t);
  entry('no-phone', { phone: '' });
  entry('no-phone-other-stock', { phone: '', stock: '另一股票' });
  db.exec("INSERT INTO registry_links VALUES ('investor','同名客户','','3')");
  assert.equal(board({ metric: 'customers' }).total, 2, '手工确认关联优先于缺手机号');
  assert.ok(!board().notes.some(note => note.includes('条登记资料不完整')));
  db.exec("INSERT INTO identities VALUES (6,'investor','other-identity','active'); INSERT INTO clients VALUES ('other-identity','同名客户','19900000001','b1','2026-11-02T00:00:00Z')");
  entry('unlinked-ambiguous');
  const result = board({ metric: 'customers' });
  assert.equal(result.total, 4, '明确不同身份不合并，未关联记录也不任意挂给一人');
});

test('按中国登记日期队列筛选：累计包括缺日期，月份和自定义含边界且排除未来', t => {
  const { entry, board } = fixture(t);
  entry('before', { name: '月前客户', phone: '19900000011', date: '2026-10-31' });
  entry('start', { name: '月初客户', phone: '19900000012', date: '2026-11-01' });
  entry('end', { name: '今天客户', phone: '19900000013', date: '2026-11-18' });
  entry('future', { name: '未来客户', phone: '19900000014', date: '2026-11-19' });
  entry('unknown', { name: '未知日期客户', phone: '19900000015', date: '' });
  const cumulative = board({ metric: 'customers' });
  assert.equal(cumulative.total, 6);
  assert.ok(cumulative.items.some(row => row.title === '未知日期客户'));
  assert.ok(!cumulative.items.some(row => row.title === '未来客户'));
  const month = board({ period: 'month', metric: 'customers' });
  assert.equal(month.from, '2026-11-01'); assert.equal(month.to, '2026-11-18'); assert.equal(month.total, 4);
  assert.equal(month.metrics.find(row => row.key === 'customers').unknownDateCount, 1);
  const edge = board({ period: 'custom', from: '2026-11-18', to: '2026-11-18', metric: 'customers' });
  assert.deepEqual(edge.items.map(row => row.title).sort(), ['今天客户', '独立经办'].sort());
  assert.equal(board({ period: 'custom', from: '2026-11-01', to: '2026-11-01', metric: 'customers' }).total, 2,
    'UTC 10月31日16时属于中国11月1日');
  assert.equal(board({ period: 'custom', from: '2026-01-01', to: '2026-01-31', metric: 'customers' }).total, 0);
  for (const input of [{ period: 'bad' }, { metric: 'bad' }, { offset: -1 }, { offset: '0.5' }, { offset: '9007199254740992' },
    { period: 'custom', from: '2026-02-30', to: '2026-03-01' }, { period: 'custom', from: '2026-11-18' },
    { period: 'custom', from: '2026-11-19', to: '2026-11-18' }, { period: 'custom', from: '2026-11-01', to: '2026-11-19' }]) {
    assert.throws(() => board(input), error => error.status === 400, JSON.stringify(input));
  }
});

test('签约只采用明确证据，结案覆盖历史且不将后续阶段或到账推定签约结案', t => {
  const { db, entry, board } = fixture(t);
  entry('closed', { name: '历史结案客户', phone: '19900000021', date: '2020-03-27', stage: 'closure', node: 'closed' });
  entry('filed', { name: '已立案客户', phone: '19900000022', status: '已立案' });
  entry('signed', { name: '明确签约客户', phone: '19900000023', stage: 'intake', node: 'signed_waiting_filing' });
  entry('paid', { name: '到账客户', phone: '19900000024', stage: 'closure', node: 'payment_received' });
  entry('cleared', { name: '已清除结案状态', phone: '19900000025', stage: 'closure', node: 'closed', status: '已结案' });
  db.exec("INSERT INTO company_record_progress VALUES ('registry','cleared','','','[]'),('lead','lb','intake','signed','[]')");
  const signedResult = board({ metric: 'effective' });
  assert.equal(signedResult.total, 3); assert.ok(!signedResult.items.some(row => row.title === '已立案客户'));
  const closedResult = board({ metric: 'closed' });
  assert.equal(closedResult.total, 3); assert.ok(!closedResult.items.some(row => row.title === '已清除结案状态'));
  const historical = closedResult.items.find(row => row.subtitle === '早期结案');
  assert.equal(historical.kind, undefined, '旧案件超出当前详情权限时不提供不可用跳转');
  assert.ok(closedResult.items.find(row => row.title === '历史结案客户').progressId);
  assert.equal(board({ metric: 'closed', period: 'month' }).total, 2, '按客户登记队列查看当前已结案，而非声称当月结案');
  assert.ok(signedResult.notes.some(note => note.includes('签约状态待确认，未计入已签约客户')));
  assert.ok(!JSON.stringify(signedResult).includes('contract'));
});

test('日期缺失提示只计当前筛选之外的档案，混有已知日期的同人不会重复提示', t => {
  const { entry, board } = fixture(t);
  entry('mixed-unknown', { date: '' });
  entry('only-unknown', { name: '只有缺日期客户', phone: '19900000031', date: '', source: '只有缺日期来源' });
  const month = board({ period: 'month', metric: 'customers' });
  assert.equal(month.total, 2);
  assert.equal(month.metrics.find(row => row.key === 'customers').unknownDateCount, 1);
  assert.equal(month.metrics.find(row => row.key === 'channels').unknownDateCount, 2,
    'ALPHA券商合作发生在历史且只有缺日期登记，本月尚未显示');
  entry('mixed-known-source');
  assert.equal(board({ period: 'month' }).metrics.find(row => row.key === 'channels').unknownDateCount, 1,
    '同来源含本月登记已显示，不再次提示另有');
});

test('每卡统计与明细一致，20条稳定分页，摘要受限且不存在账户或登记表也可返回空板', t => {
  const { db, entry, board } = fixture(t);
  for (let n = 0; n < 45; n++) entry('customer-' + n, { name: '分页客户' + n, phone: '1990000' + String(1000 + n),
    source: '来源' + n, stage: 'closure', node: 'closed' });
  for (let n = 0; n < 15; n++) entry('stock-' + n, { stock: '股票' + n, code: String(n) });
  const first = board({ metric: 'customers' });
  assert.equal(first.limit, 20); assert.equal(first.items.length, 20); assert.equal(first.total, 47);
  const second = board({ metric: 'customers', offset: 20 });
  assert.equal(second.items.length, 20); assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 40);
  assert.equal(board({ metric: 'customers', offset: 40 }).items.length, 7);
  assert.equal(board({ metric: 'customers', offset: 200 }).items.length, 7);
  assert.equal(board({ metric: 'customers', offset: 200 }).offset, 40, '数据缩小后夹到最后一页');
  assert.equal(board({ metric: 'customers', offset: 21 }).offset, 20, '非整页请求规范为整页起点');
  for (const metric of first.metrics) {
    const detail = board({ metric: metric.key });
    assert.equal(metric.value, detail.total);
    assert.ok(detail.items.length <= 20);
  }
  const client = [...first.items, ...second.items, ...board({ metric: 'customers', offset: 40 }).items].find(row => row.title === '同名客户');
  assert.match(client.subtitle, /等 17 项股票/); assert.equal(client.recordCount, 17);
  assert.ok(client.subtitle.length < 300);
  const empty = board({}, { role: 'sales', id: 'missing-account' });
  assert.ok(empty.metrics.every(row => row.value === 0));
  assert.equal(board({ offset: 100 }, { role: 'sales', id: 'missing-account' }).offset, 0);
  db.exec('DROP TABLE registry_entries');
  assert.equal(board({ metric: 'customers' }).total, 2);
  assert.throws(() => board({}, { role: 'broker', id: 'b1' }), error => error.status === 403);
  assert.throws(() => board({}, { ...sales, passwordChangeRequired: true }), error => error.status === 403);
});

test('新销售看板API遵守会话和强制改密权限，旧券商看板保持兼容', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sales-board-api-')), path = join(dir, 'fixture.sqlite');
  const credentials = { username: 'board-admin', password: 'fictional-admin', name: '测试管理员' };
  const store = createStore(path, { seed: true, admin: credentials });
  const admin = store.getSession(store.createSession(store.verifyLogin(credentials).id));
  store.openSalesAccount(admin, { salesId: 'sales-a', name: '测试销售', username: 'board-sales' });
  const initial = store.createSession(store.verifyLogin({ username: 'board-sales', password: '12345678' }).id);
  activateStoredAccount(store, 'broker-a', 'fictional-broker');
  const broker = store.createSession(store.verifyLogin({ username: 'broker-a', password: 'fictional-broker' }).id);
  const before = store.view(store.getSession(broker));
  const investorId = store.registerInvestor({ phone: '19900009990', password: 'fictional-investor' });
  const investor = store.createSession(investorId);
  const adminToken = store.createSession(store.verifyLogin(credentials).id);
  const server = createAppServer({ database: path });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); unlinkSync(path); rmdirSync(dir); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = async (token, url = '/sales/board') => {
    const response = await fetch(base + url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await get()).status, 401);
  for (const token of [initial, broker, investor, adminToken]) assert.equal((await get(token)).status, 403);
  activateStoredAccount(store, 'board-sales', 'fictional-sales');
  const token = store.createSession(store.verifyLogin({ username: 'board-sales', password: 'fictional-sales' }).id);
  const response = await get(token);
  assert.equal(response.status, 200); assert.equal(response.body.to, today()); assert.equal(response.body.period, 'all');
  assert.equal((await get(token, '/sales/board?period=custom&from=bad&to=bad')).status, 400);
  assert.deepEqual((await get(broker, '/view')).body, JSON.parse(JSON.stringify(before)));
});
