import { reportDefinition, reportTypes, reportRows, salesLabel } from './report.js';
import { operationsPage } from './operations.js';
import { renderClientPicker, renderClientRecords, installClientSearch } from './client-search.js';
import { renderBrokerAccounts, mountBrokerAccounts } from './broker-accounts.js';

const app = document.querySelector('#app');
const accountBar = document.querySelector('#account-bar');
const feedback = document.querySelector('#feedback');
const adminPage = /^\/admin\/?$/.test(location.pathname);
const portalLink = document.querySelector('#portal-link');

function businessApi() {
  const storageKey = 'huzi:business-tab';
  let id = sessionStorage.getItem(storageKey);
  if (!/^[a-f0-9]{32}$/.test(id || '')) {
    id = crypto.randomUUID().replaceAll('-', '');
    sessionStorage.setItem(storageKey, id);
  }
  return `/api/business/${id}`;
}

const apiRoot = adminPage ? '/api/admin' : businessApi();
if (adminPage) {
  portalLink.href = '/';
  portalLink.textContent = '业务端';
  document.title = '运营后台 · 沪紫律师事务所';
}
const adminTabs = [[6, '数据总览'], [7, '销售看板'], [8, '渠道管理'], [2, '客户案件'], [9, '律所登记台账'], [3, '数据报表'], [5, '公司与派单'], [1, '客户签约'], [0, '账号管理'], [4, '审计与联调']];
const timeZone = 'Asia/Shanghai';
const dayOf = date => new Intl.DateTimeFormat('sv-SE', { timeZone }).format(new Date(date));
const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const state = { ready: false, registering: false, authBusy: false, editingName: false, revision: 0,
  view: null, page: 'home', metric: 0, lead: '', ledger: '洽谈中', adminTab: 6, filters: {},
  recovering: false, security: false, recovery: null, accountFilters: {}, accountAction: null,
  assignmentFilters: {}, caseFilters: {}, salesFilters: {}, channelFilters: {}, editCompany: '', editAssignment: '', editChannel: '', followFilter: '待跟进', clientRecords: {}, brokerFilters: {}, overviewDetail: null,
  salesBoard: salesBoardState() };

function salesBoardState(owner = '') {
  return { owner, period: 'all', from: '', to: '', rangeFrom: '', rangeTo: '', metric: 'channels', offset: 0, data: null, error: '', dateError: '', loading: false, sequence: 0 };
}
let salesBoardAbort;
function cancelSalesBoard() {
  salesBoardAbort?.abort();
  state.salesBoard.sequence += 1;
  state.salesBoard.loading = false;
  state.salesBoard.data = null;
}

async function loadSalesBoard(offset = state.salesBoard.offset) {
  const board = state.salesBoard;
  if (state.page !== 'mine' || state.view?.actor.role !== 'sales') return;
  salesBoardAbort?.abort();
  salesBoardAbort = new AbortController();
  const sequence = ++board.sequence;
  const revision = state.revision;
  const current = () => revision === state.revision && board === state.salesBoard && sequence === board.sequence
    && state.page === 'mine' && state.view?.actor.role === 'sales' && state.view.actor.id === board.owner;
  board.loading = true; board.error = ''; board.data = null;
  render();
  const params = { period: board.period, metric: board.metric, offset };
  if (board.period === 'custom') Object.assign(params, { from: board.rangeFrom, to: board.rangeTo });
  try {
    const result = await request('/sales/board?' + new URLSearchParams(params), undefined, salesBoardAbort.signal);
    if (!current()) return;
    if (!result || !Array.isArray(result.metrics) || !Array.isArray(result.items)
        || !result.metrics.some(item => item.key === result.selected)
        || !Number.isInteger(result.total) || result.total < 0 || !Number.isInteger(result.offset)
        || result.offset < 0 || !Number.isInteger(result.limit) || result.limit < 1) {
      throw new Error('统计数据暂未完整返回，请重试');
    }
    board.data = result; board.offset = result.offset; board.metric = result.selected;
  } catch (error) {
    if (!current() || error.name === 'AbortError') return;
    board.error = error.message || '暂时无法加载统计';
    if (error.status === 401) { handleError(error); return; }
  } finally {
    if (current()) { board.loading = false; render(); }
  }
}

function message(text, error = false) {
  feedback.textContent = text;
  feedback.hidden = !text;
  feedback.classList.toggle('error', error);
}

