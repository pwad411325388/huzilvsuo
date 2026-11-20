import { compareRecent, compareSalesSummary, compareSourceSummary } from './list-order.js';

const distinct = values => new Set(values).size;
export const isOngoing = record => record.caseGroup ? record.caseGroup === 'ongoing' : ['已受理', '诉讼中'].includes(record.status);
export const sourceLabel = record => record.brokerName || '自然流入';

export function assignmentLabel(lead) {
  if (lead.assignmentStatus) return lead.assignmentStatus;
  const needsAssignment = lead.needsAssignment ?? !lead.salesId;
  return needsAssignment ? '待分配' : '已分配';
}

export function caseRows(view) {
  const byLead = new Map(view.assignments.map(lead => [lead.id, lead]));
  return view.cases.map(record => {
    const lead = byLead.get(record.leadId);
    return { ...record, number: `AJ-${String(record.recordNumber).padStart(6, '0')}`,
      customer: lead?.name || record.name || '未留资', phone: lead?.phone || '', stockName: lead?.stockName || '', stockCode: lead?.stockCode || '',
      companyId: lead?.companyId || '', company: lead?.companyName || '', broker: lead ? sourceLabel(lead) : '自然流入',
      handlerId: lead?.salesId || '', handler: lead?.salesName || '待分配', date: record.openedOn };
  }).sort(compareRecent);
}

export function channelRows(view) {
  const cases = caseRows(view);
  return [...view.brokers, { id: '', name: '自然流入', salesName: '—', signedOn: '', accountStatus: 'natural' }].map(broker => {
    const leads = view.assignments.filter(lead => (lead.brokerId || '') === broker.id);
    const relatedCases = cases.filter(record => (record.brokerId || '') === broker.id);
    return { id: broker.id, name: broker.name, salesId: broker.salesId || '', sales: broker.salesName || '未登记姓名',
      status: broker.accountStatus === 'natural' ? '无券商归属' : broker.accountStatus === 'closed' ? '已注销' : broker.username ? '已开户' : '待开户',
      date: broker.signedOn, customers: distinct(leads.map(lead => lead.clientId)), leads: leads.length,
      ongoing: relatedCases.filter(isOngoing).length, closed: relatedCases.filter(record => record.status === '已结案').length };
  }).sort((a, b) => compareSourceSummary({ ...a, sourceStatus: a.status === '无券商归属' ? 'active' : a.status },
    { ...b, sourceStatus: b.status === '无券商归属' ? 'active' : b.status }));
}

export function salesRows(view) {
  const channels = channelRows(view);
  const cases = caseRows(view);
  return view.sales.map(sales => {
    const owned = channels.filter(channel => channel.salesId === sales.id);
    const leads = view.assignments.filter(lead => lead.salesId === sales.id);
    const handled = cases.filter(record => record.handlerId === sales.id);
    return { id: sales.id, name: sales.name, status: sales.accountStatus === 'closed' ? '已注销' : sales.username ? '正常' : '待开户',
      channels: owned.length, channelNames: owned.map(channel => `${channel.name}（${channel.customers} 人）`).join('、'),
      channelCustomers: owned.reduce((sum, channel) => sum + channel.customers, 0),
      leads: leads.length, customers: distinct(leads.map(lead => lead.clientId)),
      ongoing: handled.filter(isOngoing).length, closed: handled.filter(record => record.status === '已结案').length };
  }).sort(compareSalesSummary);
}

export function overview(view) {
  const month = view.today.slice(0, 7);
  return [
    ['留资记录', view.assignments.length, '条'], ['留资客户', distinct(view.assignments.map(lead => lead.clientId)), '人'],
    ['合作渠道', view.brokers.length, '家'], ['待分配留资', view.assignments.filter(lead => lead.needsAssignment).length, '条'],
    ['在办案件', view.cases.filter(isOngoing).length, '件'], ['已结案件', view.cases.filter(record => record.status === '已结案').length, '件'],
    ['本月新增留资', view.assignments.filter(lead => lead.createdOn.startsWith(month)).length, '条'],
    ['本月签约客户', view.clients.filter(client => client.signedOn?.startsWith(month)).length, '人'],
  ];
}

export function matchesFilters(row, filters = {}) {
  const channel = filters.brokerId === '__natural__' ? !row.brokerId : !filters.brokerId || row.brokerId === filters.brokerId;
  const handler = filters.salesId === '__unassigned__' ? !row.handlerId : !filters.salesId || row.handlerId === filters.salesId;
  const search = String(filters.search || '').trim().toLowerCase();
  return channel && handler && (!filters.companyId || row.companyId === filters.companyId) &&
    (!filters.state || row.status === filters.state) && (!filters.from || row.date >= filters.from) && (!filters.to || row.date <= filters.to) &&
    (!search || [row.number, row.customer, row.phone, row.stockName, row.stockCode, row.title, row.company].some(value => String(value || '').toLowerCase().includes(search)));
}
