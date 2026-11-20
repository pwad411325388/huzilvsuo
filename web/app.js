import { reportDefinition } from './report.js';
import { recordsEntryState, normalRecordsState } from './user-records-panel.js';
import { operationsPage } from './operations.js';
import { renderClientPicker, renderClientRecords, installClientSearch } from './client-search.js';
import { renderBrokerAccounts, mountBrokerAccounts } from './broker-accounts.js';
import { businessBoardScope, businessBoardMatches, businessBoardParams, businessBoardPresentation } from './business-board.js';
import { compareAccounts, compareRecent } from './list-order.js';
import { renderHomeCard, salesHomeNote, brokerHomeNote } from './home-card.js';

const app = document.querySelector('#app');
const accountBar = document.querySelector('#account-bar');
const feedback = document.querySelector('#feedback');
const adminPage = /^\/admin\/?$/.test(location.pathname);
const portalLink = document.querySelector('#portal-link');
if (!adminPage) {
  document.documentElement.classList.add('business-portal');
  document.querySelector('.brand strong').textContent = '沪紫律师事务所';
  document.querySelector('.brand div span').textContent = '股民索赔宝';
}

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
const adminTabs = [[6, '数据总览'], [7, '销售看板'], [8, '渠道管理'], [2, '客户案件'], [10, '进度测试'], [9, '律所登记台账'], [3, '数据报表'], [5, '公司与派单'], [1, '客户签约'], [0, '账号管理'], [4, '审计与联调']];
const timeZone = 'Asia/Shanghai';
const dayOf = date => new Intl.DateTimeFormat('sv-SE', { timeZone }).format(new Date(date));
const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const state = { ready: false, registering: false, authBusy: false, editingName: false, revision: 0,
  view: null, page: 'home', metric: 0, lead: '', ledger: '洽谈中', adminTab: 6, filters: {},
  recovering: false, security: false, recovery: null, accountFilters: {}, accountAction: null,
  assignmentFilters: {}, caseFilters: {}, salesFilters: {}, channelFilters: {}, editCompany: '', editAssignment: '', editChannel: '', clientRecords: {}, brokerFilters: {}, overviewDetail: null,
  salesBoard: salesBoardState(), adminSales: {}, adminOverview: {}, adminData: {}, adminProgressTest: {}, userRecords: {}, recordsDrilldown: {}, recordsOwner: '', recordsReturn: 'home' };

let adminProgressTestPanel;
async function showAdminProgressTest(container) {
  if (!container || container.dataset.loaded) return;
  container.dataset.loaded = 'true';
  const revision = state.revision, owner = state.view?.actor.id;
  const current = () => container.isConnected && state.revision === revision && state.adminTab === 10 && state.view?.progressTestEnabled === true && state.view?.actor.role === 'admin' && state.view.actor.id === owner;
  try {
    const { mountAdminProgressTest } = await import('./admin-progress-test-panel.js');
    if (!current()) return;
    adminProgressTestPanel = mountAdminProgressTest(container, { request, initialState: state.adminProgressTest,
      onState: value => { if (current()) state.adminProgressTest = value; }, onError: handleError, isCurrent: current });
  } catch {
    if (current()) {
      delete container.dataset.loaded;
      container.setAttribute('aria-busy', 'false');
      container.innerHTML = '<section class="panel"><p role="alert">进度测试暂未加载，请重试。</p><button class="secondary" data-action="retry-progress-test">重新加载</button></section>';
    }
  }
}

let adminDataPanel;
async function showAdminData(container) {
  if (!container || container.dataset.loaded) return;
  container.dataset.loaded = 'true';
  const revision = state.revision, owner = state.view?.actor.id, tab = state.adminTab;
  const current = () => container.isConnected && state.revision === revision && state.adminTab === tab && state.view?.actor.role === 'admin' && state.view.actor.id === owner;
  try {
    const { mountAdminDataPanel } = await import('./admin-data-panel.js');
    if (!current()) return;
    adminDataPanel = mountAdminDataPanel(container, { request, download: downloadAdminData, page: container.dataset.adminDataHost,
      initialState: state.adminData[tab] || {}, today: state.view.today,
      onState: value => { if (current()) state.adminData[tab] = value; }, onError: handleError, isCurrent: current });
  } catch {
    if (current()) {
      delete container.dataset.loaded;
      container.setAttribute('aria-busy', 'false');
      container.innerHTML = '<section class="panel"><p role="alert">业务数据暂未加载，请重试。</p><button class="secondary" data-action="retry-admin-data">重新加载</button></section>';
    }
  }
}

