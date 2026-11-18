import { overview, salesRows, channelRows, caseRows, matchesFilters } from './analytics.js';
import { renderOverviewDetail } from './overview-detail.js';

export function operationsPage(view, state, ui) {
  const { safe, button, field, select, panel, empty, tag } = ui;
  const activeSales = view.sales.filter(sales => sales.username && sales.accountStatus === 'active').map(sales => [sales.id, sales.name]);
  const brokerOptions = [['__natural__', '自然流入'], ...view.brokers.map(item => [item.id, item.name])];
  const table = (headings, rows) => rows.length ? `<div class="table-wrap"><table><thead><tr>${headings.map(title => `<th>${title}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty();
  const history = rows => rows.length ? `<details class="history"><summary>查看 ${rows.length} 条跟进记录</summary>${rows.map(row =>
    `<article class="admin-record"><strong>${safe(row.salesName || '历史销售')}</strong><p>${safe(row.note)}</p><small>${safe(new Date(row.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</small></article>`).join('')}</details>` : '<p>暂无跟进记录</p>';
  const assignmentTable = rows => table(['留资编号 / 日期', '客户 / 股票', '来源渠道', '经办销售 / 状态', '说明', '操作'], rows.map(lead => [
    `${safe(lead.number)}<small>${safe(lead.createdOn)}</small>`, `${safe(lead.name)}<small>${safe(lead.phone)}</small><small>${safe(lead.stockName)} · ${safe(lead.stockCode)}</small>`,
    safe(lead.brokerName || '自然流入'), `${safe(lead.salesName || '待分配')}<small>${tag(lead.status)}</small>`, safe(lead.reason),
    button(lead.salesId ? '核对 / 转派' : '核对并分配', 'edit-assignment', lead.id, 'class="secondary"'),
  ]));

  if (state.adminTab === 6) {
    if (state.overviewDetail) return renderOverviewDetail(view, state.overviewDetail, ui);
    const totals = overview(view);
    const pending = view.assignments.filter(lead => lead.needsAssignment);
    const recent = view.assignments.filter(lead => !lead.legacy).slice(0, 6);
    return `<div class="overview-cards">${totals.map(([label, value, unit], index) => `<button type="button" class="stat-card" data-action="overview-detail" data-value="${index}" aria-label="${label} ${value} ${unit}，查看明细"><strong>${value}<small>${unit}</small></strong><span>${label}</span><small class="stat-link">查看明细 →</small></button>`).join('')}</div>
      ${panel('需要处理', `<div class="action-grid"><div><strong>${pending.filter(lead => !lead.legacy).length} 条新留资待分配</strong><p>核对券商绑定销售或股票公司负责人。</p>${button('进入待分配', 'open-queue', 'pending', 'class="primary"')}</div>
        <div><strong>${pending.filter(lead => lead.legacy).length} 条历史留资待核对</strong><p>保留原记录，由运营逐条确认经办人。</p>${button('查看历史待核对', 'open-queue', 'legacy', 'class="secondary"')}</div></div>`)}
      ${panel('最近新增留资', assignmentTable(recent))}
      ${panel('统计口径', `<p>留资按条、客户按人、案件按件。案件仅统计 ${safe(view.caseCutoff)} 及之后的记录；在办为已受理及诉讼中，待受理另见客户案件。来源渠道按当前券商归属，经办销售按每条留资的当前分派。</p>`)}`;
  }

  if (state.adminTab === 7) {
    const f = state.salesFilters;
    const rows = salesRows(view).filter(row => (!f.salesId || row.id === f.salesId) && (!f.search || row.name.includes(f.search.trim())));
    return panel('销售看板', `<p>合作负责人管理券商关系，经办销售负责分配到本人的具体留资，两种统计分别列示。</p>
      <form data-form="sales-query" class="inline-form">${field('销售', select('salesId', view.sales.map(item => [item.id, item.name]), f.salesId, '全部销售'))}
      <button class="secondary">查询销售</button></form>`) +
      panel('券商合作统计', table(['销售', '账号状态', '合作渠道及留资客户数', '渠道数', '渠道留资客户'], rows.map(row => [safe(row.name), safe(row.status), `<span class="wrap-cell">${safe(row.channelNames || '暂无合作渠道')}</span>`, row.channels, `${row.channelCustomers} 人`]))) +
      panel('经办留资统计', `<p>按当前派单计算。同一股民在不同销售下可能各计 1 人，各销售人数不能直接相加作为平台人数。</p>` +
        table(['销售', '经办留资', '去重客户', '待跟进', '已跟进', '在办案件', '已结案件', '操作'], rows.map(row => [safe(row.name), `${row.leads} 条`, `${row.customers} 人`, row.pending, row.followed, row.ongoing, row.closed,
          button('查看经办留资', 'sales-leads', row.id, 'class="secondary"')])));
  }

  if (state.adminTab === 8) {
    const f = state.channelFilters;
    const rows = channelRows(view).filter(row => (!f.salesId || row.salesId === f.salesId) && (!f.search || row.name.includes(f.search.trim())));
    const selected = view.brokers.find(row => row.id === state.editChannel);
    return panel('渠道管理', `<p>券商推荐的新留资自动交给当前合作负责人。已有经办人的留资可在「公司与派单」中转派。</p>
      <form data-form="channel-query" class="inline-form">${field('渠道名称', `<input name="search" value="${safe(f.search)}" maxlength="80">`)}
      ${field('合作负责人', select('salesId', view.sales.map(row => [row.id, row.name]), f.salesId, '全部销售'))}<button class="secondary">查询渠道</button></form>
      ${table(['渠道', '合作负责人', '账号状态', '签约日期', '留资客户', '留资', '在办 / 已结', '操作'], rows.map(row => [safe(row.name), safe(row.sales), safe(row.status), safe(row.date || '—'), `${row.customers} 人`, `${row.leads} 条`, `${row.ongoing} / ${row.closed}`,
        `<div class="filters">${button('客户案件', 'channel-cases', row.id || '__natural__', 'class="secondary"')}${row.id ? button('管理负责人', 'edit-channel', row.id, 'class="quiet"') : ''}</div>`]))}`) +
      (selected ? panel(`调整合作负责人 · ${safe(selected.name)}`, `<form data-form="channel-owner" class="form-grid"><input type="hidden" name="brokerId" value="${safe(selected.id)}">
        <input type="hidden" name="previousSalesId" value="${safe(selected.salesId)}">${field('合作负责人', select('salesId', activeSales, selected.salesId, '请选择'))}
        ${field('调整说明', '<input name="reason" maxlength="200" required>')}<button class="primary">保存负责人</button></form>${button('取消', 'edit-channel', '', 'class="quiet"')}`) : '') +
      panel('渠道开户与账号维护', `<p>券商合作由销售登记，账号开通、注销和恢复在账号管理中办理。</p>${button('前往账号管理', 'admin-tab', 0, 'class="secondary"')}`);
  }

  if (state.adminTab === 2) {
    const f = state.caseFilters;
    const rows = caseRows(view).filter(row => matchesFilters(row, f));
    const renderCases = records => table(['案件编号', '客户', '股票 / 案件名称', '来源渠道', '经办销售', '登记日期', '状态'], records.map(row => [
      safe(row.number), safe(row.customer), `${safe(row.stockName)} · ${safe(row.stockCode)}<small>${safe(row.title)}</small>`, safe(row.broker), safe(row.handler), safe(row.date), tag(row.status),
    ]));
    return panel('客户案件', `<p>经办销售取自案件对应留资；同一股民不同股票的案件可由不同销售经办。当前案件分界日为 ${safe(view.caseCutoff)}。</p>
      <form data-form="case-query" class="form-grid query-grid">${field('客户 / 股票 / 案件', `<input name="search" value="${safe(f.search)}" maxlength="100">`)}
      ${field('来源渠道', select('brokerId', brokerOptions, f.brokerId, '全部渠道'))}${field('经办销售', select('salesId', [['__unassigned__', '待分配'], ...view.sales.map(row => [row.id, row.name])], f.salesId, '全部销售'))}
      ${field('案件状态', select('state', view.caseStatuses.map(value => [value, value]), f.state, '全部状态'))}
      <button class="secondary">查询案件</button></form>`) + panel('待受理及在办案件', renderCases(rows.filter(row => row.status !== '已结案'))) + panel('已结案件', renderCases(rows.filter(row => row.status === '已结案')));
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
  });
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
    <button class="primary">确认分配</button></form>${history(target.followups)}${button('取消', 'edit-assignment', '', 'class="quiet"')}`) : '';
  return panel('留资分配', `<p>券商推荐的留资交给该券商绑定的销售，自然流入的留资按股票公司派单。缺少可用经办人时进入待分配。</p>
    <form data-form="assignment-query" class="form-grid query-grid">${field('队列', select('queue', [['pending', '新留资待分配'], ['legacy', '历史待核对'], ['assigned', '已分配'], ['all', '全部留资']], f.queue || 'pending'))}
    ${field('经办销售', select('salesId', view.sales.map(item => [item.id, item.name]), f.salesId, '全部销售'))}
    ${field('客户 / 股票 / 编号', `<input name="search" maxlength="100" value="${safe(f.search)}">`)}<button class="secondary">查询留资</button></form>
    <p>共 ${rows.length} 条</p>${assignmentTable(rows)}`) + assignmentEditor + companyForm +
    panel('公司配置', table(['公司', '代码', '别名', '负责销售', '状态', '操作'], view.companies.map(item => [safe(item.name), safe(item.stockCode), `<span class="wrap-cell">${safe(item.aliases || '—')}</span>`,
      safe(item.salesName || '未配置'), item.active ? (item.salesId && item.salesStatus === 'active' ? '启用' : '待配置可用销售') : '已停用', button('修改配置', 'edit-company', item.id, 'class="secondary"')]))) +
    (view.legacyFollowups.length ? panel('历史客户跟进', `<p>这些记录原来只关联客户，尚未确认对应哪条留资，保留原记录供核对。</p>${view.legacyFollowups.map(row => `<article class="admin-record"><strong>${safe(row.name)} · ${safe(row.salesName || '历史销售')}</strong><p>${safe(row.note)}</p></article>`).join('')}`) : '');
}
