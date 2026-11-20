import { createSigningEvidence } from './signing-evidence.mjs';
import { createLeadSigningScope, currentRelatedCases, resolveCaseProgress, resolveLeadProgress } from './lead-progress.mjs';
import { summarizeProgress } from './board-progress.mjs';
import { recordDate as dateOf } from './user-records.mjs';
import { compareRecent, orderLabels } from './web/list-order.js';
const definitions = [['customers', '我的客户', '人', 'customer'], ['ongoing', '在办案件', '件', 'case'],
  ['closed', '已结案件', '件', 'case'], ['effective', '已签约客户', '人', 'customer'],
  ['signings', '签约登记人数', '人', 'customer']];
const descriptions = {
  customers: '当前归属本券商的客户，按登记日期筛选；尚未提交股票资料的客户按注册日期筛选。',
  ongoing: '当前归属本券商、目前仍在办理的案件，按对应股票的登记日期筛选。',
  closed: '当前归属本券商、目前已经结案的案件，按对应股票的登记日期筛选。',
  effective: '当前归属本券商且已确认签约的客户，包含已确认签约的历史资料，不要求填写签约日期；按登记日期筛选。',
  signings: '仅统计当前归属本券商且填写了实际签约日期的客户，按实际签约日期筛选；缺少签约日期的历史签约不计入。',
};
const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

