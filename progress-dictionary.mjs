// A pair identifies a reported state. Next steps are guidance, never evidence
// that a future step has already happened or that an optional route applies.
const groups = {
  intake: { title: '留资与签约', nodes: {
    lead_received: '已留资', signed: '已签约',
    signed_waiting_filing: '已签约',
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
  closure: { title: '获赔与结案', nodes: { pending_payment: '待支付', payment_received: '赔款已到账', closed: '已结案' } },
};

export function progressNode(stage, node, role) {
  if ((role !== 'investor' && role !== 'sales') || !Object.hasOwn(groups, stage)) return null;
  const { title, nodes } = groups[stage];
  if (!Object.hasOwn(nodes, node)) return null;
  const wording = nodes[node];
  const stageLabel = stage === 'closure' && node === 'pending_payment' ? '获赔' : title;
  return { stage, node, stageLabel, label: typeof wording === 'string' ? wording : wording[role] };
}

// The admin tester chooses the same wording a salesperson sees. The two
// signing codes share one label; use the waiting-for-filing variant when
// explicitly simulating signing, so investors receive their waiting note.
export function progressCatalog() {
  return Object.entries(groups).map(([stage, group]) => ({
    stage, label: group.title,
    nodes: Object.keys(group.nodes).filter(node => stage !== 'intake' || node !== 'signed')
      .map(node => ({ node, label: progressNode(stage, node, 'sales').label })),
  }));
}

const nextNodes = new Map([
  ['intake.lead_received', ['intake', 'signed']],
  ['intake.signed_waiting_filing', ['filing', 'preparing']],
  ['filing.preparing', ['filing', 'submitted']],
  ['filing.supplement', ['filing', 'submitted']],
  ['filing.submitted', ['first_hearing', 'awaiting_hearing']],
  ['first_hearing.awaiting_hearing', ['first_hearing', 'awaiting_judgment']],
  ['first_hearing.awaiting_judgment', ['first_hearing', 'judgment_pending_effective']],
  ['first_hearing.judgment_pending_effective', ['first_hearing', 'judgment_effective']],
  ['first_hearing.judgment_effective', ['enforcement', 'in_progress']],
  ['appeal.awaiting_hearing', ['appeal', 'awaiting_judgment']],
  ['appeal.awaiting_judgment', ['appeal', 'judgment_pending_effective']],
  ['appeal.judgment_pending_effective', ['enforcement', 'in_progress']],
  ['settlement.agreed', ['settlement', 'pending_payment']],
  ['enforcement.in_progress', ['enforcement', 'compensated']],
  ['enforcement.compensated', ['closure', 'pending_payment']],
  ['debt_claim.preparing', ['debt_claim', 'compensated']],
  ['debt_claim.supplement', ['debt_claim', 'compensated']],
  ['closure.pending_payment', ['closure', 'payment_received']],
  ['closure.payment_received', ['closure', 'closed']],
]);

export function progressSteps(current, role, completedNodes = [], nextState = null) {
  // Rebuild from the role dictionary, rather than accepting another role's text.
  const confirmed = current && progressNode(current.stage, current.node, role);
  if (!confirmed) return [];
  const step = { ...confirmed, status: 'current' };
  if (confirmed.node === 'signed_waiting_filing') {
    step.label = '已签约';
    if (role === 'investor') step.note = '待立案';
  }
  if (confirmed.stage === 'closure' && confirmed.node === 'closed') return [step];
  const sourceNext = nextState && progressNode(nextState.stage, nextState.node, role);
  const nextKey = nextNodes.get(`${confirmed.stage}.${confirmed.node}`);
  const next = sourceNext && (sourceNext.stage !== confirmed.stage || sourceNext.node !== confirmed.node)
    ? sourceNext : nextKey ? progressNode(...nextKey, role) : null;
  // Signing keeps its confirmed state. The preparation marker is presentation
  // guidance for this hand-off, not evidence of filing or a new dated event.
  if (confirmed.stage === 'intake' && confirmed.node === 'signed_waiting_filing'
      && next?.stage === 'filing' && next.node === 'preparing') {
    return [step, { ...next, status: 'active' },
      { ...progressNode('filing', 'submitted', role), status: 'next' }];
  }
  return [step, next ? { ...next, status: 'next' }
    : { stage: '', node: 'pending_route', stageLabel: '', label: '后续进度待确认', status: 'next' }];
}
