import { progressNode } from './progress-dictionary.mjs';
import { compareRecent, orderLabels } from './web/list-order.js';

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
const established = new Set(['已受理','诉讼中','已立案','已立案未开庭','已开庭','一审待开庭','一审已开庭',
  '二审待开庭','二审已开庭','已判决','已上诉','执行中','判决生效待执行','一审已开庭待判决',
  '已结案','撤诉','已撤诉','终结执行','执行获赔']);
const caseStages = new Set(['first_hearing','appeal','enforcement','closure']);
const needsMaterial = current => current?.node === 'supplement' && ['filing','debt_claim'].includes(current.stage);
const countingNote = '按具体案件及未建案留资逐项统计：同一留资有多个案件时分别计案，不再重复计父留资。尚无独立案件的股票记录，当前明确进入一审、二审、执行或获赔结案阶段时计为一件展示案件；仅预告下一步不计案。明确授权的登记按已有建案证据计案，其余单列待核对；不凭同名或同股票合并记录。';

export function createInvestorHome(db,{userRecords,transaction,requireValue,today}) {
  const authorize = actor => requireValue(actor?.role === 'investor' && !actor.passwordChangeRequired,'当前账号无权查看股民首页记录',403);
  function originalTestingSnapshots(actor,rows) {
    if (!rows.some(row=>row.homeProgress?.registry?.testing)) return new Map();
    const originals = new Map();
    const values = db.prepare(`SELECT p.record_id,p.revision,p.stage,p.node,p.contract_number,p.completed_nodes,p.next_stage,p.next_node,p.testing,
      b.original_snapshot,b.applied_snapshot FROM company_record_progress p
      JOIN admin_progress_test_backup b ON b.kind=p.kind AND b.record_id=p.record_id
      JOIN registry_entries e ON e.entry_key=p.record_id
      JOIN registry_links l ON l.type='investor' AND l.source_name=e.customer AND l.source_phone=e.phone
      JOIN identities i ON i.id=l.identity_id AND i.role='investor' AND i.status='active' AND i.subjectId=?
      WHERE p.kind='registry' AND p.testing=1`).all(actor.id);
    for (const value of values) {
      const {record_id,original_snapshot,applied_snapshot,...snapshot} = value;
      if (JSON.stringify(snapshot) !== applied_snapshot) continue;
      try { originals.set(record_id,JSON.parse(original_snapshot)); } catch { /* An invalid backup is not evidence. */ }
    }
    return originals;
  }
  function establishedRegistry(source,originals,currentDay) {
    if (validDate(source.filedOn) && source.filedOn <= currentDay || established.has(source.rawStatus)) return true;
    const original = originals.get(source.entryKey);
    const official = source.testing
      ? original === null ? {stage:source.sourceStage,node:source.sourceNode} : original
      : source;
    const node = official && progressNode(official.stage,official.node,'investor');
    return !!node && caseStages.has(node.stage);
  }
  function read(actor) {
    authorize(actor);
    const rows = userRecords.homeRows(actor), originals = originalTestingSnapshots(actor,rows), currentDay=today();
    const items=new Map(), attentions=new Map();
    let caseCount=0,leadCount=0,unclassifiedCount=0;
    const item = (row,kind=row.kind,progressId=row.progressId,record=row) => ({
      id:kind+':'+progressId,kind,progressId,stockName:row.stockName,stockCode:row.stockCode,
      title:record.title || row.stockName,status:record.status,
      ...(kind === 'case' && record.title ? {caseTitle:record.title} : {}),
      registeredOn:validDate(record.registeredOn) ? record.registeredOn : '',
    });
    const add=(record,category)=>{
      if (items.has(record.id)) return;
      items.set(record.id,record);
      if(category==='case') caseCount++;
      else if(category==='lead') leadCount++;
      else unclassifiedCount++;
    };
    for(const row of rows) {
      const own=item(row),state=row.homeProgress;
      if(row.kind==='lead' && row.cases.length) {
        const states=new Map((state?.cases || []).map(record=>[record.id,record.current]));
        for(const record of row.cases) {
          const entry=item(row,'case',record.id,{...record,registeredOn:record.openedOn});
          add(entry,'case');
          if(needsMaterial(states.get(record.id))) attentions.set(entry.id,entry);
        }
        // A lead's own instruction is a separate actionable target. An inherited
        // instruction is already represented by its case above.
        if(state?.hasOwnSnapshot && needsMaterial(state.current)) attentions.set(own.id,own);
      } else {
        // A stock record can carry its own case progress before a separate case
        // row is created. Count its displayed current state, never a next step;
        // keep the lead identity so details and later case creation don't duplicate it.
        const category = row.kind==='lead'
          ? state?.hasOwnSnapshot && caseStages.has(state.current?.stage) ? 'case' : 'lead'
          : establishedRegistry(state.registry,originals,currentDay) ? 'case' : 'unclassified';
        add(own,category);
        if(needsMaterial(state?.current)) attentions.set(own.id,own);
      }
    }
    const records=[...items.values()].sort(compareRecent), attention=[...attentions.values()].sort(compareRecent);
    return {records,summary:{totalRecords:records.length,caseCount,leadCount,unclassifiedCount,countingNote,
      attentionCount:attention.length,attention:attention[0] || null,recent:records.slice(0,2)}};
  }
  const summary=actor=>transaction(()=>read(actor).summary,true);
  const records=(actor,input={})=>{
    authorize(actor);
    const selected=userRecords.criteria(input);
    requireValue(selected.ledger==='all' && !selected.customerId,'首页记录不支持该筛选条件');
    return transaction(()=>{
      const all=read(actor).records;
      const ranged=all.filter(row=>row.registeredOn ? row.registeredOn<=selected.to && (!selected.from || row.registeredOn>=selected.from) : selected.period==='all');
      const q=normalize(selected.q);
      const matches=q ? ranged.filter(row=>[row.stockName,row.stockCode,row.title].some(value=>normalize(value).includes(q))) : ranged;
      const offset=Math.min(Math.floor(selected.offset/selected.limit),Math.max(0,Math.ceil(matches.length/selected.limit)-1))*selected.limit;
      return {...selected,presentation:'home',offset,total:matches.length,unfilteredTotal:ranged.length,customerCount:matches.length ? 1 : 0,
        orderLabel:orderLabels.recent,items:matches.slice(offset,offset+selected.limit)};
    },true);
  };
  return {summary,records};
}
