const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const show = value => escape(value || '—');
const button = (action, label, attrs = '', primary = false) => `<button type="button" class="${primary ? 'primary' : 'secondary'}" data-records-action="${action}" ${attrs}>${escape(label)}</button>`;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const initial = { period: 'all', from: '', to: '', draftFrom: '', draftTo: '', q: '', draft: '', ledger: 'all', customerId: '', customerName: '', scopeNote: '', offset: 0, detail: null, listExpanded: true };

export function recordsQuery(state, role = 'sales') {
  const params = { period: state.period, q: state.q, offset: state.offset, limit: 5 };
  if (role === 'investor' && state.presentation === 'home') params.presentation = 'home';
  if (state.period === 'custom') Object.assign(params, { from: state.from, to: state.to });
  if (state.customerId) params.customerId = state.customerId;
  if (role === 'broker') params.ledger = state.ledger || 'all';
  return new URLSearchParams(params).toString();
}

// A signing event is filtered by signedOn; its stock records may have been
// registered in earlier months. Keep the board untouched for the return trip.
export function recordsEntryState(board, { role, customerId = '', customerName = '' } = {}) {
  const signingCustomer = role === 'broker' && customerId && (board.data?.selected || board.metric) === 'signings';
  const period = signingCustomer ? 'all' : board.period;
  const from = signingCustomer ? '' : board.rangeFrom || '', to = signingCustomer ? '' : board.rangeTo || '';
  return { ...initial, period, from, to, draftFrom: from, draftTo: to, customerId, customerName,
    scopeNote: signingCustomer ? '查看该签约客户的全部股票记录' : '' };
}

export function normalRecordsState(state = {}) {
  return { ...state, customerId: '', customerName: '', scopeNote: '', detail: null, parentDetail: null };
}

function visibleProgressSteps(confirmed, source) {
  if (!confirmed) return [];
  if (confirmed.uncertain) return [{ ...confirmed, status: 'current', uncertain: true, hideDate: true }];
  const steps = Array.isArray(source) ? source : [];
  const current = steps.find(step => step?.status === 'current' && step.stage === confirmed.stage && step.node === confirmed.node);
  if (!current) return [{ ...confirmed, status: 'current' }];
  if (current.stage === 'intake' && current.node === 'signed_waiting_filing' && steps.some(step => step?.status === 'active')) {
    const hasLabel = step => typeof step?.label === 'string' && step.label.trim() !== '';
    if (!hasLabel(current)) return [{ ...current, label: confirmed.label }];
    const labeled = steps.filter(hasLabel);
    const preparing = labeled.find(step => step.status === 'active' && step.stage === 'filing' && step.node === 'preparing');
    const submitted = labeled.find(step => step.status === 'next' && step.stage === 'filing' && step.node === 'submitted');
    if (preparing && submitted) return [current, preparing, submitted];
    // A broken preparation hand-off cannot promote submission to the immediate next step.
    const alternative = labeled.find(step => step.status === 'next' && step.node && (step.stage || step.node === 'pending_route')
      && !(step.stage === 'filing' && step.node === 'submitted'));
    return alternative ? [current, alternative] : [current];
  }
  const next = steps.find(step => step?.status === 'next');
  return next ? [current, next] : [current];
}

