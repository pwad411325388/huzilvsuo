import assert from 'node:assert/strict';
import test from 'node:test';
import { nativePages } from '../test-support/native-page.mjs';

const event = dataset => ({ currentTarget: { dataset } });
const settle = () => new Promise(resolve => setImmediate(resolve));
function response(path, id = 'current') {
  const p = new URL(path, 'http://local').searchParams;
  const limit = Number(p.get('limit') || 20), offset = Number(p.get('offset'));
  const rows = Array.from({ length: 41 }, (_, index) => ({ id: index ? id + '-' + index : id, stockName: '测试股票' }));
  return { q: p.get('q'), period: p.get('period'), from: p.get('from'), to: p.get('to'), ledger: p.get('ledger') || 'all',
    customerId: p.get('customerId') || '', items: rows.slice(offset, offset + limit), total: rows.length, unfilteredTotal: rows.length,
    customerCount: 2, offset, limit, today: '2026-11-20', orderLabel: '日期从新到旧' };
}
function setup(role = 'sales', home = true, fetchRecords = async path => response(path), standalone = false) {
  const app = { globalData: { token: 'session-a' } }, requests = [], navigations = [];
  const client = { capturePromos: async () => false, showLogin: () => { app.globalData.token = ''; },
    request: async (path, input) => {
      requests.push({ path, input });
      if (path === '/view') return { actor: { role, id: app.globalData.token }, today: '2026-11-20' };
      return fetchRecords(path, input);
    } };
  const wx = { navigateTo: ({ url }) => navigations.push(url), reLaunch: ({ url }) => navigations.push(url) };
  const pages = nativePages({ app, client, wx });
  return { app, requests, navigations, page: standalone ? pages.page('registry') : pages.create(home) };
}

test('首页查看全部按案件展开，换日期和翻页沿用相同口径，其他角色不能启用', async () => {
  for (const role of ['investor', 'sales', 'broker']) {
    const { page, requests } = setup(role, false, undefined, true);
    page.onLoad({ presentation: 'home' });
    await page.onShow();
    assert.equal(page.data.recordList.expanded, true);
    assert.equal(page.data.recordList.data.items.length, 5);
    await page.toggleRecordResults();
    assert.equal(page.data.recordList.expanded, false);
    await page.recordsPickPeriod(event({ period: 'month' }));
    assert.equal(page.data.recordList.expanded, true);
    const firstPage = page.data.recordList.data.items.map(item => item.id);
    await page.toggleRecordResults();
    await page.recordsNext();
    assert.equal(page.data.recordList.expanded, true);
    assert.equal(page.data.recordList.offset, 5);
    assert.equal(new Set([...firstPage, ...page.data.recordList.data.items.map(item => item.id)]).size, 10);
    await page.toggleRecordResults();
    await page.toggleRecordResults();
    assert.equal(page.data.recordList.page, 2);
    const reads = requests.filter(item => item.path.startsWith('/records?'));
    assert.equal(reads.length, 3);
    for (const read of reads) {
      const params = new URL(read.path, 'http://local').searchParams;
      assert.equal(params.get('limit'), '5');
      assert.equal(params.has('follow'), false);
      assert.equal(params.get('presentation'), role === 'investor' ? 'home' : null);
    }
  }
});

test('咨询表单收起保留挂载状态，切换股民账号时清除之前的草稿', async () => {
  const { app, page } = setup('investor');
  await page.onShow();
  assert.equal(page.data.consultationStarted, false);
  page.toggleConsultation();
  page.pickPeriod({ detail: { value: 1 } });
  page.toggleConsultation();
  assert.equal(page.data.consultationOpen, false);
  assert.equal(page.data.consultationStarted, true);
  assert.equal(page.data.period, '2020–2022 年');
  page.onHide();
  app.globalData.token = 'session-b';
  await page.onShow();
  assert.equal(page.data.consultationStarted, false);
  assert.equal(page.data.period, '');
});

