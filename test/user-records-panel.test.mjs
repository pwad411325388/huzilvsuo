import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { progressNode, progressSteps } from '../progress-dictionary.mjs';
import { projectProgressDisplay } from '../progress-display.mjs';
import { recordsQuery, recordsEntryState, normalRecordsState, renderRecordProgress, renderUserRecords, mountUserRecordsPanel } from '../web/user-records-panel.js';

const row = { id: 'row-one', customer: '测试股民', stockName: '测试股票', stockCode: '000001', phone: '19900000001',
  registeredOn: '2025-01-01', status: '已受理', kind: 'lead', progressId: 'lead-one', cases: [],
  canFollowup: true, leadId: 'lead-one', version: 3, followStatus: '待跟进', followups: [] };
const result = patch => ({ q: '', period: 'all', from: '', to: '2026-11-20', follow: 'all', ledger: 'all', customerId: '', total: 45,
  unfilteredTotal: 45, customerCount: 40, offset: 0, limit: 20, items: [row], ...patch });

function harness({ role = 'sales', initialState = {} } = {}) {
  const listeners = {}, pending = [], changes = [], errors = [], results = [];
  const root = { innerHTML: '', isConnected: true, attributes: {}, contains: () => true,
    setAttribute(name,value) { this.attributes[name] = value; }, addEventListener(name,fn) { listeners[name] = fn; },
    removeEventListener(name,fn) { if (listeners[name] === fn) delete listeners[name]; } };
  let current = true;
  const panel = mountUserRecordsPanel(root, { role, today: '2026-11-20', initialState, isCurrent: () => current,
    onState: state => changes.push(state), onResult: value => results.push(value), onError: error => errors.push(error),
    request(path,body,signal) { return new Promise((resolve,reject) => pending.push({path,body,signal,resolve,reject})); } });
  async function resolve(index, patch, promise) { pending[index].resolve(result(patch)); await promise; }
  return {root,panel,listeners,pending,changes,errors,results,resolve,invalidate() { current = false; }};
}

test('首页摘要只收到当前记录请求的真实结果，加载或失败清空旧数量，离开账号后无回调', async () => {
  const h = harness();
  assert.equal(h.results.at(-1).loading,true);
  await h.resolve(0,{total:8971},h.panel.ready);
  assert.equal(h.results.at(-1).data.total,8971);
  const search = h.panel.search('测试');
  assert.equal(h.results.at(-1).data,null);
  h.pending[1].reject(new Error('offline')); await search;
  assert.equal(h.results.at(-1).error,'offline');
  const retry = h.panel.retry(), before = h.results.length;
  h.invalidate(); h.pending[2].resolve(result({q:'测试',total:9})); await retry;
  assert.equal(h.results.length,before);
  h.panel.dispose();
});

test('三个角色使用统一记录且无跟进控件；股民无姓名搜索、券商无电话，所有资料转义', () => {
  const data = result({items:[{...row, sourceType:'历史登记', customer:'<img src=x>', stockName:'"<script>x</script>', followups:[{note:'<img>',salesName:'测试销售'}]}]});
  const sales = renderUserRecords(data, {}, { role:'sales' });
  assert.match(sales,/搜索客户或股票/); assert.match(sales,/19900000001/); assert.doesNotMatch(sales,/跟进|data-follow/);
  assert.match(sales,/&lt;img/); assert.doesNotMatch(sales,/<img|<script|历史登记|小程序数据/);
  const investor = renderUserRecords(data, {}, {role:'investor'});
  assert.match(investor,/<h2>我的股票登记<\/h2>/); assert.doesNotMatch(investor,/data-records-form="search"|保存跟进|律所登记/);
  const broker = renderUserRecords(data, {}, {role:'broker'});
  assert.doesNotMatch(broker,/19900000001|保存跟进|data-records-action="detail"/);
});

