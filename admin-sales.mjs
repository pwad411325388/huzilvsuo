import { createHash } from 'node:crypto';
import { hasSigningEvidence as signingEvidence, classifyCase as classify } from './data-semantics.mjs';
import { compareAccounts, compareRecent, comparePending, compareSalesSummary, compareSourceSummary, orderLabels } from './web/list-order.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const limit = 20;
const titles = { channels: '来源渠道', records: '留资与历史登记', customers: '客户档案', ongoing: '在办案件',
  closed: '已结案件', unknown: '进度待核记录', other: '其他进度记录' };
const platformMetrics = [
  ['records', '留资与登记', '条'], ['customers', '客户档案', '份'], ['channels', '来源渠道', '个'],
  ['pending', '待分配 / 关联', '条'], ['ongoing', '在办案件', '件'], ['closed', '已结案件', '件'],
  ['registry', '历史登记', '条'], ['signed', '已签约档案', '份'],
];
const pendingQueues = [
  ['system_new', '新留资待分配'], ['system_legacy', '历史留资待核对'], ['registry_unlinked', '历史登记待关联 / 调整'],
];
const dataTypes = { records: '留资与登记', customers: '客户档案', channels: '来源渠道', cases: '客户案件', signed: '已签约档案', sales: '销售汇总' };
const caseFilters = [['ongoing', '在办'], ['closed', '已结案'], ['unknown', '进度待核'], ['other', '其他进度']];
const column = (key, label, width = 20) => ({ key, label, width });
const recordColumns = [column('number', '记录编号'), column('title', '客户'), column('phone', '电话'), column('stockName', '股票'),
  column('stockCode', '股票代码'), column('source', '来源渠道'), column('sales', '销售'), column('registeredOn', '登记日期'),
  column('followStatus', '跟进状态'), column('caseStatus', '案件进度'), column('originLabel', '数据来源')];
const reportColumns = {
  records: recordColumns,
  cases: [column('number', '案件 / 登记编号'), ...recordColumns.slice(1, 8), column('caseStatus', '案件进度'), column('originLabel', '数据来源')],
  customers: [column('title', '客户'), column('phone', '电话'), column('subtitle', '股票线索', 42), column('source', '来源渠道', 26),
    column('sales', '销售'), column('registeredOn', '最近登记日期'), column('recordCount', '记录数'), column('status', '资料状态'), column('originLabel', '数据来源')],
  signed: [column('title', '客户'), column('phone', '电话'), column('subtitle', '股票线索', 42), column('source', '来源渠道', 26),
    column('sales', '销售'), column('registeredOn', '最近登记日期'), column('signedOn', '实际签约日期'), column('recordCount', '记录数'), column('status', '签约状态')],
  channels: [column('title', '来源渠道', 26), column('sales', '对应销售', 30), column('recordCount', '留资与登记数'),
    column('customerCount', '客户档案数'), column('ongoing', '在办案件'), column('closed', '已结案件'), column('registeredOn', '最近登记 / 合作日期'),
    column('status', '渠道类型'), column('originLabel', '数据来源')],
  sales: [column('name', '销售'), column('status', '账号状态'), column('channelCount', '来源渠道数'), column('recordCount', '留资与登记数'),
    column('customerCount', '客户档案数'), column('ongoing', '在办案件'), column('closed', '已结案件'), column('unknown', '进度待核'), column('other', '其他进度')],
};

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return '';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return '';
  if (value.length === 10) return parsed.toISOString().slice(0, 10) === value ? value : '';
  return dateFormat.format(parsed);
}

function personPair(name, phone) {
  const fullName = normalize(name), fullPhone = String(phone || '').normalize('NFKC').trim();
  if (!/^1\d{10}$/.test(fullPhone) || !fullName || /[*＊]/.test(fullName) ||
      /^(?:股民姓名待核对|待留资客户|未知|不详|未登记|无|待核对|[-—–/\s]+)$/.test(fullName)) return '';
  return JSON.stringify([fullName, fullPhone]);
}

function resolvePeople(rows) {
  const identitiesByPair = new Map();
  for (const row of rows) {
    row.pair = personPair(row.title, row.phone);
    if (row.identity && row.pair) {
      if (!identitiesByPair.has(row.pair)) identitiesByPair.set(row.pair, new Set());
      identitiesByPair.get(row.pair).add(row.identity);
    }
  }
  for (const row of rows) {
    const known = identitiesByPair.get(row.pair);
    const identity = row.identity || (known?.size === 1 ? [...known][0] : '');
    row.personKey = identity ? 'identity:' + identity : row.pair ? 'pair:' + row.pair : row.clientId ? 'client:' + row.clientId : row.id;
    row.unverified = !identity && !row.pair && row.origin === 'registry';
  }
}

