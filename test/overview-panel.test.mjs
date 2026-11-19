import assert from 'node:assert/strict';
import test from 'node:test';
import { mountOverviewPanel, renderOverviewControls, renderOverviewDetails, renderOverviewSummary } from '../web/overview-panel.js';

const metricRows = [
  ['records', '留资与登记', 52, '条'], ['customers', '客户档案', 48, '份'], ['channels', '来源渠道', 4, '个'], ['pending', '待分配 / 关联', 9, '条'],
  ['ongoing', '在办案件', 15, '件'], ['closed', '已结案件', 7, '件'], ['registry', '历史登记', 50, '条'], ['signed', '已签约档案', 2, '份'],
];
const row = (title = '合成客户甲') => ({ id: 'record-1', number: 'DJ-000101', title, phone: '19900009991', stockName: '合成股票', stockCode: 'TST',
  source: '合成来源', sales: '测试销售甲', registeredOn: '2026-11-18', followStatus: '未记录', caseStatus: '进度待核对', origin: 'registry' });
const result = (patch = {}) => ({
  period: 'all', from: '', to: '2026-11-19', today: '2026-11-19', metrics: metricRows.map(([key, label, value, unit]) => ({ key, label, value, unit })),
  selected: 'records', title: '留资与登记', total: 52, offset: 0, limit: 20, items: [row()],
  queues: [{ key: 'system_new', label: '新留资待分配', value: 1, unit: '条' }, { key: 'system_legacy', label: '历史留资待核对', value: 2, unit: '条' }, { key: 'registry_unlinked', label: '历史登记未关联销售', value: 6, unit: '条' }],
  recent: [row()], notes: ['合成测试口径说明'], meta: { sourceName: '合成样表.xlsx', registryTotal: 50, systemRecordCount: 2, registryCount: 50 }, ...patch,
});
const filters = (patch = {}) => ({ period: 'all', from: '', to: '', draftFrom: '', draftTo: '', detail: false, metric: 'records', queue: '', q: '', searchDraft: '', offset: 0, ...patch });

test('总览提供8张历史和系统合并卡片及同期3个待处理队列，日期控件区别草稿与已应用范围', () => {
  const html = renderOverviewSummary(result());
  assert.equal((html.match(/data-overview-action="metric"/g) || []).length, 8);
  for (const [key] of metricRows) assert.match(html, new RegExp(`data-metric="${key}"`));
  for (const queue of ['system_new', 'system_legacy', 'registry_unlinked']) assert.match(html, new RegExp(`data-queue="${queue}"`));
  assert.match(html, /客户档案/); assert.match(html, /已签约档案/);
  assert.match(html, /源台账共 50 条/); assert.match(html, /当前期间：小程序 2 条，历史登记 50 条/);
  const controls = renderOverviewControls(filters({ period: 'custom', from: '2025-01-01', to: '2025-12-31', draftFrom: '2026-01-01', draftTo: '2026-11-18' }), null, { today: '2026-11-19' });
  assert.match(controls, /自选日期：2025-01-01 至 2025-12-31/);
  assert.match(controls, /name="from" value="2026-01-01" max="2026-11-19"/);
  assert.match(controls, /data-period="all"/); assert.match(controls, /data-period="month"/);
  assert.match(controls, /签约、结案不代表在所选期间发生/);
});

test('明细保留客户股票电话来源销售日期及来源标签，检索数与范围总数分开且字段转义', () => {
  const malicious = '<img src=x onerror="alert(1)">';
  const data = result({ total: 1, items: [{ ...row(malicious), source: malicious, sales: malicious }], notes: [malicious] });
  const html = renderOverviewDetails(data, filters({ detail: true, searchDraft: '"><script>bad()</script>' }));
  assert.match(html, /当前范围 52 条 · 检索结果 1 条/);
  assert.match(html, /19900009991/); assert.match(html, /合成股票/); assert.match(html, /DJ-000101/);
  assert.match(html, /历史登记/); assert.match(html, /2026-11-18/);
  assert.doesNotMatch(html, /<img|<script>/); assert.match(html, /&lt;img/);
  assert.match(html, /data-offset="20" disabled/);
  const summary = renderOverviewSummary({ ...data, meta: { sourceName: malicious }, recent: [row(malicious)] });
  assert.doesNotMatch(summary, /<img|<script>/);
  const queue = renderOverviewDetails(result({ selected: 'pending', total: 6, items: [{ ...row(), status: '待关联 / 调整销售' }] }), filters({ detail: true, metric: 'pending', queue: 'registry_unlinked' }));
  assert.match(queue, /当前范围 6 条/); assert.match(queue, /待处理事项/); assert.match(queue, /待关联 \/ 调整销售/);
});