test('股民首页的全部记录使用逐案接口，详情返回和重试保留页码与口径', async () => {
  const state = { presentation:'home', offset:20 };
  assert.doesNotMatch(recordsQuery({}, 'investor'), /presentation/);
  assert.doesNotMatch(recordsQuery(state, 'broker'), /presentation/);
  const h = harness({role:'investor', initialState:state});
  assert.match(h.pending[0].path, /presentation=home/);
  await h.resolve(0, {}, h.panel.ready);
  assert.match(h.root.innerHTML, /未完整返回/);
  const retry = h.panel.retry();
  assert.equal(h.pending[1].path, h.pending[0].path);
  const list = {presentation:'home', offset:20, items:[{...row, caseTitle:'第一批<测试>'}]};
  await h.resolve(1, list, retry);
  assert.match(h.root.innerHTML, /<h2>全部记录<\/h2>/); assert.match(h.root.innerHTML, /第一批&lt;测试&gt;/);
  const detail = h.panel.open(0);
  h.pending[2].resolve({kind:'lead',id:'lead-one',relatedCases:[]}); await detail;
  assert.match(h.root.innerHTML, /返回记录列表/);
  const back = h.panel.back();
  assert.equal(h.pending[3].path, h.pending[0].path);
  await h.resolve(3, list, back);
  assert.match(h.root.innerHTML, /第 2 \/ 3 页/);
  h.panel.dispose();
});

test('股民首页直达进度时，关联案件能原路返回，详情失败可原地重试', async () => {
  const lead = {kind:'lead', id:'lead-one', relatedCases:[{id:'case-one', title:'关联案件'}]};
  const h = harness({role:'investor', initialState:{presentation:'home', directHomeDetail:true, detail:{kind:'lead', id:'lead-one'}}});
  assert.equal(h.pending[0].path, '/progress?kind=lead&id=lead-one');
  h.pending[0].resolve(lead); await h.panel.ready;
  assert.match(h.root.innerHTML, /data-action="records-return">返回首页/);
  const detail = h.panel.openCase('case-one');
  assert.equal(h.pending[1].path, '/progress?kind=case&id=case-one');
  h.pending[1].reject(new Error('测试网络错误')); await detail;
  assert.match(h.root.innerHTML, /返回关联记录/); assert.match(h.root.innerHTML, /重新加载/);
  const retry = h.panel.retry();
  assert.equal(h.pending[2].path, h.pending[1].path);
  h.pending[2].resolve({kind:'case', id:'case-one', relatedCases:[]}); await retry;
  const back = h.panel.back();
  assert.equal(h.pending[3].path, h.pending[0].path);
  h.pending[3].resolve(lead); await back;
  assert.match(h.root.innerHTML, /data-action="records-return">返回首页/);
  h.panel.dispose();
});

test('搜索覆盖服务端全部结果，期间和客户筛选在翻页与详情返回后保持', async () => {
  const h = harness({initialState:{customerId:'customer-key',customerName:'指定客户'}});
  assert.match(h.pending[0].path,/^\/records\?/); assert.doesNotMatch(h.pending[0].path,/follow=/);
  await h.resolve(0,{},h.panel.ready);
  const dates = h.panel.applyDates('2025-01-01','2025-12-31');
  await h.resolve(1,{period:'custom',from:'2025-01-01',to:'2025-12-31'},dates);
  const search = h.panel.search('第九只股票');
  assert.match(decodeURIComponent(h.pending[2].path),/q=第九只股票/);
  assert.match(h.pending[2].path,/customerId=customer-key/);
  await h.resolve(2,{period:'custom',q:'第九只股票'},search);
  const paging = h.panel.setPage(40);
  await h.resolve(3,{period:'custom',q:'第九只股票',offset:20,total:21},paging);
  assert.equal(h.panel.state().offset,20);
  const detail = h.panel.open(0);
  assert.match(h.pending[4].path,/\/progress\?kind=lead&id=lead-one/);
  h.pending[4].resolve({kind:'lead',id:'lead-one',title:'测试股票',current:{label:'已受理'},relatedCases:[]}); await detail;
  const back = h.panel.back();
  assert.match(h.pending[5].path,/offset=20/); assert.match(h.pending[5].path,/from=2025-01-01/);
  await h.resolve(5,{period:'custom',q:'第九只股票',offset:20,total:21},back);
  assert.match(h.root.innerHTML,/第 2 \/ 2 页/); h.panel.dispose();
});

