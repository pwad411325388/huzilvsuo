import test from 'node:test';
import assert from 'node:assert/strict';
import { overview } from '../web/analytics.js';
import { buildOverviewDetail, renderOverviewDetail } from '../web/overview-detail.js';

const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const ui = {
  safe,
  button: (label, action, value = '', extra = '') => `<button type="button" data-action="${safe(action)}" data-value="${safe(value)}" ${extra}>${safe(label)}</button>`,
  field: (label, input) => `<label>${safe(label)}${input}</label>`,
  panel: (title, content) => `<section><h2>${title}</h2>${content}</section>`,
  empty: text => `<p>${safe(text)}</p>`,
};

function fixture() {
  const lead = (id, clientId, options = {}) => ({
    id, clientId, name: '留资时姓名', phone: '18800000001', number: `LZ-${id.padStart(6, '0')}`, recordNumber: Number(id),
    stockName: '甲公司', stockCode: 'AAA', companyName: '甲公司', createdOn: '2026-11-17', needsAssignment: false,
    brokerId: 'broker-current-internal', brokerName: '当前券商', salesName: '冬天', status: '待跟进', ...options,
  });
  return {
    today: '2026-11-17', caseCutoff: '2026-01-01',
    assignments: [
      lead('1', 'client-a-internal', { createdOn: '2026-10-31', needsAssignment: true, legacy: true, reason: '待确认经办人' }),
      lead('2', 'client-a-internal', { createdOn: '2026-11-01', needsAssignment: true }),
      lead('3', 'client-a-internal', { createdOn: '2026-11-30', stockName: '乙公司', stockCode: 'BBB', salesName: '夏天' }),
      lead('4', 'client-b-internal', { createdOn: '2026-12-01', brokerId: null, brokerName: null }),
    ],
    clients: [
      { id: 'client-a-internal', name: '现用姓名', phone: '19900000001', firstBrokerId: 'broker-first-internal', brokerId: 'broker-current-internal', brokerName: '当前券商', signedOn: '2026-11-01' },
      { id: 'client-b-internal', name: '乙客户', phone: '19900000002', firstBrokerId: null, brokerId: null, signedOn: '2026-10-31' },
      { id: 'client-c-internal', name: '未留资签约客户', phone: '19900000003', brokerId: 'broker-current-internal', signedOn: '2026-11-30' },
      { id: 'client-d-internal', name: '下月签约客户', phone: '19900000004', signedOn: '2026-12-01' },
    ],
    brokers: [
      { id: 'broker-first-internal', name: '首次券商', salesName: '秋天', signedOn: '2026-01-01' },
      { id: 'broker-current-internal', name: '当前券商', salesName: '冬天', signedOn: '2026-02-01', username: 'winter', accountStatus: 'active' },
      { id: 'broker-closed-internal', name: '历史券商', salesName: '春天', signedOn: '2025-01-01', username: 'old', accountStatus: 'closed' },
    ],
    cases: [
      { id: 'case-1-internal', recordNumber: 1, leadId: '1', title: '甲公司诉讼', status: '已受理', openedOn: '2026-11-01', brokerId: 'broker-current-internal' },
      { id: 'case-2-internal', recordNumber: 2, leadId: '3', title: '乙公司诉讼', status: '诉讼中', openedOn: '2026-11-02', brokerId: 'broker-current-internal' },
      { id: 'case-3-internal', recordNumber: 3, leadId: '2', title: '甲公司已结', status: '已结案', openedOn: '2026-11-03', brokerId: 'broker-current-internal' },
      { id: 'case-4-internal', recordNumber: 4, leadId: '4', title: '暂未受理案件', status: '待受理', openedOn: '2026-11-04', brokerId: null },
    ],
  };
}

test('八项明细数量、名称和单位与总览完全一致，且只输出展示字段', () => {
  const view = fixture();
  for (const [index, [title, total, unit]] of overview(view).entries()) {
    const detail = buildOverviewDetail(view, index);
    assert.equal(detail.title, title);
    assert.equal(detail.total, total);
    assert.equal(detail.unit, unit);
    assert.equal(detail.rows.length, total);
    assert.ok(detail.description.length > 0);
    const serialized = JSON.stringify(detail);
    assert.doesNotMatch(serialized, /-internal|返佣|金额|奖励|password|rebate/);
    for (const row of detail.rows) assert.deepEqual(Object.keys(row), detail.columns.map(column => column.key));
  }
  assert.throws(() => buildOverviewDetail(view, 8), /总览明细类型无效/);
});

test('客户明细按客户去重并汇总股票，展示当前资料和首次当前券商', () => {
  const detail = buildOverviewDetail(fixture(), 1);
  assert.equal(detail.rows.length, 2);
  assert.deepEqual(detail.rows[0], {
    customer: '现用姓名', phone: '19900000001', stocks: '甲公司（AAA） · 2 条；乙公司（BBB） · 1 条',
    firstBroker: '首次券商', broker: '当前券商', owner: '冬天', sales: '冬天、夏天', signedOn: '2026-11-01',
  });
  assert.equal(detail.rows[1].broker, '自然流入');
  assert.equal(detail.rows[1].owner, '无券商归属');
  const signed = buildOverviewDetail(fixture(), 7);
  assert.equal(signed.rows[0].stocks, detail.rows[0].stocks);
  assert.equal(signed.rows[1].stocks, '暂无留资');
});

