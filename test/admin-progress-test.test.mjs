import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,unlinkSync,rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createStore } from '../store.mjs';
import { createAppServer } from '../server.mjs';
import { renderRecordProgress } from '../web/user-records-panel.js';
import { nativePages } from '../test-support/native-page.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'huzi-admin-progress-')),path=join(dir,'qa.sqlite');
  const credentials={username:'fixture-admin',password:'fixture-password',name:'测试管理'};
  const store=createStore(path,{seed:true,cutoff:'2000-01-01',admin:credentials,progressTestEnabled:true}),db=new DatabaseSync(path),beforeClose=[];
  t.after(async()=>{for(const close of beforeClose) await close();store.close();db.close();unlinkSync(path);rmdirSync(dir);});
  const admin=store.getSession(store.createSession(store.verifyLogin(credentials).id));
  const investor={role:'investor',id:'customer-a'},sales={role:'sales',id:'sales-a'};
  db.exec("UPDATE lead_assignments SET salesId='sales-a' WHERE leadId='lead-demo-a'");
  return {store,db,path,admin,investor,sales,credentials,api:store.adminProgressTest,beforeClose};
}
const lead={kind:'lead',id:'lead-demo-a'},theCase={kind:'case',id:'case-demo-1'};
const selected=(detail,stage,node,extra={})=>({...detail.record,revision:detail.revision,stage,node,...extra});

test('管理员按具体股票逐一测试全部销售词条，两端真实进度与预览一致且恢复原无快照',t=>{
  const {store,db,admin,investor,sales,api}=fixture(t);
  const groups=api.options(admin).groups;
  assert.equal(groups.length,8); assert.equal(groups.flatMap(group=>group.nodes).length,23);
  assert.equal(groups[0].nodes.some(item=>item.node==='signed'),false);
  assert.deepEqual(api.search(admin),{items:[],total:0,offset:0,limit:20});
  assert.throws(()=>api.search(admin,{q:'a'.repeat(101)}),/最多/);
  assert.throws(()=>api.search(admin,{q:'甲',offset:-1}),/分页/);
  const matches=api.search(admin,{q:'示例股票甲'});
  assert.deepEqual(new Set(matches.items.map(item=>item.kind)),new Set(['lead','case']));
  assert.ok(matches.items.every(row=>/^(LZ|AJ)-\d{6}$/.test(row.number) && /^\d{4}-\d{2}-\d{2}$/.test(row.registeredOn)));
  let detail=api.detail(admin,lead);
  const initial=store.progress(investor,lead),other=store.progress(investor,theCase),originalRevision=detail.revision;
  for(const group of groups) for(const item of group.nodes) {
    detail=api.save(admin,selected(detail,group.stage,item.node,{contractNumber:'TEST-CONTRACT'}));
    assert.equal(detail.testing,true);
    assert.equal(detail.previews.sales.current.node,item.node);
    assert.equal(detail.previews.sales.current.label,item.label);
    for(const actor of [investor,sales]) {
      assert.deepEqual(detail.previews[actor.role],store.progress(actor,lead));
      assert.equal(store.userRecords(actor,{q:'000000'}).items[0].status,detail.previews[actor.role].current.label);
    }
    if(item.node==='signed_waiting_filing') assert.equal(detail.previews.investor.steps[0].note,'待立案','测试覆盖不被已有案件抑制');
    if(group.stage==='filing' && item.node==='submitted') {
      for(const role of ['investor','sales']) assert.deepEqual(detail.previews[role].steps.map(step=>[step.stage,step.node,step.status]),
        [['filing','submitted','current'],['first_hearing','awaiting_hearing','next']]);
    }
    if(group.stage==='closure' && item.node==='pending_payment') {
      for(const role of ['investor','sales']) {
        const preview=detail.previews[role];
        assert.equal(preview.current.stageLabel,'获赔');
        assert.equal(preview.current.label,'待支付');
        assert.deepEqual(preview.steps.map(step=>[step.node,step.status]),[['pending_payment','current'],['payment_received','next']]);
        assert.equal(preview.steps[1].date,undefined);
      }
    }
    assert.doesNotMatch(JSON.stringify(detail.previews.investor),/TEST-CONTRACT|contract/i);
    assert.equal(detail.previews.sales.contractNumber,'TEST-CONTRACT');
    assert.equal(db.prepare("SELECT revision FROM company_record_progress WHERE kind='lead' AND record_id='lead-demo-a'").get().revision,0,'测试不消耗公司版本');
  }
  assert.deepEqual(store.progress(investor,theCase),other,'修改lead不改其他case');
  assert.throws(()=>api.save(admin,{...lead,revision:originalRevision,stage:'filing',node:'submitted'}),error=>error.status===409);
  detail=api.restore(admin,{...lead,revision:detail.revision});
  assert.equal(detail.testing,false); assert.deepEqual(store.progress(investor,lead),initial);
  assert.equal(db.prepare("SELECT 1 FROM company_record_progress WHERE kind='lead' AND record_id='lead-demo-a'").get(),undefined);
  assert.notEqual(detail.revision,originalRevision,'恢复无快照也使旧表单过期');
  assert.throws(()=>api.restore(admin,{...lead,revision:detail.revision}),error=>error.status===409);
  const actions=db.prepare("SELECT action,subject FROM audit WHERE action LIKE '%进度测试'").all();
  assert.equal(actions.length,24); assert.ok(actions.every(item=>item.subject==='lead:lead-demo-a'));
});