test('旧跟进筛选和字段不再影响列表，客户仍可查看真实案件进度', async () => {
  const h = harness({ initialState: { follow: 'pending' } });
  await h.resolve(0,{items:[{...row,followups:[{note:'旧内部备注',salesName:'旧销售'}]}]},h.panel.ready);
  assert.doesNotMatch(h.pending[0].path,/follow=/);
  assert.doesNotMatch(h.root.innerHTML,/跟进|旧内部备注|旧销售/);
  assert.match(h.root.innerHTML,/已受理|查看记录与进度/);
  const detail = h.panel.open(0);
  assert.equal(h.pending[1].path,'/progress?kind=lead&id=lead-one');
  h.pending[1].resolve({kind:'lead',id:'lead-one',relatedCases:[]}); await detail;
  assert.equal(h.pending.filter(request=>request.body!==undefined).length,0);
  h.panel.dispose();
});

test('缺日期或倒置日期不请求，搜索草稿不被回包覆盖，账号切换和离页丢弃旧响应', async () => {
  const h = harness(); await h.resolve(0,{},h.panel.ready);
  h.panel.applyDates('2026-02-30','2026-11-20'); assert.equal(h.pending.length,1); assert.match(h.root.innerHTML,/请选择有效/);
  const earlier = h.panel.search('早请求'), later = h.panel.search('新请求');
  assert.equal(h.pending[1].signal.aborted,true);
  const target = {value:'尚未提交',closest:()=>({dataset:{recordsForm:'search'}})};
  h.listeners.input({target});
  await h.resolve(2,{q:'新请求',items:[]},later);
  await h.resolve(1,{q:'早请求',items:[{...row,customer:'过期资料'}]},earlier);
  assert.doesNotMatch(h.root.innerHTML,/过期资料/); assert.match(h.root.innerHTML,/value="尚未提交"/);
  const next = h.panel.search('离页请求'); h.invalidate(); const before=h.root.innerHTML;
  await h.resolve(3,{q:'离页请求',items:[{...row,customer:'其他账号资料'}]},next);
  assert.equal(h.root.innerHTML,before); h.panel.dispose();
});

test('错误不显示假零记录，401交还主应用，损坏响应可重试', async () => {
  const h=harness(); h.pending[0].resolve({items:[]}); await h.panel.ready;
  assert.match(h.root.innerHTML,/未完整返回/); assert.doesNotMatch(h.root.innerHTML,/共 0 条/);
  const retry=h.panel.retry(); h.pending[1].reject(Object.assign(new Error('请先登录'),{status:401})); await retry;
  assert.equal(h.errors.length,1); h.panel.dispose();
});

test('所有业务入口不再打开独立登记搜索，后台台账仍保留管理入口', () => {
  const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
  assert.doesNotMatch(app,/data-my-registry|showRegistry\([^\n]*false|我的登记客户|分派给我的留资|历史股票请/);
  assert.match(app,/state\.adminTab === 9\) void showRegistry/);
  assert.match(app,/state\.page === 'mine'[\s\S]*userRecordsHost/);
  assert.match(app,/customerId: action === 'customer-records' \? value/);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(recordsQuery({period:'all',q:'',follow:'all',offset:0,from:'stale',to:'stale'}))),{period:'all',q:'',offset:'0',limit:'5'});
});


test('券商默认显示全部，签约筛选保留搜索和日期，签约状态不冒充案件进度', async () => {
  const h=harness({role:'broker'});
  assert.match(h.pending[0].path,/ledger=all/);
  await h.resolve(0,{items:[{...row,canFollowup:false,signingStatus:'洽谈中'}]},h.panel.ready);
  assert.match(h.root.innerHTML,/aria-label="客户签约状态"/);
  assert.match(h.root.innerHTML,/客户签约状态：洽谈中/); assert.match(h.root.innerHTML,/已受理/);
  const search=h.panel.search('股票'); await h.resolve(1,{q:'股票'},search);
  const month=h.panel.setPeriod('month'); await h.resolve(2,{q:'股票',period:'month'},month);
  const signed=h.panel.setLedger('signed');
  assert.match(h.pending[3].path,/period=month/); assert.match(decodeURIComponent(h.pending[3].path),/q=股票/); assert.match(h.pending[3].path,/ledger=signed/);
  await h.resolve(3,{q:'股票',period:'month',ledger:'signed',items:[{...row,signingStatus:'已签约'}]},signed);
  assert.match(h.root.innerHTML,/客户签约状态：已签约/); h.panel.dispose();
});

