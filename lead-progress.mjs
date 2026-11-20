import { progressNode } from './progress-dictionary.mjs';
import { classifyCase } from './data-semantics.mjs';
import { compareRecent } from './web/list-order.js';

const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Shanghai' });
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const caseDate = value => validDate(value) ? value : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && validDate(value.slice(0,10))
  && Number.isFinite(Date.parse(value)) ? businessDate.format(new Date(value)) : '';

// The list and progress detail must select the same current case, including
// same-day ties and records without a valid date.
export function currentRelatedCases(rows, currentDay) {
  return rows.map(row => ({...row,openedOn:caseDate(row.openedOn)}))
    .filter(row => !row.openedOn || row.openedOn <= currentDay)
    .sort((a,b) => compareRecent({...a,registeredOn:a.openedOn},{...b,registeredOn:b.openedOn}));
}

const coarseStatuses = new Set(['待受理','已受理','诉讼中','未立案','已立案','已立案未开庭','已开庭','一审待开庭',
  '一审已开庭','二审待开庭','二审已开庭','已判决','已上诉','撤诉','已撤诉','执行中','已结案','终结执行',
  '一审已开庭待判决','已调解待支付','已和解待支付','重整债权已申报','破产债权已申报','重整债权已确认',
  '判决生效待执行','立案退回','已提交调解申请','执行获赔','债权申报获赔','债权申报','案件进度待核对']);
const coarseNodes = new Map([
  ['一审待开庭',['first_hearing','awaiting_hearing']],['二审待开庭',['appeal','awaiting_hearing']],
  ['执行中',['enforcement','in_progress']],['已结案',['closure','closed']],
]);
const advancedStatuses = new Set(['已受理','诉讼中','已立案','已立案未开庭','已开庭','一审待开庭','一审已开庭',
  '二审待开庭','二审已开庭','已判决','已上诉','已结案','执行中','一审已开庭待判决','判决生效待执行','终结执行','执行获赔']);
export const validSigningDate = (value, currentDay) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value && value <= currentDay;

// Customer-level signing has no stock foreign key. It can identify one lead
// only when that lead is the sole candidate as of the actual signing date.
// Read candidates across sales ownership; return only the qualification, never
// another salesperson's records. Keep this cache local to one read transaction.
export function createLeadSigningScope(db) {
  const cache = new Map();
  const hasRegistry = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registry_entries'").get();
  return (row,currentDay) => {
    if (!validSigningDate(row.signedOn,currentDay)) return 'none';
    const registeredOn = caseDate(row.createdAt);
    if (registeredOn && registeredOn > row.signedOn) return 'none';
    if (!registeredOn) return 'ambiguous';
    const key = JSON.stringify([row.clientId,row.signedOn]);
    if (!cache.has(key)) {
      const candidates = db.prepare('SELECT id,createdAt FROM leads WHERE clientId=?').all(row.clientId)
        .map(item => ({id:'lead:'+item.id,date:caseDate(item.createdAt)}));
      if (hasRegistry) {
        for (const item of db.prepare(`SELECT e.entry_key,e.registered_on FROM registry_entries e
          JOIN registry_links link ON link.type='investor' AND link.source_name=e.customer AND link.source_phone=e.phone
          JOIN identities i ON i.id=link.identity_id AND i.role='investor' AND i.subjectId=?`).all(row.clientId)) {
          candidates.push({id:'registry:'+item.entry_key,date:caseDate(item.registered_on)});
        }
      }
      cache.set(key,new Set(candidates.filter(item=>!item.date || item.date<=row.signedOn).map(item=>item.id)));
    }
    const candidates = cache.get(key);
    return candidates.size === 1 && candidates.has('lead:'+row.id) ? 'single' : 'ambiguous';
  };
}
function completion(value) {
  try { const result = Array.isArray(value) ? value : JSON.parse(value || '[]'); return Array.isArray(result) ? result : []; }
  catch { return []; }
}
function resolved(current, sourceStatus = '', completedNodes = [], nextState = null) {
  const classification = current
    ? classifyCase({hasSnapshot:true,progressStage:current.stage,progressNode:current.node})
    : classifyCase({rawStatus:sourceStatus});
  return {current,sourceStatus:current ? '' : sourceStatus,status:current?.label || sourceStatus || '进度待核对',
    caseGroup:classification.caseGroup,completedNodes,nextState:current ? nextState : null};
}

// A present empty snapshot is a deliberate clearing. It must never fall back to
// an older raw state, actual signing, or an associated case.
export function resolveCaseProgress(row, role, currentDay = businessDate.format(new Date())) {
  if (row.hasSnapshot || row.progressStage || row.progressNode) {
    const alreadyFiled = !row.testing && (validSigningDate(row.filedOn,currentDay) || advancedStatuses.has(row.rawStatus));
    const node = row.progressStage === 'intake' && row.progressNode === 'signed_waiting_filing' && alreadyFiled ? 'signed' : row.progressNode;
    const result = resolved(progressNode(row.progressStage,node,role), '', completion(row.completedNodes),
      node === row.progressNode ? progressNode(row.nextStage,row.nextNode,role) : null);
    return {...result,hasFilingEvidence:!!result.current && alreadyFiled};
  }
  const sourceStatus = coarseStatuses.has(row.rawStatus) ? row.rawStatus : '';
  const pair = coarseNodes.get(sourceStatus);
  return resolved(pair ? progressNode(...pair,role) : null, sourceStatus);
}

// Related cases must already be authorized, current, and sorted newest first.
// An actual customer signing is a fallback only when no record/case state exists.
export function resolveLeadProgress(row, related, role, currentDay) {
  let result;
  if (row.hasSnapshot) {
    const advanced = !row.testing && related.some(item => {
      const current = resolveCaseProgress(item,role,currentDay);
      return current.hasFilingEvidence || (current.current ? current.current.stage !== 'intake' : advancedStatuses.has(current.sourceStatus));
    });
    const node = row.progressNode === 'signed_waiting_filing' && advanced ? 'signed' : row.progressNode;
    result = resolveCaseProgress({...row,progressNode:node,
      ...(node !== row.progressNode ? {nextStage:'',nextNode:''} : {})},role,currentDay);
  } else if (related.length) {
    result = resolveCaseProgress(related[0],role,currentDay);
  } else {
    const hasSigning = validSigningDate(row.signedOn,currentDay);
    if (hasSigning && row.signingMatch === 'ambiguous') result = resolved(null,'签约对应记录待核对');
    else result = resolved(progressNode('intake',hasSigning && row.signingMatch === 'single' ? 'signed_waiting_filing' : 'lead_received',role));
  }
  if (result.current?.stage === 'intake' && Number.isFinite(Date.parse(row.createdAt))) {
    result.completedNodes = [...new Set([...result.completedNodes,'lead_received'])];
  }
  return result;
}
