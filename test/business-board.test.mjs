import assert from 'node:assert/strict';
import test from 'node:test';
import { businessBoardScope, businessBoardMatches, businessBoardParams, businessBoardPresentation } from '../web/business-board.js';

const broker = { id: 'broker-a', role: 'broker' }, sales = { id: 'sales-a', role: 'sales' };
const board = { period: 'custom', metric: 'signings', rangeFrom: '2025-01-01', rangeTo: '2025-12-31', offset: 20, from: '2026-01-01', to: '2026-11-01' };

test('券商首页合并客户查询和概览，我的及股票下钻页不请求看板', () => {
  const home = businessBoardScope(broker, 'home');
  assert.deepEqual(businessBoardParams({ ...board, metric: 'effective', q: '客户甲' }, home), { period: 'custom', metric: 'effective', offset: 20, limit: 5, from: '2025-01-01', to: '2025-12-31', ledger: 'all', q: '客户甲' });
  assert.equal(businessBoardPresentation(home).showMetrics, true);
  assert.equal(businessBoardPresentation(home).title, '渠道概览');
  assert.equal(businessBoardScope(broker, 'mine'), null);
  assert.equal(businessBoardScope(broker, 'records'), null);
});

test('首页查询及分页沿用已应用期间、搜索和洽谈筛选，未提交草稿不生效', () => {
  const home = businessBoardScope(broker, 'home', 'negotiating');
  const draft = { ...board, metric: 'customers', q: '股票甲', searchDraft: '尚未提交' };
  const next = businessBoardParams(draft, home, 5);
  assert.equal(next.offset, 5); assert.equal(next.ledger, 'negotiating'); assert.equal(next.from, board.rangeFrom);
  assert.equal(next.q, '股票甲');
  assert.equal(businessBoardPresentation(home).label, '洽谈中客户');
  const month = businessBoardParams({ ...draft, period: 'month' }, home, 0);
  assert.deepEqual(month, { period: 'month', metric: 'customers', offset: 0, limit: 5, ledger: 'negotiating', q: '股票甲' });
});

test('迟到回包必须同时属于当前账号、角色、页面和台账状态', () => {
  const requestScope = businessBoardScope(broker, 'home', 'negotiating');
  assert.equal(businessBoardMatches(requestScope, broker, 'home', 'negotiating'), true);
  assert.equal(businessBoardMatches(requestScope, broker, 'mine', 'negotiating'), false);
  assert.equal(businessBoardMatches(requestScope, broker, 'home', 'all'), false);
  assert.equal(businessBoardMatches(requestScope, { ...broker, id: 'broker-b' }, 'home', 'negotiating'), false);
  assert.equal(businessBoardMatches(requestScope, { ...broker, role: 'sales' }, 'home', 'negotiating'), false);
  assert.equal(businessBoardMatches(requestScope, null, 'home', 'negotiating'), false);
});

test('销售我的保留原统计和登记明细入口，非业务账号及销售首页不请求看板', () => {
  const scope = businessBoardScope(sales, 'mine', '已签约');
  assert.equal(businessBoardParams({ ...board, metric: 'customers' }, scope).ledger, undefined);
  assert.equal(businessBoardParams({ ...board, q: '券商搜索' }, scope).q, undefined);
  assert.equal(businessBoardPresentation(scope).showMetrics, true);
  assert.equal(businessBoardPresentation(scope).showSalesGuide, true);
  assert.equal(businessBoardPresentation(businessBoardScope(broker, 'mine')).showSalesGuide, false);
  assert.equal(businessBoardScope(sales, 'home'), null);
  assert.equal(businessBoardScope({ id: 'admin', role: 'admin' }, 'mine'), null);
  assert.equal(businessBoardScope({ id: 'client', role: 'investor' }, 'home'), null);
});
