import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, scryptSync } from 'node:crypto';
import test from 'node:test';
import { createAppServer } from '../server.mjs';
import { createStore, today } from '../store.mjs';
import { activateApiAccount } from '../test-support/business-account.mjs';

async function localApi(t) {
  const adminCredentials = { username: 'test-admin', password: 'fictional-admin', name: '测试管理员' };
  const server = createAppServer({ cutoff: today(), seed: true, admin: adminCredentials });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, input, token) => fetch(base + path, {
    method: input ? 'POST' : 'GET',
    headers: { ...(input && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: input ? JSON.stringify(input) : undefined,
  });
  const session = async (input, method = 'login') => {
    const response = await call(`/api/auth/${method}`, input);
    const body = await response.json();
    assert.equal(response.status, 200, body.message);
    const cookie = response.headers.get('set-cookie');
    return { ...body, cookie, token: body.token || cookie?.match(/^huzi_session=([^;]+)/)?.[1] };
  };
  const get = async (path, input, token) => {
    const response = await call(path, input, token);
    const body = await response.json();
    assert.equal(response.status, 200, body.message);
    return body;
  };
  const admin = await session(adminCredentials);
  let phone = 19900000009;
  const login = (profile, credentials) => {
    if (profile === 'admin') return admin;
    if (profile === 'new-investor') return session({ platform: 'mini', phone: String(++phone), password: 'fictional-investor' }, 'register');
    return session({ platform: 'mini', ...(credentials || { username: profile, password: 'fictional-sales' }) });
  };
  const view = session => get('/api/view', null, session.token);
  const post = (path, input, session) => get(`/api/${path}`, input, session.token);
  const status = async (path, input, session) => (await call(`/api/${path}`, input, session?.token)).status;
  for (const letter of ['a', 'b']) {
    const salesId = `sales-${letter}`;
    await post('accounts/sales', { salesId, name: `测试销售 ${letter.toUpperCase()}`, username: salesId }, admin);
    await activateApiAccount(base + '/api', salesId, 'fictional-sales');
    await activateApiAccount(base + '/api', `broker-${letter}`, `demo-broker-${letter}`);
  }
  return { base, call, login, view, post, status, session, adminCredentials };
}

function metric(snapshot, label) {
  const item = snapshot.metrics.find(row => row.label === label);
  assert.ok(item, `${label} exists`);
  assert.equal(item.value, item.records.length, `${label} tally matches its list`);
  return item;
}

test('后台全角色账号管理，注销撤销会话且保留业务记录，恢复不复活旧会话', async t => {
  const { login, view, post, status, session, adminCredentials } = await localApi(t);
  const admin = await login('admin');
  const investor = await login('new-investor');
  const sales = await login('sales-a');
  const broker = await login('broker', { username: 'broker-a', password: 'demo-broker-a' });
  await post('scan', { code: 'DEMO-A' }, investor);
  const lead = await post('leads', fixtureLead, investor);
  await post('signings', { clientId: investor.actor.id, signedOn: today(), reference: '账号生命周期测试' }, admin);
  await post('cases', { leadId: lead.id, title: '保留案件', openedOn: today(), status: '已受理' }, admin);
  const before = await view(admin);
  assert.deepEqual(new Set(before.accounts.map(item => item.role)), new Set(['admin', 'investor', 'broker', 'sales']));
  assert.ok(before.accounts.every(item => !('password' in item) && !('digest' in item)));
  assert.equal((await view(investor)).accounts, undefined);
  assert.equal((await view(sales)).accounts, undefined);
  const changes = identityId => ({ identityId, currentPassword: adminCredentials.password, status: 'closed' });
  const investorRow = before.accounts.find(item => item.subjectId === investor.actor.id);
  assert.equal(investorRow.name, fixtureLead.name);
  assert.equal(await status('accounts/status', changes(investorRow.id), sales), 403);
  assert.equal(await status('accounts/status', { ...changes(investorRow.id), currentPassword: 'wrong' }, admin), 400);
  assert.equal(await status('accounts/status', changes(before.accounts.find(item => item.role === 'admin').id), admin), 400);
  for (const actor of [investor, sales, broker]) {
    const row = before.accounts.find(item => item.role === actor.actor.role && item.subjectId === actor.actor.id);
    await post('accounts/status', changes(row.id), admin);
    assert.equal(await status('view', null, actor), 401);
  }
  assert.equal(await status('auth/login', { username: investor.actor.account, password: 'fictional-investor' }), 401);
  assert.equal(await status('auth/register', { phone: investor.actor.account, password: 'fictional-investor' }), 409);
  assert.equal(await status('referral/capture', { code: 'DEMO-A' }), 404);
  const after = await view(admin);
  for (const key of ['leads', 'clients', 'cases']) assert.deepEqual(after[key], before[key]);
  assert.equal(after.accounts.find(item => item.id === investorRow.id).status, 'closed');
  await post('accounts/status', { ...changes(investorRow.id), status: 'active' }, admin);
  assert.equal(await status('view', null, investor), 401);
  const restored = await session({ username: investor.actor.account, password: 'fictional-investor', platform: 'mini' });
  assert.equal((await view(restored)).leads[0].id, lead.id);
});

test('后台重置各角色密码强制首次修改，撤销全部旧会话和恢复码且保留归属', async t => {
  const { login, view, post, status, session, adminCredentials } = await localApi(t);
  const admin = await login('admin');
  const investor = await login('new-investor');
  for (const [username, password] of [[investor.actor.account, 'fictional-investor'], ['sales-a', 'fictional-sales'], ['broker-a', 'demo-broker-a']]) {
    const first = await session({ username, password, platform: 'mini' });
    const second = await session({ username, password, platform: 'mini' });
    const code = await post('auth/recovery-code', { currentPassword: password }, first);
    const row = (await view(admin)).accounts.find(item => item.username === username);
    const reset = { identityId: row.id, currentPassword: adminCredentials.password, password: 'temporary-password' };
    assert.equal(await status('accounts/password', reset, first), 403);
    await post('accounts/password', reset, admin);
    for (const old of [first, second]) assert.equal(await status('view', null, old), 401);
    assert.equal(await status('auth/login', { username, password }), 401);
    assert.equal(await status('auth/recover', { username, code: code.code, password: 'invalid-reuse' }), 400);
    const temporary = await session({ username, password: reset.password, platform: 'mini' });
    const restricted = await view(temporary);
    assert.equal(restricted.actor.passwordChangeRequired, true);
    assert.equal(restricted.metrics, undefined);
    assert.equal(restricted.leads, undefined);
    assert.equal(await status('auth/recovery-code', { currentPassword: reset.password }, temporary), 403);
    assert.equal(await status('leads', fixtureLead, temporary), 403);
    assert.equal(await status('auth/change-password', { currentPassword: reset.password, password: reset.password }, temporary), 400);
    await post('auth/change-password', { currentPassword: reset.password, password: 'personal-new-password' }, temporary);
    assert.equal(await status('view', null, temporary), 401);
    const changed = await session({ username, password: 'personal-new-password', platform: 'mini' });
    assert.equal(changed.actor.id, first.actor.id);
    assert.equal(changed.actor.passwordChangeRequired, false);
    assert.ok((await view(changed)).today);
  }
  const own = (await view(admin)).accounts.find(item => item.role === 'admin');
  const result = await post('accounts/password', { identityId: own.id, currentPassword: adminCredentials.password, password: 'admin-temporary' }, admin);
  assert.equal(result.signedOut, true);
  assert.equal(await status('view', null, admin), 401);
  const temporaryAdmin = await session({ username: adminCredentials.username, password: 'admin-temporary' });
  assert.equal((await view(temporaryAdmin)).accounts, undefined);
  assert.equal(await status('accounts/sales', { name: '不应创建' }, temporaryAdmin), 403);
  await post('auth/change-password', { currentPassword: 'admin-temporary', password: 'admin-personal-new' }, temporaryAdmin);
  const freshAdmin = await session({ username: adminCredentials.username, password: 'admin-personal-new' });
  assert.ok((await view(freshAdmin)).accounts.length > 0);
});

test('个人恢复码单次有效、轮换和密码修改失效，找回不自动登录且不可跨账号', async t => {
  const { login, view, post, call, status, session } = await localApi(t);
  const investor = await login('new-investor');
  const other = await login('new-investor');
  assert.equal(await status('auth/recovery-code', { currentPassword: 'fictional-investor' }), 401);
  assert.equal(await status('auth/recovery-code', { currentPassword: 'bad' }, investor), 400);
  const oldCode = await post('auth/recovery-code', { currentPassword: 'fictional-investor' }, investor);
  const newCode = await post('auth/recovery-code', { currentPassword: 'fictional-investor' }, investor);
  assert.notEqual(oldCode.code, newCode.code);
  assert.equal(newCode.expiresAt, null);
  assert.match(newCode.code, /^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);
  const recovery = { username: investor.actor.account, code: newCode.code, password: 'recovered-password' };
  assert.equal(await status('auth/recover', { ...recovery, code: oldCode.code }), 400);
  assert.equal(await status('auth/recover', { ...recovery, username: other.actor.account }), 400);
  assert.equal(await status('auth/recover', { ...recovery, code: '' }), 400);
  assert.equal(await status('auth/recover', { ...recovery, password: 'short' }), 400);
  const responses = await Promise.all([call('/api/auth/recover', recovery), call('/api/auth/recover', recovery)]);
  assert.deepEqual(responses.map(item => item.status).sort(), [200, 400]);
  assert.equal(responses.find(item => item.status === 200).headers.get('set-cookie'), null);
  assert.equal(await status('view', null, investor), 401);
  assert.equal(await status('auth/login', { username: investor.actor.account, password: 'fictional-investor' }), 401);
  const changed = await session({ username: investor.actor.account, password: recovery.password, platform: 'mini' });
  assert.equal(changed.actor.passwordChangeRequired, false);
  const changeCode = await post('auth/recovery-code', { currentPassword: recovery.password }, changed);
  await post('auth/change-password', { currentPassword: recovery.password, password: 'new-password-again' }, changed);
  assert.equal(await status('auth/recover', { ...recovery, code: changeCode.code }), 400);
  const admin = await login('admin');
  const logs = JSON.stringify((await view(admin)).audit);
  for (const secret of [newCode.code, oldCode.code, recovery.password]) assert.ok(!logs.includes(secret));
});

test('后台临时恢复码与错误次数限制，注销恢复后旧码仍无效', async t => {
  const { login, view, post, status, session, adminCredentials } = await localApi(t);
  const admin = await login('admin');
  const investor = await login('new-investor');
  const account = (await view(admin)).accounts.find(item => item.subjectId === investor.actor.id);
  const target = { identityId: account.id, currentPassword: adminCredentials.password };
  const recovery = { username: account.username, code: 'wrong-code', password: 'recovered-pass' };
  for (let i = 0; i < 5; i++) assert.equal(await status('auth/recover', recovery), 400);
  assert.equal(await status('auth/recover', recovery), 429);
  assert.ok(await view(investor), 'failed recovery must not lock normal login');
  assert.equal(await status('accounts/recovery-code', target, investor), 403);
  const code = await post('accounts/recovery-code', target, admin);
  assert.ok(new Date(code.expiresAt).getTime() > Date.now() + 29 * 60_000);
  await post('auth/recover', { ...recovery, code: code.code }, admin);
  const changed = await session({ username: account.username, password: recovery.password, platform: 'mini' });
  assert.equal(changed.actor.id, investor.actor.id);
  const old = await post('auth/recovery-code', { currentPassword: recovery.password }, changed);
  await post('accounts/status', { ...target, status: 'closed' }, admin);
  assert.equal(await status('accounts/recovery-code', target, admin), 400);
  assert.equal(await status('accounts/password', { ...target, password: 'new-password' }, admin), 400);
  await post('accounts/status', { ...target, status: 'active' }, admin);
  assert.equal(await status('auth/recover', { ...recovery, code: old.code }), 400);
});

test('恢复码只存散列并跨重启有效，临时码过期和最后管理员保护', () => {
  const directory = mkdtempSync(join(tmpdir(), 'huzi-security-'));
  const file = join(directory, 'db.sqlite');
  let store;
  try {
    store = createStore(file, { admin: { username: 'security-admin', password: 'admin-password', name: '安全测试管理员' } });
    const adminIdentity = store.verifyLogin({ username: 'security-admin', password: 'admin-password' });
    const admin = store.getSession(store.createSession(adminIdentity.id));
    const investorId = store.registerInvestor({ phone: '19900009900', password: 'investor-password' });
    const investor = store.getSession(store.createSession(investorId));
    const code = store.issueRecoveryCode(investor, { currentPassword: 'investor-password' });
    store.close(); store = null;
    const inspect = new DatabaseSync(file);
    const row = inspect.prepare('SELECT * FROM password_recovery WHERE identityId = ?').get(investorId);
    assert.equal(row.digest, createHash('sha256').update(code.code.replaceAll('-', '').toLowerCase()).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(code.code));
    inspect.close();
    store = createStore(file);
    store.recoverPassword({ username: investor.account, code: code.code, password: 'recovered-password' });
    const temporary = store.issueRecoveryCode(admin, { identityId: investorId, currentPassword: 'admin-password' }, true);
    const update = new DatabaseSync(file);
    update.prepare('UPDATE password_recovery SET expires = 1').run();
    update.close();
    assert.throws(() => store.recoverPassword({ username: investor.account, code: temporary.code, password: 'expired-code-password' }), /无效/);
    assert.throws(() => store.setAccountStatus(admin, { identityId: adminIdentity.id, currentPassword: 'admin-password', status: 'closed' }), /不能注销/);
    assert.ok(store.verifyLogin({ username: investor.account, password: 'recovered-password' }));
  } finally {
    store?.close();
    unlinkSync(file);
    rmdirSync(directory);
  }
});

const fixtureLead = { name: '测试股民甲', phone: '19900000003', stockName: '测试股票', stockCode: '000000',
  period: '2022–2024 年', consent: true };
const date = today();

test('合作登记、开户、首次扫码、留资与授权改归联动', async t => {
  const { base, login, view, post, status } = await localApi(t);
  const [sales, otherSales, admin, investor, otherInvestor] = await Promise.all([
    login('sales-a'), login('sales-b'), login('admin'), login('new-investor'), login('new-investor'),
  ]);
  assert.equal(await status('view', null), 401);
  const registration = { name: '测试新券商', signedOn: date, rebate: '12.5' };
  const { id } = await post('cooperations', registration, sales);
  const administered = (await view(admin)).brokers.find(item => item.id === id);
  assert.equal(administered.salesId, sales.actor.id);
  assert.equal(administered.rebate, 12.5);
  assert.equal(administered.username, null);
  assert.equal(await status('scan', { code: administered.code }, investor), 404);
  assert.equal(await status('cooperations', registration, sales), 409);
  const credentials = { username: 'fixture-broker', password: 'fictional-pass' };
  assert.equal(await status('accounts', { brokerId: id, ...credentials }, sales), 403);
  assert.equal(await status('auth/login', { platform: 'mini', ...credentials }), 401);
  await post('accounts', { brokerId: id, username: credentials.username }, admin);
  await activateApiAccount(base + '/api', credentials.username, credentials.password);
  const broker = await login('broker', credentials);
  assert.equal((await view(broker)).broker.name, registration.name);
  assert.deepEqual(await post('scan', { code: administered.code }, investor), { recorded: true });
  assert.deepEqual(await post('scan', { code: 'DEMO-B' }, investor), { recorded: false });
  assert.equal((await view(broker)).ledger[0].subtitle, '待留资');
  assert.equal(metric(await view(broker), '我的客户').records[0].title, '待留资客户');
  assert.equal(await status('leads', { ...fixtureLead, consent: false }, investor), 400);
  await post('companies', { name: fixtureLead.stockName, stockCode: fixtureLead.stockCode, aliases: '', salesId: sales.actor.id, active: true }, admin);
  const lead = await post('leads', fixtureLead, investor);
  const ownView = await view(investor);
  assert.equal(ownView.actor.name, investor.actor.account);
  assert.deepEqual(ownView.contact, { name: fixtureLead.name, phone: fixtureLead.phone });
  assert.equal(ownView.leads[0].id, lead.id);
  assert.deepEqual(ownView.leads[0].cases, []);
  const otherView = await view(otherInvestor);
  assert.notEqual(otherView.actor.name, investor.actor.name);
  assert.equal(otherView.contact, null);
  assert.deepEqual(otherView.leads, []);
  const visible = metric(await view(sales), '渠道客户').records.find(row => row.id === investor.actor.id);
  assert.equal(visible.title, fixtureLead.name);
  assert.equal(visible.phone, fixtureLead.phone);
  const brokerView = await view(broker);
  const dashboardCustomer = metric(brokerView, '我的客户').records[0];
  assert.equal(dashboardCustomer.title, fixtureLead.name);
  assert.equal(dashboardCustomer.phone, undefined);
  assert.equal(brokerView.ledger[0].phone, undefined);
  assert.equal(brokerView.ledger[0].title, fixtureLead.name);
  assert.equal(await status('followups', { clientId: investor.actor.id, note: '越权尝试' }, otherSales), 404);
  assert.equal(await status('followups', { leadId: lead.id, version: 1, note: '旧客户端提交' }, sales), 404);
  assert.equal((await view(sales)).assignedLeads.find(row => row.id === lead.id).assignmentStatus, '已分配');
  assert.doesNotMatch(JSON.stringify(await view(sales)),/followups|followStatus|canFollowup/);
  await post('reassign', { clientId: investor.actor.id, brokerId: 'broker-b' }, admin);
  assert.deepEqual(await post('scan', { code: administered.code }, investor), { recorded: false });
  assert.equal((await view(broker)).ledger.length, 0);
  assert.equal(metric(await view(broker), '我的客户').value, 0);
  assert.ok(metric(await view(otherSales), '渠道客户').records.some(row => row.id === investor.actor.id));
  const reassigned = (await view(admin)).clients.find(item => item.id === investor.actor.id);
  assert.equal(reassigned.firstBrokerId, id);
  assert.equal(reassigned.brokerId, 'broker-b');
  assert.ok((await view(sales)).assignedLeads.some(row => row.id === lead.id));
  assert.ok(!(await view(otherSales)).assignedLeads.some(row => row.id === lead.id));
  assert.ok((await view(admin)).audit.some(entry => entry.action === '调整客户归属'));
});

test('统一登录按服务器角色分流，公开注册与个人名称隔离旧案和授权操作', async t => {
  const { base, login, view, post, status, session, adminCredentials } = await localApi(t);
  const admin = await login('admin');
  assert.match(admin.cookie, /HttpOnly/);
  assert.match(admin.cookie, /SameSite=Strict/);
  const adminView = await fetch(`${base}/api/view`, { headers: { Cookie: admin.cookie.split(';')[0] } });
  assert.equal((await adminView.json()).actor.role, 'admin');
  assert.equal(await status('auth/login', { ...adminCredentials, platform: 'mini' }), 403);
  assert.equal(await status('demo/session', { profile: 'admin' }), 401);
  const legacyPhone = '19900000001';
  const credentials = { phone: legacyPhone, password: 'fictional-investor', platform: 'mini', role: 'admin', subjectId: 'customer-a' };
  const investor = await session(credentials, 'register');
  assert.equal(investor.actor.role, 'investor');
  assert.notEqual(investor.actor.id, 'customer-a');
  const snapshot = await view(investor);
  assert.equal(snapshot.actor.account, legacyPhone);
  assert.equal(snapshot.actor.name, legacyPhone);
  assert.equal(snapshot.contact, null);
  assert.deepEqual(snapshot.leads, []);
  assert.ok((await view(admin)).leads.some(lead => lead.id === 'lead-demo-a'));
  assert.equal(await status('auth/register', credentials), 409);
  assert.equal(await status('accounts/sales', { role: 'sales' }, investor), 403);
  assert.equal(await status('accounts', { role: 'broker' }, investor), 403);
  assert.equal(await status('reassign', { brokerId: 'broker-b' }, investor), 403);
  assert.equal(await status('export', null, investor), 403);
  assert.equal(await status('auth/login', { username: legacyPhone, password: 'wrong-password', platform: 'mini' }), 401);
  await post('leads', fixtureLead, investor);
  await post('profile/name', { name: '本人新显示名', username: 'fake-admin', role: 'admin' }, investor);
  assert.equal((await view(investor)).actor.name, '本人新显示名');
  const relogged = await session({ username: legacyPhone, password: credentials.password, platform: 'mini' });
  assert.equal(relogged.actor.name, '本人新显示名');
  assert.equal(relogged.actor.account, legacyPhone);
  assert.deepEqual((await view(relogged)).contact, { name: fixtureLead.name, phone: fixtureLead.phone });
  await post('auth/logout', {}, investor);
  assert.equal(await status('view', null, investor), 401);
  assert.equal((await view(relogged)).actor.role, 'investor');
  const broker = await login('broker', { username: 'broker-a', password: 'demo-broker-a' });
  assert.equal((await view(broker)).actor.name, '示例券商 A');
  assert.equal((await view(broker)).actor.account, 'broker-a');
  assert.equal(await status('profile/name', { name: '越权改名' }, broker), 403);
  const sales = await login('sales-a');
  assert.equal((await view(sales)).actor.name, '测试销售 A');
  assert.equal((await view(sales)).actor.account, 'sales-a');
});

test('注册前先 A 后 B 保留 A，直接注册留空，无归属可补绑，改归后扫码不覆盖', async t => {
  const { base, login, view, post, session } = await localApi(t);
  const [admin, salesA, salesB, brokerA, brokerB] = await Promise.all([
    login('admin'), login('sales-a'), login('sales-b'),
    login('broker', { username: 'broker-a', password: 'demo-broker-a' }),
    login('broker', { username: 'broker-b', password: 'demo-broker-b' }),
  ]);
  const browserPost = (path, body, cookie) => fetch(`${base}/api/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const invalid = await browserPost('referral/capture', { code: 'missing-code' });
  assert.equal(invalid.status, 404);
  assert.equal(invalid.headers.get('set-cookie'), null);
  const a = await browserPost('referral/capture', { code: 'DEMO-A' });
  const pending = a.headers.get('set-cookie').split(';')[0];
  assert.match(pending, /^huzi_referral=/);
  assert.deepEqual(await a.json(), { pending: true, recorded: true });
  const b = await browserPost('referral/capture', { code: 'DEMO-B' }, pending);
  assert.equal(b.headers.get('set-cookie').split(';')[0], pending);
  assert.deepEqual(await b.json(), { pending: true, recorded: false });
  const created = await browserPost('auth/register', { phone: '19900000029', password: 'fictional-investor' }, pending);
  assert.equal(created.status, 200);
  assert.ok(created.headers.getSetCookie().some(cookie => cookie.startsWith('huzi_referral=;')));
  const primary = (await created.json()).actor;
  const primaryToken = created.headers.getSetCookie()[0].match(/^huzi_session=([^;]+)/)[1];
  const investor = { actor: primary, token: primaryToken };
  const find = async id => (await view(admin)).clients.find(row => row.id === id);
  assert.equal((await find(primary.id)).firstBrokerId, 'broker-a');
  assert.equal((await find(primary.id)).brokerId, 'broker-a');
  await post('leads', fixtureLead, investor);
  assert.ok(metric(await view(salesA), '渠道客户').records.some(row => row.id === primary.id));
  assert.ok((await view(brokerA)).ledger.some(row => row.id === primary.id));
  assert.ok(!metric(await view(salesB), '渠道客户').records.some(row => row.id === primary.id));
  assert.ok(!(await view(brokerB)).ledger.some(row => row.id === primary.id));
  assert.deepEqual(await post('referral/capture', { code: 'DEMO-B' }, investor), { pending: false, recorded: false });
  await post('reassign', { clientId: primary.id, brokerId: 'broker-b' }, admin);
  await post('referral/capture', { code: 'DEMO-A' }, investor);
  assert.equal((await find(primary.id)).firstBrokerId, 'broker-a');
  assert.equal((await find(primary.id)).brokerId, 'broker-b');
  assert.ok(metric(await view(salesB), '渠道客户').records.some(row => row.id === primary.id));
  assert.ok(!(await view(brokerA)).ledger.some(row => row.id === primary.id));

  const direct = await session({ phone: '19900000039', password: 'fictional-investor', platform: 'mini' }, 'register');
  await post('leads', { ...fixtureLead, name: '直接注册客户' }, direct);
  assert.equal((await find(direct.actor.id)).brokerId, null);
  assert.equal((await find(direct.actor.id)).firstBrokerId, null);
  await post('referral/capture', { code: 'DEMO-B', platform: 'mini' }, direct);
  assert.equal((await find(direct.actor.id)).brokerId, 'broker-b');
  assert.equal((await find(direct.actor.id)).firstBrokerId, 'broker-b');
  const replay = await browserPost('auth/register', { phone: '19900000049', password: 'fictional-investor' }, pending);
  assert.equal(replay.status, 200);
  assert.equal(await find((await replay.json()).actor.id), undefined);
});

test('后台会话与不同业务标签页的登录和退出互不覆盖', async t => {
  const { base, adminCredentials } = await localApi(t);
  const adminPath = '/api/admin';
  const salesPath = '/api/business/11111111111111111111111111111111';
  const investorPath = '/api/business/22222222222222222222222222222222';
  const call = (scope, endpoint, body, cookie) => fetch(`${base}${scope}${endpoint}`, {
    method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await call(adminPath, '/auth/register', { phone: '19900000076', password: 'fictional-investor' })).status, 403);
  assert.equal((await call(salesPath, '/auth/login', adminCredentials)).status, 403);
  assert.equal((await call(adminPath, '/auth/login', { username: 'sales-a', password: 'fictional-sales' })).status, 403);
  const signIn = async (scope, endpoint, input, name) => {
    const response = await call(scope, endpoint, input);
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie.startsWith(`${name}=`));
    assert.match(setCookie, new RegExp(`Path=${scope}; HttpOnly`));
    return setCookie.split(';')[0];
  };
  const admin = await signIn(adminPath, '/auth/login', adminCredentials, 'huzi_pc');
  const sales = await signIn(salesPath, '/auth/login', { username: 'sales-a', password: 'fictional-sales' }, 'huzi_business');
  const investor = await signIn(investorPath, '/auth/register', { phone: '19900000076', password: 'fictional-investor' }, 'huzi_business');
  const role = async (scope, cookie) => {
    const response = await call(scope, '/view', null, cookie);
    assert.equal(response.status, 200);
    return (await response.json()).actor.role;
  };
  assert.equal(await role(adminPath, admin), 'admin');
  assert.equal(await role(salesPath, sales), 'sales');
  assert.equal(await role(investorPath, investor), 'investor');
  assert.equal((await call(adminPath, '/view', null, sales)).status, 401);
  assert.equal((await call(investorPath, '/view', null, admin)).status, 401);
  const logout = await call(investorPath, '/auth/logout', {}, investor);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call(investorPath, '/view', null, investor)).status, 401);
  assert.equal(await role(adminPath, admin), 'admin');
  assert.equal(await role(salesPath, sales), 'sales');
});

test('重复签约只计一人，同一客户多案按件统计，新增案件保留日期写入限制', async t => {
  const { call, login, view, post, status } = await localApi(t);
  const [admin, sales, broker, investor] = await Promise.all([
    login('admin'), login('sales-b'), login('broker', { username: 'broker-b', password: 'demo-broker-b' }), login('new-investor'),
  ]);
  await post('scan', { code: 'DEMO-B' }, investor);
  const lead = await post('leads', fixtureLead, investor);
  const actual = { clientId: investor.actor.id, reference: '虚构签约凭据-001', signedOn: date };
  assert.equal(await status('signings', actual, sales), 403);
  assert.deepEqual(await post('signings', actual, admin), { changed: true });
  assert.deepEqual(await post('signings', actual, admin), { changed: false });
  assert.equal(metric(await view(sales), '有效客户').value, 1);
  const signedCards = metric(await view(broker), '本月新增签约').records;
  assert.equal(signedCards.length, 1);
  assert.equal(signedCards[0].title, fixtureLead.name);
  assert.equal(signedCards[0].phone, undefined);
  const caseInput = { leadId: lead.id, title: '虚构新案甲', openedOn: date, status: '已受理' };
  assert.equal(await status('cases', { ...caseInput, openedOn: '2000-01-01' }, admin), 400);
  const first = await post('cases', caseInput, admin);
  const second = await post('cases', { ...caseInput, title: '虚构新案乙', status: '诉讼中' }, admin);
  const ongoing = metric(await view(broker), '在办案件').records;
  assert.deepEqual(ongoing.map(card => card.subtitle).sort(), ['虚构新案乙', '虚构新案甲']);
  assert.ok(ongoing.every(card => card.title === fixtureLead.name && card.phone === undefined));
  assert.equal(metric(await view(broker), '已结案').value, 0);
  await post('cases', { id: first.id, status: '已结案' }, admin);
  assert.deepEqual(metric(await view(broker), '在办案件').records.map(row => row.id), [second.id]);
  const brokerClosed = metric(await view(broker), '已结案').records;
  assert.deepEqual(brokerClosed.map(row => row.id), [first.id]);
  assert.equal(brokerClosed[0].subtitle, caseInput.title);
  const closed = metric(await view(sales), '已结案');
  assert.equal(closed.records[0].phone, fixtureLead.phone);
  assert.equal(closed.records[0].status, '已结案');
  assert.equal(metric(await view(sales), '有效客户').value, 1);
  assert.equal((await view(investor)).leads[0].cases.find(record => record.id === first.id).status, '已结案');
  await post('cases', { id: second.id, status: '已结案' }, admin);
  assert.equal(metric(await view(sales), '已结案').value, 2);
  assert.equal(metric(await view(broker), '已结案').value, 2);
  assert.equal(metric(await view(broker), '在办案件').value, 0);
  assert.equal(metric(await view(broker), '本月新增签约').value, 1);
  const filters = `type=signings&brokerId=broker-b&salesId=sales-b&from=${date}&to=${date}`;
  const csv = await call(`/api/export?${filters}`, null, admin.token);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.ok(text.includes(fixtureLead.name));
  assert.ok(!text.includes('虚构客户甲'));
  assert.match(text, /"记录编号","客户姓名","券商","销售","日期","状态"/);
  assert.match(text, /"QY-\d{6}","测试股民甲","示例券商 B","测试销售 B","\d{4}-\d{2}-\d{2}","已签约"/);
  assert.ok(!text.includes('sales-b'));
  const excel = await call(`/api/export?${filters}&format=xlsx`, null, admin.token);
  assert.equal(excel.status, 200);
  assert.match(excel.headers.get('content-type'), /spreadsheetml/);
  assert.equal(Buffer.from(await excel.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  assert.equal(await status('export', null, broker), 403);
});

test('本地数据和测试案件分界日跨重启保留', () => {
  const directory = mkdtempSync(join(tmpdir(), 'huzilvsuo-test-'));
  const path = join(directory, 'demo.sqlite');
  const author = { role: 'sales', id: 'sales-a' };
  const admin = { role: 'admin', id: 'admin' };
  let store = createStore(path, { cutoff: date });
  try {
    const broker = store.registerBroker(author, { name: '跨重启示例券商', rebate: '5', signedOn: date });
    store.close();
    store = createStore(path, { cutoff: '2000-01-01' });
    assert.equal(store.view(admin).caseCutoff, date);
    assert.ok(metric(store.view(author), '券商渠道').records.some(card => card.id === broker.id));
  } finally {
    store.close();
    unlinkSync(path);
    rmdirSync(directory);
  }
});

test('迁移旧账号沿用散列、绑定和旧业务，持久化会话可过期', () => {
  const directory = mkdtempSync(join(tmpdir(), 'huzilvsuo-auth-'));
  const path = join(directory, 'legacy.sqlite');
  const password = 'legacy-broker-test';
  const passwordHash = `legacysalt:${scryptSync(password, 'legacysalt', 32).toString('hex')}`;
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE brokers(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, salesId TEXT NOT NULL,
    signedOn TEXT NOT NULL, rebate REAL NOT NULL, code TEXT NOT NULL UNIQUE);
    CREATE TABLE accounts(brokerId TEXT PRIMARY KEY REFERENCES brokers(id), username TEXT NOT NULL UNIQUE, password TEXT NOT NULL);
    CREATE TABLE clients(id TEXT PRIMARY KEY, name TEXT, phone TEXT, firstBrokerId TEXT REFERENCES brokers(id),
    brokerId TEXT REFERENCES brokers(id), createdAt TEXT NOT NULL);
    CREATE TABLE leads(id TEXT PRIMARY KEY, clientId TEXT NOT NULL REFERENCES clients(id),
    stockName TEXT NOT NULL, stockCode TEXT NOT NULL, period TEXT NOT NULL, createdAt TEXT NOT NULL);`);
  legacy.prepare('INSERT INTO brokers VALUES (?,?,?,?,?,?)').run('legacy-b', '旧券商', 'legacy-sale', date, 5, 'legacy-code');
  legacy.prepare('INSERT INTO accounts VALUES (?,?,?)').run('legacy-b', 'legacy-account', passwordHash);
  legacy.prepare('INSERT INTO clients VALUES (?,?,?,?,?,?)').run('legacy-client', '旧客户', '19900000099', 'legacy-b', 'legacy-b', date);
  legacy.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?)').run('legacy-lead', 'legacy-client', '旧股票', '000000', '测试', date);
  legacy.close();
  let store;
  try {
    store = createStore(path);
    const broker = store.verifyLogin({ username: 'legacy-account', password });
    const token = store.createSession(broker.id);
    const actor = store.getSession(token);
    assert.equal(actor.id, 'legacy-b');
    assert.equal(store.view(actor).ledger[0].id, 'legacy-client');
    const legacyLead = store.view({ id: 'ops', role: 'admin' }).leads[0];
    assert.equal(legacyLead.id, 'legacy-lead');
    assert.ok(legacyLead.recordNumber > 0);
    assert.equal(store.view({ id: 'ops', role: 'admin' }).sales[0].id, 'legacy-sale');
    const inspect = new DatabaseSync(path);
    assert.equal(inspect.prepare('SELECT password FROM identities').get().password, passwordHash);
    assert.equal(inspect.prepare('SELECT count(*) AS count FROM accounts').get().count, 0);
    assert.equal(inspect.prepare('SELECT digest FROM auth_sessions').get().digest, createHash('sha256').update(token).digest('hex'));
    inspect.close();
    store.close();
    store = createStore(path);
    assert.deepEqual(store.getSession(token), actor);
    assert.equal(store.view({ id: 'ops', role: 'admin' }).leads[0].recordNumber, legacyLead.recordNumber);
    const expired = new DatabaseSync(path);
    expired.exec('UPDATE auth_sessions SET expires = 0');
    expired.close();
    assert.equal(store.getSession(token), null);
  } finally {
    store?.close();
    unlinkSync(path);
    rmdirSync(directory);
  }
});
