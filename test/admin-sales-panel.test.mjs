import assert from 'node:assert/strict';
import test from 'node:test';
import { mountAdminSalesPanel, renderAdminSalesDetails, renderAdminSalesOverview } from '../web/admin-sales-panel.js';

const overview = (name = '测试销售甲') => ({
  rows: [{ id: 'seller-a', name, status: '正常', channelCount: 1, channelCustomers: 19, recordCount: 31, customerCount: 22,
    systemRecordCount: 2, registryRecordCount: 29, ongoing: 4, closed: 5,
    unknownCaseCount: 20, unverifiedCustomerCount: 10, sourceUnknownCount: 3,
    sources: [{ key: 'source-a', name: '测试来源', origin: 'registry', recordCount: 28, customerCount: 19 }] }],
  meta: { sourceName: '合成样表.xlsx', importedAt: '2026-11-18T00:00:00Z', registryTotal: 33, registryLinked: 29, registryUnlinked: 4 },
  notes: [],
});
const detailResult = (title = '测试客户甲', offset = 0) => ({ metric: 'records', title: '留资与登记', total: 31, offset, limit: 20,
  items: [{ id: 'one', number: 'DJ-000101', title, phone: '19900008881', stockName: '测试股票', stockCode: 'TST',
    source: '测试来源', sales: '测试销售甲', registeredOn: '2026-11-18', assignmentStatus: '已关联', caseStatus: '进度待核对', origin: 'registry' }], notes: [] });
const selection = { salesId: 'seller-a', salesName: '测试销售甲', metric: 'records', origin: 'all', q: '', offset: 0 };

test('销售客户档案明细将案件进度与资料状态分开显示', () => {
  const data = detailResult();
  data.items[0] = { ...data.items[0], status: '资料待核对', caseStatus: '多个案件进度' };
  const html = renderAdminSalesDetails(data, { ...selection, metric: 'customers' });
  assert.match(html, /<th\b[^>]*>案件进度<\/th>/);
  assert.match(html, /<td>多个案件进度<\/td>/);
  assert.match(html, /<small>资料待核对<\/small>/);
});

test('销售汇总标明历史来源和档案单位，每个可点击数字带对应明细范围', () => {
  const html = renderAdminSalesOverview(overview(), { salesId: 'seller-a', q: '甲' });
  assert.match(html, /来源渠道统计/);
  assert.match(html, /历史来源不表示已开通券商账号/);
  assert.doesNotMatch(html, /跟进/);
  assert.match(html, /进度待核登记/);
  assert.match(html, /data-sales-id="__unlinked__"[^>]*data-metric="records"/);
  assert.match(html, /data-metric="customers"[^>]*data-source-key="__known__"/);
  assert.match(html, /data-metric="customers"[^>]*data-source-key="source-a"[^>]*>测试来源 · 19 份/);
  assert.match(html, /data-metric="records"[^>]*data-source-key="__unknown__"[^>]*>来源待核对 3 条/);
  assert.match(html, /data-metric="records"[^>]*>31 条/);
  assert.match(html, /data-metric="customers"[^>]*>22 份/);
  assert.match(html, /<option value="seller-a" selected>/);
  assert.match(html, /value="甲"/);
});

test('名称、来源、搜索及明细文本都转义，登记资料不作为可执行HTML', () => {
  const malicious = '<img src=x onerror="alert(1)">';
  const data = overview(malicious);
  data.rows[0].sources[0].name = malicious;
  data.notes = [malicious];
  data.meta.sourceName = malicious;
  const html = renderAdminSalesOverview(data, { q: '"><script>bad()</script>' });
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;img/);
  const details = detailResult(malicious);
  details.items[0].source = malicious;
  details.items[0].stockName = malicious;
  const detailHtml = renderAdminSalesDetails(details, { ...selection, salesName: malicious, q: malicious });
  assert.doesNotMatch(detailHtml, /<img|<script>/);
  assert.match(detailHtml, /DJ-000101/);
  assert.match(detailHtml, /<td>已关联<\/td>/);
  assert.match(detailHtml, /进度待核对/);
  assert.doesNotMatch(detailHtml, /跟进/);
  assert.match(detailHtml, /第 1 \/ 2 页/);
  assert.match(detailHtml, /data-offset="0" disabled/);
  assert.match(detailHtml, /data-offset="20"/);
});

