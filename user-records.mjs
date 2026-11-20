import { createHash } from 'node:crypto';
import { createSigningEvidence } from './signing-evidence.mjs';
import { createLeadSigningScope, currentRelatedCases, resolveCaseProgress, resolveLeadProgress } from './lead-progress.mjs';
import { compareRecent, orderLabels } from './web/list-order.js';

const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const recordDate = value => validDate(value) ? value : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && validDate(value.slice(0,10))
  && Number.isFinite(Date.parse(value)) ? businessDate.format(new Date(value)) : '';
const dateOf = recordDate;
function personPair(name, phone) {
  const fullName = normalize(name), fullPhone = String(phone || '').normalize('NFKC').trim();
  if (!/^1\d{10}$/.test(fullPhone) || !fullName || /[*＊]/.test(fullName) ||
      /^(?:股民姓名待核对|待留资客户|未知|不详|未登记|无|待核对|[-—–/\s]+)$/.test(fullName)) return '';
  return JSON.stringify([fullName, fullPhone]);
}

// One authorized read path for every user-facing stock record. Source identities
// stay internal; searching never expands permissions or manufactures ownership.
export function createUserRecords(db, { transaction, requireValue, today }) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  function authorize(actor) {
    requireValue(['investor', 'sales', 'broker'].includes(actor?.role) && !actor.passwordChangeRequired, '当前账号无权查看记录', 403);
  }
  function filters(input = {}) {
    const q = input.q ?? '', period = input.period ?? 'all', customerId = input.customerId ?? '', ledger = input.ledger ?? 'all';
    requireValue(typeof q === 'string' && q.length <= 100, '查询内容最多 100 字');
    requireValue(typeof customerId === 'string' && customerId.length <= 128 && !/[\u0000-\u001f\u007f]/.test(customerId), '客户条件无效');
    requireValue(['all','month','custom'].includes(period), '请选择全部、本月或自选日期');
    requireValue(['all','negotiating','signed'].includes(ledger), '客户签约状态无效');
    requireValue(/^\d+$/.test(String(input.offset ?? 0)) && Number.isSafeInteger(Number(input.offset ?? 0)), '分页参数无效');
    const limit = input.limit === undefined ? 20 : input.limit;
    requireValue([5, 20, '5', '20'].includes(limit), '每页条数只能选择 5 或 20');
    const currentDay = today();
    let from = period === 'month' ? currentDay.slice(0, 7) + '-01' : '', to = currentDay;
    if (period === 'custom') {
      requireValue(validDate(input.from) && validDate(input.to), '请填写有效的起止日期');
      requireValue(input.from <= input.to, '起始日期不能晚于结束日期');
      requireValue(input.to <= currentDay, '结束日期不能晚于今天');
      from = input.from; to = input.to;
    }
    return { q: q.trim(), period, customerId, ledger, from, to, today: currentDay, offset: Number(input.offset || 0), limit: Number(limit) };
  }
  function read(actor) {
    authorize(actor);
    const currentDay = today(), role = actor.role === 'investor' ? 'investor' : 'sales';
    const signingEvidence = createSigningEvidence(db);
    const testing = all('PRAGMA table_info(company_record_progress)').some(row=>row.name==='testing') ? 'p.testing' : '0';
    const scope = actor.role === 'sales' ? 'a.salesId=?' : actor.role === 'broker' ? 'c.brokerId=?' : 'l.clientId=?';
    const leads = all(`SELECT l.*,c.id AS clientId,c.name AS clientName,c.phone AS clientPhone,
      COALESCE(a.contactName,c.name) AS customer,COALESCE(a.contactPhone,c.phone) AS phone,
      a.salesId,a.version,i.subjectId AS identity,i.name AS identityName,s.signedOn,p.record_id AS hasSnapshot,
      p.stage AS progressStage,p.node AS progressNode,p.completed_nodes AS completedNodes,${testing} AS testing
      FROM leads l JOIN clients c ON c.id=l.clientId LEFT JOIN lead_assignments a ON a.leadId=l.id
      LEFT JOIN identities i ON i.role='investor' AND i.subjectId=c.id LEFT JOIN signings s ON s.clientId=c.id
      LEFT JOIN company_record_progress p ON p.kind='lead' AND p.record_id=l.id WHERE ${scope}`, actor.id);
    const cases = all(`SELECT k.*,p.record_id AS hasSnapshot,p.stage AS progressStage,p.node AS progressNode,p.completed_nodes AS completedNodes,${testing} AS testing
      FROM cases k JOIN leads l ON l.id=k.leadId JOIN clients c ON c.id=l.clientId LEFT JOIN lead_assignments a ON a.leadId=l.id
      LEFT JOIN company_record_progress p ON p.kind='case' AND p.record_id=k.id
      WHERE ${scope}`, actor.id);
    const casesByLead = new Map();
    for (const item of currentRelatedCases(cases,currentDay)) {
      const resolved = resolveCaseProgress({ ...item,rawStatus:item.status },role,currentDay);
      if (!casesByLead.has(item.leadId)) casesByLead.set(item.leadId, []);
      casesByLead.get(item.leadId).push({ id:item.id,title:item.title,status:resolved.status,current:resolved.current,
        openedOn:dateOf(item.openedOn), signed:signingEvidence('case',item.id,item,currentDay),
        progress:{hasSnapshot:item.hasSnapshot,progressStage:item.progressStage,progressNode:item.progressNode,completedNodes:item.completedNodes,rawStatus:item.status,testing:item.testing} });
    }
    const records = [];
    const signingScope = createLeadSigningScope(db);
    for (const row of leads) {
      const registeredOn = dateOf(row.createdAt);
      if (registeredOn > currentDay) continue;
      const ownCases = casesByLead.get(row.id) || [];
      const signingMatch = signingScope(row,currentDay);
      const progress = resolveLeadProgress({...row,signingMatch},ownCases.map(item=>item.progress),role,currentDay);
      const status = progress.status;
      records.push({ id:'lead:'+row.id,recordKind:'lead',identity:row.identity || '',clientId:row.clientId,
        customer:row.customer || row.clientName || '待留资客户',phone:row.phone || row.clientPhone || '',
        nameAliases:[row.customer,row.clientName,row.identityName],phoneAliases:[row.phone,row.clientPhone],
        stockName:row.stockName || '',stockCode:row.stockCode || '',registeredOn,status,
        caseGroup:progress.caseGroup,
        homeProgress:{current:progress.current,hasOwnSnapshot:!!row.hasSnapshot,cases:ownCases.map(item=>({id:item.id,current:item.current}))},
        ...(signingMatch === 'single' ? {signedOn:row.signedOn} : {}),
        signed:(validDate(row.signedOn) && row.signedOn <= currentDay) || signingEvidence('lead',row.id,row,currentDay) || ownCases.some(item=>item.signed),
        kind:'lead',progressId:row.id,cases:ownCases.map(({signed,progress,current,...item})=>item),
      });
    }
    if (one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registry_entries'")) {
      const columns = new Set(all('PRAGMA table_info(registry_entries)').map(row=>row.name));
      const extra = name => columns.has(name) ? 'e.'+name : "''";
      const source = actor.role === 'sales'
        ? "JOIN registry_links sl ON sl.type='sales' AND sl.source_name=e.sales AND sl.source_phone='' JOIN identities seller ON seller.id=sl.identity_id AND seller.role='sales' AND seller.subjectId=? AND seller.status='active' LEFT JOIN registry_links il ON il.type='investor' AND il.source_name=e.customer AND il.source_phone=e.phone LEFT JOIN identities investor ON investor.id=il.identity_id AND investor.role='investor'"
        : "JOIN registry_links il ON il.type='investor' AND il.source_name=e.customer AND il.source_phone=e.phone JOIN identities investor ON investor.id=il.identity_id AND investor.role='investor'" +
          (actor.role === 'investor' ? " AND investor.subjectId=? AND investor.status='active'" : " JOIN clients c ON c.id=investor.subjectId AND c.brokerId=?");
      for (const row of all(`SELECT e.entry_key AS entryKey,e.customer,e.phone,e.stock_name AS stockName,e.stock_code AS stockCode,
        e.registered_on AS registeredOn,${extra('filed_on')} AS filedOn,e.stage AS rawStatus,investor.subjectId AS identity,investor.name AS identityName,profile.name AS clientName,profile.phone AS clientPhone,p.record_id AS hasSnapshot,
        COALESCE(p.stage,${extra('progress_stage')}) AS progressStage,COALESCE(p.node,${extra('progress_node')}) AS progressNode,
        ${extra('progress_stage')} AS sourceProgressStage,${extra('progress_node')} AS sourceProgressNode,p.completed_nodes AS completedNodes,${testing} AS testing
        FROM registry_entries e ${source} LEFT JOIN clients profile ON profile.id=investor.subjectId LEFT JOIN company_record_progress p ON p.kind='registry' AND p.record_id=e.entry_key`,actor.id)) {
        const registeredOn = dateOf(row.registeredOn);
        if (registeredOn > currentDay) continue;
        const current = resolveCaseProgress(row,role,currentDay);
        records.push({id:'registry:'+hash(row.entryKey),groupFallback:'registry:'+row.entryKey,recordKind:'registry',identity:row.identity || '',clientId:row.identity || '',
          customer:row.customer || '股民姓名待核对',phone:row.phone || '',
          nameAliases:[row.customer,row.clientName,row.identityName],phoneAliases:[row.phone,row.clientPhone],stockName:row.stockName || '',stockCode:row.stockCode || '',registeredOn,
          status:current.status,caseGroup:current.caseGroup,signed:signingEvidence('registry',row.entryKey,row,currentDay),kind:'registry',progressId:hash(row.entryKey),cases:[],
          homeProgress:{current:current.current,registry:{entryKey:row.entryKey,filedOn:row.filedOn,rawStatus:row.rawStatus,
            hasSnapshot:!!row.hasSnapshot,stage:row.progressStage,node:row.progressNode,testing:!!row.testing,
            sourceStage:row.sourceProgressStage,sourceNode:row.sourceProgressNode}}});
      }
    }
    if (actor.role === 'broker') {
      const represented = new Set(records.map(row => row.clientId));
      for (const row of all(`SELECT c.id,c.name,c.phone,c.createdAt,s.signedOn,i.name AS identityName FROM clients c
        LEFT JOIN signings s ON s.clientId=c.id LEFT JOIN identities i ON i.role='investor' AND i.subjectId=c.id WHERE c.brokerId=?`, actor.id)) {
        const registeredOn = dateOf(row.createdAt);
        if (represented.has(row.id) || registeredOn > currentDay) continue;
        records.push({id:'client:'+row.id,recordKind:'client',identity:row.id,clientId:row.id,
          customer:row.name || '待留资客户',phone:row.phone || '',nameAliases:[row.name,row.identityName],stockName:'',stockCode:'',registeredOn,
          status:'待留资',caseGroup:'other',signed:validDate(row.signedOn) && row.signedOn <= currentDay,cases:[]});
      }
    }
    const identitiesByPair = new Map();
    for (const row of records) {
      row.pair = personPair(row.customer,row.phone);
      if (row.identity && row.pair) {
        if (!identitiesByPair.has(row.pair)) identitiesByPair.set(row.pair,new Set());
        identitiesByPair.get(row.pair).add(row.identity);
      }
    }
    for (const row of records) {
      const matches = identitiesByPair.get(row.pair);
      const identity = row.identity || (matches?.size === 1 ? [...matches][0] : '');
      const groupKey = identity ? 'identity:'+identity : row.pair ? 'pair:'+row.pair : row.clientId ? 'client:'+row.clientId : row.groupFallback || row.id;
      row.customerId = actor.role === 'broker' ? row.clientId : hash(groupKey);
    }
    if (actor.role === 'broker') {
      const signedCustomers = new Set(records.filter(row=>row.signed).map(row=>row.customerId));
      for (const row of all(`SELECT c.id,s.signedOn FROM clients c JOIN signings s ON s.clientId=c.id WHERE c.brokerId=?`, actor.id)) {
        if (validDate(row.signedOn) && row.signedOn <= currentDay) signedCustomers.add(row.id);
      }
      for (const row of records) row.signingStatus = signedCustomers.has(row.customerId) ? '已签约' : '洽谈中';
    }
    return records.sort(compareRecent);
  }
  function publicItem(row, actor, internal = false) {
    const { identity,pair,groupFallback,nameAliases,phoneAliases,recordKind,clientId,signed,caseGroup,homeProgress,...item } = row;
    if (actor.role === 'broker') { delete item.phone; delete item.kind; delete item.progressId; }
    return internal ? { ...item,recordKind,clientId,signed,caseGroup } : item;
  }
  function query(actor, input = {}) {
    authorize(actor);
    const selected = filters(input);
    requireValue(actor.role === 'broker' || selected.ledger === 'all', '客户签约筛选仅适用于券商');
    return transaction(() => {
      const authorized = read(actor), q = normalize(selected.q);
      const matchedCustomers = new Set();
      if (q) for (const row of authorized) {
        const names = [row.customer,...(row.nameAliases || [])];
        const phones = actor.role === 'broker' ? [] : [row.phone,...(row.phoneAliases || [])];
        if ([...names,...phones].some(value=>normalize(value).includes(q))) matchedCustomers.add(row.customerId);
      }
      const records = authorized.filter(row => (!selected.customerId || row.customerId === selected.customerId) &&
        (row.registeredOn ? row.registeredOn <= selected.to && (!selected.from || row.registeredOn >= selected.from) : selected.period === 'all') &&
        (selected.ledger === 'all' || row.signingStatus === (selected.ledger === 'signed' ? '已签约' : '洽谈中')));
      const matched = q ? records.filter(row => matchedCustomers.has(row.customerId) || [row.stockName,row.stockCode]
        .some(value=>normalize(value).includes(q))) : records;
      const offset = Math.min(Math.floor(selected.offset/selected.limit),Math.max(0,Math.ceil(matched.length/selected.limit)-1))*selected.limit;
      return {...selected,offset,total:matched.length,unfilteredTotal:records.length,customerCount:new Set(matched.map(row=>row.customerId)).size,
        orderLabel:orderLabels.recent,items:matched.slice(offset,offset+selected.limit).map(row=>publicItem(row,actor))};
    },true);
  }
  // Internal readers call this within their existing transaction; nesting BEGIN
  // here would break broker-board snapshots. The HTTP query owns its transaction.
  query.all = actor => read(actor).map(row=>publicItem(row,actor,true));
  query.homeRows = actor => read(actor);
  query.criteria = filters;
  return query;
}
