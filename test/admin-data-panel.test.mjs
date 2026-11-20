import assert from 'node:assert/strict';
import test from 'node:test';
import { adminDataQuery, mountAdminDataPanel, renderAdminDataPanel } from '../web/admin-data-panel.js';

const defaults = { type: 'records', period: 'all', from: '', to: '', draftFrom: '', draftTo: '', sourceKey: '', salesId: '', origin: 'all', status: 'all', q: '', offset: 0 };
const state = patch => { const applied = { ...defaults, ...patch }; return { ...applied, draft: { sourceKey: applied.sourceKey, salesId: applied.salesId, origin: applied.origin, status: applied.status, q: applied.q } }; };
const result = patch => ({ type: 'records', title: '留资与登记', period: 'all', from: '', to: '2026-11-19', today: '2026-11-19',
  columns: [{ key: 'title', label: '客户姓名' }, { key: 'stockName', label: '股票名称' }, { key: 'sales', label: '销售' }, { key: 'registeredOn', label: '登记日期' }, { key: 'origin', label: '数据来源' }],
  items: [{ title: '合成客户甲', stockName: '合成股票', sales: '测试销售', registeredOn: '2025-05-01', origin: 'registry' }],
  total: 51, offset: 0, limit: 20, filters: { sources: [{ key: 'source-one', name: '合成来源' }], sales: [{ id: 'seller-one', name: '测试销售' }], statuses: [{ key: 'closed', label: '已结案' }] },
  definition: '含小程序与历史登记', notes: ['来源不等于券商账号归属'], ...patch });

test('三页共享全量筛选且报表列按API定义，历史来源能下钻，所有文本安全转义', () => {
  const data = result();
  const html = renderAdminDataPanel(data, state(), { choices: data.filters, today: data.today });
  assert.match(html, /data-admin-data-type/); assert.match(html, /data-admin-data-form="dates"/);
  for (const name of ['sourceKey', 'salesId', 'origin', 'status', 'q']) assert.match(html, new RegExp(`name="${name}"`));
  assert.match(html, /全部时间/); assert.match(html, /共 51 条/); assert.match(html, /合成股票/); assert.match(html, /历史登记/);
  assert.match(html, /导出 Excel/); assert.match(html, /每页 20 条/);
  const dangerous = '<img src=x onerror="bad()">';
  const channels = renderAdminDataPanel(result({ type: 'channels', items: [{ title: dangerous, sourceKey: 'hash"x', origin: 'registry' }] }), state({ type: 'channels' }), { page: 'channels' });
  assert.match(channels, /data-admin-data-action="source-records"/); assert.match(channels, /data-source-key="hash&quot;x"/);
  assert.doesNotMatch(channels, /<img|data-admin-data-type/); assert.match(channels, /&lt;img/);
  const empty = renderAdminDataPanel(result({ items: [], total: 0 }), state());
  assert.match(empty, /暂无符合条件/); assert.match(empty, /data-offset="20" disabled/);
});

function harness({ initialState = {}, page = 'reports' } = {}) {
  const pending = [], exports = [], errors = [], changes = [], listeners = {};
  const root = { innerHTML: '', isConnected: true, attributes: {}, contains: () => true, setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { listeners[name] = fn; }, removeEventListener(name, fn) { if (listeners[name] === fn) delete listeners[name]; } };
  let current = true;
  const panel = mountAdminDataPanel(root, { initialState, page, today: '2026-11-19', isCurrent: () => current,
    request(path, body, signal) { return new Promise((resolve, reject) => pending.push({ path, signal, resolve, reject })); },
    download(path, filename, signal, isCurrent) { return new Promise((resolve, reject) => exports.push({ path, filename, signal, isCurrent, resolve, reject })); },
    onState: value => changes.push(value), onError: error => errors.push(error) });
  const resolve = async (index, patch, promise) => { pending[index].resolve(result(patch)); await promise; };
  return { root, panel, pending, exports, errors, changes, listeners, resolve, invalidate() { current = false; } };
}

test('默认全量，期间、分类、筛选与分页均交服务端，后端校正页码生效', async () => {
  const h = harness({ page: 'cases' });
  assert.match(h.pending[0].path, /type=cases&period=all/);
  await h.resolve(0, { type: 'cases' }, h.panel.ready);
  const custom = h.panel.applyDates('2025-01-01', '2025-12-31');
  await h.resolve(1, { type: 'cases', period: 'custom', from: '2025-01-01', to: '2025-12-31' }, custom);
  const filtered = h.panel.applyFilters({ sourceKey: 'source-one', salesId: 'seller-one', origin: 'registry', status: 'closed', q: '合成股票' });
  const query = new URL('http://localhost' + h.pending[2].path).searchParams;
  assert.equal(query.get('sourceKey'), 'source-one'); assert.equal(query.get('salesId'), 'seller-one'); assert.equal(query.get('status'), 'closed');
  assert.equal(query.get('origin'), 'registry'); assert.equal(query.get('q'), '合成股票'); assert.equal(query.get('from'), '2025-01-01');
  await h.resolve(2, { type: 'cases', period: 'custom', from: '2025-01-01', to: '2025-12-31', total: 23 }, filtered);
  const page = h.panel.setPage(40);
  await h.resolve(3, { type: 'cases', period: 'custom', from: '2025-01-01', to: '2025-12-31', total: 23, offset: 20 }, page);
  assert.equal(h.changes.at(-1).offset, 20); assert.match(h.root.innerHTML, /第 2 \/ 2 页/);
  const month = h.panel.setPeriod('month');
  assert.doesNotMatch(h.pending[4].path, /from=|to=/); assert.match(h.pending[4].path, /status=closed/);
  await h.resolve(4, { type: 'cases', period: 'month', from: '2026-11-01' }, month);
  assert.equal(h.changes.at(-1).draftFrom, '2025-01-01'); h.panel.dispose();
});

