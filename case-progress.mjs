import { progressNode, progressSteps } from './progress-dictionary.mjs';
import { createLeadSigningScope, currentRelatedCases, resolveCaseProgress, resolveLeadProgress } from './lead-progress.mjs';
import { projectProgressDisplay } from './progress-display.mjs';

const records = { lead: 'leads', case: 'cases', registry: 'registry_entries' };
const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function createCaseProgress(db, { transaction, requireValue, registry }) {
  transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS company_record_progress (
      kind TEXT NOT NULL CHECK(kind IN ('lead','case','registry')), record_id TEXT NOT NULL,
      revision INTEGER NOT NULL, stage TEXT NOT NULL, node TEXT NOT NULL, contract_number TEXT NOT NULL,
      completed_nodes TEXT NOT NULL DEFAULT '[]',next_stage TEXT NOT NULL DEFAULT '',next_node TEXT NOT NULL DEFAULT '', PRIMARY KEY(kind,record_id)
    )`);
    const columns = db.prepare('PRAGMA table_info(company_record_progress)').all();
    if (!columns.some(column => column.name === 'completed_nodes')) {
      db.exec("ALTER TABLE company_record_progress ADD COLUMN completed_nodes TEXT NOT NULL DEFAULT '[]'");
    }
    for (const column of ['next_stage','next_node']) {
      if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE company_record_progress ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    }
    if (!columns.some(item => item.name === 'testing')) db.exec("ALTER TABLE company_record_progress ADD COLUMN testing INTEGER NOT NULL DEFAULT 0");
  });
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  function checkKey(kind, id) {
    requireValue(typeof kind === 'string' && Object.hasOwn(records, kind), '记录类型无效');
    requireValue(typeof id === 'string' && id.length > 0 && id.length <= 256, '记录编号无效');
  }

  // Used only by the trusted company-data import, with internal source keys.
  // Revision and full-snapshot comparison avoid stale or ambiguous overwrites.
  function sync(items) {
    return transaction(() => applySnapshots(items));
  }
  function applySnapshots(items) {
    requireValue(Array.isArray(items), '同步数据应为记录数组');
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
        const nextStage = item.nextStage ?? '', nextNode = item.nextNode ?? '';
        requireValue(typeof nextStage === 'string' && typeof nextNode === 'string' &&
          ((!nextStage && !nextNode) || progressNode(nextStage,nextNode,'sales')), '下一步路线须提供成对有效的阶段和节点');
        requireValue(!nextStage || stage && node && !(stage === nextStage && node === nextNode) && !(stage === 'closure' && node === 'closed'),
          '下一步不能等于当前节点，清空状态或结案后不能提供下一步');
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
        let sourcePrior = prior;
        if (prior?.testing && one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_progress_test_backup'")) {
          const backup = one('SELECT original_snapshot,applied_snapshot FROM admin_progress_test_backup WHERE kind=? AND record_id=?',kind,id);
          const current = one(`SELECT revision,stage,node,contract_number,completed_nodes,next_stage,next_node,testing
            FROM company_record_progress WHERE kind=? AND record_id=?`,kind,id);
          if (backup?.applied_snapshot === JSON.stringify(current)) sourcePrior = JSON.parse(backup.original_snapshot);
        }
        if (sourcePrior && sourcePrior.revision >= revision) {
          requireValue(sourcePrior.revision === revision && sourcePrior.stage === stage && sourcePrior.node === node &&
            sourcePrior.contract_number === contractNumber && sourcePrior.completed_nodes === history && sourcePrior.next_stage === nextStage && sourcePrior.next_node === nextNode, '进度版本已过期或同版本内容不一致', 409);
          result.unchanged++;
          continue;
        }
        db.prepare(`INSERT INTO company_record_progress(kind,record_id,revision,stage,node,contract_number,completed_nodes,next_stage,next_node) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(kind,record_id) DO UPDATE SET revision=excluded.revision,stage=excluded.stage,
            node=excluded.node,contract_number=excluded.contract_number,completed_nodes=excluded.completed_nodes,next_stage=excluded.next_stage,next_node=excluded.next_node,testing=0`)
          .run(kind,id,revision,stage,node,contractNumber,history,nextStage,nextNode);
        result.updated++;
      }
      return result;
  }

  function liveRecord(actor, kind, id, preview = false) {
    const isCase = kind === 'case';
    const scope = preview ? '1=1' : actor.role === 'sales' ? 'a.salesId=?' : 'l.clientId=?';
    return one(`SELECT l.clientId,l.stockName,l.stockCode,COALESCE(a.contactName,c.name,'') AS customer,s.signedOn,
      ${isCase ? 'k.id AS internalId,k.title,k.status AS sourceStatus,k.openedOn' : "l.id AS internalId,l.createdAt,'' AS title,'' AS sourceStatus"}
      FROM leads l JOIN clients c ON c.id=l.clientId LEFT JOIN lead_assignments a ON a.leadId=l.id LEFT JOIN signings s ON s.clientId=c.id
      ${isCase ? 'JOIN cases k ON k.leadId=l.id' : ''}
      WHERE ${scope} AND ${isCase ? 'k.id=?' : 'l.id=?'}`, ...(preview ? [id] : [actor.id,id]));
  }

  function detail(actor, { kind, id }) {
    requireValue(['investor','sales'].includes(actor?.role) && !actor.passwordChangeRequired, '当前账号无权查看案件进度', 403);
    return transaction(() => readDetail(actor,{kind,id}),true);
  }

  function readDetail(actor, { kind, id }, adminActor) {
    checkKey(kind,id);
      const record = kind === 'registry' ? registry.progressRecord(adminActor || actor,id,adminActor ? actor.role : undefined) : liveRecord(actor,kind,id,!!adminActor);
      requireValue(record, '未找到可查看的记录', 404);
      const snapshot = one(`SELECT stage,node,completed_nodes,next_stage,next_node,testing${actor.role === 'sales' ? ',contract_number' : ''}
        FROM company_record_progress WHERE kind=? AND record_id=?`, kind, record.internalId);
      const currentDay = businessDate.format(new Date());
      const signingMatch = kind === 'lead' ? createLeadSigningScope(db)({...record,id:record.internalId},currentDay) : 'none';
      const related = kind === 'lead' ? currentRelatedCases(db.prepare(`SELECT k.id,k.title,k.status,k.openedOn,p.stage,p.node,p.completed_nodes,p.next_stage,p.next_node,p.testing,p.record_id AS snapshot${actor.role === 'sales' ? ',p.contract_number' : ''} FROM cases k
        LEFT JOIN company_record_progress p ON p.kind='case' AND p.record_id=k.id
        WHERE k.leadId=?`).all(id),currentDay) : [];
      const normalized = { hasSnapshot:!!snapshot,progressStage:snapshot ? snapshot.stage : record.progress_stage,
        progressNode:snapshot ? snapshot.node : record.progress_node,completedNodes:snapshot?.completed_nodes,
        nextStage:snapshot?.next_stage,nextNode:snapshot?.next_node,testing:!!snapshot?.testing,
        rawStatus:record.sourceStatus,filedOn:record.filedOn,signedOn:record.signedOn,createdAt:record.createdAt,signingMatch };
      const relatedProgress = related.map(item => ({
        hasSnapshot:!!item.snapshot,progressStage:item.stage,progressNode:item.node,completedNodes:item.completed_nodes,rawStatus:item.status,nextStage:item.next_stage,nextNode:item.next_node,testing:!!item.testing }));
      const resolved = kind === 'lead' ? resolveLeadProgress(normalized,relatedProgress,actor.role,currentDay)
        : resolveCaseProgress(normalized,actor.role,currentDay);
      const {current,sourceStatus,completedNodes:completed,nextState} = resolved;
      const response = { kind,id, title: record.title || record.stockName || record.stockCode || '',
        customer: record.customer, stockName: record.stockName, stockCode: record.stockCode, current, sourceStatus: current ? '' : sourceStatus,
        steps: progressSteps(current, actor.role, completed, nextState),
        relatedCases: related.map(({id,title,status,openedOn,stage,node,snapshot,testing}) => ({id,title,
          status: resolveCaseProgress({ rawStatus: status, hasSnapshot: !!snapshot, progressStage: stage, progressNode: node,testing }, actor.role,currentDay).status, openedOn})) };
      if (!current) {
        const displaySource = kind === 'lead' && !snapshot && relatedProgress.length ? relatedProgress[0] : normalized;
        response.displayProgress = projectProgressDisplay(displaySource, { role: actor.role, kind, currentDay });
      }
      for (const key of ['registeredOn','filedOn','openedOn']) {
        if (record[key] && (key !== 'filedOn' || validDay(record[key]) && record[key] <= currentDay)) response[key] = record[key];
      }
      if (kind === 'lead' && signingMatch === 'single') response.signedOn = record.signedOn;
      if (typeof record.createdAt === 'string' && validDay(record.createdAt.slice(0, 10)) && Number.isFinite(Date.parse(record.createdAt))) {
        response.createdOn = businessDate.format(new Date(record.createdAt));
      }
      // Attach only a real event belonging to the current record and stage.
      // Test snapshots and inherited case states do not acquire older dates.
      let event;
      if (current && !snapshot?.testing) {
        if (kind === 'lead' && (snapshot || !related.length) && current.stage === 'intake') {
          if (current.node === 'lead_received') event = [response.createdOn, '留资日期'];
          else if (['signed', 'signed_waiting_filing'].includes(current.node) && signingMatch === 'single') {
            event = [record.signedOn, '签约日期'];
          }
        } else if (kind === 'registry' && current.stage === 'filing' && current.node === 'submitted') {
          event = [record.filedOn, '立案日期'];
        }
      }
      if (event && validDay(event[0]) && event[0] <= currentDay) {
        Object.assign(response.steps[0], { date: event[0], dateLabel: event[1] });
      }
      if (actor.role === 'sales') {
        const contract = snapshot ? snapshot.contract_number : kind === 'lead' && related.length ? related[0].contract_number : record.contract_number;
        if (contract) response.contractNumber = contract;
      }
      return response;
  }

  // Internal administrative projection only; caller owns the transaction.
  function preview(actor,input,role) {
    requireValue(actor?.role === 'admin' && !actor.passwordChangeRequired && ['investor','sales'].includes(role),'当前账号无权预览进度',403);
    return readDetail({role},input,actor);
  }
  return { detail, sync, preview, applySnapshots };
}
