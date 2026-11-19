const panels = new WeakMap();
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const show = value => escape(value || '—');
const typeLabels = { sales: '销售', investor: '股民' };
const button = (action, label, attrs = '', primary = false) => `<button type="button" class="${primary ? 'primary' : 'secondary'}" data-registry-action="${action}" ${attrs}>${escape(label)}</button>`;
const accountName = item => `${item.name || '未登记姓名'}（${item.username}）`;

function pagination(data, key) {
  if (data.total <= data.limit) return '';
  const offset = data.offset, limit = data.limit;
  return `<nav class="list-pagination" aria-label="${key === 'page' ? '登记资料' : '账号'}分页">
    ${button(key, '上一页', `data-offset="${Math.max(0, offset - limit)}"${offset === 0 ? ' disabled' : ''}`)}
    <span>第 ${Math.floor(offset / limit) + 1} / ${Math.ceil(data.total / limit)} 页</span>
    ${button(key, '下一页', `data-offset="${offset + limit}"${offset + limit >= data.total ? ' disabled' : ''}`)}</nav>`;
}

export function renderRegistryPanel({ admin = false } = {}) {
  return `<section class="panel" data-registry-panel data-admin="${admin ? 'true' : 'false'}">
    <h2>${admin ? '股民登记台账' : '我的登记资料'}</h2>
    ${admin ? `<p data-registry-source class="muted"></p>${button('sync', '从本地表格更新')}
      <details class="admin-record" data-sales-batch><summary>按销售姓名批量开户</summary>
        <div data-batch-body aria-live="polite"></div></details>` : ''}
    <form data-registry-query class="inline-form" role="search"><label class="field"><span>检索登记资料</span>
      <input type="search" name="q" maxlength="100" placeholder="股民、股票名称或代码、销售" autocomplete="off"></label>
      <button class="primary">搜索</button>${button('reset', '重置')}</form>
    <p data-registry-notice role="status" aria-live="polite"></p><div data-registry-edit></div>
    <p data-registry-count class="muted" aria-live="polite"></p><div data-registry-results></div></section>`;
}

const batchStatus = { create: '新开账号', reuse: '关联已有账号', linked: '已关联', review: '待人工核对' };
const batchButton = (key, label) => `<button type="button" class="secondary" data-batch-action="${key}">${label}</button>`;

