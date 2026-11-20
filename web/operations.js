import { channelRows, assignmentLabel } from './analytics.js';
import { compareAccounts, compareRecent, comparePending, compareName } from './list-order.js';

export function operationsPage(view, state, ui) {
  const { safe, button, field, select, panel, empty, tag } = ui;
  const orderedSales = view.sales.slice().sort(compareAccounts);
  const activeSales = orderedSales.filter(sales => sales.username && sales.accountStatus === 'active').map(sales => [sales.id, sales.name]);
  const table = (headings, rows) => rows.length ? `<div class="table-wrap"><table><thead><tr>${headings.map(title => `<th>${title}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty();
  const assignmentTable = rows => table(['留资编号 / 日期', '客户 / 股票', '来源渠道', '经办销售 / 分配状态', '说明', '操作'], rows.map(lead => [
    `${safe(lead.number)}<small>${safe(lead.createdOn)}</small>`, `${safe(lead.name)}<small>${safe(lead.phone)}</small><small>${safe(lead.stockName)} · ${safe(lead.stockCode)}</small>`,
    safe(lead.brokerName || '自然流入'), `${safe(lead.salesName || '待分配')}<small>${tag(assignmentLabel(lead))}</small>`, safe(lead.reason),
    button(lead.salesId ? '核对 / 转派' : '核对并分配', 'edit-assignment', lead.id, 'class="secondary"'),
  ]));

  if (state.adminTab === 6) {
    return '<div data-overview-host aria-busy="true"><section class="panel" role="status">正在加载数据总览…</section></div>';
  }

  if (state.adminTab === 7) {
    return '<div data-admin-sales-host aria-busy="true"><section class="panel" role="status">正在加载销售数据…</section></div>';
  }

  if (state.adminTab === 8) {
    const f = state.channelFilters;
    const rows = channelRows(view).filter(row => (!f.salesId || row.salesId === f.salesId) && (!f.search || row.name.includes(f.search.trim())));
    const selected = view.brokers.find(row => row.id === state.editChannel);
    return '<div data-admin-data-host="channels" aria-busy="true"><section class="panel" role="status">正在加载全部来源渠道…</section></div>' +
      `<details class="panel"${selected || f.search || f.salesId ? ' open' : ''}><summary>券商账号与合作负责人维护</summary>` +
      panel('小程序合作券商', `<p>券商推荐的新留资交给其绑定销售。</p>
      <form data-form="channel-query" class="inline-form">${field('渠道名称', `<input name="search" value="${safe(f.search)}" maxlength="80">`)}
      ${field('合作负责人', select('salesId', orderedSales.map(row => [row.id, row.name]), f.salesId, '全部销售'))}<button class="secondary">查询渠道</button></form>
      ${table(['券商', '合作负责人', '账号状态', '合作签约日期', '操作'], rows.filter(row => row.id).map(row => [safe(row.name), safe(row.sales), safe(row.status), safe(row.date || '—'),
        button('管理负责人', 'edit-channel', row.id, 'class="quiet"')]))}`) +
      (selected ? panel(`调整合作负责人 · ${safe(selected.name)}`, `<form data-form="channel-owner" class="form-grid"><input type="hidden" name="brokerId" value="${safe(selected.id)}">
        <input type="hidden" name="previousSalesId" value="${safe(selected.salesId)}">${field('合作负责人', select('salesId', activeSales, selected.salesId, '请选择'))}
        ${field('调整说明', '<input name="reason" maxlength="200" required>')}<button class="primary">保存负责人</button></form>${button('取消', 'edit-channel', '', 'class="quiet"')}`) : '') +
      panel('渠道开户与账号维护', `<p>券商合作由销售登记，账号开通、注销和恢复在账号管理中办理。</p>${button('前往账号管理', 'admin-tab', 0, 'class="secondary"')}`) + '</details>';
  }

  if (state.adminTab === 2) {
    return '<div data-admin-data-host="cases" aria-busy="true"><section class="panel" role="status">正在加载全部客户案件…</section></div>';
  }

  if (state.adminTab !== 5) return '';
  const f = state.assignmentFilters;
  const rows = view.assignments.filter(lead => {
    if ((f.queue || 'pending') === 'pending' && (!lead.needsAssignment || lead.legacy)) return false;
    if (f.queue === 'legacy' && (!lead.legacy || !lead.needsAssignment)) return false;
    if (f.queue === 'assigned' && lead.needsAssignment) return false;
    if (f.salesId && lead.salesId !== f.salesId) return false;
    if (f.search && !`${lead.number} ${lead.name} ${lead.phone} ${lead.stockName} ${lead.stockCode}`.includes(f.search.trim())) return false;
    return true;
  }).sort((a, b) => {
    if (a.needsAssignment !== b.needsAssignment) return a.needsAssignment ? -1 : 1;
    if (!a.needsAssignment) return compareRecent(a, b);
    return comparePending({ ...a, queue: a.legacy ? 'system_legacy' : 'system_new' }, { ...b, queue: b.legacy ? 'system_legacy' : 'system_new' });
  });
  const companies = view.companies.slice().sort((a, b) => Number(b.active) - Number(a.active) || String(a.stockCode || '').localeCompare(String(b.stockCode || ''), 'en', { numeric: true }) || compareName(a, b));
  const company = view.companies.find(row => row.id === state.editCompany);
  const target = view.assignments.find(row => row.id === state.editAssignment);
  const companyForm = panel(company ? `修改公司配置 · ${safe(company.name)}` : '新增公司派单配置', `<p>自然流入的留资按公司派单。股票名称或别名和代码须匹配同一家公司。</p>
    <form data-form="company" class="form-grid query-grid"><input type="hidden" name="id" value="${safe(company?.id)}"><input type="hidden" name="version" value="${company?.version || ''}">
    ${field('公司 / 股票名称', `<input name="name" maxlength="80" value="${safe(company?.name)}" required>`)}
    ${field('股票代码', `<input name="stockCode" maxlength="20" value="${safe(company?.stockCode)}" placeholder="如 600000 或 NVDA" required>`)}
    ${field('股票别名（逗号分隔）', `<input name="aliases" maxlength="500" value="${safe(company?.aliases)}">`)}
    ${field('负责销售', select('salesId', activeSales, company?.salesId, '暂不配置，进入待分配'))}
    <label class="check"><input type="checkbox" name="active" ${!company || company.active ? 'checked' : ''}>启用自动匹配</label>
    <button class="primary">保存公司配置</button></form>${company ? button('取消修改', 'edit-company', '', 'class="quiet"') : ''}`);
  const assignmentEditor = target ? panel(`核对与分配 · ${safe(target.number)}`, `<p>${safe(target.name)} · ${safe(target.phone)} · 原填 ${safe(target.stockName)} / ${safe(target.stockCode)}</p>
    <p>${safe(target.reason)}</p><form data-form="assignment" data-source="${target.brokerId ? 'broker' : 'direct'}" class="form-grid query-grid">
    <input type="hidden" name="leadId" value="${safe(target.id)}"><input type="hidden" name="version" value="${target.version}">
    ${field(target.brokerId ? '核对后的公司（选填）' : '核对后的公司', select('companyId', view.companies.filter(item => item.active).map(item => [item.id, `${item.name} · ${item.stockCode}`]), target.companyId, target.brokerId ? '保留现有公司资料' : '请选择公司'))}
    ${field('经办销售', select('salesId', activeSales, target.salesId, '请选择销售'))}${field('核对 / 转派说明', '<input name="reason" maxlength="200" required>')}
    <button class="primary">确认分配</button></form>${button('取消', 'edit-assignment', '', 'class="quiet"')}`) : '';
  return panel('留资分配', `<p>此处分派小程序留资；登记表客户请到律所登记台账关联销售。</p><div class="filters">${button('查看全部客户档案', 'all-client-data', '', 'class="secondary"')}${button('打开律所登记台账', 'admin-tab', 9, 'class="secondary"')}</div>
    <form data-form="assignment-query" class="form-grid query-grid">${field('队列', select('queue', [['pending', '新留资待分配'], ['legacy', '历史待核对'], ['assigned', '已分配'], ['all', '全部留资']], f.queue || 'pending'))}
    ${field('经办销售', select('salesId', orderedSales.map(item => [item.id, item.name]), f.salesId, '全部销售'))}
    ${field('客户 / 股票 / 编号', `<input name="search" maxlength="100" value="${safe(f.search)}">`)}<button class="secondary">查询留资</button></form>
    <p>共 ${rows.length} 条</p>${assignmentTable(rows)}`) + assignmentEditor + companyForm +
    panel('公司配置', table(['公司', '代码', '别名', '负责销售', '状态', '操作'], companies.map(item => [safe(item.name), safe(item.stockCode), `<span class="wrap-cell">${safe(item.aliases || '—')}</span>`,
      safe(item.salesName || '未配置'), item.active ? (item.salesId && item.salesStatus === 'active' ? '启用' : '待配置可用销售') : '已停用', button('修改配置', 'edit-company', item.id, 'class="secondary"')])));
}
