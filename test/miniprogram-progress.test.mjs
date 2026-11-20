import { developAccountInfo, nativePages } from '../test-support/native-page.mjs';
import { progressNode, progressSteps } from '../progress-dictionary.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = file => readFileSync(new URL('../miniprogram/' + file, import.meta.url), 'utf8');

function mini() {
  const app = { globalData: { token: 'first-session' } };
  const requests = [], navigations = [];
  const wx = {
    getAccountInfoSync: developAccountInfo,
    request: call => { if (new URL(call.url).pathname === '/api/view') call.success({statusCode:200,data:{actor:{role:'sales',id:app.globalData.token},today:'2026-11-18'}}); else requests.push(call); },
    navigateTo: ({ url }) => navigations.push(url),
    reLaunch: ({ url }) => navigations.push(url),
    removeStorageSync() {},
  };
  const runtime = { app, wx, networkConfig: { apiBase: 'http://fixture.test/api' } };
  const page = name => nativePages(runtime).page(name);
  return { page, client: nativePages(runtime).load('client.js'), app, requests, navigations };
}

test('原生详情按所点记录和当前会话取数，返回或切账号后丢弃迟到响应', async () => {
  const { page, client, app, requests, navigations } = mini();
  client.openProgress({ currentTarget: { dataset: { kind: 'registry', id: 'row-key-2' } } });
  const route = new URL(navigations.pop(), 'http://local');
  assert.equal(route.pathname, '/pages/progress/index');
  const detail = page('progress');
  detail.onLoad(Object.fromEntries(route.searchParams));
  const stale = detail.onShow();
  const old = requests.shift();
  assert.equal(new URL(old.url).search, '?kind=registry&id=row-key-2');
  detail.onHide();
  old.success({ statusCode: 200, data: { contractNumber: 'TEST-OLD' } });
  await stale;
  assert.equal(detail.data.detail, null);

  const pending = detail.onShow();
  app.globalData.token = 'new-session';
  requests.shift().success({ statusCode: 200, data: { contractNumber: 'TEST-OLD' } });
  await pending;
  assert.equal(detail.data.detail, null);
  const denied = detail.onShow();
  const active = requests.shift();
  assert.equal(active.header.Authorization, 'Bearer new-session');
  active.success({ statusCode: 404, data: { message: '记录不存在或无权查看' } });
  await denied;
  assert.equal(detail.data.notice, '记录不存在或无权查看');
  assert.equal(detail.data.detail, null);
  assert.equal(detail.data.retryable, false);

  const lead = page('progress');
  lead.onLoad({ kind: 'lead', id: 'lead-2' });
  const loaded = lead.onShow();
  requests.shift().success({ statusCode: 200, data: {
    kind: 'lead', id: 'lead-2', current: null, relatedCases: [{ id: 'case-1', title: '测试一案' }, { id: 'case-2', title: '测试二案' }],
  } });
  await loaded;
  assert.equal(lead.data.detail.current, null);
  lead.openProgress({ currentTarget: { dataset: { kind: 'case', id: lead.data.detail.relatedCases[1].id } } });
  assert.equal(navigations.pop(), '/pages/progress/index?kind=case&id=case-2');
});

test('从历史记录详情返回后保留检索和页码，换账号则重新查询首页', async () => {
  const { page, app, requests } = mini();
  const registry = page('registry');
  async function finish(pending, q, offset) {
    await new Promise(resolve => setImmediate(resolve));
    const call = requests.shift();
    assert.equal(new URL(call.url).searchParams.get('q'), q);
    assert.equal(new URL(call.url).searchParams.get('offset'), String(offset));
    assert.equal(new URL(call.url).searchParams.get('limit'), '5');
    call.success({ statusCode: 200, data: { items: [{id:'test-key'}],total:40,offset,limit:5 } });
    await pending;
  }
  await finish(registry.onShow(), '', 0);
  registry.recordsInput({ detail: { value: '示例股票' } });
  await finish(registry.recordsSearch(), '示例股票', 0);
  await finish(registry.recordsNext(), '示例股票', 5);
  registry.onHide();
  assert.equal(registry.data.recordList.data, null);
  await finish(registry.onShow(), '示例股票', 5);
  registry.onHide();
  app.globalData.token = 'another-sale';
  await finish(registry.onShow(), '', 0);
  assert.equal(registry.data.recordList.draft, '');
});