async function downloadAdminData(path, filename, signal, current) {
  const response = await fetch(`${apiRoot}${path}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const failure = new Error(body.message || '导出失败，请重试'); failure.status = response.status; throw failure;
  }
  const blob = await response.blob();
  if (!current() || signal.aborted) return;
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let overviewPanel;
async function showOverview(container) {
  if (!container || container.dataset.loaded) return;
  container.dataset.loaded = 'true';
  const revision = state.revision, owner = state.view?.actor.id;
  const current = () => container.isConnected && state.revision === revision && state.adminTab === 6 && state.view?.actor.role === 'admin' && state.view.actor.id === owner;
  try {
    const { mountOverviewPanel } = await import('./overview-panel.js');
    if (!current()) return;
    overviewPanel = mountOverviewPanel(container, { request, initialState: state.adminOverview, today: state.view.today,
      onState: value => { if (current()) state.adminOverview = value; }, onError: handleError, isCurrent: current });
  } catch {
    if (current()) {
      delete container.dataset.loaded;
      container.setAttribute('aria-busy', 'false');
      container.innerHTML = '<section class="panel"><p role="alert">数据总览暂未加载，请重试。</p><button class="secondary" data-action="retry-overview">重新加载</button></section>';
    }
  }
}

let adminSalesPanel;
async function showAdminSales(container) {
  if (!container || container.dataset.loaded) return;
  container.dataset.loaded = 'true';
  const revision = state.revision, owner = state.view?.actor.id;
  const current = () => container.isConnected && state.revision === revision && state.adminTab === 7 && state.view?.actor.role === 'admin' && state.view.actor.id === owner;
  try {
    const { mountAdminSalesPanel } = await import('./admin-sales-panel.js');
    if (!current()) return;
    adminSalesPanel = mountAdminSalesPanel(container, { request, sales: state.view.sales, initialState: state.adminSales,
      onState: value => { if (current()) state.adminSales = value; }, onError: handleError, isCurrent: current,
      onRegistry: () => { if (current()) { state.adminTab = 9; render(); } } });
  } catch {
    if (current()) {
      delete container.dataset.loaded;
      container.setAttribute('aria-busy', 'false');
      container.innerHTML = '<section class="panel"><p role="alert">销售看板暂未加载，请重试。</p><button class="secondary" data-action="retry-admin-sales">重新加载</button></section>';
    }
  }
}

function salesBoardState(owner = '', role = '') {
  return { owner, role, period: 'all', from: '', to: '', rangeFrom: '', rangeTo: '', datesOpen: false, detailsExpanded: true, ledger: 'all', q: '', searchDraft: '', metric: role === 'broker' ? 'customers' : 'channels', offset: 0, data: null, error: '', dateError: '', loading: false, sequence: 0 };
}
let salesBoardAbort;
function cancelSalesBoard() {
  salesBoardAbort?.abort();
  state.salesBoard.sequence += 1;
  state.salesBoard.loading = false;
  state.salesBoard.data = null;
  state.salesBoard.error = '';
}

async function loadSalesBoard(offset = state.salesBoard.offset) {
  const board = state.salesBoard;
  const scope = businessBoardScope(state.view?.actor, state.page, board.ledger);
  if (!scope) return;
  if (scope.role === 'broker' && board.metric === 'signings') { board.metric = 'effective'; board.offset = 0; offset = 0; }
  salesBoardAbort?.abort();
  salesBoardAbort = new AbortController();
  const sequence = ++board.sequence;
  const revision = state.revision;
  const current = () => revision === state.revision && board === state.salesBoard && sequence === board.sequence
    && businessBoardMatches(scope, state.view?.actor, state.page, board.ledger) && scope.owner === board.owner;
  board.loading = true; board.error = ''; board.data = null;
  render();
  const params = businessBoardParams(board, scope, offset);
  try {
    const result = await request(`/${scope.role}/board?` + new URLSearchParams(params), undefined, salesBoardAbort.signal);
    if (!current()) return;
    if (!result || !Array.isArray(result.metrics) || !Array.isArray(result.items)
        || !result.metrics.some(item => item.key === result.selected) || result.selected !== params.metric
        || result.period !== params.period || scope.ledger && (result.ledger !== scope.ledger || result.q !== params.q
          || !Number.isInteger(result.scopeTotal) || result.scopeTotal < result.total)
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

function businessBoardVisible() {
  return !!businessBoardScope(state.view?.actor, state.page, state.salesBoard.ledger);
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

let userRecordsPanel;
async function showUserRecords(container) {
  if (!container || container.dataset.loaded) return;
  container.dataset.loaded = 'true';
  const revision = state.revision, actor = state.view?.actor, page = state.page;
  const stateKey = ['records', 'registry'].includes(page) ? 'recordsDrilldown' : 'userRecords';
  const current = () => container.isConnected && state.revision === revision && state.page === page && state.view?.actor.id === actor.id && state.view?.actor.role === actor.role;
  try {
    const { mountUserRecordsPanel } = await import('./user-records-panel.js');
    if (!current()) return;
    userRecordsPanel = mountUserRecordsPanel(container, { request, role: actor.role, today: state.view.today,
      initialState: { listExpanded: !(actor.role === 'sales' && page === 'home'), ...state[stateKey] },
      onState: value => { if (current()) state[stateKey] = value; },
      onResult: result => {
        if (!current() || actor.role !== 'sales' || page !== 'home') return;
        const note = app.querySelector('[data-home-note]');
        if (note) note.textContent = salesHomeNote(result);
      }, onError: handleError, isCurrent: current });
  } catch {
    if (current()) {
      delete container.dataset.loaded;
      if (actor.role === 'sales' && page === 'home') {
        const note = app.querySelector('[data-home-note]');
        if (note) note.textContent = salesHomeNote({ error: true });
      }
      container.innerHTML = '<section class="panel"><p role="alert">记录暂时无法加载，请重试。</p><button class="secondary" data-action="retry-user-records">重新加载</button></section>';
    }
  }
}

const userRecordsHost = () => '<div data-user-records-host aria-busy="true"><section class="panel" role="status">正在加载记录…</section></div>';

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
  state.clientRecords = {};
  state.brokerFilters = {};
  state.overviewDetail = null;
  state.adminSales = {};
  state.adminOverview = {};
  state.adminData = {};
  state.adminProgressTest = {};
  state.userRecords = {}; state.recordsDrilldown = {}; state.recordsOwner = '';
  render();
}

const pendingKey = 'huzi:pending-promos';
const promotions = () => (sessionStorage.getItem(pendingKey) || '').split(',').filter(Boolean);

async function applyPromotions() {
  const capture = async () => {
    for (const code of promotions()) {
      try {
        await request('/referral/capture', { code });
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
const tabIcon = {
  home: '<path d="m3 11 9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',
  mine: '<circle cx="12" cy="7.5" r="3.3"/><path d="M4.5 20v-1a7.5 7.5 0 0 1 15 0v1z"/>',
};
function businessTab(page, name, selected) {
  return `<button type="button" data-action="page" data-value="${page}" aria-current="${selected ? 'page' : 'false'}">
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${tabIcon[page]}</svg><span>${name}</span></button>`;
}

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
  return `<div class="mobile-content${adminPage ? '' : ' business-login'}">${hero(adminPage ? '沪紫律师事务所' : '证券维权服务', adminPage ? '运营后台' : '股民索赔宝', adminPage ? title : '')}
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
    <div class="business-account-head"><span class="avatar" aria-hidden="true">${safe(initial(actor.name))}</span>
    <div><h2>${safe(actor.name)}</h2><p class="muted">${safe(roleNames[actor.role])}账号 ${safe(actor.account)}</p></div></div>
    <div class="business-account-actions">${actor.role === 'investor' ? button(state.editingName ? '取消修改' : '修改显示名称', 'edit-name', '', 'class="quiet"') : ''}
    ${button('账号安全', 'security', '', 'class="quiet"')}${button('退出登录', 'sign-out', '', 'class="quiet"')}</div>
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
  return `<section class="dashboard"><h2>${state.view.actor.role === 'sales' ? '券商合作统计' : '数据看板'}</h2><div class="metrics">${metrics.map(item =>
    `<div class="metric"><span>${safe(item.label)}</span><strong>${item.value}<small>${safe(item.unit)}</small></strong></div>`).join('')}</div>
    <div class="filters" aria-label="按指标筛选">${metrics.map((item, index) => button(item.label, 'metric', index,
      `class="chip ${item === selected ? 'selected' : ''}" aria-pressed="${item === selected}"`)).join('')}</div>
    <div class="list-heading"><h2>${safe(selected.label)}</h2><span>${selected.value} ${safe(selected.unit)}</span></div>
    <div class="records">${selected.records.map(record => recordCard(record)).join('') || empty()}</div></section>`;
}

function renderSalesBoard() {
  const board = state.salesBoard;
  const data = board.data;
  const scope = businessBoardScope(state.view?.actor, state.page, board.ledger);
  const presentation = businessBoardPresentation(scope);
  const selected = data?.metrics.find(item => item.key === data.selected);
  const listToggle = button(board.detailsExpanded ? '收起明细' : '展开明细', 'board-toggle-list', '',
    `class="secondary" aria-expanded="${board.detailsExpanded}" aria-controls="board-results"`);
  const brokerHome = scope.role === 'broker' && scope.page === 'home';
  const controls = `<div class="filters business-period" aria-label="统计日期范围">${[['all', '全部'], ['month', '本月']].map(([period, label]) =>
    button(label, 'sales-board-period', period, `class="chip ${board.period === period ? 'selected' : ''}" aria-pressed="${board.period === period}"`)).join('')}
    ${button(board.datesOpen ? '收起日期' : '自选日期', 'board-toggle-dates', '', `class="chip" aria-pressed="${board.period === 'custom'}" aria-expanded="${board.datesOpen}" aria-controls="board-dates"`)}</div>
    <div id="board-dates" ${board.datesOpen ? '' : 'hidden'}><form data-form="sales-board-dates" class="inline-form">
      ${field('开始日期', `<input type="date" name="from" max="${safe(state.view.today)}" value="${safe(board.from)}" required>`)}
      ${field('结束日期', `<input type="date" name="to" max="${safe(state.view.today)}" value="${safe(board.to)}" required>`)}
      <button class="${board.period === 'custom' ? 'primary' : 'secondary'}">按日期查看</button></form>
    ${board.dateError ? `<p role="alert" class="sales-board-error">${safe(board.dateError)}</p>` : ''}</div>`;
  const customerControls = brokerHome ? `<form data-form="broker-board-search" class="inline-form business-search" role="search">
      ${field('搜索客户或股票', `<input type="search" name="q" maxlength="100" value="${safe(board.searchDraft)}" placeholder="客户姓名、股票名称或代码" autocomplete="off">`)}
      <button class="primary">搜索</button>${button('重置', 'broker-board-search-reset', '', 'class="secondary"')}</form>
    ${['customers', 'effective'].includes(board.metric) ? `<div class="filters ledger-filters" aria-label="客户签约筛选">${[['all', '全部客户'], ['negotiating', '洽谈中'], ['signed', '已签约']].map(([key, label]) => {
      const active = key === 'signed' ? board.metric === 'effective' : board.metric === 'customers' && board.ledger === key;
      return button(label, 'broker-board-ledger', key, `class="chip ${active ? 'selected' : ''}" aria-pressed="${active}"`);
    }).join('')}</div>` : ''}` : '';
  let content = empty('正在加载统计与明细…');
  if (board.error) content = `<p role="alert" class="sales-board-error">${safe(board.error)}</p>${button('重新加载', 'sales-board-retry', '', 'class="secondary"')}`;
  else if (data) {
    const page = Math.floor(data.offset / data.limit) + 1;
    const pages = Math.max(1, Math.ceil(data.total / data.limit));
    content = `${data.period === 'all' ? '' : `<p class="muted">${safe(data.from)} 至 ${safe(data.to)}</p>`}${presentation.showMetrics ? `<div class="metrics">${data.metrics.filter(item => !brokerHome || item.key !== 'signings').map(item =>
      `<button type="button" class="metric ${item.key === data.selected ? 'selected' : ''}" data-action="sales-board-metric" data-value="${safe(item.key)}" aria-pressed="${item.key === data.selected}">
        <span>${safe(item.label)}</span><strong>${safe(item.value)}<small>${safe(item.unit)}</small></strong></button>`).join('')}</div>` : ''}
      ${customerControls}<div class="list-heading" id="board-results-heading"><h2>${safe(presentation.label || selected.label)}明细</h2><div class="business-shortcuts"><span>${brokerHome && data.q ? `范围 ${safe(data.scopeTotal)} ${safe(selected.unit)} · 检索结果 ` : ''}${safe(data.total)} ${safe(selected.unit)}</span>${listToggle}</div></div>
      <div id="board-results" ${board.detailsExpanded ? '' : 'hidden'}>
      <div class="records">${data.items.map(item => {
        const customerId = item.customerId || (['customers', 'effective', 'signings'].includes(data.selected) ? item.id : '');
        const card = { ...item, ...(state.view.actor.role === 'broker' ? { phone: '' } : {}), openedOnLabel: '案件登记日期',
          ...(data.selected === 'channels' ? { subtitle: `${item.customerCount || 0} 份客户档案 · ${item.recordCount || 0} 条记录` } : {}) };
        const directProgress = scope.role === 'sales' && ['lead', 'registry', 'case'].includes(item.kind) && item.progressId && !(customerId && item.recordCount > 1);
        const recordsLabel = scope.role === 'sales' ? (item.recordCount > 1 ? '选择股票查看进度' : '查看记录')
          : data.selected === 'signings' ? '查看该签约客户的全部股票记录' : '查看股票记录';
        const action = directProgress ? button('查看进度', 'board-progress', item.progressId, `class="secondary" data-kind="${safe(item.kind)}"`)
          : customerId ? button(recordsLabel, 'customer-records', customerId, `class="secondary" data-customer-name="${safe(item.title)}"`) : '';
        return `<div class="record-with-action">${recordCard(card)}${action}</div>`;
      }).join('') || empty()}</div></div>
      <nav class="list-pagination" aria-label="业务统计明细分页">
        ${button('上一页', 'sales-board-page', Math.max(0, data.offset - data.limit), `class="secondary" ${data.offset === 0 ? 'disabled' : ''}`)}
        <span>${page} / ${pages} 页 · 每页 ${data.limit} 条</span>
        ${button('下一页', 'sales-board-page', data.offset + data.limit, `class="secondary" ${data.offset + data.limit >= data.total ? 'disabled' : ''}`)}
      </nav>${board.detailsExpanded && data.items.length ? `<div class="list-heading">${listToggle}</div>` : ''}`;
  }
  return `<section class="dashboard sales-board" data-board-mode="dashboard" aria-busy="${board.loading}"><h2>${safe(presentation.title)}</h2>${controls}<div class="sales-board-content">${!data ? customerControls : ''}${content}</div></section>`;
}

let consultationSubmission = null;

function investorConsultation() {
  return `<details class="inv-consult"><summary>提交咨询资料</summary><form data-form="lead" class="form-grid">
      ${field('姓名', '<input name="name" maxlength="40" autocomplete="name" required>')}
      ${field('手机号码', '<input name="phone" type="tel" maxlength="11" inputmode="numeric" autocomplete="tel" pattern="1[0-9]{10}" title="请输入以 1 开头的 11 位手机号" placeholder="以 1 开头的 11 位数字" required>')}
      ${field('股票名称', '<input name="stockName" maxlength="50" required>')}
      ${field('股票代码', '<input name="stockCode" maxlength="20" placeholder="如 600000 或 NVDA" required>')}
      ${field('大致买入时段', select('period', [['2020 年之前', '2020 年之前'], ['2020–2022 年', '2020–2022 年'], ['2022–2024 年', '2022–2024 年'], ['2024 年至今', '2024 年至今']], '', '请选择'))}
      <label class="check"><input type="checkbox" name="consent" required>我同意将资料用于联系与咨询。</label>
      <button class="primary">提交留资</button></form></details>`;
}

function investorRecentRow(item, index) {
  const title = item.caseTitle && item.caseTitle !== item.stockName ? `<small>${safe(item.caseTitle)}</small>` : '';
  const pending = ['待您补充材料', '待补充材料'].includes(item.status);
  return `<button type="button" class="inv-row" data-action="investor-progress" data-value="${index}">
    <span class="inv-record-icon${item.kind === 'lead' ? ' inv-record-lead' : ''}" aria-hidden="true"></span>
    <span class="inv-record-copy"><strong>${safe(item.stockName || '股票名称待核对')}</strong>${title}
      <small>${item.stockCode ? safe(item.stockCode) + ' · ' : ''}${item.registeredOn ? safe(item.registeredOn) + ' 登记' : '登记日期待核对'}</small></span>
    <span class="inv-status${pending ? ' inv-status-pending' : ''}">${safe(item.status || '进度待同步')}</span><span class="inv-chevron" aria-hidden="true">›</span></button>`;
}

function investorHome() {
  const { investorHome: summary, actor, today } = state.view;
  const card = options => renderHomeCard({ role: 'investor', name: actor.name, today, action: 'investor-records', actionLabel: '查看我的记录', ...options });
  if (!summary) return card({ note: '首页摘要暂未提供，可查看我的记录。' }) + investorConsultation();
  const attention = summary.attention;
  const note = attention ? [summary.attentionCount + ' 条待关注', attention.status, attention.stockName || '股票名称待核对', attention.stockCode, attention.caseTitle !== attention.stockName && attention.caseTitle].filter(Boolean).join(' · ')
    : summary.totalRecords ? '暂无补料提醒' : '暂无维权记录，登记后可在这里查看进度。';
  const stats = [[summary.totalRecords, '条', '全部记录'], [summary.caseCount, '件', '案件'], [summary.leadCount, '条', '未建案留资']];
  return `${card({ note, ...(attention ? { action: 'investor-progress', value: 'attention', actionLabel: '查看案件进度' } : {}) })}
    <button class="inv-stats" type="button" data-action="investor-records">${stats.map(([value, unit, label]) => `<span><strong>${safe(value)}<small>${unit}</small></strong><span>${label}</span></span>`).join('')}</button>
    ${summary.unclassifiedCount ? `<p class="inv-unclassified">另有 ${safe(summary.unclassifiedCount)} 条登记待核对。</p>` : ''}
    <section class="inv-recent"><div class="inv-section-title"><h2>最近记录</h2>${button('查看全部 ›', 'investor-records', '', 'class="inv-more"')}</div>
      ${summary.recent?.length ? `<div class="inv-list">${summary.recent.slice(0, 2).map(investorRecentRow).join('')}</div>` : '<p class="inv-empty">尚无登记记录</p>'}</section>
    ${investorConsultation()}`;
}

function investor() {
  if (state.page === 'home') return investorHome();
  if (state.page === 'records') {
    const previous = state.recordsDrilldown.directHomeDetail ? '' : button('返回首页', 'records-return', '', 'class="secondary"');
    return previous + userRecordsHost();
  }
  const { contact } = state.view;
  return `${contact ? `<dl class="panel profile-contact" aria-label="本人联系信息"><div><dt>姓名</dt><dd>${safe(contact.name)}</dd></div><div><dt>手机号</dt><dd>${safe(contact.phone)}</dd></div></dl>` : ''}
    ${userRecordsHost()}${panel('转介绍', '<p>将咨询入口分享给有需要的股民。</p>' + button('复制咨询入口', 'share', '', 'class="secondary"'))}`;
}

function sales() {
  if (state.page === 'mine') return `<div class="panel business-shortcuts">${button('查看客户与股票', 'open-records', '', 'class="quiet"')}</div>` + renderSalesBoard();
  if (['records', 'registry'].includes(state.page)) return button(state.recordsReturn === 'mine' ? '返回销售统计' : '返回销售工作台', 'records-return', '', 'class="secondary"') + userRecordsHost();
  return `${renderHomeCard({ role: 'sales', name: state.view.actor.name, today: state.view.today, note: salesHomeNote({ loading: true }), action: 'home-cooperation', actionLabel: '登记券商合作' })}
    <section class="panel"><h2>登记合作</h2><form data-form="cooperation" class="form-grid">
      ${field('券商名称', '<input name="name" maxlength="100" required>')}${dateField('签约日期', 'signedOn')}
      <button class="primary">保存签约绑定</button></form></section>${userRecordsHost()}`;
}

function broker() {
  const { name, code } = state.view.broker;
  if (state.page === 'mine') {
    return `<section class="panel business-promo"><h2>推广与分享</h2><p>将推广链接分享给客户，用于登记咨询资料。</p>
      ${code ? `<figure class="promo-placeholder"><img src="/assets/promo-placeholder.png" width="180" height="180" alt="演示占位二维码，暂不可扫码">
        <figcaption>演示占位码，暂不可扫码</figcaption></figure>
      <p>专属推广码：<code>${safe(code)}</code></p><div class="business-shortcuts">
      ${button('复制推广码', 'copy-promo-code', '', 'class="secondary"')}
      ${button('复制推广链接', 'share', '/?promo=' + encodeURIComponent(code), 'class="primary"')}</div>` : empty('暂无专属推广码')}</section>`;
  }
  if (['records', 'registry'].includes(state.page)) return button('返回渠道台账', 'records-return', '', 'class="secondary"') + userRecordsHost();
  return `${renderHomeCard({ role: 'broker', name, today: state.view.today, note: brokerHomeNote(state.salesBoard), action: 'home-customers', actionLabel: '查看客户明细' })}${renderSalesBoard()}`;
}

function adminContent() {
  const { clients, brokers, sales, leads, cases, caseStatuses, caseCutoff, audit, integrations } = state.view;
  const onboardingSales = sales.slice().sort((a, b) => compareAccounts(a, b, true));
  const statusOptions = caseStatuses.map(status => [status, status]);
  const header = '';
  const operations = () => operationsPage(state.view, state, { safe, button, field, select, panel, empty, tag });
  if (state.adminTab === 10 && state.view.progressTestEnabled === true) return '<div data-admin-progress-test-host aria-busy="true">正在打开进度测试…</div>';
  if (state.adminTab === 9) return '<div data-registry-host>正在打开登记台账…</div>';
  if ([5, 6, 7, 8].includes(state.adminTab)) return operations();
  if (state.adminTab === 0) return header + accountManagement() + `<div class="admin-grid">${panel('销售账号开通', `<form data-form="sales-account" class="form-grid">
    ${field('销售业务记录', select('salesId', onboardingSales.filter(item => !item.username).map(item => [item.id, item.name]), '', '新增销售'))}
    ${field('销售姓名', '<input name="name" maxlength="40" required>')}
    ${field('专用账号', '<input name="username" minlength="3" maxlength="40" autocomplete="off" required>')}
    <p class="muted">${safe(initialPasswordHint())}</p>
    <button class="primary">开通销售账号</button></form>`)}${panel('销售账号', (onboardingSales.map(item => `<article class="admin-record">
    <div class="list-heading"><h3>${safe(item.name)}</h3>${tag(item.accountStatus === 'closed' ? '已注销' : item.username ? '已开户' : '待开户')}</div>
    ${item.username ? `<p>账号 ${safe(item.username)}</p>` : ''}</article>`).join('') || empty('暂无销售账号')))}</div>` + renderBrokerAccounts(state.brokerFilters);

  if (state.adminTab === 1) return header + panel('客户操作范围', `<p>此处维护已建立小程序记录的客户；登记表资料请到律所登记台账处理。</p><div class="filters">${button('查看全部客户档案', 'all-client-data', '', 'class="secondary"')}${button('打开律所登记台账', 'admin-tab', 9, 'class="secondary"')}</div>`) + `<div class="admin-grid">${panel('调整客户归属', `<form data-form="reassign" class="form-grid">
    ${renderClientPicker('reassign')}
    ${field('新券商', select('brokerId', brokers.filter(item => item.username && item.accountStatus === 'active').map(item => [item.id, item.name]), '', '选择已开户券商'))}
    <button class="primary">保存归属</button></form>`)}${panel('登记客户实际签约', `<form data-form="signing" class="form-grid">
    ${renderClientPicker('signing')}
    ${dateField('实际签约日期', 'signedOn')}
    ${field('签约凭据说明', '<input name="reference" maxlength="160" required>')}
    <button class="primary">保存签约结果</button></form>`)}</div>` + renderClientRecords(state.clientRecords);

  if (state.adminTab === 2) return operations() + `<details class="panel"><summary>小程序案件录入与更新</summary><p class="muted">此处维护小程序客户案件；登记表案件请到律所登记台账处理。</p>${button('打开律所登记台账', 'admin-tab', 9, 'class="secondary"')}` + panel('录入新增案件', `<p>可录入 ${safe(caseCutoff)} 及之后登记的案件。</p><form data-form="case" class="form-grid">
    ${field('对应留资', select('leadId', leads.map(item => [item.id, `${item.name} · ${item.stockName} · ${dayOf(item.createdAt)}`]), '', '选择留资记录'))}
    ${field('案件名称', '<input name="title" maxlength="80" required>')}
    ${dateField('案件登记日期', 'openedOn')}${field('当前状态', select('status', statusOptions))}
    <button class="primary">录入案件</button></form>`) + panel('更新案件状态', (cases.slice().sort(compareRecent).map(item => `<article class="admin-record">
    <div class="list-heading"><h3>${safe(item.title)} · ${safe(item.name)}</h3>${tag(item.status)}</div><p>登记日期 ${safe(item.openedOn)}</p>
    <form data-form="case" class="inline-form"><input type="hidden" name="id" value="${safe(item.id)}">
    ${field('当前状态', select('status', statusOptions, item.rawStatus ?? item.status))}<button class="secondary">更新状态</button></form></article>`).join('') || empty('暂无新增案件'))) + '</details>';

  if (state.adminTab === 3) {
    return '<div data-admin-data-host="reports" aria-busy="true"><section class="panel" role="status">正在加载数据报表…</section></div>';
  }

  return header + panel('联调状态', `<dl><dt>WPS</dt><dd>${safe(integrations.wps)}</dd><dt>微信</dt><dd>${safe(integrations.wechat)}</dd></dl>`) +
    panel('最近操作', (audit.map(item => `<article class="admin-record"><h3>${safe(item.action)}</h3>
      <p>${safe(item.actor)} · ${safe(item.subject)} · ${safe(item.createdAt)}</p>${item.details !== '{}' ? `<p>${safe(item.details)}</p>` : ''}</article>`).join('') || empty('暂无操作记录')));
}

function admin() {
  return `<div class="admin-heading"><h1>运营后台</h1><p>客户、渠道与案件运营</p></div><div class="admin-layout">
    <nav class="admin-nav" aria-label="后台功能">${adminTabs.filter(([index]) => index !== 10 || state.view.progressTestEnabled === true).map(([index, title]) => button(title, 'admin-tab', index,
      `class="chip ${index === state.adminTab ? 'selected' : ''}" aria-pressed="${index === state.adminTab}"`)).join('')}</nav>
    <div class="admin-content">${state.security ? securityPanel() : ''}${adminContent()}</div></div>`;
}

function render() {
  adminProgressTestPanel?.dispose(); adminProgressTestPanel = null;
  userRecordsPanel?.dispose(); userRecordsPanel = null;
  adminDataPanel?.dispose();
  adminDataPanel = null;
  overviewPanel?.dispose();
  overviewPanel = null;
  adminSalesPanel?.dispose();
  adminSalesPanel = null;
  const actor = state.view?.actor;
  const role = actor?.role;
  const recordsOwner = actor ? `${actor.role}:${actor.id}` : '';
  if (recordsOwner !== state.recordsOwner) { state.recordsOwner = recordsOwner; state.userRecords = {}; state.recordsDrilldown = {}; }
  if (['sales', 'broker'].includes(role) && (state.salesBoard.owner !== actor.id || state.salesBoard.role !== role)) {
    cancelSalesBoard();
    state.salesBoard = salesBoardState(actor.id, role);
  }
  accountBar.hidden = role !== 'admin';
  accountBar.innerHTML = role === 'admin' ? `<strong>${safe(actor.name)} · ${safe(actor.account)}</strong><div>${button('账号安全', 'security', '', 'class="quiet"')}${button('退出登录', 'sign-out', '', 'class="quiet"')}</div>` : '';
  app.classList.toggle('admin', role === 'admin');
  app.setAttribute('aria-busy', String(!state.ready));
  if (!role) { app.innerHTML = state.ready ? authPanel() : empty('正在检查登录状态…'); return; }
  if (actor.passwordChangeRequired) { app.innerHTML = securityPanel(true); return; }
  if (role === 'admin') {
    if (state.adminTab === 10 && state.view.progressTestEnabled !== true) { state.adminTab = 6; state.adminProgressTest = {}; }
    app.innerHTML = admin();
    clientSearch.mount(app);
    if (state.adminTab === 6) void showOverview(app.querySelector('[data-overview-host]'));
    if ([2, 3, 8].includes(state.adminTab)) void showAdminData(app.querySelector('[data-admin-data-host]'));
    if (state.adminTab === 7) void showAdminSales(app.querySelector('[data-admin-sales-host]'));
    if (state.adminTab === 9) void showRegistry(app.querySelector('[data-registry-host]'), true);
    if (state.adminTab === 10 && state.view.progressTestEnabled === true) void showAdminProgressTest(app.querySelector('[data-admin-progress-test-host]'));
    mountBrokerAccounts(app, { request, onError: handleError, initialPasswordHint: initialPasswordHint(),
      onState: filters => { state.brokerFilters = filters; },
      onChanged: () => refresh(), onNotice: message });
    return;
  }
  const content = role === 'investor' ? investor() : role === 'sales' ? sales() : broker();
  app.innerHTML = `<div class="mobile-content">${state.page === 'mine' ? accountSummary(actor) : ''}${content}</div><nav class="bottom-nav" aria-label="底部导航">
    ${[['home', '首页'], ['mine', '我的']].map(([page, name]) => businessTab(page, name,
      state.page === page || ['records', 'registry'].includes(state.page) && state.recordsReturn === page)).join('')}</nav>`;
  if (app.querySelector('[data-user-records-host]')) void showUserRecords(app.querySelector('[data-user-records-host]'));
  if (businessBoardVisible() && !state.salesBoard.data && !state.salesBoard.loading && !state.salesBoard.error) void loadSalesBoard();
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
      case 'home-cooperation': {
        if (state.view?.actor.role !== 'sales' || state.page !== 'home') break;
        const field = app.querySelector('[data-form="cooperation"] input[name="name"]');
        field?.scrollIntoView({ block: 'center' }); field?.focus({ preventScroll: true });
        break;
      }
      case 'home-customers': {
        if (state.view?.actor.role !== 'broker' || state.page !== 'home') break;
        if (state.salesBoard.metric === 'customers' && state.salesBoard.data && !state.salesBoard.loading && !state.salesBoard.error) {
          state.salesBoard.detailsExpanded = true;
          const results = app.querySelector('#board-results');
          if (results) results.hidden = false;
          for (const toggle of app.querySelectorAll('[data-action="board-toggle-list"]')) {
            toggle.textContent = '收起明细'; toggle.setAttribute('aria-expanded', 'true');
          }
          const heading = app.querySelector('#board-results-heading');
          heading?.setAttribute('tabindex', '-1'); heading?.scrollIntoView({ block: 'start' }); heading?.focus({ preventScroll: true });
          break;
        }
        const board = state.salesBoard, revision = state.revision, sequence = board.sequence + 1;
        Object.assign(board, { metric: 'customers', ledger: 'all', offset: 0, detailsExpanded: true });
        await loadSalesBoard(0);
        if (state.revision !== revision || state.salesBoard !== board || board.sequence !== sequence || state.page !== 'home') break;
        const heading = app.querySelector('#board-results-heading');
        heading?.setAttribute('tabindex', '-1'); heading?.scrollIntoView({ block: 'start' }); heading?.focus({ preventScroll: true });
        break;
      }
      case 'retry-progress-test': if (state.view?.actor.role === 'admin' && state.adminTab === 10) void showAdminProgressTest(app.querySelector('[data-admin-progress-test-host]')); break;
      case 'retry-user-records': void showUserRecords(app.querySelector('[data-user-records-host]')); break;
      case 'board-toggle-dates': {
        const section = document.getElementById('board-dates');
        if (!section) break;
        const open = section.hidden;
        state.salesBoard.datesOpen = open;
        section.hidden = !open;
        target.setAttribute('aria-expanded', String(open));
        target.textContent = open ? '收起日期' : '自选日期';
        break;
      }
      case 'board-progress': {
        if (state.view?.actor.role !== 'sales' || !state.salesBoard.data?.items.some(item => item.progressId === value && item.kind === target.dataset.kind)) break;
        state.recordsReturn = state.page;
        state.recordsDrilldown = { ...recordsEntryState(state.salesBoard, { role: 'sales' }), detail: { kind: target.dataset.kind, id: value } };
        state.page = 'records'; cancelSalesBoard(); render(); break;
      }
      case 'investor-records': case 'investor-progress': {
        if (state.view?.actor.role !== 'investor' || state.page !== 'home') break;
        const home = state.view.investorHome;
        const item = value === 'attention' ? home?.attention : home?.recent?.[value];
        const direct = action === 'investor-progress';
        if (direct && (!item?.progressId || !['case','lead','registry'].includes(item.kind))) break;
        state.recordsReturn = 'home';
        state.recordsDrilldown = { presentation: 'home', directHomeDetail: direct, detail: direct ? { kind: item.kind, id: item.progressId } : null };
        state.page = 'records'; render(); break;
      }
      case 'open-records': case 'customer-records': {
        const board = state.salesBoard;
        state.recordsReturn = state.page === 'mine' ? 'mine' : 'home';
        state.recordsDrilldown = recordsEntryState(board, { role: state.view.actor.role,
          customerId: action === 'customer-records' ? value : '', customerName: target.dataset.customerName || '' });
        state.page = 'records'; cancelSalesBoard(); render(); break;
      }
      case 'records-return': state.page = state.view?.actor.role === 'broker' ? 'home' : state.recordsReturn || 'home'; state.userRecords = normalRecordsState(state.userRecords); state.recordsDrilldown = {}; render(); break;

      case 'retry-admin-data': if (state.view?.actor.role === 'admin' && [2, 3, 8].includes(state.adminTab)) void showAdminData(app.querySelector('[data-admin-data-host]')); break;
      case 'retry-overview': if (state.view?.actor.role === 'admin' && state.adminTab === 6) void showOverview(app.querySelector('[data-overview-host]')); break;
      case 'retry-admin-sales': if (state.view?.actor.role === 'admin' && state.adminTab === 7) void showAdminSales(app.querySelector('[data-admin-sales-host]')); break;
      case 'sales-board-period':
        if (!['all', 'month'].includes(value)) break;
        Object.assign(state.salesBoard, { period: value, offset: 0, dateError: '', detailsExpanded: true });
        await loadSalesBoard(0); break;
      case 'sales-board-metric':
        if (state.view?.actor.role === 'broker' && state.page === 'mine') break;
        if (!(state.view?.actor.role === 'broker' ? ['customers', 'ongoing', 'closed', 'effective'] : ['channels', 'customers', 'effective', 'closed']).includes(value)) break;
        Object.assign(state.salesBoard, { metric: value, ledger: 'all', offset: 0, detailsExpanded: true });
        await loadSalesBoard(0); break;
      case 'sales-board-page': state.salesBoard.detailsExpanded = true; await loadSalesBoard(Number(value)); break;
      case 'board-toggle-list': {
        state.salesBoard.detailsExpanded = !state.salesBoard.detailsExpanded;
        render();
        const heading = app.querySelector('#board-results-heading');
        if (!state.salesBoard.detailsExpanded && heading?.getBoundingClientRect().top < 0) heading.scrollIntoView({ block: 'start' });
        break;
      }
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
      case 'page': state.userRecords = normalRecordsState(state.userRecords); if (value === 'home' && state.view?.actor.role === 'sales') state.userRecords.listExpanded = false; state.recordsDrilldown = {}; cancelSalesBoard(); state.salesBoard.offset = 0; state.page = value; state.metric = 0; state.lead = ''; state.editingName = false; state.security = false; state.recovery = null; message(''); await refresh(); break;
      case 'metric': state.metric = Number(value); render(); app.querySelector('.filters .selected')?.focus(); break;
      case 'broker-board-ledger':
        if (state.view?.actor.role !== 'broker' || state.page !== 'home' || !['all', 'negotiating', 'signed'].includes(value)) break;
        Object.assign(state.salesBoard, { metric: value === 'signed' ? 'effective' : 'customers', ledger: value === 'negotiating' ? value : 'all', offset: 0, detailsExpanded: true });
        await loadSalesBoard(0); break;
      case 'broker-board-search-reset':
        if (state.view?.actor.role !== 'broker' || state.page !== 'home') break;
        Object.assign(state.salesBoard, { q: '', searchDraft: '', offset: 0, detailsExpanded: true });
        await loadSalesBoard(0); break;
      case 'lead': state.lead = value; await refresh(); break;
      case 'admin-tab': state.adminTab = Number(value); state.overviewDetail = null; state.accountAction = null; state.recovery = null; message(''); await refresh(); break;
      case 'all-client-data': state.adminData[3] = { type: 'customers', period: 'all' }; state.adminTab = 3; message(''); await refresh(); break;
      case 'copy-promo-code': {
        const code = state.view?.actor.role === 'broker' && state.view.broker?.code;
        if (!code) break;
        try { await navigator.clipboard.writeText(code); message('已复制推广码'); }
        catch { message(code); }
        break;
      }
      case 'share': await copyLink(value); break;
    }
  } catch (error) { handleError(error); }
});

