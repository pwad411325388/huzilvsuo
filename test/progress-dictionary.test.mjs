import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressNode, progressSteps, progressCatalog } from '../progress-dictionary.mjs';

test('同一阶段与节点按股民、销售角色显示，重复节点名称保留各自阶段', () => {
  for (const [stage, node, investor, sales = investor] of [
    ['intake', 'lead_received', '已留资'], ['intake', 'signed', '已签约'],
    ['intake', 'signed_waiting_filing', '已签约'],
    ['filing', 'preparing', '立案材料准备中'], ['filing', 'submitted', '已提交立案'],
    ['filing', 'supplement', '待您补充材料', '待补充材料'],
    ['first_hearing', 'awaiting_hearing', '一审待开庭'], ['first_hearing', 'awaiting_judgment', '等待判决结果'],
    ['first_hearing', 'judgment_pending_effective', '判决待生效'], ['first_hearing', 'judgment_effective', '判决已生效'],
    ['appeal', 'awaiting_hearing', '二审上诉待开庭'], ['appeal', 'awaiting_judgment', '等待判决结果'],
    ['appeal', 'judgment_pending_effective', '判决待生效'], ['appeal', 'remanded', '案件已发回重审'],
    ['settlement', 'agreed', '已达成调解或和解'], ['settlement', 'pending_payment', '已调解待支付'],
    ['enforcement', 'in_progress', '执行中'], ['enforcement', 'compensated', '获赔'],
    ['debt_claim', 'preparing', '准备中'], ['debt_claim', 'supplement', '待补充材料'], ['debt_claim', 'compensated', '获赔'],
    ['closure', 'pending_payment', '待支付'], ['closure', 'payment_received', '赔款已到账'], ['closure', 'closed', '已结案'],
  ]) {
    assert.equal(progressNode(stage, node, 'investor').label, investor);
    assert.equal(progressNode(stage, node, 'sales').label, sales);
  }
  assert.notEqual(progressNode('first_hearing','awaiting_judgment','sales').stageLabel, progressNode('appeal','awaiting_judgment','sales').stageLabel);
  for (const args of [['appeal','judgment_effective','sales'], ['unknown','closed','investor'], ['__proto__','closed','investor'],
    ['appeal','toString','sales'], ['closure','closed','broker']]) assert.equal(progressNode(...args), null);
});

test('后台可选词条与销售八阶段字典一致，签约不出现两个同名选项', () => {
  const catalog = progressCatalog();
  assert.deepEqual(catalog.map(group=>group.label), ['留资与签约','立案','一审','上诉与二审','调解与和解','执行','债权申报','获赔与结案']);
  assert.equal(catalog.reduce((count,group)=>count+group.nodes.length,0),23);
  for(const group of catalog) {
    assert.equal(new Set(group.nodes.map(item=>item.node)).size,group.nodes.length);
    for(const item of group.nodes) assert.equal(item.label,progressNode(group.stage,item.node,'sales').label);
  }
  assert.deepEqual(catalog[0].nodes,[{node:'lead_received',label:'已留资'},{node:'signed_waiting_filing',label:'已签约'}]);
  assert.equal(catalog[1].nodes.find(item=>item.node==='supplement').label,'待补充材料');
  catalog[0].nodes[0].label='changed';
  assert.equal(progressCatalog()[0].nodes[0].label,'已留资');
});

test('除签约待立案外各流程仍展示当前和下一节点，不展开完成记录或可选分支', () => {
  const expected = [
    ['intake','lead_received','intake','signed'],
    ['intake','signed','','pending_route'],
    ['filing','preparing','filing','submitted'],
    ['filing','supplement','filing','submitted'],
    ['filing','submitted','first_hearing','awaiting_hearing'],
    ['first_hearing','awaiting_hearing','first_hearing','awaiting_judgment'],
    ['first_hearing','awaiting_judgment','first_hearing','judgment_pending_effective'],
    ['first_hearing','judgment_pending_effective','first_hearing','judgment_effective'],
    ['first_hearing','judgment_effective','enforcement','in_progress'],
    ['appeal','awaiting_hearing','appeal','awaiting_judgment'],
    ['appeal','awaiting_judgment','appeal','judgment_pending_effective'],
    ['appeal','judgment_pending_effective','enforcement','in_progress'],
    ['appeal','remanded','','pending_route'],
    ['settlement','agreed','settlement','pending_payment'],
    ['settlement','pending_payment','','pending_route'],
    ['enforcement','in_progress','enforcement','compensated'],
    ['enforcement','compensated','closure','pending_payment'],
    ['debt_claim','preparing','debt_claim','compensated'],
    ['debt_claim','supplement','debt_claim','compensated'],
    ['debt_claim','compensated','','pending_route'],
    ['closure','pending_payment','closure','payment_received'],
    ['closure','payment_received','closure','closed'],
  ];
  for (const role of ['investor','sales']) for (const [stage,node,nextStage,nextNode] of expected) {
    const result = progressSteps(progressNode(stage,node,role),role,['preparing','submitted','payment_received']);
    assert.deepEqual(result.map(s => [s.stage,s.node,s.status]), [
      [stage,node,'current'],[nextStage,nextNode,'next'],
    ]);
    if (!nextStage) assert.equal(result[1].label,'后续进度待确认');
  }
  for (const role of ['investor','sales']) {
    assert.deepEqual(progressSteps(progressNode('closure','closed',role),role,['payment_received'])
      .map(s => [s.node,s.status]),[['closed','current']]);
  }
  assert.deepEqual(progressSteps(null,'investor'),[]);
  assert.deepEqual(progressSteps({stage:'missing',node:'missing'},'sales'),[]);
});

