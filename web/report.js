import { caseRows, channelRows, salesRows, matchesFilters, sourceLabel } from './analytics.js';
import { compareRecent } from './list-order.js';

export const reportColumns = [
  { key: 'number', label: '记录编号', width: 19 },
  { key: 'customer', label: '客户姓名', width: 22 },
  { key: 'broker', label: '券商', width: 30 },
  { key: 'sales', label: '销售', width: 22 },
  { key: 'date', label: '日期', width: 18 },
  { key: 'status', label: '状态', width: 14 },
];

export function salesLabel(staff) {
  return staff?.name && staff.name !== staff.id ? staff.name : '未登记姓名';
}

const columns = items => items.map(([key, label, width = 22]) => ({ key, label, width }));
export const reportTypes = [['leads', '留资记录'], ['signings', '签约记录'], ['cases', '客户案件'], ['sales', '销售汇总'], ['channels', '渠道汇总']];
export function reportDefinition(type = 'leads') {
  const definitions = {
    leads: { title: '留资记录', description: '销售按每条留资的经办人统计；同一股民的不同留资可以有不同销售。历史未核对记录显示待分配。',
      columns: columns([['number', '记录编号', 19], ['customer', '客户姓名'], ['stockName', '股票名称'], ['stockCode', '股票代码', 18],
        ['company', '核对公司', 28], ['broker', '来源渠道', 28], ['sales', '经办销售'], ['date', '日期', 18], ['status', '分派/跟进状态', 20]]) },
    signings: { title: '签约记录', description: '按客户实际签约统计，每人一条。此表的销售仍指券商合作负责人；签约业绩归属口径尚待确认。', columns: reportColumns },
    cases: { title: '客户案件', description: '按案件计数，销售为案件对应留资的当前经办人，仅含当前案件分界日之后的记录。',
      columns: columns([['number', '案件编号', 19], ['customer', '客户姓名'], ['title', '案件名称', 30], ['stockName', '股票名称'],
        ['stockCode', '股票代码', 18], ['broker', '来源渠道', 28], ['sales', '经办销售'], ['date', '登记日期', 18], ['status', '案件状态', 16]]) },
    sales: { title: '销售汇总', summary: true, description: '渠道按合作负责人统计，经办留资按当前派单统计。客户在每位销售内去重，跨销售可能重复，不应相加作为全平台人数。',
      columns: columns([['name', '销售'], ['status', '账号状态', 16], ['channels', '合作渠道数', 18], ['channelCustomers', '渠道留资客户数', 20],
        ['leads', '经办留资数', 18], ['customers', '经办客户数', 18], ['pending', '待跟进留资', 18], ['followed', '已跟进留资', 18], ['ongoing', '经办在办案件', 20], ['closed', '经办已结案件', 20]]) },
    channels: { title: '渠道汇总', summary: true, description: '按客户当前券商归属汇总，自然流入保持无券商归属；各项分别按人、条、件计数。',
      columns: columns([['name', '渠道名称', 30], ['sales', '合作负责人'], ['status', '账号状态', 18], ['date', '合作签约日期', 18],
        ['customers', '留资客户数', 18], ['leads', '留资条数', 18], ['ongoing', '在办案件数', 18], ['closed', '已结案件数', 18]]) },
  };
  return definitions[type] || definitions.leads;
}

export function reportRows(view, filters = {}) {
  const { clients, sales } = view;
  if (filters.type === 'sales') return salesRows(view).filter(row => (!filters.salesId || row.id === filters.salesId) && (!filters.search || row.name.includes(filters.search.trim())));
  if (filters.type === 'channels') return channelRows(view).filter(row =>
    (!filters.brokerId || row.id === (filters.brokerId === '__natural__' ? '' : filters.brokerId)) && (!filters.salesId || row.salesId === (filters.salesId === '__unassigned__' ? '' : filters.salesId)) &&
    (!filters.search || row.name.includes(filters.search.trim())));
  if (filters.type === 'cases') return caseRows(view).filter(row => matchesFilters(row, filters)).map(row => ({ ...row, sales: row.handler }));
  if (filters.type !== 'signings') return view.assignments.map(lead => ({ number: lead.number, customer: lead.name, phone: lead.phone,
    stockName: lead.stockName, stockCode: lead.stockCode, companyId: lead.companyId, company: lead.companyName || '', brokerId: lead.brokerId,
    broker: sourceLabel(lead), handlerId: lead.salesId, sales: lead.salesName || '待分配', date: lead.createdOn, status: lead.status }))
    .filter(row => matchesFilters(row, filters)).sort(compareRecent);
  const salesById = new Map(sales.map(staff => [staff.id, staff]));
  const source = clients.filter(client => client.signedOn).map(client => ({ client, date: client.signedOn, serial: client.signingNumber }));
  const prefix = 'QY-';
  return source.flatMap(({ client, date, serial }) => {
    if (!client) return [];
    const status = client.signedOn ? '已签约' : '洽谈中';
    if ((filters.brokerId && (filters.brokerId === '__natural__' ? client.brokerId : client.brokerId !== filters.brokerId)) ||
      (filters.salesId && (filters.salesId === '__unassigned__' ? client.salesId : client.salesId !== filters.salesId))
      || (filters.state && status !== filters.state) || (filters.from && date < filters.from) || (filters.to && date > filters.to)) return [];
    if (filters.search && !`${client.name} ${client.phone}`.includes(filters.search.trim())) return [];
    return [{ number: `${prefix}${String(serial).padStart(6, '0')}`, customer: client.name || '', broker: client.brokerName || '',
      sales: client.salesId ? salesLabel(salesById.get(client.salesId)) : '', date, status }];
  }).sort(compareRecent);
}