test('原生进度只展示当前与下一节点，保留角色文案小注及销售合同号', async () => {
  const { page, requests } = mini();
  const detail = page('progress');
  detail.onLoad({ kind: 'case', id: 'test-case' });
  async function load(current, steps, contractNumber) {
    const pending = detail.onShow();
    requests.shift().success({ statusCode: 200, data: { current, steps, contractNumber } });
    await pending;
    return detail.data.detail;
  }
  const signed = { stage: 'intake', node: 'signed_waiting_filing', label: '已签约' };
  const next = { stage: 'filing', node: 'preparing', label: '立案材料准备中', status: 'next' };
  const investor = await load(signed, [{ ...signed, note: '待立案', status: 'current' }, next]);
  assert.equal(investor.steps.length, 2);
  assert.equal(investor.steps[0].label, '已签约');
  assert.equal(investor.steps[0].note, '待立案');
  assert.equal(investor.steps[1].label, '立案材料准备中');
  assert.equal(investor.contractNumber, undefined);
  assert.equal(investor.contractStep, '');
  const sales = await load(signed, [{ ...signed, status: 'current' }, next], 'TEST-123');
  assert.equal(sales.contractStep, signed.node);
  assert.equal(sales.steps[0].note, undefined);
  assert.equal(sales.steps[0].key, 'intake:signed_waiting_filing');
  assert.equal(sales.steps[1].key, 'filing:preparing');
  const received = { stage: 'intake', node: 'lead_received', label: '已留资' };
  const beforeSigning = await load(received, [{ ...received, status: 'current' }, { ...signed, status: 'next' }], 'TEST-123');
  assert.equal(beforeSigning.contractStep, '', '合同号不能附到尚未到达的下一签约节点');
  const supplement = { stage: 'filing', node: 'supplement', label: '待您补充材料' };
  const unknownRoute = { stage: '', node: 'pending_route', label: '后续进度待确认', status: 'next' };
  assert.equal((await load(supplement, [{ ...supplement, status: 'current' }, unknownRoute])).steps[1].label, '后续进度待确认');
});

test('终态及未知进度不编造后续，旧完成和参考节点不会重新出现', async () => {
  const { page, requests } = mini();
  const detail = page('progress');
  detail.onLoad({ kind: 'registry', id: 'row-key' });
  async function load(current, steps) {
    const pending = detail.onShow();
    requests.shift().success({ statusCode: 200, data: { current, steps } });
    await pending;
    return detail.data.detail;
  }
  const closed = { stage: 'closure', node: 'closed', label: '已结案' };
  const terminal = await load(closed, [{ ...closed, status: 'current' },
    { stage: '', node: 'pending_route', label: '后续进度待确认', status: 'next' }]);
  assert.equal(terminal.steps.length, 1);
  assert.equal(terminal.steps[0].status, 'current');
  const unknown = await load(null, [{ ...closed, status: 'next' }]);
  assert.equal(unknown.current, null);
  assert.deepEqual(Array.from(unknown.steps, step => [step.title, step.statusLabel, step.uncertain, step.dateText]),
    [['案件进度', '待核对', true, '']]);
  const current = { stage: 'filing', node: 'submitted', label: '已提交立案' };
  const old = await load(current, [
    { stage:'filing',node:'preparing',label:'立案材料准备中',status:'completed' },
    { ...current,status:'current' },
    { stage:'filing',node:'supplement',label:'待补充材料',status:'reference' },
  ]);
  assert.equal(old.steps.length, 1);
  assert.equal(old.steps[0].node, 'submitted');
  const compatible = await load(current, undefined);
  assert.equal(compatible.steps.length, 1);
  assert.equal(compatible.steps[0].label, '已提交立案');
});

