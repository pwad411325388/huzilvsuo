import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createAppServer } from '../server.mjs';
import { renderHomeCard, salesHomeNote, brokerHomeNote } from '../web/home-card.js';

const appSource = readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const cardActions = appSource.slice(appSource.indexOf("      case 'home-cooperation':"), appSource.indexOf("      case 'retry-progress-test':"));
const runAction = new Function('action','state','app','loadSalesBoard', `return (async () => { switch (action) { ${cardActions} } })();`);

function actionHarness(role) {
  const field = {value:'尚未保存的券商',focus(){this.focused=true;},scrollIntoView(){}},
    heading = {setAttribute(){},focus(){this.focused=true;},scrollIntoView(){this.scrolled=true;}},
    toggle = {textContent:'展开明细',setAttribute(name,value){this[name]=value;}}, results = {hidden:true};
  const state = {view:{actor:{role}},page:'home',revision:1,salesBoard:{metric:'customers',ledger:'negotiating',offset:5,sequence:1,
    period:'custom',rangeFrom:'2025-01-01',rangeTo:'2025-12-31',q:'股票',searchDraft:'未提交的搜索',from:'2024-01-01',detailsExpanded:false,data:{items:[]}}};
  const app = {querySelector(selector){return selector.includes('input') ? field : selector === '#board-results' ? results : heading;},querySelectorAll(){return [toggle];}};
  return {state,app,field,heading,toggle,results};
}

test('销售卡片只定位已有输入框，保留未提交的券商名称', async () => {
  const h = actionHarness('sales');
  await runAction('home-cooperation',h.state,h.app,()=>assert.fail('不应请求看板'));
  assert.equal(h.field.value,'尚未保存的券商'); assert.equal(h.field.focused,true);
});

test('券商卡片在客户页直接展开定位，保留第2页、洽谈筛选和所有草稿且不请求接口', async () => {
  const h = actionHarness('broker'), before = {...h.state.salesBoard};
  await runAction('home-customers',h.state,h.app,()=>assert.fail('已加载客户不应重查'));
  assert.deepEqual(h.state.salesBoard,{...before,detailsExpanded:true});
  assert.equal(h.results.hidden,false); assert.equal(h.heading.focused,true); assert.equal(h.toggle['aria-expanded'],'true');
});

test('券商其他指标切换客户时保留时间和查询草稿，晚到结果不会抢走新页面焦点', async () => {
  const h = actionHarness('broker'); h.state.salesBoard.metric='ongoing';
  let calls=0;
  await runAction('home-customers',h.state,h.app,async offset=>{calls++;assert.equal(offset,0);h.state.salesBoard.sequence++;});
  assert.equal(calls,1); assert.equal(h.state.salesBoard.metric,'customers'); assert.equal(h.state.salesBoard.offset,0);
  assert.equal(h.state.salesBoard.period,'custom'); assert.equal(h.state.salesBoard.rangeFrom,'2025-01-01');
  assert.equal(h.state.salesBoard.q,'股票'); assert.equal(h.state.salesBoard.searchDraft,'未提交的搜索');
  assert.equal(h.state.salesBoard.from,'2024-01-01'); assert.equal(h.heading.focused,true);
  h.heading.focused=false; h.state.salesBoard.metric='ongoing';
  await runAction('home-customers',h.state,h.app,async()=>{h.state.salesBoard.sequence++;h.state.page='mine';});
  assert.equal(h.heading.focused,false);
});

test('首页摘要区分加载、失败、真实零值和当前筛选范围', () => {
  for (const note of [salesHomeNote, brokerHomeNote]) {
    assert.match(note({ loading: true }), /正在读取/);
    assert.match(note({ error: 'offline' }), /暂未加载/);
    assert.doesNotMatch(note({}), /0 条|0 件/);
  }
  assert.equal(salesHomeNote({data:{total:8971,period:'all'}}), '8971 条客户与股票记录');
  assert.match(salesHomeNote({data:{total:0,period:'month'}}), /本月登记 · 0 条/);
  assert.match(salesHomeNote({data:{total:3,period:'custom',q:'股票'}}), /当前检索 · 3 条/);
  assert.match(salesHomeNote({data:{total:-1}}), /暂未加载/);
  const data = {period:'custom',total:99,metrics:[{key:'customers',value:99},{key:'ongoing',value:2}]};
  assert.equal(brokerHomeNote({data}), '所选日期登记 · 2 件案件在办');
  assert.match(brokerHomeNote({data:{period:'month',metrics:[{key:'ongoing',value:0}]}}), /0 件案件在办/);
  assert.match(brokerHomeNote({data:{metrics:[]}}), /暂未加载/);
  assert.match(brokerHomeNote({data,error:'offline'}), /暂未加载/);
});

test('三端首页只合并标题和摘要卡片，文字转义且装饰图无可点击语义', () => {
  for (const [role,title] of [['investor','我的维权服务'],['sales','销售工作台'],['broker','渠道台账']]) {
    const html = renderHomeCard({role,name:'<客户>',today:'2026-11-20',note:'<提醒>',action:'investor-progress',value:'attention',actionLabel:'查看进度'});
    assert.match(html,new RegExp(`<h1>${title}</h1>`));
    assert.match(html,role === 'broker' ? /&lt;客户&gt;<\/span>/ : /&lt;客户&gt;，您好/); assert.match(html,/&lt;提醒&gt;/);
    assert.match(html, /datetime="2026-11-20">11月20日/);
    assert.match(html,/data-action="investor-progress" data-value="attention"/);
    assert.match(html,new RegExp(`/assets/home-${role}\\.png`));
    assert.match(html,/alt="" aria-hidden="true"/);
  }
  assert.equal(renderHomeCard({role:'admin'}),'');
});

test('固定静态映射提供同一组首页透明图及卡片模块，不开放任意文件路径', async t => {
  const server = createAppServer({database:':memory:'});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const role of ['investor','sales','broker']) {
    const response = await fetch(`${base}/assets/home-${role}.png`);
    assert.equal(response.status,200); assert.match(response.headers.get('content-type'),/^image\/png/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),readFileSync(new URL(`../miniprogram/assets/home-${role}.png`,import.meta.url)));
  }
  assert.equal((await fetch(base+'/home-card.js')).status,200);
  assert.equal((await fetch(base+'/assets/unknown.png')).status,404);
});
