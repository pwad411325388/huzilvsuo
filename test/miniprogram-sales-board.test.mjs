import { nativePages } from '../test-support/native-page.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function harness(fetchBoard, role = 'sales', isHome = false) {
  const app = { globalData: { token: 'seller-a' } };
  const requests = [], clipboard = [];
  const client = {
    async request(path) {
      requests.push(path);
      if (path === '/view') return { actor: { role, id: app.globalData.token }, today: '2026-11-18',
        ...(role === 'broker' ? { broker: { name: '合成券商', code: 'TEST-B' } } : {}) };
      return fetchBoard(path, app.globalData.token);
    },
    showLogin() { app.globalData.token = ''; },
  };
  const wx = { setClipboardData: ({ data }) => clipboard.push(data) };
  const page = nativePages({ app, client, wx }).create(isHome);
  return { page, app, requests, clipboard };
}
function boardResponse(path, title = '模拟客户') {
  const query = new URL(path, 'http://test').searchParams;
  const keys = path.startsWith('/broker/') ? ['customers','ongoing','effective','closed','signings'] : ['channels', 'customers', 'effective', 'closed'];
  const offset = Number(query.get('offset')), limit = Number(query.get('limit') || 20);
  const items = Array.from({ length: 6 }, (_, index) => ({ id: String(index + 1), title }));
  return { period: query.get('period'), from: query.get('from'), to: query.get('to'), today: '2026-11-18',
    selected: query.get('metric'), q: query.get('q') || '', ledger: query.get('ledger') || 'all', scopeTotal: items.length,
    metrics: keys.map(key => ({ key, label: key, value: items.length, unit: '份' })),
    items: items.slice(offset, offset + limit), total: items.length, offset, limit, notes: [] };
}
const event = dataset => ({ currentTarget: { dataset } });

test('销售和券商客户卡展示接口给出的案件进度，独立签约字段不覆盖主标签', async () => {
  for (const role of ['sales', 'broker']) {
    const { page } = harness(async path => {
      const response = boardResponse(path);
      response.items = [
        { id: 'one-stock', title: '客户甲', status: '已立案未开庭', signingStatus: '已签约' },
        { id: 'two-stocks', title: '客户乙', status: '多个案件进度', signingStatus: '已签约' },
      ];
      return response;
    }, role, role === 'broker');
    await page.onShow();
    for (const key of ['customers', 'effective']) {
      await page.pickBoardMetric(event({ key }));
      assert.deepEqual(page.data.salesBoard.items.map(item => item.status), ['已立案未开庭', '多个案件进度']);
      assert.ok(page.data.salesBoard.items.every(item => item.signingStatus === '已签约'));
    }
  }
  const markup = readFileSync(new URL('../miniprogram/ui.wxml', import.meta.url), 'utf8');
  const rows = markup.split('wx:for="{{salesBoard.items}}"')[1].split('bindtap="openProgress"')[0];
  assert.match(rows, /class="tag"[^>]*>{{item\.status}}<\/text>/);
  assert.doesNotMatch(rows, /signingStatus/);
});

test('销售看板默认全部，按同一期间加载四卡和分页明细，返回保留期间与页码', async () => {
  const { page, requests } = harness(async path => boardResponse(path));
  await page.onShow();
  assert.match(requests.at(-1), /period=all&metric=channels&offset=0&limit=5$/);
  assert.equal(page.data.boardExpanded, true);
  assert.equal(page.data.salesBoard.items.length, 5);
  page.toggleBoardDetails();
  assert.equal(page.data.boardExpanded, false);
  assert.equal(page.data.salesBoard.metrics.length, 4);
  await page.pickBoardPeriod(event({ period: 'month' }));
  assert.equal(page.data.boardExpanded, true);
  page.toggleBoardDetails();
  await page.pickBoardMetric(event({ key: 'customers' }));
  assert.equal(page.data.boardExpanded, true);
  assert.deepEqual(page.data.salesBoard.items.map(item => item.id), ['1', '2', '3', '4', '5']);
  await page.boardNext();
  assert.match(requests.at(-1), /period=month&metric=customers&offset=5&limit=5$/);
  assert.equal(page.data.boardPage, 2);
  assert.deepEqual(page.data.salesBoard.items.map(item => item.id), ['6']);
  const count = requests.length;
  page.toggleBoardDetails();
  assert.equal(page.data.boardExpanded, false);
  page.toggleBoardDetails();
  assert.equal(page.data.boardExpanded, true);
  assert.equal(page.data.boardPage, 2);
  assert.equal(requests.length, count, '收起和展开明细保留当前页');
  await page.boardNext();
  assert.equal(requests.length, count, '末页不应继续请求');
  page.onHide();
  assert.equal(page.data.salesBoard, null);
  await page.onShow();
  assert.match(requests.at(-1), /period=month&metric=customers&offset=5&limit=5$/);
  page.toggleBoardDetails();
  await page.boardPrevious();
  assert.equal(page.data.boardExpanded, true);
  assert.equal(page.data.boardPage, 1);
  page.pickBoardDate({ ...event({ field: 'from' }), detail: { value: '2020-01-01' } });
  page.pickBoardDate({ ...event({ field: 'to' }), detail: { value: '2020-12-31' } });
  await page.applyBoardDates();
  assert.match(requests.at(-1), /period=custom&metric=customers&offset=0&limit=5&from=2020-01-01&to=2020-12-31$/);
  page.pickBoardDate({ ...event({ field: 'from' }), detail: { value: '2021-01-01' } });
  await page.pickBoardMetric(event({ key: 'closed' }));
  assert.match(requests.at(-1), /period=custom&metric=closed&offset=0&limit=5&from=2020-01-01&to=2020-12-31$/, '未应用的日期草稿不能改变统计范围');
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
  assert.match(pending[4].path, /period=all&metric=channels&offset=0&limit=5$/);
  pending[4].resolve(boardResponse(pending[4].path, '销售乙'));
  await nextAccount;
  pending[3].resolve(boardResponse(pending[3].path, '销售甲'));
  await previousAccount;
  assert.equal(page.data.salesBoard.items[0].title, '销售乙');
  assert.equal(page.data.boardPeriod, 'all');
});


