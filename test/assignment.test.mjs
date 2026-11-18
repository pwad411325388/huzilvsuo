import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAppServer } from '../server.mjs';
import { createStore, today } from '../store.mjs';
import { activateApiAccount } from '../test-support/business-account.mjs';
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
  for (const id of ['sales-a', 'sales-b']) {
    await call('/accounts/sales', { salesId: id, name: `虚构 ${id}`, username: id }, admin);
    await activateApiAccount(base, id, 'sales-password');
  }
  await activateApiAccount(base, 'broker-a', 'demo-broker-a');
  const a = await login('sales-a', 'sales-password');
  const b = await login('sales-b', 'sales-password');
  const broker = await login('broker-a', 'demo-broker-a');
  let phone = 19900002000;
  const investor = referralToken => call('/auth/register', { phone: String(++phone), password: 'investor-password', platform: 'mini', referralToken });
  const company = (name, code, salesId = 'sales-a', extra = {}) => call('/companies', { name, stockCode: code, salesId, aliases: '', active: true, ...extra }, admin);
  const view = actor => call('/view', undefined, actor);
  const lead = (owner, stockName, stockCode, extra = {}) => call('/leads', { name: '虚构留资人', phone: '19900002001', stockName, stockCode, period: '2024 年至今', consent: true, ...extra }, owner);
  const status = async (path, input, actor) => (await request(path, input, actor?.token)).status;
  return { admin, a, b, broker, call, request, investor, company, view, lead, status };
}

test('券商推荐按渠道绑定销售派单并可跟进，自然客户按每条留资的公司派单', async t => {
  const api = await setup(t);
  const { admin, a, b, broker, call, investor, company, view, lead, status } = api;
  const alpha = await company('虚构公司甲', 'TSTA', 'sales-b', { aliases: '甲股票,Alpha Test' });
  await company('虚构公司乙', '000002', 'sales-a');
  const direct = await investor();
  const initial = await view(admin);
  const promo = await call('/referral/capture', { code: 'DEMO-A', platform: 'mini' });
  const referred = await investor(promo.referralToken);
  const first = await lead(direct, ' alpha test ', 'tsta', { name: '第一条姓名', phone: '19900003001' });
  const sameCompany = await lead(referred, '甲股票', 'TSTA');
  const unmatched = await lead(referred, '未配置的股票', 'UNKNOWN');
  const otherCompany = await lead(direct, '虚构公司乙', '000002', { name: '第二条姓名', phone: '19900003002' });
  const boardA = await view(a);
  const boardB = await view(b);
  const customerIds = new Set([direct.actor.id, referred.actor.id]);
  const theseCustomers = board => board.assignedLeads.filter(row => customerIds.has(row.clientId));
  assert.deepEqual(new Set(theseCustomers(boardA).map(row => row.id)), new Set([otherCompany.id, sameCompany.id, unmatched.id]));
  assert.deepEqual(theseCustomers(boardB).map(row => row.id), [first.id]);
  assert.equal(boardB.assignedLeads.find(row => row.id === first.id).companyId, alpha.id);
  assert.equal(boardB.assignedLeads.find(row => row.id === first.id).name, '第一条姓名');
  assert.equal(boardB.assignedLeads.find(row => row.id === first.id).phone, '19900003001');
  assert.equal(boardB.assignedLeads.find(row => row.id === first.id).brokerId, null);
  assert.equal(boardA.assignedLeads.find(row => row.id === sameCompany.id).brokerId, 'broker-a');
  assert.equal(boardA.assignedLeads.find(row => row.id === sameCompany.id).companyId, alpha.id);
  assert.equal(boardA.assignedLeads.find(row => row.id === unmatched.id).companyId, null);
  assert.equal(await status('/followups', { leadId: sameCompany.id, version: 1, note: '公司负责人无权跟进券商留资' }, b), 403);
  assert.equal(await status('/followups', { clientId: referred.actor.id, note: '旧客户级接口不可越权' }, a), 403);
  await call('/followups', { leadId: first.id, version: 1, note: '仅第一条留资可见' }, b);
  await call('/followups', { leadId: sameCompany.id, version: 1, note: '券商经办销售跟进' }, a);
  assert.equal((await view(a)).assignedLeads.find(row => row.id === sameCompany.id).status, '已跟进');
  assert.equal((await view(b)).assignedLeads.find(row => row.id === first.id).status, '已跟进');
  assert.equal((await view(a)).assignedLeads.find(row => row.id === unmatched.id).followups.length, 0);
  assert.equal((await view(broker)).assignedLeads, undefined);
  const before = await view(admin);
  const pendingCount = snapshot => overview(snapshot).find(([name]) => name === '待分配留资')[1];
  assert.equal(pendingCount(before), pendingCount(initial));
  const referredReport = reportRows(before, { type: 'leads', brokerId: 'broker-a', salesId: 'sales-a', state: '已跟进' });
  assert.ok(referredReport.some(row => row.stockCode === 'TSTA' && row.sales === '虚构 sales-a'));
  assert.equal(reportRows(before, { type: 'leads', brokerId: 'broker-a', salesId: 'sales-b' }).some(row => row.stockCode === 'TSTA'), false);
  const directClient = before.clients.find(row => row.id === direct.actor.id);
  assert.equal(directClient.brokerId, null);
  assert.equal(directClient.firstBrokerId, null);
  await call('/reassign', { clientId: referred.actor.id, brokerId: 'broker-b' }, admin);
  assert.equal((await view(a)).assignedLeads.find(row => row.id === sameCompany.id).brokerId, 'broker-b');
  assert.equal((await view(admin)).clients.find(row => row.id === referred.actor.id).firstBrokerId, 'broker-a');
  const afterTransfer = await lead(referred, '未配置的股票', 'UNKNOWN');
  assert.ok((await view(b)).assignedLeads.some(row => row.id === afterTransfer.id));
});

