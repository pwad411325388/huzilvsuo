import { createHash } from 'node:crypto';
import { hasSigningEvidence as signed, classifyCase } from './data-semantics.mjs';
import { accountRank, compareRecent, compareSourceSummary, orderLabels } from './web/list-order.js';

const pageSize = 20;
const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const key = value => createHash('sha256').update(value).digest('hex');
const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
const metricDefinitions = [
  ['channels', '来源渠道', '个', 'channel'], ['customers', '客户档案', '份', 'customer'],
  ['effective', '已签约客户', '人', 'customer'], ['closed', '已结案', '件', 'case'],
];

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function localDate(value) {
  if (validDate(value)) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return '';
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? businessDate.format(parsed) : '';
}

function personPair(name, phone) {
  const fullName = normalize(name), fullPhone = String(phone || '').normalize('NFKC').trim();
  if (!/^1\d{10}$/.test(fullPhone) || !fullName || /[*＊]/.test(fullName) ||
      /^(?:股民姓名待核对|待留资客户|未知|不详|未登记|无|待核对|[-—–/\s]+)$/.test(fullName)) return '';
  return JSON.stringify([fullName, fullPhone]);
}

function closed(record) {
  return classifyCase({ ...record, rawStatus: record.status }).caseGroup === 'closed';
}

function stockSummary(members) {
  const stocks = new Map();
  let records = 0;
  for (const member of members) {
    records += member.recordCount;
    for (const stock of member.stocks) {
      const stockKey = JSON.stringify([normalize(stock.name), normalize(stock.code)]);
      if (stock.name || stock.code) stocks.set(stockKey, stock.name && stock.code ? `${stock.name}（${stock.code}）` : stock.name || stock.code);
    }
  }
  return [Array.from(stocks.values()).slice(0, 8).join('、') + (stocks.size > 8 ? ` 等 ${stocks.size} 项股票` : ''),
    `${records} 条登记`].filter(Boolean).join(' · ');
}

