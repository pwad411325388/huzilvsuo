import { renderRecordProgress } from './user-records-panel.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const show = value => escape(value || '—');
const button = (action, label, attrs = '', primary = false) => `<button type="button" class="${primary ? 'primary' : 'secondary'}" data-progress-test-action="${action}" ${attrs}>${escape(label)}</button>`;
const same = (a, b) => a?.kind === b?.kind && a?.id === b?.id;
const kindLabel = kind => kind === 'case' ? '案件' : '股票记录';
const blankForm = () => ({ stage: '', node: '', contractNumber: '', nextStage: '', nextNode: '', more: false });
const option = (value, label, selected) => `<option value="${escape(value)}"${selected === value ? ' selected' : ''}>${escape(label)}</option>`;
const options = (rows, key, selected, placeholder) => option('', placeholder, selected) + rows.map(row => option(row[key], row.label, selected)).join('');
const field = (label, input) => `<label class="field"><span>${label}</span>${input}</label>`;

export function renderAdminProgressTest({ state, groups = [], data = null, detail = null, form = blankForm(), listLoading = false, detailLoading = false,
  saving = false, stale = false, listError = '', detailError = '', optionsError = '', notice = '' }) {
  const disabled = saving ? ' disabled' : '';
  const list = listLoading ? '<p role="status">正在检索记录…</p>' : data ? `<p class="muted" data-progress-test-count>共 ${escape(data.total)} 条记录 · 每页 ${data.limit} 条</p>
    ${data.items.length ? `<div class="table-wrap"><table><thead><tr><th>客户 / 电话</th><th>股票 / 案件</th><th>销售</th><th>当前进度</th><th>操作</th></tr></thead><tbody>${data.items.map((row, index) => `<tr${same(state.selected, row) ? ' class="progress-test-selected"' : ''}>
      <td>${show(row.customer)}<small>${show(row.phone)}</small></td><td>${show(row.stockName)} ${escape(row.stockCode)}<small>${kindLabel(row.kind)}${row.kind === 'case' ? ` · ${show(row.title)}` : ''}</small><small>${row.kind === 'case' ? '案件登记' : '登记日期'}：${show(row.registeredOn)} · 记录编号：${show(row.number)}</small></td>
      <td>${show(row.salesName)}</td><td>${show(row.status)}</td><td>${button('select', same(state.selected, row) ? '已选择' : '选择记录', `data-index="${index}" aria-pressed="${same(state.selected, row)}"${disabled}`)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">没有符合条件的股票或案件，请换个关键词搜索。</div>'}
    <nav class="list-pagination" aria-label="进度测试结果分页">${button('page', '上一页', `data-offset="${Math.max(0, data.offset - data.limit)}"${!data.offset || saving ? ' disabled' : ''}`)}<span>第 ${Math.floor(data.offset / data.limit) + 1} / ${Math.max(1, Math.ceil(data.total / data.limit))} 页</span>
    ${button('page', '下一页', `data-offset="${data.offset + data.limit}"${data.offset + data.limit >= data.total || saving ? ' disabled' : ''}`)}</nav>` : '';
  const group = groups.find(row => row.stage === form.stage), nextGroup = groups.find(row => row.stage === form.nextStage);
  const editor = detail ? `<section class="panel progress-test-editor"><h2>当前选中记录</h2>
    <p><strong>${show(detail.record.customer)} · ${show(detail.record.stockName)} ${escape(detail.record.stockCode)}</strong></p>
    <p>${kindLabel(detail.record.kind)}${detail.record.kind === 'case' ? ` · ${show(detail.record.title)}` : ''} · 电话 ${show(detail.record.phone)} · 销售 ${show(detail.record.salesName)}</p>
    <p>${detail.record.kind === 'case' ? '案件登记' : '登记日期'}：${show(detail.record.registeredOn)} · 记录编号：${show(detail.record.number)}</p>
    <p data-progress-test-status>后台当前状态：<strong>${show(detail.record.status)}</strong> <span class="tag">${detail.testing ? '测试中' : '原进度'}</span></p>
    ${detailError ? `<p class="records-error" role="alert">${escape(detailError)}</p>` : ''}
    ${stale ? `<p>这条记录已被其他操作更新。重新读取后再修改，避免覆盖较新的进度。</p>${button('reload-detail', '重新读取', disabled)}` : ''}
    ${notice ? `<p class="progress-test-notice" role="status">${escape(notice)}</p>` : ''}
    <form data-progress-test-form="edit"><fieldset${saving || stale || !groups.length ? ' disabled' : ''}>
      <div class="progress-test-fields">${field('阶段', `<select name="stage" required>${options(groups, 'stage', form.stage, '选择阶段')}</select>`)}
      ${field('当前状态', `<select name="node" required>${options(group?.nodes || [], 'node', form.node, '选择当前状态')}</select>`)}</div>
      <details class="progress-test-more" data-progress-test-more${form.more ? ' open' : ''}><summary>更多测试项</summary>
        ${field('测试合同号（仅销售端展示）', `<input name="contractNumber" value="${escape(form.contractNumber)}" maxlength="128" autocomplete="off">`)}
        <p class="muted">下一步留空时按当前流程显示；选择后只为这条记录指定下一步。</p>
        <div class="progress-test-fields">${field('下一阶段（可选）', `<select name="nextStage">${options(groups, 'stage', form.nextStage, '按当前流程')}</select>`)}
        ${field('下一状态（可选）', `<select name="nextNode"${form.nextStage ? ' required' : ' disabled'}>${options(nextGroup?.nodes || [], 'node', form.nextNode, form.nextStage ? '选择下一状态' : '按当前流程')}</select>`)}</div>
      </details><button class="primary">${saving ? '正在保存…' : '保存测试进度'}</button>
    </fieldset></form>
    <div class="progress-test-restore"><p class="muted">恢复到这条记录开始测试前的进度和合同信息。</p>${button('restore', '恢复原进度', !detail.testing || saving || stale ? 'disabled' : '')}</div>
    <h3>当前已保存效果</h3><div class="progress-test-previews">${[['investor','股民端预览'],['sales','销售端预览']].map(([role,label]) => `<section class="progress-test-preview" data-progress-test-preview="${role}"><h3>${label}</h3>${renderRecordProgress({ ...detail.previews[role], relatedCases: [] }, role)}</section>`).join('')}</div>
  </section>` : detailLoading ? '<section class="panel" role="status">正在读取选中记录…</section>' : state.selected && detailError ? `<section class="panel"><p role="alert">${escape(detailError)}</p>${button('reload-detail', '重新读取')}</section>` : '<section class="panel empty">先搜索并选择一条股票或案件，再修改测试进度。</section>';
  return `<section class="panel progress-test-search"><h2>进度测试</h2><p>选中一条股票或案件测试，保存后股民、销售和后台同步显示；测试完可恢复原进度。</p>
    <form data-progress-test-form="search" class="inline-form" role="search">${field('搜索客户或股票', `<input type="search" name="q" value="${escape(state.draft)}" maxlength="100" placeholder="客户姓名、电话、股票名称或代码" autocomplete="off"${disabled}>`)}<button class="primary"${disabled}>搜索</button>${button('reset', '重置', disabled)}</form>
    ${optionsError ? `<p role="alert" class="records-error">${escape(optionsError)}</p>${button('retry-options', '重新加载阶段')}` : ''}
    ${listError ? `<p role="alert" class="records-error">${escape(listError)}</p>${button('retry-list', '重新检索', disabled)}` : ''}${list}</section>${editor}`;
}

export function mountAdminProgressTest(root, { request, initialState = {}, onState = () => {}, onError = () => {}, isCurrent = () => true } = {}) {
  const state = { q: '', draft: '', offset: 0, selected: null, ...initialState };
  let groups = [], data = null, detail = null, form = blankForm(), listLoading = false, detailLoading = false, saving = false, stale = false;
  let listError = '', detailError = '', optionsError = '', notice = '', disposed = false;
  let listSequence = 0, detailSequence = 0, optionsSequence = 0, listController, detailController, optionsController;
  const current = () => !disposed && root.isConnected && isCurrent();
  const emit = () => onState({ ...state, selected: state.selected && { ...state.selected } });
  const paint = () => {
    if (!current()) return;
    root.setAttribute('aria-busy', String(listLoading || detailLoading || saving));
    root.innerHTML = renderAdminProgressTest({ state, groups, data, detail, form, listLoading, detailLoading, saving, stale, listError, detailError, optionsError, notice });
    emit();
  };
  function failure(error) { if (error.status === 401) onError(error); }
  function acceptDetail(result, selected) {
    if (!result || !same(result.record, selected) || !Number.isSafeInteger(result.revision) || result.revision < 0 || typeof result.testing !== 'boolean' || !result.snapshot || !result.previews?.investor || !result.previews?.sales) throw new Error('记录详情未完整返回，请重新读取');
    detail = result;
    const snapshot = result.snapshot, effective = snapshot.stage && snapshot.node ? snapshot : result.previews.sales.current;
    const stage = effective?.stage || '', node = effective?.node || '';
    form = { ...blankForm(), ...snapshot, stage, node: stage === 'intake' && node === 'signed' ? 'signed_waiting_filing' : node,
      more: !!(snapshot.contractNumber || snapshot.nextStage) };
    stale = false;
    if (data) data.items = data.items.map(row => same(row, result.record) ? result.record : row);
  }
  async function loadOptions() {
    optionsController?.abort(); optionsController = new AbortController(); const sequence = ++optionsSequence; optionsError = '';
    try {
      const result = await request('/progress-test/options', undefined, optionsController.signal);
      if (!current() || sequence !== optionsSequence) return;
      if (!Array.isArray(result?.groups) || !result.groups.length || !result.groups.every(group => typeof group.stage === 'string' && Array.isArray(group.nodes) && group.nodes.length)) throw new Error('阶段选项未完整返回，请重试');
      groups = result.groups;
    } catch (error) { if (!current() || sequence !== optionsSequence || error.name === 'AbortError') return; optionsError = error.message || '阶段暂时无法加载'; failure(error); }
    finally { if (current() && sequence === optionsSequence) paint(); }
  }
  async function loadList() {
    listController?.abort(); listController = new AbortController(); const sequence = ++listSequence; listLoading = true; listError = ''; data = null; paint();
    try {
      const result = await request('/progress-test?' + new URLSearchParams({ q: state.q, offset: state.offset }), undefined, listController.signal);
      if (!current() || sequence !== listSequence) return;
      if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || !Number.isSafeInteger(result.offset) || result.offset < 0 || result.limit !== 20) throw new Error('检索结果未完整返回，请重试');
      data = result; state.offset = result.offset;
    } catch (error) { if (!current() || sequence !== listSequence || error.name === 'AbortError') return; listError = error.message || '暂时无法检索记录'; failure(error); }
    finally { if (current() && sequence === listSequence) { listLoading = false; paint(); } }
  }
  async function loadDetail() {
    if (!state.selected) return;
    detailController?.abort(); detailController = new AbortController(); const sequence = ++detailSequence, selected = { ...state.selected };
    detailLoading = true; detailError = ''; detail = null; notice = ''; paint();
    try {
      const result = await request('/progress-test/detail?' + new URLSearchParams(selected), undefined, detailController.signal);
      if (!current() || sequence !== detailSequence || !same(selected, state.selected)) return;
      acceptDetail(result, selected);
    } catch (error) { if (!current() || sequence !== detailSequence || error.name === 'AbortError') return; detailError = error.message || '暂时无法读取记录'; failure(error); }
    finally { if (current() && sequence === detailSequence) { detailLoading = false; paint(); } }
  }
  function clearSelection() { detailSequence++; detailController?.abort(); state.selected = null; detail = null; detailLoading = false; detailError = ''; notice = ''; stale = false; form = blankForm(); }
  async function mutate(restore) {
    if (!current() || saving || stale || !detail || restore && !detail.testing) return;
    if (!restore) {
      const group = groups.find(row => row.stage === form.stage), nextGroup = groups.find(row => row.stage === form.nextStage);
      if (!group?.nodes.some(row => row.node === form.node)) { detailError = '请选择有效的阶段和当前状态'; paint(); return; }
      if (form.nextStage && !nextGroup?.nodes.some(row => row.node === form.nextNode) || !form.nextStage && form.nextNode) { detailError = '下一阶段和下一状态需要一起选择'; paint(); return; }
      if (form.nextStage === form.stage && form.nextNode === form.node || form.stage === 'closure' && form.node === 'closed' && form.nextStage) { detailError = '下一步不能与当前状态相同，已结案也不需要下一步'; paint(); return; }
    }
    const selected = { ...state.selected }, revision = detail.revision, sequence = detailSequence;
    saving = true; detailError = ''; notice = ''; paint();
    try {
      const input = restore ? { ...selected, revision } : { ...selected, revision, stage: form.stage, node: form.node, contractNumber: form.contractNumber.trim(), nextStage: form.nextStage, nextNode: form.nextNode };
      const result = await request(restore ? '/progress-test/restore' : '/progress-test', input);
      if (!current() || sequence !== detailSequence || !same(selected, state.selected)) return;
      acceptDetail(result, selected);
      notice = restore ? '已恢复到开始测试前的原进度，请刷新股民/销售页面核对。' : '已保存，请刷新股民/销售页面核对。';
    } catch (error) {
      if (!current() || sequence !== detailSequence) return;
      stale = error.status === 409; detailError = stale ? '进度已更新，请重新读取后再操作。' : error.message || '未能保存，请重试'; failure(error);
    } finally { if (current() && sequence === detailSequence) { saving = false; paint(); } }
  }
  const api = {
    state: () => ({ ...state, selected: state.selected && { ...state.selected } }),
    search(value) { if (saving) return; state.q = String(value || '').trim(); state.draft = state.q; state.offset = 0; clearSelection(); return loadList(); },
    page(value) { if (saving || !Number.isSafeInteger(value) || value < 0) return; state.offset = value; clearSelection(); return loadList(); },
    select(index) { if (saving || !data?.items[index]) return; const row = data.items[index]; state.selected = { kind: row.kind, id: row.id }; return loadDetail(); },
    edit(name, value) {
      if (saving || stale || !detail || !Object.hasOwn(blankForm(), name)) return;
      form[name] = value; detailError = ''; notice = '';
      if (name === 'stage') form.node = '';
      if (name === 'stage' || name === 'node') { form.nextStage = ''; form.nextNode = ''; }
      if (name === 'nextStage') form.nextNode = '';
      if (name === 'stage' || name === 'node' || name === 'nextStage') paint();
    },
    save: () => mutate(false), restore: () => mutate(true), reload: loadDetail, reloadList: loadList, reloadOptions: loadOptions,
    dispose() { disposed = true; listController?.abort(); detailController?.abort(); optionsController?.abort(); for (const [name, handler] of Object.entries(listeners)) root.removeEventListener(name, handler, name === 'toggle'); },
  };
  const listeners = {
    click(event) {
      const target = event.target.closest('[data-progress-test-action]'); if (!target || !root.contains(target)) return;
      const action = target.dataset.progressTestAction;
      if (action === 'select') void api.select(Number(target.dataset.index));
      if (action === 'page') void api.page(Number(target.dataset.offset));
      if (action === 'reset') void api.search('');
      if (action === 'reload-detail') void api.reload();
      if (action === 'retry-list') void api.reloadList();
      if (action === 'retry-options') void api.reloadOptions();
      if (action === 'restore') void api.restore();
    },
    submit(event) {
      const element = event.target.closest('[data-progress-test-form]'); if (!element || !root.contains(element)) return;
      event.preventDefault();
      if (element.dataset.progressTestForm === 'search') void api.search(new FormData(element).get('q'));
      else void api.save();
    },
    input(event) { const target = event.target, element = target.closest('[data-progress-test-form]'); if (!element) return; if (element.dataset.progressTestForm === 'search') { state.draft = target.value; emit(); } else if (target.name === 'contractNumber') api.edit(target.name, target.value); },
    change(event) { if (event.target.closest('[data-progress-test-form="edit"]') && event.target.tagName === 'SELECT') api.edit(event.target.name, event.target.value); },
    toggle(event) { if (event.target.matches?.('[data-progress-test-more]')) form.more = event.target.open; },
  };
  for (const [name, handler] of Object.entries(listeners)) root.addEventListener(name, handler, name === 'toggle');
  api.ready = Promise.all([loadOptions(), loadList(), state.selected ? loadDetail() : Promise.resolve()]);
  return api;
}