const originLabel = value => value === 'system' ? '系统留资' : value === 'registry' ? '历史登记' : '系统与历史登记';
const sourceKey = name => normalize(name) ? hash('source:' + normalize(name)) : '__unknown__';
const mixedOrigin = rows => new Set(rows.map(row => row.origin)).size > 1 ? 'mixed' : rows[0]?.origin || 'system';
const notes = [
  '来源渠道包括合作券商和客户登记来源，同一来源可涉及多位销售；历史来源不会自动开通券商账号。',
  '客户按身份或完整姓名、手机号核对合并；资料不完整的历史登记暂按独立档案计数，各销售档案数不能直接相加。',
  '历史表未提供销售跟进记录，单列为跟进待核；案件仅按明确进度统计，最新公司同步状态优先。',
];

// Keep the imported snapshot as the source of truth: this model never creates
// broker accounts, client accounts, assignments or duplicate copies of registrations.
export function createAdminSales(db, { requireValue, transaction, today }) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const exists = name => !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

  function check(actor) {
    requireValue(actor?.role === 'admin' && !actor.passwordChangeRequired, '只有后台管理员可以查看销售汇总', 403);
  }

  function filters(input = {}) {
    const { q = '', salesId = '', sourceKey = '', origin = 'all', metric = 'records', offset = '0' } = input;
    requireValue(typeof q === 'string' && q.length <= 100, '搜索内容最多 100 字');
    requireValue(typeof salesId === 'string' && salesId.length <= 100, '销售参数无效');
    requireValue(typeof sourceKey === 'string' && (!sourceKey || ['__known__', '__unknown__'].includes(sourceKey) || /^[a-f0-9]{64}$/.test(sourceKey)), '来源参数无效');
    requireValue(['all', 'system', 'registry'].includes(origin), '请选择有效的数据来源');
    requireValue(Object.hasOwn(titles, metric), '明细分类无效');
    requireValue(/^\d+$/.test(String(offset)) && Number.isSafeInteger(Number(offset)), '分页参数无效');
    return { q: normalize(q), salesId, sourceKey, origin, metric, offset: Number(offset) };
  }

  function load() {
    const currentDay = today();
    const visible = value => !value || value <= currentDay;
    const staff = all(`SELECT s.id,s.name,i.status AS accountStatus,i.username FROM sales_staff s
      LEFT JOIN identities i ON i.role='sales' AND i.subjectId=s.id
      UNION ALL SELECT i.subjectId,i.name,i.status,i.username FROM identities i WHERE i.role='sales'
        AND NOT EXISTS(SELECT 1 FROM sales_staff s WHERE s.id=i.subjectId)`);
    const staffById = new Map(staff.map(row => [row.id, row]));
    const brokers = all(`SELECT b.id,b.name,b.salesId,b.signedOn,COALESCE(i.status,'pending') AS accountStatus FROM brokers b
      LEFT JOIN identities i ON i.role='broker' AND i.subjectId=b.id`).filter(row => visible(date(row.signedOn)));
    const assignmentColumns = new Set(all('PRAGMA table_info(lead_assignments)').map(row => row.name));
    const records = all(`SELECT l.id,l.clientId,l.stockName,l.stockCode,l.createdAt,
      COALESCE(a.contactName,c.name) AS customer,COALESCE(a.contactPhone,c.phone) AS phone,
      a.salesId,i.status AS salesStatus,a.version,b.name AS source,n.number AS recordNumber,
      investor.subjectId AS investorId,${assignmentColumns.has('legacy') ? 'a.legacy' : '0'} AS legacy,
      EXISTS(SELECT 1 FROM lead_followups f WHERE f.leadId=l.id AND f.assignmentVersion=a.version) AS followed
      FROM leads l JOIN clients c ON c.id=l.clientId LEFT JOIN lead_assignments a ON a.leadId=l.id
      LEFT JOIN brokers b ON b.id=c.brokerId LEFT JOIN identities i ON i.role='sales' AND i.subjectId=a.salesId
      LEFT JOIN identities investor ON investor.role='investor' AND investor.subjectId=c.id
      LEFT JOIN report_numbers n ON n.kind='lead' AND n.subjectId=l.id`).map(row => ({
      internalId: row.id, id: hash('lead:' + row.id), number: row.recordNumber ? `LZ-${String(row.recordNumber).padStart(6, '0')}` : '系统留资',
      title: row.customer || '待留资客户', phone: row.phone || '', stockName: row.stockName, stockCode: row.stockCode,
      source: row.source || '自然流入', sourceKey: sourceKey(row.source || '自然流入'), origin: 'system',
      salesId: row.salesId || '__unassigned__', sales: staffById.get(row.salesId)?.name || '待分配',
      registeredOn: date(row.createdAt), identity: row.investorId || '', clientId: row.clientId,
      followStatus: !row.salesId || row.salesStatus !== 'active' ? '待分配' : row.followed ? '已跟进' : '待跟进',
      caseStatus: '尚未建案', caseGroup: 'other', recordCount: 1, _legacy: !!row.legacy,
    })).filter(row => visible(row.registeredOn));
    const liveById = new Map(records.map(row => [row.internalId, row]));
    const cases = all(`SELECT k.id,k.leadId,k.title,k.openedOn,k.status AS rawStatus,n.number AS recordNumber,
      p.record_id AS hasSnapshot,p.stage AS progressStage,p.node AS progressNode
      FROM cases k LEFT JOIN case_numbers n ON n.caseId=k.id
      LEFT JOIN company_record_progress p ON p.kind='case' AND p.record_id=k.id`).flatMap(row => {
      const lead = liveById.get(row.leadId);
      if (!lead || !visible(date(row.openedOn))) return [];
      return [{ ...lead, id: hash('case:' + row.id), number: row.recordNumber ? `AJ-${String(row.recordNumber).padStart(6, '0')}` : '系统案件',
        subtitle: row.title, openedOn: date(row.openedOn), ...classify(row) }];
    });
    const casesByLead = new Map();
    for (const item of cases) {
      if (!casesByLead.has(item.internalId)) casesByLead.set(item.internalId, []);
      casesByLead.get(item.internalId).push(item);
    }
    for (const row of records) {
      const related = casesByLead.get(row.internalId) || [];
      if (related.length) row.caseStatus = [...new Set(related.map(item => item.caseStatus))].join('、');
    }
    const meta = { registryTotal: 0, registryLinked: 0, registryUnlinked: 0, registrySourceTotal: 0, futureRegistryCount: 0,
      importedAt: '', sourceName: '' };
    if (exists('registry_entries')) {
      const columns = new Set(all('PRAGMA table_info(registry_entries)').map(row => row.name));
      const extra = name => columns.has(name) ? `e.${name}` : "''";
      const imported = all(`SELECT e.entry_key,e.source_row,e.customer,e.phone,e.stock_name,e.stock_code,e.source,e.sales,
        e.registered_on,e.stage AS rawStatus,seller.subjectId AS salesId,seller.status AS salesStatus,investor.subjectId AS investorId,
        p.record_id AS hasSnapshot,COALESCE(p.stage,${extra('progress_stage')}) AS progressStage,
        COALESCE(p.node,${extra('progress_node')}) AS progressNode
        FROM registry_entries e LEFT JOIN registry_links l ON l.type='sales' AND l.source_name=e.sales AND l.source_phone=''
        LEFT JOIN identities seller ON seller.id=l.identity_id AND seller.role='sales'
        LEFT JOIN registry_links il ON il.type='investor' AND il.source_name=e.customer AND il.source_phone=e.phone
        LEFT JOIN identities investor ON investor.id=il.identity_id AND investor.role='investor'
        LEFT JOIN company_record_progress p ON p.kind='registry' AND p.record_id=e.entry_key`);
      meta.registrySourceTotal = imported.length;
      for (const row of imported) {
        if (!visible(date(row.registered_on))) { meta.futureRegistryCount++; continue; }
        meta.registryTotal++;
        const linked = row.salesId && staffById.has(row.salesId);
        if (linked) meta.registryLinked++; else meta.registryUnlinked++;
        const item = { id: hash('registry:' + row.entry_key), number: `DJ-${String(row.source_row).padStart(6, '0')}`,
          title: row.customer || '股民姓名待核对', phone: row.phone || '', stockName: row.stock_name || '', stockCode: row.stock_code || '',
          source: row.source || '来源待核对', sourceKey: sourceKey(row.source), origin: 'registry',
          salesId: linked ? row.salesId : '__unlinked__', sales: linked ? staffById.get(row.salesId).name : row.sales || '销售待核对',
          registeredOn: date(row.registered_on), identity: row.investorId || '', clientId: '', followStatus: '跟进待核',
          recordCount: 1, _needsAssociation: !linked || row.salesStatus !== 'active', _signed: signingEvidence(row), ...classify(row) };
        records.push(item); cases.push(item);
      }
      if (exists('registry_meta')) {
        const importedMeta = Object.fromEntries(all("SELECT key,value FROM registry_meta WHERE key IN ('source_name','imported_at')").map(row => [row.key, row.value]));
        meta.importedAt = importedMeta.imported_at || ''; meta.sourceName = importedMeta.source_name || '';
      }
    }
    const recordsBySales = new Map();
    for (const row of records) {
      if (!recordsBySales.has(row.salesId)) recordsBySales.set(row.salesId, []);
      recordsBySales.get(row.salesId).push(row);
    }
    // Resolve identity before applying a source/search filter so a person's key
    // cannot change merely by hiding another record in the same sales scope.
    for (const rows of recordsBySales.values()) resolvePeople(rows);
    return { staff, brokers, records, recordsBySales, cases, meta };
  }

  function customers(records, platform = false) {
    const grouped = new Map();
    for (const row of records) {
      if (!grouped.has(row.personKey)) grouped.set(row.personKey, []);
      grouped.get(row.personKey).push(row);
    }
    return [...grouped].map(([personKey, rows]) => {
      const preferred = rows.find(row => row.origin === 'system') || rows[0];
      const stocks = [...new Set(rows.map(row => [row.stockName, row.stockCode].filter(Boolean).join(' · ')).filter(Boolean))];
      return { id: hash(personKey), title: preferred.title, phone: preferred.phone, origin: mixedOrigin(rows),
        subtitle: stocks.slice(0, 8).join('、') + (stocks.length > 8 ? ` 等 ${stocks.length} 项股票` : ''),
        source: [...new Set(rows.map(row => row.source))].slice(0, 8).join('、'),
        sales: platform ? [...new Set(rows.map(row => row.sales))].join('、') : preferred.sales,
        registeredOn: rows.map(row => row.registeredOn).sort().at(-1) || '', recordCount: rows.length,
        status: rows.some(row => row.unverified) ? '资料待核对' : '身份资料完整',
        unverified: rows.some(row => row.unverified),
        searchText: rows.map(searchText).join('\n') };
    });
  }

  function channels(records, brokers, allBrokers = brokers) {
    const grouped = new Map();
    const add = (key, name) => {
      if (!grouped.has(key)) grouped.set(key, { key, name, records: [], brokers: [] });
      return grouped.get(key);
    };
    for (const broker of brokers) add(sourceKey(broker.name), broker.name).brokers.push(broker);
    for (const record of records) if (record.sourceKey !== '__unknown__') add(record.sourceKey, record.source).records.push(record);
    return [...grouped.values()].map(group => {
      const rows = group.records;
      const accounts = allBrokers.filter(row => sourceKey(row.name) === group.key);
      const sourceStatus = rows.some(row => row.origin === 'registry') || !accounts.length || accounts.some(row => row.accountStatus === 'active') ? 'active'
        : accounts.some(row => row.accountStatus !== 'closed') ? 'pending' : 'closed';
      const status = sourceStatus === 'closed' ? '券商已注销' : sourceStatus === 'pending' ? '券商待开户'
        : accounts.length ? rows.some(row => row.origin === 'registry') ? '历史来源 / 含合作券商' : '含合作券商' : '历史 / 客户来源';
      const origins = [...new Set([...rows.map(row => row.origin), ...(group.brokers.length ? ['system'] : [])])];
      return { id: group.key, key: group.key, sourceKey: group.key, title: group.name, name: group.name,
        origin: origins.length > 1 ? 'mixed' : origins[0], status, sourceStatus,
        registeredOn: [...rows.map(row => row.registeredOn), ...group.brokers.map(row => date(row.signedOn))].sort().at(-1) || '',
        recordCount: rows.length, customerCount: new Set(rows.map(row => row.personKey)).size,
        subtitle: group.brokers.length ? '已登记合作券商及其同名客户来源' : '按登记来源汇总',
        searchText: [group.name, ...rows.map(searchText)].join('\n') };
    }).sort(compareSourceSummary);
  }

  function searchText(row) { return [row.title, row.phone, row.stockName, row.stockCode, row.source, row.sales, row.number, row.subtitle].filter(Boolean).join(' '); }
  function matchesSource(row, source) { return !source || source === '__known__' ? !source || row.sourceKey !== '__unknown__' : row.sourceKey === source; }
  const search = (row, q) => !q || normalize(row.searchText || searchText(row)).includes(q);
  const publicItem = row => {
    const { internalId, identity, clientId, salesId, pair, personKey, searchText, caseGroup, unverified,
      _legacy, _needsAssociation, _signed, ...item } = row;
    return { ...item, status: item.status || item.caseStatus || '', originLabel: originLabel(item.origin) };
  };

  function overview(actor, input = {}) {
    check(actor);
    const f = filters(input);
    return transaction(() => {
      const data = load();
      const rows = data.staff.filter(sales => (!f.salesId || sales.id === f.salesId) && (!f.q || normalize(sales.name).includes(f.q)))
        .map(sales => {
          const records = data.recordsBySales.get(sales.id) || [];
          const clients = customers(records);
          const sources = channels(records, data.brokers.filter(row => row.salesId === sales.id), data.brokers);
          const cases = data.cases.filter(row => row.salesId === sales.id);
          return { id: sales.id, name: sales.name, status: sales.accountStatus === 'closed' ? '已注销' : sales.username ? '正常' : '待开户',
            channelCount: sources.length, channelCustomers: new Set(records.filter(row => row.sourceKey !== '__unknown__').map(row => row.personKey)).size,
            recordCount: records.length, customerCount: clients.length,
            pending: records.filter(row => row.followStatus === '待跟进').length, followed: records.filter(row => row.followStatus === '已跟进').length,
            followUnknown: records.filter(row => row.origin === 'registry').length,
            unassignedCount: records.filter(row => row.followStatus === '待分配').length,
            ongoing: cases.filter(row => row.caseGroup === 'ongoing').length, closed: cases.filter(row => row.caseGroup === 'closed').length,
            unknownCaseCount: cases.filter(row => row.caseGroup === 'unknown').length, otherCaseCount: cases.filter(row => row.caseGroup === 'other').length,
            systemRecordCount: records.filter(row => row.origin === 'system').length, registryRecordCount: records.filter(row => row.origin === 'registry').length,
            unverifiedCustomerCount: clients.filter(row => row.unverified).length,
            sourceUnknownCount: records.filter(row => row.sourceKey === '__unknown__').length,
            sources: sources.map(({ key, name, origin, recordCount, customerCount, sourceStatus }) => ({ key, name, origin, recordCount, customerCount, sourceStatus })) };
        }).sort(compareSalesSummary);
      return { rows, meta: { ...data.meta, today: today() }, notes, orderLabel: orderLabels.sales, sourceOrderLabel: orderLabels.sources };
    }, true);
  }

  function details(actor, input = {}) {
    check(actor);
    const f = filters(input);
    requireValue(f.salesId, '请选择需要查看的销售');
    return transaction(() => {
      const data = load();
      const salesperson = data.staff.find(row => row.id === f.salesId);
      requireValue(salesperson || ['__unlinked__', '__unassigned__'].includes(f.salesId), '销售不存在', 404);
      const filterOrigin = row => f.origin === 'all' || row.origin === f.origin;
      const records = (data.recordsBySales.get(f.salesId) || []).filter(row => filterOrigin(row) && matchesSource(row, f.sourceKey));
      let items;
      if (f.metric === 'channels') {
        const related = data.brokers.filter(row => row.salesId === f.salesId && f.origin !== 'registry' && matchesSource({ sourceKey: sourceKey(row.name) }, f.sourceKey));
        items = channels(records, related, data.brokers);
      } else if (f.metric === 'customers') items = customers(records);
      else if (f.metric === 'records') items = records;
      else items = data.cases.filter(row => row.salesId === f.salesId && row.caseGroup === f.metric && filterOrigin(row) && matchesSource(row, f.sourceKey));
      items = items.filter(row => search(row, f.q));
      if (f.metric !== 'channels') items.sort(compareRecent);
      const offset = Math.min(Math.floor(f.offset / limit), Math.max(0, Math.ceil(items.length / limit) - 1)) * limit;
      return { metric: f.metric, title: titles[f.metric], salesId: f.salesId, salesName: salesperson?.name || (f.salesId === '__unlinked__' ? '待关联历史登记' : '待分配系统留资'),
        total: items.length, offset, limit, items: items.slice(offset, offset + limit).map(publicItem), notes,
        orderLabel: f.metric === 'channels' ? orderLabels.sources : orderLabels.recent };
    }, true);
  }

  function platformFilters(input) {
    const period = input.period ?? 'all', metric = input.metric ?? 'records', q = input.q ?? '', queue = input.queue ?? '';
    const currentDay = today(), offset = String(input.offset ?? '0');
    requireValue(['all', 'month', 'custom'].includes(period), '请选择全部、本月或自选日期');
    requireValue(platformMetrics.some(([key]) => key === metric), '总览分类无效');
    requireValue(typeof q === 'string' && q.length <= 100, '搜索内容最多 100 字');
    requireValue(typeof queue === 'string' && (!queue || pendingQueues.some(([key]) => key === queue)), '待处理分类无效');
    requireValue(/^\d+$/.test(offset) && Number.isSafeInteger(Number(offset)), '分页参数无效');
    let from = period === 'month' ? currentDay.slice(0, 7) + '-01' : '', to = currentDay;
    if (period === 'custom') {
      requireValue(typeof input.from === 'string' && input.from.length === 10 && date(input.from) === input.from &&
        typeof input.to === 'string' && input.to.length === 10 && date(input.to) === input.to, '请填写有效的起止日期');
      requireValue(input.from <= input.to, '开始日期不能晚于结束日期');
      requireValue(input.to <= currentDay, '结束日期不能晚于今天');
      from = input.from; to = input.to;
    }
    return { period, from, to, today: currentDay, metric, q: normalize(q), offset: Number(offset), queue: metric === 'pending' ? queue : '' };
  }

  function attachSigningEvidence(data, currentDay) {
    const known = exists('signings') ? new Map(all('SELECT clientId,signedOn FROM signings').flatMap(row => {
      const signedOn = date(row.signedOn);
      return signedOn && signedOn <= currentDay ? [[row.clientId, signedOn]] : [];
    })) : new Map();
    for (const row of data.records) if (row.origin === 'system' && known.has(row.clientId)) {
      row._signed = true; row.signedOn = known.get(row.clientId);
    }
    const columns = new Set(all('PRAGMA table_info(company_record_progress)').map(row => row.name));
    const snapshots = all(`SELECT kind,record_id,stage AS progressStage,node AS progressNode,
      ${columns.has('completed_nodes') ? 'completed_nodes' : "'[]'"} AS completedNodes FROM company_record_progress`);
    const recordsById = new Map(data.records.map(row => [row.id, row]));
    const casesById = new Map(data.cases.filter(row => row.origin === 'system').map(row => [row.id, row]));
    for (const snapshot of snapshots) {
      if (!signingEvidence(snapshot)) continue;
      const record = snapshot.kind === 'case' ? recordsById.get(hash('lead:' + (casesById.get(hash('case:' + snapshot.record_id))?.internalId || '')))
        : recordsById.get(hash((snapshot.kind === 'lead' ? 'lead:' : 'registry:') + snapshot.record_id));
      if (record) record._signed = true;
    }
  }

  function platformCollections(f, extra = {}) {
      const data = load();
      // A platform customer is resolved globally, never by adding sales subtotals.
      resolvePeople(data.records);
      attachSigningEvidence(data, f.today);
      const signedIds = new Set(data.records.filter(row => row._signed).map(row => hash(row.personKey)));
      const signingDates = new Map();
      for (const row of data.records.filter(row => row.signedOn)) {
        const id = hash(row.personKey);
        if (!signingDates.has(id) || signingDates.get(id) < row.signedOn) signingDates.set(id, row.signedOn);
      }
      const included = value => value ? value <= f.to && (!f.from || value >= f.from) : f.period === 'all';
      const signedPerson = row => signedIds.has(hash(row.personKey));
      const selectedSales = row => !extra.salesId || row.salesId === extra.salesId;
      const selectedOrigin = row => !extra.origin || extra.origin === 'all' || row.origin === extra.origin;
      const selectedSource = row => matchesSource(row, extra.sourceKey);
      let records = data.records.filter(row => included(row.registeredOn) && selectedSales(row) && selectedOrigin(row) && selectedSource(row));
      let cases = data.cases.filter(row => included(row.registeredOn) && selectedSales(row) && selectedOrigin(row) && selectedSource(row));
      if (caseFilters.some(([key]) => key === extra.status)) {
        const allLiveIds = new Set(cases.filter(row => row.origin === 'system').map(row => row.internalId));
        cases = cases.filter(row => row.caseGroup === extra.status);
        const liveIds = new Set(cases.filter(row => row.origin === 'system').map(row => row.internalId));
        records = records.filter(row => row.origin === 'registry' ? row.caseGroup === extra.status
          : liveIds.has(row.internalId) || extra.status === 'other' && !allLiveIds.has(row.internalId));
      } else if (['signed', 'unsigned'].includes(extra.status)) {
        records = records.filter(row => signedPerson(row) === (extra.status === 'signed'));
        const recordIds = new Set(records.map(row => row.id)), liveIds = new Set(records.filter(row => row.origin === 'system').map(row => row.internalId));
        cases = cases.filter(row => row.origin === 'registry' ? recordIds.has(row.id) : liveIds.has(row.internalId));
      }
      const clients = customers(records, true);
      const byQueue = {
        system_new: records.filter(row => row.origin === 'system' && row.followStatus === '待分配' && !row._legacy),
        system_legacy: records.filter(row => row.origin === 'system' && row.followStatus === '待分配' && row._legacy),
        registry_unlinked: records.filter(row => row.origin === 'registry' && row._needsAssociation),
      };
      const pending = Object.entries(byQueue).flatMap(([queue, rows]) => rows.map(row => ({ ...row, queue,
        status: queue === 'registry_unlinked' ? '待关联 / 调整销售' : row.followStatus })));
      const brokers = data.brokers.filter(row => included(date(row.signedOn)) && selectedSales(row) &&
        extra.origin !== 'registry' && selectedSource({ sourceKey: sourceKey(row.name) }) && (!extra.status || extra.status === 'all'));
      const collections = {
        records, customers: clients,
        channels: channels(records, brokers, data.brokers), pending, cases,
        ongoing: cases.filter(row => row.caseGroup === 'ongoing'), closed: cases.filter(row => row.caseGroup === 'closed'),
        registry: records.filter(row => row.origin === 'registry'),
        signed: clients.filter(row => signedIds.has(row.id)).map(row => ({ ...row, status: '已签约', signedOn: signingDates.get(row.id) || '' })),
      };
      return { data, records, clients, cases, brokers, byQueue, pending, collections };
  }

  function platformNotes(data) {
    const unknownDateCount = data.records.filter(row => !row.registeredOn).length;
    const rows = [
      '当前测试按留资 / 材料登记日期筛选，签约和案件展示当前状态；正式上线将按各业务实际发生日期统计。',
      '统计包含小程序业务及全部历史登记，包括尚未关联销售的登记；客户档案在全平台合并核对，缺资料的记录保留独立档案。',
      '来源渠道包含合作券商和历史来源分类；案件仅按明确进度计数，不将未确认进度视为在办。',
      '历史登记没有完整签约信息，已签约仅采用实际签约记录或公司明确同步的签约状态。',
    ];
    if (unknownDateCount) rows.push(`${unknownDateCount} 条记录缺少有效登记日期，仅计入全部累计。`);
    return rows;
  }

  function platformMeta({ data, records, clients, collections }) {
    return { ...data.meta, systemRecordCount: records.filter(row => row.origin === 'system').length,
      registryCount: collections.registry.length, unverifiedCustomerCount: clients.filter(row => row.unverified).length,
      sourceUnknownCount: records.filter(row => row.sourceKey === '__unknown__').length,
      unknownDateCount: data.records.filter(row => !row.registeredOn).length };
  }

  function platformBoard(actor, input = {}) {
    check(actor);
    const f = platformFilters(input);
    return transaction(() => {
      const result = platformCollections(f);
      const { data, records, byQueue, pending, collections } = result;
      const metrics = platformMetrics.map(([key, label, unit]) => ({ key, label, unit, value: collections[key].length }));
      const scoped = f.queue ? pending.filter(row => row.queue === f.queue) : collections[f.metric];
      const matching = scoped.filter(row => search(row, f.q));
      if (f.metric !== 'channels') matching.sort(f.metric === 'pending' ? comparePending : compareRecent);
      const offset = Math.min(Math.floor(f.offset / limit), Math.max(0, Math.ceil(matching.length / limit) - 1)) * limit;
      return { period: f.period, from: f.from, to: f.to, today: f.today, metrics, selected: f.metric,
        title: metrics.find(row => row.key === f.metric).label, queue: f.queue,
        total: matching.length, scopeTotal: scoped.length, offset, limit, items: matching.slice(offset, offset + limit).map(publicItem),
        meta: platformMeta(result), notes: platformNotes(data),
        orderLabel: f.metric === 'pending' ? orderLabels.pending : f.metric === 'channels' ? orderLabels.sources : orderLabels.recent,
        queues: pendingQueues.map(([key, label]) => ({ key, label, value: byQueue[key].length, unit: '条' })),
        recent: records.slice().sort(compareRecent).slice(0, 6).map(publicItem) };
    }, true);
  }

  function recordsReport(actor, input = {}, exportAll = false) {
    check(actor);
    const type = input.type ?? 'records', source = input.sourceKey ?? '', salesId = input.salesId ?? '',
      origin = input.origin ?? 'all', status = input.status ?? 'all';
    requireValue(Object.hasOwn(dataTypes, type), '数据类型无效');
    requireValue(typeof salesId === 'string' && salesId.length <= 100, '销售参数无效');
    requireValue(typeof source === 'string' && (!source || ['__known__', '__unknown__'].includes(source) || /^[a-f0-9]{64}$/.test(source)), '来源参数无效');
    requireValue(['all', 'system', 'registry'].includes(origin), '数据来源无效');
    const statuses = type === 'cases' || type === 'records' ? caseFilters : type === 'customers' ? [['signed', '已签约'], ['unsigned', '签约未确认']] : [];
    requireValue(status === 'all' || statuses.some(([key]) => key === status), '状态筛选无效');
    const f = platformFilters({ ...input, metric: 'records', queue: '' });
    return transaction(() => {
      const result = platformCollections(f, { sourceKey: source, salesId, origin, status });
      const { data, records, cases, brokers, collections } = result;
      requireValue(!salesId || data.staff.some(row => row.id === salesId) || ['__unlinked__', '__unassigned__'].includes(salesId), '销售不存在', 404);
      let rows;
      if (type === 'sales') {
        const staff = [...data.staff, { id: '__unlinked__', name: '未关联销售' }, { id: '__unassigned__', name: '未分配销售' }];
        rows = staff.filter(row => !salesId || row.id === salesId).map(person => {
          const own = records.filter(row => row.salesId === person.id), ownedCases = cases.filter(row => row.salesId === person.id);
          const sources = channels(own, brokers.filter(row => row.salesId === person.id), data.brokers);
          return { id: person.id, name: person.name, title: person.name,
            status: person.id.startsWith('__') ? '待关联 / 分配' : person.accountStatus === 'closed' ? '已注销' : person.username ? '正常' : '待开户',
            channelCount: sources.length, recordCount: own.length, customerCount: customers(own).length,
            ongoing: ownedCases.filter(row => row.caseGroup === 'ongoing').length, closed: ownedCases.filter(row => row.caseGroup === 'closed').length,
            unknown: ownedCases.filter(row => row.caseGroup === 'unknown').length, other: ownedCases.filter(row => row.caseGroup === 'other').length,
            searchText: [person.name, ...own.map(searchText)].join('\n') };
        }).filter(row => !row.id.startsWith('__') || row.recordCount);
      } else if (type === 'channels') {
        rows = collections.channels.map(channel => {
          const own = records.filter(row => row.sourceKey === channel.key), ownedCases = cases.filter(row => row.sourceKey === channel.key);
          const brokerSales = brokers.filter(row => sourceKey(row.name) === channel.key).map(row => data.staff.find(person => person.id === row.salesId)?.name).filter(Boolean);
          return { ...channel, sales: [...new Set([...own.map(row => row.sales), ...brokerSales])].join('、'),
            ongoing: ownedCases.filter(row => row.caseGroup === 'ongoing').length, closed: ownedCases.filter(row => row.caseGroup === 'closed').length };
        });
      } else rows = collections[type];
      rows = rows.filter(row => search(row, f.q));
      if (type === 'sales') rows.sort(compareSalesSummary);
      else if (type !== 'channels') rows.sort(compareRecent);
      const offset = exportAll ? 0 : Math.min(Math.floor(f.offset / limit), Math.max(0, Math.ceil(rows.length / limit) - 1)) * limit;
      const options = channels(data.records, data.brokers).map(({ key, name }) => ({ key, name }));
      if (data.records.some(row => row.sourceKey === '__unknown__')) options.push({ key: '__unknown__', name: '来源待核对' });
      return { type, title: dataTypes[type], period: f.period, from: f.from, to: f.to, today: f.today,
        definition: type === 'cases' ? '包括系统案件与历史登记的当前案件进度；待核、未立案等进度单列，均可筛选。'
          : type === 'sales' ? '按当前经办 / 台账关联销售汇总；同档案可能涉及多位销售，各销售数量不能直接相加作为平台人数。'
            : '与数据总览采用同一数据范围；系统业务与全部历史登记均可按日期、来源和销售检索。',
        columns: reportColumns[type], total: rows.length, offset, limit: exportAll ? rows.length : limit,
        items: (exportAll ? rows : rows.slice(offset, offset + limit)).map(publicItem),
        filters: { sales: [...data.staff, { id: '__unlinked__', name: '未关联销售' }, { id: '__unassigned__', name: '未分配销售' }]
          .sort(compareAccounts).map(({ id, name }) => ({ id, name })),
          sources: options, statuses: statuses.map(([key, label]) => ({ key, label })) },
        notes: platformNotes(data), meta: platformMeta(result),
        orderLabel: type === 'sales' ? orderLabels.sales : type === 'channels' ? orderLabels.sources : orderLabels.recent };
    }, true);
  }

  return { overview, details, platformBoard, recordsReport };
}