test('本月实际签约客户下钻显示上月登记的股票，返回看板期间保持；普通卡片仍沿用期间', async () => {
  const board={period:'custom',rangeFrom:'2026-11-01',rangeTo:'2026-11-20',metric:'signings',offset:20,data:{selected:'signings'}};
  const before=structuredClone(board);
  const entry=recordsEntryState(board,{role:'broker',customerId:'signed-customer',customerName:'跨月客户'});
  assert.equal(entry.period,'all'); assert.equal(entry.from,''); assert.equal(entry.to,'');
  assert.equal(entry.scopeNote,'查看该签约客户的全部股票记录'); assert.deepEqual(board,before);
  const h=harness({role:'broker',initialState:entry});
  assert.match(h.pending[0].path,/period=all/); assert.doesNotMatch(h.pending[0].path,/from=|to=/);
  await h.resolve(0,{items:[{...row,registeredOn:'2026-10-08',signingStatus:'已签约'}]},h.panel.ready);
  assert.match(h.root.innerHTML,/2026-10-08/); assert.match(h.root.innerHTML,/查看该签约客户的全部股票记录/);
  assert.deepEqual(board,before,'读取记录不能修改返回时的看板状态');
  const normal=recordsEntryState({...board,metric:'customers',data:{selected:'customers'}},{role:'broker',customerId:'signed-customer'});
  assert.equal(normal.period,'custom'); assert.equal(normal.from,'2026-11-01'); assert.equal(normal.to,'2026-11-20'); assert.equal(normal.scopeNote,'');
  const cleared=h.panel.allCustomers(); await h.resolve(1,{items:[]},cleared); assert.doesNotMatch(h.root.innerHTML,/该签约客户/); h.panel.dispose();
});


test('普通入口与客户下钻状态隔离，回到普通入口保留检索日期页码但清除客户与详情限定', () => {
  const normal={period:'custom',from:'2025-01-01',to:'2025-12-31',q:'原有搜索',draft:'未提交草稿',offset:20,ledger:'negotiating',follow:'all',detail:{kind:'lead',id:'old'}};
  const before=structuredClone(normal);
  const drill=recordsEntryState({period:'month',metric:'signings'},{role:'broker',customerId:'signed-one',customerName:'签约客户'});
  const resumed=normalRecordsState(normal);
  assert.equal(drill.customerId,'signed-one'); assert.equal(drill.period,'all');
  assert.equal(resumed.customerId,''); assert.equal(resumed.customerName,''); assert.equal(resumed.scopeNote,''); assert.equal(resumed.detail,null);
  for(const key of ['period','from','to','q','draft','offset','ledger','follow']) assert.equal(resumed[key],normal[key]);
  assert.deepEqual(normal,before,'下钻和返回不修改保存的普通筛选对象');
  const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
  assert.match(app,/const stateKey = \['records', 'registry'\]\.includes\(page\) \? 'recordsDrilldown' : 'userRecords'/);
  assert.match(app,/state\.recordsDrilldown = recordsEntryState/);
  assert.match(app,/case 'page': state\.userRecords = normalRecordsState/);
});