test('销售首页默认收起，搜索和筛选展开列表，进度返回保留期间及页码，重新进入首页收起', async () => {
  const { page, requests, app } = setup();
  await page.onShow();
  assert.match(requests.at(-1).path, /^\/records\?q=&period=all&offset=0&limit=5$/);
  assert.equal(page.data.recordList.expanded, false);
  assert.equal(page.data.recordList.data.total, 41);
  await page.toggleRecordResults();
  assert.equal(page.data.recordList.expanded, true);
  await page.toggleRecordResults();
  assert.equal(page.data.recordList.expanded, false);
  page.recordsInput({ detail: { value: '小盒 股票' } });
  await page.recordsSearch();
  assert.equal(page.data.recordList.expanded, true);
  assert.equal(new URL(requests.at(-1).path, 'http://local').searchParams.get('q'), '小盒 股票');
  await page.toggleRecordResults();
  await page.recordsPickPeriod(event({ period: 'month' }));
  assert.equal(page.data.recordList.expanded, true);
  await page.recordsNext();
  assert.equal(page.data.recordList.offset, 5);
  page.onHide();
  assert.equal(page.data.recordList.data, null);
  await page.onShow();
  assert.equal(page.data.recordList.expanded, true);
  assert.match(requests.at(-1).path, /period=month&offset=5&limit=5/);
  page.recordsPickDate({ ...event({ field: 'from' }), detail: { value: '2025-01-01' } });
  page.recordsPickDate({ ...event({ field: 'to' }), detail: { value: '2025-12-31' } });
  await page.recordsApplyDates();
  page.recordsPickDate({ ...event({ field: 'from' }), detail: { value: '2026-01-01' } });
  await page.recordsSearch();
  assert.match(requests.at(-1).path, /period=custom&offset=0&limit=5&from=2025-01-01&to=2025-12-31$/);
  assert.equal(page.data.recordList.from, '2026-01-01', '回包不能抹掉尚未应用的草稿');
  page.onTabItemTap();
  assert.equal(page.data.recordList.expanded, false);
  await page.recordsPickPeriod(event({ period: 'all' }));
  assert.equal(page.data.recordList.expanded, true);
  app.globalData.token = 'session-b';
  await page.onShow();
  assert.equal(page.data.recordList.expanded, false);
});

test('较早搜索、隐藏页面、切换账号的请求不会覆盖当前统一记录，换人清空客户范围', async () => {
  const pending = [];
  const { page, app } = setup('sales', false, path => new Promise(resolve => pending.push({ path, resolve })), true);
  page.onLoad({ customerId: 'customer-a', period: 'month' });
  const initial = page.onShow(); await settle();
  page.recordsInput({ detail: { value: '新查询' } });
  const searched = page.recordsSearch();
  pending[1].resolve(response(pending[1].path, 'latest')); await searched;
  pending[0].resolve(response(pending[0].path, 'stale')); await initial;
  assert.equal(page.data.recordList.data.items[0].id, 'latest');
  const hidden = page.loadRecords(); page.onHide();
  pending[2].resolve(response(pending[2].path, 'hidden')); await hidden;
  assert.equal(page.data.recordList.data, null);
  const returned = page.onShow(); await settle();
  assert.match(pending[3].path, /customerId=customer-a/);
  page.onHide(); app.globalData.token = 'session-b';
  const changed = page.onShow(); await settle();
  assert.match(pending[4].path, /^\/records\?q=&period=all&offset=0&limit=5$/);
  pending[4].resolve(response(pending[4].path, 'new-owner')); await changed;
  pending[3].resolve(response(pending[3].path, 'old-owner')); await returned;
  assert.equal(page.data.recordList.data.items[0].id, 'new-owner');
});

