import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAppServer } from '../server.mjs';
import { createStore, today } from '../store.mjs';
import { overview, salesRows, channelRows, caseRows } from '../web/analytics.js';
import { reportRows, reportDefinition, reportTypes } from '../web/report.js';

async function setup(t) {
  const server = createAppServer({ seed: true, cutoff: today(), admin: { username: 'assign-admin', password: 'admin-password', name: '派单测试管理员' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = (path, input, token) => fetch(base + path, { method: input ? 'POST' : 'GET', headers: { ...(input && { 'Content-Type': 'application/json' }),
    ...(token && { Authorization: `Bearer ${token}` }) }, body: input ? JSON.stringify(input) : undefined });
  const call = async (path, input, actor) => {
    const response = await request(path, input, actor?.token);
    const body = await response.json();
    assert.equal(response.status, 200, body.message);
    return body;
  };
  const login = async (username, password, mini = true) => {
    const response = await request('/auth/login', { username, password, ...(mini && { platform: 'mini' }) });
    const body = await response.json();
    assert.equal(response.status, 200, body.message);
    return { ...body, token: body.token || response.headers.get('set-cookie').match(/^huzi_session=([^;]+)/)[1] };
  };
  const admin = await login('assign-admin', 'admin-password', false);
  for (const id of ['sales-a', 'sales-b']) await call('/accounts/sales', { salesId: id, name: `虚构 ${id}`, username: id, password: 'sales-password' }, admin);
  const a = await login('sales-a', 'sales-password');
  const b = await login('sales-b', 'sales-password');
  const broker = await login('broker-a', 'demo-broker-a');
  let phone = 19900002000;
  const investor = () => call('/auth/register', { phone: String(++phone), password: 'investor-password', platform: 'mini' });
  const company = (name, code, salesId = 'sales-a', extra = {}) => call('/companies', { name, stockCode: code, salesId, aliases: '', active: true, ...extra }, admin);
  const view = actor => call('/view', undefined, actor);
  const lead = (owner, stockName, stockCode, extra = {}) => call('/leads', { name: '虚构留资人', phone: '19900002001', stockName, stockCode, period: '2024 年至今', consent: true, ...extra }, owner);
  const status = async (path, input, actor) => (await request(path, input, actor?.token)).status;
  return { admin, a, b, broker, call, request, investor, company, view, lead, status };
}

test('自然流入与券商推荐同公司派给同一销售，同一股民不同公司逐条派单', async t => {
  const api = await setup(t);
  const { admin, a, b, broker, call, investor, company, view, lead, status } = api;
  const alpha = await company('虚构公司甲', 'TSTA', 'sales-b', { aliases: '甲股票,Alpha Test' });
  await company('虚构公司乙', '000002', 'sales-a');
  const direct = await investor();
  const referred = await investor();
  await call('/scan', { code: 'DEMO-A' }, referred);
  const first = await lead(direct, ' alpha test ', 'tsta', { name: '第一条姓名', phone: '19900003001' });
  const sameCompany = await lead(referred, '甲股票', 'TSTA');
  const otherCompany = await lead(direct, '虚构公司乙', '000002', { name: '第二条姓名', phone: '19900003002' });
  const boardA = await view(a);
  const boardB = await view(b);
  assert.deepEqual(boardA.assignedLeads.map(row => row.id), [otherCompany.id]);
  assert.deepEqual(new Set(boardB.assignedLeads.map(row => row.id)), new Set([first.id, sameCompany.id]));
  assert.equal(boardB.assignedLeads.find(row => row.id === first.id).companyId, alpha.id);
  assert.equal(boardB.assignedLeads.find(row => row.id === first.id).name, '第一条姓名');
  assert.equal(boardB.assignedLeads.find(row => row.id === first.id).phone, '19900003001');
  assert.equal(boardB.assignedLeads.find(row => row.id === first.id).brokerId, null);
  assert.equal(boardB.assignedLeads.find(row => row.id === sameCompany.id).brokerId, 'broker-a');
  assert.equal(await status('/followups', { leadId: sameCompany.id, version: 1, note: '合作负责人不等于经办人' }, a), 403);
  assert.equal(await status('/followups', { clientId: referred.actor.id, note: '旧客户级接口不可越权' }, a), 403);
  await call('/followups', { leadId: first.id, version: 1, note: '仅第一条留资可见' }, b);
  assert.equal((await view(b)).assignedLeads.find(row => row.id === first.id).status, '已跟进');
  assert.equal((await view(a)).assignedLeads[0].followups.length, 0);
  assert.equal((await view(broker)).assignedLeads, undefined);
  const before = await view(admin);
  const directClient = before.clients.find(row => row.id === direct.actor.id);
  assert.equal(directClient.brokerId, null);
  assert.equal(directClient.firstBrokerId, null);
  await call('/reassign', { clientId: referred.actor.id, brokerId: 'broker-b' }, admin);
  assert.equal((await view(b)).assignedLeads.find(row => row.id === sameCompany.id).brokerId, 'broker-b');
  assert.equal((await view(admin)).clients.find(row => row.id === referred.actor.id).firstBrokerId, 'broker-a');
  assert.equal((await view(a)).assignedLeads.length, 1);
});

test('名称代码冲突、未匹配、未配置或停用负责人进入待分配，后台核对转派与版本校验', async t => {
  const { admin, a, b, call, investor, company, view, lead, status } = await setup(t);
  const alpha = await company('甲公司', 'AA');
  await company('乙公司', 'BB', 'sales-b');
  await company('空负责人公司', 'CC', '');
  await company('停用公司', 'DD', 'sales-a', { active: false });
  const owner = await investor();
  const inputs = [['甲公司', 'BB'], ['未知公司', 'ZZ'], ['空负责人公司', 'CC'], ['停用公司', 'DD'], ['甲公司', '??'], ['未知股票', 'AA']];
  const ids = [];
  for (const [name, code] of inputs) ids.push((await lead(owner, name, code)).id);
  const snapshot = await view(admin);
  for (const id of ids) assert.ok(snapshot.assignments.find(row => row.id === id).needsAssignment);
  assert.match(snapshot.assignments.find(row => row.id === ids[0]).reason, /不一致/);
  assert.equal((await view(a)).assignedLeads.length, 0);
  const assign = { leadId: ids[0], companyId: alpha.id, salesId: 'sales-a', version: 1, reason: '已核对用户原填股票代码有误' };
  assert.equal(await status('/assignments', assign, a), 403);
  assert.equal(await status('/companies', { name: '伪造公司' }, owner), 403);
  await call('/assignments', assign, admin);
  assert.equal(await status('/assignments', { ...assign, salesId: 'sales-b' }, admin), 409);
  await call('/followups', { leadId: ids[0], version: 2, note: '原经办记录' }, a);
  await call('/assignments', { ...assign, version: 2, salesId: 'sales-b', reason: '转交新经办人' }, admin);
  assert.equal(await status('/followups', { leadId: ids[0], version: 2, note: '转派后禁止旧销售写入' }, a), 403);
  assert.equal(await status('/followups', { leadId: ids[0], version: 2, note: '新销售旧版本' }, b), 409);
  const assigned = (await view(b)).assignedLeads[0];
  assert.equal(assigned.stockCode, 'BB', 'original user input preserved');
  assert.equal(assigned.companyId, alpha.id);
  assert.equal(assigned.status, '待跟进');
  assert.equal(assigned.followups[0].note, '原经办记录');
  assert.equal((await view(a)).assignedLeads.length, 0);
  const account = (await view(admin)).accounts.find(row => row.subjectId === 'sales-b');
  await call('/accounts/status', { identityId: account.id, status: 'closed', currentPassword: 'admin-password' }, admin);
  const unavailable = await lead(owner, '乙公司', 'BB');
  const latest = await view(admin);
  assert.equal(latest.assignments.find(row => row.id === unavailable.id).needsAssignment, true);
  assert.equal(latest.assignments.find(row => row.id === assigned.id).needsAssignment, true);
  assert.equal(await status('/assignments', { ...assign, version: 3, salesId: 'sales-b' }, admin), 400);
});

test('公司配置别名冲突受保护，配置变更只影响新留资，渠道负责人调整不改派单', async t => {
  const { admin, a, b, call, investor, company, view, lead, status } = await setup(t);
  const alpha = await company('甲公司', 'AAA', 'sales-a', { aliases: '简称甲' });
  assert.equal(await status('/companies', { name: '其他', stockCode: 'BBB', aliases: '简称甲', active: true }, admin), 409);
  assert.equal(await status('/companies', { name: '其他', stockCode: 'aaa', aliases: '', active: true }, admin), 409);
  const owner = await investor();
  await call('/scan', { code: 'DEMO-A' }, owner);
  const first = await lead(owner, '简称甲', 'AAA');
  const update = { id: alpha.id, name: '甲公司', stockCode: 'AAA', aliases: '简称甲', active: true, salesId: 'sales-b', version: 1 };
  await call('/companies', update, admin);
  assert.equal(await status('/companies', update, admin), 409);
  const second = await lead(owner, '简称甲', 'AAA');
  assert.equal((await view(a)).assignedLeads[0].id, first.id);
  assert.equal((await view(b)).assignedLeads[0].id, second.id);
  const ownerChange = { brokerId: 'broker-a', previousSalesId: 'sales-a', salesId: 'sales-b', reason: '合作交接' };
  assert.equal(await status('/channels/owner', ownerChange, a), 403);
  await call('/channels/owner', ownerChange, admin);
  assert.equal(await status('/channels/owner', ownerChange, admin), 409);
  assert.equal((await view(a)).assignedLeads[0].id, first.id);
  assert.equal((await view(b)).assignedLeads[0].id, second.id);
});

test('后台统计区分人条件及渠道/经办销售，筛选页面和 CSV/Excel 导出一致且无财务列', async t => {
  const { admin, a, b, call, request, investor, company, view, lead } = await setup(t);
  await company('甲公司', 'AAA', 'sales-b');
  await company('乙公司', 'BBB', 'sales-a');
  const owner = await investor();
  const first = await lead(owner, '甲公司', 'AAA');
  const second = await lead(owner, '乙公司', 'BBB');
  await call('/cases', { leadId: first.id, title: '第一案件', openedOn: today(), status: '诉讼中' }, admin);
  await call('/cases', { leadId: first.id, title: '第二案件', openedOn: today(), status: '已结案' }, admin);
  await call('/cases', { leadId: second.id, title: '第三案件', openedOn: today(), status: '待受理' }, admin);
  await call('/followups', { leadId: first.id, version: 1, note: '已沟通' }, b);
  const snapshot = await view(admin);
  assert.equal(salesRows(snapshot).find(row => row.id === 'sales-b').leads, 1);
  assert.equal(salesRows(snapshot).find(row => row.id === 'sales-b').closed, 1);
  assert.equal(salesRows(snapshot).find(row => row.id === 'sales-a').ongoing, 0);
  const natural = channelRows(snapshot).find(row => !row.id);
  assert.equal(natural.leads, 2);
  assert.equal(natural.customers, 1);
  assert.equal(natural.ongoing, 1);
  assert.equal(natural.closed, 1);
  assert.equal(overview(snapshot).find(row => row[0] === '留资记录')[1], snapshot.assignments.length);
  const cases = caseRows(snapshot).filter(row => row.handlerId === 'sales-b');
  assert.equal(cases.length, 2);
  assert.ok(cases.every(row => /^AJ-\d{6}$/.test(row.number)));
  assert.equal((await view(a)).assignedLeads[0].cases.length, 1);
  const filtered = reportRows(snapshot, { type: 'leads', salesId: 'sales-b', brokerId: '__natural__', state: '已跟进' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].stockCode, 'AAA');
  for (const [type] of reportTypes) {
    const columns = reportDefinition(type).columns;
    assert.ok(columns.every(column => !/金额|返佣|奖励|到账|服务费/.test(column.label)));
    const csv = await request(`/export?type=${type}`, null, admin.token);
    assert.equal(csv.status, 200);
    const contents = await csv.text();
    const rows = reportRows(snapshot, { type });
    for (const row of rows) assert.ok(contents.includes(String(row[columns[0].key])));
    const excel = await request(`/export?type=${type}&format=xlsx`, null, admin.token);
    assert.equal(excel.status, 200);
    assert.equal(Buffer.from(await excel.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  }
  const filteredCsv = await (await request('/export?type=leads&salesId=sales-b&brokerId=__natural__&state=已跟进', null, admin.token)).text();
  assert.ok(filteredCsv.includes('AAA'));
  assert.ok(!filteredCsv.includes('BBB'));
});

test('历史留资和客户级跟进保留，不推断销售；新增派单和案件编号跨重启稳定', () => {
  const directory = mkdtempSync(join(tmpdir(), 'huzi-assignment-'));
  const path = join(directory, 'db.sqlite');
  let store;
  try {
    store = createStore(path, { seed: true });
    const admin = { role: 'admin', id: 'test' };
    const legacy = store.view(admin).assignments.find(row => row.id === 'lead-demo-a');
    assert.equal(legacy.legacy, 1);
    assert.equal(legacy.salesId, null);
    store.close(); store = null;
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO followups VALUES (?,?,?,?,?)').run('old-followup', 'customer-a', 'sales-a', '旧客户记录', new Date().toISOString());
    const original = db.prepare('SELECT * FROM leads ORDER BY id').all();
    db.close();
    store = createStore(path);
    store.openSalesAccount(admin, { salesId: 'sales-a', name: '历史销售', username: 'legacy-sales', password: 'legacy-password' });
    const company = store.saveCompany(admin, { name: '示例股票甲', stockCode: '000000', aliases: '', salesId: 'sales-a', active: true });
    assert.equal(store.view(admin).assignments.find(row => row.id === 'lead-demo-a').salesId, null);
    store.assignLead(admin, { leadId: 'lead-demo-a', companyId: company.id, salesId: 'sales-a', version: 1, reason: '人工核对历史记录' });
    const before = store.view(admin);
    store.close(); store = createStore(path);
    const after = store.view(admin);
    assert.deepEqual(after.assignments, before.assignments);
    assert.deepEqual(after.cases, before.cases);
    assert.equal(after.legacyFollowups[0].note, '旧客户记录');
    assert.equal(after.assignments.find(row => row.id === 'lead-demo-a').followups.length, 0);
    const inspect = new DatabaseSync(path);
    assert.deepEqual(inspect.prepare('SELECT * FROM leads ORDER BY id').all(), original);
    inspect.close();
  } finally {
    store?.close();
    // Only the dedicated, freshly created test directory is removed.
    rmSync(path, { force: true });
    rmdirSync(directory);
  }
});
