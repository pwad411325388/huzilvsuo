import { compareAccounts, orderLabels } from './list-order.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const display = value => escape(value === '' || value == null ? '—' : value);
const originLabels = { system: '小程序数据', registry: '历史登记', mixed: '小程序及历史登记' };
const metricLabels = { channels: '来源渠道', records: '留资与登记', customers: '客户档案', ongoing: '在办案件', closed: '已结案件', unknown: '进度待核记录', other: '其他进度记录' };
const metricUnits = { channels: '个', records: '条', customers: '份', ongoing: '件', closed: '件', unknown: '条', other: '条' };
const button = (action, label, attrs = '', className = 'secondary') => `<button type="button" class="${className}" data-admin-sales-action="${action}" ${attrs}>${escape(label)}</button>`;
const empty = text => `<div class="empty">${escape(text || '暂无符合条件的数据')}</div>`;
const table = (headings, rows) => rows.length ? `<div class="table-wrap"><table><thead><tr>${headings.map(title => `<th scope="col">${escape(title)}</th>`).join('')}</tr></thead><tbody>${rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty();
const panel = (title, body) => `<section class="panel">${title ? `<h2>${escape(title)}</h2>` : ''}${body}</section>`;
const notes = rows => (rows || []).map(note => `<p class="muted">${escape(note)}</p>`).join('');
const detailAttrs = (row, metric, sourceKey = '', sourceName = '') => `data-sales-id="${escape(row.id)}" data-sales-name="${escape(row.name)}" data-metric="${metric}" data-source-key="${escape(sourceKey)}" data-source-name="${escape(sourceName)}"`;
const countLink = (row, metric, value, unit, sourceKey = '', sourceName = '') => button('detail', `${value ?? 0} ${unit}`, detailAttrs(row, metric, sourceKey, sourceName), 'admin-sales-count');

function updatedLabel(value) {
  if (!value) return '尚未同步登记表';
  const time = new Date(value);
  return Number.isNaN(time.valueOf()) ? '同步时间待确认' : time.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

export function renderAdminSalesOverview(data, filters = {}, sales = []) {
  const options = new Map(sales.map(row => [row.id, row]));
  for (const row of data?.rows || []) options.set(row.id, { ...options.get(row.id), ...row });
  const controls = panel('销售看板', `<p>汇总销售名下的小程序业务与已关联的历史登记，点击数量可查看对应明细。</p>
    <form data-admin-sales-form="overview" class="inline-form" role="search">
      <label class="field"><span>销售</span><select name="salesId"><option value="">全部销售</option>${[...options.values()].sort(compareAccounts).map(({ id, name }) => `<option value="${escape(id)}"${filters.salesId === id ? ' selected' : ''}>${escape(name)}</option>`).join('')}</select></label>
      <label class="field"><span>搜索销售</span><input type="search" name="q" value="${escape(filters.q)}" maxlength="100" placeholder="输入销售姓名"></label>
      <button class="primary">查询销售</button>${button('overview-reset', '重置')}${button('refresh', '刷新数据')}
    </form>`);
  if (!data) return controls;
  const meta = data.meta || {};
  const source = panel('同步数据', `<p>${display(meta.sourceName)} · 最近同步 ${escape(updatedLabel(meta.importedAt))}</p>
    <div class="admin-sales-sync"><span>登记总数 <strong>${escape(meta.registryTotal ?? 0)}</strong> 条</span>
      <span>已关联销售 <strong>${escape(meta.registryLinked ?? 0)}</strong> 条</span>
      ${button('detail', `未关联销售 ${meta.registryUnlinked ?? 0} 条`, detailAttrs({ id: '__unlinked__', name: '未关联销售' }, 'records'), 'secondary')}
      ${button('registry', '打开登记台账')}</div><p class="muted">在登记台账更新表格或调整关联后，刷新此页即可反映最新数据。</p>
      ${meta.futureRegistryCount ? `<p class="muted">另有 ${escape(meta.futureRegistryCount)} 条登记日期晚于今天，暂未计入上述统计，请在登记台账核对日期。</p>` : ''}`);
  const sources = row => {
    const rows = row.sources || [];
    const renderSource = source => button('detail', `${source.name} · ${source.customerCount ?? 0} 份`,
      detailAttrs(row, 'customers', source.key, source.name), 'admin-sales-source');
    return (rows.length ? `<div class="admin-sales-sources">${rows.slice(0, 3).map(renderSource).join('')}</div>${rows.length > 3 ? `<details class="admin-sales-more"><summary>展开其余 ${rows.length - 3} 个来源</summary><div class="admin-sales-sources">${rows.slice(3).map(renderSource).join('')}</div></details>` : ''}` : '暂无已识别来源') +
      (row.sourceUnknownCount ? `<small>${button('detail', `来源待核对 ${row.sourceUnknownCount} 条`, detailAttrs(row, 'records', '__unknown__', '来源待核对'), 'admin-sales-count')}</small>` : '');
  };
  const channels = panel('来源渠道统计', `<p>包括合作券商及表内历史来源分类。同一来源可涉及多位销售；历史来源不表示已开通券商账号。</p><p class="muted" data-order-label>排序：${escape(data.orderLabel || orderLabels.sales)}</p>` +
    table(['销售', '账号状态', '来源及客户档案', '来源渠道', '明确来源的客户档案'], data.rows.map(row => [
      escape(row.name), display(row.status), sources(row), countLink(row, 'channels', row.channelCount, '个'),
      countLink(row, 'customers', row.channelCustomers, '份', '__known__', '已识别来源'),
    ])));
  const records = panel('留资、客户与案件统计', `<p>历史登记与小程序留资合并展示。缺少可靠身份资料的登记按独立档案计数，单位为份；跨销售档案数不能直接相加。</p><p class="muted" data-order-label>排序：${escape(data.orderLabel || orderLabels.sales)}</p>` +
    table(['销售', '留资与登记', '客户档案', '小程序待跟进', '小程序已跟进', '历史跟进未记录', '在办案件', '已结案件', '进度待核登记', '操作'], data.rows.map(row => [
      escape(row.name), `${countLink(row, 'records', row.recordCount, '条')}<small>小程序 ${escape(row.systemRecordCount ?? 0)} · 历史 ${escape(row.registryRecordCount ?? 0)}</small>`,
      `${countLink(row, 'customers', row.customerCount, '份')}${row.unverifiedCustomerCount ? `<small>待核对 ${escape(row.unverifiedCustomerCount)} 份</small>` : ''}`,
      display(row.pending ?? 0), display(row.followed ?? 0), display(row.followUnknown ?? 0),
      countLink(row, 'ongoing', row.ongoing, '件'), countLink(row, 'closed', row.closed, '件'),
      `${countLink(row, 'unknown', row.unknownCaseCount, '条')}${row.otherCaseCount ? `<small>其他进度 ${countLink(row, 'other', row.otherCaseCount, '条')}</small>` : ''}`,
      button('detail', '查看留资与登记', detailAttrs(row, 'records')),
    ])));
  return controls + source + channels + records + (data.notes?.length ? panel('统计说明', notes(data.notes)) : '');
}

export function renderAdminSalesDetails(data, detail) {
  const metric = detail.metric;
  const caption = metricLabels[metric] || '明细';
  const controls = `<div class="admin-sales-detail-heading"><h2>${escape(detail.salesName || '销售')} · ${escape(caption)}</h2>${button('back', '返回销售看板')}</div>
    <div class="filters" aria-label="销售明细类型">${Object.entries(metricLabels).map(([key, label]) => button('metric', label, `data-metric="${key}" aria-pressed="${metric === key}"`, `chip${metric === key ? ' selected' : ''}`)).join('')}</div>
    ${detail.sourceKey ? `<p class="admin-sales-scope">当前来源：${escape(detail.sourceName || (detail.sourceKey === '__unknown__' ? '来源待核对' : '已筛选来源'))} ${button('clear-source', '查看全部来源')}</p>` : ''}
    <form data-admin-sales-form="details" class="inline-form" role="search">
      <label class="field"><span>搜索明细</span><input type="search" name="q" value="${escape(detail.q)}" maxlength="100" placeholder="姓名、电话、股票名称/代码或来源"></label>
      <label class="field"><span>数据来源</span><select name="origin">${[['all', '全部数据'], ['system', '小程序数据'], ['registry', '历史登记']].map(([value, label]) => `<option value="${value}"${detail.origin === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <button class="primary">搜索明细</button>${button('detail-reset', '重置')}${button('refresh', '刷新数据')}</form>`;
  if (!data) return panel('', controls);
  const rowSource = row => `<span class="tag">${escape(originLabels[row.origin] || row.origin || '—')}</span>`;
  let rows;
  if (metric === 'channels') rows = table(['来源渠道', '来源类型', '留资与登记', '客户档案', '操作'], data.items.map(row => [
    `<span class="wrap-cell">${display(row.title)}</span>`, rowSource(row), `${escape(row.recordCount ?? 0)} 条`, `${escape(row.customerCount ?? 0)} 份`,
    button('source-records', '查看此来源记录', `data-source-key="${escape(row.sourceKey)}" data-source-name="${escape(row.title)}"`),
  ]));
  else if (metric === 'customers') rows = table(['客户', '联系电话', '股票与登记', '来源渠道', '销售', '登记日期', '数据来源'], data.items.map(row => [
    `<span class="wrap-cell">${display(row.title)}</span>${row.status ? `<small>${escape(row.status)}</small>` : ''}`, display(row.phone), `<span class="wrap-cell">${display(row.subtitle)}</span><small>${escape(row.recordCount ?? 0)} 条登记</small>`,
    `<span class="wrap-cell">${display(row.source)}</span>`, display(row.sales), display(row.registeredOn), rowSource(row),
  ]));
  else rows = table(['记录编号', '客户 / 联系电话', '股票 / 代码', '来源渠道', '销售', '登记日期', ...(metric === 'records' ? ['跟进状态', '案件进度'] : ['当前进度']), '数据来源'], data.items.map(row => [
    display(row.number), `${display(row.title)}<small>${display(row.phone)}</small>`, `<span class="wrap-cell">${display(row.stockName || row.subtitle)}</span><small>${display(row.stockCode)}</small>${metric !== 'records' && row.subtitle && row.stockName ? `<small class="wrap-cell">${escape(row.subtitle)}</small>` : ''}`,
    `<span class="wrap-cell">${display(row.source)}</span>`, display(row.sales), display(row.registeredOn),
    ...(metric === 'records' ? [display(row.followStatus), display(row.caseStatus)] : [display(row.caseStatus || row.status)]), rowSource(row),
  ]));
  const page = Math.floor(data.offset / data.limit) + 1, pages = Math.max(1, Math.ceil(data.total / data.limit));
  const pager = `<nav class="list-pagination" aria-label="销售数据明细分页">${button('page', '上一页', `data-offset="${Math.max(0, data.offset - data.limit)}"${data.offset === 0 ? ' disabled' : ''}`)}
    <span>第 ${page} / ${pages} 页 · 每页 ${escape(data.limit)} 条</span>${button('page', '下一页', `data-offset="${data.offset + data.limit}"${data.offset + data.limit >= data.total ? ' disabled' : ''}`)}</nav>`;
  return panel('', controls + `<p class="muted" aria-live="polite">共 ${escape(data.total)} ${metricUnits[metric] || '条'}</p><p class="muted" data-order-label>排序：${escape(data.orderLabel || (metric === 'channels' ? orderLabels.sources : orderLabels.recent))}</p>` + rows + pager + notes(data.notes));
}

export function mountAdminSalesPanel(root, { request, sales = [], initialState = {}, onState, onError, onRegistry, isCurrent = () => true } = {}) {
  let state = { filters: { salesId: '', q: '', ...initialState.filters }, detail: initialState.detail ? { ...initialState.detail } : null };
  let overview, detailData, loading = false, error = '', controller, sequence = 0, disposed = false;
  const active = () => !disposed && root.isConnected && isCurrent();
  const notify = () => onState?.({ filters: { ...state.filters }, detail: state.detail ? { ...state.detail } : null });
  function render() {
    if (!active()) return;
    root.setAttribute('aria-busy', String(loading));
    root.innerHTML = (state.detail ? renderAdminSalesDetails(detailData, state.detail) : renderAdminSalesOverview(overview, state.filters, sales)) +
      (loading ? '<div class="panel" role="status">正在加载销售数据…</div>' : '') +
      (error ? `<div class="panel"><p role="alert" class="admin-sales-error">${escape(error)}</p>${button('refresh', '重新加载')}</div>` : '');
  }
  async function load() {
    if (!active()) return;
    controller?.abort();
    controller = new AbortController();
    const currentSequence = ++sequence;
    const current = () => active() && currentSequence === sequence;
    loading = true; error = ''; overview = state.detail ? overview : null; detailData = null;
    notify(); render();
    const detail = state.detail;
    const params = detail ? { salesId: detail.salesId, metric: detail.metric, sourceKey: detail.sourceKey || '', origin: detail.origin || 'all', q: detail.q || '', offset: detail.offset || 0 } : state.filters;
    try {
      const result = await request(`/sales/${detail ? 'details' : 'overview'}?${new URLSearchParams(params)}`, undefined, controller.signal);
      if (!current()) return;
      if (detail) {
        if (!result || !Array.isArray(result.items) || !Number.isInteger(result.total) || result.total < 0 || !Number.isInteger(result.offset) || result.offset < 0 || !Number.isInteger(result.limit) || result.limit < 1) throw new Error('明细数据暂未完整返回，请重试');
        detailData = result;
        state.detail.offset = result.offset;
      } else {
        if (!result || !Array.isArray(result.rows) || !result.meta) throw new Error('汇总数据暂未完整返回，请重试');
        overview = result;
      }
      notify();
    } catch (failure) {
      if (!current() || failure.name === 'AbortError') return;
      error = failure.message || '暂时无法加载，请重试';
      if (failure.status === 401) onError?.(failure);
    } finally {
      if (current()) { loading = false; render(); }
    }
  }
  function loadOverview(filters = state.filters) {
    state = { filters: { ...filters }, detail: null };
    return load();
  }
  function openDetail(detail) {
    if (!detail.salesId || !metricLabels[detail.metric]) return;
    state.detail = { origin: 'all', q: '', offset: 0, sourceKey: '', sourceName: '', ...detail };
    return load();
  }
  function loadDetails(patch) {
    if (!state.detail) return;
    state.detail = { ...state.detail, ...patch };
    return load();
  }
  const click = event => {
    const target = event.target.closest('[data-admin-sales-action]');
    if (!target || !root.contains(target) || !active()) return;
    const data = target.dataset;
    switch (data.adminSalesAction) {
      case 'detail': void openDetail({ salesId: data.salesId, salesName: data.salesName, metric: data.metric, sourceKey: data.sourceKey, sourceName: data.sourceName }); break;
      case 'back': void loadOverview(); break;
      case 'overview-reset': void loadOverview({ salesId: '', q: '' }); break;
      case 'refresh': void load(); break;
      case 'registry': onRegistry?.(); break;
      case 'metric': if (metricLabels[data.metric]) void loadDetails({ metric: data.metric, offset: 0 }); break;
      case 'source-records': void loadDetails({ metric: 'records', sourceKey: data.sourceKey, sourceName: data.sourceName, q: '', offset: 0 }); break;
      case 'clear-source': void loadDetails({ sourceKey: '', sourceName: '', offset: 0 }); break;
      case 'detail-reset': void loadDetails({ q: '', origin: 'all', offset: 0 }); break;
      case 'page': if (!loading && Number.isSafeInteger(Number(data.offset)) && Number(data.offset) >= 0) void loadDetails({ offset: Number(data.offset) }); break;
    }
  };
  const submit = event => {
    const form = event.target.closest('[data-admin-sales-form]');
    if (!form || !root.contains(form) || !active()) return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    if (form.dataset.adminSalesForm === 'overview') void loadOverview({ salesId: values.salesId || '', q: String(values.q || '').trim() });
    else void loadDetails({ q: String(values.q || '').trim(), origin: ['all', 'system', 'registry'].includes(values.origin) ? values.origin : 'all', offset: 0 });
  };
  root.addEventListener('click', click);
  root.addEventListener('submit', submit);
  const ready = load();
  return { ready, loadOverview, openDetail, loadDetails, refresh: load,
    dispose() { disposed = true; sequence++; controller?.abort(); root.removeEventListener('click', click); root.removeEventListener('submit', submit); } };
}