test('竖向进度以阶段为大字、状态及备注为同行小字，销售合同号在日期下方', () => {
  const detail={kind:'registry',id:'test',title:'测试股票',stockCode:'000001',current:{stage:'intake',node:'signed_waiting_filing',stageLabel:'留资与签约',label:'已签约'},relatedCases:[],contractNumber:'合成合同号',
    steps:[{stage:'intake',node:'signed_waiting_filing',label:'已签约',note:'待立案',status:'current'},
      {stage:'filing',node:'preparing',stageLabel:'立案',label:'立案材料准备中',status:'next'},
      {stage:'intake',node:'lead_received',label:'旧已完成节点',status:'completed'},
      {stage:'filing',node:'filed',label:'旧流程说明节点',status:'reference'}]};
  const html=renderUserRecords(null,{detail:{kind:'registry',id:'test'}},{role:'investor',detail});
  assert.equal((html.match(/class="progress-step"/g)||[]).length,2);
  assert.match(html,/data-step-status="current" aria-current="step"/);
  assert.match(html,/<div class="progress-step-title"><strong>留资与签约<\/strong><\/div><small class="progress-step-status">已签约 · <span class="progress-step-note">待立案<\/span><\/small>/);
  assert.match(html,/<strong>立案<\/strong><\/div><small class="progress-step-status">立案材料准备中<\/small>/);
  assert.match(html,/<span class="progress-step-marker" aria-hidden="true">✓<\/span>/);
  assert.match(html,/<span class="progress-step-marker" aria-hidden="true"><\/span>/);
  assert.match(html,/data-step-status="next"/);assert.match(html,/立案材料准备中/);
  assert.doesNotMatch(html,/旧已完成节点|旧流程说明节点|流程说明|已完成|progress-stage|当前状态：/);
  assert.doesNotMatch(html,/合同号：|合成合同号/);
  const sales=renderUserRecords(null,{detail:{}},{role:'sales',detail:{...detail,steps:detail.steps.map(({note,...step})=>step)}});
  assert.match(sales,/<div class="progress-step-date">日期待补充<\/div><small class="progress-step-contract">合同号：合成合同号<\/small>/);
  assert.equal((sales.match(/合同号：/g)||[]).length,1);assert.doesNotMatch(sales,/待立案/);
  const css=readFileSync(new URL('../web/app.css',import.meta.url),'utf8');
  assert.match(css,/\.record-progress \{ display: flex; flex-direction: column;/);
  assert.match(css,/\.progress-step:not\(:last-child\)::after \{[^}]*width: 2px; background: #d8dfe4/);
  assert.match(css,/data-step-status=current\] \.progress-step-marker \{[^}]*background: #238553; color: white/);
  assert.match(css,/data-step-status=next\] \{ color: #75808a; \}/);
  assert.doesNotMatch(css,/\.progress-step\[data-step-status=(?:current|next)\] \{[^}]*background/);
  assert.match(css,/\.progress-step-heading \{ display: flex; align-items: baseline; flex-wrap: wrap;/);
  assert.match(css,/\.progress-position \{[^}]*clip: rect\(0, 0, 0, 0\)/);
});

test('网页按两种角色的真实签约接口展示绿黄灰三步，仅签约节点显示日期和销售合同号', () => {
  for (const role of ['investor', 'sales']) {
    const current = progressNode('intake', 'signed_waiting_filing', role);
    const steps = progressSteps(current, role);
    steps[0].date = '2026-11-20';
    steps[0].dateLabel = '签约日期';
    const detail = {current, steps, contractNumber:'合同一'};
    const html = renderUserRecords(null, {detail:{}}, {role, detail});
    const rows = [...html.matchAll(/<li class="progress-step" data-step-status="(\w+)"[^>]*>([\s\S]*?)<\/li>/g)];
    assert.deepEqual(rows.map(row => row[1]), ['current', 'active', 'next']);
    assert.match(rows[0][2], /留资与签约[\s\S]*已签约[\s\S]*<time datetime="2026-11-20"/);
    assert.match(rows[1][2], /进行中[\s\S]*<strong>立案<\/strong>[\s\S]*立案材料准备中/);
    assert.match(rows[2][2], /下一步[\s\S]*<strong>立案<\/strong>[\s\S]*已提交立案/);
    assert.doesNotMatch(rows[1][2] + rows[2][2], /<time|progress-step-date|合同一|✓/);
    assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
    assert.equal((html.match(/待立案/g) || []).length, role === 'investor' ? 1 : 0);
    assert.equal((html.match(/合同号：合同一/g) || []).length, role === 'sales' ? 1 : 0);
    if (role === 'sales') assert.match(rows[0][2], /<\/time><\/div><small class="progress-step-contract">合同号：合同一/);
    steps[0].date = '';
    steps[1].date = steps[2].date = '2029-01-01';
    const missing = renderUserRecords(null, {detail:{}}, {role, detail});
    assert.equal((missing.match(/日期待补充/g) || []).length, 1);
    assert.doesNotMatch(missing, /<time|2029/);
  }
  const css = readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');
  assert.match(css, /data-step-status=active\] \.progress-step-marker \{ border-color: #876513; background: #d4a21f;/);
});

test('签约三步忽略混入或错配的节点，旧版及明确指定的两步路线照常回显', () => {
  const role = 'sales';
  const current = progressNode('intake', 'signed_waiting_filing', role);
  const [signed, preparing, submitted] = progressSteps(current, role);
  const render = (steps, confirmed = current) => renderUserRecords(null, {detail:{}}, {role, detail:{current:confirmed, steps}});
  const unrelated = {stage:'closure', node:'closed', label:'不相关的结案'};
  const noisy = render([null, {...unrelated, status:'active'}, {...unrelated, status:'next'}, submitted, preparing, signed]);
  assert.equal((noisy.match(/class="progress-step"/g) || []).length, 3);
  assert.doesNotMatch(noisy, /不相关的结案/);
  for (const incomplete of [
    [signed, preparing], [signed, {...unrelated, status:'active'}], [preparing, submitted], {},
    [signed, {...unrelated, status:'active'}, submitted], [signed, {...preparing, label:'  '}, submitted],
    [signed, preparing, {...submitted, label:null}], [{...signed, label:''}, preparing, submitted],
    [{...signed, node:'signed'}, preparing, submitted],
  ]) {
    const shown = render(incomplete);
    assert.match(shown, /已签约/);
    assert.doesNotMatch(shown, /data-step-status="(?:active|next)"|不相关的结案/);
  }
  const legacy = render([signed, {...preparing, status:'next'}]);
  assert.match(legacy, /data-step-status="next"[\s\S]*立案材料准备中/);
  assert.doesNotMatch(legacy, /data-step-status="active"|已提交立案/);
  assert.match(render([signed, submitted]), /data-step-status="next"[\s\S]*已提交立案/);
  const explicit = progressSteps(current, role, [], {stage:'filing', node:'supplement'});
  for (const steps of [explicit, [...explicit, preparing], [...explicit, {...unrelated, status:'active'}]]) {
    const shown = render(steps);
    assert.match(shown, /data-step-status="next"[\s\S]*待补充材料/);
    assert.doesNotMatch(shown, /data-step-status="active"|已提交立案|不相关的结案/);
  }
  const other = progressNode('filing', 'preparing', role);
  const normal = render([...progressSteps(other, role), {...unrelated, status:'active'}], other);
  assert.match(normal, /data-step-status="next"[\s\S]*已提交立案/);
  assert.doesNotMatch(normal, /data-step-status="active"|不相关的结案/);
});

test('终态只显示当前节点，未知进度不编造下一步，标签和备注保持转义', () => {
  const render=detail=>renderUserRecords(null,{detail:{}},{role:'sales',detail:{title:'测试',relatedCases:[],...detail}});
  const terminal=render({current:{stage:'closure',node:'closed',label:'已结案'},steps:[{stage:'closure',node:'closed',label:'已结案',status:'current'}]});
  assert.equal((terminal.match(/class="progress-step"/g)||[]).length,1);assert.doesNotMatch(terminal,/下一步/);
  const unknown=render({current:null,sourceStatus:'待核对',steps:[]});assert.match(unknown,/data-step-uncertain="true"/);assert.match(unknown,/待核对/);assert.doesNotMatch(unknown,/下一步|日期待补充|<time/);
  const orphan=render({current:null,steps:[{label:'不能推定',status:'next'}]});assert.doesNotMatch(orphan,/不能推定|下一步/);
  const escaped=render({current:{stage:'filing',node:'preparing',label:'<img>'},steps:[{stage:'filing',node:'preparing',label:'<img>',note:'<script>x</script>',status:'current'}]});assert.match(escaped,/&lt;img&gt;/);assert.match(escaped,/&lt;script&gt;/);assert.doesNotMatch(escaped,/<img|<script/);
  const unconfirmed=render({current:null,steps:[{stage:'closure',node:'closed',label:'未确认结案',status:'current'}]});assert.doesNotMatch(unconfirmed,/未确认结案/);assert.match(unconfirmed,/data-step-uncertain="true"/);
  const fallback=render({current:{stage:'filing',node:'preparing',label:'立案材料准备中'},steps:[],openedOn:'2026-11-02'});
  assert.equal((fallback.match(/class="progress-step"/g)||[]).length,1);assert.match(fallback,/登记日期：2026-11-02/);
  const mismatch=render({current:{stage:'filing',node:'preparing',label:'立案材料准备中'},steps:[{stage:'closure',node:'closed',label:'错误结案',status:'current'},{stage:'filing',node:'submitted',label:'错误下一步',status:'next'}]});
  assert.match(mismatch,/<strong>立案材料准备中<\/strong>/);assert.doesNotMatch(mismatch,/错误结案|错误下一步/);
});


test('同名进度显示一审或二审阶段，真实签约日期两端可见且缺失时不补造', () => {
  const render=(stageLabel,role,signedOn)=>renderUserRecords(null,{detail:{}},{role,detail:{title:'测试股票',relatedCases:[],
    current:{stage:stageLabel==='一审'?'first_hearing':'appeal',node:'awaiting_judgment',stageLabel,label:'等待判决结果'},signedOn,steps:[{stage:stageLabel==='一审'?'first_hearing':'appeal',node:'awaiting_judgment',label:'等待判决结果',status:'current'},{label:'判决待生效',status:'next'}]}});
  const first=render('一审','investor','2026-11-20'),appeal=render('上诉与二审','sales','2026-11-19');
  assert.match(first,/<strong>一审<\/strong><\/div><small class="progress-step-status">等待判决结果<\/small>/);assert.match(appeal,/<strong>上诉与二审<\/strong><\/div><small class="progress-step-status">等待判决结果<\/small>/);
  assert.doesNotMatch(first,/progress-stage|当前状态：/);
  assert.match(first,/签约日期：2026-11-20/);assert.match(appeal,/签约日期：2026-11-19/);
  assert.doesNotMatch(render('一审','investor',undefined),/签约日期/);
});

test('下一步以实际阶段名为大字，无阶段名称时保留状态且不重复', () => {
  const render=(stage,stageLabel)=>renderUserRecords(null,{detail:{}},{role:'sales',detail:{title:'测试股票',relatedCases:[],
    current:{stage:'first_hearing',node:'awaiting_judgment',stageLabel:'一审',label:'等待判决结果'},
    steps:[{stage:'first_hearing',node:'awaiting_judgment',label:'等待判决结果',status:'current'},
      {stage,node:'awaiting_judgment',stageLabel,label:'等待判决结果',status:'next'}]}});
  assert.match(render('appeal','上诉与二审'),/<strong>上诉与二审<\/strong><\/div><small class="progress-step-status">等待判决结果<\/small>/);
  assert.equal((render('first_hearing','一审').match(/<strong>一审<\/strong>/g)||[]).length,2);
  const fallback=render('','').split('data-step-status="next"')[1];
  assert.match(fallback,/<strong>等待判决结果<\/strong>/);assert.doesNotMatch(fallback,/progress-step-status|progress-step-date/);
});

test('当前节点只显示接口给出的真实事件日期，下一步不显示日期，缺日期待补充', () => {
  const render=(date,dateLabel='立案日期')=>renderUserRecords(null,{detail:{}},{role:'investor',detail:{title:'测试股票',relatedCases:[],filedOn:'2026-11-18',
    current:{stage:'filing',node:'submitted',stageLabel:'立案',label:'已提交立案'},
    steps:[{stage:'filing',node:'submitted',label:'已提交立案',status:'current',date,dateLabel},
      {stage:'first_hearing',node:'awaiting_hearing',stageLabel:'一审',label:'一审待开庭',status:'next',date:'2030-01-01'}]}});
  const known=render('2026-11-18');
  assert.match(known,/<time datetime="2026-11-18" aria-label="立案日期：2026.11.18">2026.11.18<\/time>/);
  assert.doesNotMatch(known,/2030-01-01|2030.01.01|日期待补充/);
  const missing=render(undefined);assert.equal((missing.match(/日期待补充/g)||[]).length,1);assert.doesNotMatch(missing,/<time/);
  assert.match(missing,/立案日期：2026-11-18/,'原详情字段保留，不能拿它擅自填节点事件日期');
  assert.match(render('2026-02-30'),/日期待补充/);assert.doesNotMatch(render('2026-02-30'),/2026.02.30/);
  assert.match(render('2026-11-18','<img>'),/aria-label="&lt;img&gt;：2026.11.18"/);
});

test('未知后续路线只显示后续进度与待确认，不编造日期或阶段',()=>{
  const html=renderUserRecords(null,{detail:{}},{role:'sales',detail:{title:'测试',relatedCases:[],
    current:{stage:'filing',node:'submitted',stageLabel:'立案',label:'已提交立案'},steps:[{stage:'filing',node:'submitted',label:'已提交立案',status:'current'},
      {stage:'',node:'pending_route',label:'后续进度待确认',status:'next'}]}});
  const next=html.split('data-step-status="next"')[1];
  assert.match(next,/<strong>后续进度<\/strong><\/div><small class="progress-step-status">待确认<\/small>/);
  assert.doesNotMatch(next,/progress-step-date|日期待补充|后续进度待确认|<time/);
});

test('股民与销售共用粗状态节点展示，保留原状态与事件日期而不推定审级', () => {
  const current = {stage:'historical_filing',node:'filed_unheard',stageLabel:'立案',label:'已立案未开庭',note:'审级待核对'};
  const displayProgress = {current,steps:[{...current,status:'current',date:'2026-11-11',dateLabel:'立案日期'},
    {stage:'historical_hearing',node:'awaiting_hearing',stageLabel:'开庭',label:'待开庭',status:'next'}]};
  for (const role of ['investor','sales']) {
    const html = renderRecordProgress({title:'测试股票',current:null,steps:[],displayProgress,contractNumber:'ROLE-ONLY'},role);
    assert.equal((html.match(/class="progress-step"/g)||[]).length,2);
    assert.match(html,/<strong>立案<\/strong>/); assert.match(html,/已立案未开庭/);
    assert.match(html,/<strong>开庭<\/strong>/); assert.match(html,/审级待核对/);
    assert.match(html,/<time datetime="2026-11-11"/);
    assert.doesNotMatch(html,/一审|二审|待同步|data-step-uncertain/);
    if (role === 'investor') assert.doesNotMatch(html,/ROLE-ONLY/);
    else assert.match(html,/ROLE-ONLY/);
  }
  const formal = {stage:'closure',node:'closed',stageLabel:'获赔与结案',label:'已结案'};
  const html = renderRecordProgress({title:'测试',current:formal,steps:[{...formal,status:'current'}],displayProgress},'sales');
  assert.match(html,/已结案/); assert.doesNotMatch(html,/已立案未开庭|审级待核对|2026-11-11/);
});

test('未知投影显示灰色待核对锚点，不显示猜测的后续状态、事件日期或原始叙述', () => {
  const current = {stage:'unknown',node:'unconfirmed',stageLabel:'案件进度',label:'待核对',uncertain:true};
  const html = renderRecordProgress({title:'测试',current:null,sourceStatus:'不应公开的原始叙述',displayProgress:{current,
    steps:[{...current,status:'current',date:'2026-11-11'},{stage:'closure',node:'closed',status:'next',label:'错误结案'}],
    notice:'具体阶段待律所核实。'}},'investor');
  assert.match(html,/data-step-uncertain="true"/);
  assert.match(html,/aria-hidden="true">\?<\/span>/);
  assert.match(html,/具体阶段待律所核实/);
  assert.doesNotMatch(html,/下一步|错误结案|不应公开|<time|日期待补充/);
  const css=readFileSync(new URL('../web/app.css',import.meta.url),'utf8');
  assert.match(css,/data-step-uncertain=true\] \.progress-step-marker \{[^}]*background: #f3f5f7/);
});

test('真实展示投影在网页及后台预览保留申报、受理、调解和退回的具体下一步提示', () => {
  for (const [rawStatus, nextLabel] of [['重整债权已申报','申报结果待确认'],['破产债权已申报','申报结果待确认'],
    ['待受理','受理结果待确认'],['已提交调解申请','调解结果待确认'],['立案退回','后续处理待确认']]) {
    for (const role of ['investor','sales']) {
      const displayProgress=projectProgressDisplay({rawStatus},{role,kind:'registry',currentDay:'2026-11-20'});
      const html=renderRecordProgress({title:'投影测试',current:null,steps:[],displayProgress},role);
      assert.ok(html.includes(rawStatus),rawStatus);
      assert.ok(html.includes(nextLabel),nextLabel);
      assert.match(html,/<strong>后续进度<\/strong>/);
      assert.equal((html.match(/data-step-status="next"/g)||[]).length,1);
    }
  }
});
