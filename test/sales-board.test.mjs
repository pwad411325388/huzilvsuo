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
  assert.equal(snapshot.metrics.find(row => row.key === 'channels').value, 3, 'NFKC名称归一，并计入已获授权经办留资的实际来源');
  const same = snapshot.items.filter(row => row.title === '同名客户' && row.phone === '19900000001');
  assert.equal(same.length, 1); assert.equal(same[0].recordCount, 4); assert.match(same[0].subtitle, /另一股票/);
  assert.equal(same[0].status, '多个案件进度');
  assert.equal(same[0].signingStatus, '已签约');
  assert.ok(snapshot.items.some(row => row.title === '独立经办'), '只属于经办范围也统计，账号注销保留客户');
  assert.ok(snapshot.notes.some(note => note.startsWith('2 条登记资料不完整')));
  assert.ok(!JSON.stringify(snapshot).includes('不能看到'));
  assert.ok(!JSON.stringify(board({ metric: 'channels' })).includes('PRIVATE SOURCE'));
  assert.equal(board({ metric: 'channels' }).items.find(row => row.title === 'ALPHA').status, '已注销');
  const handledSource = board({ metric: 'channels' }).items.find(row => row.title === 'Private channel');
  assert.equal(handledSource.subtitle, '1 位客户 · 1 条记录'); assert.equal(handledSource.status, '', '知悉经办留资来源不等于拥有该券商合作关系');
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM brokers').get().n, 3);
});