export function renderRecordProgress(detail, role) {
  if (!detail) return '<p role="status">正在读取记录详情…</p>';
  const projection = !detail.current && detail.displayProgress;
  const confirmed = detail.current || projection?.current || {
    stage: 'unknown', node: 'unconfirmed', stageLabel: '案件进度', label: '待核对', uncertain: true, hideDate: true,
  };
  const steps = visibleProgressSteps(confirmed, detail.current ? detail.steps : projection?.steps);
  const notice = detail.current ? '' : projection?.notice || (confirmed.uncertain ? '当前资料尚未明确具体阶段，请以律所确认结果为准。' : '');
  const current = steps[0];
  const signingContract = !!detail.current && role === 'sales' && detail.contractNumber && current?.stage === 'intake' && ['signed', 'signed_waiting_filing'].includes(current.node);
  const timeline = steps.map(step => {
    const pendingRoute = !!detail.current && step.node === 'pending_route';
    const stageLabel = pendingRoute ? '后续进度' : step.stageLabel || (step.stage === confirmed.stage ? confirmed.stageLabel : '');
    const status = pendingRoute ? '待确认' : stageLabel ? step.label : '';
    const date = step.status === 'current' && validDate(step.date) ? step.date : '';
    return `<li class="progress-step" data-step-status="${step.status}"${step.status === 'current' ? ' aria-current="step"' : ''}${step.uncertain ? ' data-step-uncertain="true"' : ''}>
      <span class="progress-step-marker" aria-hidden="true">${step.status === 'current' ? step.uncertain ? '?' : '✓' : ''}</span><div class="progress-step-content">
      <span class="progress-position">${{current: '当前', active: '进行中', next: '下一步'}[step.status]}</span><div class="progress-step-heading"><div class="progress-step-title"><strong>${show(stageLabel || step.label)}</strong></div>${status || step.note ? `<small class="progress-step-status">${escape(status)}${step.note ? `${status ? ' · ' : ''}<span class="progress-step-note">${escape(step.note)}</span>` : ''}</small>` : ''}</div>
      ${step.status === 'current' && !step.hideDate && !step.uncertain ? `<div class="progress-step-date">${date ? `<time datetime="${date}" aria-label="${escape(step.dateLabel || '进度日期')}：${date.replaceAll('-', '.')}">${date.replaceAll('-', '.')}</time>` : '日期待补充'}</div>${signingContract ? `<small class="progress-step-contract">合同号：${escape(detail.contractNumber)}</small>` : ''}` : ''}</div></li>`;
  }).join('');

  return `<h2>${show(detail.title || detail.stockName)}</h2><p>${show(detail.stockCode)}${role === 'investor' ? '' : ` · ${show(detail.customer)}`}</p>
    <ol class="record-progress" aria-label="案件进度">${timeline}</ol>${notice ? `<p class="progress-explanation">${escape(notice)}</p>` : ''}
    ${role === 'sales' && detail.contractNumber && !signingContract ? `<p>合同号：${show(detail.contractNumber)}</p>` : ''}
    ${detail.registeredOn || detail.createdOn || detail.openedOn ? `<p>登记日期：${show(detail.registeredOn || detail.createdOn || detail.openedOn)}</p>` : ''}
    ${detail.signedOn ? `<p>签约日期：${show(detail.signedOn)}</p>` : ''}
    ${detail.filedOn ? `<p>立案日期：${show(detail.filedOn)}</p>` : ''}
    ${(detail.relatedCases || []).length ? `<h3>相关案件</h3>${detail.relatedCases.map(item => `<article class="record"><div class="record-main"><strong>${show(item.title)}</strong><p>${show(item.status)} · ${show(item.openedOn)}</p>${button('case', '查看案件进度', `data-id="${escape(item.id)}"`)}</div></article>`).join('')}` : ''}`;
}