test('签约旁注、补料及同名节点使用角色文案，明确下一路线只作未来步骤', () => {
  const waiting = progressNode('intake','signed_waiting_filing','investor');
  const investor = progressSteps(waiting,'investor');
  assert.equal(investor[0].label,'已签约');
  assert.equal(investor[0].note,'待立案');
  assert.equal(investor[1].label,'立案材料准备中');
  const sales = progressSteps(waiting,'sales');
  assert.equal(sales[0].label,'已签约');
  assert.equal(sales[0].note,undefined);
  for (const role of ['investor','sales']) {
    const signing = progressSteps(waiting,role);
    assert.deepEqual(signing.map(step=>[step.stage,step.node,step.status]),[
      ['intake','signed_waiting_filing','current'],['filing','preparing','active'],['filing','submitted','next'],
    ]);
    assert.equal(signing[2].stageLabel,'立案');
    assert.equal(signing[2].label,'已提交立案');
    assert.ok(signing.every(step=>step.date === undefined));
    const alternate = progressSteps(waiting,role,[],{stage:'filing',node:'supplement'});
    assert.deepEqual(alternate.map(step=>[step.node,step.status]),[['signed_waiting_filing','current'],['supplement','next']]);
    assert.equal(progressSteps(progressNode('filing','supplement',role),role)[0].label,
      role === 'investor' ? '待您补充材料' : '待补充材料');
    assert.equal(progressSteps(progressNode('debt_claim','supplement',role),role)[0].label,'待补充材料');
    const result = progressSteps(progressNode('first_hearing','judgment_effective',role),role,[],
      {stage:'appeal',node:'awaiting_hearing'});
    assert.deepEqual(result.map(s=>s.label),['判决已生效','二审上诉待开庭']);
    assert.equal(result[1].status,'next');
    assert.equal(result[1].stageLabel,'上诉与二审');
    // A source can report a non-default supplement route, but cannot inject role text.
    const supplement = progressSteps(progressNode('filing','preparing',role),role,[],
      {stage:'filing',node:'supplement',label:'wrong role label'});
    assert.equal(supplement[1].label,role === 'investor' ? '待您补充材料' : '待补充材料');
    assert.equal(progressSteps(progressNode('closure','closed',role),role,[],
      {stage:'enforcement',node:'in_progress'}).length,1);
  }
});

test('执行获赔预告获赔待支付，实际待支付才预告到账，其他获赔路线保持原口径', () => {
  for (const role of ['investor','sales']) {
    const earned = progressSteps(progressNode('enforcement','compensated',role),role);
    assert.deepEqual(earned.map(step=>[step.stageLabel,step.label,step.status]),
      [['执行','获赔','current'],['获赔','待支付','next']]);
    const pending = progressSteps(progressNode('closure','pending_payment',role),role);
    assert.deepEqual(pending.map(step=>[step.stageLabel,step.label,step.status]),
      [['获赔','待支付','current'],['获赔与结案','赔款已到账','next']]);
    assert.ok([...earned,...pending].every(step=>step.date===undefined));
    assert.equal(progressSteps(progressNode('debt_claim','compensated',role),role)[1].node,'pending_route');
    const explicit = progressSteps(progressNode('enforcement','compensated',role),role,[],{stage:'closure',node:'payment_received'});
    assert.deepEqual(explicit.map(step=>[step.node,step.status]),[['compensated','current'],['payment_received','next']]);
  }
});
