import { orderLabels } from './list-order.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const display = value => escape(value === '' || value == null ? '—' : value);
const metricLabels = { records: '留资与登记', customers: '客户档案', channels: '来源渠道', pending: '待分配 / 关联', ongoing: '在办案件', closed: '已结案件', registry: '历史登记', signed: '已签约档案' };
const metricUnits = { records: '条', customers: '份', channels: '个', pending: '条', ongoing: '件', closed: '件', registry: '条', signed: '份' };
const originLabels = { system: '小程序数据', registry: '历史登记', mixed: '小程序及历史登记' };
const queueLabels = { system_new: '新留资待分配', system_legacy: '历史留资待核对', registry_unlinked: '历史登记未关联销售' };
const button = (action, label, attrs = '', className = 'secondary') => `<button type="button" class="${className}" data-overview-action="${action}" ${attrs}>${escape(label)}</button>`;
const panel = (title, body) => `<section class="panel">${title ? `<h2>${escape(title)}</h2>` : ''}${body}</section>`;
const table = (headers, rows) => rows.length ? `<div class="table-wrap"><table><thead><tr>${headers.map(value => `<th scope="col">${escape(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="empty">当前范围暂无符合条件的数据</div>';
const origin = row => `<span class="tag">${escape(originLabels[row.origin] || row.origin || '—')}</span>`;
const wrap = value => `<span class="wrap-cell">${display(value)}</span>`;
const notes = values => (values || []).map(value => `<p class="muted">${escape(value)}</p>`).join('');
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function scopeLabel(state, data) {
  if (state.period === 'all') return '累计全部数据（含历史同步）';
  if (state.period === 'month') return data ? `本月：${data.from} 至 ${data.to}` : '本月（截至今天）';
  return `自选日期：${state.from} 至 ${state.to}`;
}

export function renderOverviewControls(state, data, { today = '', dateError = '' } = {}) {
  return panel('统计范围', `<div class="overview-period-bar"><div class="filters" aria-label="统计期间">
    ${button('period', '全部', `data-period="all" aria-pressed="${state.period === 'all'}"`, `chip${state.period === 'all' ? ' selected' : ''}`)}
    ${button('period', '本月', `data-period="month" aria-pressed="${state.period === 'month'}"`, `chip${state.period === 'month' ? ' selected' : ''}`)}
    </div>${button('refresh', '刷新数据')}</div>
    <form data-overview-form="dates" class="inline-form overview-dates" novalidate>
      <label class="field"><span>起始日期</span><input type="date" name="from" value="${escape(state.draftFrom)}"${today ? ` max="${escape(today)}"` : ''}></label>
      <label class="field"><span>结束日期</span><input type="date" name="to" value="${escape(state.draftTo)}"${today ? ` max="${escape(today)}"` : ''}></label>
      <button class="${state.period === 'custom' ? 'primary' : 'secondary'}">按日期查看</button>
    </form>${dateError ? `<p class="overview-error" role="alert">${escape(dateError)}</p>` : ''}
    <p class="overview-scope" data-overview-scope>${escape(scopeLabel(state, data))}</p>
    <p class="muted">测试阶段按留资 / 材料登记日期筛选，展示当前状态；签约、结案不代表在所选期间发生。</p>`);
}

function recordTable(items, metric = 'records') {
  const records = ['records', 'registry', 'pending'].includes(metric);
  return table(['记录编号', '客户 / 联系电话', '股票 / 代码', '来源渠道', '销售', '登记日期', ...(metric === 'pending' ? ['待处理事项'] : []), ...(records ? ['跟进状态', '案件进度'] : ['当前进度']), '数据来源'], items.map(row => [
    display(row.number), `${wrap(row.title)}<small>${display(row.phone)}</small>`, `${wrap(row.stockName || row.subtitle)}<small>${display(row.stockCode)}</small>${!records && row.subtitle && row.stockName ? `<small class="wrap-cell">${escape(row.subtitle)}</small>` : ''}`,
    wrap(row.source), wrap(row.sales), display(row.registeredOn), ...(metric === 'pending' ? [display(row.status)] : []),
    ...(records ? [display(row.followStatus), display(row.caseStatus || row.status)] : [display(row.caseStatus || row.status)]), origin(row),
  ]));
}

export function renderOverviewSummary(data) {
  if (!data) return '';
  const cards = `<div class="overview-cards">${data.metrics.map(row => `<button type="button" class="stat-card" data-overview-action="metric" data-metric="${escape(row.key)}" aria-label="${escape(row.label)} ${escape(row.value)} ${escape(row.unit)}，查看明细"><strong data-overview-value="${escape(row.key)}">${escape(row.value)}<small>${escape(row.unit)}</small></strong><span>${escape(row.label)}</span><small class="stat-link">查看明细 →</small></button>`).join('')}</div>`;
  const queueNotes = { system_new: '核对券商绑定销售或股票公司负责人。', system_legacy: '确认小程序历史留资的经办人。', registry_unlinked: '核对登记表中的销售资料与账号关联。' };
  const queues = panel('需要处理', `<p>以下数量与上方统计期间一致。</p><p class="muted" data-order-label>排序：${escape(data.queueOrderLabel || orderLabels.pending)}</p><div class="action-grid overview-queues">${data.queues.map(row => `<div><strong>${escape(row.value)} ${escape(row.unit)}${escape(row.label)}</strong><p>${escape(queueNotes[row.key] || '')}</p>${button('queue', '查看明细', `data-queue="${escape(row.key)}"`)}</div>`).join('')}</div>`);
  const meta = data.meta || {};
  const sourceTotal = meta.registrySourceTotal ?? meta.registryTotal;
  const source = meta.sourceName ? `<p>源台账：${escape(meta.sourceName)}${Number.isInteger(sourceTotal) ? `（源台账共 ${escape(sourceTotal)} 条）` : ''}</p>` : '';
  const withinRange = Number.isInteger(meta.systemRecordCount) && Number.isInteger(meta.registryCount) ? `<p>当前期间：小程序 ${escape(meta.systemRecordCount)} 条，历史登记 ${escape(meta.registryCount)} 条。</p>` : '';
  return cards + queues + panel('最近登记', `<p>当前期间最近 6 条留资与历史登记。</p><p class="muted" data-order-label>排序：${escape(data.recentOrderLabel || orderLabels.recent)}</p>` + recordTable(data.recent)) +
    panel('统计说明', source + withinRange + notes(data.notes));
}

export function renderOverviewDetails(data, state) {
  const caption = metricLabels[state.metric] || '明细';
  const controls = `<div class="overview-detail-heading"><h2>${escape(state.queue ? queueLabels[state.queue] : caption)}明细</h2>${button('back', '返回数据总览')}</div>
    ${state.queue ? `<p class="overview-scope">当前队列：${escape(queueLabels[state.queue])} ${button('clear-queue', '查看全部待分配 / 关联')}</p>` : ''}
    <form data-overview-form="search" class="inline-form" role="search">
      <label class="field"><span>搜索明细</span><input type="search" name="q" value="${escape(state.searchDraft)}" maxlength="100" placeholder="姓名、电话、股票名称 / 代码、来源渠道或销售"></label>
      <button class="primary">搜索明细</button>${button('reset-search', '重置')}</form>`;
  if (!data) return panel('', controls);
  let rows;
  if (state.metric === 'channels') rows = table(['来源渠道', '来源类型', '留资与登记', '客户档案', '最近登记日期'], data.items.map(row => [
    `${wrap(row.title || row.name)}<small>${display(row.status)}</small>`, origin(row), `${escape(row.recordCount ?? 0)} 条`, `${escape(row.customerCount ?? 0)} 份`, display(row.registeredOn),
  ]));
  else if (['customers', 'signed'].includes(state.metric)) rows = table(['客户', '联系电话', '股票与登记', '来源渠道', '销售', '登记日期', ...(state.metric === 'signed' ? ['实际签约日期'] : []), '数据来源'], data.items.map(row => [
    `${wrap(row.title)}${row.status ? `<small>${escape(row.status)}</small>` : ''}`, display(row.phone), `${wrap(row.subtitle)}<small>${escape(row.recordCount ?? 0)} 条登记</small>`, wrap(row.source), wrap(row.sales), display(row.registeredOn), ...(state.metric === 'signed' ? [display(row.signedOn)] : []), origin(row),
  ]));
  else rows = recordTable(data.items, state.metric);
  const selected = data.metrics.find(row => row.key === state.metric);
  const scopeTotal = state.queue ? data.queues.find(row => row.key === state.queue)?.value : selected?.value;
  const unit = selected?.unit || metricUnits[state.metric];
  const page = Math.floor(data.offset / data.limit) + 1, pages = Math.max(1, Math.ceil(data.total / data.limit));
  const pager = `<nav class="list-pagination" aria-label="总览明细分页">${button('page', '上一页', `data-offset="${Math.max(0, data.offset - data.limit)}"${data.offset === 0 ? ' disabled' : ''}`)}<span>第 ${page} / ${pages} 页 · 每页 ${escape(data.limit)} 条</span>${button('page', '下一页', `data-offset="${data.offset + data.limit}"${data.offset + data.limit >= data.total ? ' disabled' : ''}`)}</nav>`;
  return panel('', controls + `<p class="overview-count muted" data-overview-count aria-live="polite">当前范围 ${escape(scopeTotal ?? data.total)} ${escape(unit)} · 检索结果 ${escape(data.total)} ${escape(unit)}</p><p class="muted" data-order-label>排序：${escape(data.orderLabel || (state.metric === 'channels' ? orderLabels.sources : state.metric === 'pending' ? orderLabels.pending : orderLabels.recent))}</p>` + rows + pager) + (data.notes?.length ? panel('统计说明', notes(data.notes)) : '');
}

function initialFilters(value) {
  const state = { period: 'all', from: '', to: '', draftFrom: '', draftTo: '', detail: false, metric: 'records', q: '', searchDraft: '', offset: 0, queue: '', ...value };
  if (!['all', 'month', 'custom'].includes(state.period) || (state.period === 'custom' && (!validDate(state.from) || !validDate(state.to) || state.from > state.to))) state.period = 'all';
  if (!metricLabels[state.metric]) state.metric = 'records';
  if (state.metric !== 'pending' || !queueLabels[state.queue]) state.queue = '';
  if (!Number.isSafeInteger(state.offset) || state.offset < 0) state.offset = 0;
  if (!state.detail) Object.assign(state, { metric: 'records', q: '', searchDraft: '', offset: 0, queue: '' });
  return state;
}

export function mountOverviewPanel(root, { request, initialState = {}, today: initialToday = '', onState, onError, isCurrent = () => true } = {}) {
  let state = initialFilters(initialState), data, loading = false, error = '', dateError = '', today = initialToday;
  let sequence = 0, controller, disposed = false;
  const active = () => !disposed && root.isConnected && isCurrent();
  const notify = () => onState?.({ ...state });
  function render() {
    if (!active()) return;
    root.setAttribute('aria-busy', String(loading));
    root.innerHTML = renderOverviewControls(state, data, { today, dateError }) +
      (state.detail ? renderOverviewDetails(data, state) : renderOverviewSummary(data)) +
      (loading ? '<section class="panel" role="status">正在加载统计数据…</section>' : '') +
      (error ? panel('', `<p role="alert" class="overview-error">${escape(error)}</p>${button('refresh', '重新加载')}`) : '');
  }
  async function load() {
    if (!active()) return;
    controller?.abort();
    controller = new AbortController();
    const currentSequence = ++sequence;
    const current = () => active() && currentSequence === sequence;
    loading = true; error = ''; data = null;
    notify(); render();
    const params = { period: state.period, metric: state.metric, q: state.q, offset: state.offset };
    if (state.period === 'custom') Object.assign(params, { from: state.from, to: state.to });
    if (state.queue) params.queue = state.queue;
    try {
      const result = await request(`/overview?${new URLSearchParams(params)}`, undefined, controller.signal);
      if (!current()) return;
      if (!result || !Array.isArray(result.metrics) || Object.keys(metricLabels).some(key => !result.metrics.some(row => row.key === key && Number.isInteger(row.value) && row.value >= 0))
        || result.selected !== state.metric || !Array.isArray(result.items) || !Array.isArray(result.queues) || !Array.isArray(result.recent)
        || !Number.isInteger(result.total) || result.total < 0 || !Number.isInteger(result.offset) || result.offset < 0 || !Number.isInteger(result.limit) || result.limit < 1
        || !validDate(result.today) || result.period !== state.period) throw new Error('统计数据暂未完整返回，请重试');
      data = result; state.offset = result.offset; today = result.today;
      notify();
    } catch (failure) {
      if (!current() || failure.name === 'AbortError') return;
      error = failure.message || '暂时无法加载统计数据，请重试';
      if (failure.status === 401) onError?.(failure);
    } finally {
      if (current()) { loading = false; render(); }
    }
  }
  function setPeriod(period) {
    if (!['all', 'month'].includes(period)) return;
    state.period = period; state.offset = 0; dateError = '';
    return load();
  }
  function setDraftDates(from, to) {
    state.draftFrom = String(from || ''); state.draftTo = String(to || ''); notify();
  }
  function applyDates(from = state.draftFrom, to = state.draftTo) {
    setDraftDates(from, to);
    dateError = !validDate(from) || !validDate(to) ? '请选择有效的起始日期和结束日期。' : from > to ? '起始日期不能晚于结束日期。' : today && to > today ? '结束日期不能晚于今天。' : '';
    if (dateError) { render(); return; }
    Object.assign(state, { period: 'custom', from, to, offset: 0 });
    return load();
  }
  function openDetail(metric, queue = '') {
    if (!metricLabels[metric] || (queue && (metric !== 'pending' || !queueLabels[queue]))) return;
    Object.assign(state, { detail: true, metric, queue, q: '', searchDraft: '', offset: 0 });
    return load();
  }
  function back() {
    Object.assign(state, { detail: false, metric: 'records', queue: '', q: '', searchDraft: '', offset: 0 });
    return load();
  }
  function search(q = '') {
    if (!state.detail) return;
    state.q = String(q).trim().slice(0, 100); state.searchDraft = state.q; state.offset = 0;
    return load();
  }
  function setPage(offset) {
    if (!state.detail || loading || !Number.isSafeInteger(offset) || offset < 0) return;
    state.offset = offset;
    return load();
  }
  const click = event => {
    const target = event.target.closest('[data-overview-action]');
    if (!target || !root.contains(target) || !active() || target.disabled) return;
    const attrs = target.dataset;
    switch (attrs.overviewAction) {
      case 'period': void setPeriod(attrs.period); break;
      case 'refresh': void load(); break;
      case 'metric': void openDetail(attrs.metric); break;
      case 'queue': void openDetail('pending', attrs.queue); break;
      case 'clear-queue': void openDetail('pending'); break;
      case 'back': void back(); break;
      case 'reset-search': void search(); break;
      case 'page': void setPage(Number(attrs.offset)); break;
    }
  };
  const submit = event => {
    const form = event.target.closest('[data-overview-form]');
    if (!form || !root.contains(form) || !active()) return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    if (form.dataset.overviewForm === 'dates') void applyDates(String(values.from || ''), String(values.to || ''));
    if (form.dataset.overviewForm === 'search') void search(values.q);
  };
  const input = event => {
    const target = event.target, form = target.closest('[data-overview-form]');
    if (!form || !root.contains(form) || !active()) return;
    if (form.dataset.overviewForm === 'dates' && ['from', 'to'].includes(target.name)) {
      state[target.name === 'from' ? 'draftFrom' : 'draftTo'] = target.value;
    } else if (form.dataset.overviewForm === 'search' && target.name === 'q') state.searchDraft = target.value;
    else return;
    notify();
  };
  root.addEventListener('click', click);
  root.addEventListener('submit', submit);
  root.addEventListener('input', input);
  root.addEventListener('change', input);
  const ready = load();
  return { ready, setPeriod, setDraftDates, applyDates, openDetail, back, search, setPage, refresh: load,
    dispose() { disposed = true; sequence++; controller?.abort(); root.removeEventListener('click', click); root.removeEventListener('submit', submit); root.removeEventListener('input', input); root.removeEventListener('change', input); } };
}