export function renderUserRecords(data, state = {}, options = {}) {
  state = { ...initial, ...state };
  const { role = 'sales', today = '', loading = false, error = '', notice = '', detail = null } = options;
  const collapsible = options.collapsible !== false;
  const collapsed = collapsible && !state.listExpanded;
  const listLabel = role === 'investor' ? '记录' : '客户列表';
  const listToggle = collapsible ? button('toggle-list', `${collapsed ? '展开' : '收起'}${listLabel}`,
    `aria-expanded="${!collapsed}" aria-controls="records-results"`) : '';
  const homeList = role === 'investor' && state.presentation === 'home';
  const title = role === 'investor' ? (homeList ? '全部记录' : '我的股票登记') : '我的客户与股票';
  if (state.detail) {
    const back = state.parentDetail ? button('back', '返回关联记录')
      : homeList && state.directHomeDetail ? '<button type="button" class="secondary" data-action="records-return">返回首页</button>' : button('back', '返回记录列表');
    return `<section class="panel user-records-detail">${back}${error ? `<p role="alert">${escape(error)}</p>${button('retry', '重新加载')}` : renderRecordProgress(detail, role)}</section>`;
  }
  const controls = `${role !== 'investor' ? `<form data-records-form="search" class="inline-form business-search" role="search"><label class="field"><span>搜索客户或股票</span>
      <input type="search" name="q" value="${escape(state.draft)}" maxlength="100" placeholder="${role === 'broker' ? '客户姓名、股票名称或代码' : '客户姓名、电话、股票名称或代码'}" autocomplete="off"></label>
      <button class="primary">搜索</button>${button('reset-search', '重置')}</form>` : ''}
    <div class="filters business-period" aria-label="记录日期范围">${[['all', '全部'], ['month', '本月']].map(([period, label]) => button('period', label,
    `data-period="${period}" aria-pressed="${state.period === period}"`)).join('')}
    ${button('toggle-dates', state.datesOpen ? '收起日期' : '自选日期', `aria-expanded="${!!state.datesOpen}" aria-pressed="${state.period === 'custom'}" aria-controls="records-dates"`)}</div>
    <form id="records-dates" data-records-form="dates" class="inline-form" ${state.datesOpen ? '' : 'hidden'}><label class="field"><span>开始日期</span><input type="date" name="from" max="${escape(today)}" value="${escape(state.draftFrom)}" required></label>
    <label class="field"><span>结束日期</span><input type="date" name="to" max="${escape(today)}" value="${escape(state.draftTo)}" required></label><button class="secondary">按日期查看</button></form>
    ${role === 'broker' ? `<div class="filters" aria-label="客户签约状态">${[['all', '全部'], ['negotiating', '洽谈中'], ['signed', '已签约']].map(([ledger,label]) => button('ledger', label, `data-ledger="${ledger}" aria-pressed="${state.ledger === ledger}"`)).join('')}</div>` : ''}`;
  const items = data?.items || [];
  const list = items.map((item, index) => `<article class="record user-record"><div class="record-main">
    <div class="record-title"><h3>${role === 'investor' ? '' : `${show(item.customer)} · `}${show(item.stockName)} ${escape(item.stockCode)}</h3><span class="tag">${show(item.status)}</span></div>
    ${homeList && item.caseTitle && item.caseTitle !== item.stockName ? `<p>案件 ${escape(item.caseTitle)}</p>` : ''}
    <p>登记日期 ${show(item.registeredOn || '待核对')}</p>
    ${role === 'sales' && item.phone ? `<p>电话 ${escape(item.phone)}</p>` : ''}
    ${role === 'broker' ? `<p>客户签约状态：${show(item.signingStatus || '待确认')}</p>` : ''}
    ${(item.cases || []).map(record => `<p>案件：${show(record.title)} · ${show(record.status)}${record.openedOn ? ` · ${show(record.openedOn)}` : ''}</p>`).join('')}
    ${item.kind && item.progressId && role !== 'broker' ? button('detail', '查看记录与进度', `data-index="${index}"`) : ''}
    </div></article>`).join('');
  return `<section class="panel user-records-panel" data-records-role="${role}">${collapsible ? `<div class="list-heading"><h2>${title}</h2>${listToggle}</div>` : `<h2>${title}</h2>`}
    ${state.customerId ? `<p class="records-customer-scope">客户：${show(state.customerName || '当前客户')} ${button('all-customers', '查看全部客户')}</p>` : ''}
    ${state.scopeNote ? `<p class="records-scope-note">${escape(state.scopeNote)}</p>` : ''}
    ${controls}${error ? `<p class="records-error" role="alert">${escape(error)}</p>${button('retry', '重新加载')}` : ''}${notice ? `<p role="status">${escape(notice)}</p>` : ''}
    ${data ? `<p class="muted" data-records-count>${state.q ? `当前范围 ${escape(data.unfilteredTotal)} 条 · 搜索结果` : '共'} ${escape(data.total)} 条记录</p>` : ''}
    ${data && state.period !== 'all' ? `<p class="muted">${show(data.from)} 至 ${show(data.to)}</p>` : ''}
    <div id="records-results" ${collapsed ? 'hidden' : ''}><div class="records">${loading ? '<p role="status">正在加载记录…</p>' : list || (!error ? '<div class="empty">没有符合条件的记录</div>' : '')}</div></div>
    ${data ? `<nav class="list-pagination" aria-label="我的记录分页">${button('page', '上一页', `data-offset="${Math.max(0, data.offset - data.limit)}"${!data.offset ? ' disabled' : ''}`)}
      <span>第 ${Math.floor(data.offset / data.limit) + 1} / ${Math.max(1, Math.ceil(data.total / data.limit))} 页 · 每页 ${data.limit} 条</span>
      ${button('page', '下一页', `data-offset="${data.offset + data.limit}"${data.offset + data.limit >= data.total ? ' disabled' : ''}`)}</nav>` : ''}
      ${collapsible && !collapsed && items.length ? `<div class="list-heading">${listToggle}</div>` : ''}</section>`;
}