test('券商绑定的销售不可用时，已匹配公司的推荐留资仍待分配', async t => {
  const { admin, b, call, investor, company, view, lead, status } = await setup(t);
  await company('匹配公司', 'KNOWN', 'sales-b');
  const referred = await investor();
  await call('/scan', { code: 'DEMO-A' }, referred);
  const seller = (await view(admin)).accounts.find(row => row.subjectId === 'sales-a');
  await call('/accounts/status', { identityId: seller.id, status: 'closed', currentPassword: 'admin-password' }, admin);
  const created = await lead(referred, '匹配公司', 'KNOWN');
  const assigned = (await view(admin)).assignments.find(row => row.id === created.id);
  assert.equal(assigned.salesId, null);
  assert.equal(assigned.status, '待分配');
  assert.equal(assigned.needsAssignment, true);
  assert.match(assigned.reason, /券商|渠道/);
  assert.equal(await status('/followups', { leadId: created.id, version: assigned.version, note: '越权' }, b), 403);
  const unconfigured = await lead(referred, '无公司配置', 'OTHER');
  const transfer = { leadId: unconfigured.id, salesId: 'sales-b', version: 1, reason: '渠道负责人已停用，改由同事跟进' };
  assert.equal(await status('/assignments', { ...transfer, companyId: '不存在的公司' }, admin), 400);
  await call('/assignments', transfer, admin);
  assert.equal(await status('/assignments', transfer, admin), 409);
  const manual = (await view(b)).assignedLeads.find(row => row.id === unconfigured.id);
  assert.equal(manual.companyId, null);
  assert.equal(manual.status, '待跟进');
  await call('/followups', { leadId: manual.id, version: manual.version, note: '按转派结果跟进' }, b);
  await call('/accounts/status', { identityId: seller.id, status: 'active', currentPassword: 'admin-password' }, admin);
  const restored = (await view(admin)).assignments;
  assert.equal(restored.find(row => row.id === created.id).salesId, 'sales-a');
  assert.equal(restored.find(row => row.id === created.id).needsAssignment, false);
  assert.equal(restored.find(row => row.id === manual.id).salesId, 'sales-b');
  assert.equal(restored.find(row => row.id === manual.id).status, '已跟进');
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
  assert.ok(!(await view(a)).assignedLeads.some(row => ids.includes(row.id)));
  const assign = { leadId: ids[0], companyId: alpha.id, salesId: 'sales-a', version: 1, reason: '已核对用户原填股票代码有误' };
  assert.equal(await status('/assignments', { ...assign, companyId: '' }, admin), 400);
  assert.equal(await status('/assignments', assign, a), 403);
  assert.equal(await status('/companies', { name: '伪造公司' }, owner), 403);
  await call('/assignments', assign, admin);
  assert.equal(await status('/assignments', { ...assign, salesId: 'sales-b' }, admin), 409);
  await call('/followups', { leadId: ids[0], version: 2, note: '原经办记录' }, a);
  await call('/assignments', { ...assign, version: 2, salesId: 'sales-b', reason: '转交新经办人' }, admin);
  assert.equal(await status('/followups', { leadId: ids[0], version: 2, note: '转派后禁止旧销售写入' }, a), 403);
  assert.equal(await status('/followups', { leadId: ids[0], version: 2, note: '新销售旧版本' }, b), 409);
  const assigned = (await view(b)).assignedLeads.find(row => row.id === ids[0]);
  assert.equal(assigned.stockCode, 'BB', 'original user input preserved');
  assert.equal(assigned.companyId, alpha.id);
  assert.equal(assigned.status, '待跟进');
  assert.equal(assigned.followups[0].note, '原经办记录');
  assert.ok(!(await view(a)).assignedLeads.some(row => ids.includes(row.id)));
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
  const referred = await investor();
  await call('/scan', { code: 'DEMO-A' }, referred);
  const channelBefore = await lead(referred, '甲公司', 'AAA');
  const first = await lead(owner, '简称甲', 'AAA');
  const update = { id: alpha.id, name: '甲公司', stockCode: 'AAA', aliases: '简称甲', active: true, salesId: 'sales-b', version: 1 };
  await call('/companies', update, admin);
  assert.equal(await status('/companies', update, admin), 409);
  const second = await lead(owner, '简称甲', 'AAA');
  assert.ok((await view(a)).assignedLeads.some(row => row.id === first.id));
  assert.ok((await view(b)).assignedLeads.some(row => row.id === second.id));
  const ownerChange = { brokerId: 'broker-a', previousSalesId: 'sales-a', salesId: 'sales-b', reason: '合作交接' };
  assert.equal(await status('/channels/owner', ownerChange, a), 403);
  await call('/channels/owner', ownerChange, admin);
  assert.equal(await status('/channels/owner', ownerChange, admin), 409);
  const channelAfter = await lead(referred, '未配置的股票', 'UNKNOWN');
  const assignments = (await view(admin)).assignments;
  const handler = entry => assignments.find(row => row.id === entry.id).salesId;
  assert.equal(handler(first), 'sales-a');
  assert.equal(handler(second), 'sales-b');
  assert.equal(handler(channelBefore), 'sales-a');
  assert.equal(handler(channelAfter), 'sales-b');
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
  assert.equal(salesRows(snapshot).find(row => row.id === 'sales-b').leads, 2, '一条公司派单和一条开户时补派的券商留资');
  assert.equal(salesRows(snapshot).find(row => row.id === 'sales-b').closed, 1);
  assert.equal(salesRows(snapshot).find(row => row.id === 'sales-a').ongoing, 1, '只计券商历史已受理案件；待受理案件不算在办');
  const natural = channelRows(snapshot).find(row => !row.id);
  assert.equal(natural.leads, 2);
  assert.equal(natural.customers, 1);
  assert.equal(natural.ongoing, 1);
  assert.equal(natural.closed, 1);
  assert.equal(overview(snapshot).find(row => row[0] === '留资记录')[1], snapshot.assignments.length);
  const cases = caseRows(snapshot).filter(row => row.handlerId === 'sales-b');
  assert.equal(cases.length, 2);
  assert.ok(cases.every(row => /^AJ-\d{6}$/.test(row.number)));
  assert.equal((await view(a)).assignedLeads.find(row => row.id === second.id).cases.length, 1);
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

test('升级将待派券商留资交给其绑定销售，保留自然留资、人工经办和跟进，重启不重复补派', () => {
  const directory = mkdtempSync(join(tmpdir(), 'huzi-assignment-'));
  const path = join(directory, 'db.sqlite');
  let store;
  try {
    store = createStore(path, { seed: true });
    const admin = { role: 'admin', id: 'test' };
    store.openSalesAccount(admin, { salesId: 'sales-a', name: '历史销售', username: 'legacy-sales', password: 'legacy-password' });
    const company = store.saveCompany(admin, { name: '示例股票乙', stockCode: '000001', aliases: '', salesId: 'sales-a', active: true });
    const manualLead = store.view(admin).assignments.find(row => row.id === 'lead-demo-b');
    store.assignLead(admin, { leadId: manualLead.id, companyId: company.id, salesId: 'sales-a', version: manualLead.version, reason: '原人工交接' });
    store.addFollowup({ role: 'sales', id: 'sales-a' }, { leadId: manualLead.id, version: manualLead.version + 1, note: '原留资跟进' });
    const manual = store.view(admin).assignments.find(row => row.id === manualLead.id);
    store.close(); store = null;
    const db = new DatabaseSync(path);
    let original;
    try {
      const time = new Date().toISOString();
      db.prepare('INSERT INTO followups VALUES (?,?,?,?,?)').run('old-followup', 'customer-a', 'sales-a', '旧客户记录', time);
      // Reproduce the persisted dispatch records and migration flags from the release before broker dispatch.
      db.exec("DELETE FROM settings WHERE key='brokerReferralRoutingV1'");
      db.exec("UPDATE lead_assignments SET method='legacy', legacy=1, salesId=NULL, version=1 WHERE leadId='lead-demo-a'");
      const insert = db.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?)');
      insert.run('old-pending', 'customer-a', '未配置股票', 'NONE', '历史', time);
      insert.run('old-direct', 'customer-new', '未配置股票', 'NONE', '历史', time);
      insert.run('old-no-sales-account', 'customer-b', '示例股票乙', '000001', '历史', time);
      db.prepare(`INSERT INTO lead_assignments(leadId,reason,method,contactName,contactPhone,updatedAt)
        VALUES ('old-pending','未匹配到公司','auto','提交时姓名','19900004567',?)`).run(time);
      original = db.prepare('SELECT * FROM leads ORDER BY id').all();
    } finally {
      db.close();
    }
    store = createStore(path);
    const before = store.view(admin);
    const row = id => before.assignments.find(item => item.id === id);
    for (const id of ['lead-demo-a', 'old-pending']) {
      assert.equal(row(id).salesId, 'sales-a');
      assert.equal(row(id).legacy, 0);
      assert.equal(row(id).status, '待跟进');
      assert.equal(row(id).version, 2);
      assert.match(row(id).reason, /券商|渠道/);
    }
    assert.equal(row('old-pending').name, '提交时姓名');
    assert.equal(row('old-pending').phone, '19900004567');
    assert.equal(row('old-direct').salesId, null);
    assert.equal(row('old-no-sales-account').salesId, null);
    assert.deepEqual(row(manual.id), manual);
    store.close(); store = createStore(path);
    const after = store.view(admin);
    assert.deepEqual(after.assignments, before.assignments);
    assert.deepEqual(after.cases, before.cases);
    assert.deepEqual(after.audit, before.audit);
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