test('恢复保留首次完整快照及显式清空；外部下一版覆盖测试且旧测试不能恢复',t=>{
  const {store,db,admin,api,investor}=fixture(t);
  store.syncProgress([{...theCase,revision:7,stage:'filing',node:'submitted',contractNumber:'ORIGINAL',completedNodes:['preparing'],nextStage:'first_hearing',nextNode:'awaiting_hearing'}]);
  const old=api.detail(admin,theCase);
  let detail=api.save(admin,selected(old,'closure','closed',{contractNumber:'TEST'}));
  detail=api.save(admin,selected(detail,'intake','signed_waiting_filing'));
  assert.equal(detail.previews.investor.current.node,'signed_waiting_filing');
  assert.equal(detail.previews.investor.steps[0].note,'待立案');
  detail=api.restore(admin,{...theCase,revision:detail.revision});
  assert.deepEqual(detail.snapshot,old.snapshot);
  const restored=db.prepare("SELECT * FROM company_record_progress WHERE kind='case' AND record_id='case-demo-1'").get();
  assert.equal(restored.revision,7); assert.equal(restored.completed_nodes,'["preparing"]');
  detail=api.save(admin,selected(detail,'filing','supplement'));
  for(let n=0;n<4;n++) detail=api.save(admin,selected(detail,'filing',n%2?'supplement':'preparing'));
  store.syncProgress([{...theCase,revision:8,stage:'appeal',node:'remanded',contractNumber:'REAL-NEXT'}]);
  assert.throws(()=>api.restore(admin,{...theCase,revision:detail.revision}),error=>error.status===409);
  assert.throws(()=>api.save(admin,selected(detail,'intake','lead_received')),error=>error.status===409);
  const external=api.detail(admin,theCase);
  assert.equal(external.testing,false); assert.equal(external.previews.sales.contractNumber,'REAL-NEXT');
  assert.throws(()=>api.restore(admin,{...theCase,revision:external.revision}),error=>error.status===409);
  assert.equal(store.progress(investor,theCase).current.node,'remanded');
  store.syncProgress([{...lead,revision:3,stage:null,node:null}]);
  const empty=api.detail(admin,lead);
  detail=api.save(admin,selected(empty,'closure','closed'));
  detail=api.restore(admin,{...lead,revision:detail.revision});
  assert.equal(detail.previews.sales.current,null); assert.equal(detail.previews.sales.sourceStatus,'');
  assert.equal(db.prepare("SELECT revision FROM company_record_progress WHERE kind='lead' AND record_id='lead-demo-a'").get().revision,3);
});

