import assert from 'node:assert/strict';
import test from 'node:test';
import { businessBoardScope, businessBoardMatches, businessBoardParams, businessBoardPresentation } from '../web/business-board.js';

const broker = { id: 'broker-a', role: 'broker' }, sales = { id: 'sales-a', role: 'sales' };
const board = { period: 'custom', metric: 'signings', rangeFrom: '2025-01-01', rangeTo: '2025-12-31', offset: 20, from: '2026-01-01', to: '2026-11-01' };

test('券商首页保留指标看板，我的强制客户台账和洽谈或签约筛选', () => {
  const home = businessBoardScope(broker, 'home', '已签约');
  assert.deepEqual(businessBoardParams(board, home), { period: 'custom', metric: 'signings', offset: 20, from: '2025-01-01', to: '2025-12-31' });
  assert.equal(businessBoardPresentation(home).showMetrics, true);
  for (const [label, ledger] of [['洽谈中', 'negotiating'], ['已签约', 'signed']]) {
    const mine = businessBoardScope(broker, 'mine', label);
    assert.deepEqual(businessBoardParams(board, mine), { period: 'custom', metric: 'customers', offset: 20, from: '2025-01-01', to: '2025-12-31', ledger });
    assert.equal(businessBoardPresentation(mine).title, '客户台账');
    assert.equal(businessBoardPresentation(mine).showMetrics, false);
    assert.equal(businessBoardPresentation(mine).showLedger, true);
  }
});

test('台账状态及分页沿用已应用期间，首页不带台账筛选，日期草稿不会偷偷生效', () => {
  const mine = businessBoardScope(broker, 'mine', '已签约');
  const next = businessBoardParams(board, mine, 40);
  assert.equal(next.offset, 40); assert.equal(next.ledger, 'signed'); assert.equal(next.from, board.rangeFrom);
  const month = businessBoardParams({ ...board, period: 'month' }, mine, 0);
  assert.deepEqual(month, { period: 'month', metric: 'customers', offset: 0, ledger: 'signed' });
  const home = businessBoardParams(board, businessBoardScope(broker, 'home', '已签约'), 0);
  assert.equal(home.ledger, undefined); assert.equal(home.from, '2025-01-01');
});

test('迟到回包必须同时属于当前账号、角色、页面和台账状态', () => {
  const requestScope = businessBoardScope(broker, 'mine', '洽谈中');
  assert.equal(businessBoardMatches(requestScope, broker, 'mine', '洽谈中'), true);
  assert.equal(businessBoardMatches(requestScope, broker, 'home', '洽谈中'), false);
  assert.equal(businessBoardMatches(requestScope, broker, 'mine', '已签约'), false);
  assert.equal(businessBoardMatches(requestScope, { ...broker, id: 'broker-b' }, 'mine', '洽谈中'), false);
  assert.equal(businessBoardMatches(requestScope, { ...broker, role: 'sales' }, 'mine', '洽谈中'), false);
  assert.equal(businessBoardMatches(requestScope, null, 'mine', '洽谈中'), false);
});

test('销售我的保留原统计和登记明细入口，非业务账号及销售首页不请求看板', () => {
  const scope = businessBoardScope(sales, 'mine', '已签约');
  assert.equal(businessBoardParams({ ...board, metric: 'customers' }, scope).ledger, undefined);
  assert.equal(businessBoardPresentation(scope).showMetrics, true);
  assert.equal(businessBoardPresentation(scope).showSalesGuide, true);
  assert.equal(businessBoardPresentation(businessBoardScope(broker, 'mine')).showSalesGuide, false);
  assert.equal(businessBoardScope(sales, 'home'), null);
  assert.equal(businessBoardScope({ id: 'admin', role: 'admin' }, 'mine'), null);
  assert.equal(businessBoardScope({ id: 'client', role: 'investor' }, 'home'), null);
});
