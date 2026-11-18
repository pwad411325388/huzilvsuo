// A pair identifies a reported state. Order within a stage is for display only.
const groups = {
  intake: { title: '留资与签约', nodes: {
    lead_received: '已留资', signed: '已签约',
    signed_waiting_filing: { investor: '已签约 待立案', sales: '已签约' },
  } },
  filing: { title: '立案', nodes: {
    preparing: '立案材料准备中',
    supplement: { investor: '待您补充材料', sales: '待补充材料' },
    submitted: '已提交立案',
  } },
  first_hearing: { title: '一审', nodes: {
    awaiting_hearing: '一审待开庭', awaiting_judgment: '等待判决结果',
    judgment_pending_effective: '判决待生效', judgment_effective: '判决已生效',
  } },
  appeal: { title: '上诉与二审', nodes: {
    awaiting_hearing: '二审上诉待开庭', awaiting_judgment: '等待判决结果',
    judgment_pending_effective: '判决待生效', remanded: '案件已发回重审',
  } },
  settlement: { title: '调解与和解', nodes: { agreed: '已达成调解或和解', pending_payment: '已调解待支付' } },
  enforcement: { title: '执行', nodes: { in_progress: '执行中', compensated: '获赔' } },
  debt_claim: { title: '债权申报', nodes: { preparing: '准备中', supplement: '待补充材料', compensated: '获赔' } },
  closure: { title: '获赔与结案', nodes: { payment_received: '赔款已到账', closed: '已结案' } },
};

export function progressNode(stage, node, role) {
  if ((role !== 'investor' && role !== 'sales') || !Object.hasOwn(groups, stage)) return null;
  const { title, nodes } = groups[stage];
  if (!Object.hasOwn(nodes, node)) return null;
  const wording = nodes[node];
  return { stage, node, stageLabel: title, label: typeof wording === 'string' ? wording : wording[role] };
}

export function progressSteps(current, role, completedNodes = []) {
  if (!current) return [];
  const { stage, node } = current;
  let nodes = Object.keys(groups[stage].nodes);
  const completed = new Set(completedNodes);
  if (stage === 'intake') {
    // Signing and signing while awaiting filing occupy one position.
    nodes = ['lead_received', node === 'signed_waiting_filing' ? node : 'signed'];
    if (completed.has('signed_waiting_filing')) completed.add('signed');
  }
  if (stage === 'appeal' && node === 'remanded' && !completed.has('judgment_pending_effective')) {
    nodes = nodes.filter(code => code !== 'judgment_pending_effective');
  }
  if (stage === 'filing' && node === 'supplement' && completed.has('submitted')) {
    nodes = ['preparing', 'submitted', 'supplement'];
  }
  return nodes.filter(code =>
    !['supplement', 'remanded'].includes(code) || code === node || completed.has(code)
  ).map(code => ({
    node: code,
    label: progressNode(stage, code, role).label,
    status: code === node ? 'current' : completed.has(code) ? 'completed' : 'reference',
  }));
}