test('券商渠道台账同表搜索及筛选，五条分页，返回保留已应用的日期、关键词和客户范围', async () => {
  const { page, requests, app } = harness(async path => {
    const board = boardResponse(path);
    if (board.q) board.scopeTotal = 12;
    return board;
  }, 'broker', true);
  const query = () => new URL(requests.at(-1), 'http://test').searchParams;
  await page.onShow();
  assert.deepEqual(requests.map(path => path.split('?')[0]), ['/view', '/broker/board']);
  assert.equal(query().get('metric'), 'customers');
  assert.equal(query().get('limit'), '5');
  assert.deepEqual(Array.from(page.data.salesBoard.metrics, item => item.key).sort(), ['closed','customers','effective','ongoing']);
  assert.equal(page.data.boardExpanded, true);
  assert.equal(page.data.salesBoard.items.length, 5);
  page.toggleBoardDetails();
  assert.equal(page.data.boardExpanded, false);
  await page.pickBoardPeriod(event({ period: 'month' }));
  assert.equal(page.data.boardExpanded, true);
  page.toggleBoardDetails();
  page.boardInput({ detail: { value: '山河 A+1' } });
  await page.boardSearch();
  assert.equal(page.data.boardExpanded, true);
  assert.equal(query().get('q'), '山河 A+1');
  assert.equal(page.data.salesBoard.total, 6);
  assert.equal(page.data.salesBoard.scopeTotal, 12);
  await page.pickBoardLedger(event({ ledger: 'negotiating' }));
  assert.equal(query().get('ledger'), 'negotiating');
  assert.equal(query().get('metric'), 'customers');
  await page.boardNext();
  assert.equal(page.data.boardPage, 2);
  assert.equal(page.data.salesBoard.items.length, 1);
  const saved = query().toString();
  page.toggleBoardDetails(); page.toggleBoardDetails();
  page.onHide(); await page.onShow();
  assert.equal(query().toString(), saved);
  await page.pickBoardLedger(event({ ledger: 'signed' }));
  assert.equal(query().get('metric'), 'effective');
  assert.equal(query().get('ledger') || 'all', 'all');
  assert.equal(query().get('offset'), '0');
  await page.pickBoardMetric(event({ key: 'signings' }));
  assert.equal(query().get('period'), 'month');
  assert.equal(query().get('metric'), 'effective', '旧签约指标归并到已签约客户');
  assert.equal(query().get('q'), '山河 A+1');
  await page.pickBoardMetric(event({ key: 'ongoing' }));
  assert.match(requests.at(-1), /metric=ongoing/);
  const count = requests.length;
  await page.pickBoardMetric(event({ key: 'channels' }));
  assert.equal(requests.length, count, '券商不能请求销售来源渠道接口');
  await page.boardReset();
  assert.equal(query().get('q') || '', '');
  assert.equal(query().get('period'), 'month');
  assert.equal(query().get('metric'), 'ongoing');
  page.boardInput({ detail: { value: '前一账号' } }); await page.boardSearch();
  page.onHide(); app.globalData.token = 'second-broker'; await page.onShow();
  assert.equal(query().get('q') || '', '');
  assert.equal(query().get('period'), 'all');
  assert.equal(query().get('metric'), 'customers');
  assert.ok(requests.every(path => path === '/view' || path.startsWith('/broker/board?')));
  assert.ok(!requests.some(path => path.includes('metric=signings')));
});

test('券商我的页只读取本人资料，可复制和分享该券商推广码', async () => {
  const { page, requests, clipboard } = harness(() => assert.fail('我的页不查询客户或看板'), 'broker');
  await page.onShow();
  page.copyCode();
  assert.deepEqual(clipboard, ['TEST-B']);
  assert.equal(page.onShareAppMessage().path, '/pages/home/index?promo=TEST-B');
  assert.deepEqual(requests, ['/view']);
});