const forms = {
  company: ['/companies', '已保存公司配置，仅影响后续新留资'], assignment: ['/assignments', '已保存留资分派'],
  'channel-owner': ['/channels/owner', '已更新渠道合作负责人'],
  cooperation: ['/cooperations', '已保存合作签约与销售绑定'], account: ['/accounts', '券商账号已开通'],
  'sales-account': ['/accounts/sales', '销售账号已开通'], name: ['/profile/name', '已保存显示名称'],
  lead: ['/leads', '已提交，可在「我的」查看记录'],
  reassign: ['/reassign', '已保存客户归属'],
  signing: ['/signings', '已保存客户实际签约'], case: ['/cases', '已保存案件状态'],
};

document.addEventListener('input', event => {
  if (event.target.closest('form')?.dataset.form === 'broker-board-search' && event.target.name === 'q') {
    state.salesBoard.searchDraft = event.target.value;
  }
});

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
  if (kind === 'lead') {
    if (consultationSubmission === revision) return;
    consultationSubmission = revision;
  }
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const queries = { 'assignment-query': 'assignmentFilters', 'case-query': 'caseFilters', 'sales-query': 'salesFilters', 'channel-query': 'channelFilters' };
    if (kind === 'broker-board-search') {
      if (state.view?.actor.role !== 'broker' || state.page !== 'home') return;
      const q = String(input.q || '').trim().slice(0, 100);
      Object.assign(state.salesBoard, { q, searchDraft: q, offset: 0, detailsExpanded: true });
      await loadSalesBoard(0); return;
    }
    if (kind === 'sales-board-dates') {
      const board = state.salesBoard;
      board.from = input.from; board.to = input.to;
      if (!board.from || !board.to) { board.dateError = '请选择起止日期'; render(); return; }
      const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      if (!validDate(board.from) || !validDate(board.to)) { board.dateError = '请选择有效的日期'; render(); return; }
      if (board.from > board.to) { board.dateError = '开始日期须早于或等于结束日期'; render(); return; }
      if (state.view.today && board.to > state.view.today) { board.dateError = '日期不能晚于今天'; render(); return; }
      Object.assign(board, { period: 'custom', rangeFrom: board.from, rangeTo: board.to, offset: 0, dateError: '', detailsExpanded: true });
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
  finally {
    if (kind === 'auth') state.authBusy = false;
    if (kind === 'lead' && consultationSubmission === revision) consultationSubmission = null;
    if (submit) submit.disabled = false;
  }
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