test('登记逐行测试不改变关联或原业务字段；完整下一步校验和隐私角色限制保留',t=>{
  const {store,db,admin,api,investor,sales}=fixture(t);
  db.exec(`CREATE TABLE registry_entries(entry_key TEXT PRIMARY KEY,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
    stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,filed_on TEXT,stage TEXT);
    INSERT INTO registry_entries VALUES ('raw-one',1,'测试客户','19900000001','销售 A','100%_股票','888888','','2026-01-01','2026-01-02','已结案'),
      ('raw-two',2,'测试客户','19900000001','销售 A','另外股票','999999','','2026-01-01','','');
    INSERT INTO identities(username,password,role,subjectId,name) VALUES('fixture-person','unused','investor','customer-a','客户新名');
    INSERT INTO registry_links SELECT 'investor','测试客户','19900000001',id FROM identities WHERE username='fixture-person';
    INSERT INTO registry_links SELECT 'sales','销售 A','',id FROM identities WHERE role='sales' AND subjectId='sales-a';`);
  const id=createHash('sha256').update('raw-one').digest('hex'),target={kind:'registry',id};
  const search=api.search(admin,{q:'%_'});
  assert.equal(search.total,1); assert.equal(search.items[0].id,id); assert.doesNotMatch(JSON.stringify(search),/raw-one/);
  assert.equal(search.items[0].number,'DJ-000001'); assert.equal(search.items[0].registeredOn,'2026-01-01');
  assert.equal(api.search(admin,{q:'客户新名'}).items.filter(row=>row.kind==='registry').length,2);
  const original=db.prepare('SELECT * FROM registry_entries').all(),links=db.prepare('SELECT * FROM registry_links').all();
  const initial=api.detail(admin,target);
  let detail=api.save(admin,selected(initial,'intake','signed_waiting_filing'));
  assert.equal(detail.previews.investor.steps[0].note,'待立案','测试可以覆盖原始立案日期的解释保护');
  assert.deepEqual(store.progress(investor,target),detail.previews.investor);
  assert.equal(store.userRecords(investor,{q:'888888'}).items[0].status,'已签约');
  const before=detail;
  for(const extra of [{nextStage:'filing',nextNode:''},{nextStage:'intake',nextNode:'signed_waiting_filing'},
    {stage:'closure',node:'closed',nextStage:'filing',nextNode:'preparing'},{contractNumber:'bad\nvalue'}]) {
    assert.throws(()=>api.save(admin,selected(detail,'intake','signed_waiting_filing',extra)));
    assert.deepEqual(api.detail(admin,target),before,'校验失败不改变测试或备份');
  }
  detail=api.save(admin,selected(detail,'filing','submitted',{nextStage:'first_hearing',nextNode:'awaiting_hearing'}));
  assert.equal(detail.previews.sales.steps[1].node,'awaiting_hearing');
  detail=api.restore(admin,{...target,revision:detail.revision});
  assert.equal(detail.previews.investor.current.node,'closed');
  assert.deepEqual(db.prepare('SELECT * FROM registry_entries').all(),original);
  assert.deepEqual(db.prepare('SELECT * FROM registry_links').all(),links);
  for(const actor of [investor,sales,{role:'broker',id:'broker-a'},{...admin,passwordChangeRequired:true}]) {
    for(const operation of [()=>api.options(actor),()=>api.search(actor,{q:'客户'}),()=>api.detail(actor,target),
      ()=>api.save(actor,selected(detail,'closure','closed')),()=>api.restore(actor,{...target,revision:detail.revision})]) {
      assert.throws(operation,error=>error.status===403);
    }
  }
  assert.throws(()=>api.detail(admin,{kind:'registry',id:'raw-one'}),error=>error.status===404);
});

test('测试期间公司同版重试对比原正式内容且不回滚批次，下一个正式版本始终接收',t=>{
  const {store,admin,api}=fixture(t);
  const official={...lead,revision:3,stage:'filing',node:'submitted',contractNumber:'SOURCE',completedNodes:['preparing']};
  store.syncProgress([official]);
  let detail=api.detail(admin,lead);
  for(let n=0;n<6;n++) detail=api.save(admin,selected(detail,'intake',n%2?'lead_received':'signed_waiting_filing'));
  const same=api.detail(admin,lead);
  assert.deepEqual(store.syncProgress([official,{...theCase,revision:1,stage:'appeal',node:'remanded'}]),{updated:1,unchanged:1});
  assert.equal(api.detail(admin,lead).revision,same.revision,'同版重试不改测试乐观锁');
  assert.deepEqual(api.detail(admin,lead).snapshot,same.snapshot,'同版重试不改测试快照');
  assert.equal(api.detail(admin,lead).testing,true);
  assert.throws(()=>store.syncProgress([{...official,stage:'intake',node:'lead_received',completedNodes:[],contractNumber:''}]),error=>error.status===409);
  store.syncProgress([{...official,revision:4,stage:'closure',node:'closed',completedNodes:[]}]);
  const actual=api.detail(admin,lead);assert.equal(actual.testing,false);assert.equal(actual.previews.sales.current.node,'closed');
  assert.throws(()=>api.restore(admin,{...lead,revision:detail.revision}),error=>error.status===409);
  const fresh={kind:'case',id:'case-demo-2'};
  const freshTest=api.save(admin,selected(api.detail(admin,fresh),'filing','preparing'));
  store.syncProgress([{...fresh,revision:1,stage:'appeal',node:'remanded'}]);
  assert.equal(api.detail(admin,fresh).testing,false,'原无快照时首次公司版本1也正常覆盖测试');
  assert.throws(()=>api.restore(admin,{...fresh,revision:freshTest.revision}),error=>error.status===409);
});

