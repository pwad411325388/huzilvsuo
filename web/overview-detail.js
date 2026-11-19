import { overview, caseRows, channelRows, isOngoing } from './analytics.js';
import { compareRecent, comparePending, compareSourceSummary, orderLabels } from './list-order.js';

const PAGE_SIZE = 20;
const columns = entries => entries.map(([key, label]) => ({ key, label }));
const leadColumns = columns([
  ['number', '留资编号'], ['customer', '客户'], ['phone', '手机号'], ['stockName', '股票名称'], ['stockCode', '股票代码'],
  ['company', '核对公司'], ['broker', '当前券商'], ['sales', '经办销售'], ['date', '留资日期'], ['status', '状态'], ['reason', '说明'],
]);
const clientColumns = columns([
  ['customer', '客户'], ['phone', '手机号'], ['stocks', '股票线索'], ['firstBroker', '首次券商'], ['broker', '当前券商'],
  ['owner', '客户归属销售'], ['sales', '留资经办销售'], ['signedOn', '签约日期'],
]);
const caseColumns = columns([
  ['number', '案件编号'], ['customer', '客户'], ['phone', '手机号'], ['title', '案件名称'], ['stockName', '股票名称'],
  ['stockCode', '股票代码'], ['broker', '当前券商'], ['sales', '经办销售'], ['date', '登记日期'], ['status', '状态'],
]);

function readableNumber(prefix, number) {
  return Number.isSafeInteger(Number(number)) && Number(number) > 0 ? `${prefix}-${String(number).padStart(6, '0')}` : '未编号';
}

function leadRow(lead) {
  return {
    number: /^LZ-\d+$/.test(lead.number || '') ? lead.number : readableNumber('LZ', lead.recordNumber),
    customer: lead.name || '未登记姓名', phone: lead.phone || '—', stockName: lead.stockName || '—', stockCode: lead.stockCode || '—',
    company: lead.companyName || '待核对', broker: lead.brokerName || '自然流入', sales: lead.salesName || '待分配',
    date: lead.createdOn || '—', status: lead.status || (lead.needsAssignment ? '待分配' : '已分配'),
    reason: lead.legacy && lead.needsAssignment ? `历史待核对${lead.reason ? `：${lead.reason}` : ''}` : lead.reason || '—',
  };
}

function customerRows(view, selectedIds, signed = false) {
  const clients = new Map(view.clients.map(client => [client.id, client]));
  const brokers = new Map(view.brokers.map(broker => [broker.id, broker]));
  const leadsByClient = new Map();
  for (const lead of view.assignments) {
    if (!leadsByClient.has(lead.clientId)) leadsByClient.set(lead.clientId, []);
    leadsByClient.get(lead.clientId).push(lead);
  }
  return selectedIds.map(id => {
    const leads = leadsByClient.get(id) || [];
    const client = clients.get(id) || {};
    const broker = brokers.get(client.brokerId);
    const stocks = new Map();
    for (const lead of leads) {
      const stockName = lead.stockName || '';
      const stockCode = lead.stockCode || '';
      const key = JSON.stringify([stockName, stockCode]);
      const entry = stocks.get(key) || { stockName, stockCode, count: 0 };
      entry.count += 1;
      stocks.set(key, entry);
    }
    const display = {
      customer: client.name || leads[0]?.name || '未登记姓名', phone: client.phone || leads[0]?.phone || '—',
      stocks: [...stocks.values()].map(stock => `${stock.stockName || '未填股票名称'}${stock.stockCode ? `（${stock.stockCode}）` : ''} · ${stock.count} 条`).join('；') || '暂无留资',
      firstBroker: client.firstBrokerName || brokers.get(client.firstBrokerId)?.name || '未关联',
      broker: client.brokerName || broker?.name || '自然流入',
      owner: client.brokerId ? (broker?.salesName && broker.salesName !== broker.salesId ? broker.salesName : '未登记姓名') : '无券商归属',
      sales: [...new Set(leads.map(lead => lead.salesName || '待分配'))].join('、') || '—', signedOn: client.signedOn || '未签约',
    };
    const latest = leads.slice().sort(compareRecent)[0];
    return { id, name: display.customer, registeredOn: signed ? client.signedOn || '' : latest?.createdOn ?? latest?.createdAt ?? '', display };
  }).sort(compareRecent).map(row => row.display);
}