// Broker access follows explicit customer ownership. A spreadsheet source label
// is not proof that a broker account may access every customer under that label.
export function createBrokerBoard(db, { requireValue, transaction, today, userRecords }) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  return (actor, input = {}) => {
    requireValue(actor?.role === 'broker' && !actor.passwordChangeRequired, '当前账号无权查看券商看板', 403);
    const period = input.period ?? 'all', selected = input.metric ?? 'customers', currentDay = today();
    const query = input.q === undefined ? '' : input.q;
    requireValue(typeof query === 'string' && query.length <= 100, '查询内容最多 100 字');
    const q = query.trim(), normalizedQuery = normalize(q);
    requireValue(['all', 'month', 'custom'].includes(period), '请选择全部、本月或自选日期');
    requireValue(definitions.some(([key]) => key === selected), '看板分类无效');
    const ledger = input.ledger || 'all';
    requireValue(['all', 'negotiating', 'signed'].includes(ledger), '客户台账状态无效');
    requireValue(/^\d+$/.test(String(input.offset ?? 0)) && Number.isSafeInteger(Number(input.offset ?? 0)), '分页参数无效');
    const requestedLimit = input.limit === undefined ? 20 : input.limit;
    requireValue([5, 20, '5', '20'].includes(requestedLimit), '每页条数只能选择 5 或 20');
    const limit = Number(requestedLimit);
    let from = period === 'month' ? currentDay.slice(0, 7) + '-01' : '', to = currentDay;
    if (period === 'custom') {
      requireValue(validDate(input.from) && validDate(input.to), '请填写有效的起止日期');
      requireValue(input.from <= input.to, '起始日期不能晚于结束日期');
      requireValue(input.to <= currentDay, '结束日期不能晚于今天');
      from = input.from; to = input.to;
    }
    return transaction(() => {
      const signed = createSigningEvidence(db);
      const signingScope = createLeadSigningScope(db);
      const testing = all('PRAGMA table_info(company_record_progress)').some(row => row.name === 'testing') ? 'p.testing' : '0';
      const clients = all(`SELECT c.id,c.name,c.createdAt,s.signedOn FROM clients c
        LEFT JOIN signings s ON s.clientId=c.id WHERE c.brokerId=?`, actor.id);
      const linkedRecords = userRecords ? userRecords.all(actor).filter(row => row.recordKind === 'registry') : [];
      const leads = all(`SELECT l.id,l.clientId,l.stockName,l.stockCode,l.createdAt,s.signedOn,
        p.record_id AS hasSnapshot,p.stage AS progressStage,p.node AS progressNode,p.completed_nodes AS completedNodes,${testing} AS testing
        FROM leads l JOIN clients c ON c.id=l.clientId LEFT JOIN signings s ON s.clientId=c.id
        LEFT JOIN company_record_progress p ON p.kind='lead' AND p.record_id=l.id WHERE c.brokerId=?`, actor.id);
      const cases = all(`SELECT k.id,k.leadId,k.clientId,k.title,k.status,k.openedOn,k.createdAt,k.stockName,k.stockCode,
        p.record_id AS hasSnapshot,p.stage AS progressStage,p.node AS progressNode,p.completed_nodes AS completedNodes,${testing} AS testing FROM
        (SELECT ca.*,l.clientId,l.createdAt,l.stockName,l.stockCode FROM cases ca JOIN leads l ON l.id=ca.leadId
          JOIN clients c ON c.id=l.clientId WHERE c.brokerId=?) k
        LEFT JOIN company_record_progress p ON p.kind='case' AND p.record_id=k.id`, actor.id);
      const included = date => date ? date <= to && (!from || date >= from) : period === 'all';
      const current = date => !date || date <= currentDay;
      const casesByLead = new Map();
      const currentCases = currentRelatedCases(cases.filter(row => current(dateOf(row.createdAt))), currentDay);
      // Broker records use the neutral sales wording, without granting progress
      // detail access or exposing any sales-only fields.
      const caseProgress = new Map(currentCases.map(row => [row.id, resolveCaseProgress({ ...row, rawStatus: row.status }, 'sales', currentDay)]));
      for (const row of currentCases) {
        if (!casesByLead.has(row.leadId)) casesByLead.set(row.leadId, []);
        casesByLead.get(row.leadId).push({ ...row, rawStatus: row.status });
      }
      const leadMap = new Map(), signEvidence = new Set(), names = new Map(clients.map(row => [row.id, row.name || '待留资客户']));
      for (const row of leads) {
        row.registeredOn = dateOf(row.createdAt);
        row.status = resolveLeadProgress({ ...row, signingMatch: signingScope(row, currentDay) },
          casesByLead.get(row.id) || [], 'sales', currentDay).status;
        if (!leadMap.has(row.clientId)) leadMap.set(row.clientId, []);
        leadMap.get(row.clientId).push(row);
        if (current(row.registeredOn) && signed('lead',row.id,row,currentDay)) signEvidence.add(row.clientId);
      }
      for (const row of linkedRecords) {
        if (!leadMap.has(row.clientId)) leadMap.set(row.clientId, []);
        leadMap.get(row.clientId).push(row);
        if (current(row.registeredOn) && row.signed) signEvidence.add(row.clientId);
      }
      for (const row of currentCases) if (signed('case',row.id,row,currentDay)) signEvidence.add(row.clientId);
      const customers = [], allCustomers = [];
      for (const client of clients) {
        const allLeads = (leadMap.get(client.id) || []).filter(row => current(row.registeredOn));
        const members = allLeads.length ? allLeads : [{ registeredOn: dateOf(client.createdAt), prospect: true, status: '待留资' }];
        const currentMembers = members.filter(row => current(row.registeredOn));
        if (!currentMembers.length) continue;
        const signedOn = validDate(client.signedOn) && client.signedOn <= currentDay ? client.signedOn : '';
        const toCard = rows => {
          const stocks = [...new Set(rows.filter(row => !row.prospect).map(row => [row.stockName,row.stockCode].filter(Boolean).join(' · ')))];
          return { id: client.id, customerId: client.id, title: client.name || '待留资客户', subtitle: stocks.slice(0, 8).join('、') || '待留资',
            searchTerms: [client.name || '待留资客户', ...rows.flatMap(row => [row.stockName, row.stockCode])],
            status: summarizeProgress(rows.map(row => row.status)),
            signingStatus: signedOn || signEvidence.has(client.id) ? '已签约' : '洽谈中', signedOn,
            registeredOn: rows.map(row => row.registeredOn).filter(Boolean).sort().at(-1) || '',
            unknownDate: rows.some(row => !row.registeredOn), sourceType: '本券商客户', recordCount: rows.filter(row => !row.prospect).length };
        };
        allCustomers.push(toCard(currentMembers));
        const visible = members.filter(row => included(row.registeredOn));
        if (visible.length) customers.push(toCard(visible));
      }
      const caseCards = currentCases.map(row => ({
        id: row.id, customerId: row.clientId, title: names.get(row.clientId) || '待留资客户', subtitle: row.title || row.stockName || '案件名称待核对',
        searchTerms: [names.get(row.clientId), row.title, row.stockName, row.stockCode],
        status: caseProgress.get(row.id).status,
        group: caseProgress.get(row.id).caseGroup, registeredOn: dateOf(row.createdAt), openedOn: dateOf(row.openedOn), sourceType: '本券商案件',
      }));
      for (const row of linkedRecords) caseCards.push({ id: row.id, customerId: row.clientId,
        title: names.get(row.clientId) || row.customer, subtitle: [row.stockName, row.stockCode].filter(Boolean).join(' · '),
        searchTerms: [names.get(row.clientId) || row.customer, row.stockName, row.stockCode],
        status: row.status, group: row.caseGroup, registeredOn: row.registeredOn, sourceType: '本券商案件' });
      const signings = allCustomers.filter(row => row.signedOn && included(row.signedOn));
      const collection = { customers, effective: customers.filter(row => row.signingStatus === '已签约'), signings,
        ongoing: caseCards.filter(row => row.group === 'ongoing' && included(row.registeredOn)),
        closed: caseCards.filter(row => row.group === 'closed' && included(row.registeredOn)) };
      const allCollections = { customers: allCustomers, effective: allCustomers.filter(row => row.signingStatus === '已签约'), signings: allCustomers.filter(row => row.signedOn),
        ongoing: caseCards.filter(row => row.group === 'ongoing'), closed: caseCards.filter(row => row.group === 'closed') };
      const metrics = definitions.map(([key,label,unit,kind]) => ({ key,label: key === 'signings' ? (period === 'month' ? '本月新增签约' : period === 'custom' ? '期间新增签约' : '签约登记人数') : label,unit,kind,value:collection[key].length,
        description: descriptions[key],
        dateLabel: key === 'signings' ? '实际签约日期' : '登记日期（未提交股票资料的客户按注册日期）',
        unknownDateCount: key === 'signings' ? 0 : allCollections[key].filter(row => (row.unknownDate || !row.registeredOn) && !collection[key].some(item => item.id === row.id)).length }));
      // Overview metrics always describe the date/ownership scope. The ledger
      // and text controls narrow only customer details, never the cards above.
      const scopedItems = ['customers', 'effective'].includes(selected) ? collection[selected].filter(row => ledger === 'all' ||
        (ledger === 'signed' ? row.signingStatus === '已签约' : row.signingStatus !== '已签约')) : collection[selected];
      const scopeTotal = scopedItems.length;
      const items = scopedItems.filter(row => !normalizedQuery || row.searchTerms.some(value => normalize(value).includes(normalizedQuery)))
        .sort(selected === 'signings'
        ? (a, b) => compareRecent({ ...a, registeredOn: a.signedOn }, { ...b, registeredOn: b.signedOn }) : compareRecent);
      const offset = Math.min(Math.floor(Number(input.offset || 0) / limit), Math.max(0, Math.ceil(items.length / limit) - 1)) * limit;
      return { period,from,to,today:currentDay,selected,ledger,q,metrics,scopeTotal,total:items.length,offset,limit,
        orderLabel: selected === 'signings' ? '按实际签约日期从新到旧排序。' : orderLabels.recent,
        items:items.slice(offset,offset + limit).map(({group,searchTerms,...row}) => row),
        notes:['客户与案件按登记日期筛选；未提交股票资料的客户按注册日期，展示当前状态。',
          '已签约客户包含已明确关联的历史已立案及后续阶段客户；缺失的实际签约日期留空。',
          ...(selected === 'signings' ? ['签约登记人数 / 本月新增签约 / 期间新增签约按实际签约日期统计，缺少签约日期的记录不计入。'] : []),
          '只显示明确归属本券商的客户与股票记录，按当前归属实时更新。'] };
    }, true);
  };
}
