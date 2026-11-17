const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const pickers = new WeakMap();
const recordLists = new WeakMap();

export function renderClientPicker(scope) {
  return `<div class="client-picker" data-client-picker="${scope}">
    <label class="field"><span>客户</span><input type="search" data-client-query maxlength="100" autocomplete="off" placeholder="输入客户姓名，可用手机号进一步查找"
      role="combobox" aria-autocomplete="list" aria-controls="client-results-${scope}" aria-expanded="false" aria-describedby="client-hint-${scope}" required></label>
    <input type="hidden" name="clientId"><p id="client-hint-${scope}" class="muted" data-client-status role="status" aria-live="polite">输入姓名开始检索，再点击对应客户确认。</p>
    <div id="client-results-${scope}" role="listbox" aria-label="匹配客户" class="client-results" data-client-results></div>
    <button type="button" data-client-more class="secondary" hidden>显示更多匹配客户</button>
    <div class="client-selection" data-client-selection hidden></div><button type="button" data-client-clear class="quiet" hidden>重新搜索客户</button>
  </div>`;
}

export function renderClientRecords({ q = '', offset = 0 } = {}) {
  return `<section class="panel" data-client-records data-offset="${Number(offset) || 0}"><h2>客户记录</h2>
    <form data-client-records-query class="inline-form"><label class="field"><span>查找客户</span>
    <input type="search" name="q" value="${safe(q)}" maxlength="100" placeholder="输入股票名称或代码、客户姓名、券商、手机号" autocomplete="off"></label>
    <button class="secondary">搜索客户</button><button type="button" class="quiet" data-records-reset>重置</button></form>
    <p class="muted">可检索首次或当前券商。同一客户的多条股票线索合并展示。</p>
    <p class="muted" data-records-status role="status" aria-live="polite">正在加载客户记录…</p><div data-records-table></div>
    <div class="list-pagination"><button type="button" class="secondary" data-records-prev disabled>上一页</button>
      <span data-records-page></span><button type="button" class="secondary" data-records-next disabled>下一页</button></div>
  </section>`;
}

