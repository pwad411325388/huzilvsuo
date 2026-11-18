import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = file => readFileSync(new URL('../miniprogram/' + file, import.meta.url), 'utf8');

function mini() {
  const app = { globalData: { token: 'first-session' } };
  const requests = [], navigations = [];
  const wx = {
    request: call => requests.push(call),
    navigateTo: ({ url }) => navigations.push(url),
    reLaunch: ({ url }) => navigations.push(url),
    removeStorageSync() {},
  };
  const client = { exports: {} };
  vm.runInNewContext(source('client.js'), { wx, module: client, getApp: () => app });
  function page(name) {
    let instance;
    vm.runInNewContext(source('pages/' + name + '/index.js'), {
      wx, getApp: () => app, require: () => client.exports, Page: p => { instance = p; },
    });
    instance.setData = values => Object.assign(instance.data, values);
    return instance;
  }
  return { page, client: client.exports, app, requests, navigations };
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
    const call = requests.shift();
    assert.equal(new URL(call.url).searchParams.get('q'), q);
    assert.equal(new URL(call.url).searchParams.get('offset'), String(offset));
    call.success({ statusCode: 200, data: { items: [{rowKey:'test-key'}],total:40,offset,limit:20 } });
    await pending;
  }
  await finish(registry.onShow(), '', 0);
  registry.input({ detail: { value: '示例股票' } });
  await finish(registry.search(), '示例股票', 0);
  await finish(registry.next(), '示例股票', 20);
  registry.onHide();
  assert.equal(registry.data.items.length, 0);
  await finish(registry.onShow(), '示例股票', 20);
  registry.onHide();
  app.globalData.token = 'another-sale';
  await finish(registry.onShow(), '', 0);
  assert.equal(registry.data.draft, '');
});

test('原生进度条沿用记录的步骤证据，合同号只附在已确认的签约步骤', async () => {
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
  const signedSteps = [
    { node: 'lead_received', label: '已留资', status: 'reference' },
    { node: signed.node, label: signed.label, status: 'current' },
  ];
  const sales = await load(signed, signedSteps, 'TEST-123');
  assert.deepEqual(sales.steps, signedSteps);
  assert.equal(sales.contractStep, signed.node);
  assert.equal((await load(signed, signedSteps)).contractStep, '');

  const received = { stage: 'intake', node: 'lead_received', label: '已留资' };
  const references = [
    { node: received.node, label: received.label, status: 'current' },
    { node: 'signed', label: '已签约', status: 'reference' },
  ];
  assert.equal((await load(received, references, 'TEST-123')).contractStep, '');
  const older = await load(received, undefined);
  assert.equal(older.steps.length, 1);
  assert.equal(older.steps[0].status, 'current');
  assert.equal((await load(null, [])).steps.length, 0);
});