test('无效日期不请求，坏响应与401明确处理', async () => {
  let fail = true;
  const { page, requests, app } = setup('investor', false, async path => fail ? {} : response(path));
  await page.onShow();
  assert.match(page.data.recordList.error, /完整返回/);
  assert.equal(page.data.recordList.data, null);
  fail = false; await page.retryRecords();
  const count = requests.length;
  for (const [from, to] of [['2026-02-30','2026-03-01'],['2026-11-20','2026-11-01'],['2026-11-20','2026-11-21']]) {
    page.updateRecords({ from, to }); await page.recordsApplyDates();
    assert.ok(page.data.recordList.dateError);
  }
  assert.equal(requests.length, count);
  const denied = setup('broker', false, async () => { throw Object.assign(new Error('请重新登录'), { status: 401 }); }, true);
  await denied.page.onShow();
  assert.equal(denied.app.globalData.token, '');
  assert.equal(denied.page.data.recordList.data, null);
  assert.equal(app.globalData.token, 'session-a');
});

test('股民我的和券商独立记录页查询本人授权范围，客户下钻原样传ID及已应用期间', async () => {
  for (const role of ['investor', 'broker']) {
    const { page, requests } = setup(role, false, undefined, role === 'broker');
    await page.onShow();
    const request = new URL(requests.at(-1).path, 'http://local');
    assert.equal(request.pathname, '/records');
    assert.equal(request.searchParams.get('period'), 'all');
    assert.equal(request.searchParams.get('ledger'), role === 'broker' ? 'all' : null);
    assert.ok(!requests.some(row => row.path.startsWith('/registry') || row.path.startsWith('/broker/board')));
  }
  const { page, navigations } = setup();
  page.setData({ boardPeriod: 'custom', boardRangeFrom: '2025-01-01', boardRangeTo: '2025-12-31', boardFrom: '2026-01-01' });
  page.openCustomerRecords(event({ customerId: 'customer/raw+id', board: true }));
  const params = new URL(navigations[0], 'http://local').searchParams;
  assert.equal(params.get('customerId'), 'customer/raw+id');
  assert.equal(params.get('period'), 'custom');
  assert.equal(params.get('from'), '2025-01-01');
  assert.equal(params.get('to'), '2025-12-31');
});

test('券商客户状态默认全部，搜索、日期、分页和返回保留签约筛选，其他角色不发送ledger', async () => {
  const { page, requests, app } = setup('broker', false, undefined, true);
  await page.onShow();
  await page.recordsPickLedger(event({ ledger: 'signed' }));
  page.recordsInput({ detail: { value: '测试客户' } }); await page.recordsSearch();
  await page.recordsPickPeriod(event({ period: 'month' }));
  await page.recordsNext();
  let params = new URL(requests.at(-1).path, 'http://local').searchParams;
  assert.equal(params.get('q'), '测试客户'); assert.equal(params.get('ledger'), 'signed');
  assert.equal(params.get('period'), 'month'); assert.equal(params.get('offset'), '5');
  page.onHide(); await page.onShow();
  params = new URL(requests.at(-1).path, 'http://local').searchParams;
  assert.equal(params.get('ledger'), 'signed'); assert.equal(params.get('offset'), '5');
  await page.recordsPickLedger(event({ ledger: 'negotiating' }));
  assert.equal(page.data.recordList.offset, 0);
  page.onHide(); app.globalData.token = 'another-broker'; await page.onShow();
  assert.equal(page.data.recordList.ledger, 'all');
  for (const role of ['sales', 'investor']) {
    const other = setup(role, role === 'sales'); await other.page.onShow();
    const count = other.requests.length;
    await other.page.recordsPickLedger(event({ ledger: 'signed' }));
    assert.equal(other.requests.length, count);
    assert.equal(new URL(other.requests.at(-1).path, 'http://local').searchParams.has('ledger'), false);
  }
});