export function installClientSearch({ search, onError, onRecordsState }) {
  function pickerState(node) {
    if (!pickers.has(node)) pickers.set(node, { query: '', items: [], total: 0, hasMore: false, selected: null, index: -1, serial: 0, composing: false, busy: false });
    return pickers.get(node);
  }
  const queryInput = node => node.querySelector('[data-client-query]');
  const pickerStatus = (node, text) => { node.querySelector('[data-client-status]').textContent = text; };
  function renderOptions(node, state) {
    node.querySelector('[data-client-results]').innerHTML = state.items.map((client, index) =>
      `<button type="button" role="option" aria-selected="false" id="${node.dataset.clientPicker}-client-${index}" data-client-choice="${index}" class="client-choice">
        <strong>${safe(client.name || '尚未留资')}</strong><span>手机 ${safe(client.phone || '尚未留资')} · 当前券商 ${safe(client.brokerName || '自然流入')}</span>
        ${client.account ? `<small>登录账号 ${safe(client.account)}</small>` : ''}</button>`).join('');
    node.querySelector('[data-client-more]').hidden = !state.hasMore;
    node.querySelector('[data-client-more]').disabled = state.busy;
    queryInput(node).setAttribute('aria-expanded', String(Boolean(state.items.length)));
    queryInput(node).removeAttribute('aria-activedescendant');
    state.index = -1;
  }
  function clearSelection(node, state) {
    state.selected = null;
    node.querySelector('[name=clientId]').value = '';
    node.querySelector('[data-client-selection]').hidden = true;
    node.querySelector('[data-client-selection]').textContent = '';
    node.querySelector('[data-client-clear]').hidden = true;
    queryInput(node).setCustomValidity('');
  }
  async function loadPicker(node, offset = 0) {
    const state = pickerState(node);
    if (!node.isConnected || !state.query) return;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const serial = ++state.serial;
    state.busy = true;
    node.querySelector('[data-client-more]').disabled = true;
    pickerStatus(node, '正在检索客户…');
    try {
      const response = await search({ scope: node.dataset.clientPicker, q: state.query, offset }, controller.signal);
      if (!node.isConnected || serial !== state.serial) return;
      state.items = offset ? [...state.items, ...response.items] : response.items;
      state.total = response.total;
      state.hasMore = response.hasMore;
      state.busy = false;
      renderOptions(node, state);
      pickerStatus(node, response.total ? `找到 ${response.total} 位客户，已显示 ${state.items.length} 位。请核对信息后点击确认。` : '未找到符合条件的客户，请核对姓名或手机号。');
    } catch (error) {
      if (error.name === 'AbortError' || !node.isConnected || serial !== state.serial) return;
      state.busy = false;
      pickerStatus(node, `检索失败：${error.message}。请重新输入后重试。`);
      node.querySelector('[data-client-more]').disabled = false;
      if (error.status === 401) onError(error);
    }
  }
  function schedule(node) {
    const state = pickerState(node);
    clearTimeout(state.timer);
    state.controller?.abort();
    ++state.serial;
    clearSelection(node, state);
    state.query = queryInput(node).value.trim();
    state.items = [];
    state.hasMore = false;
    state.busy = false;
    renderOptions(node, state);
    pickerStatus(node, state.query ? '输入完成后将自动检索…' : '输入姓名开始检索，再点击对应客户确认。');
    if (state.query && !state.composing) state.timer = setTimeout(() => loadPicker(node), 220);
  }
  function choose(node, index) {
    const state = pickerState(node);
    const client = state.items[index];
    if (!client || state.busy) return;
    clearTimeout(state.timer);
    state.controller?.abort();
    ++state.serial;
    state.selected = client;
    queryInput(node).value = client.name || client.account || client.phone;
    state.selectedText = queryInput(node).value;
    queryInput(node).setCustomValidity('');
    node.querySelector('[name=clientId]').value = client.id;
    const selection = node.querySelector('[data-client-selection]');
    selection.innerHTML = `<strong>已选客户：${safe(client.name || '尚未留资')}</strong><span>手机 ${safe(client.phone || '尚未留资')} · 当前券商 ${safe(client.brokerName || '自然流入')}</span>${client.account ? `<small>登录账号 ${safe(client.account)}</small>` : ''}`;
    selection.hidden = false;
    node.querySelector('[data-client-clear]').hidden = false;
    state.items = [];
    state.hasMore = false;
    renderOptions(node, state);
    pickerStatus(node, '已确认客户，可继续填写并保存。修改搜索内容会取消本次选择。');
    queryInput(node).focus();
  }
  document.addEventListener('input', event => {
    if (event.target.matches('[data-client-query]')) schedule(event.target.closest('[data-client-picker]'));
  });
  document.addEventListener('compositionstart', event => {
    if (!event.target.matches('[data-client-query]')) return;
    const node = event.target.closest('[data-client-picker]');
    pickerState(node).composing = true;
    schedule(node);
  });
  document.addEventListener('compositionend', event => {
    if (!event.target.matches('[data-client-query]')) return;
    const node = event.target.closest('[data-client-picker]');
    pickerState(node).composing = false;
    schedule(node);
  });
  document.addEventListener('keydown', event => {
    if (!event.target.matches('[data-client-query]')) return;
    const node = event.target.closest('[data-client-picker]');
    const state = pickerState(node);
    if (event.isComposing || state.composing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (state.index >= 0) choose(node, state.index);
      else if (!state.selected) { clearTimeout(state.timer); loadPicker(node); }
    }
    if (event.key === 'Escape') {
      clearTimeout(state.timer);
      state.controller?.abort();
      ++state.serial;
      state.busy = false;
      state.items = []; state.hasMore = false; renderOptions(node, state);
      pickerStatus(node, '已收起搜索结果，可重新输入姓名或按回车检索。');
    }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && state.items.length) {
      event.preventDefault();
      state.index = (state.index + (event.key === 'ArrowDown' ? 1 : state.index < 0 ? 0 : -1) + state.items.length) % state.items.length;
      node.querySelectorAll('[data-client-choice]').forEach((item, index) => item.setAttribute('aria-selected', String(index === state.index)));
      const option = node.querySelector(`[data-client-choice="${state.index}"]`);
      queryInput(node).setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    }
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    const node = button?.closest('[data-client-picker]');
    if (node) {
      if (button.hasAttribute('data-client-choice')) choose(node, Number(button.dataset.clientChoice));
      if (button.hasAttribute('data-client-more')) loadPicker(node, pickerState(node).items.length);
      if (button.hasAttribute('data-client-clear')) { queryInput(node).value = ''; schedule(node); queryInput(node).focus(); }
    }
  });

  function renderRows(node, response) {
    node.querySelector('[data-records-table]').innerHTML = response.items.length ? `<div class="table-wrap"><table><thead><tr>
      <th>客户</th><th>手机号</th><th>股票线索</th><th>首次券商</th><th>当前券商</th><th>客户签约</th></tr></thead><tbody>${response.items.map(client =>
      `<tr><td>${safe(client.name || '尚未留资')}${client.account ? `<small>登录账号 ${safe(client.account)}</small>` : ''}</td><td>${safe(client.phone || '—')}</td>
      <td class="client-stock-cell">${client.stocks.length ? client.stocks.map(stock => `<div>${safe(stock.stockName)} · ${safe(stock.stockCode)}${stock.leadCount > 1 ? `<small>${stock.leadCount} 条留资</small>` : ''}</div>`).join('') : '暂无股票线索'}</td>
      <td>${safe(client.firstBrokerName || '—')}</td><td>${safe(client.brokerName || '—')}</td><td>${safe(client.signedOn || '未签约')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">未找到匹配的客户</div>';
    node.querySelector('[data-records-status]').textContent = `共 ${response.total} 位客户${response.total ? `，当前显示第 ${response.offset + 1}–${response.offset + response.items.length} 位` : ''}。`;
    node.querySelector('[data-records-page]').textContent = response.total ? `第 ${Math.floor(response.offset / response.limit) + 1} / ${Math.ceil(response.total / response.limit)} 页` : '暂无记录';
    node.querySelector('[data-records-prev]').disabled = !response.offset;
    node.querySelector('[data-records-next]').disabled = !response.hasMore;
  }
  async function loadRecords(node, offset = 0, query) {
    const state = recordLists.get(node);
    if (!state || !node.isConnected) return;
    state.controller?.abort();
    state.controller = new AbortController();
    const serial = ++state.serial;
    state.query = query === undefined ? state.query : query;
    state.offset = offset;
    onRecordsState({ q: state.query, offset });
    node.querySelector('[data-records-status]').textContent = '正在检索客户记录…';
    node.querySelector('[data-records-table]').textContent = '';
    node.querySelector('[data-records-prev]').disabled = true;
    node.querySelector('[data-records-next]').disabled = true;
    try {
      const response = await search({ scope: 'records', q: state.query, offset }, state.controller.signal);
      if (!node.isConnected || state.serial !== serial) return;
      if (offset && offset >= response.total) return loadRecords(node, Math.max(0, Math.ceil(response.total / response.limit) - 1) * response.limit);
      renderRows(node, response);
    } catch (error) {
      if (error.name === 'AbortError' || !node.isConnected || state.serial !== serial) return;
      node.querySelector('[data-records-status]').textContent = `加载失败：${error.message}。请点击搜索客户重试。`;
      if (error.status === 401) onError(error);
    }
  }
  document.addEventListener('submit', event => {
    if (!event.target.matches('[data-client-records-query]')) return;
    event.preventDefault();
    const node = event.target.closest('[data-client-records]');
    loadRecords(node, 0, event.target.elements.q.value.trim());
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    const node = button?.closest('[data-client-records]');
    if (!node || !recordLists.has(node)) return;
    const state = recordLists.get(node);
    if (button.hasAttribute('data-records-reset')) {
      node.querySelector('[name=q]').value = '';
      loadRecords(node, 0, '');
    }
    if (button.hasAttribute('data-records-next')) loadRecords(node, state.offset + 20);
    if (button.hasAttribute('data-records-prev')) loadRecords(node, Math.max(0, state.offset - 20));
  });
  return {
    mount(root) {
      for (const node of root.querySelectorAll('[data-client-records]')) {
        if (recordLists.has(node)) continue;
        recordLists.set(node, { query: node.querySelector('[name=q]').value, offset: Number(node.dataset.offset) || 0, serial: 0 });
        loadRecords(node, Number(node.dataset.offset) || 0);
      }
    },
    validate(form) {
      const node = form.querySelector('[data-client-picker]');
      if (!node) return true;
      const state = pickerState(node);
      const input = queryInput(node);
      const valid = state.selected && state.selected.id === form.elements.clientId.value && input.value === state.selectedText && !state.composing;
      if (!valid) { clearSelection(node, state); input.setCustomValidity('请从搜索结果中确认一位客户后再保存。'); input.reportValidity(); }
      return Boolean(valid);
    },
  };
}
