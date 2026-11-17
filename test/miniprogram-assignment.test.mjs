import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createAppServer } from '../server.mjs';

test('小程序销售工作台按留资展示、过滤和提交跟进，转派后旧销售无法写入', async t => {
  const server = createAppServer({ seed: true, admin: { username: 'mini-ops', password: 'admin-password', name: '测试运营' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const raw = async (path, input, token) => {
    const response = await fetch(base + path, { method: input ? 'POST' : 'GET', headers: { ...(input && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }) }, body: input ? JSON.stringify(input) : undefined });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message), { status: response.status });
    return { data, response };
  };
  const ops = await raw('/auth/login', { username: 'mini-ops', password: 'admin-password' });
  const admin = ops.response.headers.get('set-cookie').match(/^huzi_session=([^;]+)/)[1];
  for (const id of ['sales-a', 'sales-b']) await raw('/accounts/sales', { salesId: id, name: id, username: id, password: 'sales-password' }, admin);
  const company = (await raw('/companies', { name: '测试甲公司', stockCode: 'TSTA', aliases: '', salesId: 'sales-b', active: true }, admin)).data;
  const investor = (await raw('/auth/register', { phone: '19900004401', password: 'investor-password', platform: 'mini' })).data;
  const lead = (await raw('/leads', { name: '测试留资人', phone: '19900004401', stockName: '测试甲公司', stockCode: 'TSTA', period: '2024 年至今', consent: true }, investor.token)).data;
  const seller = (await raw('/auth/login', { username: 'sales-b', password: 'sales-password', platform: 'mini' })).data;
  const app = { globalData: { token: seller.token, pendingPromos: [] }, savePromos() {} };
  const client = {
    request: async (path, input) => (await raw(path, input, app.globalData.token)).data,
    capturePromos: async () => false, showLogin: () => { app.globalData.token = ''; },
  };
  const pageModule = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../miniprogram/page.js', import.meta.url), 'utf8'), {
    getApp: () => app, require: () => client, module: pageModule, wx: { switchTab() {}, reLaunch() {} },
  });
  const page = pageModule.exports(true);
  page.setData = values => Object.assign(page.data, values);
  await page.onShow();
  assert.equal(page.data.assignedRecords.length, 1);
  assert.equal(page.data.assignedRecords[0].stockCode, 'TSTA');
  assert.equal(page.data.assignedRecords[0].brokerId, null);
  await page.submit({ currentTarget: { dataset: { type: 'followup', id: lead.id, version: 1 } }, detail: { value: { note: '小程序跟进' } } });
  assert.equal(page.data.assignedRecords.length, 0);
  page.pickFollow({ currentTarget: { dataset: { status: '已跟进' } } });
  assert.equal(page.data.assignedRecords[0].followups[0].note, '小程序跟进');
  await raw('/assignments', { leadId: lead.id, companyId: company.id, salesId: 'sales-a', version: 1, reason: '运营转派' }, admin);
  await page.submit({ currentTarget: { dataset: { type: 'followup', id: lead.id, version: 1 } }, detail: { value: { note: '旧页面不应写入' } } });
  assert.match(page.data.notice, /无法跟进/);
  await page.onShow();
  assert.equal(page.data.assignedRecords.length, 0);
  const newSeller = (await raw('/auth/login', { username: 'sales-a', password: 'sales-password', platform: 'mini' })).data;
  app.globalData.token = newSeller.token;
  await page.onShow();
  assert.equal(page.data.followFilter, '待跟进');
  assert.equal(page.data.assignedRecords.length, 1);
  assert.equal(page.data.assignedRecords[0].version, 2);
  assert.equal(page.data.assignedRecords[0].followups.length, 1);
});