test('已签约客户下钻沿用登记期间，既有按签约日期生成的链接仍可查本人全部股票', async () => {
  const backend = async path => {
    const params = new URL(path, 'http://local').searchParams;
    if (path.startsWith('/broker/board')) return {
      selected: params.get('metric'), period: params.get('period'), q: params.get('q') || '', ledger: params.get('ledger') || 'all',
      scopeTotal: 1, metrics: ['customers','ongoing','effective','closed','signings'].map(key => ({ key, label:key,value:1,unit:'人' })),
      items: [{ id:'client-a', customerId:'client-a', title:'跨月签约客户', signedOn:'2026-11-12' }], total:1,offset:0,limit:Number(params.get('limit') || 20),
    };
    const items = params.get('period') === 'all' ? [{ id:'lead-old', customerId:'client-a', stockName:'上月登记股票', registeredOn:'2026-10-09', signingStatus:'已签约', status:'已受理' }] : [];
    return { ...response(path), items, total:items.length, customerCount:items.length };
  };
  const board = setup('broker', true, backend);
  await board.page.onShow();
  await board.page.pickBoardPeriod(event({ period:'month' }));
  await board.page.pickBoardMetric(event({ key:'effective' }));
  board.page.openCustomerRecords(event({ customerId:board.page.data.salesBoard.items[0].customerId,board:true }));
  const route = new URL(board.navigations.at(-1), 'http://local');
  assert.equal(route.searchParams.get('period'), 'month');
  assert.equal(route.searchParams.has('signingCustomer'), false);
  assert.equal(route.searchParams.has('from'), false);
  const detail = setup('broker', false, backend, true);
  detail.page.onLoad({customerId:'client-a',period:'all',signingCustomer:'1'});
  await detail.page.onShow();
  assert.equal(detail.page.data.recordList.signingCustomer, true);
  assert.equal(detail.page.data.recordList.data.items[0].registeredOn, '2026-10-09');
  assert.equal(detail.page.data.recordList.data.items[0].signingStatus, '已签约');
  assert.equal(detail.page.data.recordList.data.items[0].status, '已受理');
  board.page.onHide(); await board.page.onShow();
  assert.equal(board.page.data.boardPeriod, 'month');
  assert.equal(board.page.data.boardMetric, 'effective');
  assert.match(board.requests.at(-1).path, /period=month&metric=effective/);
});

test('重置只清搜索，查看全部客户只解除客户范围，两者均保留日期和业务筛选', async () => {
  for (const role of ['sales', 'broker']) {
    const { page, requests } = setup(role, role === 'sales', undefined, role === 'broker');
    await page.onShow();
    page.updateRecords({ customerId:'selected-customer',signingCustomer:true,q:'误输名称',draft:'误输名称',
      period:'custom',rangeFrom:'2025-01-01',rangeTo:'2025-12-31',from:'2026-01-01',to:'2026-02-01',
      ledger:role === 'broker' ? 'signed' : 'all',offset:5 });
    await page.recordsReset();
    let query = new URL(requests.at(-1).path, 'http://local').searchParams;
    assert.equal(query.get('q'), '');
    assert.equal(query.get('customerId'), 'selected-customer');
    assert.equal(query.get('period'), 'custom');
    assert.equal(query.get('from'), '2025-01-01');
    assert.equal(query.get('to'), '2025-12-31');
    assert.equal(query.get('ledger'), role === 'broker' ? 'signed' : null);
    assert.equal(page.data.recordList.from, '2026-01-01', '未应用的日期草稿也不应被搜索重置');
    page.recordsInput({detail:{value:'小盒'}}); await page.recordsSearch();
    await page.recordsAllCustomers();
    query = new URL(requests.at(-1).path, 'http://local').searchParams;
    assert.equal(query.has('customerId'), false);
    assert.equal(query.get('q'), '小盒');
    assert.equal(query.get('period'), 'custom');
    assert.equal(query.get('from'), '2025-01-01');
    assert.equal(query.get('ledger'), role === 'broker' ? 'signed' : null);
    assert.equal(page.data.recordList.signingCustomer, false);
  }
});