test('历史案件依照展示节点保留审级、执行与申报的实际含义，正式节点优先', async () => {
  const { page, requests } = mini();
  const detail = page('progress');
  detail.onLoad({ kind: 'registry', id: 'history-preview' });
  async function load(data) {
    const pending = detail.onShow();
    requests.shift().success({ statusCode: 200, data });
    await pending;
    return detail.data.detail;
  }
  const rows = [
    ['立案', '已立案未开庭', '开庭', '待开庭', 'display_next', '审级待核对'],
    ['判决', '判决生效待执行', '执行', '执行中', 'display_next'],
    ['债权申报', '破产债权已申报', '后续进度', '申报结果待确认', 'pending_route'],
    ['立案', '立案退回', '后续进度', '后续处理待确认', 'pending_route'],
  ];
  for (const [stageLabel, label, nextTitle, nextLabel, node, note] of rows) {
    const current = { stage: 'historical', node: 'reported_state', stageLabel, label, note };
    const currentStep = { ...current, status: 'current' };
    if (label === '已立案未开庭') Object.assign(currentStep, { date: '2024-02-29', dateLabel: '立案日期' });
    const next = { stage: '', node, stageLabel: nextTitle, label: nextLabel, status: 'next' };
    const result = await load({ current: null, steps: [], registeredOn: '2020-01-01', filedOn: '2024-02-29',
      displayProgress: { current, steps: [currentStep, next] } });
    assert.equal(result.current, null);
    assert.deepEqual(Array.from(result.steps, step => [step.title, step.statusLabel, step.status, step.uncertain]),
      [[stageLabel, label, 'current', false], [nextTitle, nextLabel, 'next', false]]);
    assert.equal(result.steps[0].dateText, currentStep.date ? '2024.02.29' : '日期待补充');
    assert.equal(result.steps[0].note, note);
    assert.equal(result.steps[1].dateText, '');
  }
  const signed = progressNode('intake', 'signed_waiting_filing', 'sales');
  const result = await load({ current: signed, steps: progressSteps(signed, 'sales'), contractNumber: 'SAMPLE-CONTRACT',
    displayProgress: { current: { stage: 'unknown', node: 'unknown', label: '多余投影', uncertain: true }, steps: [], notice: '多余说明' } });
  assert.deepEqual(Array.from(result.steps, step => step.status), ['current', 'active', 'next']);
  assert.equal(result.progressNotice, '');
  assert.equal(result.contractStep, signed.node);
});

test('待核对锚点不显示日期和未经确认的下一步，旧响应也不回显原始备注', async () => {
  const { page, requests } = mini();
  const detail = page('progress');
  detail.onLoad({ kind: 'registry', id: 'unknown-source' });
  const current = { stage: 'unknown', node: 'unknown', stageLabel: '案件进度', label: '待核对', uncertain: true };
  const notice = '当前资料尚未明确具体阶段，请以律所确认结果为准。';
  for (const displayProgress of [undefined, { current, notice, steps: [
    { ...current, status: 'current', hideDate: true, date: '2020-01-01' },
    { stage: 'first_hearing', node: 'awaiting_hearing', label: '一审待开庭', status: 'next' },
  ] }]) {
    const pending = detail.onShow();
    requests.shift().success({ statusCode: 200, data: { current: null, sourceStatus: '原始备注仅供内部核对', displayProgress } });
    await pending;
    assert.deepEqual(Array.from(detail.data.detail.steps, step => [step.title, step.statusLabel, step.status, step.uncertain, step.dateText]),
      [['案件进度', '待核对', 'current', true, '']]);
    assert.equal(detail.data.detail.progressNotice, notice);
    assert.equal(detail.data.detail.contractStep, '');
  }
  const markup = source('pages/progress/index.wxml');
  assert.match(markup, /wx:if="{{item\.uncertain}}">\?<\/text>/);
  assert.match(markup, /{{detail\.progressNotice}}/);
  assert.doesNotMatch(markup, /detail\.sourceStatus|待同步|尚未同步/);
});