function harness(initialState = {}) {
  const listeners = {}, changes = [], errors = [], pending = [];
  const root = { innerHTML: '', isConnected: true, attributes: {}, contains: () => true,
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { listeners[name] = fn; },
    removeEventListener(name, fn) { if (listeners[name] === fn) delete listeners[name]; } };
  let current = true;
  const panel = mountAdminSalesPanel(root, { initialState, isCurrent: () => current,
    request(path, body, signal) { return new Promise((resolve, reject) => pending.push({ path, signal, resolve, reject })); },
    onState: value => changes.push(value), onError: error => errors.push(error) });
  return { root, panel, pending, changes, errors, listeners, invalidate() { current = false; } };
}

test('切换筛选或明细时丢弃较早响应，返回保留销售条件，分页用后端校正值', async () => {
  const h = harness({ filters: { salesId: 'seller-a', q: '甲' } });
  assert.match(h.pending[0].path, /salesId=seller-a&q=/);
  const opened = h.panel.openDetail(selection);
  assert.equal(h.pending[0].signal.aborted, true);
  assert.match(h.pending[1].path, /\/sales\/details\?salesId=seller-a&metric=records/);
  h.pending[1].resolve(detailResult('最新明细')); await opened;
  h.pending[0].resolve(overview('过期汇总')); await h.panel.ready;
  assert.match(h.root.innerHTML, /最新明细/); assert.doesNotMatch(h.root.innerHTML, /过期汇总/);
  const next = h.panel.loadDetails({ q: '股票', origin: 'registry', offset: 40 });
  assert.match(h.pending[2].path, /origin=registry/); assert.match(h.pending[2].path, /offset=40/);
  h.pending[2].resolve(detailResult('末页明细', 20)); await next;
  assert.equal(h.changes.at(-1).detail.offset, 20);
  assert.match(h.root.innerHTML, /第 2 \/ 2 页/);
  const back = h.panel.loadOverview();
  assert.match(h.pending[3].path, /\/sales\/overview\?salesId=seller-a&q=/);
  h.pending[3].resolve(overview()); await back;
  assert.equal(h.changes.at(-1).detail, null);
  assert.equal(h.changes.at(-1).filters.q, '甲');
  assert.equal(h.root.attributes['aria-busy'], 'false');
  h.panel.dispose();
});

test('断开页面或切换账号后不展示迟到数据，错误可重试且401交还主应用', async () => {
  const h = harness();
  h.pending[0].reject(new Error('接口暂不可用')); await h.panel.ready;
  assert.match(h.root.innerHTML, /接口暂不可用/); assert.match(h.root.innerHTML, /重新加载/);
  const retry = h.panel.refresh();
  h.pending[1].resolve(overview()); await retry;
  assert.doesNotMatch(h.root.innerHTML, /接口暂不可用/);
  const old = h.panel.openDetail(selection);
  const before = h.root.innerHTML, savedChanges = h.changes.length;
  h.invalidate();
  h.pending[2].resolve(detailResult('前一账号资料')); await old;
  assert.equal(h.root.innerHTML, before); assert.equal(h.changes.length, savedChanges);
  h.panel.dispose();
  assert.deepEqual(Object.keys(h.listeners), []);
  const unauthorized = harness();
  const failure = new Error('请先登录'); failure.status = 401;
  unauthorized.pending[0].reject(failure); await unauthorized.panel.ready;
  assert.equal(unauthorized.errors.length, 1);
  unauthorized.panel.dispose();
});

test('恢复明细过滤与页码时直接读取同一范围，结构损坏响应不会伪装为空统计', async () => {
  const h = harness({ filters: { salesId: 'seller-a', q: '' }, detail: { ...selection, sourceKey: '__unknown__', sourceName: '来源待核对', q: '测试', origin: 'registry', offset: 20 } });
  assert.match(h.pending[0].path, /\/sales\/details/);
  assert.match(h.pending[0].path, /sourceKey=__unknown__&origin=registry/);
  assert.match(h.pending[0].path, /offset=20/);
  h.pending[0].resolve({ items: [] }); await h.panel.ready;
  assert.match(h.root.innerHTML, /明细数据暂未完整返回/);
  assert.doesNotMatch(h.root.innerHTML, /共 0 条/);
  h.panel.dispose();
});