function harness(initialState = {}) {
  const listeners = {}, changes = [], errors = [], pending = [];
  const root = { innerHTML: '', isConnected: true, attributes: {}, contains: () => true,
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { listeners[name] = fn; },
    removeEventListener(name, fn) { if (listeners[name] === fn) delete listeners[name]; } };
  let current = true;
  const panel = mountOverviewPanel(root, { initialState, today: '2026-11-19', isCurrent: () => current,
    request(path, body, signal) { return new Promise((resolve, reject) => pending.push({ path, signal, resolve, reject })); },
    onState: value => changes.push(value), onError: error => errors.push(error) });
  const resolve = async (index, patch, operation) => { pending[index].resolve(result(patch)); await operation; };
  return { root, panel, pending, changes, errors, listeners, resolve, invalidate() { current = false; } };
}

test('默认全部，切换本月和自选范围后卡片、搜索、分页及返回均保留已应用期间', async () => {
  const h = harness();
  assert.equal(h.pending[0].path, '/overview?period=all&metric=records&q=&offset=0');
  await h.resolve(0, {}, h.panel.ready);
  const month = h.panel.setPeriod('month');
  assert.match(h.pending[1].path, /period=month/);
  await h.resolve(1, { period: 'month', from: '2026-11-01' }, month);
  assert.match(h.root.innerHTML, /本月：2026-11-01 至 2026-11-19/);
  const custom = h.panel.applyDates('2025-01-01', '2025-12-31');
  assert.match(h.pending[2].path, /period=custom.*from=2025-01-01&to=2025-12-31/);
  await h.resolve(2, { period: 'custom', from: '2025-01-01', to: '2025-12-31' }, custom);
  h.panel.setDraftDates('2026-01-01', '2026-11-18');
  const detail = h.panel.openDetail('customers');
  assert.match(h.pending[3].path, /metric=customers.*from=2025-01-01&to=2025-12-31/);
  await h.resolve(3, { period: 'custom', from: '2025-01-01', to: '2025-12-31', selected: 'customers', total: 48 }, detail);
  const search = h.panel.search('合成客户');
  assert.equal(new URL('http://localhost' + h.pending[4].path).searchParams.get('q'), '合成客户');
  await h.resolve(4, { period: 'custom', from: '2025-01-01', to: '2025-12-31', selected: 'customers', total: 23 }, search);
  const next = h.panel.setPage(40);
  assert.match(h.pending[5].path, /offset=40.*from=2025-01-01/);
  await h.resolve(5, { period: 'custom', from: '2025-01-01', to: '2025-12-31', selected: 'customers', total: 23, offset: 20 }, next);
  assert.equal(h.changes.at(-1).offset, 20); assert.match(h.root.innerHTML, /第 2 \/ 2 页/);
  const back = h.panel.back();
  assert.match(h.pending[6].path, /period=custom&metric=records&q=&offset=0&from=2025-01-01&to=2025-12-31/);
  await h.resolve(6, { period: 'custom', from: '2025-01-01', to: '2025-12-31' }, back);
  assert.equal(h.changes.at(-1).detail, false); assert.equal(h.changes.at(-1).draftFrom, '2026-01-01');
  assert.match(h.root.innerHTML, /value="2026-11-18"/); assert.equal(h.root.attributes['aria-busy'], 'false');
  h.panel.dispose();
});

test('无效日期、倒置日期和未来日期本地提示且不覆盖已应用结果，队列随期间并可返回', async () => {
  const h = harness(); await h.resolve(0, {}, h.panel.ready);
  for (const [from, to, message] of [['2026-02-30', '2026-03-01', '有效'], ['', '', '有效'], ['2026-11-19', '2026-11-18', '起始日期不能晚于结束日期'], ['2026-11-01', '2026-11-20', '结束日期不能晚于今天']]) {
    h.panel.applyDates(from, to); assert.equal(h.pending.length, 1); assert.match(h.root.innerHTML, new RegExp(message));
    assert.equal(h.changes.at(-1).period, 'all'); assert.match(h.root.innerHTML, /data-overview-value="records">52/);
  }
  const queue = h.panel.openDetail('pending', 'registry_unlinked');
  assert.match(h.pending[1].path, /metric=pending.*queue=registry_unlinked/);
  await h.resolve(1, { selected: 'pending', total: 6 }, queue);
  const month = h.panel.setPeriod('month');
  assert.match(h.pending[2].path, /period=month&metric=pending.*queue=registry_unlinked/);
  await h.resolve(2, { period: 'month', from: '2026-11-01', selected: 'pending', total: 0, items: [], queues: result().queues.map(row => ({ ...row, value: 0 })) }, month);
  assert.match(h.root.innerHTML, /当前范围 0 条 · 检索结果 0 条/);
  h.panel.dispose();
});