test('确认身份优先：无手机号可通过关联合并，两个明确账号不会因同名同电话误合', t => {
  const { db, entry, board } = fixture(t);
  entry('no-phone', { phone: '' });
  entry('no-phone-other-stock', { phone: '', stock: '另一股票' });
  db.exec("INSERT INTO registry_links VALUES ('investor','同名客户','','3')");
  assert.equal(board({ metric: 'customers' }).total, 2, '手工确认关联优先于缺手机号');
  assert.ok(!board().notes.some(note => note.includes('条登记资料不完整')));
  db.exec(`INSERT INTO identities VALUES (6,'investor','other-identity','active');
    INSERT INTO clients VALUES ('other-identity','同名客户','19900000001','b1','2026-11-02T00:00:00Z');
    INSERT INTO leads VALUES ('other-lead','other-identity','另一身份股票','000006','2026-11-02T00:00:00Z');
    INSERT INTO lead_assignments VALUES ('other-lead','sales-a')`);
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

test('销售看板支持每页五条，完整集合排序后分页且保留日期和权限边界', t => {
  const { entry, board } = fixture(t);
  for (let i = 0; i < 11; i++) entry('five-' + i, { name: '分页客户' + i, phone: '', date: '2026-11-10' });
  entry('hidden-five', { name: '他人分页客户', sales: '销售乙', date: '2026-11-10' });
  const original = board({ metric: 'customers' });
  assert.equal(original.limit, 20);
  assert.deepEqual(board({ metric: 'customers', limit: '20' }).items, original.items);
  const pages = [0, 5, 10].map(offset => board({ metric: 'customers', limit: '5', offset }));
  assert.deepEqual(pages.map(page => page.items.length), [5, 5, 3]);
  assert.ok(pages.every(page => page.limit === 5 && page.total === 13 && page.metrics.find(metric => metric.key === 'customers').value === 13));
  assert.deepEqual(pages.flatMap(page => page.items), original.items);
  assert.equal(new Set(pages.flatMap(page => page.items).map(item => item.id)).size, 13);
  assert.deepEqual(board({ metric: 'customers', limit: 5, offset: 9999 }).items, pages[2].items);
  assert.equal(board({ metric: 'customers', limit: 5, offset: 7 }).offset, 5);
  const day = board({ metric: 'customers', limit: 5, period: 'custom', from: '2026-11-10', to: '2026-11-10', offset: 10 });
  assert.equal(day.total, 11); assert.equal(day.items.length, 1); assert.equal(day.offset, 10);
  assert.equal(board({ metric: 'customers', limit: 5, period: 'custom', from: '2026-01-01', to: '2026-01-01', offset: 10 }).offset, 0);
  for (const limit of [0, 1, 10, 21, -5, 5.5, null, '', true, '05', '5.0', ' 5 ', [], {}]) {
    assert.throws(() => board({ limit }), error => error.status === 400);
  }
  assert.throws(() => board({ limit: 5 }, { role: 'investor', id: 'sales-a' }), error => error.status === 403);
});

test('历史立案和后续阶段可计签约，当前有效的结案与单纯到账分别展示', t => {
  const { db, entry, board } = fixture(t);
  entry('closed', { name: '历史结案客户', phone: '19900000021', date: '2020-03-27', stage: 'closure', node: 'closed' });
  entry('filed', { name: '已立案客户', phone: '19900000022', status: '已立案' });
  entry('signed', { name: '明确签约客户', phone: '19900000023', stage: 'intake', node: 'signed_waiting_filing' });
  entry('paid', { name: '到账客户', phone: '19900000024', stage: 'closure', node: 'payment_received' });
  entry('cleared', { name: '已清除结案状态', phone: '19900000025', stage: 'closure', node: 'closed', status: '已结案' });
  db.exec("INSERT INTO company_record_progress VALUES ('registry','cleared','','','[]'),('lead','lb','intake','signed','[]')");
  const signedResult = board({ metric: 'effective' });
  assert.equal(signedResult.total, 6);
  for (const title of ['历史结案客户','已立案客户','到账客户']) assert.equal(signedResult.items.find(row=>row.title===title).signedOn,'');
  assert.ok(!signedResult.items.some(row=>row.title==='已清除结案状态'));
  const closedResult = board({ metric: 'closed' });
  assert.equal(closedResult.total, 3); assert.ok(!closedResult.items.some(row => row.title === '已清除结案状态'));
  const historical = closedResult.items.find(row => row.subtitle === '早期结案');
  assert.equal(historical.kind, 'case', '自有早期案件与统一记录和详情读取范围一致');
  assert.equal(historical.progressId, historical.id.slice('case:'.length));
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
  assert.equal(month.metrics.find(row => row.key === 'channels').unknownDateCount, 1,
    'ALPHA已有本月实际留资，不因合作日期较早而遗漏或误提示缺日期');
  entry('mixed-known-source');
  assert.equal(board({ period: 'month' }).metrics.find(row => row.key === 'channels').unknownDateCount, 1,
    '同来源含本月登记已显示，不再次提示另有');
});

test('老客户新增股票按留资日期入期，摘要与结案只取对应登记队列', t => {
  const { db, board } = fixture(t);
  db.exec(`UPDATE clients SET createdAt='2019-01-01T00:00:00Z' WHERE id='alice';
    UPDATE leads SET createdAt='2025-12-31T00:00:00Z' WHERE id='la';
    INSERT INTO cases VALUES ('new-stock-closed','la2','本期股票结案','2026-11-15','已结案')`);
  const input = { period: 'custom', from: '2026-11-02', to: '2026-11-02' };
  const clients = board({ ...input, metric: 'customers' });
  assert.equal(clients.total, 1);
  assert.equal(clients.items[0].recordCount, 1);
  assert.equal(clients.items[0].registeredOn, '2026-11-02');
  assert.match(clients.items[0].subtitle, /测试股票乙/);
  assert.doesNotMatch(clients.items[0].subtitle, /测试股票甲/);
  assert.equal(clients.items[0].status, '已结案', '按登记队列展示该股票的当前案件进度');
  assert.equal(clients.items[0].signingStatus, '已签约', '签约资格与进度展示分开');
  assert.equal(clients.items[0].progressId, 'la2', '单条本期股票可直接进入该留资进度');
  const cases = board({ ...input, metric: 'closed' });
  assert.equal(cases.total, 1); assert.equal(cases.items[0].subtitle, '本期股票结案');
  const channels = board({ ...input, metric: 'channels' });
  assert.equal(channels.total, 1); assert.equal(channels.items[0].title, 'ALPHA');
  assert.equal(board({ metric: 'closed', period: 'custom', from: '2025-12-31', to: '2025-12-31' }).total, 1);
});

test('自然流入及同客户不同经办股票按授权记录统计，不扩散其他销售的数据', t => {
  const { db, board } = fixture(t);
  db.exec(`INSERT INTO clients VALUES ('natural','自然客户','19900000041',NULL,'2020-01-01T00:00:00Z'),
    ('unsubmitted','未留资账号','19900000042','b1','2026-11-18T00:00:00Z');
    INSERT INTO leads VALUES ('natural-lead','natural','自然股票','000041','2026-11-18T00:00:00Z'),
      ('same-client-private','bob','其他经办专属股票','900099','2026-11-18T00:00:00Z');
    INSERT INTO lead_assignments VALUES ('natural-lead','sales-a'),('same-client-private','sales-b');
    INSERT INTO cases VALUES ('other-handler-case','same-client-private','其他经办专属案件','2026-11-18','已结案')`);
  const input = { period: 'custom', from: '2026-11-18', to: '2026-11-18' };
  const result = board({ ...input, metric: 'customers' });
  assert.equal(result.total, 2);
  assert.ok(!JSON.stringify(result).includes('其他经办专属'));
  assert.ok(!JSON.stringify(result).includes('未留资账号'));
  const bob = result.items.find(row => row.title === '独立经办');
  assert.equal(bob.recordCount, 1); assert.match(bob.subtitle, /经办股票/);
  assert.equal(board({ ...input, metric: 'closed' }).total, 1);
  const channels = board({ ...input, metric: 'channels' });
  assert.equal(channels.total, 2);
  assert.ok(channels.items.some(row => row.title === '自然流入'));
  assert.ok(channels.items.some(row => row.title === 'Private channel' && row.customerCount === 1 && row.recordCount === 1));
});

test('券商负责人不能凭合作关系继续查看已转派给其他销售的股票、案件或签约快照', t => {
  const { db, board } = fixture(t);
  db.exec(`UPDATE lead_assignments SET salesId='sales-b' WHERE leadId='la2';
    DELETE FROM signings WHERE clientId='alice';
    INSERT INTO company_record_progress VALUES ('lead','la2','intake','signed','[]');
    INSERT INTO cases VALUES ('transferred-case','la2','转派股票结案','2026-11-17','已结案')`);
  const owner = board({ metric: 'customers' });
  const alice = owner.items.find(row => row.title === '同名客户');
  assert.equal(alice.recordCount, 1); assert.match(alice.subtitle, /测试股票甲/);
  assert.doesNotMatch(alice.subtitle, /测试股票乙/);
  assert.equal(alice.status, '已结案');
  assert.equal(alice.signingStatus, '签约状态未确认');
  assert.equal(alice.progressId, 'la');
  assert.ok(!JSON.stringify(board({ metric: 'closed' })).includes('转派股票结案'));
  const receiver = board({ metric: 'customers' }, { role: 'sales', id: 'sales-b' });
  const received = receiver.items.find(row => row.title === '同名客户');
  assert.equal(received.recordCount, 1); assert.match(received.subtitle, /测试股票乙/);
  assert.doesNotMatch(received.subtitle, /测试股票甲/); assert.equal(received.status, '已签约');
  assert.equal(received.signingStatus, '已签约');
  assert.ok(board({ metric: 'closed' }, { role: 'sales', id: 'sales-b' }).items.some(row => row.subtitle === '转派股票结案'));
  db.exec("UPDATE lead_assignments SET salesId='sales-b' WHERE leadId='la'");
  assert.ok(!board({ metric: 'customers' }).items.some(row => row.title === '同名客户'));
  assert.ok(board({ metric: 'channels' }).items.some(row => row.title === 'ALPHA'), '合法合作关系保留在来源渠道卡');
  assert.ok(!JSON.stringify(board({ metric: 'closed' })).includes('早期结案'));
});

test('无可靠姓名电话的同一系统客户仍只计一份档案，日期范围只选相应股票', t => {
  const { db, board } = fixture(t);
  db.exec("UPDATE clients SET name=NULL,phone=NULL WHERE id='alice'; DELETE FROM identities WHERE subjectId='alice'");
  const all = board({ metric: 'customers' });
  assert.equal(all.total, 2);
  const unnamed = all.items.find(row => row.title === '待留资客户');
  assert.equal(unnamed.recordCount, 2);
  const oneDay = board({ metric: 'customers', period: 'custom', from: '2026-11-02', to: '2026-11-02' });
  assert.equal(oneDay.total, 1); assert.equal(oneDay.items[0].recordCount, 1);
});

test('未来登记不参与当前客户身份合并，不能改变今天的去重结果', t => {
  const { db, entry, board } = fixture(t);
  entry('known-today');
  db.exec("INSERT INTO identities VALUES (6,'investor','future-identity','active')");
  entry('future-identity', { name: '同名客户 ', phone: '19900000001', date: '2026-11-19' });
  db.exec("INSERT INTO registry_links VALUES ('investor','同名客户 ','19900000001','6')");
  const result = board({ metric: 'customers' });
  assert.equal(result.total, 2);
  assert.ok(!JSON.stringify(result).includes('2026-11-19'));
  assert.equal(result.items.find(row => row.title === '同名客户').recordCount, 3);
});

test('来源先按可用状态再按档案量排序，注销大渠道不置顶且跨页不丢失', t => {
  const { db, entry, board } = fixture(t);
  db.exec(`INSERT INTO brokers VALUES ('active-empty','有效空来源','sales-a','2025-01-01');
    INSERT INTO identities VALUES (6,'broker','active-empty','active')`);
  for (let n = 0; n < 27; n++) for (let m = 0; m < n % 4 + 1; m++) entry(`source-${n}-${m}`, {
    source: `历史来源${n}`, name: `来源客户${n}-${m}`, phone: '199000' + String(10000 + n * 4 + m), date: '2025-01-01',
  });
  for (let n = 0; n < 40; n++) entry('closed-channel-' + n, {
    source: 'ALPHA', name: '注销来源客户' + n, phone: '199001' + String(10000 + n), date: '2026-11-18',
  });
  const first = board({ metric: 'channels' }), second = board({ metric: 'channels', offset: 20 });
  const items = [...first.items, ...second.items];
  assert.equal(items.length, first.total); assert.equal(new Set(items.map(row => row.id)).size, first.total);
  assert.equal(items.at(-1).title, 'ALPHA'); assert.equal(items.at(-1).sourceStatus, 'closed');
  assert.ok(items.at(-1).customerCount > items[0].customerCount, '注销客户量再大也不会排在有效来源之前');
  const rank = { active: 0, pending: 1, closed: 2 };
  for (let n = 1; n < items.length; n++) {
    assert.ok(rank[items[n - 1].sourceStatus] <= rank[items[n].sourceStatus]);
    if (items[n - 1].sourceStatus === items[n].sourceStatus) assert.ok(items[n - 1].customerCount >= items[n].customerCount);
  }
  assert.deepEqual(board({ metric: 'channels' }).items, first.items);
  assert.match(first.orderLabel, /注销/);
});

test('客户与案件明细按登记日新到旧，四十条同日记录跨三页稳定且缺日期末置', t => {
  const { entry, board } = fixture(t);
  for (let n = 0; n < 46; n++) entry('date-order-' + n, {
    name: '排序客户' + n, phone: '199002' + String(10000 + n),
    date: n < 40 ? '2026-11-17' : n === 45 ? '' : '2020-01-01', stage: 'closure', node: 'closed',
  });
  for (const metric of ['customers', 'closed']) {
    const pages = [0, 20, 40].map(offset => board({ metric, offset }));
    const items = pages.flatMap(page => page.items);
    assert.equal(items.length, pages[0].total); assert.equal(new Set(items.map(row => row.id)).size, items.length);
    assert.equal(items.at(-1).registeredOn, '');
    const dates = items.map(row => row.registeredOn).filter(Boolean);
    assert.deepEqual(dates, dates.slice().sort().reverse());
    assert.deepEqual(board({ metric, offset: 20 }).items, pages[1].items);
  }
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