test('默认关闭本地测试入口，管理员视图标记和HTTP接口均尊重开关',async t=>{
  const store=createStore(':memory:',{seed:true});t.after(()=>store.close());
  const admin={role:'admin',id:'fixture-admin'};
  assert.equal(store.view(admin).progressTestEnabled,false);
  assert.throws(()=>store.adminProgressTest.options(admin),error=>error.status===403);
  assert.throws(()=>store.adminProgressTest.search(admin,{q:'甲'}),error=>error.status===403);
  const {store:active,path,credentials,beforeClose}=fixture(t);
  assert.equal(active.view(active.getSession(active.createSession(active.verifyLogin(credentials).id))).progressTestEnabled,true);
  const server=createAppServer({database:path,progressTestEnabled:false});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  beforeClose.push(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const token=active.createSession(active.verifyLogin(credentials).id);
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/progress-test/options`,{headers:{Cookie:'huzi_pc='+token}});
  assert.equal(response.status,403);await response.json();
});

test('后台HTTP测试入口使用管理员cookie、真实角色预览与409保护',async t=>{
  const {store,path,credentials,beforeClose}=fixture(t);
  const server=createAppServer({database:path,progressTestEnabled:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  beforeClose.push(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const root=`http://127.0.0.1:${server.address().port}`;
  const token=store.createSession(store.verifyLogin(credentials).id),headers={Cookie:'huzi_pc='+token};
  async function call(url,status=200,body) {
    const response=await fetch(root+'/api/admin/progress-test'+url,{method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal(response.status,status);return response.json();
  }
  assert.equal((await call('/options')).groups.length,8);
  assert.equal((await call('?q='+encodeURIComponent('示例股票甲'))).total,3);
  const detail=await call('/detail?kind=lead&id=lead-demo-a');
  const updated=await call('',200,selected(detail,'filing','supplement'));
  assert.equal(updated.previews.investor.current.label,'待您补充材料');
  assert.equal(updated.previews.sales.current.label,'待补充材料');
  await call('',409,selected(detail,'closure','closed'));
  const restored=await call('/restore',200,{...lead,revision:updated.revision});assert.equal(restored.testing,false);
  assert.equal((await fetch(root+'/api/admin/progress-test/options')).status,401);
  const business=store.createSession(store.registerInvestor({phone:'19900005555',password:'fixture-password'}));
  assert.equal((await fetch(root+'/api/progress-test/options',{headers:{Authorization:'Bearer '+business}})).status,403);
});

test('执行获赔到待支付及到账以实际快照推进，两端与后台预览一致且不提前确认到账',async t=>{
  const {store,db,admin,investor,sales,api}=fixture(t);
  const originalCases=db.prepare('SELECT * FROM cases ORDER BY id').all();
  const originalSignings=db.prepare('SELECT * FROM signings ORDER BY clientId').all();
  const phases=[
    ['enforcement','compensated','执行','获赔','获赔','待支付'],
    ['closure','pending_payment','获赔','待支付','获赔与结案','赔款已到账'],
    ['closure','payment_received','获赔与结案','赔款已到账','获赔与结案','已结案'],
    ['closure','closed','获赔与结案','已结案'],
  ];
  let revision=0;
  for(const [stage,node,title,label,nextTitle,nextLabel] of phases) {
    store.syncProgress([{...lead,revision:++revision,stage,node}]);
    const adminDetail=api.detail(admin,lead);
    for(const actor of [investor,sales]) {
      const detail=store.progress(actor,lead);
      assert.deepEqual(adminDetail.previews[actor.role],detail);
      assert.equal(detail.current.node,node);
      assert.equal(detail.current.label,label);
      assert.equal(detail.current.stageLabel,title);
      assert.equal(store.userRecords(actor,{q:'000000'}).items[0].status,label);
      assert.equal(detail.steps.length,nextLabel?2:1);
      if(nextLabel) {
        assert.equal(detail.steps[1].stageLabel,nextTitle);
        assert.equal(detail.steps[1].label,nextLabel);
        assert.equal(detail.steps[1].status,'next');
        assert.equal(detail.steps[1].date,undefined);
      }
      const html=renderRecordProgress(detail,actor.role);
      assert.ok(html.includes(`<strong>${title}</strong>`));
      assert.ok(html.includes(`class="progress-step-status">${label}`));
      if(nextLabel) assert.ok(html.split('data-step-status="next"')[1].includes(`<strong>${nextTitle}</strong>`));
      const page=nativePages({app:{globalData:{token:'isolated'}},client:{request:async()=>detail}}).page('progress');
      page.onLoad(lead); await page.onShow();
      assert.equal(page.data.detail.steps[0].title,title);
      assert.equal(page.data.detail.steps[0].statusLabel,label);
      if(nextLabel) {
        assert.equal(page.data.detail.steps[1].title,nextTitle);
        assert.equal(page.data.detail.steps[1].statusLabel,nextLabel);
        assert.equal(page.data.detail.steps[1].dateText,'');
      }
    }
  }
  assert.deepEqual(db.prepare('SELECT * FROM cases ORDER BY id').all(),originalCases);
  assert.deepEqual(db.prepare('SELECT * FROM signings ORDER BY clientId').all(),originalSignings);
});
