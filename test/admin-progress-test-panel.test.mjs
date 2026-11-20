import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountAdminProgressTest, renderAdminProgressTest } from '../web/admin-progress-test-panel.js';

const groups = [
  {stage:'intake',label:'留资与签约',nodes:[{node:'lead_received',label:'已留资'},{node:'signed_waiting_filing',label:'已签约'}]},
  {stage:'filing',label:'立案',nodes:[{node:'preparing',label:'立案材料准备中'},{node:'supplement',label:'待补充材料'}]},
  {stage:'closure',label:'获赔与结案',nodes:[{node:'closed',label:'已结案'}]},
];
const row={kind:'lead',id:'one',customer:'同名客户',phone:'19900000001',stockName:'股票甲',stockCode:'000001',title:'',salesName:'销售甲',status:'已签约',registeredOn:'2026-11-20',number:'LZ20260001'};
const list=patch=>({items:[row,{...row,id:'two',stockName:'股票乙',phone:'19900000002'}],total:42,offset:0,limit:20,...patch});
function detail(patch={}) {
  const result={record:row,revision:2,testing:false,snapshot:{stage:'intake',node:'signed_waiting_filing',contractNumber:'',nextStage:'',nextNode:''},...patch};
  const current={stage:result.snapshot.stage,node:result.snapshot.node,stageLabel:'留资与签约',label:result.record.status};
  result.previews={investor:{title:row.stockName,stockCode:row.stockCode,current,relatedCases:[],steps:[{...current,status:'current',note:'待立案'}]},
    sales:{title:row.stockName,stockCode:row.stockCode,customer:row.customer,current,contractNumber:result.snapshot.contractNumber,relatedCases:[],steps:[{...current,status:'current'}]}};
  return result;
}
function harness(initialState={}) {
  const pending=[],listeners={},changes=[],errors=[];let active=true;
  const root={innerHTML:'',isConnected:true,contains:()=>true,attributes:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,v){listeners[k]=v;},removeEventListener(k,v){if(listeners[k]===v)delete listeners[k];}};
  const panel=mountAdminProgressTest(root,{initialState,isCurrent:()=>active,onState:s=>changes.push(s),onError:e=>errors.push(e),
    request(path,body,signal){return new Promise((resolve,reject)=>pending.push({path,body,signal,resolve,reject}));}});
  async function boot() { pending[0].resolve({groups});pending[1].resolve(list());await panel.ready; }
  async function select(index=0,value=detail()) { const p=panel.select(index);pending.at(-1).resolve(value);await p; }
  return {pending,listeners,changes,errors,root,panel,boot,select,invalidate(){active=false;}};
}

test('后台入口独立，初次只检索不自动选中/修改，结果区分股票电话与销售且转义',async()=>{
  const h=harness();assert.equal(h.pending[0].path,'/progress-test/options');assert.equal(h.pending[1].path,'/progress-test?q=&offset=0');
  await h.boot();assert.equal(h.panel.state().selected,null);assert.equal(h.pending.length,2);
  assert.match(h.root.innerHTML,/每页 20 条/);assert.match(h.root.innerHTML,/19900000001/);assert.match(h.root.innerHTML,/股票乙/);assert.match(h.root.innerHTML,/销售甲/);
  assert.match(h.root.innerHTML,/登记日期：2026-11-20 · 记录编号：LZ20260001/);
  const html=renderAdminProgressTest({state:{draft:'<script>',selected:null},groups,data:list({items:[{...row,customer:'<img>'}]})});
  assert.doesNotMatch(html,/<script>|<img>/);assert.match(html,/&lt;img&gt;/);
  const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
  assert.match(app,/\[2, '客户案件'\], \[10, '进度测试'\]/);assert.match(app,/adminProgressTestPanel\?\.dispose\(\)/);assert.match(app,/state\.adminProgressTest = \{\}/);h.panel.dispose();
  assert.match(app,/adminTabs\.filter\(\(\[index\]\) => index !== 10 \|\| state\.view\.progressTestEnabled === true\)/);
  assert.match(app,/state\.adminTab === 10 && state\.view\.progressTestEnabled !== true\) \{ state\.adminTab = 6/);
});

