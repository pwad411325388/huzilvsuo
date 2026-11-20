const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const display = value => escape(value === '' || value == null ? '—' : value);
const types = { records: '留资与登记', customers: '客户档案', channels: '来源渠道', cases: '客户案件', signed: '已签约档案', sales: '销售汇总' };
const units = { records: '条', customers: '份', channels: '个', cases: '件', signed: '份', sales: '位' };
const origins = { system: '小程序数据', registry: '历史登记', mixed: '小程序及历史登记' };
const button = (action, label, attrs = '', css = 'secondary') => `<button type="button" class="${css}" data-admin-data-action="${action}" ${attrs}>${escape(label)}</button>`;
const panel = (title, body) => `<section class="panel">${title ? `<h2>${escape(title)}</h2>` : ''}${body}</section>`;
const field = (label, input) => `<label class="field"><span>${escape(label)}</span>${input}</label>`;
const select = (name, options, value = '', attributes = '') => `<select name="${name}" ${attributes}>${options.map(([key, label]) => `<option value="${escape(key)}"${value === key ? ' selected' : ''}>${escape(label)}</option>`).join('')}</select>`;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const filterDefaults = { sourceKey: '', salesId: '', origin: 'all', status: 'all', q: '' };
const headings = { channels: '渠道管理', cases: '客户案件', reports: '数据报表' };
const actionNote = note => /缺少有效登记日期|登记日期晚于今天|未来日期|请.*核对/.test(note);
function dataNotes(data) {
  const values = [data.definition, ...(data.notes || [])].filter(Boolean);
  const paragraph = note => `<p class="muted">${escape(note)}</p>`;
  const guidance = values.filter(note => !actionNote(note));
  return values.filter(actionNote).map(paragraph).join('') +
    (data.meta?.futureRegistryCount ? `<p class="muted">另有 ${escape(data.meta.futureRegistryCount)} 条登记日期晚于今天，暂未计入统计，请核对日期。</p>` : '') +
    (guidance.length ? `<details class="panel"><summary>数据说明</summary>${guidance.map(paragraph).join('')}</details>` : '');
}

export function adminDataQuery(state, exporting = false) {
  const params = { type: state.type, period: state.period, sourceKey: state.sourceKey, salesId: state.salesId, origin: state.origin, status: state.status, q: state.q };
  if (state.period === 'custom') Object.assign(params, { from: state.from, to: state.to });
  if (!exporting) params.offset = state.offset;
  return new URLSearchParams(params).toString();
}

