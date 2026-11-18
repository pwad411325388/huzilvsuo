import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressNode, progressSteps } from '../progress-dictionary.mjs';

test('同一阶段与节点按股民、销售角色显示，重复节点名称保留各自阶段', () => {
  for (const [stage, node, investor, sales = investor] of [
    ['intake', 'lead_received', '已留资'], ['intake', 'signed', '已签约'],
    ['intake', 'signed_waiting_filing', '已签约 待立案', '已签约'],
    ['filing', 'preparing', '立案材料准备中'], ['filing', 'submitted', '已提交立案'],
    ['filing', 'supplement', '待您补充材料', '待补充材料'],
    ['first_hearing', 'awaiting_hearing', '一审待开庭'], ['first_hearing', 'awaiting_judgment', '等待判决结果'],
    ['first_hearing', 'judgment_pending_effective', '判决待生效'], ['first_hearing', 'judgment_effective', '判决已生效'],
    ['appeal', 'awaiting_hearing', '二审上诉待开庭'], ['appeal', 'awaiting_judgment', '等待判决结果'],
    ['appeal', 'judgment_pending_effective', '判决待生效'], ['appeal', 'remanded', '案件已发回重审'],
    ['settlement', 'agreed', '已达成调解或和解'], ['settlement', 'pending_payment', '已调解待支付'],
    ['enforcement', 'in_progress', '执行中'], ['enforcement', 'compensated', '获赔'],
    ['debt_claim', 'preparing', '准备中'], ['debt_claim', 'supplement', '待补充材料'], ['debt_claim', 'compensated', '获赔'],
    ['closure', 'payment_received', '赔款已到账'], ['closure', 'closed', '已结案'],
  ]) {
    assert.equal(progressNode(stage, node, 'investor').label, investor);
    assert.equal(progressNode(stage, node, 'sales').label, sales);
  }
  assert.notEqual(progressNode('first_hearing','awaiting_judgment','sales').stageLabel, progressNode('appeal','awaiting_judgment','sales').stageLabel);
  for (const args of [['appeal','judgment_effective','sales'], ['unknown','closed','investor'], ['__proto__','closed','investor'],
    ['appeal','toString','sales'], ['closure','closed','broker']]) assert.equal(progressNode(...args), null);
});

test('进度条仅展示适用阶段和有依据的条件步骤，顺序本身不产生完成记录', () => {
  const steps = (stage,node,role = 'investor',history = []) =>
    progressSteps(progressNode(stage,node,role),role,history);
  assert.deepEqual(steps('closure','closed').map(step => step.status), ['reference','current']);
  assert.deepEqual(steps('closure','closed','sales',['payment_received']).map(step => step.status), ['completed','current']);
  assert.deepEqual(steps('filing','preparing').map(step => step.node), ['preparing','submitted']);
  assert.deepEqual(steps('filing','supplement').map(step => step.label), ['立案材料准备中','待您补充材料','已提交立案']);
  assert.deepEqual(steps('filing','supplement','sales',['submitted']).map(step => [step.label,step.status]), [
    ['立案材料准备中','reference'],['已提交立案','completed'],['待补充材料','current'],
  ]);
  assert.deepEqual(steps('debt_claim','supplement').map(step => step.label), ['准备中','待补充材料','获赔']);
  assert.ok(!steps('debt_claim','compensated').some(step => step.node === 'supplement'));
  assert.ok(steps('debt_claim','compensated','sales',['supplement']).some(step => step.node === 'supplement' && step.status === 'completed'));
  assert.ok(!steps('appeal','awaiting_hearing').some(step => step.node === 'remanded'));
  assert.deepEqual(steps('appeal','remanded').map(step => step.node), ['awaiting_hearing','awaiting_judgment','remanded']);
  assert.deepEqual(steps('intake','signed_waiting_filing').map(step => step.label), ['已留资','已签约 待立案']);
  assert.deepEqual(steps('intake','signed_waiting_filing','sales',['signed']).map(step => step.status), ['reference','current']);
  assert.deepEqual(steps('intake','lead_received').map(step => step.label), ['已留资','已签约']);
  assert.deepEqual(steps('missing','missing'), []);
});