test('已签约待立案展示真实签约及两项立案提示，只为签约节点显示日期和角色说明', async () => {
  const { page, requests } = mini();
  const detail = page('progress');
  detail.onLoad({ kind: 'case', id: 'signed-case' });
  async function load(current, steps, contractNumber) {
    const pending = detail.onShow();
    requests.shift().success({ statusCode: 200, data: { current, steps, contractNumber } });
    await pending;
    return detail.data.detail;
  }

  for (const role of ['investor', 'sales']) {
    const current = progressNode('intake', 'signed_waiting_filing', role);
    const steps = progressSteps(current, role).map(step => ({ ...step, date: '2026-11-18' }));
    const result = await load(current, steps, role === 'sales' ? 'TEST-SIGNED' : undefined);
    assert.deepEqual(Array.from(result.steps, step => [
      step.status, step.title, step.statusLabel, step.dateText,
    ]), [
      ['current', '留资与签约', '已签约', '2026.11.18'],
      ['active', '立案', '立案材料准备中', ''],
      ['next', '立案', '已提交立案', ''],
    ]);
    assert.equal(result.steps[0].note, role === 'investor' ? '待立案' : undefined);
    assert.equal(result.contractStep, role === 'sales' ? current.node : '');
    assert.equal(result.current.node, 'signed_waiting_filing');
  }

  const signed = progressNode('intake', 'signed_waiting_filing', 'sales');
  const [current, preparing, submitted] = progressSteps(signed, 'sales');
  const unrelated = { ...preparing, stage: 'debt_claim' };
  for (const malformed of [
    [current, unrelated], [current, preparing], [current, unrelated, submitted],
    [current, { ...preparing, label: ' ' }, submitted], [current, preparing, { ...submitted, label: '' }],
  ]) {
    assert.deepEqual(Array.from((await load(signed, malformed)).steps, step => step.node), [signed.node]);
  }
  const wrongCurrent = { ...current, note: '其他记录', date: '2020-01-01' };
  for (const candidate of [null, { ...wrongCurrent, stage: '' }, { ...wrongCurrent, stage: 'filing' },
    { ...wrongCurrent, node: 'signed' }, { ...wrongCurrent, label: '' }]) {
    const fallback = await load(signed, [candidate, preparing, submitted]);
    assert.deepEqual(Array.from(fallback.steps, step => step.node), [signed.node]);
    assert.equal(fallback.steps[0].note, signed.note);
    assert.equal(fallback.steps[0].dateText, '日期待补充');
  }
  const extra = await load(signed, [null, current, unrelated, { ...submitted, stage: 'unrelated' }, preparing, submitted]);
  assert.deepEqual(Array.from(extra.steps, step => step.key), ['intake:signed_waiting_filing', 'filing:preparing', 'filing:submitted']);
  const alternative = { ...progressNode('filing', 'supplement', 'investor'), status: 'next' };
  for (const explicitRoute of [[current, alternative], [current, preparing, alternative], [current, unrelated, alternative]]) {
    assert.deepEqual(Array.from((await load(signed, explicitRoute)).steps, step => step.node), [signed.node, 'supplement']);
  }
  assert.deepEqual(Array.from((await load(signed, [current, submitted])).steps, step => step.status), ['current', 'next']);
  const otherCurrent = progressNode('filing', 'preparing', 'investor');
  const other = await load(otherCurrent, [{ ...otherCurrent, status: 'current' }, preparing, submitted]);
  assert.deepEqual(Array.from(other.steps, step => step.status), ['current', 'next']);
});

test('时间线大字显示阶段、同行小字显示状态，仅当前节点显示对应日期', async () => {
  const { page, requests } = mini();
  const detail = page('progress');
  detail.onLoad({ kind: 'case', id: 'cross-stage-case' });
  const current = { stage: 'first_hearing', node: 'awaiting_judgment', stageLabel: '一审', label: '等待判决结果' };
  async function load(next, date = '2026-11-18') {
    const pending = detail.onShow();
    requests.shift().success({ statusCode: 200, data: {
      current, filedOn: '2025-01-01', steps: [{ ...current, status: 'current', stageLabel: '', date, dateLabel: '节点日期' },
        { ...next, status: 'next', date: '2026-12-01' }],
    } });
    await pending;
    return detail.data.detail.steps;
  }
  const crossStage = await load({ stage: 'appeal', node: 'awaiting_judgment', stageLabel: '上诉与二审', label: '等待判决结果' });
  assert.equal(crossStage[0].title, '一审');
  assert.equal(crossStage[1].title, '上诉与二审');
  assert.equal(crossStage[0].statusLabel, current.label);
  assert.equal(crossStage[1].statusLabel, current.label);
  assert.equal(crossStage[0].dateText, '2026.11.18');
  assert.equal(crossStage[1].dateText, '');
  const sameStage = await load({ stage: 'first_hearing', node: 'judgment_pending_effective', label: '判决待生效' }, '');
  assert.equal(sameStage[1].title, '一审');
  assert.equal(sameStage[0].dateText, '日期待补充', '不挪用记录其他日期');
  const pendingRoute = await load({ stage: '', node: 'pending_route', stageLabel: '', label: '后续进度待确认' }, '2026-02-30');
  assert.equal(pendingRoute[1].title, '后续进度');
  assert.equal(pendingRoute[1].statusLabel, '待确认');
  assert.equal(pendingRoute[0].dateText, '日期待补充');
  const missingLabel = await load({ stage: 'appeal', node: 'awaiting_judgment', label: '等待判决结果' });
  assert.equal(missingLabel[1].title, current.label);
  assert.equal(missingLabel[1].statusLabel, '');
  const markup = source('pages/progress/index.wxml');
  assert.match(markup, /item\.status === 'current'\}\}">✓<\/text>/);
  assert.match(markup, /index \+ 1 < detail\.steps\.length\}\}" class="step-connector"/);
  assert.match(markup, /class="step-line"[\s\S]+{{item\.title}}[\s\S]+class="step-status"[\s\S]+{{item\.statusLabel}}[\s\S]+class="step-date"/);
  assert.match(markup, /wx:if="{{item\.dateText}}" class="step-date"/);
});