test('转派留资后客户仍归当前券商负责人，可按归属销售搜索留资和本月签约客户', () => {
  const view = fixture();
  for (const lead of view.assignments) lead.salesName = '实际经办销售';
  for (const index of [1, 7]) {
    const detail = buildOverviewDetail(view, index);
    assert.equal(detail.rows[0].owner, '冬天');
    assert.equal(detail.rows[0].sales, '实际经办销售');
    const html = renderOverviewDetail(view, { index, q: '冬天', offset: 0 }, ui);
    assert.match(html, /客户归属销售<\/th>/);
    assert.match(html, /留资经办销售<\/th>/);
    assert.match(html, /现用姓名/);
    assert.doesNotMatch(html, /乙客户/);
  }
  const broker = view.brokers[1];
  broker.salesName = broker.salesId = 'hidden-legacy-id';
  const html = renderOverviewDetail(view, { index: 1, q: '' }, ui);
  assert.match(html, /未登记姓名/);
  assert.doesNotMatch(html, /hidden-legacy-id/);
});

test('渠道不含自然流入，待分配包含历史待核对，案件按准确状态展示', () => {
  const view = fixture();
  const channels = buildOverviewDetail(view, 2);
  assert.equal(channels.rows.length, 3);
  assert.deepEqual(channels.rows.map(row => row.status), ['待开户', '已开户', '已注销']);
  assert.ok(channels.rows.every(row => row.broker !== '自然流入'));
  assert.equal(channels.rows.find(row => row.broker === '当前券商').customers, 1);
  const pending = buildOverviewDetail(view, 3);
  assert.deepEqual(pending.rows.map(row => row.number), ['LZ-000001', 'LZ-000002']);
  assert.match(pending.rows[0].reason, /历史待核对/);
  const ongoing = buildOverviewDetail(view, 4);
  assert.deepEqual(ongoing.rows.map(row => row.status), ['已受理', '诉讼中']);
  assert.deepEqual(ongoing.rows.map(row => row.number), ['AJ-000001', 'AJ-000002']);
  assert.deepEqual(buildOverviewDetail(view, 5).rows.map(row => row.status), ['已结案']);
});

test('本月统计包含月首月末并排除相邻月份', () => {
  assert.deepEqual(buildOverviewDetail(fixture(), 6).rows.map(row => row.date), ['2026-11-01', '2026-11-30']);
  assert.deepEqual(buildOverviewDetail(fixture(), 7).rows.map(row => row.signedOn), ['2026-11-01', '2026-11-30']);
});

test('明细支持展示字段搜索、稳定钩子及20条分页，搜索和数据均安全转义', () => {
  const view = fixture();
  for (const [index, q, count] of [[0, '乙公司', 1], [0, 'bbb', 1], [0, '留资时姓名', 4], [0, '18800000001', 4], [0, '夏天', 1],
    [1, '现用姓名', 1], [1, '19900000001', 1], [1, '首次券商', 1], [1, '当前券商', 1], [2, '秋天', 1], [4, '乙公司诉讼', 1], [0, 'internal', 0]]) {
    const html = renderOverviewDetail(view, { index, q, offset: 0 }, ui);
    assert.match(html, new RegExp(`data-overview-filtered="${count}"`));
    assert.match(html, new RegExp(`data-overview-detail data-index="${index}" data-total="${overview(view)[index][1]}"`));
    assert.match(html, /data-form="overview-detail-search"/);
    assert.match(html, /name="q"/);
    assert.match(html, /data-action="overview-back"/);
    assert.match(html, /data-action="overview-reset"/);
  }
  view.assignments = Array.from({ length: 45 }, (_, index) => ({ ...view.assignments[0], number: `LZ-${String(index + 1).padStart(6, '0')}` }));
  const render = offset => renderOverviewDetail(view, { index: 0, q: '', offset }, ui);
  assert.equal((render(0).match(/<tbody>(.*?)<\/tbody>/s)[1].match(/<tr>/g) || []).length, 20);
  assert.match(render(0), /data-action="overview-page" data-value="20"/);
  assert.doesNotMatch(render(20), /LZ-000001/);
  assert.match(render(20), /LZ-000021/);
  assert.equal((render(40).match(/<tbody>(.*?)<\/tbody>/s)[1].match(/<tr>/g) || []).length, 5);
  assert.match(render(999), /第 3 \/ 3 页/);
  assert.match(render(-1), /第 1 \/ 3 页/);
  assert.match(renderOverviewDetail(view, { index: 0, q: '无匹配', offset: 40 }, ui), /暂无|未找到/);
  const escapedQuery = renderOverviewDetail(view, { index: 0, q: '"><script>alert(1)</script>', offset: 0 }, ui);
  assert.doesNotMatch(escapedQuery, /<script>/);
  assert.match(escapedQuery, /&lt;script&gt;/);
  view.assignments[0].name = '<script>alert(1)</script>';
  const escapedData = render(0);
  assert.doesNotMatch(escapedData, /<script>/);
  assert.match(escapedData, /&lt;script&gt;/);
});
