import { progressNode } from './progress-dictionary.mjs';

const ongoingStatuses = new Set(['已受理', '诉讼中', '已立案', '已立案未开庭', '已开庭', '一审待开庭', '一审已开庭',
  '二审待开庭', '二审已开庭', '已判决', '已上诉', '执行中', '重整债权已申报', '破产债权已申报',
  '重整债权已确认', '判决生效待执行', '已提交调解申请', '已调解待支付', '已和解待支付']);
const otherStatuses = new Set(['未立案', '待受理', '立案退回', '撤诉', '已撤诉', '终结执行']);
const ongoingStages = new Set(['first_hearing', 'appeal', 'settlement', 'enforcement', 'debt_claim']);

export function hasSigningEvidence(row) {
  if (row.progressStage !== 'intake') return false;
  if (['signed', 'signed_waiting_filing'].includes(row.progressNode)) return true;
  try { return JSON.parse(row.completedNodes || '[]').some(node => ['signed', 'signed_waiting_filing'].includes(node)); }
  catch { return false; }
}

// Confirmed business rule for imported registrations (2026-11-20): a filed
// case or a later confirmed phase counts as signed, without inventing a signing
// date. This rule does not turn ordinary system leads into signed customers.
const filedStatuses = new Set(['已受理', '诉讼中', '已立案', '已立案未开庭', '已开庭', '一审待开庭',
  '一审已开庭', '一审已开庭待判决', '一审等待判决结果', '一审判决待生效', '一审判决已生效',
  '二审待开庭', '二审上诉待开庭', '二审已开庭', '二审已开庭待判决', '二审等待判决结果',
  '二审判决待生效', '案件已发回重审', '二审发回重审', '已判决', '已上诉', '执行中',
  '判决生效待执行', '终结执行', '执行获赔', '已结案']);
const beforeFilingStatuses = new Set(['未立案', '立案退回', '待受理', '未签约', '已留资',
  '立案材料准备中', '立案待补充材料', '已提交立案']);
const filingContextStatuses = new Set(['撤诉', '已撤诉', '已提交调解申请', '已调解待支付', '已和解待支付',
  '已达成调解或和解', '债权申报', '重整债权已申报', '破产债权已申报', '重整债权已确认']);
const filedStages = new Set(['first_hearing', 'appeal', 'enforcement', 'closure']);

function historicalFiledDate(row, currentDay) {
  const day = row.filedOn;
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= currentDay &&
    Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}

export function hasRegistrySigningEvidence(row, currentDay) {
  if (hasSigningEvidence(row)) return true;
  const current = progressNode(row.progressStage, row.progressNode, 'sales');
  // An authoritative correction/clear must not resurrect old source facts.
  const status = row.rawStatus || row.status || '';
  if (row.hasSnapshot) {
    if (!current) return false;
    if (filedStages.has(current.stage)) return true;
    // Settlement and debt-claim routes can start without a filed lawsuit. Keep
    // a proven prior filing, but never infer one merely from these phase names.
    return ['settlement', 'debt_claim'].includes(current.stage) && !beforeFilingStatuses.has(status) &&
      (filedStatuses.has(status) || filingContextStatuses.has(status) && historicalFiledDate(row, currentDay));
  }
  if (beforeFilingStatuses.has(status)) return false;
  if (current && filedStages.has(current.stage)) return true;
  if (filedStatuses.has(status)) return true;
  // Empty/ambiguous source progress can conceal a returned filing; its date
  // alone must never establish that the lawsuit was accepted.
  return filingContextStatuses.has(status) && historicalFiledDate(row, currentDay);
}

export function classifyCase(row, role = 'sales') {
  const current = progressNode(row.progressStage, row.progressNode, role);
  if (row.hasSnapshot || row.progressStage || row.progressNode) {
    if (!current) return { caseGroup: 'unknown', caseStatus: '进度待核对' };
    return { caseGroup: current.stage === 'closure' && current.node === 'closed' ? 'closed'
      : ongoingStages.has(current.stage) ? 'ongoing' : 'other', caseStatus: current.label };
  }
  const status = row.rawStatus || '';
  return { caseGroup: status === '已结案' ? 'closed' : ongoingStatuses.has(status) ? 'ongoing'
    : otherStatuses.has(status) ? 'other' : 'unknown', caseStatus: status || '进度待核对' };
}
