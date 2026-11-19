import { hasSigningEvidence, classifyCase } from './data-semantics.mjs';
import { compareRecent, orderLabels } from './web/list-order.js';
const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const definitions = [['customers', '我的客户', '人', 'customer'], ['ongoing', '在办案件', '件', 'case'],
  ['closed', '已结案件', '件', 'case'], ['effective', '当前已签约客户', '人', 'customer'],
  ['signings', '累计签约', '人', 'customer']];
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const dateOf = value => validDate(value) ? value : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
  && Number.isFinite(Date.parse(value)) ? businessDate.format(new Date(value)) : '';
const signed = row => hasSigningEvidence({ progressStage: row.stage, progressNode: row.node, completedNodes: row.completed_nodes });
const caseGroup = row => classifyCase({ hasSnapshot: row.snapshot, progressStage: row.stage, progressNode: row.node, rawStatus: row.status }).caseGroup;

// Broker access follows explicit customer ownership. A spreadsheet source label
// is not proof that a broker account may access every customer under that label.
export function createBrokerBoard(db, { requireValue, transaction, today }) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  return (actor, input = {}) => {
    requireValue(actor?.role === 'broker' && !actor.passwordChangeRequired, '当前账号无权查看券商看板', 403);
    const period = input.period ?? 'all', selected = input.metric ?? 'customers', currentDay = today();
    requireValue(['all', 'month', 'custom'].includes(period), '请选择全部、本月或自选日期');
    requireValue(definitions.some(([key]) => key === selected), '看板分类无效');
    const ledger = input.ledger || 'all';
    requireValue(['all', 'negotiating', 'signed'].includes(ledger), '客户台账状态无效');
    requireValue(/^\d+$/.test(String(input.offset ?? 0)) && Number.isSafeInteger(Number(input.offset ?? 0)), '分页参数无效');
    let from = period === 'month' ? currentDay.slice(0, 7) + '-01' : '', to = currentDay;
    if (period === 'custom') {
      requireValue(validDate(input.from) && validDate(input.to), '请填写有效的起止日期');
      requireValue(input.from <= input.to, '起始日期不能晚于结束日期');
      requireValue(input.to <= currentDay, '结束日期不能晚于今天');
      from = input.from; to = input.to;
    }
    return transaction(() => {
      const clients = all(`SELECT c.id,c.name,c.createdAt,s.signedOn FROM clients c
        LEFT JOIN signings s ON s.clientId=c.id WHERE c.brokerId=?`, actor.id);
      const leads = all(`SELECT l.id,l.clientId,l.stockName,l.stockCode,l.createdAt,
        p.stage,p.node,p.completed_nodes FROM leads l JOIN clients c ON c.id=l.clientId
        LEFT JOIN company_record_progress p ON p.kind='lead' AND p.record_id=l.id WHERE c.brokerId=?`, actor.id);
      const cases = all(`SELECT k.id,k.clientId,k.title,k.status,k.openedOn,k.createdAt,k.stockName,k.stockCode,
        p.record_id AS snapshot,p.stage,p.node,p.completed_nodes FROM
        (SELECT ca.*,l.clientId,l.createdAt,l.stockName,l.stockCode FROM cases ca JOIN leads l ON l.id=ca.leadId
          JOIN clients c ON c.id=l.clientId WHERE c.brokerId=?) k
        LEFT JOIN company_record_progress p ON p.kind='case' AND p.record_id=k.id`, actor.id);
      const included = date => date ? date <= to && (!from || date >= from) : period === 'all';
      const current = date => !date || date <= currentDay;
      const leadMap = new Map(), signEvidence = new Set(), names = new Map(clients.map(row => [row.id, row.name || '待留资客户']));
      for (const row of leads) {
        row.registeredOn = dateOf(row.createdAt);
        if (!leadMap.has(row.clientId)) leadMap.set(row.clientId, []);
        leadMap.get(row.clientId).push(row);
        if (current(row.registeredOn) && signed(row)) signEvidence.add(row.clientId);
      }
      for (const row of cases) if (current(dateOf(row.createdAt)) && current(dateOf(row.openedOn)) && signed(row)) signEvidence.add(row.clientId);
      const customers = [], allCustomers = [];
      for (const client of clients) {
        const allLeads = (leadMap.get(client.id) || []).filter(row => current(row.registeredOn));
        const members = allLeads.length ? allLeads : [{ registeredOn: dateOf(client.createdAt), prospect: true }];
        const currentMembers = members.filter(row => current(row.registeredOn));
        if (!currentMembers.length) continue;
        const signedOn = validDate(client.signedOn) && client.signedOn <= currentDay ? client.signedOn : '';
        const toCard = rows => {
          const stocks = [...new Set(rows.filter(row => !row.prospect).map(row => [row.stockName,row.stockCode].filter(Boolean).join(' · ')))];
          return { id: client.id, title: client.name || '待留资客户', subtitle: stocks.slice(0, 8).join('、') || '待留资',
            status: signedOn || signEvidence.has(client.id) ? '已签约' : '洽谈中', signedOn,
            registeredOn: rows.map(row => row.registeredOn).filter(Boolean).sort().at(-1) || '',
            unknownDate: rows.some(row => !row.registeredOn), sourceType: '本券商客户', recordCount: rows.filter(row => !row.prospect).length };
        };
        allCustomers.push(toCard(currentMembers));
        const visible = members.filter(row => included(row.registeredOn));
        if (visible.length) customers.push(toCard(visible));
      }
      const caseCards = cases.filter(row => current(dateOf(row.openedOn)) && current(dateOf(row.createdAt))).map(row => ({
        id: row.id, title: names.get(row.clientId) || '待留资客户', subtitle: row.title || row.stockName || '案件名称待核对',
        status: classifyCase({ hasSnapshot: row.snapshot, progressStage: row.stage, progressNode: row.node, rawStatus: row.status }).caseStatus,
        group: caseGroup(row), registeredOn: dateOf(row.createdAt), openedOn: dateOf(row.openedOn), sourceType: '本券商案件',
      }));
      const signings = allCustomers.filter(row => row.signedOn && included(row.signedOn));
      const ledgerCustomers = customers.filter(row => ledger === 'all' || (ledger === 'signed' ? row.status === '已签约' : row.status !== '已签约'));
      const collection = { customers: ledgerCustomers, effective: ledgerCustomers.filter(row => row.status === '已签约'), signings,
        ongoing: caseCards.filter(row => row.group === 'ongoing' && included(row.registeredOn)),
        closed: caseCards.filter(row => row.group === 'closed' && included(row.registeredOn)) };
      const allLedgerCustomers = allCustomers.filter(row => ledger === 'all' || (ledger === 'signed' ? row.status === '已签约' : row.status !== '已签约'));
      const allCollections = { customers: allLedgerCustomers, effective: allLedgerCustomers.filter(row => row.status === '已签约'), signings: allCustomers.filter(row => row.signedOn),
        ongoing: caseCards.filter(row => row.group === 'ongoing'), closed: caseCards.filter(row => row.group === 'closed') };
      const metrics = definitions.map(([key,label,unit,kind]) => ({ key,label: key === 'signings' ? (period === 'month' ? '本月新增签约' : period === 'custom' ? '期间新增签约' : '累计签约') : label,unit,kind,value:collection[key].length,
        dateLabel: key === 'signings' ? '实际签约日期' : '留资日期（未留资客户按注册日期）',
        unknownDateCount: key === 'signings' ? 0 : allCollections[key].filter(row => (row.unknownDate || !row.registeredOn) && !collection[key].some(item => item.id === row.id)).length }));
      const items = collection[selected].sort(selected === 'signings'
        ? (a, b) => compareRecent({ ...a, registeredOn: a.signedOn }, { ...b, registeredOn: b.signedOn }) : compareRecent);
      const limit = 20, offset = Math.min(Math.floor(Number(input.offset || 0) / limit), Math.max(0, Math.ceil(items.length / limit) - 1)) * limit;
      return { period,from,to,today:currentDay,selected,ledger,metrics,total:items.length,offset,limit,
        orderLabel: selected === 'signings' ? '按实际签约日期从新到旧排序。' : orderLabels.recent,
        items:items.slice(offset,offset + limit).map(({group,...row}) => row),
        notes:['客户与案件按留资日期筛选；未留资客户按注册日期，展示当前状态。',
          '累计签约 / 本月新增签约 / 期间新增签约按实际签约日期统计，缺少签约日期的记录不计入。',
          '只显示明确归属本券商的客户与案件；历史表的来源分类不会自动变成券商客户归属。'] };
    }, true);
  };
}