export function renderAdminDataPanel(data, state, { page = 'reports', today = '', choices = {}, loading = false, exporting = false, dateError = '', error = '', notice = '' } = {}) {
  const periodLabel = state.period === 'all' ? '全部时间' : state.period === 'month' ? data ? `本月：${data.from} 至 ${data.to}` : '本月（截至今天）' : `自选日期：${state.from} 至 ${state.to}`;
  const typeSelector = page === 'reports' ? field('报表类型', select('type', Object.entries(types), state.type, 'data-admin-data-type')) : '';
  const sourceOptions = [['', '全部来源'], ...(choices.sources || []).map(row => [row.key, row.name])];
  const salesOptions = [['', '全部销售'], ...(choices.sales || []).map(row => [row.id, row.name])];
  const statusOptions = choices.statuses?.length ? choices.statuses.map(row => [row.key, row.label]) : [['all', '全部状态']];
  if (!statusOptions.some(([key]) => key === 'all')) statusOptions.unshift(['all', '全部状态']);
  for (const [options, selected] of [[sourceOptions, state.draft.sourceKey], [salesOptions, state.draft.salesId], [statusOptions, state.draft.status]]) {
    if (selected && !options.some(([key]) => key === selected)) options.push([selected, '当前筛选（待加载）']);
  }
  const controls = panel(headings[page] || '数据查询', `
    ${typeSelector ? `<div class="inline-form admin-data-type">${typeSelector}</div>` : ''}
    <div class="overview-period-bar"><div class="filters" aria-label="统计期间">${['all', 'month'].map(value => button('period', value === 'all' ? '全部' : '本月', `data-period="${value}" aria-pressed="${state.period === value}"`, `chip${state.period === value ? ' selected' : ''}`)).join('')}</div>${button('refresh', '刷新数据')}</div>
    <form data-admin-data-form="dates" class="inline-form overview-dates" novalidate>
      ${field('起始日期', `<input type="date" name="from" value="${escape(state.draftFrom)}"${today ? ` max="${escape(today)}"` : ''}>`)}
      ${field('结束日期', `<input type="date" name="to" value="${escape(state.draftTo)}"${today ? ` max="${escape(today)}"` : ''}>`)}<button class="${state.period === 'custom' ? 'primary' : 'secondary'}">按日期查看</button></form>
    ${dateError ? `<p class="overview-error" role="alert">${escape(dateError)}</p>` : ''}
    <p class="overview-scope" data-admin-data-scope>${escape(periodLabel)}</p>
    ${state.sourceReturn ? `<p>来源明细：${escape(state.sourceName || '所选来源')} ${button('back-channels', '返回来源列表')}</p>` : ''}
    <form data-admin-data-form="filters" class="form-grid query-grid">
      ${field('来源渠道', select('sourceKey', sourceOptions, state.draft.sourceKey))}
      ${field('销售', select('salesId', salesOptions, state.draft.salesId))}
      ${field('数据来源', select('origin', [['all', '全部数据'], ['system', '小程序数据'], ['registry', '历史登记']], state.draft.origin))}
      ${field('当前状态', select('status', statusOptions, state.draft.status))}
      ${field('搜索明细', `<input type="search" name="q" value="${escape(state.draft.q)}" maxlength="100" placeholder="姓名、电话、股票、来源或销售">`)}
      <div class="inline-form"><button class="primary">查询</button>${button('reset', '重置筛选')}</div>
    </form>`);
  let content = '';
  if (data) {
    const unit = units[state.type] || '条';
    const header = `<div class="overview-detail-heading"><h2>${escape(data.title || types[state.type])}</h2>${button('export', exporting ? '正在导出…' : '导出 Excel', exporting || loading ? 'disabled' : '')}</div>
      <p data-admin-data-count aria-live="polite">共 ${escape(data.total)} ${escape(unit)} · 导出当前查询的全部结果</p><p class="muted">修改筛选后请点击查询，再导出结果。</p>`;
    const rows = data.items.length ? `<div class="table-wrap"><table><thead><tr>${data.columns.map(column => `<th scope="col">${escape(column.label)}</th>`).join('')}${state.type === 'channels' ? '<th scope="col">操作</th>' : ''}</tr></thead><tbody>${data.items.map(row => `<tr>${data.columns.map(column => {
      const value = column.key === 'origin' ? origins[row.origin] || row.origin : row[column.key];
      return `<td><span class="${['title', 'name', 'source', 'sales', 'subtitle', 'stockName'].includes(column.key) ? 'wrap-cell' : ''}">${display(value)}</span></td>`;
    }).join('')}${state.type === 'channels' ? `<td>${button('source-records', '查看留资与登记', `data-source-key="${escape(row.sourceKey || row.key || row.id)}" data-source-name="${escape(row.title || row.name)}"`)}</td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<div class="empty">当前范围暂无符合条件的数据</div>';
    const pages = Math.max(1, Math.ceil(data.total / data.limit));
    const pager = `<nav class="list-pagination" aria-label="业务数据分页">${button('page', '上一页', `data-offset="${Math.max(0, data.offset - data.limit)}"${data.offset === 0 ? ' disabled' : ''}`)}<span>第 ${Math.floor(data.offset / data.limit) + 1} / ${pages} 页 · 每页 ${escape(data.limit)} 条</span>${button('page', '下一页', `data-offset="${data.offset + data.limit}"${data.offset + data.limit >= data.total ? ' disabled' : ''}`)}</nav>`;
    content = panel('', header + rows + pager) + dataNotes(data);
  }
  return controls + content + (loading ? panel('', '<p role="status">正在加载业务数据…</p>') : '') +
    (error ? panel('', `<p class="overview-error" role="alert">${escape(error)}</p>${button('refresh', '重新加载')}`) : '') +
    (notice ? panel('', `<p role="status">${escape(notice)}</p>`) : '');
}

export function mountAdminDataPanel(root, { request, download, page = 'reports', initialState = {}, today: initialToday = '', onState, onError, isCurrent = () => true } = {}) {
  let state = { ...filterDefaults, type: page === 'channels' ? 'channels' : page === 'cases' ? 'cases' : 'records', period: 'all', from: '', to: '', draftFrom: '', draftTo: '', offset: 0, sourceReturn: null, ...initialState };
  if (!types[state.type]) state.type = 'records';
  if (!['all', 'month', 'custom'].includes(state.period) || state.period === 'custom' && (!validDate(state.from) || !validDate(state.to) || state.from > state.to)) state.period = 'all';
  if (!Number.isSafeInteger(state.offset) || state.offset < 0) state.offset = 0;
  state.draft = { ...filterDefaults, ...Object.fromEntries(Object.keys(filterDefaults).map(key => [key, state[key]])), ...initialState.draft };
  let data, choices = {}, today = initialToday, loading = false, exporting = false, dateError = '', error = '', notice = '', disposed = false, sequence = 0, exportSequence = 0, controller, exportController;
  const active = () => !disposed && root.isConnected && isCurrent();
  const notify = () => onState?.({ ...state, draft: { ...state.draft }, sourceReturn: state.sourceReturn ? { ...state.sourceReturn } : null });
  const render = () => {
    if (!active()) return;
    root.setAttribute('aria-busy', String(loading));
    root.innerHTML = renderAdminDataPanel(data, state, { page, today, choices, loading, exporting, dateError, error, notice });
  };
  function cancelExport() { exportController?.abort(); exportSequence++; exporting = false; }
  async function load() {
    if (!active()) return;
    controller?.abort(); cancelExport(); controller = new AbortController();
    const id = ++sequence, current = () => active() && id === sequence;
    loading = true; error = ''; notice = ''; data = null; notify(); render();
    try {
      const response = await request(`/data?${adminDataQuery(state)}`, undefined, controller.signal);
      if (!current()) return;
      if (!response || response.type !== state.type || response.period !== state.period || !Array.isArray(response.columns) || !response.columns.length
        || !Array.isArray(response.items) || !Number.isInteger(response.total) || response.total < 0 || !Number.isInteger(response.offset) || response.offset < 0
        || !Number.isInteger(response.limit) || response.limit < 1 || !validDate(response.today) || !response.filters) throw new Error('业务数据暂未完整返回，请重试');
      data = response; choices = response.filters; today = response.today; state.offset = response.offset; notify();
    } catch (failure) {
      if (!current() || failure.name === 'AbortError') return;
      error = failure.message || '暂时无法加载业务数据'; if (failure.status === 401) onError?.(failure);
    } finally { if (current()) { loading = false; render(); } }
  }
  function setPeriod(period) {
    if (!['all', 'month'].includes(period)) return;
    state.period = period; state.offset = 0; dateError = ''; return load();
  }
  function applyDates(from = state.draftFrom, to = state.draftTo) {
    state.draftFrom = String(from || ''); state.draftTo = String(to || ''); notify();
    dateError = !validDate(from) || !validDate(to) ? '请选择有效的起始日期和结束日期。' : from > to ? '起始日期不能晚于结束日期。' : today && to > today ? '结束日期不能晚于今天。' : '';
    if (dateError) { render(); return; }
    Object.assign(state, { period: 'custom', from, to, offset: 0 }); return load();
  }
  function applyFilters(value = state.draft) {
    const next = { ...filterDefaults, ...value, q: String(value.q || '').trim().slice(0, 100) };
    if (!['all', 'system', 'registry'].includes(next.origin)) next.origin = 'all';
    Object.assign(state, next, { draft: { ...next }, offset: 0 });
    if (state.sourceReturn) state.sourceName = next.sourceKey ? choices.sources?.find(row => row.key === next.sourceKey)?.name || '所选来源' : '全部来源';
    return load();
  }
  function setType(type) {
    if (!types[type]) return;
    Object.assign(state, { type, status: 'all', offset: 0, sourceReturn: null, sourceName: '' }); state.draft.status = 'all'; return load();
  }
  function sourceRecords(sourceKey, sourceName = '') {
    if (!sourceKey) return;
    state.sourceReturn = { type: state.type, sourceKey: state.sourceKey, q: state.q, status: state.status, offset: state.offset };
    Object.assign(state, { type: 'records', sourceKey, sourceName, status: 'all', q: '', offset: 0 });
    state.draft = Object.fromEntries(Object.keys(filterDefaults).map(key => [key, state[key]])); return load();
  }
  function backChannels() {
    if (!state.sourceReturn) return;
    Object.assign(state, state.sourceReturn, { sourceReturn: null, sourceName: '' });
    state.draft = Object.fromEntries(Object.keys(filterDefaults).map(key => [key, state[key]])); return load();
  }
  function setPage(offset) {
    if (loading || !Number.isSafeInteger(offset) || offset < 0) return;
    state.offset = offset; return load();
  }
  async function exportData() {
    if (!active() || loading || exporting || !data || !download) return;
    exportController = new AbortController();
    const id = ++exportSequence, current = () => active() && id === exportSequence;
    exporting = true; error = ''; notice = ''; render();
    try {
      await download(`/data/export?${adminDataQuery(state, true)}&format=xlsx`, `${types[state.type]}.xlsx`, exportController.signal, current);
      if (current()) notice = '已导出当前筛选的全部结果。';
    } catch (failure) {
      if (!current() || failure.name === 'AbortError') return;
      error = failure.message || '导出失败，请重试'; if (failure.status === 401) onError?.(failure);
    } finally { if (current()) { exporting = false; render(); } }
  }
  const click = event => {
    const target = event.target.closest('[data-admin-data-action]');
    if (!target || !root.contains(target) || !active() || target.disabled) return;
    const attrs = target.dataset;
    switch (attrs.adminDataAction) {
      case 'period': void setPeriod(attrs.period); break;
      case 'refresh': void load(); break;
      case 'reset': void applyFilters(filterDefaults); break;
      case 'page': void setPage(Number(attrs.offset)); break;
      case 'source-records': void sourceRecords(attrs.sourceKey, attrs.sourceName); break;
      case 'back-channels': void backChannels(); break;
      case 'export': void exportData(); break;
    }
  };
  const submit = event => {
    const form = event.target.closest('[data-admin-data-form]');
    if (!form || !root.contains(form) || !active()) return;
    event.preventDefault(); const values = Object.fromEntries(new FormData(form));
    if (form.dataset.adminDataForm === 'dates') void applyDates(String(values.from || ''), String(values.to || ''));
    if (form.dataset.adminDataForm === 'filters') void applyFilters(values);
  };
  const input = event => {
    const target = event.target;
    if (!root.contains(target) || !active()) return;
    if (event.type === 'change' && target.matches('[data-admin-data-type]')) { void setType(target.value); return; }
    const form = target.closest('[data-admin-data-form]'); if (!form) return;
    if (form.dataset.adminDataForm === 'dates' && ['from', 'to'].includes(target.name)) state[target.name === 'from' ? 'draftFrom' : 'draftTo'] = target.value;
    else if (form.dataset.adminDataForm === 'filters' && Object.hasOwn(filterDefaults, target.name)) state.draft[target.name] = target.value;
    else return;
    notify();
  };
  root.addEventListener('click', click); root.addEventListener('submit', submit); root.addEventListener('input', input); root.addEventListener('change', input);
  const ready = load();
  return { ready, setPeriod, applyDates, applyFilters, setType, sourceRecords, backChannels, setPage, exportData, refresh: load,
    dispose() { disposed = true; sequence++; controller?.abort(); cancelExport(); root.removeEventListener('click', click); root.removeEventListener('submit', submit); root.removeEventListener('input', input); root.removeEventListener('change', input); } };
}
