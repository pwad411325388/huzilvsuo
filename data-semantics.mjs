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
