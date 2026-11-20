import { developAccountInfo, isolatedRequest, nativePages } from '../test-support/native-page.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppServer } from '../server.mjs';
import { activateApiAccount } from '../test-support/business-account.mjs';

test('券商推荐客户可按姓名、股票和日期查阅案件进度，转派后只有新经办销售可查阅', async t => {
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
  for (const id of ['sales-a', 'sales-b']) {
    await raw('/accounts/sales', { salesId: id, name: id, username: id }, admin);
    await activateApiAccount(base, id, 'sales-password');
  }
  const company = (await raw('/companies', { name: '测试甲公司', stockCode: 'TSTA', aliases: '', salesId: 'sales-a', active: true }, admin)).data;
  const promo = (await raw('/referral/capture', { code: 'DEMO-B', platform: 'mini' })).data;
  const investor = (await raw('/auth/register', { phone: '19900004401', password: 'investor-password', platform: 'mini', referralToken: promo.referralToken })).data;
  const lead = (await raw('/leads', { name: '小盒原生测试客户', phone: '19900004401', stockName: '测试甲公司', stockCode: 'TSTA', period: '2024 年至今', consent: true }, investor.token)).data;
  const seller = (await raw('/auth/login', { username: 'sales-b', password: 'sales-password', platform: 'mini' })).data;
  const app = { globalData: { token: seller.token, pendingPromos: [] }, savePromos() {} };
  let destination;
  const wx = {
    switchTab() {}, reLaunch() {}, removeStorageSync() {}, navigateTo: ({ url }) => { destination = url; },
    getAccountInfoSync: developAccountInfo, request: isolatedRequest(base),
  };
  const pages = nativePages({ app, wx, networkConfig: { apiBase: base } });
  const page = pages.create(true);
  await page.onShow();
  assert.deepEqual(Array.from(page.data.recordList.data.items, row => row.progressId).sort(), [lead.id, 'lead-demo-b'].sort());
  assert.equal(page.data.recordList.data.items.find(row => row.progressId === lead.id).stockCode, 'TSTA');
  page.recordsInput({ detail: { value: '小盒' } }); await page.recordsSearch();
  assert.equal(page.data.recordList.data.total, 1);
  const ownView = (await raw('/view', undefined, investor.token)).data;
  await raw('/signings', { clientId: ownView.actor.id, signedOn: ownView.today, reference: '原生流程合成签约凭据' }, admin);
  await page.onShow();
  const searched = page.data.recordList.data.items[0];
  page.openProgress({ currentTarget: { dataset: { kind: searched.kind, id: searched.progressId } } });
  page.onHide();
  const detail = pages.page('progress');
  detail.onLoad(Object.fromEntries(new URL(destination, 'http://local').searchParams));
  await detail.onShow();
  assert.equal(detail.data.detail.id, lead.id);
  assert.equal(detail.data.detail.signedOn, ownView.today);
  assert.equal(detail.data.detail.steps[0].label, '已签约');
  assert.equal(detail.data.detail.steps[0].note, undefined);
  assert.equal(detail.data.detail.steps[1].label, '立案材料准备中');
  detail.onHide(); app.globalData.token = investor.token;
  await detail.onShow();
  assert.equal(detail.data.detail.signedOn, ownView.today);
  assert.equal(detail.data.detail.steps[0].note, '待立案');
  assert.equal('contractNumber' in detail.data.detail, false);
  detail.onHide(); app.globalData.token = seller.token;
  await page.onShow();
  assert.equal(page.data.recordList.q, '小盒', '进度返回后保留客户检索');
  assert.equal(page.data.recordList.data.total, 1);
  const caseRecord = (await raw('/cases', { leadId: lead.id, title: '测试甲公司索赔案', openedOn: ownView.today, status: '已受理' }, admin)).data;
  page.recordsInput({ detail: { value: 'TSTA' } });
  await page.recordsSearch();
  for (const field of ['from', 'to']) {
    page.recordsPickDate({ currentTarget: { dataset: { field } }, detail: { value: ownView.today } });
  }
  await page.recordsApplyDates();
  assert.equal(page.data.recordList.data.total, 1);
  const currentCase = page.data.recordList.data.items[0].cases.find(row => row.id === caseRecord.id);
  assert.equal(currentCase.status, '已受理');
  page.openProgress({ currentTarget: { dataset: { kind: 'case', id: currentCase.id } } });
  detail.onLoad(Object.fromEntries(new URL(destination, 'http://local').searchParams));
  await detail.onShow();
  assert.equal(detail.data.detail.id, caseRecord.id);
  detail.onHide();
  await raw('/assignments', { leadId: lead.id, companyId: company.id, salesId: 'sales-a', version: 1, reason: '运营转派' }, admin);
  await page.onShow();
  assert.equal(page.data.recordList.data.items.length, 0);
  await detail.onShow();
  assert.equal(detail.data.detail, null);
  assert.match(detail.data.notice, /未找到|无权/);
  const newSeller = (await raw('/auth/login', { username: 'sales-a', password: 'sales-password', platform: 'mini' })).data;
  app.globalData.token = newSeller.token;
  await page.onShow();
  assert.equal(page.data.recordList.period, 'all');
  assert.deepEqual(Array.from(page.data.recordList.data.items, row => row.progressId).sort(), [lead.id, 'lead-demo-a'].sort());
  await detail.onShow();
  assert.equal(detail.data.detail.id, caseRecord.id);
  assert.equal(detail.data.detail.title, '测试甲公司索赔案');
});