/** Build display values only: internal IDs remain in the snapshot and never become table cells. */
export function buildOverviewDetail(view, index) {
  if (!Number.isInteger(index) || index < 0 || index > 7) throw new RangeError('总览明细类型无效');
  const [title, total, unit] = overview(view)[index];
  const month = view.today.slice(0, 7);
  let rows;
  let tableColumns;
  let description;
  if ([0, 3, 6].includes(index)) {
    const selected = index === 3 ? view.assignments.filter(lead => lead.needsAssignment)
      : index === 6 ? view.assignments.filter(lead => lead.createdOn.startsWith(month)) : view.assignments;
    rows = selected.slice().sort(index === 3 ? (a, b) => comparePending(
      { ...a, queue: a.legacy ? 'system_legacy' : 'system_new' }, { ...b, queue: b.legacy ? 'system_legacy' : 'system_new' }) : compareRecent).map(leadRow);
    tableColumns = leadColumns;
    description = index === 3 ? '按留资条数统计，包括新留资待分配和历史待核对；同一客户可有多条留资。'
      : index === 6 ? `按留资日期统计 ${month} 的全部留资记录；同一客户可有多条留资。`
        : '按全部留资记录统计，一条留资一行；同一客户多次留资分别计数。';
    description += index === 3 ? orderLabels.pending : orderLabels.recent;
  } else if (index === 1 || index === 7) {
    const ids = index === 1 ? [...new Set(view.assignments.map(lead => lead.clientId))]
      : view.clients.filter(client => client.signedOn?.startsWith(month)).map(client => client.id);
    rows = customerRows(view, ids, index === 7);
    tableColumns = clientColumns;
    description = index === 1 ? '按留资客户去重，一位客户一行；姓名和电话显示当前资料，股票线索合并同一股票的留资条数。'
      : `按客户实际签约日期统计 ${month} 的签约客户，一位客户一行；股票线索汇总该客户全部留资。`;
    description += '客户归属销售取当前券商的合作负责人，留资经办销售按每条股票留资的分派结果显示。';
    description += index === 7 ? '按实际签约日期从新到旧排序。' : '按最近一次留资日期从新到旧排序，无日期在最后。';
  } else if (index === 2) {
    const realBrokerIds = new Set(view.brokers.map(broker => broker.id));
    rows = channelRows(view).filter(channel => realBrokerIds.has(channel.id)).sort(compareSourceSummary).map(channel => ({
      broker: channel.name, sales: channel.sales, status: channel.status, signedOn: channel.date || '未登记',
      customers: channel.customers, leads: channel.leads, ongoing: channel.ongoing, closed: channel.closed,
    }));
    tableColumns = columns([
      ['broker', '券商'], ['sales', '合作负责人'], ['status', '账号状态'], ['signedOn', '合作签约日期'],
      ['customers', '留资客户数'], ['leads', '留资条数'], ['ongoing', '在办案件'], ['closed', '已结案件'],
    ]);
    description = '按已登记的券商渠道统计，包括待开户、已开户和已注销渠道；不计入自然流入。客户和案件按当前券商归属汇总。';
    description += orderLabels.sources;
  } else {
    rows = caseRows(view).filter(record => index === 4 ? isOngoing(record) : record.status === '已结案').sort(compareRecent).map(record => ({
      number: readableNumber('AJ', record.recordNumber), customer: record.customer, phone: record.phone || '—', title: record.title || '未登记案件名称',
      stockName: record.stockName || '—', stockCode: record.stockCode || '—', broker: record.broker, sales: record.handler, date: record.date, status: record.status,
    }));
    tableColumns = caseColumns;
    description = `按案件件数统计${view.caseCutoff ? `，仅包含 ${view.caseCutoff} 及之后登记的案件` : ''}；${index === 4 ? '在办包括已受理和诉讼中，不包含待受理及已结案' : '仅包含状态为已结案的案件'}。`;
    description += orderLabels.recent;
  }
  return { title, description, unit, total, columns: tableColumns, rows };
}

const searchText = value => String(value ?? '').normalize('NFKC').toLowerCase();

export function renderOverviewDetail(view, selection, ui) {
  const { safe, button, field, panel, empty } = ui;
  const index = Number(selection.index);
  const detail = buildOverviewDetail(view, index);
  const q = String(selection.q || '').trim();
  const needle = searchText(q);
  const filtered = detail.rows.filter(row => !needle || detail.columns.some(column => searchText(row[column.key]).includes(needle)));
  const requested = Number(selection.offset);
  const lastOffset = Math.max(0, Math.floor((filtered.length - 1) / PAGE_SIZE) * PAGE_SIZE);
  const offset = Math.min(lastOffset, Number.isSafeInteger(requested) && requested >= 0 ? Math.floor(requested / PAGE_SIZE) * PAGE_SIZE : 0);
  const page = filtered.slice(offset, offset + PAGE_SIZE);
  const table = page.length ? `<div class="table-wrap"><table><thead><tr>${detail.columns.map(column => `<th>${safe(column.label)}</th>`).join('')}</tr></thead>
    <tbody>${page.map(row => `<tr>${detail.columns.map(column => `<td><span class="wrap-cell">${safe(row[column.key] ?? '—')}</span></td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : empty(q ? '未找到符合条件的明细，请调整关键词后重试。' : '暂无明细记录');
  return `<div data-overview-detail data-index="${index}" data-total="${detail.total}">
    ${panel(`${safe(detail.title)}明细`, `${button('返回数据总览', 'overview-back', '', 'class="secondary"')}
      <p>总计 ${detail.total} ${safe(detail.unit)} · 检索结果 <strong data-overview-filtered="${filtered.length}">${filtered.length}</strong> ${safe(detail.unit)}</p>
      <p>${safe(detail.description)}</p>
      <form data-form="overview-detail-search" class="inline-form">
        ${field('搜索明细', `<input name="q" value="${safe(q)}" maxlength="100" placeholder="股票、姓名、代码、电话、券商或销售">`)}
        <button class="primary" type="submit">搜索明细</button>${button('重置', 'overview-reset', '', 'class="secondary"')}
      </form>${table}
      <div class="filters">${button('上一页', 'overview-page', Math.max(0, offset - PAGE_SIZE), `class="secondary"${offset === 0 ? ' disabled' : ''}`)}
        <span>第 ${filtered.length ? offset / PAGE_SIZE + 1 : 0} / ${Math.ceil(filtered.length / PAGE_SIZE)} 页 · 每页 ${PAGE_SIZE} 条</span>
        ${button('下一页', 'overview-page', offset + PAGE_SIZE, `class="secondary"${offset + PAGE_SIZE >= filtered.length ? ' disabled' : ''}`)}</div>`)}
    </div>`;
}
