import { createHash } from 'node:crypto';
import { progressCatalog } from './progress-dictionary.mjs';
import { compareRecent } from './web/list-order.js';

const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
const signature = value => Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0,12),16);
const businessDate=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'});
const dateOf=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) && Number.isFinite(Date.parse(value))
  && (value.length!==10 || new Date(value).toISOString().slice(0,10)===value) ? businessDate.format(new Date(value)) : '';
const recordNumber=row=>{
  const prefix={lead:'LZ',case:'AJ',registry:'DJ'}[row.kind];
  return row.recordNumber ? `${prefix}-${String(row.recordNumber).padStart(6,'0')}`
    : `${prefix}-${createHash('sha256').update(row.kind+':'+row.id).digest('hex').slice(0,10).toUpperCase()}`;
};
const emptySnapshot = {stage:'',node:'',contractNumber:'',nextStage:'',nextNode:''};

export function createAdminProgressTest(db,{transaction,requireValue,audit,progress,enabled=false}) {
  db.exec(`CREATE TABLE IF NOT EXISTS admin_progress_test_backup(
    kind TEXT NOT NULL,record_id TEXT NOT NULL,original_snapshot TEXT NOT NULL,
    applied_snapshot TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(kind,record_id)
  )`);
  const one = (sql,...args) => db.prepare(sql).get(...args);
  const all = (sql,...args) => db.prepare(sql).all(...args);
  const tableExists = name => !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",name);
  function authorize(actor) {
    requireValue(enabled,'当前环境未开启进度测试功能',403);
    requireValue(actor?.role==='admin' && !actor.passwordChangeRequired,'只有后台管理员可测试案件进度',403);
  }
  function validateKey(input) {
    requireValue(input && ['lead','case','registry'].includes(input.kind),'记录类型无效');
    requireValue(typeof input.id==='string' && input.id.length>0 && input.id.length<=256,'记录编号无效');
  }
  function rawRecords(kind,id) {
    if(kind==='registry') {
      if(!tableExists('registry_entries')) return [];
      const sourceRow=all('PRAGMA table_info(registry_entries)').some(column=>column.name==='source_row') ? 'e.source_row' : 'NULL';
      return all(`SELECT 'registry' AS kind,registry_public_key(e.entry_key) AS id,e.entry_key AS internalId,
        e.customer,e.phone,e.stock_name AS stockName,e.stock_code AS stockCode,e.stock_name AS title,
        e.sales AS salesName,e.registered_on AS registeredOn,${sourceRow} AS recordNumber,person.name AS displayName FROM registry_entries e
        LEFT JOIN registry_links link ON link.type='investor' AND link.source_name=e.customer AND link.source_phone=e.phone
        LEFT JOIN identities person ON person.id=link.identity_id AND person.role='investor'
        ${id ? 'WHERE registry_public_key(e.entry_key)=?' : ''}`,...(id?[id]:[]));
    }
    const isCase=kind==='case';
    const numbers=tableExists(isCase?'case_numbers':'report_numbers');
    return all(`SELECT '${kind}' AS kind,${isCase?'k.id':'l.id'} AS id,${isCase?'k.id':'l.id'} AS internalId,
      COALESCE(a.contactName,c.name,'') AS customer,COALESCE(a.contactPhone,c.phone,'') AS phone,
      l.stockName,l.stockCode,${isCase?'k.title':'l.stockName'} AS title,COALESCE(s.name,'待分配') AS salesName,
      ${isCase?'k.openedOn':'l.createdAt'} AS registeredOn,${numbers?'n.number':'NULL'} AS recordNumber,person.name AS displayName FROM leads l JOIN clients c ON c.id=l.clientId
      LEFT JOIN identities person ON person.role='investor' AND person.subjectId=c.id
      LEFT JOIN lead_assignments a ON a.leadId=l.id LEFT JOIN sales_staff s ON s.id=a.salesId
      ${isCase?'JOIN cases k ON k.leadId=l.id':''}
      ${numbers ? isCase ? 'LEFT JOIN case_numbers n ON n.caseId=k.id' : "LEFT JOIN report_numbers n ON n.kind='lead' AND n.subjectId=l.id" : ''}
      ${id ? `WHERE ${isCase?'k.id':'l.id'}=?`:''}`,...(id?[id]:[]));
  }
  function record(input) {
    validateKey(input);
    const row=rawRecords(input.kind,input.id)[0];
    requireValue(row,'未找到对应股票或案件',404);
    return row;
  }
  function state(row) {
    const snapshot=one(`SELECT revision,stage,node,contract_number,completed_nodes,next_stage,next_node,testing
      FROM company_record_progress WHERE kind=? AND record_id=?`,row.kind,row.internalId) || null;
    const backup=one('SELECT * FROM admin_progress_test_backup WHERE kind=? AND record_id=?',row.kind,row.internalId);
    const encoded=JSON.stringify(snapshot);
    return {snapshot,backup,encoded,testing:!!snapshot?.testing && backup?.applied_snapshot===encoded,
      revision:signature(JSON.stringify([encoded,backup?.generation || 0]))};
  }
  const publicRow=(row,status)=>({kind:row.kind,id:row.id,customer:row.customer,phone:row.phone,
    stockName:row.stockName,stockCode:row.stockCode,title:row.title,salesName:row.salesName,status,
    registeredOn:dateOf(row.registeredOn),number:recordNumber(row)});
  function readDetail(actor,input) {
    const row=record(input),current=state(row);
    const previews={investor:progress.preview(actor,input,'investor'),sales:progress.preview(actor,input,'sales')};
    const s=current.snapshot;
    return {record:publicRow(row,previews.sales.current?.label || previews.sales.sourceStatus || '进度待核对'),
      revision:current.revision,testing:current.testing,
      snapshot:s ? {stage:s.stage,node:s.node,contractNumber:s.contract_number,nextStage:s.next_stage,nextNode:s.next_node} : {...emptySnapshot},previews};
  }
  function search(actor,input={}) {
    authorize(actor);
    const q=input.q ?? '',requested=input.offset ?? 0;
    requireValue(typeof q==='string' && q.length<=100,'查询内容最多 100 字');
    requireValue(/^\d+$/.test(String(requested)) && Number.isSafeInteger(Number(requested)),'分页参数无效');
    const query=normalize(q),limit=20;
    if(!query) return {items:[],total:0,offset:0,limit};
    return transaction(()=>{
      const rows=['lead','case','registry'].flatMap(kind=>rawRecords(kind)).filter(row=>
        [row.customer,row.displayName,row.phone,row.stockName,row.stockCode,row.title,row.salesName].some(value=>normalize(value).includes(query))).sort(compareRecent);
      const offset=Math.min(Math.floor(Number(requested)/limit),Math.max(0,Math.ceil(rows.length/limit)-1))*limit;
      return {total:rows.length,offset,limit,items:rows.slice(offset,offset+limit).map(row=>{
        const view=progress.preview(actor,row,'sales');
        return publicRow(row,view.current?.label || view.sourceStatus || '进度待核对');
      })};
    },true);
  }
  function detail(actor,input) { authorize(actor); return transaction(()=>readDetail(actor,input),true); }
  function options(actor) { authorize(actor); return {groups:progressCatalog()}; }
  function change(actor,input,restore=false) {
    authorize(actor);
    return transaction(()=>{
      const row=record(input),prior=state(row);
      requireValue(Number.isSafeInteger(input.revision) && input.revision===prior.revision,'记录已更新，请重新打开后再操作',409);
      if(restore) {
        requireValue(prior.testing,'测试状态已被更新或已经恢复，不能覆盖当前进度',409);
        const original=JSON.parse(prior.backup.original_snapshot);
        if(original) {
          progress.applySnapshots([{kind:row.kind,id:row.internalId,revision:prior.snapshot.revision+1,
            stage:original.stage,node:original.node,contractNumber:original.contract_number,
            completedNodes:JSON.parse(original.completed_nodes),nextStage:original.next_stage,nextNode:original.next_node}]);
          db.prepare('UPDATE company_record_progress SET revision=? WHERE kind=? AND record_id=?').run(original.revision,row.kind,row.internalId);
        } else db.prepare('DELETE FROM company_record_progress WHERE kind=? AND record_id=?').run(row.kind,row.internalId);
        db.prepare("UPDATE admin_progress_test_backup SET applied_snapshot='',generation=generation+1 WHERE kind=? AND record_id=?").run(row.kind,row.internalId);
        audit(actor,'恢复案件进度测试',row.kind+':'+row.id);
      } else {
        const allowed=progressCatalog().some(group=>group.stage===input.stage && group.nodes.some(node=>node.node===input.node));
        requireValue(allowed,'请选择有效的销售端进度词条');
        progress.applySnapshots([{kind:row.kind,id:row.internalId,revision:(prior.snapshot?.revision || 0)+1,
          stage:input.stage,node:input.node,contractNumber:input.contractNumber ?? '',nextStage:input.nextStage ?? '',nextNode:input.nextNode ?? ''}]);
        // Test transitions never consume the company's source revision. The
        // independent generation below protects admin forms from stale writes.
        db.prepare('UPDATE company_record_progress SET testing=1,revision=? WHERE kind=? AND record_id=?').run(prior.snapshot?.revision || 0,row.kind,row.internalId);
        const applied=state(row).encoded;
        db.prepare(`INSERT INTO admin_progress_test_backup VALUES(?,?,?,?,?) ON CONFLICT(kind,record_id) DO UPDATE SET
          original_snapshot=excluded.original_snapshot,applied_snapshot=excluded.applied_snapshot,generation=excluded.generation`)
          .run(row.kind,row.internalId,prior.testing ? prior.backup.original_snapshot : prior.encoded,applied,(prior.backup?.generation || 0)+1);
        audit(actor,'修改案件进度测试',row.kind+':'+row.id,{stage:input.stage,node:input.node});
      }
      return readDetail(actor,input);
    });
  }
  return {options,search,detail,save:(actor,input)=>change(actor,input),restore:(actor,input)=>change(actor,input,true)};
}