test('姓名全量检索与翻页保留关键词，只选择指定股票，阶段联动不自动提交',async()=>{
  const h=harness();await h.boot();const search=h.panel.search(' 同名客户 ');
  assert.equal(h.pending.at(-1).path,'/progress-test?q=%E5%90%8C%E5%90%8D%E5%AE%A2%E6%88%B7&offset=0');h.pending.at(-1).resolve(list());await search;
  const page=h.panel.page(20);assert.match(h.pending.at(-1).path,/offset=20/);h.pending.at(-1).resolve(list({offset:20}));await page;
  await h.select(1,detail({record:{...row,id:'two'}}));assert.match(h.pending.at(-1).path,/kind=lead&id=two/);
  h.panel.edit('stage','filing');assert.match(h.root.innerHTML,/<option value="" selected>选择当前状态/);
  const count=h.pending.length;await h.panel.save();assert.equal(h.pending.length,count);assert.match(h.root.innerHTML,/请选择有效的阶段/);
  h.panel.edit('node','supplement');const save=h.panel.save();assert.deepEqual(h.pending.at(-1).body,{kind:'lead',id:'two',revision:2,stage:'filing',node:'supplement',contractNumber:'',nextStage:'',nextNode:''});
  h.pending.at(-1).resolve(detail({record:{...row,id:'two',status:'待补充材料'},revision:3,testing:true,snapshot:{stage:'filing',node:'supplement',contractNumber:'',nextStage:'',nextNode:''}}));await save;
  assert.equal(h.panel.state().q,'同名客户');assert.equal(h.panel.state().offset,20);assert.match(h.root.innerHTML,/已保存，请刷新股民\/销售页面核对/);assert.match(h.root.innerHTML,/后台当前状态：<strong>待补充材料/);h.panel.dispose();
});

test('合同号只在销售只读预览出现，plain signed回填，下一步成对校验，恢复保留搜索',async()=>{
  const h=harness({q:'股票',draft:'股票'});await h.boot();
  await h.select(0,detail({testing:true,snapshot:{stage:'intake',node:'signed',contractNumber:'测试合同',nextStage:'',nextNode:''}}));
  assert.match(h.root.innerHTML,/<option value="signed_waiting_filing" selected>已签约/);
  const investor=h.root.innerHTML.split('data-progress-test-preview="investor"')[1].split('data-progress-test-preview="sales"')[0];assert.doesNotMatch(investor,/测试合同/);assert.match(h.root.innerHTML,/合同号：测试合同/);
  assert.doesNotMatch(h.root.innerHTML,/data-records-action=/,'只读预览无跳转或编辑按钮');
  h.panel.edit('nextStage','filing');const count=h.pending.length;await h.panel.save();assert.equal(h.pending.length,count);assert.match(h.root.innerHTML,/需要一起选择/);
  h.panel.edit('nextNode','preparing');const save=h.panel.save();assert.equal(h.pending.at(-1).body.nextStage,'filing');assert.equal(h.pending.at(-1).body.nextNode,'preparing');
  h.pending.at(-1).resolve(detail({testing:true,revision:3}));await save;
  const restore=h.panel.restore();assert.equal(h.pending.at(-1).path,'/progress-test/restore');assert.deepEqual(h.pending.at(-1).body,{kind:'lead',id:'one',revision:3});
  h.pending.at(-1).resolve(detail({testing:false,revision:4}));await restore;assert.equal(h.panel.state().q,'股票');assert.match(h.root.innerHTML,/已恢复到开始测试前/);
  const after=h.pending.length;await h.panel.restore();assert.equal(h.pending.length,after);h.panel.dispose();
});

test('409保留草稿但禁止覆盖，显式重新读取后才可保存；保存中不能切换或重复提交',async()=>{
  const h=harness();await h.boot();await h.select();h.panel.edit('contractNumber','未保存草稿');
  const save=h.panel.save(),count=h.pending.length;void h.panel.save();void h.panel.search('其他人');void h.panel.select(1);assert.equal(h.pending.length,count);
  h.pending.at(-1).reject(Object.assign(new Error('冲突'),{status:409}));await save;assert.match(h.root.innerHTML,/重新读取后再操作/);assert.match(h.root.innerHTML,/value="未保存草稿"/);
  await h.panel.save();await h.panel.restore();assert.equal(h.pending.length,count);
  const reload=h.panel.reload();h.pending.at(-1).resolve(detail({revision:9}));await reload;assert.doesNotMatch(h.root.innerHTML,/未保存草稿/);
  const retry=h.panel.save();assert.equal(h.pending.at(-1).body.revision,9);h.pending.at(-1).resolve(detail({revision:10,testing:true}));await retry;h.panel.dispose();
});