// This read model joins only records already authorized to this salesperson.
// Imported source categories remain categories; they never create broker ownership.
export function createSalesBoard(db, { requireValue, transaction, today, caseCutoff }) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  function period(input) {
    const period = input.period ?? 'all', selected = input.metric ?? 'channels', currentDay = today();
    requireValue(['all', 'month', 'custom'].includes(period), '请选择全部、本月或自选日期');
    requireValue(metricDefinitions.some(([name]) => name === selected), '看板分类无效');
    const offset = String(input.offset ?? '0');
    requireValue(/^\d+$/.test(offset) && Number.isSafeInteger(Number(offset)), '分页参数无效');
    let from = period === 'month' ? currentDay.slice(0, 7) + '-01' : '', to = currentDay;
    if (period === 'custom') {
      requireValue(validDate(input.from) && validDate(input.to), '请填写有效的起止日期');
      requireValue(input.from <= input.to, '起始日期不能晚于结束日期');
      requireValue(input.to <= currentDay, '结束日期不能晚于今天');
      from = input.from; to = input.to;
    }
    return { period, selected, from, to, today: currentDay, offset: Number(offset), limit: pageSize };
  }

  function load(actor, currentDay) {
    const brokers = all(`SELECT b.id,b.name,b.signedOn,i.status AS accountStatus FROM brokers b
      LEFT JOIN identities i ON i.role='broker' AND i.subjectId=b.id WHERE b.salesId=?`, actor.id);
    const clients = all(`SELECT c.*,s.signedOn,i.subjectId AS identitySubjectId,b.name AS brokerName,bi.status AS brokerAccountStatus
      FROM clients c LEFT JOIN brokers b ON b.id=c.brokerId LEFT JOIN signings s ON s.clientId=c.id
      LEFT JOIN identities i ON i.role='investor' AND i.subjectId=c.id
      LEFT JOIN identities bi ON bi.role='broker' AND bi.subjectId=b.id
      WHERE EXISTS(SELECT 1 FROM leads l JOIN lead_assignments a ON a.leadId=l.id
        WHERE l.clientId=c.id AND a.salesId=?)`, actor.id);
    const assignmentColumns = new Set(all('PRAGMA table_info(lead_assignments)').map(row => row.name));
    const leads = all(`SELECT l.id,l.clientId,l.stockName,l.stockCode,l.createdAt,a.salesId,
      ${assignmentColumns.has('contactName') ? 'COALESCE(a.contactName,c.name)' : 'c.name'} AS customer,
      ${assignmentColumns.has('contactPhone') ? 'COALESCE(a.contactPhone,c.phone)' : 'c.phone'} AS phone,
      p.stage AS progressStage,p.node AS progressNode,p.completed_nodes AS completedNodes
      FROM leads l JOIN clients c ON c.id=l.clientId LEFT JOIN brokers b ON b.id=c.brokerId
      LEFT JOIN lead_assignments a ON a.leadId=l.id
      LEFT JOIN company_record_progress p ON p.kind='lead' AND p.record_id=l.id
      WHERE a.salesId=?`, actor.id);
    const cases = all(`SELECT k.*,l.clientId,l.stockName,l.stockCode,a.salesId,
      p.record_id AS hasSnapshot,p.stage AS progressStage,p.node AS progressNode,p.completed_nodes AS completedNodes
      FROM cases k JOIN leads l ON l.id=k.leadId JOIN clients c ON c.id=l.clientId
      LEFT JOIN brokers b ON b.id=c.brokerId LEFT JOIN lead_assignments a ON a.leadId=l.id
      LEFT JOIN company_record_progress p ON p.kind='case' AND p.record_id=k.id
      WHERE a.salesId=?`, actor.id);
    const visibleLeads = leads.filter(row => !localDate(row.createdAt) || localDate(row.createdAt) <= currentDay);
    const leadById = new Map(visibleLeads.map(row => [row.id, row]));
    const clientsById = new Map(clients.map(row => [row.id, row]));
    const casesByLead = new Map();
    for (const row of cases.filter(row => leadById.has(row.leadId) && (!localDate(row.openedOn) || localDate(row.openedOn) <= currentDay))) {
      if (!casesByLead.has(row.leadId)) casesByLead.set(row.leadId, []);
      casesByLead.get(row.leadId).push(row);
    }
    // Each stock registration has its own cohort date. An account's creation date
    // must not hide a later lead or pull an out-of-period stock into its summary.
    const people = visibleLeads.map(lead => {
      const client = clientsById.get(lead.clientId), ownCases = casesByLead.get(lead.id) || [];
      const signedOn = validDate(client.signedOn) && client.signedOn <= currentDay ? client.signedOn : '';
      return { id: 'lead:' + lead.id, identity: client.identitySubjectId || '', local: true,
        clientId: client.id, name: lead.customer || '待留资客户', phone: lead.phone || '', registeredOn: localDate(lead.createdAt),
        signed: !!signedOn || signed(lead) || ownCases.some(signed), signedOn,
        stocks: [{ name: lead.stockName, code: lead.stockCode }], recordCount: 1,
        sources: [client.brokerName || '自然流入'], sourceType: '系统留资',
        formalSource: !!client.brokerId, sourceStatus: client.brokerAccountStatus || 'pending',
        progress: lead.salesId === actor.id ? { kind: 'lead', progressId: lead.id } : {},
      };
    });
    let registryRows = [];
    if (one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registry_entries'")) {
      const columns = new Set(all('PRAGMA table_info(registry_entries)').map(row => row.name));
      const extra = name => columns.has(name) ? 'e.' + name : "''";
      registryRows = all(`SELECT e.entry_key AS entryKey,e.customer,e.phone,e.stock_name AS stockName,
        e.stock_code AS stockCode,e.source,e.registered_on AS registeredOn,e.stage AS status,
        investor.subjectId AS identitySubjectId,p.record_id AS hasSnapshot,
        COALESCE(p.stage,${extra('progress_stage')}) AS progressStage,
        COALESCE(p.node,${extra('progress_node')}) AS progressNode,p.completed_nodes AS completedNodes
        FROM registry_entries e JOIN registry_links l ON l.type='sales' AND l.source_name=e.sales AND l.source_phone=''
        JOIN identities seller ON seller.id=l.identity_id AND seller.role='sales' AND seller.subjectId=? AND seller.status='active'
        LEFT JOIN registry_links il ON il.type='investor' AND il.source_name=e.customer AND il.source_phone=e.phone
        LEFT JOIN identities investor ON investor.id=il.identity_id AND investor.role='investor'
        LEFT JOIN company_record_progress p ON p.kind='registry' AND p.record_id=e.entry_key`, actor.id)
        .filter(row => !localDate(row.registeredOn) || localDate(row.registeredOn) <= currentDay);
      for (const row of registryRows) people.push({ id: 'registry:' + row.entryKey, identity: row.identitySubjectId || '',
        name: row.customer || '股民姓名待核对', phone: row.phone || '', registeredOn: localDate(row.registeredOn),
        signed: signed(row), signedOn: '', stocks: [{ name: row.stockName, code: row.stockCode }], recordCount: 1,
        sources: row.source?.trim() ? [row.source.trim()] : [], sourceType: '历史登记',
        progress: { kind: 'registry', progressId: key(row.entryKey) },
      });
    }
    const personByLead = new Map(people.filter(row => row.local).map(row => [row.id.slice(5), row]));
    const closedCases = cases.filter(row => leadById.has(row.leadId) && closed(row) && localDate(row.openedOn) <= currentDay).map(row => {
      const person = personByLead.get(row.leadId);
      return { id: 'case:' + row.id, title: person.name, phone: person.phone,
        subtitle: row.title || row.stockName || row.stockCode || '案件', status: '已结案', registeredOn: person.registeredOn,
        openedOn: localDate(row.openedOn), sourceType: '系统案件',
        ...(row.salesId === actor.id && row.openedOn >= caseCutoff ? { kind: 'case', progressId: row.id } : {}),
      };
    });
    for (const row of registryRows.filter(closed)) closedCases.push({ id: 'registry:' + key(row.entryKey), title: row.customer,
      phone: row.phone || '', subtitle: [row.stockName, row.stockCode].filter(Boolean).join(' · '), status: '已结案',
      registeredOn: localDate(row.registeredOn), sourceType: '历史登记', kind: 'registry', progressId: key(row.entryKey) });
    return { people, brokers, closedCases };
  }

  function board(actor, input = {}) {
    requireValue(actor?.role === 'sales' && !actor.passwordChangeRequired, '当前账号无权查看销售看板', 403);
    const filters = period(input);
    return transaction(() => {
      const { people, brokers, closedCases } = load(actor, filters.today);
      const included = date => date ? date <= filters.to && (!filters.from || date >= filters.from) : filters.period === 'all';
      const priorOrUnknown = date => !date || date <= filters.today;
      const groups = new Map(), identitiesByPair = new Map();
      // A verified account identity takes precedence over a matching name and phone.
      for (const person of people) {
        person.pair = personPair(person.name, person.phone);
        if (person.identity && person.pair) {
          if (!identitiesByPair.has(person.pair)) identitiesByPair.set(person.pair, new Set());
          identitiesByPair.get(person.pair).add(person.identity);
        }
      }
      for (const person of people) {
        const matches = identitiesByPair.get(person.pair);
        const identity = person.identity || (matches?.size === 1 ? [...matches][0] : '');
        const groupKey = identity ? 'identity:' + identity : person.pair ? 'pair:' + person.pair
          : person.clientId ? 'client:' + person.clientId : person.id;
        person.groupKey = groupKey;
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(person);
      }
      const customers = [], allCustomers = [];
      let uncertainCount = 0, missingSigningCount = 0;
      for (const [groupKey, members] of groups) {
        const visible = members.filter(row => included(row.registeredOn));
        const current = members.filter(row => priorOrUnknown(row.registeredOn));
        if (!current.length) continue;
        const statusKnown = current.some(row => row.signed);
        const preferred = current.find(row => row.local) || current[0];
        const toCard = subset => {
          const dates = subset.map(row => row.registeredOn).filter(Boolean).sort();
          const signedDates = current.map(row => row.signedOn).filter(Boolean).sort();
          return { id: key(groupKey), title: preferred.name, phone: preferred.phone,
            subtitle: stockSummary(subset), status: statusKnown ? '已签约' : '签约状态未确认', registeredOn: dates.at(-1) || '',
            signedOn: signedDates.at(-1) || '', recordCount: subset.reduce((n, row) => n + row.recordCount, 0),
            sourceType: [...new Set(subset.map(row => row.sourceType))].join('、'),
            ...(subset.length === 1 ? subset[0].progress : {}), unknownDate: subset.some(row => !row.registeredOn),
          };
        };
        allCustomers.push(toCard(current));
        if (!visible.length) continue;
        customers.push(toCard(visible));
        uncertainCount += visible.filter(row => !row.identity && !row.pair).length;
        if (!statusKnown) missingSigningCount += visible.filter(row => !row.local).length;
      }
      const channelGroups = new Map();
      const addChannel = (name, registeredOn, sourceType, status = '', person = null, sourceStatus = '') => {
        const channelKey = normalize(name);
        if (!channelKey) return;
        if (!channelGroups.has(channelKey)) channelGroups.set(channelKey, { name, occurrences: [] });
        channelGroups.get(channelKey).occurrences.push({ registeredOn, sourceType, status, sourceStatus,
          customerKey: person?.groupKey || '', recordCount: person?.recordCount || 0 });
      };
      for (const broker of brokers) addChannel(broker.name, localDate(broker.signedOn), '合作券商',
        broker.accountStatus === 'closed' ? '已注销' : broker.accountStatus ? '已开户' : '待开户', null, broker.accountStatus || 'pending');
      for (const person of people) for (const source of person.sources) addChannel(source, person.registeredOn,
        person.local ? '留资来源' : '历史来源分类', '', person, person.formalSource ? person.sourceStatus : '');
      const channels = [], allChannels = [];
      for (const [channelKey, group] of channelGroups) {
        const sourceStatus = group.occurrences.filter(row => row.sourceStatus && priorOrUnknown(row.registeredOn))
          .map(row => row.sourceStatus).sort((a, b) => accountRank(a) - accountRank(b))[0] || 'active';
        const toCard = rows => ({ id: key('channel:' + channelKey), title: group.name,
          subtitle: [...new Set(rows.map(row => row.sourceType))].join('、'),
          status: [...new Set(rows.map(row => row.status).filter(Boolean))].join('、'),
          registeredOn: rows.map(row => row.registeredOn).filter(Boolean).sort().at(-1) || '',
          sourceStatus, customerCount: new Set(rows.map(row => row.customerKey).filter(Boolean)).size,
          recordCount: rows.reduce((total, row) => total + row.recordCount, 0),
          unknownDate: rows.some(row => !row.registeredOn),
        });
        const current = group.occurrences.filter(row => priorOrUnknown(row.registeredOn));
        if (current.length) allChannels.push(toCard(current));
        const visible = group.occurrences.filter(row => included(row.registeredOn));
        if (visible.length) channels.push(toCard(visible));
      }
      const collections = { channels, customers, effective: customers.filter(row => row.status === '已签约'),
        closed: closedCases.filter(row => included(row.registeredOn)) };
      const totals = { channels: allChannels, customers: allCustomers, effective: allCustomers.filter(row => row.status === '已签约'),
        closed: closedCases.filter(row => priorOrUnknown(row.registeredOn)) };
      const metrics = metricDefinitions.map(([name, label, unit, kind]) => {
        const visibleIds = new Set(collections[name].map(row => row.id));
        return { key: name, label, unit, kind, value: collections[name].length,
          dateLabel: name === 'channels' ? '合作 / 留资 / 材料登记日期' : '留资 / 材料登记日期',
          unknownDateCount: totals[name].filter(row => (row.unknownDate || !row.registeredOn) &&
            (filters.period === 'all' || !visibleIds.has(row.id))).length };
      });
      const items = collections[filters.selected].sort(filters.selected === 'channels' ? compareSourceSummary : compareRecent);
      const notes = ['按留资 / 材料登记日期筛选；签约、结案显示当前状态，并非期间发生数。',
        '客户与股票仅统计当前经办留资和已关联历史登记；转派给其他销售的股票、案件及其同步状态不再计入。',
        '来源渠道包含合作券商与经办登记来源，同名来源合并；合作关系不代表可查看该渠道的其他经办记录。'];
      if (uncertainCount) notes.push(`${uncertainCount} 条登记资料不完整，暂按独立档案计数，待核对。`);
      if (missingSigningCount) notes.push(`${missingSigningCount} 条历史登记的签约状态待确认，未计入已签约客户。`);
      if (metrics.some(row => row.unknownDateCount)) notes.push('缺少登记日期的记录仅计入全部累计，不计入本月或自选日期。');
      const lastPage = Math.max(0, Math.ceil(items.length / pageSize) - 1);
      const offset = Math.min(Math.floor(filters.offset / pageSize), lastPage) * pageSize;
      return { ...filters, offset, metrics, total: items.length, items: items.slice(offset, offset + pageSize), notes,
        orderLabel: filters.selected === 'channels' ? orderLabels.sources : orderLabels.recent };
    }, true);
  }

  return board;
}