test('来源下钻与返回保持期间及原筛选，报告切换不会携带不适用状态', async () => {
  const h = harness({ page: 'channels', initialState: { period: 'month', salesId: 'seller-one', q: '来源' } });
  assert.match(h.root.innerHTML, /option value="seller-one" selected/);
  await h.resolve(0, { type: 'channels', period: 'month', from: '2026-11-01' }, h.panel.ready);
  const drill = h.panel.sourceRecords('source-one', '合成来源');
  assert.match(h.pending[1].path, /type=records&period=month&sourceKey=source-one&salesId=seller-one/);
  await h.resolve(1, { type: 'records', period: 'month', from: '2026-11-01' }, drill);
  assert.match(h.root.innerHTML, /返回来源列表/);
  const back = h.panel.backChannels();
  assert.match(h.pending[2].path, /type=channels&period=month&sourceKey=&salesId=seller-one/);
  assert.equal(new URL('http://localhost' + h.pending[2].path).searchParams.get('q'), '来源');
  await h.resolve(2, { type: 'channels', period: 'month', from: '2026-11-01' }, back);
  const type = h.panel.setType('customers');
  assert.match(h.pending[3].path, /type=customers/); assert.match(h.pending[3].path, /status=all/);
  await h.resolve(3, { type: 'customers', period: 'month', from: '2026-11-01' }, type);
  h.panel.dispose();
});

test('Excel导出采用已应用的全部结果过滤，排除分页与未提交草稿，改变范围取消旧导出', async () => {
  const h = harness({ initialState: { ...state({ type: 'records', period: 'custom', from: '2025-01-01', to: '2025-12-31', sourceKey: 'source-one', q: '已应用', offset: 20 }) } });
  await h.resolve(0, { period: 'custom', from: '2025-01-01', to: '2025-12-31', offset: 20 }, h.panel.ready);
  const form = { dataset: { adminDataForm: 'filters' } };
  h.listeners.input({ type: 'input', target: { name: 'q', value: '未提交', closest: () => form } });
  const exportPromise = h.panel.exportData();
  assert.equal(h.exports.length, 1); const exported = h.exports[0];
  const query = new URL('http://localhost' + exported.path).searchParams;
  assert.equal(query.get('q'), '已应用'); assert.equal(query.get('sourceKey'), 'source-one'); assert.equal(query.get('offset'), null);
  assert.equal(query.get('from'), '2025-01-01'); assert.equal(query.get('format'), 'xlsx'); assert.equal(exported.filename, '留资与登记.xlsx');
  assert.equal(h.panel.exportData() instanceof Promise, true); assert.equal(h.exports.length, 1);
  const month = h.panel.setPeriod('month');
  assert.equal(exported.signal.aborted, true); assert.equal(exported.isCurrent(), false);
  exported.resolve(); await exportPromise;
  await h.resolve(1, { period: 'month', from: '2026-11-01' }, month);
  assert.doesNotMatch(h.root.innerHTML, /已导出当前筛选/);
  const nextExport = h.panel.exportData(); h.exports[1].resolve(); await nextExport;
  assert.match(h.root.innerHTML, /已导出当前筛选的全部结果/); h.panel.dispose();
});

test('日期无效不请求，编辑草稿和异步回包互不覆盖，断开页面与账号切换丢弃旧响应', async () => {
  const h = harness();
  const month = h.panel.setPeriod('month'); assert.equal(h.pending[0].signal.aborted, true);
  h.listeners.input({ type: 'input', target: { name: 'from', value: '2025-01-01', closest: () => ({ dataset: { adminDataForm: 'dates' } }) } });
  await h.resolve(1, { period: 'month', from: '2026-11-01' }, month);
  await h.resolve(0, { items: [{ title: '过期客户' }] }, h.panel.ready);
  assert.doesNotMatch(h.root.innerHTML, /过期客户/); assert.match(h.root.innerHTML, /value="2025-01-01"/);
  for (const dates of [['2026-02-30', '2026-03-01'], ['2026-11-19', '2026-11-18'], ['2026-11-19', '2026-11-20']]) { h.panel.applyDates(...dates); assert.equal(h.pending.length, 2); }
  const next = h.panel.refresh(), before = h.root.innerHTML, changes = h.changes.length;
  h.invalidate(); await h.resolve(2, { period: 'month', items: [{ title: '旧账号资料' }] }, next);
  assert.equal(h.root.innerHTML, before); assert.equal(h.changes.length, changes); h.panel.dispose(); assert.deepEqual(Object.keys(h.listeners), []);
});

test('查询失败能重试，401交主应用，损坏响应不显示零数量', async () => {
  const h = harness(); h.pending[0].reject(new Error('数据接口异常')); await h.panel.ready;
  assert.match(h.root.innerHTML, /数据接口异常/); assert.match(h.root.innerHTML, /重新加载/);
  const retry = h.panel.refresh(); await h.resolve(1, {}, retry); assert.doesNotMatch(h.root.innerHTML, /数据接口异常/);
  const broken = h.panel.refresh(); h.pending[2].resolve({ items: [] }); await broken;
  assert.match(h.root.innerHTML, /业务数据暂未完整返回/); assert.doesNotMatch(h.root.innerHTML, /共 0 条/);
  const auth = h.panel.refresh(), failure = new Error('请先登录'); failure.status = 401;
  h.pending[3].reject(failure); await auth; assert.equal(h.errors[0], failure); h.panel.dispose();
});