test('异步切换忽略较早响应，加载中的日期与搜索草稿不会被网络响应重置', async () => {
  const h = harness();
  const month = h.panel.setPeriod('month');
  assert.equal(h.pending[0].signal.aborted, true);
  const form = { dataset: { overviewForm: 'dates' } };
  h.listeners.input({ target: { name: 'from', value: '2025-05-01', closest: () => form } });
  h.listeners.change({ target: { name: 'to', value: '2025-06-01', closest: () => form } });
  await h.resolve(1, { period: 'month', from: '2026-11-01' }, month);
  await h.resolve(0, { recent: [row('过期客户')] }, h.panel.ready);
  assert.doesNotMatch(h.root.innerHTML, /过期客户/);
  assert.match(h.root.innerHTML, /value="2025-05-01"/); assert.match(h.root.innerHTML, /value="2025-06-01"/);
  const detail = h.panel.openDetail('records');
  h.listeners.input({ target: { name: 'q', value: '尚未提交的检索词', closest: () => ({ dataset: { overviewForm: 'search' } }) } });
  await h.resolve(2, { period: 'month', from: '2026-11-01' }, detail);
  assert.match(h.root.innerHTML, /value="尚未提交的检索词"/);
  assert.equal(h.changes.at(-1).q, '');
  h.panel.dispose(); assert.deepEqual(Object.keys(h.listeners), []);
});

test('错误可重试；401转交应用；切换账号、离开或销毁后不展示迟到资料', async () => {
  const h = harness();
  h.pending[0].reject(new Error('网络暂不可用')); await h.panel.ready;
  assert.match(h.root.innerHTML, /网络暂不可用/); assert.match(h.root.innerHTML, /重新加载/);
  const retry = h.panel.refresh(); await h.resolve(1, {}, retry);
  assert.doesNotMatch(h.root.innerHTML, /网络暂不可用/);
  const detail = h.panel.openDetail('customers'), before = h.root.innerHTML, saved = h.changes.length;
  h.invalidate(); await h.resolve(2, { selected: 'customers', items: [row('前一账号客户')] }, detail);
  assert.equal(h.root.innerHTML, before); assert.equal(h.changes.length, saved); h.panel.dispose();
  const disconnected = harness(); disconnected.root.isConnected = false;
  const disconnectedBefore = disconnected.root.innerHTML;
  await disconnected.resolve(0, { recent: [row('离开后资料')] }, disconnected.panel.ready);
  assert.equal(disconnected.root.innerHTML, disconnectedBefore); disconnected.panel.dispose();
  const disposed = harness(); disposed.panel.dispose(); assert.equal(disposed.pending[0].signal.aborted, true);
  await disposed.resolve(0, {}, disposed.panel.ready); assert.deepEqual(Object.keys(disposed.listeners), []);
  const unauthorized = harness(), failure = new Error('请先登录'); failure.status = 401;
  unauthorized.pending[0].reject(failure); await unauthorized.panel.ready;
  assert.equal(unauthorized.errors[0], failure); unauthorized.panel.dispose();
});

test('保存的范围与明细直接恢复；损坏响应不会被渲染成零统计', async () => {
  const h = harness(filters({ period: 'custom', from: '2025-01-01', to: '2025-12-31', detail: true, metric: 'closed', q: '测试', searchDraft: '测试', offset: 20 }));
  assert.match(h.pending[0].path, /period=custom&metric=closed/); assert.match(h.pending[0].path, /offset=20&from=2025-01-01&to=2025-12-31/);
  h.pending[0].resolve({ items: [] }); await h.panel.ready;
  assert.match(h.root.innerHTML, /统计数据暂未完整返回/); assert.doesNotMatch(h.root.innerHTML, /当前范围 0/);
  h.panel.dispose();
});
