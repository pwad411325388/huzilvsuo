import { progressNode, progressSteps } from './progress-dictionary.mjs';

const notice = '当前资料尚未明确具体阶段，请以律所确认结果为准。';
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

// Display-only projections. These never become authoritative progress, case
// classifications, signing evidence, or persisted company snapshots.
const precise = new Map([
  ['已留资', ['intake', 'lead_received']], ['已签约', ['intake', 'signed']],
  ['已签约待立案', ['intake', 'signed_waiting_filing']],
  ['立案材料准备中', ['filing', 'preparing']], ['已提交立案', ['filing', 'submitted']],
  ['立案待补充材料', ['filing', 'supplement']],
  ['一审待开庭', ['first_hearing', 'awaiting_hearing']],
  ['一审已开庭待判决', ['first_hearing', 'awaiting_judgment']], ['一审等待判决结果', ['first_hearing', 'awaiting_judgment']],
  ['一审判决待生效', ['first_hearing', 'judgment_pending_effective']], ['一审判决已生效', ['first_hearing', 'judgment_effective']],
  ['二审待开庭', ['appeal', 'awaiting_hearing']], ['二审上诉待开庭', ['appeal', 'awaiting_hearing']],
  ['二审已开庭待判决', ['appeal', 'awaiting_judgment']], ['二审等待判决结果', ['appeal', 'awaiting_judgment']],
  ['二审判决待生效', ['appeal', 'judgment_pending_effective']],
  ['案件已发回重审', ['appeal', 'remanded']], ['二审发回重审', ['appeal', 'remanded']],
  ['已达成调解或和解', ['settlement', 'agreed']],
  ['已调解待支付', ['settlement', 'pending_payment']], ['已和解待支付', ['settlement', 'pending_payment']],
  ['执行中', ['enforcement', 'in_progress']], ['执行获赔', ['enforcement', 'compensated']],
  ['债权申报准备中', ['debt_claim', 'preparing']], ['债权申报待补充材料', ['debt_claim', 'supplement']],
  ['债权申报获赔', ['debt_claim', 'compensated']], ['赔款已到账', ['closure', 'payment_received']],
  ['已结案', ['closure', 'closed']],
]);

const next = (stage, stageLabel, label, node = 'display_next') => ({ stage, node, stageLabel, label, status: 'next' });
const pending = label => next('', '后续进度', label || '待确认', 'pending_route');
const coarse = new Map([
  ['已立案未开庭', ['filing', '立案', next('hearing', '开庭', '待开庭'), '审级待核对']],
  ['已立案', ['filing', '立案', pending()]],
  ['未立案', ['filing', '立案', next('filing', '立案', '立案材料准备中')]],
  ['待受理', ['filing', '立案', pending('受理结果待确认')]],
  ['已受理', ['filing', '立案', pending()]],
  ['诉讼中', ['litigation', '诉讼', pending()]],
  ['已开庭', ['hearing', '开庭', pending()]],
  ['一审已开庭', ['first_hearing', '一审', pending()]],
  ['二审已开庭', ['appeal', '上诉与二审', pending()]],
  ['已判决', ['judgment', '判决', pending()]],
  ['已上诉', ['appeal', '上诉与二审', pending()]],
  ['判决生效待执行', ['judgment', '判决', next('enforcement', '执行', '执行中')]],
  ['重整债权已申报', ['debt_claim', '债权申报', pending('申报结果待确认')]],
  ['破产债权已申报', ['debt_claim', '债权申报', pending('申报结果待确认')]],
  ['重整债权已确认', ['debt_claim', '债权申报', pending()]],
  ['债权申报', ['debt_claim', '债权申报', pending()]],
  ['立案退回', ['filing', '立案', pending('后续处理待确认')]],
  ['撤诉', ['litigation', '诉讼', null]], ['已撤诉', ['litigation', '诉讼', null]],
  ['终结执行', ['enforcement', '执行', null]],
  ['已提交调解申请', ['settlement', '调解与和解', pending('调解结果待确认')]],
]);

function unknown() {
  const current = { stage: 'unknown', node: 'unknown', stageLabel: '案件进度', label: '待核对', uncertain: true };
  return { current, steps: [{ ...current, status: 'current', hideDate: true }], notice };
}

export function projectProgressDisplay(row, { role, kind, currentDay }) {
  // A cleared snapshot or invalid structured state must not revive older text.
  if (!['investor', 'sales'].includes(role) || row.hasSnapshot || row.progressStage || row.progressNode) return unknown();
  const label = row.rawStatus;
  let current, steps;
  if (precise.has(label)) {
    current = progressNode(...precise.get(label), role);
    steps = progressSteps(current, role).map(step => step.node === 'pending_route'
      ? { ...step, stageLabel: '后续进度', label: '待确认' } : step);
    // Keep reported distinctions such as 和解/调解. Role-specific filing and
    // signing wording still follows the shared dictionary.
    if (!['已签约待立案', '立案待补充材料', '债权申报待补充材料'].includes(label)) {
      current = { ...current, label };
      steps[0] = { ...steps[0], label };
    }
  } else if (coarse.has(label)) {
    const [stage, stageLabel, following, note] = coarse.get(label);
    current = { stage, node: 'reported_state', stageLabel, label, ...(note ? { note } : {}) };
    steps = [{ ...current, status: 'current' }, ...(following ? [{ ...following }] : [])];
  } else return unknown();
  if (kind === 'registry' && !row.testing && ['已立案', '已立案未开庭'].includes(label)
      && validDay(row.filedOn) && row.filedOn <= currentDay) {
    Object.assign(steps[0], { date: row.filedOn, dateLabel: '立案日期' });
  }
  return { current, steps };
}
