import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function harness(fetchBoard) {
  const app = { globalData: { token: 'seller-a' } };
  const requests = [];
  const client = {
    async request(path) {
      requests.push(path);
      if (path === '/view') return { actor: { role: 'sales', id: app.globalData.token }, today: '2026-11-18' };
      return fetchBoard(path, app.globalData.token);
    },
    showLogin() { app.globalData.token = ''; },
  };
  const boardModule = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../miniprogram/sales-board.js', import.meta.url), 'utf8'), {
    getApp: () => app, require: () => client, module: boardModule,
  });
  const pageModule = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../miniprogram/page.js', import.meta.url), 'utf8'), {
    getApp: () => app, require: name => name === './sales-board' ? boardModule.exports : client, module: pageModule,
  });
  const page = pageModule.exports(false);
  page.setData = values => Object.assign(page.data, values);
  return { page, app, requests };
}
function boardResponse(path, title = '模拟客户') {
  const query = new URL(path, 'http://test').searchParams;
  const keys = ['channels', 'customers', 'effective', 'closed'];
  return { period: query.get('period'), from: query.get('from'), to: query.get('to'), today: '2026-11-18',
    selected: query.get('metric'), metrics: keys.map(key => ({ key, label: key, value: 21, unit: '份' })),
    items: [{ id: 'one', title }], total: 21, offset: Number(query.get('offset')), limit: 20, notes: [] };
}
const event = dataset => ({ currentTarget: { dataset } });

test('销售看板默认全部，按同一期间加载四卡和分页明细，返回保留期间与页码', async () => {
  const { page, requests } = harness(async path => boardResponse(path));
  await page.onShow();
  assert.match(requests.at(-1), /period=all&metric=channels&offset=0$/);
  await page.pickBoardPeriod(event({ period: 'month' }));
  await page.pickBoardMetric(event({ key: 'customers' }));
  await page.boardNext();
  assert.match(requests.at(-1), /period=month&metric=customers&offset=20$/);
  assert.equal(page.data.boardPage, 2);
  const count = requests.length;
  await page.boardNext();
  assert.equal(requests.length, count, '末页不应继续请求');
  page.onHide();
  assert.equal(page.data.salesBoard, null);
  await page.onShow();
  assert.match(requests.at(-1), /period=month&metric=customers&offset=20$/);
  await page.boardPrevious();
  assert.equal(page.data.boardPage, 1);
  page.pickBoardDate({ ...event({ field: 'from' }), detail: { value: '2020-01-01' } });
  page.pickBoardDate({ ...event({ field: 'to' }), detail: { value: '2020-12-31' } });
  await page.applyBoardDates();
  assert.match(requests.at(-1), /period=custom&metric=customers&offset=0&from=2020-01-01&to=2020-12-31$/);
  page.pickBoardDate({ ...event({ field: 'from' }), detail: { value: '2021-01-01' } });
  await page.pickBoardMetric(event({ key: 'closed' }));
  assert.match(requests.at(-1), /period=custom&metric=closed&offset=0&from=2020-01-01&to=2020-12-31$/, '未应用的日期草稿不能改变统计范围');
});

test('无效日期不请求；服务失败和结构不完整显示错误并可重试', async () => {
  let fail = true;
  const { page, requests } = harness(async path => { if (fail) throw new Error('网络异常'); return boardResponse(path); });
  await page.onShow();
  assert.equal(page.data.boardLoading, false);
  assert.equal(page.data.boardError, '网络异常');
  fail = false;
  await page.retryBoard();
  assert.equal(page.data.boardError, '');
  const count = requests.length;
  await page.applyBoardDates();
  assert.match(page.data.boardDateError, /请选择起止日期/);
  page.setData({ boardFrom: '2026-11-18', boardTo: '2026-11-01' });
  await page.applyBoardDates();
  assert.match(page.data.boardDateError, /开始日期/);
  page.setData({ boardFrom: '2026-02-30', boardTo: '2026-11-01' });
  await page.applyBoardDates();
  assert.match(page.data.boardDateError, /有效的日期/);
  page.setData({ boardFrom: '2026-11-01', boardTo: '2026-11-19' });
  await page.applyBoardDates();
  assert.match(page.data.boardDateError, /不能晚于今天/);
  assert.equal(requests.length, count);
  const malformed = harness(async () => ({}));
  await malformed.page.onShow();
  assert.match(malformed.page.data.boardError, /完整返回/);
  assert.equal(malformed.page.data.salesBoard, null);
});

test('首次加载未完成时离开并返回，重新加载且忽略旧响应', async () => {
  const pending = [];
  const { page } = harness(path => new Promise(resolve => pending.push({ path, resolve })));
  const first = page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  page.onHide();
  const returned = page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[0].resolve(boardResponse(pending[0].path, '旧请求'));
  await first;
  assert.equal(page.data.boardLoading, true);
  pending[1].resolve(boardResponse(pending[1].path, '返回后数据'));
  await returned;
  assert.equal(page.data.salesBoard.items[0].title, '返回后数据');
  assert.equal(page.data.busy, false);
});

test('较早请求、离开页面和切换账号的在途响应不会污染销售看板', async () => {
  const pending = [];
  const { page, app } = harness(path => new Promise(resolve => pending.push({ path, resolve })));
  const initial = page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  const month = page.pickBoardPeriod(event({ period: 'month' }));
  pending[1].resolve(boardResponse(pending[1].path, '最新筛选'));
  await month;
  pending[0].resolve(boardResponse(pending[0].path, '过时筛选'));
  await initial;
  assert.equal(page.data.salesBoard.items[0].title, '最新筛选');
  const hidden = page.pickBoardMetric(event({ key: 'closed' }));
  page.onHide();
  pending[2].resolve(boardResponse(pending[2].path, '离开后的旧记录'));
  await hidden;
  assert.equal(page.data.salesBoard, null);
  page.boardVisible = true;
  const previousAccount = page.loadSalesBoard();
  app.globalData.token = 'seller-b';
  const nextAccount = page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(pending[4].path, /period=all&metric=channels&offset=0$/);
  pending[4].resolve(boardResponse(pending[4].path, '销售乙'));
  await nextAccount;
  pending[3].resolve(boardResponse(pending[3].path, '销售甲'));
  await previousAccount;
  assert.equal(page.data.salesBoard.items[0].title, '销售乙');
  assert.equal(page.data.boardPeriod, 'all');
});
