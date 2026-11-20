import { nativePages } from '../test-support/native-page.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { operationsPage } from '../web/operations.js';
import { renderAdminSalesOverview, renderAdminSalesDetails } from '../web/admin-sales-panel.js';
import { renderAdminDataPanel } from '../web/admin-data-panel.js';
import { renderOverviewDetails } from '../web/overview-panel.js';
import { renderBrokerAccounts } from '../web/broker-accounts.js';

const safe = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const ui = { safe, button: (label, action, value) => `<button data-action="${action}" data-value="${safe(value)}">${safe(label)}</button>`,
  field: (label, content) => `<label>${safe(label)}${content}</label>`, select: (name, options) => `<select name="${name}">${options.map(([value, label]) => `<option value="${safe(value)}">${safe(label)}</option>`).join('')}</select>`,
  panel: (title, body) => `<section><h2>${safe(title)}</h2>${body}</section>`, empty: () => '暂无记录', tag: safe };
const base = () => ({ sales: [], brokers: [], cases: [], assignments: [], companies: [] });
const sequence = (html, labels) => {
  const offsets = labels.map(label => html.indexOf(label));
  assert.ok(offsets.every(index => index >= 0), '每条记录仍然存在');
  assert.deepEqual(offsets, offsets.slice().sort((a, b) => a - b));
};

test('派单列表优先待处理组且组内旧到新，缺日期末位；已分配新到旧，筛选不改变规则', () => {
  const view = base();
  const lead = (id, createdOn, needsAssignment, legacy = false) => ({ id, number: id, createdOn, needsAssignment, legacy, name: id, phone: '', stockName: '测试股票', stockCode: 'TST', salesId: needsAssignment ? '' : 'active', assignmentStatus: needsAssignment ? '待分配' : '已分配' });
  view.assignments = [lead('assigned-old', '2025-01-01', false), lead('new-undated', '', true), lead('legacy-old', '2024-01-01', true, true), lead('new-new', '2026-05-01', true), lead('assigned-new', '2026-06-01', false), lead('new-old', '2026-01-01', true)];
  const before = structuredClone(view);
  const state = { adminTab: 5, assignmentFilters: { queue: 'all' } };
  const html = operationsPage(view, state, ui);
  sequence(html, ['<td>new-old', '<td>new-new', '<td>new-undated', '<td>legacy-old', '<td>assigned-new', '<td>assigned-old']);
  assert.doesNotMatch(html, /排序：新待分配、历史待核对在前/);
  const editor = operationsPage({ ...view, legacyFollowups: [{ note: '过去的客户备注' }] }, { ...state, editAssignment: 'assigned-old' }, ui);
  assert.match(editor, /确认分配/);
  assert.doesNotMatch(editor, /跟进|过去的客户备注/);
  const pending = operationsPage(view, { ...state, assignmentFilters: { queue: 'pending' } }, ui);
  sequence(pending, ['<td>new-old', '<td>new-new', '<td>new-undated']);
  assert.doesNotMatch(pending, /<td>assigned-old|<td>legacy-old/);
  assert.deepEqual(view, before, '渲染不会改动原业务数组');
});

test('维护券商正常、待开户、注销排序，注销即使客户多也不会前置；销售候选正常在前', () => {
  const view = base();
  view.sales = [{ id: 'closed-sales', name: '甲注销', accountStatus: 'closed', username: 'closed' }, { id: 'pending-sales', name: '乙待开', accountStatus: 'pending' }, { id: 'active-sales', name: '丙正常', accountStatus: 'active', username: 'active' }];
  view.brokers = [{ id: 'closed', name: '关闭渠道', accountStatus: 'closed', username: 'closed' }, { id: 'pending', name: '待开渠道' }, { id: 'active', name: '正常渠道', accountStatus: 'active', username: 'active' }];
  view.assignments = Array.from({ length: 50 }, (_, i) => ({ id: `lead-${i}`, clientId: `client-${i}`, brokerId: 'closed' }));
  const html = operationsPage(view, { adminTab: 8, channelFilters: {} }, ui);
  sequence(html, ['option value="active-sales"', 'option value="pending-sales"', 'option value="closed-sales"']);
  sequence(html, ['<td>正常渠道', '<td>待开渠道', '<td>关闭渠道']);
  assert.match(html, /已注销|注销券商/);
  assert.doesNotMatch(renderBrokerAccounts(), /待开户在前，正常账号其次，已注销在后/);
});

test('销售概览遵循服务端汇总顺序，选择器独立按可用账号排序，省略重复排序说明', () => {
  const rows = [{ id: 'one', name: '大客户销售', status: '正常', customerCount: 50, sources: [] }, { id: 'two', name: '小客户销售', status: '正常', customerCount: 2, sources: [] }, { id: 'closed', name: '注销销售', status: '已注销', customerCount: 500, sources: [] }];
  const html = renderAdminSalesOverview({ rows, meta: {}, notes: [], orderLabel: '<img src=x>服务端排序' }, {}, [
    { id: 'closed', name: '注销销售', accountStatus: 'closed' }, { id: 'one', name: '大客户销售', accountStatus: 'active' }, { id: 'two', name: '小客户销售', accountStatus: 'active' },
  ]);
  sequence(html, ['<td>大客户销售', '<td>小客户销售', '<td>注销销售']);
  assert.ok(html.indexOf('option value="closed"') > html.indexOf('option value="one"'));
  assert.doesNotMatch(html, /data-order-label|排序：|服务端排序|<img/);
});

test('服务端分页明细保留行序和注销记录，不再额外显示排序说明', () => {
  const data = { type: 'records', title: '记录', total: 22, offset: 20, limit: 20, items: [{ id: 'b', title: '分页第一条' }, { id: 'a', title: '注销历史条' }],
    columns: [{ key: 'title', label: '客户' }], orderLabel: '登记时间从旧到新，编号稳定排序', notes: [], filters: {}, metrics: [{ key: 'records', value: 22, unit: '条' }], queues: [] };
  const draft = { sourceKey: '', salesId: '', origin: 'all', status: 'all', q: '' };
  const filters = { ...draft, type: 'records', metric: 'records', period: 'all', draft };
  for (const html of [renderAdminDataPanel(data, filters), renderOverviewDetails(data, filters), renderAdminSalesDetails(data, { metric: 'records' })]) {
    sequence(html, ['分页第一条', '注销历史条']);
    assert.doesNotMatch(html, /data-order-label|排序：登记时间从旧到新，编号稳定排序/);
    assert.match(html, /第 2 \/ 2 页/);
  }
});

test('原生统一记录页沿用接口行序与排序说明，不将登记日期替换为同步时间', async () => {
  const payload = { items: [{ id: 'latest', registeredOn: '2026-11-18' }, { id: 'unknown', registeredOn: '' }], total: 2, offset: 0, limit: 5,
    orderLabel: '按登记日新到旧，缺日期末位，同日编号固定。', importedAt: '2026-11-19T00:00:00Z' };
  const app = {globalData:{token:'current-user'}};
  const page = nativePages({app,client:{request:async path => path === '/view' ? {actor:{role:'sales',id:'sales-a'},today:'2026-11-19'} : payload,
    showLogin:()=>assert.fail('不应退出登录')}}).page('registry');
  await page.onShow();
  assert.equal(page.data.recordList.data.orderLabel, payload.orderLabel);
  assert.deepEqual(page.data.recordList.data.items.map(row => row.id), ['latest', 'unknown']);
  assert.equal(page.data.recordList.data.items[0].registeredOn, '2026-11-18');
  assert.equal(page.data.recordList.data.items[1].registeredOn, '');
});