function batchTable(rows) {
  if (!rows.length) return '';
  return `<div class="table-wrap"><table><thead><tr><th>销售</th><th>表内销售标记</th><th>登记条数</th><th>处理方式</th></tr></thead>
    <tbody>${rows.map(row => `<tr><td>${show(row.name)}</td><td>${show(row.labels.join('、'))}</td>
      <td>${escape(row.recordCount)}</td><td>${show(batchStatus[row.status])}${row.reason ? `<small>${escape(row.reason)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function mountSalesBatch(details, request, refresh, onError, initialPasswordHint) {
  const body = details.querySelector('[data-batch-body]');
  let token = '', busy = false, created = [];
  async function run(commit) {
    if (busy) return;
    busy = true;
    body.inert = true;
    body.setAttribute('aria-busy', 'true');
    try {
      if (!commit) {
        const plan = await request('/registry/sales-batch');
        if (!details.isConnected) return;
        token = plan.token;
        const count = status => plan.rows.filter(row => row.status === status).length;
        body.innerHTML = plan.rows.length ? `<p>待新开 ${count('create')} 个，关联已有账号 ${count('reuse')} 个，已关联 ${count('linked')} 个，待核对 ${count('review')} 个。</p>
          <p>同一销售名的带星和无星登记归入同一账号。${escape(initialPasswordHint)}</p>
          <p class="muted" data-order-label>排序：${escape(plan.orderLabel || '待新开、待关联、待核对、已关联；同组按姓名，待核对组内注销账号在后。')}</p>
          ${batchTable(plan.rows)}${count('create') || count('reuse') ? batchButton('commit', '确认开户并关联') : ''} ${batchButton('preview', '刷新预览')}` :
          `<p>台账中暂无销售登记。</p>${batchButton('preview', '刷新预览')}`;
      } else {
        const result = await request('/registry/sales-batch', { token, confirmed: true });
        if (!details.isConnected) return;
        token = '';
        created = result.created;
        body.innerHTML = `<p>本次新开 ${created.length} 个销售账号，新关联 ${escape(result.linkedRecords)} 条登记。</p>
          ${created.length ? `<p>${escape(initialPasswordHint)}可保存本次新开户的销售名单。</p>${batchButton('download', '保存新账号清单')}` : ''}
          ${result.review.length ? `<h3>待人工核对</h3>${batchTable(result.review)}` : ''}`;
        await refresh();
      }
    } catch (error) {
      if (!details.isConnected) return;
      token = '';
      body.innerHTML = `<p role="alert">${escape(error.message || '请求失败')}</p>${batchButton('preview', '重新预览')}`;
      if (error.status === 401) onError?.(error);
    } finally {
      busy = false;
      body.inert = false;
      body.removeAttribute('aria-busy');
    }
  }
  details.addEventListener('toggle', () => {
    if (details.open && !body.childElementCount) void run(false);
  });
  details.addEventListener('click', event => {
    const action = event.target.closest('button[data-batch-action]')?.dataset.batchAction;
    if (action === 'preview') void run(false);
    if (action === 'commit' && token) void run(true);
    if (action === 'download' && created.length) {
      const lines = ['销售姓名\t登录账号\t初始密码\t登记条数', ...created.map(row =>
        [row.name, row.username, row.password, row.recordCount].join('\t'))];
      const file = new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(file);
      link.download = '销售账号与初始密码.txt';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
  });
}

function displayRows(items, admin) {
  if (!items.length) return '<div class="empty">没有符合条件的登记资料</div>';
  if (!admin) return `<div class="records">${items.map(row => `<article class="record"><div class="record-main">
    <strong>${show(row.customer)} · ${show(row.stockName)} ${show(row.stockCode)}</strong>
    <p>销售 ${show(row.sales)} · 进度 ${show(row.stage)}</p>
    <p>材料登记 ${show(row.registeredOn)} · 立案 ${show(row.filedOn)}</p>
    ${row.phone ? `<p>联系电话 ${escape(row.phone)}</p>` : ''}
    ${row.source ? `<p>客户来源 ${escape(row.source)}</p>` : ''}</div></article>`).join('')}</div>`;
  const binding = (row, type, i) => {
    const link = type === 'sales' ? row.salesLink : row.investorLink;
    if (!link && type === 'investor' && !/^1\d{10}$/.test(row.phone || '')) return '<td>缺少可核对的合同手机号</td>';
    if (!link && type === 'sales' && !row.sales) return '<td>未登记销售</td>';
    return `<td><span>${link ? escape(accountName(link)) : '未关联'}</span><small>${button('edit', link ? '管理关联' : '关联账号',
      `data-row="${i}" data-type="${type}" aria-label="${escape((link ? '管理' : '关联') + typeLabels[type] + '账号')}"`)}</small></td>`;
  };
  return `<div class="table-wrap"><table><thead><tr>${['表内行号', '股民 / 联系电话', '股票 / 代码', '销售', '客户来源', '材料登记', '立案日期', '案件进度', '销售账号', '股民账号']
    .map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${items.map((row, i) => `<tr>
    <td>${show(row.sourceRow)}</td><td>${show(row.customer)}<small>${show(row.phone)}</small></td>
    <td>${show(row.stockName)}<small>${show(row.stockCode)}</small></td><td>${show(row.sales)}</td><td>${show(row.source)}</td>
    <td>${show(row.registeredOn)}</td><td>${show(row.filedOn)}</td><td><span class="wrap-cell">${show(row.stage)}</span></td>
    ${binding(row, 'sales', i)}${binding(row, 'investor', i)}</tr>`).join('')}</tbody></table></div>`;
}

export function mountRegistryPanel(root, { request, onError, admin = false, initialPasswordHint } = {}) {
  const panel = root?.matches?.('[data-registry-panel]') ? root : root?.querySelector?.('[data-registry-panel]');
  if (!panel) return null;
  if (panels.has(panel)) return panels.get(panel);
  const canManage = admin && panel.dataset.admin === 'true';
  const find = s => panel.querySelector(s);
  const query = find('[data-registry-query]'), count = find('[data-registry-count]');
  const results = find('[data-registry-results]'), editor = find('[data-registry-edit]'), notice = find('[data-registry-notice]');
  let listController, candidateController, list, q = '', edit = null, writing = false, disposed = false;
  const connected = () => panel.isConnected && !disposed;
  const tell = (text, error = false) => {
    notice.textContent = text;
    notice.setAttribute('role', error ? 'alert' : 'status');
  };
  function fail(error) {
    tell(error.message || '操作失败，请重试。', true);
    if (error.status === 401) onError?.(error);
  }
  function closeEditor() {
    candidateController?.abort();
    edit = null;
    editor.replaceChildren();
  }
  async function load(search = q, offset = 0) {
    if (writing || !connected()) return;
    closeEditor();
    listController?.abort();
    const controller = listController = new AbortController();
    q = search.trim();
    list = null;
    results.replaceChildren();
    count.textContent = '正在查询…';
    try {
      const data = await request('/registry?' + new URLSearchParams({ q, offset }), undefined, controller.signal);
      if (!connected() || controller.signal.aborted) return;
      if (data.total > 0 && data.offset >= data.total) return load(q, Math.floor((data.total - 1) / data.limit) * data.limit);
      list = data;
      if (canManage) {
        const imported = data.importedAt ? new Date(data.importedAt) : null;
        find('[data-registry-source]').textContent = [data.sourceName, imported && Number.isFinite(imported.valueOf()) ?
          '上次导入 ' + imported.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未导入'].filter(Boolean).join(' · ');
      }
      count.textContent = `共 ${data.total} 条登记资料`;
      results.innerHTML = `<p class="muted" data-order-label>排序：${escape(data.orderLabel || '按材料登记日期从新到旧，缺少日期的记录在最后。')}</p>` + displayRows(data.items, canManage) + pagination(data, 'page');
    } catch (error) {
      if (!connected() || controller.signal.aborted) return;
      count.textContent = '登记资料未加载';
      results.innerHTML = button('retry', '重新加载');
      fail(error);
    }
  }
  function confirmation() {
    const box = find('[data-registry-confirmation]');
    if (!box || !edit?.meta) return;
    const { meta, selected, type } = edit;
    const target = meta.currentLink || selected;
    if (!target) { box.replaceChildren(); return; }
    const action = meta.currentLink ? '解除关联' : '关联账号';
    box.innerHTML = `<div class="admin-record"><h3>核对${typeLabels[type]}账号</h3>
      <p>表内${typeLabels[type]}：${show(meta.sourceLabel)} · 影响 ${escape(meta.affectedCount)} 条登记资料</p>
      <p>目标账号：${escape(accountName(target))}</p>
      <form data-registry-commit class="form-grid"><label class="check"><input type="checkbox" name="confirmed" required>
      我已核对身份，确认${meta.currentLink ? '撤销该账号查看以上资料的权限' : '允许此账号查看以上资料'}</label>
      <button class="primary">${action}</button></form></div>`;
  }
  async function candidates(text = '', offset = 0) {
    if (!edit || !canManage || writing) return;
    const selection = edit;
    candidateController?.abort();
    const controller = candidateController = new AbortController();
    selection.q = text.trim();
    selection.meta = null;
    selection.selected = null;
    const answer = find('[data-registry-options]');
    find('[data-registry-confirmation]').replaceChildren();
    answer.textContent = '正在查询…';
    try {
      const params = { type: selection.type, entryKey: selection.row.entryKey, q: selection.q, offset };
      const data = await request('/registry/candidates?' + new URLSearchParams(params), undefined, controller.signal);
      if (!connected() || controller.signal.aborted || edit !== selection) return;
      selection.meta = data;
      const searchForm = find('[data-registry-candidate-query]');
      searchForm.classList.toggle('inline-form', !data.currentLink);
      searchForm.hidden = Boolean(data.currentLink);
      const group = `<p>表内${typeLabels[selection.type]}：${show(data.sourceLabel)} · 影响 ${escape(data.affectedCount)} 条登记资料</p>`;
      if (data.currentLink) answer.innerHTML = '';
      else if (!selection.q) answer.innerHTML = group;
      else answer.innerHTML = group + `<p class="muted" data-order-label>排序：${escape(data.orderLabel || '按姓名、登录账号排序。')}</p>` + (data.items.length ? `<div class="filters">${data.items.map((candidate, i) =>
        button('choose', accountName(candidate), `data-candidate="${i}"`)).join('')}</div>` : '<p>未找到匹配的账号</p>') + pagination(data, 'candidates');
      confirmation();
    } catch (error) {
      if (!connected() || controller.signal.aborted || edit !== selection) return;
      answer.innerHTML = button('candidate-retry', '重试账号查询');
      fail(error);
    }
  }
  function beginEdit(row, type) {
    closeEditor();
    edit = { row, type, meta: null, selected: null, q: '' };
    editor.innerHTML = `<section class="admin-record"><div class="list-heading"><h3>${typeLabels[type]}账号关联</h3>${button('cancel', '关闭')}</div>
      <p>第 ${show(row.sourceRow)} 行 · ${show(row.customer)} · ${show(row.stockName)} ${show(row.stockCode)}</p>
      <form data-registry-candidate-query class="inline-form" role="search"><label class="field"><span>查找${typeLabels[type]}账号</span>
        <input name="account" type="search" maxlength="100" placeholder="输入登录账号或姓名" autocomplete="off"></label>
        <button class="secondary">查找账号</button></form>
      <div data-registry-options aria-live="polite"></div><div data-registry-confirmation></div></section>`;
    editor.scrollIntoView({ block: 'nearest' });
    void candidates();
  }
  async function write(path, payload, success) {
    if (!canManage || writing) return;
    writing = true;
    listController?.abort();
    candidateController?.abort();
    const offset = list?.offset || 0;
    panel.inert = true;
    panel.setAttribute('aria-busy', 'true');
    tell(path.endsWith('/sync') ? '正在读取本地工作簿并更新登记资料…' : '正在保存账号关联…');
    try {
      await request(path, payload);
      if (connected()) tell(success);
    } catch (error) {
      if (connected()) fail(error);
    } finally {
      writing = false;
      if (connected()) {
        panel.inert = false;
        panel.removeAttribute('aria-busy');
        await load(q, offset);
      }
    }
  }
  function onSubmit(event) {
    event.preventDefault();
    event.stopPropagation();
    if (writing) return;
    const form = event.target;
    if (form === query) { tell(''); void load(query.elements.q.value); return; }
    if (!edit || !canManage) return;
    if (form.hasAttribute('data-registry-candidate-query')) void candidates(form.elements.account.value);
    if (form.hasAttribute('data-registry-commit') && form.elements.confirmed.checked && edit.meta) {
      const prior = edit.meta.currentLink;
      if (!prior && !edit.selected) return;
      void write('/registry/link', {
        type: edit.type, entryKey: edit.row.entryKey, sourceToken: edit.meta.sourceToken,
        identityId: prior ? null : edit.selected.identityId, previousIdentityId: prior?.identityId ?? null, confirmed: true,
      }, prior ? '已解除账号关联' : '账号关联已保存');
    }
  }
  function onInput(event) {
    if (event.target.name !== 'account' || !edit || writing) return;
    candidateController?.abort();
    edit.meta = null;
    edit.selected = null;
    find('[data-registry-options]').textContent = '';
    find('[data-registry-confirmation]').replaceChildren();
  }
  function onClick(event) {
    const clicked = event.target.closest('button[data-registry-action]');
    if (!clicked || !panel.contains(clicked) || writing) return;
    const { registryAction: action, row, type, offset, candidate } = clicked.dataset;
    if (action === 'reset') { query.elements.q.value = ''; tell(''); void load(''); }
    if (action === 'retry' || action === 'page') { query.elements.q.value = q; tell(''); void load(q, Number(offset) || 0); }
    if (!canManage) return;
    if (action === 'edit' && list?.items[row] && Object.hasOwn(typeLabels, type)) { tell(''); beginEdit(list.items[row], type); }
    if (action === 'cancel') closeEditor();
    if (action === 'candidate-retry' || action === 'candidates') void candidates(edit?.q, Number(offset) || 0);
    if (action === 'choose' && edit?.meta?.items[candidate]) { edit.selected = edit.meta.items[candidate]; confirmation(); }
    if (action === 'sync' && window.confirm('从项目中的本地工作簿更新登记资料？')) void write('/registry/sync', {}, '登记资料已更新');
  }
  panel.addEventListener('submit', onSubmit);
  panel.addEventListener('input', onInput);
  panel.addEventListener('click', onClick);
  if (canManage) mountSalesBatch(find('[data-sales-batch]'), request, () => load(q, list?.offset || 0), onError, initialPasswordHint);
  const api = { refresh: () => load(q, list?.offset || 0), dispose() {
    disposed = true;
    candidateController?.abort();
    listController?.abort();
    panel.removeEventListener('submit', onSubmit);
    panel.removeEventListener('input', onInput);
    panel.removeEventListener('click', onClick);
    panels.delete(panel);
  } };
  panels.set(panel, api);
  void load();
  return api;
}