export function mountUserRecordsPanel(root, { request, role, today = '', initialState = {}, collapsible = true, onState = () => {}, onResult = () => {}, onError = () => {}, isCurrent = () => true } = {}) {
  const state = { ...initial, ...initialState };
  let data = null, detail = null, loading = false, error = '', notice = '', disposed = false, sequence = 0, controller;
  const current = () => !disposed && root.isConnected && isCurrent();
  const emit = () => onState({ ...state, detail: state.detail ? { ...state.detail } : null });
  const paint = () => {
    if (!current()) return;
    root.setAttribute('aria-busy', String(loading));
    root.innerHTML = renderUserRecords(data, state, { role, today, loading, error, notice, detail, collapsible });
    emit();
    if (!state.detail) onResult({ data, loading, error });
  };
  async function load() {
    controller?.abort(); controller = new AbortController();
    const serial = ++sequence; loading = true; error = ''; data = null; detail = null; paint();
    const record = state.detail && { ...state.detail };
    const path = record ? '/progress?' + new URLSearchParams(record) : '/records?' + recordsQuery(state, role);
    try {
      const result = await request(path, undefined, controller.signal);
      if (!current() || serial !== sequence) return;
      if (record) {
        if (!result || result.kind !== record.kind || result.id !== record.id || !Array.isArray(result.relatedCases)) throw new Error('记录详情未完整返回，请重试');
        detail = result;
      } else {
        if (!result || !Array.isArray(result.items) || !Number.isInteger(result.total) || result.total < 0 || !Number.isInteger(result.offset) || result.offset < 0
            || !Number.isInteger(result.limit) || result.limit < 1 || result.period !== state.period || result.q !== state.q
            || role === 'broker' && result.ledger !== state.ledger || role === 'investor' && state.presentation === 'home' && result.presentation !== 'home') throw new Error('记录未完整返回，请重试');
        data = result; state.offset = result.offset;
      }
    } catch (failure) {
      if (!current() || serial !== sequence || failure.name === 'AbortError') return;
      error = failure.message || '记录暂时无法加载，请重试';
      if (failure.status === 401) onError(failure);
    } finally { if (current() && serial === sequence) { loading = false; paint(); } }
  }
  const resetPage = () => { state.offset = 0; state.detail = null; state.listExpanded = true; notice = ''; };
  const api = {
    state: () => ({ ...state }),
    toggleList() {
      if (!collapsible) return;
      state.listExpanded = !state.listExpanded; paint();
      if (!state.listExpanded && root.getBoundingClientRect?.().top < 0) root.scrollIntoView?.({ block: 'start' });
    },
    setPeriod(value) { if (!['all','month'].includes(value)) return; state.period = value; state.scopeNote = ''; resetPage(); return load(); },
    applyDates(from, to) {
      state.draftFrom = from; state.draftTo = to;
      if (!validDate(from) || !validDate(to) || from > to || today && to > today) { error = '请选择有效的起止日期，结束日期不能晚于今天'; paint(); return; }
      Object.assign(state, { period: 'custom', from, to, scopeNote: '' }); resetPage(); return load();
    },
    search(value) { state.q = String(value || '').trim(); state.draft = state.q; resetPage(); return load(); },
    setLedger(value) { if (role !== 'broker' || !['all','negotiating','signed'].includes(value)) return; state.ledger = value; resetPage(); return load(); },
    setPage(value) { if (!Number.isSafeInteger(value) || value < 0) return; state.offset = value; state.listExpanded = true; return load(); },
    open(index) {
      const item = data?.items[index];
      if (role === 'broker' || !item?.kind || !item.progressId) return;
      state.detail = { kind: item.kind, id: item.progressId }; return load();
    },
    openCase(id) {
      if (!detail?.relatedCases.some(row => row.id === id)) return;
      state.parentDetail = state.detail; state.detail = { kind: 'case', id }; return load();
    },
    back() { state.detail = state.parentDetail || null; state.parentDetail = null; return load(); },
    allCustomers() { state.customerId = ''; state.customerName = ''; state.scopeNote = ''; resetPage(); return load(); },
    retry: load,
    dispose() { disposed = true; sequence++; controller?.abort(); root.removeEventListener('click', click); root.removeEventListener('submit', submit); root.removeEventListener('input', input); },
  };
  function click(event) {
    const target = event.target.closest('[data-records-action]'); if (!target || !root.contains(target) || target.disabled) return;
    const action = target.dataset.recordsAction;
    if (action === 'toggle-list') { api.toggleList(); return; }
    if (action === 'toggle-dates') {
      state.datesOpen = !state.datesOpen;
      root.querySelector('[data-records-form="dates"]').hidden = !state.datesOpen;
      target.setAttribute('aria-expanded', String(state.datesOpen));
      target.textContent = state.datesOpen ? '收起日期' : '自选日期';
      emit();
      return;
    }
    if (action === 'period') void api.setPeriod(target.dataset.period);
    if (action === 'ledger') void api.setLedger(target.dataset.ledger);
    if (action === 'page') void api.setPage(Number(target.dataset.offset));
    if (action === 'detail') void api.open(Number(target.dataset.index));
    if (action === 'case') void api.openCase(target.dataset.id);
    if (action === 'back') void api.back();
    if (action === 'all-customers') void api.allCustomers();
    if (action === 'reset-search') void api.search('');
    if (action === 'retry') void api.retry();
  }
  function input(event) {
    const form = event.target.closest('[data-records-form]'); if (!form) return;
    if (form.dataset.recordsForm === 'search') state.draft = event.target.value;
    if (form.dataset.recordsForm === 'dates') state[event.target.name === 'from' ? 'draftFrom' : 'draftTo'] = event.target.value;
    emit();
  }
  function submit(event) {
    const form = event.target.closest('[data-records-form]'); if (!form || !root.contains(form)) return;
    event.preventDefault(); const values = Object.fromEntries(new FormData(form));
    if (form.dataset.recordsForm === 'search') void api.search(values.q);
    if (form.dataset.recordsForm === 'dates') void api.applyDates(values.from, values.to);
  }
  root.addEventListener('click', click); root.addEventListener('submit', submit); root.addEventListener('input', input);
  api.ready = load(); return api;
}
