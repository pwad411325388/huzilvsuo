import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import writeExcelFile from 'write-excel-file/node';
import { createStore, today } from '../store.mjs';
import { createAppServer } from '../server.mjs';
import { activateStoredAccount } from '../test-support/business-account.mjs';

const values = board => Object.fromEntries(board.metrics.map(row => [row.key, row.value]));
const publicKey = id => createHash('sha256').update(id).digest('hex');

test('导入、关联、转派和快照同步贯穿后台报表及使用端，旧授权实时失效且重复同步不叠加', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cross-entry-data-')), database = join(dir, 'fixture.sqlite'), workbook = join(dir, 'synthetic.xlsx');
  const credentials = { username: 'cross-admin', password: 'fictional-admin-pass', name: '合成管理员' };
  const store = createStore(database, { admin: credentials, cutoff: '2000-01-01' });
  const db = new DatabaseSync(database);
  const account = (username, password) => {
    const token = store.createSession(store.verifyLogin({ username, password }).id);
    return { token, actor: store.getSession(token) };
  };
  const admin = account(credentials.username, credentials.password).actor;
  for (const [name, username] of [['销售甲', 'cross-sales-a'], ['销售乙', 'cross-sales-b']]) {
    store.openSalesAccount(admin, { name, username });
    activateStoredAccount(store, username, 'fictional-sales-pass');
  }
  const a = account('cross-sales-a', 'fictional-sales-pass'), b = account('cross-sales-b', 'fictional-sales-pass');
  const investorId = store.registerInvestor({ phone: '19900009001', password: 'fictional-investor-pass' });
  const investor = { token: store.createSession(investorId) };
  investor.actor = store.getSession(investor.token);
  store.renameInvestor(investor.actor, { name: '同名股民' });
  const headers = ['序号','客户名称','股票名称','股票代码','销售','原告-合同上的联系电话','客户来源','材料登记时间','是否立案','立案时间','案件进展','是否结案'];
  const rows = [
    ['1','同名股民','历史股票甲','000001','销售甲','19900009001','大众证券','2025-01-01','','','已结案','√'],
    ['2','同名股民','历史股票乙','000002','销售甲','19900009001','大众证券','2025-09-01','','','一审待开庭',''],
    ['3','同名股民','历史股票丙','000003','销售甲','19900009002','大众证券','2025-03-01','','','',''],
    ['4','缺号股民','历史股票丁','000004','销售甲','','大众证券','2025-04-01','','','',''],
    ['5','缺号股民','历史股票戊','000005','销售甲','','大众证券','2025-05-01','','','',''],
    ['6','乙客户','历史股票己','000006','销售乙','19900009003','东方财富','2025-06-01','','','二审待开庭',''],
    ['7','未关联客户','历史股票庚','000007','主任','19900009004','大众证券','2025-07-01','','','',''],
    ['8','同名股民','历史股票辛','000008','销售乙','19900009001','大众证券','2025-08-01','','','',''],
  ];
  await writeExcelFile([headers, ...rows].map(row => row.map(value => ({ value, type: String }))), { sheet: '股民登记总表' }).toFile(workbook);
  const server = createAppServer({ database, registryFile: workbook, cutoff: '2000-01-01' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close(); db.close(); unlinkSync(database); unlinkSync(workbook); rmdirSync(dir);
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await fetch(base + '/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function call(path, token, body, status = 200) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
      ...(path.startsWith('/admin/') ? { cookie } : token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.equal(response.status, status, result.message); return result;
  }
  const board = () => call('/admin/overview');
  const sales = (person, metric = 'customers') => call('/sales/board?metric=' + metric, person.token);
  const registry = person => call('/registry', person.token);
  const report = params => call('/admin/data?' + new URLSearchParams(params));
  const entry = stock => db.prepare('SELECT entry_key FROM registry_entries WHERE stock_code=?').get(stock).entry_key;
  async function link(type, stock, identityId) {
    const entryKey = entry(stock), group = await call('/admin/registry/candidates?' + new URLSearchParams({ type, entryKey }));
    return call('/admin/registry/link', null, { type, entryKey, identityId, previousIdentityId: group.currentLink?.identityId ?? null,
      sourceToken: group.sourceToken, confirmed: true });
  }
  async function assertReportTotals(expected) {
    const result = await board(), actual = values(result);
    for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
    for (const type of ['records', 'customers', 'channels', 'signed']) assert.equal((await report({ type })).total, actual[type]);
    for (const status of ['ongoing', 'closed']) assert.equal((await report({ type: 'cases', status })).total, actual[status]);
    const response = await fetch(base + '/admin/data/export?type=records', { headers: { cookie } });
    assert.equal(response.status, 200);
    const csv = await response.text();
    assert.equal(csv.trim().split('\r\n').length - 1, actual.records);
    return actual;
  }

  // One real workbook importer, one database, every reader observes the same snapshot.
  await call('/admin/registry/sync', null, {});
  const imported = await assertReportTotals({ records: 8, customers: 6, channels: 2, pending: 8, ongoing: 2, closed: 1, registry: 8, signed: 0 });
  const keys = db.prepare('SELECT entry_key FROM registry_entries ORDER BY source_row').all();
  await call('/admin/registry/sync', null, {});
  assert.deepEqual(values(await board()), imported); assert.deepEqual(db.prepare('SELECT entry_key FROM registry_entries ORDER BY source_row').all(), keys);
  assert.equal((await registry(a)).total, 0); assert.equal((await sales(a)).total, 0);
  assert.equal((await registry(investor)).total, 0);
  t.diagnostic('导入后：8 条登记 / 6 份档案 / 8 条待关联；重复导入数字及记录键不变。');

  const identityA = db.prepare("SELECT id FROM identities WHERE username='cross-sales-a'").get().id;
  const identityB = db.prepare("SELECT id FROM identities WHERE username='cross-sales-b'").get().id;
  await link('sales', '000001', identityA); await link('sales', '000006', identityB);
  await link('investor', '000001', investorId);
  await assertReportTotals({ records: 8, customers: 6, pending: 1 });
  assert.equal((await registry(a)).total, 5); assert.equal((await sales(a)).total, 4);
  assert.equal((await registry(b)).total, 2); assert.equal((await sales(b)).total, 2);
  assert.equal((await registry(investor)).total, 3, '同名不同电话不能一起关联股民');
  assert.equal((await report({ type: 'customers', q: '缺号股民' })).total, 2, '缺电话的同名档案保持独立');
  assert.equal((await report({ type: 'records', salesId: a.actor.id })).total, (await registry(a)).total);
  const progressPath = '/progress?' + new URLSearchParams({ kind: 'registry', id: publicKey(entry('000002')) });
  assert.equal((await call(progressPath, a.token)).current.label, '一审待开庭');
  await call(progressPath, b.token, undefined, 404);
  t.diagnostic('关联后：平台仍为 8 条 / 6 份；销售甲 5 条 / 4 份、销售乙 2 条 / 2 份；待关联降为 1 条。');

  await link('sales', '000001', null);
  await link('sales', '000001', identityB);
  assert.equal((await registry(a)).total, 0); assert.equal((await sales(a)).total, 0);
  assert.equal((await registry(b)).total, 7); assert.equal((await sales(b)).total, 5);
  await call(progressPath, a.token, undefined, 404); await call(progressPath, b.token);
  await assertReportTotals({ records: 8, customers: 6, pending: 1 });
  await link('sales', '000001', null);
  assert.equal((await registry(b)).total, 2); await call(progressPath, b.token, undefined, 404);
  await assertReportTotals({ pending: 6 });
  await link('sales', '000001', identityA);
  store.syncProgress([{ kind: 'registry', id: entry('000002'), revision: 1, stage: 'closure', node: 'closed' },
    { kind: 'registry', id: entry('000003'), revision: 1, stage: 'intake', node: 'signed' }]);
  await assertReportTotals({ ongoing: 1, closed: 2, signed: 1, pending: 1 });
  assert.equal((await sales(a, 'closed')).total, 2); assert.equal((await sales(a, 'effective')).total, 1);
  assert.equal((await call(progressPath, a.token)).current.label, '已结案');
  assert.equal((await call(progressPath, investor.token)).current.label, '已结案');
  for (const person of [a, investor]) {
    const record = (await registry(person)).items.find(row => row.stockCode === '000002');
    assert.equal(record.stage, '已结案'); assert.equal('rawStage' in record, false);
  }
  const previewFields = row => [row.rowKey, row.stockCode, row.stage, row.registeredOn];
  assert.deepEqual((await call('/view', a.token)).registryPreview.map(previewFields), (await registry(a)).items.slice(0, 3).map(previewFields), '首页预览沿用最新三条台账及当前进度');
  assert.equal((await call('/view', a.token)).registryPreview.find(row => row.stockCode === '000002').stage, '已结案');
  const administratorRecord = (await call('/admin/registry')).items.find(row => row.stockCode === '000002');
  assert.equal(administratorRecord.stage, '已结案'); assert.equal(administratorRecord.rawStage, '一审待开庭');
  await call('/progress?' + new URLSearchParams({ kind: 'registry', id: publicKey(entry('000003')) }), investor.token, undefined, 404);
  await call('/admin/registry/sync', null, {});
  await assertReportTotals({ records: 8, customers: 6, ongoing: 1, closed: 2, signed: 1, pending: 1 });
  store.syncProgress([{ kind: 'registry', id: entry('000002'), revision: 2, stage: null, node: null }]);
  for (const person of [a, investor]) {
    assert.equal((await registry(person)).items.find(row => row.stockCode === '000002').stage, '进度待核对');
    const detail = await call(progressPath, person.token);
    assert.equal(detail.current, null); assert.equal(detail.sourceStatus, '');
  }
  assert.deepEqual((await call('/view', a.token)).registryPreview.map(previewFields), (await registry(a)).items.slice(0, 3).map(previewFields));
  assert.equal((await call('/view', a.token)).registryPreview.find(row => row.stockCode === '000002').stage, '进度待核对');
  await assertReportTotals({ ongoing: 1, closed: 1, signed: 1 });
  store.syncProgress([{ kind: 'registry', id: entry('000002'), revision: 3, stage: 'closure', node: 'closed' }]);
  t.diagnostic('换销售后旧销售清零并失去详情权限；解绑待关联升至 6，重新关联及快照更新后在办 1 / 结案 2 / 签约 1，重导入仍一致。');

  // A live case's current company snapshot must also reach every legacy/current list.
  const brokerId = store.registerBroker(a.actor, { name: '合成测试券商', signedOn: today() }).id;
  store.openAccount(admin, { brokerId, username: 'cross-broker' });
  activateStoredAccount(store, 'cross-broker', 'fictional-broker-pass');
  const broker = account('cross-broker', 'fictional-broker-pass');
  store.scan(investor.actor, { code: db.prepare('SELECT code FROM brokers WHERE id=?').get(brokerId).code });
  const leadId = store.addLead(investor.actor, { name: '同名股民', phone: '19900009001', stockName: '实时股票', stockCode: '000099', period: '测试', consent: true }).id;
  const caseId = store.saveCase(admin, { leadId, title: '实时股票索赔案', openedOn: today(), status: '已受理' }).id;
  const liveCase = '/progress?' + new URLSearchParams({ kind: 'case', id: caseId });
  async function caseLabels(expected) {
    const investorView = await call('/view', investor.token), sellerView = await call('/view', a.token), brokerView = await call('/view', broker.token);
    assert.equal(investorView.leads.find(row => row.id === leadId).cases[0].status, expected);
    assert.equal(sellerView.assignedLeads.find(row => row.id === leadId).cases[0].status, expected);
    const relation = await call('/progress?' + new URLSearchParams({ kind: 'lead', id: leadId }), investor.token);
    assert.equal(relation.relatedCases.find(row => row.id === caseId).status, expected);
    const cards = brokerView.metrics.flatMap(metric => metric.records).filter(row => row.id === caseId);
    if (expected === '已结案') assert.ok(cards.some(row => row.status === expected));
    assert.equal((await report({ type: 'cases', q: '实时股票' })).items[0].caseStatus, expected);
  }
  await caseLabels('已受理');
  store.syncProgress([{ kind: 'case', id: caseId, revision: 1, stage: 'closure', node: 'closed' }]);
  await caseLabels('已结案');
  assert.equal((await call(liveCase, investor.token)).current.label, '已结案');
  assert.ok((await call('/broker/board?metric=closed', broker.token)).items.some(row => row.id === caseId && row.status === '已结案'));
  assert.equal((await sales(a, 'closed')).total, 3);
  store.assignLead(admin, { leadId, salesId: b.actor.id, version: 1, reason: '合成转派' });
  assert.equal((await call('/view', a.token)).assignedLeads.some(row => row.id === leadId), false);
  assert.equal((await sales(a, 'closed')).total, 2); assert.equal((await sales(b, 'closed')).total, 1);
  await call(liveCase, a.token, undefined, 404); await call(liveCase, b.token);
  assert.equal((await call('/view', a.token)).metrics.find(row => row.label === '已结案').records.some(row => row.id === caseId), false);
  store.syncProgress([{ kind: 'case', id: caseId, revision: 2, stage: null, node: null }]);
  assert.equal((await call('/view', investor.token)).leads.find(row => row.id === leadId).cases[0].status, '进度待核对');
  assert.equal((await call('/view', b.token)).assignedLeads.find(row => row.id === leadId).cases[0].status, '进度待核对');
  assert.equal((await report({ type: 'cases', q: '实时股票' })).items[0].caseStatus, '进度待核对');
  assert.equal((await call('/broker/board?metric=closed', broker.token)).total, 0);
  assert.equal((await sales(b, 'closed')).total, 0);
});
