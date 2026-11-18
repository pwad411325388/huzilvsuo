import { progressNode, progressSteps } from './progress-dictionary.mjs';

const records = { lead: 'leads', case: 'cases', registry: 'registry_entries' };
const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
// Legacy data contains a broad status, sometimes only a filing flag. A broad
// status can be shown verbatim without claiming a more precise procedural step.
const sourceStatuses = new Set(['待受理','已受理','诉讼中','未立案','已立案','已立案未开庭','已开庭','一审待开庭',
  '一审已开庭','二审待开庭','二审已开庭','已判决','已上诉','撤诉','已撤诉','执行中','已结案','终结执行',
  '一审已开庭待判决','已调解待支付','已和解待支付','重整债权已申报','破产债权已申报','重整债权已确认',
  '判决生效待执行','立案退回','已提交调解申请','执行获赔','债权申报获赔','债权申报','案件进度待核对']);
const legacyNodes = new Map([
  ['一审待开庭', ['first_hearing','awaiting_hearing']], ['二审待开庭', ['appeal','awaiting_hearing']],
  ['执行中', ['enforcement','in_progress']], ['已结案', ['closure','closed']],
]);

export function createCaseProgress(db, { transaction, requireValue, registry, caseCutoff }) {
  transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS company_record_progress (
      kind TEXT NOT NULL CHECK(kind IN ('lead','case','registry')), record_id TEXT NOT NULL,
      revision INTEGER NOT NULL, stage TEXT NOT NULL, node TEXT NOT NULL, contract_number TEXT NOT NULL,
      completed_nodes TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(kind,record_id)
    )`);
    const columns = db.prepare('PRAGMA table_info(company_record_progress)').all();
    if (!columns.some(column => column.name === 'completed_nodes')) {
      db.exec("ALTER TABLE company_record_progress ADD COLUMN completed_nodes TEXT NOT NULL DEFAULT '[]'");
    }
  });
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  function checkKey(kind, id) {
    requireValue(typeof kind === 'string' && Object.hasOwn(records, kind), '记录类型无效');
    requireValue(typeof id === 'string' && id.length > 0 && id.length <= 256, '记录编号无效');
  }

  // Used only by the trusted company-data import, with internal source keys.
  // Revision and full-snapshot comparison avoid stale or ambiguous overwrites.
  function sync(items) {
    requireValue(Array.isArray(items), '同步数据应为记录数组');
    return transaction(() => {
      const result = { updated: 0, unchanged: 0 };
      for (const item of items) {
        requireValue(item && typeof item === 'object', '同步记录格式无效');
        const { kind, id, revision } = item;
        checkKey(kind, id);
        requireValue(Number.isSafeInteger(revision) && revision > 0, '同步版本须为正整数');
        const stage = item.stage === null ? '' : item.stage;
        const node = item.node === null ? '' : item.node;
        requireValue(typeof stage === 'string' && typeof node === 'string' &&
          ((!stage && !node) || progressNode(stage, node, 'sales')), '同步记录缺少阶段、节点或状态代码未对齐');
        const completed = item.completedNodes === undefined ? [] : item.completedNodes;
        requireValue(Array.isArray(completed) && completed.every(code =>
          typeof code === 'string' && progressNode(stage, code, 'sales')), '已完成节点须属于当前阶段');
        const history = JSON.stringify([...new Set(completed)].sort());
        const contract = item.contractNumber ?? '';
        requireValue(typeof contract === 'string' && contract.length <= 128 && !/[\u0000-\u001f\u007f]/.test(contract),
          '合同号格式无效');
        const contractNumber = contract.trim();
        const table = records[kind], key = kind === 'registry' ? 'entry_key' : 'id';
        const exists = (kind !== 'registry' || one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registry_entries'")) &&
          one(`SELECT 1 FROM ${table} WHERE ${key}=?`, id);
        requireValue(exists, '同步记录在本地没有对应业务记录', 404);
        const prior = one('SELECT * FROM company_record_progress WHERE kind=? AND record_id=?', kind, id);
        if (prior && prior.revision >= revision) {
          requireValue(prior.revision === revision && prior.stage === stage && prior.node === node &&
            prior.contract_number === contractNumber && prior.completed_nodes === history, '进度版本已过期或同版本内容不一致', 409);
          result.unchanged++;
          continue;
        }
        db.prepare(`INSERT INTO company_record_progress(kind,record_id,revision,stage,node,contract_number,completed_nodes) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(kind,record_id) DO UPDATE SET revision=excluded.revision,stage=excluded.stage,
            node=excluded.node,contract_number=excluded.contract_number,completed_nodes=excluded.completed_nodes`)
          .run(kind,id,revision,stage,node,contractNumber,history);
        result.updated++;
      }
      return result;
    });
  }

  function liveRecord(actor, kind, id) {
    const isCase = kind === 'case';
    const scope = actor.role === 'sales' ? 'a.salesId=?' : 'l.clientId=?';
    return one(`SELECT l.stockName,l.stockCode,COALESCE(a.contactName,c.name,'') AS customer,
      ${isCase ? 'k.id AS internalId,k.title,k.status AS sourceStatus,k.openedOn' : "l.id AS internalId,l.createdAt,'' AS title,'' AS sourceStatus"}
      FROM leads l JOIN clients c ON c.id=l.clientId LEFT JOIN lead_assignments a ON a.leadId=l.id
      ${isCase ? 'JOIN cases k ON k.leadId=l.id' : ''}
      WHERE ${scope} AND ${isCase ? 'k.id=? AND k.openedOn>=?' : 'l.id=?'}`, actor.id, id, ...(isCase ? [caseCutoff] : []));
  }

  function detail(actor, { kind, id }) {
    requireValue(['investor','sales'].includes(actor?.role) && !actor.passwordChangeRequired, '当前账号无权查看案件进度', 403);
    checkKey(kind,id);
    return transaction(() => {
      const record = kind === 'registry' ? registry.progressRecord(actor,id) : liveRecord(actor,kind,id);
      requireValue(record, '未找到可查看的记录', 404);
      const snapshot = one(`SELECT stage,node,completed_nodes${actor.role === 'sales' ? ',contract_number' : ''}
        FROM company_record_progress WHERE kind=? AND record_id=?`, kind, record.internalId);
      const related = kind === 'lead' ? db.prepare(`SELECT k.id,k.title,k.status,k.openedOn,p.stage FROM cases k
        LEFT JOIN company_record_progress p ON p.kind='case' AND p.record_id=k.id
        WHERE k.leadId=? AND k.openedOn>=? ORDER BY k.openedOn DESC,k.id`).all(id, caseCutoff) : [];
      const sourceStatus = !snapshot && sourceStatuses.has(record.sourceStatus) ? record.sourceStatus : '';
      let current = null;
      if (snapshot) current = progressNode(snapshot.stage, snapshot.node, actor.role);
      else if (kind === 'lead') current = progressNode('intake', 'lead_received', actor.role);
      else if (Object.hasOwn(record,'progress_stage')) {
        current = progressNode(record.progress_stage, record.progress_node, actor.role);
      } else if (legacyNodes.has(sourceStatus)) {
        current = progressNode(...legacyNodes.get(sourceStatus), actor.role);
      }
      if (current?.node === 'signed_waiting_filing') {
        const advanced = new Set(['已受理','诉讼中','已立案','已立案未开庭','已开庭','一审待开庭','一审已开庭',
          '二审待开庭','二审已开庭','已判决','已上诉','已结案','执行中']);
        if (record.filedOn || advanced.has(record.sourceStatus) ||
          related.some(c => advanced.has(c.status) || (c.stage && c.stage !== 'intake'))) {
          current = progressNode('intake','signed',actor.role);
        }
      }
      const completed = snapshot ? JSON.parse(snapshot.completed_nodes) : [];
      if (kind === 'lead' && current?.stage === 'intake' && Number.isFinite(Date.parse(record.createdAt))) {
        completed.push('lead_received');
      }
      const response = { kind,id, title: record.title || record.stockName || record.stockCode || '',
        customer: record.customer, stockName: record.stockName, stockCode: record.stockCode, current, sourceStatus: current ? '' : sourceStatus,
        steps: progressSteps(current, actor.role, completed),
        relatedCases: related.map(({id,title,status,openedOn}) => ({id,title,status: sourceStatuses.has(status) ? status : '',openedOn})) };
      for (const key of ['registeredOn','filedOn','openedOn']) {
        if (record[key]) response[key] = record[key];
      }
      if (record.createdAt && Number.isFinite(Date.parse(record.createdAt))) {
        response.createdOn = businessDate.format(new Date(record.createdAt));
      }
      if (actor.role === 'sales') {
        const contract = snapshot ? snapshot.contract_number : record.contract_number;
        if (contract) response.contractNumber = contract;
      }
      return response;
    }, true);
  }

  return { detail, sync };
}
