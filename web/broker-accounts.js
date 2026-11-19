const mountedPanels = new WeakMap();
const pageSize = 20;
const statuses = [['', '全部状态'], ['pending', '待开户'], ['active', '已开户'], ['closed', '已注销']];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

function normalizeFilters(filters = {}) {
  const offset = Number(filters.offset);
  return {
    q: String(filters.q ?? '').trim().slice(0, 100),
    status: statuses.some(([status]) => status === filters.status) ? filters.status : '',
    offset: Number.isSafeInteger(offset) && offset >= 0 ? Math.floor(offset / pageSize) * pageSize : 0,
  };
}

export function renderBrokerAccounts(filters = {}) {
  const selected = normalizeFilters(filters);
  return `<section class="panel broker-accounts" data-broker-accounts data-broker-q="${escapeHtml(selected.q)}" data-broker-status="${escapeHtml(selected.status)}" data-broker-offset="${selected.offset}">
    <h2>券商合作与开户</h2>
    <form class="broker-search-form" data-broker-query role="search" aria-label="搜索券商合作与开户记录">
      <label class="field"><span>券商名称、账号或合作负责人</span><input type="search" name="q" maxlength="100" value="${escapeHtml(selected.q)}" placeholder="输入名称、账号或负责人" autocomplete="off"></label>
      <label class="field"><span>开户状态</span><select name="status">${statuses.map(([value, label]) => `<option value="${value}"${value === selected.status ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <div class="broker-search-actions"><button class="primary" type="submit">搜索券商</button><button class="secondary" type="button" data-broker-reset>重置</button></div>
    </form>
    <div class="broker-list-meta"><p data-broker-summary role="status" aria-live="polite">正在加载券商…</p><p class="muted" data-broker-order>排序：待开户在前，正常账号其次，已注销在后；同组按名称排序，每页 20 家。</p></div>
    <div class="broker-status-counts" data-broker-counts aria-label="券商账号状态统计"></div>
    <div class="broker-load-error" data-broker-error role="alert" hidden></div>
    <div class="broker-account-list" data-broker-list aria-busy="true"></div>
    <nav class="broker-pagination" data-broker-pagination aria-label="券商列表分页" hidden>
      <button class="secondary" type="button" data-broker-page="previous" disabled>上一页</button>
      <span data-broker-page-label></span>
      <button class="secondary" type="button" data-broker-page="next" disabled>下一页</button>
    </nav>
    <button class="secondary broker-retry" type="button" data-broker-retry hidden>重新加载</button>
  </section>`;
}

function statusOf(item) {
  if (!item.username) return 'pending';
  return item.accountStatus === 'closed' ? 'closed' : 'active';
}

function salesName(item) {
  return item.salesName && item.salesName !== item.salesId ? item.salesName : '未登记姓名';
}

function renderItems(items) {
  if (!items.length) return '<div class="empty">没有符合条件的券商</div>';
  return items.map((item, index) => {
    const status = statusOf(item);
    const label = statuses.find(([value]) => value === status)[1];
    return `<details class="broker-account-row broker-account-${status}" data-broker-row data-broker-index="${index}">
      <summary><span class="broker-summary-main"><strong>${escapeHtml(item.name)}</strong>${status === 'pending' ? `<small>合作负责人 ${escapeHtml(salesName(item))}</small>` : ''}</span>
      <span class="broker-summary-end"><span class="tag">${label}</span><span class="broker-expand-label">${status === 'pending' ? '展开开户' : '查看资料'}</span></span></summary>
      <div class="broker-account-detail" data-broker-detail></div>
    </details>`;
  }).join('');
}

function renderDetail(item, initialPasswordHint) {
  const pending = statusOf(item) === 'pending';
  return `<dl class="broker-account-facts"><div><dt>合作负责人</dt><dd>${escapeHtml(salesName(item))}</dd></div>
    <div><dt>签约日期</dt><dd>${escapeHtml(item.signedOn || '未登记')}</dd></div>
    ${pending ? '' : `<div><dt>登录账号</dt><dd>${escapeHtml(item.username)}</dd></div>`}</dl>
    ${pending ? `<form data-broker-open class="broker-open-form">
      <input type="hidden" name="brokerId" value="${escapeHtml(item.id)}">
      <label class="field"><span>专用账号</span><input name="username" minlength="3" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{2,39}" title="3 到 40 位字母、数字或 . _ -" autocomplete="off" required></label>
      <p class="muted">${escapeHtml(initialPasswordHint)}</p>
      <button class="primary" type="submit">开通账号</button>
      <p class="broker-open-error" data-broker-open-error role="alert" hidden></p>
    </form>` : ''}`;
}

export function mountBrokerAccounts(root, { request, onError, onState, onChanged, onNotice, initialPasswordHint = '' } = {}) {
  const panel = root?.matches?.('[data-broker-accounts]') ? root : root?.querySelector?.('[data-broker-accounts]');
  if (!panel) return null;
  if (mountedPanels.has(panel)) return mountedPanels.get(panel);
  if (typeof request !== 'function') throw new TypeError('mountBrokerAccounts requires a request function');

  const queryForm = panel.querySelector('[data-broker-query]');
  const list = panel.querySelector('[data-broker-list]');
  const summary = panel.querySelector('[data-broker-summary]');
  const counts = panel.querySelector('[data-broker-counts]');
  const errorBox = panel.querySelector('[data-broker-error]');
  const pagination = panel.querySelector('[data-broker-pagination]');
  const pageLabel = panel.querySelector('[data-broker-page-label]');
  const previous = panel.querySelector('[data-broker-page="previous"]');
  const next = panel.querySelector('[data-broker-page="next"]');
  const retry = panel.querySelector('[data-broker-retry]');
  let filters = normalizeFilters({ q: panel.dataset.brokerQ, status: panel.dataset.brokerStatus, offset: panel.dataset.brokerOffset });
  let items = [];
  let generation = 0;
  let controller;
  let disposed = false;
  let opening = false;
  let loading = false;
  let pageInfo = { total: 0, offset: filters.offset, hasMore: false };
  const connected = () => !disposed && panel.isConnected && (root === panel || root.contains(panel));
  const current = ticket => connected() && ticket === generation;
  const setQueryDisabled = disabled => {
    queryForm.querySelectorAll('input,select,button').forEach(control => { control.disabled = disabled; });
    previous.disabled = disabled || loading || pageInfo.offset === 0;
    next.disabled = disabled || loading || !pageInfo.hasMore;
  };

  async function load(nextFilters = filters) {
    if (!connected() || opening) return;
    controller?.abort();
    controller = new AbortController();
    const ticket = ++generation;
    filters = normalizeFilters(nextFilters);
    queryForm.elements.q.value = filters.q;
    queryForm.elements.status.value = filters.status;
    onState?.({ ...filters });
    loading = true;
    list.setAttribute('aria-busy', 'true');
    list.innerHTML = '';
    items = [];
    counts.textContent = '';
    summary.textContent = '正在加载券商…';
    errorBox.hidden = true;
    retry.hidden = true;
    pagination.hidden = true;
    previous.disabled = true;
    next.disabled = true;
    try {
      const data = await request(`/brokers/search?${new URLSearchParams(filters)}`, undefined, controller.signal);
      if (!current(ticket)) return;
      const total = Math.max(0, Number(data.total) || 0);
      const offset = Math.max(0, Number(data.offset) || 0);
      if (total > 0 && offset >= total) return await load({ ...filters, offset: Math.floor((total - 1) / pageSize) * pageSize });
      items = Array.isArray(data.items) ? data.items.slice(0, pageSize) : [];
      pageInfo = { total, offset, hasMore: Boolean(data.hasMore) };
      filters.offset = offset;
      onState?.({ ...filters });
      list.innerHTML = renderItems(items);
      const first = items.length ? offset + 1 : 0;
      const last = items.length ? offset + items.length : 0;
      summary.textContent = `共 ${total} 家券商${total ? `，当前显示 ${first}–${last} 家` : ''}`;
      const order = panel.querySelector('[data-broker-order]');
      if (order && data.orderLabel) order.textContent = `排序：${data.orderLabel} 每页 20 家。`;
      counts.innerHTML = ['pending', 'active', 'closed'].map(status => `<span>${statuses.find(([value]) => value === status)[1]} <strong>${escapeHtml(Math.max(0, Number(data.counts?.[status]) || 0))}</strong></span>`).join('');
      pageLabel.textContent = `第 ${total ? Math.floor(offset / pageSize) + 1 : 1} / ${Math.max(1, Math.ceil(total / pageSize))} 页`;
      pagination.hidden = total <= pageSize;
    } catch (error) {
      if (!current(ticket) || error.name === 'AbortError') return;
      summary.textContent = '券商列表暂未加载';
      errorBox.textContent = error.message || '加载失败，请重试';
      errorBox.hidden = false;
      retry.hidden = false;
      onError?.(error);
    } finally {
      if (current(ticket)) {
        loading = false;
        list.setAttribute('aria-busy', 'false');
        setQueryDisabled(false);
      }
    }
  }

  async function openAccount(form) {
    if (!connected() || loading || opening || !form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    const row = items.find(item => item.id === values.brokerId);
    if (!row || statusOf(row) !== 'pending') return;
    const localError = form.querySelector('[data-broker-open-error]');
    const submit = form.querySelector('button[type="submit"]');
    opening = true;
    setQueryDisabled(true);
    localError.hidden = true;
    submit.disabled = true;
    submit.textContent = '正在开户…';
    try {
      await request('/accounts', { brokerId: row.id, username: values.username });
      if (!connected()) return;
      // Stop any list response from repainting while the parent replaces its view.
      controller?.abort();
      generation += 1;
      if (onChanged) await onChanged();
      else { opening = false; await load(filters); }
      onNotice?.(`券商账号已开通。${initialPasswordHint}`);
    } catch (error) {
      if (!connected()) return;
      if (form.isConnected) {
        localError.textContent = error.message || '开户失败，请重试';
        localError.hidden = false;
      }
      onError?.(error);
    } finally {
      opening = false;
      if (connected()) {
        setQueryDisabled(false);
        if (form.isConnected) {
          submit.disabled = false;
          submit.textContent = '开通账号';
        }
      }
    }
  }

  function submitHandler(event) {
    const form = event.target;
    if (form === queryForm) {
      event.preventDefault();
      event.stopPropagation();
      if (!opening) void load({ q: queryForm.elements.q.value, status: queryForm.elements.status.value, offset: 0 });
    } else if (form.matches?.('[data-broker-open]')) {
      event.preventDefault();
      event.stopPropagation();
      void openAccount(form);
    }
  }

  function clickHandler(event) {
    const button = event.target.closest('button');
    if (!button || !panel.contains(button) || opening) return;
    if (button.hasAttribute('data-broker-reset')) void load({ q: '', status: '', offset: 0 });
    else if (button.hasAttribute('data-broker-retry')) void load(filters);
    else if (button.hasAttribute('data-broker-page') && !loading && !button.disabled) {
      const offset = pageInfo.offset + (button.dataset.brokerPage === 'previous' ? -pageSize : pageSize);
      void load({ ...filters, offset });
    }
  }

  function toggleHandler(event) {
    const details = event.target;
    if (!connected() || !details.matches?.('[data-broker-row]') || !details.open || details.dataset.brokerLoaded) return;
    const item = items[Number(details.dataset.brokerIndex)];
    if (!item) return;
    details.querySelector('[data-broker-detail]').innerHTML = renderDetail(item, initialPasswordHint);
    details.dataset.brokerLoaded = 'true';
  }

  panel.addEventListener('submit', submitHandler);
  panel.addEventListener('click', clickHandler);
  panel.addEventListener('toggle', toggleHandler, true);
  const mounted = {
    refresh: () => load(filters),
    dispose() {
      disposed = true;
      generation += 1;
      controller?.abort();
      panel.removeEventListener('submit', submitHandler);
      panel.removeEventListener('click', clickHandler);
      panel.removeEventListener('toggle', toggleHandler, true);
      mountedPanels.delete(panel);
    },
  };
  mountedPanels.set(panel, mounted);
  void load(filters);
  return mounted;
}