async function request(path, input, signal) {
  const init = input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    keepalive: path === '/referral/capture' } : {};
  const response = await fetch(`${apiRoot}${path}`, { ...init, signal });
  if (!response.ok) {
    const { message } = await response.json();
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

const clientSearch = installClientSearch({
  search: (params, signal) => request(`/clients/search?${new URLSearchParams(params)}`, undefined, signal),
  onError: error => handleError(error),
  onRecordsState: filters => { state.clientRecords = filters; },
});

async function showRegistry(container, admin) {
  if (!container || container.dataset.loaded) return;
  container.dataset.loaded = 'true';
  try {
    const { renderRegistryPanel, mountRegistryPanel } = await import('./registry-panel.js');
    if (!container.isConnected) return;
    container.innerHTML = renderRegistryPanel({ admin });
    mountRegistryPanel(container, { request, onError: handleError, admin, initialPasswordHint: initialPasswordHint() });
  } catch (error) {
    if (container.isConnected) {
      delete container.dataset.loaded;
      container.textContent = '登记台账暂未加载，请刷新页面重试。';
    }
  }
}

function initialPasswordHint() {
  const password = state.view?.initialBusinessPassword;
  return password ? `默认初始密码为 ${password}，首次登录须设置个人密码。` : '首次登录须设置个人密码。';
}

async function refresh(revision = state.revision) {
  const snapshot = await request('/view');
  if (revision !== state.revision) return;
  state.view = snapshot;
  state.ready = true;
  render();
}

function resetView() {
  cancelSalesBoard();
  state.salesBoard = salesBoardState();
  state.revision += 1;
  state.ready = true;
  state.registering = false;
  state.editingName = false;
  state.page = 'home';
  state.metric = 0;
  state.lead = '';
  state.ledger = '洽谈中';
  state.adminTab = 6;
  state.filters = {};
  state.view = null;
  state.recovering = false;
  state.security = false;
  state.recovery = null;
  state.accountAction = null;
  state.accountFilters = {};
  for (const key of ['assignmentFilters', 'caseFilters', 'salesFilters', 'channelFilters']) state[key] = {};
  for (const key of ['editCompany', 'editAssignment', 'editChannel']) state[key] = '';
  state.followFilter = '待跟进';
  state.clientRecords = {};
  state.brokerFilters = {};
  state.overviewDetail = null;
  render();
}

const pendingKey = 'huzi:pending-promos';
const promotions = () => (sessionStorage.getItem(pendingKey) || '').split(',').filter(Boolean);

async function applyPromotions() {
  const capture = async () => {
    for (const code of promotions()) {
      try {
        const result = await request('/referral/capture', { code });
        if (result.pending) message('已保留首次有效推广来源，登录或注册后关联');
        else message(result.recorded ? '已记录首次推广来源' : '已有渠道归属，本次扫码未改变归属');
      } catch (error) {
        if (![400, 403, 404].includes(error.status)) throw error;
        message(error.message, true);
      }
      sessionStorage.setItem(pendingKey, promotions().filter(item => item !== code).join(','));
    }
  };
  if (!promotions().length) return;
  if (navigator.locks) await navigator.locks.request('huzi-referral-capture', capture);
  else await capture();
}

function handleError(error, signingIn = false) {
  if (error.status === 401 && !signingIn) resetView();
  message(error.message, true);
}

const button = (label, action, value = '', extra = '') => `<button type="button" data-action="${safe(action)}" data-value="${safe(value)}" ${extra}>${safe(label)}</button>`;
const field = (label, input) => `<label class="field"><span>${label}</span>${input}</label>`;
const select = (name, options, value = '', blank = '') => `<select name="${name}">${blank ? `<option value="">${safe(blank)}</option>` : ''}${options.map(([key, title]) =>
  `<option value="${safe(key)}" ${key === value ? 'selected' : ''}>${safe(title)}</option>`).join('')}</select>`;
const empty = (text = '暂无符合条件的记录') => `<p class="empty">${safe(text)}</p>`;
const tag = text => `<span class="tag">${safe(text)}</span>`;
const day = () => state.view.today;
const dateField = (label, name, value = day()) => field(label, `<input type="date" name="${name}" value="${safe(value)}" required>`);
const hero = (name, title, copy) => `<section class="hero"><div class="hero-label">${name}</div><h1>${title}</h1><p>${copy}</p></section>`;
const panel = (title, content) => `<section class="panel"><h2>${title}</h2>${content}</section>`;
const initial = (text = '') => text.slice(0, 1);

function authPanel() {
  if (state.recovering) return `<div class="mobile-content">${hero('沪紫律师事务所', '找回密码', '使用已保存的恢复码设置新密码')}
    ${panel('忘记密码', `<p>输入登录账号及个人恢复码，或管理员核实身份后提供的临时恢复码。没有恢复码，请联系律所管理员协助。</p>
    <form data-form="recover" class="form-grid">
    ${field('登录账号', '<input name="username" maxlength="40" autocomplete="username" required>')}
    ${field('恢复码', '<input name="code" maxlength="80" autocomplete="off" required>')}
    ${newPasswordFields()}<button class="primary">设置新密码</button></form>
    ${button('返回登录', 'toggle-recovery', '', 'class="quiet"')}`)}</div>`;
  const registering = state.registering;
  const title = adminPage ? '管理员登录' : registering ? '注册股民账号' : '账号密码登录';
  return `<div class="mobile-content">${hero('沪紫律师事务所', adminPage ? '运营后台' : '股民索赔宝', title)}
    ${panel(title, `<form data-form="auth" class="form-grid">
    ${registering ? field('手机号', '<input name="phone" type="tel" inputmode="numeric" pattern="1[0-9]{10}" maxlength="11" autocomplete="username" required>') :
      field('登录账号', '<input name="username" maxlength="40" autocomplete="username" required>')}
    ${field('密码', `<input name="password" type="password" ${registering ? 'minlength="8"' : ''} maxlength="128" autocomplete="${registering ? 'new-password' : 'current-password'}" required>`)}
    ${registering ? field('确认密码', '<input name="confirm" type="password" maxlength="128" autocomplete="new-password" required>') : ''}
    <button class="primary">${registering ? '注册并登录' : '登录'}</button></form>
    ${adminPage ? '' : button(registering ? '返回登录' : '注册股民账号', 'toggle-auth', '', 'class="quiet"')}
    ${!registering ? button('忘记密码', 'toggle-recovery', '', 'class="quiet"') : ''}`)}</div>`;
}

function newPasswordFields(label = '新密码') {
  return field(label, '<input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" placeholder="8 到 128 位" required>') +
    field('确认新密码', '<input name="confirm" type="password" minlength="8" maxlength="128" autocomplete="new-password" required>');
}

function recoveryResult(scope = 'self') {
  if (!state.recovery || state.recovery.scope !== scope) return '';
  return `<div class="recovery-result"><p>${state.recovery.expiresAt ? '临时恢复码有效期 30 分钟，请在核实身份后交给账号本人。' : '请立即保存到安全位置。该恢复码仅本次显示，可用一次。重新生成或修改密码后，旧码失效。'}</p>
    <code>${safe(state.recovery.code)}</code><p>账号 ${safe(state.recovery.username)}</p></div>`;
}

function securityPanel(required = false) {
  return panel(required ? '设置个人密码' : '账号安全', `<p>${required ? '请输入管理员提供的临时密码，再设置自己的登录密码。' : '修改密码后，所有设备需要重新登录，已保存的恢复码会失效。'}</p>
    <form data-form="change-password" class="form-grid">
    ${field(required ? '临时密码' : '当前密码', '<input name="currentPassword" type="password" maxlength="128" autocomplete="current-password" required>')}
    ${newPasswordFields()}<button class="primary">保存新密码</button></form>
    ${required ? '' : `<hr><h3>忘记密码时的备用恢复码</h3><p>预先生成并妥善保存，忘记密码时可以自行找回。重新生成会使旧码失效。</p>
    <form data-form="recovery-code" class="inline-form">${field('当前密码', '<input name="currentPassword" type="password" maxlength="128" autocomplete="current-password" required>')}
    <button class="secondary">生成新的恢复码</button></form>${recoveryResult()}`}
    ${button(required ? '返回登录' : '关闭账号安全', required ? 'sign-out' : 'security', '', 'class="quiet"')}`);
}

function accountSummary(actor) {
  return `<section class="panel account-summary" aria-label="我的账号">
    <div class="list-heading"><h2>${safe(actor.name)}</h2>${button('退出登录', 'sign-out', '', 'class="quiet"')}</div>
    <p>账号 ${safe(actor.account)}</p>
    ${button('账号安全', 'security', '', 'class="secondary"')}
    ${actor.role === 'investor' ? button(state.editingName ? '取消修改' : '修改显示名称', 'edit-name', '', 'class="secondary"') : ''}
    ${state.editingName ? `<form data-form="name" class="inline-form">${field('显示名称', `<input name="name" value="${safe(actor.name)}" maxlength="40" required>`)}<button class="primary">保存名称</button></form>` : ''}
  </section>${state.security ? securityPanel() : ''}`;
}

const roleNames = { investor: '股民', sales: '销售', broker: '券商', admin: '管理员' };
const accountActionNames = { password: '重置密码', closed: '注销账号', active: '恢复账号', recovery: '签发临时恢复码' };

function accountManagement() {
  const f = state.accountFilters;
  const accounts = state.view.accounts.filter(item => (!f.role || item.role === f.role) && (!f.status || item.status === f.status) &&
    (!f.search || `${item.name} ${item.username}`.toLowerCase().includes(f.search.trim().toLowerCase())));
  const edit = state.accountAction;
  const target = edit && state.view.accounts.find(item => item.id === edit.id);
  const editor = target ? panel(`${accountActionNames[edit.kind]} · ${safe(target.name)}`, `<p>登录账号 ${safe(target.username)} · ${roleNames[target.role]}</p>
    <p>${edit.kind === 'closed' ? '注销后不能登录，所有旧登录立即失效。留资、签约、案件和渠道归属继续保留，可由后台恢复。' :
      edit.kind === 'active' ? '恢复后可使用该账号登录。如用户忘记密码，请另行重置或签发临时恢复码。' :
      edit.kind === 'password' ? '设置临时密码后，所有旧登录和恢复码失效。用户下次登录须设置自己的新密码。' :
      '请先核实账号本人的身份。临时恢复码可使用一次，有效期 30 分钟，生成后会使该账号之前的恢复码失效。'}</p>
    <form data-form="manage-account" class="form-grid"><input type="hidden" name="identityId" value="${target.id}">
    <input type="hidden" name="kind" value="${edit.kind}">
    ${field('当前管理员密码', '<input name="currentPassword" type="password" maxlength="128" autocomplete="current-password" required>')}
    ${edit.kind === 'password' ? newPasswordFields('用户的临时密码') : ''}
    <label class="check"><input type="checkbox" required>我已核对目标账号${['password', 'recovery'].includes(edit.kind) ? '并核实申请人身份' : '并确认本次操作'}</label>
    <button class="primary">确认${accountActionNames[edit.kind]}</button></form>
    ${button('取消', 'cancel-account', '', 'class="quiet"')}`) : '';
  return panel('全部账号', `<form data-form="account-query" class="form-grid query-grid">
    ${field('姓名或登录账号', `<input name="search" value="${safe(f.search)}" maxlength="100">`)}
    ${field('角色', select('role', Object.entries(roleNames), f.role, '全部角色'))}
    ${field('状态', select('status', [['active', '正常'], ['closed', '已注销']], f.status, '全部状态'))}
    <button class="secondary">筛选账号</button></form>
    <p>共 ${accounts.length} 个账号</p><div class="table-wrap"><table><thead><tr><th>姓名</th><th>登录账号</th><th>角色</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${accounts.map(item => `<tr><td>${safe(item.name)}</td><td>${safe(item.username)}</td><td>${roleNames[item.role]}</td>
      <td>${item.status === 'closed' ? '已注销' : item.passwordChangeRequired ? '待修改密码' : '正常'}</td><td><div class="filters">
      ${item.status === 'active' ? button('重置密码', 'account-password', item.id, 'class="secondary"') + button('临时恢复码', 'account-recovery', item.id, 'class="secondary"') +
        button('注销账号', 'account-closed', item.id, `class="quiet" ${item.username === state.view.actor.account ? 'disabled' : ''}`) :
        button('恢复账号', 'account-active', item.id, 'class="secondary"')}</div></td></tr>`).join('') || '<tr><td colspan="5">没有符合条件的账号</td></tr>'}</tbody></table></div>
    ${!target ? recoveryResult('managed') : ''}`) + editor;
}

function recordCard(record) {
  const details = [record.subtitle, record.registeredOn !== undefined && `登记日期 ${record.registeredOn || '待核对'}`,
    record.openedOn && `${record.openedOnLabel || '登记日期'} ${record.openedOn}`, record.signedOn && `签约日期 ${record.signedOn}`].filter(Boolean);
  return `<article class="record"><span class="avatar" aria-hidden="true">${safe(initial(record.title))}</span><div class="record-main">
    <div class="record-title"><h3>${safe(record.title)}</h3>${tag(record.status)}</div>
    <p>${details.map(safe).join(' · ')}</p>${record.phone ? `<p>手机 ${safe(record.phone)}</p>` : ''}</div></article>`;
}

function renderBoard(metrics) {
  const selected = metrics[state.metric] || metrics[0];
  return `<section class="dashboard"><h2>${state.view.actor.role === 'sales' ? '券商合作统计' : '数据看板'}</h2>${state.view.actor.role === 'sales' ? '<p class="muted">按券商合作负责人统计。实际经办留资请到首页查看。</p>' : ''}<div class="metrics">${metrics.map(item =>
    `<div class="metric"><span>${safe(item.label)}</span><strong>${item.value}<small>${safe(item.unit)}</small></strong></div>`).join('')}</div>
    <div class="filters" aria-label="按指标筛选">${metrics.map((item, index) => button(item.label, 'metric', index,
      `class="chip ${item === selected ? 'selected' : ''}" aria-pressed="${item === selected}"`)).join('')}</div>
    <div class="list-heading"><h2>${safe(selected.label)}</h2><span>${selected.value} ${safe(selected.unit)}</span></div>
    <div class="records">${selected.records.map(record => recordCard(record)).join('') || empty()}</div></section>`;
}

function renderSalesBoard() {
  const board = state.salesBoard;
  const data = board.data;
  const selected = data?.metrics.find(item => item.key === data.selected);
  const controls = `<div class="filters">${[['all', '全部'], ['month', '本月']].map(([period, label]) =>
    button(label, 'sales-board-period', period, `class="chip ${board.period === period ? 'selected' : ''}" aria-pressed="${board.period === period}"`)).join('')}</div>
    <form data-form="sales-board-dates" class="inline-form">
      ${field('开始日期', `<input type="date" name="from" max="${safe(state.view.today)}" value="${safe(board.from)}" required>`)}
      ${field('结束日期', `<input type="date" name="to" max="${safe(state.view.today)}" value="${safe(board.to)}" required>`)}
      <button class="${board.period === 'custom' ? 'primary' : 'secondary'}">按日期查看</button></form>
    ${board.dateError ? `<p role="alert" class="sales-board-error">${safe(board.dateError)}</p>` : ''}`;
  let content = empty('正在加载统计与明细…');
  if (board.error) content = `<p role="alert" class="sales-board-error">${safe(board.error)}</p>${button('重新加载', 'sales-board-retry', '', 'class="secondary"')}`;
  else if (data) {
    const range = data.period === 'all' ? '累计全部数据（含历史同步）' : `${data.from} 至 ${data.to}`;
    const page = Math.floor(data.offset / data.limit) + 1;
    const pages = Math.max(1, Math.ceil(data.total / data.limit));
    content = `<p class="muted">${safe(range)}</p><div class="metrics">${data.metrics.map(item =>
      `<button type="button" class="metric ${item.key === data.selected ? 'selected' : ''}" data-action="sales-board-metric" data-value="${safe(item.key)}" aria-pressed="${item.key === data.selected}">
        <span>${safe(item.label)}</span><strong>${safe(item.value)}<small>${safe(item.unit)}</small></strong></button>`).join('')}</div>
      ${(data.notes || []).map(note => `<p class="muted">${safe(note)}</p>`).join('')}
      <div class="list-heading"><h2>${safe(selected.label)}</h2><span>${safe(data.total)} ${safe(selected.unit)}</span></div>
      ${selected.dateLabel ? `<p class="muted">按${safe(selected.dateLabel)}筛选</p>` : ''}
      ${data.period !== 'all' && selected.unknownDateCount ? `<p class="muted">另有 ${safe(selected.unknownDateCount)} ${safe(selected.unit)}未明确日期，可在全部数据中查看。</p>` : ''}
      <div class="records">${data.items.map(item => recordCard({ ...item, openedOnLabel: '案件登记日期' })).join('') || empty()}</div>
      <nav class="list-pagination" aria-label="销售统计明细分页">
        ${button('上一页', 'sales-board-page', Math.max(0, data.offset - data.limit), `class="secondary" ${data.offset === 0 ? 'disabled' : ''}`)}
        <span>${page} / ${pages} 页 · 每页 ${data.limit} 条</span>
        ${button('下一页', 'sales-board-page', data.offset + data.limit, `class="secondary" ${data.offset + data.limit >= data.total ? 'disabled' : ''}`)}
      </nav>`;
  }
  return `<section class="dashboard sales-board" aria-busy="${board.loading}"><h2>我的数据</h2>${controls}<div class="sales-board-content">${content}</div></section>`;
}

function investor() {
  const { contact, leads } = state.view;
  if (state.page === 'home') return `${hero('沪紫律师事务所', '了解股票索赔', '提交股票和联系方式，由律所人员与您联系并评估索赔条件。')}
    ${panel('提交咨询资料', `<form data-form="lead" class="form-grid">
      ${field('姓名', '<input name="name" maxlength="40" autocomplete="name" required>')}
      ${field('手机号码', '<input name="phone" type="tel" maxlength="11" inputmode="numeric" autocomplete="tel" pattern="1[0-9]{10}" title="请输入以 1 开头的 11 位手机号" placeholder="以 1 开头的 11 位数字" required>')}
      ${field('股票名称', '<input name="stockName" maxlength="50" required>')}
      ${field('股票代码', '<input name="stockCode" maxlength="20" placeholder="如 600000 或 NVDA" required>')}
      ${field('大致买入时段', select('period', [['2020 年之前', '2020 年之前'], ['2020–2022 年', '2020–2022 年'], ['2022–2024 年', '2022–2024 年'], ['2024 年至今', '2024 年至今']], '', '请选择'))}
      <label class="check"><input type="checkbox" name="consent" required>我同意将资料用于联系与咨询。</label>
      <button class="primary">提交留资</button></form>`)}`;
  const active = leads.find(lead => lead.id === state.lead);
  if (active) return `${panel('留资与案件状态', `${button('返回留资记录', 'lead', '', 'class="quiet"')}
    <div class="list-heading"><h2>${safe(active.stockName)} <small>${safe(active.stockCode)}</small></h2><span>${safe(active.createdOn)}</span></div>
    ${active.cases.length ? active.cases.map(record => recordCard({ ...record, subtitle: `登记日期 ${record.openedOn}`, openedOn: '' })).join('')
      : `<div class="record"><div class="record-main"><div class="record-title"><h3>当前状态</h3>${tag('留资')}</div><p>已收到资料，尚未建立案件。</p></div></div>`}`)}`;
  return `${hero('股民端', '我的留资记录', '查看已提交的咨询及对应案件当前状态。')}
    ${contact ? `<dl class="panel profile-contact" aria-label="本人留资联系信息">
      <div><dt>留资姓名</dt><dd>${safe(contact.name)}</dd></div><div><dt>留资手机号</dt><dd>${safe(contact.phone)}</dd></div>
    </dl>` : ''}
    ${panel('留资记录', `<div class="records">${leads.map(lead => `<button type="button" class="record lead-card" data-action="lead" data-value="${safe(lead.id)}">
      <span class="avatar" aria-hidden="true">股</span><span class="record-main"><strong>${safe(lead.stockName)} · ${safe(lead.stockCode)}</strong>
      <span class="lead-meta">${safe(lead.createdOn)} · ${lead.cases.length ? `${lead.cases.length} 件案件` : '留资'}</span></span><span aria-hidden="true">→</span></button>`).join('') || empty('暂无留资记录')}
    </div>`)}${panel('转介绍', '<p>将咨询入口分享给有需要的股民。</p>' + button('复制咨询入口', 'share', '', 'class="secondary"'))}`;
}

function sales() {
  if (state.page === 'mine') return `${hero('销售端', '销售数据统计', '包含名下客户、股票记录及已关联的历史登记。')}${renderSalesBoard()}`;
  if (state.page === 'registry') return button('返回销售工作台', 'page', 'home', 'class="secondary"')
    + '<div data-registry-host>正在打开登记台账…</div>';
  const records = state.view.assignedLeads.filter(lead => !state.followFilter || lead.status === state.followFilter);
  const preview = (state.view.registryPreview || []).map(row => `<article class="record"><div class="record-main">
    <strong>${safe(row.customer)}</strong><p>${safe(row.stockName)} ${safe(row.stockCode)}</p></div></article>`).join('');
  return `${hero('销售端', '销售工作台', '跟进你的券商推荐的留资，以及分派给你的其他留资。')}
    ${panel('我的登记客户', `<p class="muted">${safe(state.view.registryCount || 0)} 条登记</p>
      <div class="records">${preview || empty('暂无已关联的登记记录')}</div>
      ${button('查看全部登记记录', 'page', 'registry', 'class="secondary"')}`)}
    ${panel('分派给我的留资', `<div class="filters">${[['待跟进', '待跟进'], ['已跟进', '已跟进'], ['', '全部']].map(([value, label]) =>
      button(label, 'follow-filter', value, `class="chip ${state.followFilter === value ? 'selected' : ''}"`)).join('')}</div><p>共 ${records.length} 条</p>
      <div class="records">${records.map(lead => `<article class="record"><div class="record-main"><div class="record-title"><h3>${safe(lead.name)}</h3>${tag(lead.status)}</div>
        <p>${safe(lead.number)} · ${safe(lead.createdOn)}</p><p>${safe(lead.stockName)} · ${safe(lead.stockCode)} · 核对公司 ${safe(lead.companyName)}</p>
        <p>手机 ${safe(lead.phone)} · 渠道 ${safe(lead.brokerName || '自然流入')}</p>
        ${lead.cases.length ? `<p>案件：${lead.cases.map(record => `${safe(record.title)}（${safe(record.status)}）`).join('、')}</p>` : ''}
        ${lead.followups.length ? `<details><summary>跟进记录（${lead.followups.length}）</summary>${lead.followups.map(note => `<p>${safe(note.salesName)} · ${safe(note.note)}</p>`).join('')}</details>` : ''}
        <form data-form="followup" class="inline-form"><input type="hidden" name="leadId" value="${safe(lead.id)}"><input type="hidden" name="version" value="${lead.version}">
        ${field('跟进内容', '<input name="note" maxlength="500" required>')}<button class="secondary">保存跟进</button></form></div></article>`).join('') || empty('暂无分配给你的留资')}
      </div>`)}
    ${panel('登记合作', `<form data-form="cooperation" class="form-grid">
      ${field('券商名称', '<input name="name" maxlength="100" required>')}
      ${dateField('签约日期', 'signedOn')}
      <button class="primary">保存签约绑定</button></form>`)}`;
}

function broker() {
  const { name, code } = state.view.broker;
  if (state.page === 'mine') {
    const records = state.view.ledger.filter(item => item.status === state.ledger);
    return `${hero('券商端', safe(name), '查看本券商的洽谈及已签约客户。')}
      ${panel('客户台账', `<div class="filters" aria-label="台账状态">${['洽谈中', '已签约'].map(label => button(label, 'ledger', label,
      `class="chip ${state.ledger === label ? 'selected' : ''}" aria-pressed="${state.ledger === label}"`)).join('')}</div>
      <div class="records">${records.map(record => recordCard(record)).join('') || empty()}</div>`)}`;
  }
  const link = `/?promo=${encodeURIComponent(code)}`;
  return `${hero('券商端', safe(name), '查看本券商的客户与案件统计。')}
    <section class="promo"><div><h2>专属推广码</h2><code>${safe(code)}</code></div><div>
    ${button('复制推广链接', 'share', link, 'class="secondary"')}</div></section>
    ${renderBoard(state.view.metrics)}`;
}

function adminContent() {
  const { clients, brokers, sales, leads, cases, caseStatuses, caseCutoff, audit, integrations } = state.view;
  const brokerNames = brokers.map(item => [item.id, item.name]);
  const statusOptions = caseStatuses.map(status => [status, status]);
  const header = '';
  const operations = () => operationsPage(state.view, state, { safe, button, field, select, panel, empty, tag });
  if (state.adminTab === 9) return '<div data-registry-host>正在打开登记台账…</div>';
  if ([5, 6, 7, 8].includes(state.adminTab)) return operations();
  if (state.adminTab === 0) return header + accountManagement() + `<div class="admin-grid">${panel('销售账号开通', `<form data-form="sales-account" class="form-grid">
    ${field('销售业务记录', select('salesId', sales.filter(item => !item.username).map(item => [item.id, item.name]), '', '新增销售'))}
    ${field('销售姓名', '<input name="name" maxlength="40" required>')}
    ${field('专用账号', '<input name="username" minlength="3" maxlength="40" autocomplete="off" required>')}
    <p class="muted">${safe(initialPasswordHint())}</p>
    <button class="primary">开通销售账号</button></form>`)}${panel('销售账号', sales.map(item => `<article class="admin-record">
    <div class="list-heading"><h3>${safe(item.name)}</h3>${tag(item.accountStatus === 'closed' ? '已注销' : item.username ? '已开户' : '待开户')}</div>
    ${item.username ? `<p>账号 ${safe(item.username)}</p>` : ''}</article>`).join('') || empty('暂无销售账号'))}</div>` + renderBrokerAccounts(state.brokerFilters);

  if (state.adminTab === 1) return header + `<div class="admin-grid">${panel('调整客户归属', `<form data-form="reassign" class="form-grid">
    ${renderClientPicker('reassign')}
    ${field('新券商', select('brokerId', brokers.filter(item => item.username && item.accountStatus === 'active').map(item => [item.id, item.name]), '', '选择已开户券商'))}
    <button class="primary">保存归属</button></form>`)}${panel('登记客户实际签约', `<form data-form="signing" class="form-grid">
    ${renderClientPicker('signing')}
    ${dateField('实际签约日期', 'signedOn')}
    ${field('签约凭据说明', '<input name="reference" maxlength="160" required>')}
    <button class="primary">保存签约结果</button></form>`)}</div>` + renderClientRecords(state.clientRecords);

  if (state.adminTab === 2) return operations() + `<details class="panel"><summary>录入案件与更新状态</summary>` + panel('录入新增案件', `<p>当前测试案件分界日为 ${safe(caseCutoff)}。</p><form data-form="case" class="form-grid">
    ${field('对应留资', select('leadId', leads.map(item => [item.id, `${item.name} · ${item.stockName} · ${dayOf(item.createdAt)}`]), '', '选择留资记录'))}
    ${field('案件名称', '<input name="title" maxlength="80" required>')}
    ${dateField('案件登记日期', 'openedOn')}${field('当前状态', select('status', statusOptions))}
    <button class="primary">录入案件</button></form>`) + panel('更新案件状态', cases.map(item => `<article class="admin-record">
    <div class="list-heading"><h3>${safe(item.title)} · ${safe(item.name)}</h3>${tag(item.status)}</div><p>登记日期 ${safe(item.openedOn)}</p>
    <form data-form="case" class="inline-form"><input type="hidden" name="id" value="${safe(item.id)}">
    ${field('当前状态', select('status', statusOptions, item.status))}<button class="secondary">更新状态</button></form></article>`).join('') || empty('暂无新增案件')) + '</details>';

  if (state.adminTab === 3) {
    const f = state.filters;
    const definition = reportDefinition(f.type);
    const reportColumns = definition.columns;
    const records = reportRows(state.view, f);
    const states = f.type === 'cases' ? caseStatuses : f.type === 'signings' ? ['洽谈中', '已签约'] : ['待分配', '待跟进', '已跟进'];
    return header + panel('数据报表', `<p>${safe(definition.description)}</p><form data-form="query" class="form-grid query-grid">
      ${field('记录类型', select('type', reportTypes, f.type || 'leads'))}
      ${f.type === 'sales' ? '' : field('来源渠道', select('brokerId', [['__natural__', '自然流入'], ...brokerNames], f.brokerId, '全部渠道'))}
      ${field(['signings', 'channels'].includes(f.type) ? '渠道合作负责人' : '销售', select('salesId', [...(f.type === 'sales' ? [] : [['__unassigned__', '待分配 / 无负责人']]), ...sales.map(item => [item.id, salesLabel(item)])], f.salesId, '全部销售'))}
      ${field('搜索', `<input name="search" value="${safe(f.search)}" maxlength="100" placeholder="名称、股票或编号">`)}
      ${definition.summary ? '' : field('状态', select('state', states.map(value => [value, value]), f.state, '全部状态'))}
      ${definition.summary ? '' : field('起始日期', `<input type="date" name="from" value="${safe(f.from)}">`) + field('结束日期', `<input type="date" name="to" value="${safe(f.to)}">`)}
      <div class="inline-form"><button class="primary">查询</button><button class="secondary" name="download" value="yes">导出 Excel</button></div></form>
      <p>共 ${records.length} 条，导出与当前表单筛选一致。</p>${records.length ? `<div class="table-wrap"><table><thead><tr>${reportColumns.map(column => `<th>${column.label}</th>`).join('')}</tr></thead>
      <tbody>${records.map(row => `<tr>${reportColumns.map(column => `<td>${safe(row[column.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty()}`);
  }

  return header + panel('联调状态', `<dl><dt>WPS</dt><dd>${safe(integrations.wps)}</dd><dt>微信</dt><dd>${safe(integrations.wechat)}</dd></dl>`) +
    panel('最近操作', audit.map(item => `<article class="admin-record"><h3>${safe(item.action)}</h3>
      <p>${safe(item.actor)} · ${safe(item.subject)} · ${safe(item.createdAt)}</p>${item.details !== '{}' ? `<p>${safe(item.details)}</p>` : ''}</article>`).join('') || empty('暂无操作记录'));
}

function admin() {
  return `<div class="admin-heading"><h1>运营后台</h1><p>客户、渠道与案件运营</p></div><div class="admin-layout">
    <nav class="admin-nav" aria-label="后台功能">${adminTabs.map(([index, title]) => button(title, 'admin-tab', index,
      `class="chip ${index === state.adminTab ? 'selected' : ''}" aria-pressed="${index === state.adminTab}"`)).join('')}</nav>
    <div class="admin-content">${state.security ? securityPanel() : ''}${adminContent()}</div></div>`;
}

function render() {
  const actor = state.view?.actor;
  const role = actor?.role;
  if (role === 'sales' && state.salesBoard.owner !== actor.id) {
    cancelSalesBoard();
    state.salesBoard = salesBoardState(actor.id);
  }
  accountBar.hidden = role !== 'admin';
  accountBar.innerHTML = role === 'admin' ? `<strong>${safe(actor.name)} · ${safe(actor.account)}</strong><div>${button('账号安全', 'security', '', 'class="quiet"')}${button('退出登录', 'sign-out', '', 'class="quiet"')}</div>` : '';
  app.classList.toggle('admin', role === 'admin');
  app.setAttribute('aria-busy', String(!state.ready));
  if (!role) { app.innerHTML = state.ready ? authPanel() : empty('正在检查登录状态…'); return; }
  if (actor.passwordChangeRequired) { app.innerHTML = securityPanel(true); return; }
  if (role === 'admin') {
    app.innerHTML = admin();
    clientSearch.mount(app);
    if (state.adminTab === 9) void showRegistry(app.querySelector('[data-registry-host]'), true);
    mountBrokerAccounts(app, { request, onError: handleError, initialPasswordHint: initialPasswordHint(),
      onState: filters => { state.brokerFilters = filters; },
      onChanged: () => refresh(), onNotice: message });
    return;
  }
  const content = role === 'investor' ? investor() : role === 'sales' ? sales() : broker();
  const registry = state.page === 'mine' && ['sales','investor'].includes(role)
    ? '<details class="panel" data-my-registry><summary>律所登记记录</summary><div data-registry-host></div></details>' : '';
  app.innerHTML = `<div class="mobile-content">${state.page === 'mine' ? accountSummary(actor) : ''}${registry}${content}</div><nav class="bottom-nav" aria-label="底部导航">
    ${[['home', '首页'], ['mine', '我的']].map(([page, name]) => button(name, 'page', page,
    `aria-current="${state.page === page || state.page === 'registry' && page === 'home' ? 'page' : 'false'}"`)).join('')}</nav>`;
  if (role === 'sales' && state.page === 'registry') void showRegistry(app.querySelector('[data-registry-host]'), false);
  app.querySelector('[data-my-registry]')?.addEventListener('toggle', event => {
    if (event.currentTarget.open) void showRegistry(event.currentTarget.querySelector('[data-registry-host]'), false);
  });
  if (role === 'sales' && state.page === 'mine' && !state.salesBoard.data && !state.salesBoard.loading && !state.salesBoard.error) void loadSalesBoard();
}

async function copyLink(path) {
  const link = `${location.origin}${path || '/'}`;
  try { await navigator.clipboard.writeText(link); message('已复制链接'); }
  catch { message(link); }
}

document.addEventListener('click', async event => {
  const target = event.target.closest('button[data-action]');
  if (!target) return;
  const { action, value } = target.dataset;
  try {
    switch (action) {
      case 'sales-board-period':
        if (!['all', 'month'].includes(value)) break;
        Object.assign(state.salesBoard, { period: value, offset: 0, dateError: '' });
        await loadSalesBoard(0); break;
      case 'sales-board-metric':
        if (!['channels', 'customers', 'effective', 'closed'].includes(value)) break;
        Object.assign(state.salesBoard, { metric: value, offset: 0 });
        await loadSalesBoard(0); break;
      case 'sales-board-page': await loadSalesBoard(Number(value)); break;
      case 'sales-board-retry': await loadSalesBoard(); break;
      case 'overview-detail':
        state.overviewDetail = { index: Number(value), q: '', offset: 0 }; render();
        app.querySelector('[data-action="overview-back"]')?.focus(); break;
      case 'overview-back': {
        const index = state.overviewDetail?.index;
        state.overviewDetail = null; render();
        app.querySelector(`[data-action="overview-detail"][data-value="${index}"]`)?.focus(); break;
      }
      case 'overview-reset':
        if (state.overviewDetail) { state.overviewDetail.q = ''; state.overviewDetail.offset = 0; render(); } break;
      case 'overview-page':
        if (state.overviewDetail) { state.overviewDetail.offset = Number(value); render(); app.querySelector('[data-action="overview-back"]')?.focus(); } break;
      case 'follow-filter': state.followFilter = value; render(); break;
      case 'edit-company': state.editCompany = value; render(); app.querySelector('[data-form="company"]')?.scrollIntoView({ block: 'center' }); break;
      case 'edit-assignment': state.editAssignment = value; state.adminTab = 5; render(); app.querySelector('[data-form="assignment"]')?.scrollIntoView({ block: 'center' }); break;
      case 'edit-channel': state.editChannel = value; render(); break;
      case 'channel-cases': state.caseFilters = { brokerId: value }; state.adminTab = 2; render(); break;
      case 'sales-leads': state.assignmentFilters = { queue: 'all', salesId: value }; state.adminTab = 5; render(); break;
      case 'open-queue': state.assignmentFilters = { queue: value }; state.adminTab = 5; render(); break;
      case 'toggle-recovery': if (!state.authBusy) { state.recovering = !state.recovering; state.registering = false; message(''); render(); } break;
      case 'security': state.security = !state.security; state.recovery = null; message(''); render(); break;
      case 'cancel-account': state.accountAction = null; state.recovery = null; render(); break;
      case 'account-password': case 'account-closed': case 'account-active': case 'account-recovery':
        state.accountAction = { id: Number(value), kind: action.slice(8) }; state.recovery = null; render();
        app.querySelector('[data-form="manage-account"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); break;
      case 'toggle-auth': if (!state.authBusy) { state.registering = !state.registering; message(''); render(); } break;
      case 'edit-name': state.editingName = !state.editingName; render(); break;
      case 'sign-out': await request('/auth/logout', {}); resetView(); message('已退出登录'); break;
      case 'page': cancelSalesBoard(); state.page = value; state.metric = 0; state.lead = ''; state.editingName = false; state.security = false; state.recovery = null; message(''); await refresh(); break;
      case 'metric': state.metric = Number(value); render(); app.querySelector('.filters .selected')?.focus(); break;
      case 'ledger': state.ledger = value; render(); app.querySelector('.filters .selected')?.focus(); break;
      case 'lead': state.lead = value; await refresh(); break;
      case 'admin-tab': state.adminTab = Number(value); state.overviewDetail = null; state.accountAction = null; state.recovery = null; message(''); await refresh(); break;
      case 'share': await copyLink(value); break;
    }
  } catch (error) { handleError(error); }
});

const forms = {
  company: ['/companies', '已保存公司配置，仅影响后续新留资'], assignment: ['/assignments', '已保存留资分派'],
  'channel-owner': ['/channels/owner', '已更新渠道合作负责人'],
  cooperation: ['/cooperations', '已保存合作签约与销售绑定'], account: ['/accounts', '券商账号已开通'],
  'sales-account': ['/accounts/sales', '销售账号已开通'], name: ['/profile/name', '已保存显示名称'],
  lead: ['/leads', '已提交，可在「我的」查看留资记录'],
  followup: ['/followups', '已保存跟进记录'], reassign: ['/reassign', '已保存客户归属'],
  signing: ['/signings', '已保存客户实际签约'], case: ['/cases', '已保存案件状态'],
};

document.addEventListener('change', event => {
  const form = event.target.closest('form');
  if (form?.dataset.form === 'sales-board-dates' && ['from', 'to'].includes(event.target.name)) {
    state.salesBoard[event.target.name] = event.target.value;
  }
  if (form?.dataset.form === 'assignment' && form.dataset.source === 'direct' && event.target.name === 'companyId') {
    const company = state.view.companies.find(item => item.id === event.target.value);
    form.elements.salesId.value = company?.salesId || '';
  }
  if (form?.dataset.form === 'query' && event.target.name === 'type') {
    state.filters = { type: event.target.value };
    render();
  }
});

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.dataset.form) return;
  event.preventDefault();
  if (!clientSearch.validate(form)) return;
  const kind = form.dataset.form;
  const revision = state.revision;
  const input = Object.fromEntries(new FormData(form));
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const queries = { 'assignment-query': 'assignmentFilters', 'case-query': 'caseFilters', 'sales-query': 'salesFilters', 'channel-query': 'channelFilters' };
    if (kind === 'sales-board-dates') {
      const board = state.salesBoard;
      board.from = input.from; board.to = input.to;
      if (!board.from || !board.to) { board.dateError = '请选择起止日期'; render(); return; }
      const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      if (!validDate(board.from) || !validDate(board.to)) { board.dateError = '请选择有效的日期'; render(); return; }
      if (board.from > board.to) { board.dateError = '开始日期须早于或等于结束日期'; render(); return; }
      if (state.view.today && board.to > state.view.today) { board.dateError = '日期不能晚于今天'; render(); return; }
      Object.assign(board, { period: 'custom', rangeFrom: board.from, rangeTo: board.to, offset: 0, dateError: '' });
      await loadSalesBoard(0); return;
    }
    if (kind === 'overview-detail-search' && state.overviewDetail) {
      state.overviewDetail.q = String(input.q || '').trim().slice(0, 100);
      state.overviewDetail.offset = 0; render(); return;
    }
    if (queries[kind]) { state[queries[kind]] = input; state.editAssignment = ''; render(); return; }
    if (['recover', 'change-password'].includes(kind)) {
      if (input.password !== input.confirm) throw new Error('两次输入的密码不一致');
      await request(kind === 'recover' ? '/auth/recover' : '/auth/change-password', input);
      resetView();
      message('密码已更新，请用新密码重新登录。旧登录和恢复码均已失效。');
      return;
    }
    if (kind === 'recovery-code') {
      const result = await request('/auth/recovery-code', input);
      state.recovery = { ...result, username: state.view.actor.account, scope: 'self' };
      render();
      message('请保存恢复码，关闭页面后无法再次查看。');
      return;
    }
    if (kind === 'account-query') { state.accountFilters = input; state.accountAction = null; state.recovery = null; render(); return; }
    if (kind === 'manage-account') {
      if (input.kind === 'password' && input.password !== input.confirm) throw new Error('两次输入的密码不一致');
      const target = state.view.accounts.find(item => item.id === Number(input.identityId));
      const endpoint = input.kind === 'password' ? 'password' : input.kind === 'recovery' ? 'recovery-code' : 'status';
      const result = await request(`/accounts/${endpoint}`, { ...input, status: input.kind });
      state.accountAction = null;
      state.recovery = result.code ? { ...result, username: target.username, scope: 'managed' } : null;
      if (result.signedOut) { resetView(); message('密码已重置，请用临时密码重新登录并设置个人密码。'); return; }
      await refresh();
      message(input.kind === 'recovery' ? '临时恢复码已生成，请核实身份后交给账号本人。' : `${accountActionNames[input.kind]}成功`);
      return;
    }
    if (kind === 'auth') {
      if (state.authBusy) return;
      state.authBusy = true;
      if (state.registering && input.password !== input.confirm) throw new Error('两次输入的密码不一致');
      const credentials = state.registering ? { phone: input.phone, password: input.password } : { username: input.username, password: input.password };
      await applyPromotions();
      await request(state.registering ? '/auth/register' : '/auth/login', credentials);
      resetView();
      message('');
      await refresh();
      return;
    }
    if (kind === 'query') {
      if (submit?.name === 'download') {
        const response = await fetch(`${apiRoot}/export?${new URLSearchParams({ ...input, format: 'xlsx' })}`);
        if (!response.ok) throw new Error('导出失败，请检查当前身份');
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = `${reportDefinition(input.type).title}.xlsx`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      state.filters = input;
      render();
      return;
    }
    if (kind === 'lead') input.consent = input.consent === 'on';
    if (kind === 'company') input.active = input.active === 'on';
    const [path, notice] = forms[kind];
    await request(path, input);
    if (revision !== state.revision) return;
    if (kind === 'lead') state.page = 'mine';
    if (kind === 'name') state.editingName = false;
    if (kind === 'company') state.editCompany = '';
    if (kind === 'assignment') state.editAssignment = '';
    if (kind === 'channel-owner') state.editChannel = '';
    await refresh(revision);
    if (revision !== state.revision) return;
    message(kind === 'sales-account' ? `${notice}。${initialPasswordHint()}` : notice);
  } catch (error) { handleError(error, ['auth', 'recover', 'change-password', 'recovery-code', 'manage-account'].includes(kind)); }
  finally { if (kind === 'auth') state.authBusy = false; if (submit) submit.disabled = false; }
});

const promo = new URLSearchParams(location.search).get('promo');
if (!adminPage && promo && /^[a-z0-9_-]{1,32}$/i.test(promo)) {
  sessionStorage.setItem(pendingKey, [...new Set([...promotions(), promo])].join(','));
  history.replaceState(null, '', location.pathname);
}
try {
  if (!adminPage) await applyPromotions();
  await refresh();
} catch (error) {
  if (error.status === 401) resetView();
  else { resetView(); message(error.message, true); }
}