test('快速检索/换记录/换账号丢弃过期响应，检索草稿不被回包覆盖',async()=>{
  const h=harness();await h.boot();const old=h.panel.search('旧查询'),oldRequest=h.pending.at(-1),latest=h.panel.search('新查询');
  assert.equal(oldRequest.signal.aborted,true);
  h.listeners.input({target:{value:'未提交文字',closest:()=>({dataset:{progressTestForm:'search'}})}});
  h.pending.at(-1).resolve(list());await latest;oldRequest.resolve(list({items:[{...row,customer:'过期资料'}]}));await old;
  assert.doesNotMatch(h.root.innerHTML,/过期资料/);assert.match(h.root.innerHTML,/value="未提交文字"/);
  const first=h.panel.select(0),firstRequest=h.pending.at(-1),second=h.panel.select(1);
  h.pending.at(-1).resolve(detail({record:{...row,id:'two',stockName:'第二只股票'}}));await second;firstRequest.resolve(detail());await first;
  assert.match(h.root.innerHTML,/第二只股票/);assert.equal(h.panel.state().selected.id,'two');
  const request=h.panel.reload();h.invalidate();const before=h.root.innerHTML;h.pending.at(-1).resolve(detail({record:{...row,id:'two',stockName:'别的账号内容'}}));await request;assert.equal(h.root.innerHTML,before);h.panel.dispose();
});

test('错误不伪装空列表，401交还主应用，未知状态保持未选择',async()=>{
  const h=harness();h.pending[0].resolve({groups});h.pending[1].resolve({items:[]});await h.panel.ready;
  assert.match(h.root.innerHTML,/未完整返回/);assert.doesNotMatch(h.root.innerHTML,/共 0 条/);
  const retry=h.panel.reloadList();h.pending.at(-1).reject(Object.assign(new Error('请先登录'),{status:401}));await retry;assert.equal(h.errors.length,1);
  const html=renderAdminProgressTest({state:{draft:'',selected:row},groups,data:list(),detail:detail({snapshot:{stage:'',node:'',contractNumber:'',nextStage:'',nextNode:''}})});
  assert.match(html,/<option value="" selected>选择阶段/);h.panel.dispose();
});

test('尚无测试快照时回填实际派生状态，未知状态不自动选择第一项',async()=>{
  const h=harness();await h.boot();const actual=detail();actual.snapshot={stage:'',node:'',contractNumber:'',nextStage:'',nextNode:''};
  await h.select(0,actual);assert.match(h.root.innerHTML,/<option value="signed_waiting_filing" selected>已签约/);
  const unknown=detail();unknown.snapshot=actual.snapshot;unknown.previews.sales.current=null;unknown.previews.investor.current=null;
  await h.select(1,{...unknown,record:{...row,id:'two'}});assert.match(h.root.innerHTML,/<option value="" selected>选择阶段/);
  const count=h.pending.length;await h.panel.save();assert.equal(h.pending.length,count);h.panel.dispose();
});

test('切换当前阶段或节点清空旧的指定下一步，合同号保留',async()=>{
  const h=harness();await h.boot();const existing=detail({testing:true,snapshot:{stage:'filing',node:'preparing',contractNumber:'保留合同',nextStage:'closure',nextNode:'closed'}});
  await h.select(0,existing);h.panel.edit('node','supplement');
  assert.match(h.root.innerHTML,/<option value="" selected>按当前流程/);assert.match(h.root.innerHTML,/value="保留合同"/);
  let save=h.panel.save();assert.equal(h.pending.at(-1).body.nextStage,'');assert.equal(h.pending.at(-1).body.nextNode,'');assert.equal(h.pending.at(-1).body.contractNumber,'保留合同');h.pending.at(-1).resolve(existing);await save;
  h.panel.edit('stage','intake');assert.match(h.root.innerHTML,/<option value="" selected>选择当前状态/);assert.match(h.root.innerHTML,/<option value="" selected>按当前流程/);
  h.panel.edit('node','signed_waiting_filing');save=h.panel.save();assert.equal(h.pending.at(-1).body.nextStage,'');assert.equal(h.pending.at(-1).body.nextNode,'');h.pending.at(-1).resolve(detail());await save;h.panel.dispose();
});
