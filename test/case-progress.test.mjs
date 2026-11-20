import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAppServer } from '../server.mjs';
import { createStore, today } from '../store.mjs';
import { activateStoredAccount } from '../test-support/business-account.mjs';

test('旧版公司快照升级后保留节点、合同号和版本，完成证据为空', () => {
  const dir = mkdtempSync(join(tmpdir(),'huzi-progress-migration-'));
  const path = join(dir,'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE company_record_progress(kind TEXT,record_id TEXT,revision INTEGER,stage TEXT,node TEXT,
    contract_number TEXT,PRIMARY KEY(kind,record_id));
    INSERT INTO company_record_progress VALUES ('case','case-demo-2',4,'closure','closed','TEST-OLD');`);
  old.close();
  const store = createStore(path,{seed:true,cutoff:'2000-01-01'});
  try {
    const snapshot = { kind:'case',id:'case-demo-2',revision:4,stage:'closure',node:'closed',contractNumber:'TEST-OLD' };
    assert.deepEqual(store.syncProgress([snapshot]),{updated:0,unchanged:1});
    assert.deepEqual(store.syncProgress([{...snapshot,revision:5,completedNodes:['payment_received']}]),{updated:1,unchanged:0});
  } finally {
    store.close();
    unlinkSync(path);
    rmdirSync(dir);
  }
});

test('原生详情按具体留资、案件及历史行实时授权，公司快照只展示实际节点和角色允许的字段', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'huzi-progress-'));
  const path = join(dir, 'qa.sqlite');
  const credentials = { username:'ops-test',password:'password-fixture',name:'测试管理员' };
  const store = createStore(path, { seed:true,admin:credentials,cutoff:'2026-01-01' });
  const db = new DatabaseSync(path);
  const token = (username,password) => store.createSession(store.verifyLogin({username,password}).id);
  const adminToken = token(credentials.username,credentials.password);
  const admin = store.getSession(adminToken);
  const password = 'fixture-password-only';
  const investorId = store.registerInvestor({phone:'19900008001',password});
  const investor = store.createSession(investorId);
  const customer = store.getSession(investor).id;
  const unrelated = store.createSession(store.registerInvestor({phone:'19900008002',password}));
  for (const [name, username] of [['测试销售甲','sales-p1'],['测试销售乙','sales-p2']]) {
    store.openSalesAccount(admin,{name,username});
    activateStoredAccount(store, username, password);
  }
  activateStoredAccount(store, 'broker-a', 'demo-broker-a');
  const sales = token('sales-p1',password), otherSales = token('sales-p2',password);
  const salesId = store.getSession(sales).id, otherSalesId = store.getSession(otherSales).id;
  const ids = db.prepare("SELECT id FROM identities WHERE username='sales-p1'").get();
  db.exec(`CREATE TABLE registry_entries(entry_key TEXT PRIMARY KEY,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
    stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,filed_on TEXT,stage TEXT);
    INSERT INTO registry_entries VALUES('entry1',3,'测试股民','19900008001','测试销售甲','模拟股票丙','000003','','','','已结案');
    INSERT INTO registry_entries VALUES('entry2',4,'测试股民','19900008002','测试销售乙','模拟股票丁','000004','','','','');`);
  db.prepare("INSERT INTO registry_links VALUES ('sales','测试销售甲','',?)").run(ids.id);
  db.prepare("INSERT INTO registry_links VALUES ('investor','测试股民','19900008001',?)").run(investorId);
  const lead = db.prepare("INSERT INTO leads VALUES (?,?,?,'000001','测试期间',?)");
  const assign = db.prepare("INSERT INTO lead_assignments(leadId,salesId,reason,method,updatedAt) VALUES (?,?,'测试','manual','2026-11-18')");
  for (const [id,title,staff] of [['l1','模拟甲',salesId],['l2','模拟乙',otherSalesId]]) {
    lead.run(id,customer,title,new Date().toISOString()); assign.run(id,staff);
  }
  db.prepare("INSERT INTO signings VALUES (?,?,'测试签约凭据，不能显示为合同号')").run(customer,today());
  db.exec(`INSERT INTO cases VALUES('c1','l1','测试一审','2026-01-01','已受理');
    INSERT INTO cases VALUES('c2','l1','测试二审','2026-01-02','诉讼中');
    INSERT INTO cases VALUES('cold','l1','旧测试案','2025-12-01','已结案');`);
  const server = createAppServer({ database:path });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close(); db.close(); unlinkSync(path); rmdirSync(dir);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/progress?`;
  async function get(session,kind,id,status=200) {
    const response = await fetch(base + new URLSearchParams({kind,id}),{headers:session ? {Authorization:'Bearer '+session} : {}});
    assert.equal(response.status,status);
    return response.json();
  }
  const publicKey = id => createHash('sha256').update(id).digest('hex');
  const row = publicKey('entry1');
  await get(null,'registry',row,401);
  await get(adminToken,'registry',row,403);
  await get(token('broker-a','demo-broker-a'),'registry',row,403);
  await get(otherSales,'case','c1',404); await get(unrelated,'case','c1',404);
  await get(sales,'lead','l2',404);
  assert.equal((await get(sales,'case','cold')).current.label,'已结案');
  assert.equal((await get(investor,'case','cold')).current.label,'已结案');
  await get(otherSales,'case','cold',404); await get(unrelated,'case','cold',404);
  assert.throws(()=>store.saveCase(admin,{leadId:'l1',title:'不应新增旧日期案件',openedOn:'2025-12-01',status:'已受理'}),/新增案件/);
  assert.throws(()=>store.saveCase(admin,{id:'cold',status:'已受理'}),error=>error.status===404);
  assert.ok(store.userRecords(store.getSession(sales),{q:'模拟甲'}).items[0].cases.some(row=>row.id==='cold'));
  assert.ok(store.salesBoard(store.getSession(sales),{metric:'closed'}).items.some(row=>row.progressId==='cold'));
  assert.ok(store.view(store.getSession(investor)).leads.find(row=>row.id==='l1').cases.some(row=>row.id==='cold'));
  assert.ok(store.view(store.getSession(sales)).assignedLeads.find(row=>row.id==='l1').cases.some(row=>row.id==='cold'));
  await get(investor,'registry',publicKey('entry2'),404);
  await get(investor,'registry','entry1',404);
  assert.equal((await get(investor,'registry',row)).current.label,'已结案');
  const initial = await get(investor,'lead','l1');
  assert.deepEqual(initial.relatedCases.map(c=>c.id),['c2','c1','cold']);
  assert.equal(initial.current,null);
  assert.equal(initial.sourceStatus,'诉讼中','已有案件时不回退到已留资或已签约');
  assert.equal(initial.displayProgress.current.label,'诉讼中');
  assert.equal(initial.displayProgress.steps[0].date,undefined,'继承案件不借用父留资或案件登记日期');
  assert.equal((await get(investor,'lead','l2')).current,null);
  assert.equal((await get(investor,'lead','l2')).sourceStatus,'签约对应记录待核对');
  assert.equal('signedOn' in (await get(investor,'lead','l2')),false);
  assert.equal(store.userRecords(store.getSession(investor),{q:'模拟乙'}).items[0].status,(await get(investor,'lead','l2')).sourceStatus);
  for (const invalid of ['2999-01-01','2026-02-30']) {
    db.prepare('UPDATE signings SET signedOn=? WHERE clientId=?').run(invalid,customer);
    const unsigned=await get(investor,'lead','l2');
    assert.equal(unsigned.current.node,'lead_received'); assert.equal('signedOn' in unsigned,false);
    assert.equal(store.userRecords(store.getSession(investor),{q:'模拟乙'}).items[0].status,'已留资');
  }
  db.prepare('UPDATE signings SET signedOn=? WHERE clientId=?').run(today(),customer);
  const coarse = await get(investor,'case','c2');
  assert.equal(coarse.current,null);
  assert.equal(coarse.sourceStatus,'诉讼中');
  assert.deepEqual(coarse.steps,[]);
  assert.equal(coarse.displayProgress.steps[0].label,'诉讼中');
  assert.equal(coarse.displayProgress.steps[0].status,'current');
  assert.equal('contractNumber' in await get(sales,'case','c1'),false);
  const snapshot = (kind,id,revision,stage,node,contractNumber) => ({kind,id,revision,stage,node,contractNumber});
  const first = snapshot('case','c1',1,'filing','supplement','FIXTURE-C1');
  const second = snapshot('case','c2',1,'appeal','remanded');
  assert.deepEqual(store.syncProgress([first,second]),{updated:2,unchanged:0});
  assert.deepEqual(store.syncProgress([first,second]),{updated:0,unchanged:2});
  const clientDetail = await get(investor,'case','c1');
  assert.equal(clientDetail.current.label,'待您补充材料');
  assert.equal(clientDetail.displayProgress,undefined,'正式节点不进入展示兜底');
  assert.deepEqual(clientDetail.steps.map(step => step.status),['current','next']);
  assert.doesNotMatch(JSON.stringify(clientDetail),/contract|FIXTURE-C1|凭据/i);
  const salesDetail = await get(sales,'case','c1');
  assert.equal(salesDetail.current.label,'待补充材料');
  assert.equal(salesDetail.steps.find(step => step.status === 'current').label,'待补充材料');
  assert.equal(salesDetail.contractNumber,'FIXTURE-C1');
  assert.equal((await get(investor,'case','c2')).current.label,'案件已发回重审');
  assert.throws(() => store.syncProgress([{...first,revision:2,node:'submitted'},{...second,node:'awaiting_hearing'}]),/版本/);
  assert.equal((await get(investor,'case','c1')).current.label,'待您补充材料');
  const evidenced = { ...first, revision:2, completedNodes:['preparing','submitted'] };
  assert.deepEqual(store.syncProgress([evidenced]),{updated:1,unchanged:0});
  assert.deepEqual(store.syncProgress([{...evidenced,completedNodes:['submitted','preparing','submitted']}]),{updated:0,unchanged:1});
  assert.throws(() => store.syncProgress([{...evidenced,completedNodes:[]}]),/版本/);
  assert.throws(() => store.syncProgress([{...evidenced,revision:3}, {...second, revision:2, completedNodes:['closed']}]),/属于当前阶段/);
  assert.deepEqual((await get(investor,'case','c1')).steps.map(s=>[s.node,s.status]),[
    ['supplement','current'],['submitted','next'],
  ]);
  assert.deepEqual(store.syncProgress([{...first, revision:3}]), {updated:1,unchanged:0});
  assert.ok(!(await get(investor,'case','c1')).steps.some(s=>s.status==='completed'));
  store.syncProgress([snapshot('lead','l1',1,'intake','signed_waiting_filing'),snapshot('lead','l2',1,'intake','signed_waiting_filing')]);
  assert.equal((await get(investor,'lead','l1')).current.label,'已签约');
  assert.deepEqual((await get(investor,'lead','l1')).steps.map(s=>[s.node,s.status]), [['signed','current'],['pending_route','next']]);
  assert.equal((await get(investor,'lead','l2')).current.node,'signed_waiting_filing');
  assert.equal((await get(otherSales,'lead','l2')).current.label,'已签约');
  db.exec("ALTER TABLE registry_entries ADD COLUMN progress_stage TEXT; ALTER TABLE registry_entries ADD COLUMN progress_node TEXT; ALTER TABLE registry_entries ADD COLUMN contract_number TEXT;");
  db.exec("UPDATE registry_entries SET progress_stage='debt_claim',progress_node='supplement',contract_number='FIXTURE-REG' WHERE entry_key='entry1'");
  assert.equal((await get(investor,'registry',row)).current.label,'待补充材料');
  assert.doesNotMatch(JSON.stringify(await get(investor,'registry',row)),/contract|FIXTURE-REG/i);
  assert.equal((await get(sales,'registry',row)).contractNumber,'FIXTURE-REG');
  db.exec("UPDATE registry_entries SET progress_stage='intake',progress_node='signed_waiting_filing',filed_on='2026-01-01',stage='' WHERE entry_key='entry1'");
  for(const session of [investor,sales]) {
    const filed=await get(session,'registry',row);
    assert.equal(filed.current.node,'signed'); assert.equal(filed.steps[0].note,undefined);
    assert.equal(filed.filedOn,'2026-01-01');
    assert.equal(store.userRecords(store.getSession(session),{q:'000003'}).items[0].status,filed.current.label);
  }
  for(const invalid of ['2026-02-30','2999-01-01']) {
    db.prepare("UPDATE registry_entries SET filed_on=? WHERE entry_key='entry1'").run(invalid);
    for(const session of [sales,investor]) {
      const result=await get(session,'registry',row);
      assert.equal(result.filedOn,undefined,'详情头部不显示无效或未来立案日');
      assert.ok(result.steps.every(step=>step.date===undefined));
    }
  }
  db.prepare("UPDATE registry_entries SET filed_on=? WHERE entry_key='entry1'").run('2026-01-01');
  store.syncProgress([snapshot('registry','entry1',4,null,null)]);
  const cleared = await get(sales,'registry',row);
  assert.equal(cleared.current,null); assert.equal(cleared.sourceStatus,''); assert.equal('contractNumber' in cleared,false);
  assert.deepEqual(cleared.steps,[]);
  assert.equal(cleared.displayProgress.current.uncertain,true);
  assert.equal(cleared.displayProgress.steps.length,1);
  assert.equal(cleared.displayProgress.steps[0].hideDate,true);
  assert.throws(() => store.syncProgress([snapshot('registry','entry1',3,'closure','closed')]),/版本/);
  store.syncProgress([snapshot('lead','l1',2,null,null)]);
  assert.equal((await get(investor,'lead','l1')).current,null,'显式清空优先于签约和已有案件');
  assert.equal((await get(investor,'lead','l1')).sourceStatus,'');
  assert.equal(store.userRecords(store.getSession(investor),{q:'模拟甲'}).items[0].status,'进度待核对');
  db.prepare("UPDATE lead_assignments SET salesId=? WHERE leadId='l1'").run(otherSalesId);
  await get(sales,'case','c1',404);
  assert.equal((await get(otherSales,'case','c1')).contractNumber,'FIXTURE-C1');
  db.exec("DELETE FROM registry_links WHERE type='sales'");
  await get(sales,'registry',row,404);
  db.exec("UPDATE identities SET passwordChangeRequired=1 WHERE username='sales-p2'");
  await get(otherSales,'case','c1',403);
});

test('同日多案按同一排序选当前、下一步和销售合同，未来案件不混入且自有空合同优先',t=>{
  const dir=mkdtempSync(join(tmpdir(),'huzi-progress-order-')),path=join(dir,'qa.sqlite');
  const store=createStore(path,{seed:true,cutoff:'2000-01-01'}),db=new DatabaseSync(path);
  t.after(()=>{store.close();db.close();unlinkSync(path);rmdirSync(dir);});
  db.exec("UPDATE cases SET title='Zeta' WHERE id='case-demo-1'; UPDATE cases SET title='Alpha' WHERE id='case-demo-2'; UPDATE lead_assignments SET salesId='sales-a' WHERE leadId='lead-demo-a'");
  db.exec("INSERT INTO cases VALUES ('future','lead-demo-a','A future','2999-01-01','已结案'); INSERT INTO cases VALUES ('undated','lead-demo-a','A undated','','已结案')");
  const first={kind:'case',id:'case-demo-1',revision:1,stage:'filing',node:'submitted',contractNumber:'CONTRACT-Z',nextStage:'first_hearing',nextNode:'awaiting_hearing'};
  const second={kind:'case',id:'case-demo-2',revision:1,stage:'appeal',node:'awaiting_hearing',contractNumber:'CONTRACT-A',nextStage:'appeal',nextNode:'awaiting_judgment'};
  store.syncProgress([first,second]);
  for(const actor of [{role:'investor',id:'customer-a'},{role:'sales',id:'sales-a'}]) {
    const detail=store.progress(actor,{kind:'lead',id:'lead-demo-a'}),record=store.userRecords(actor,{q:'示例股票甲'}).items[0];
    assert.equal(detail.current.stage,'appeal'); assert.equal(detail.steps[1].node,'awaiting_judgment');
    assert.deepEqual(detail.relatedCases.map(row=>row.id),['case-demo-2','case-demo-1','undated']);
    assert.deepEqual(record.cases.map(row=>row.id),detail.relatedCases.map(row=>row.id));
    assert.equal(record.status,detail.current.label);
    if(actor.role==='sales') assert.equal(detail.contractNumber,'CONTRACT-A');
    else assert.doesNotMatch(JSON.stringify(detail),/contract|CONTRACT-/i);
  }
  const sales={role:'sales',id:'sales-a'};
  store.syncProgress([{kind:'lead',id:'lead-demo-a',revision:1,stage:'intake',node:'signed',contractNumber:''}]);
  assert.equal('contractNumber' in store.progress(sales,{kind:'lead',id:'lead-demo-a'}),false);
  store.syncProgress([{kind:'lead',id:'lead-demo-a',revision:2,stage:null,node:null,contractNumber:''}]);
  assert.equal(store.progress(sales,{kind:'lead',id:'lead-demo-a'}).current,null);
  assert.equal('contractNumber' in store.progress(sales,{kind:'lead',id:'lead-demo-a'}),false);
});


test('公司确认的下一路线按完整快照版本保存，缺省清空且只跟随当前来源记录', t=>{
  const store=createStore(':memory:',{seed:true,cutoff:'2000-01-01'});
  t.after(()=>store.close());
  const investor={role:'investor',id:'customer-a'},other={role:'investor',id:'customer-b'};
  const route={kind:'case',id:'case-demo-1',revision:1,stage:'filing',node:'submitted',nextStage:'first_hearing',nextNode:'awaiting_hearing'};
  const otherRoute={kind:'case',id:'case-demo-2',revision:1,stage:'enforcement',node:'compensated',nextStage:'closure',nextNode:'payment_received'};
  assert.deepEqual(store.syncProgress([route,otherRoute]),{updated:2,unchanged:0});
  assert.deepEqual(store.syncProgress([route]),{updated:0,unchanged:1});
  const direct=store.progress(investor,{kind:'case',id:'case-demo-1'});
  assert.deepEqual(direct.steps.map(row=>[row.stage,row.node,row.status]),[['filing','submitted','current'],['first_hearing','awaiting_hearing','next']]);
  const lead=store.progress(investor,{kind:'lead',id:'lead-demo-a'});
  assert.deepEqual(lead.steps,direct.steps,'lead取当前关联case的路线，不串另一个case的next');
  assert.equal(lead.current.stage,'filing','实际签约不覆盖更先进的案件状态');
  assert.equal(store.userRecords(investor,{q:'示例股票甲'}).items[0].status,lead.current.label);
  assert.throws(()=>store.progress(other,{kind:'lead',id:'lead-demo-a'}),error=>error.status===404);
  assert.throws(()=>store.syncProgress([{...route,nextNode:'awaiting_judgment'}]),error=>error.status===409);
  for(const next of [{nextStage:'filing',nextNode:''},{nextStage:'filing',nextNode:'submitted'},
    {nextStage:'missing',nextNode:'missing'},{stage:'closure',node:'closed',nextStage:'filing',nextNode:'preparing'},
    {stage:null,node:null,nextStage:'filing',nextNode:'preparing'}]) {
    assert.throws(()=>store.syncProgress([{...route,revision:2,...next}]),/下一步/);
  }
  assert.deepEqual(store.progress(investor,{kind:'case',id:'case-demo-1'}).steps,direct.steps,'拒绝的同步不改变旧快照');
  store.syncProgress([{...route,revision:2,nextStage:'filing',nextNode:'supplement'}]);
  assert.equal(store.progress(investor,{kind:'case',id:'case-demo-1'}).steps[1].label,'待您补充材料','明确的补件路线优先于默认的一审预告');
  const {nextStage,nextNode,...withoutRoute}=route;
  store.syncProgress([{...withoutRoute,revision:3}]);
  for(const record of [{kind:'case',id:'case-demo-1'},{kind:'lead',id:'lead-demo-a'}]) {
    assert.deepEqual(store.progress(investor,record).steps.map(row=>[row.stage,row.node,row.status]),
      [['filing','submitted','current'],['first_hearing','awaiting_hearing','next']],
      '清空明确路线后使用默认一审预告，当前仍为已提交立案');
  }
  store.syncProgress([{...withoutRoute,revision:4,nextStage:null,nextNode:null}]);
  assert.equal(store.progress(investor,{kind:'case',id:'case-demo-1'}).steps[1].node,'awaiting_hearing');
  store.syncProgress([{kind:'case',id:'case-demo-1',revision:5,stage:null,node:null}]);
  assert.equal(store.progress(investor,{kind:'lead',id:'lead-demo-a'}).current,null,'关联case显式清空不得退回实际签约');
  assert.equal(store.userRecords(investor,{q:'示例股票甲'}).items[0].status,'进度待核对');
});

test('客户签约只回退到当时唯一股票，跨销售和明确关联登记参与核验但不泄露记录',t=>{
  const dir=mkdtempSync(join(tmpdir(),'huzi-signing-scope-')),path=join(dir,'qa.sqlite');
  const store=createStore(path,{seed:true,cutoff:'2000-01-01'}),db=new DatabaseSync(path);
  t.after(()=>{store.close();db.close();unlinkSync(path);rmdirSync(dir);});
  const investor={role:'investor',id:'customer-a'},sales={role:'sales',id:'sales-a'},otherSales={role:'sales',id:'sales-b'};
  db.exec(`DELETE FROM case_numbers; DELETE FROM cases;
    UPDATE leads SET createdAt='2026-01-01'; UPDATE clients SET name='同名客户';
    UPDATE lead_assignments SET salesId='sales-a' WHERE leadId='lead-demo-a';
    UPDATE signings SET signedOn='2026-01-10' WHERE clientId='customer-a';`);
  const check=(actor,id,node,status)=>{
    const detail=store.progress(actor,{kind:'lead',id}),row=store.userRecords(actor).items.find(item=>item.progressId===id);
    assert.equal(detail.current?.node ?? null,node); assert.equal(row.status,status);
    assert.equal(detail.current?.label || detail.sourceStatus,status);
    return {detail,row};
  };
  assert.equal(check(sales,'lead-demo-a','signed_waiting_filing','已签约').detail.signedOn,'2026-01-10');
  assert.equal(check(investor,'lead-demo-a','signed_waiting_filing','已签约').row.signedOn,'2026-01-10');
  const add=(id,date)=>{
    db.prepare("INSERT INTO leads VALUES (?,'customer-a',?,'555555','测试',?)").run(id,id,date);
    db.prepare("INSERT INTO lead_assignments(leadId,salesId,reason,method,updatedAt) VALUES (?,'sales-b','测试','manual','2026-01-01')").run(id);
  };
  add('later-stock','2026-01-11');
  check(sales,'lead-demo-a','signed_waiting_filing','已签约');
  const later=check(otherSales,'later-stock','lead_received','已留资');
  assert.equal('signedOn' in later.detail,false); assert.equal('signedOn' in later.row,false);
  add('same-day-stock','2026-01-10T05:00:00Z');
  for(const actor of [investor,sales]) {
    const ambiguous=check(actor,'lead-demo-a',null,'签约对应记录待核对');
    assert.equal('signedOn' in ambiguous.detail,false); assert.equal('signedOn' in ambiguous.row,false);
  }
  assert.equal(store.userRecords(sales).items.some(row=>row.stockName==='same-day-stock'),false);
  check(otherSales,'same-day-stock',null,'签约对应记录待核对');
  db.exec("UPDATE leads SET createdAt='2026-01-09' WHERE id='same-day-stock'");
  check(sales,'lead-demo-a',null,'签约对应记录待核对');
  store.syncProgress([{kind:'lead',id:'lead-demo-a',revision:1,stage:'intake',node:'signed'}]);
  check(sales,'lead-demo-a','signed','已签约');
  db.exec("DELETE FROM company_record_progress WHERE kind='lead' AND record_id='lead-demo-a'; DELETE FROM lead_assignments WHERE leadId='same-day-stock'; DELETE FROM leads WHERE id='same-day-stock'");
  check(sales,'lead-demo-a','signed_waiting_filing','已签约');
  db.exec(`CREATE TABLE registry_entries(entry_key TEXT PRIMARY KEY,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
    stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,filed_on TEXT,stage TEXT);
    INSERT INTO registry_entries VALUES('candidate',1,'同名客户','19900000002','外部经办','历史股票','888888','','','','');
    INSERT INTO identities(username,password,role,subjectId,name) VALUES ('fixture-person-a','unused','investor','customer-a','同名客户'),('fixture-person-b','unused','investor','customer-b','同名客户');
    INSERT INTO registry_links SELECT 'investor','同名客户','19900000002',id FROM identities WHERE username='fixture-person-b';`);
  check(sales,'lead-demo-a','signed_waiting_filing','已签约');
  db.exec("UPDATE registry_links SET identity_id=(SELECT id FROM identities WHERE username='fixture-person-a') WHERE type='investor'");
  check(sales,'lead-demo-a',null,'签约对应记录待核对');
  assert.equal(store.userRecords(sales).items.some(row=>row.stockName==='历史股票'),false);
  db.exec("UPDATE registry_entries SET registered_on='2026-01-11'");
  check(sales,'lead-demo-a','signed_waiting_filing','已签约');
  db.exec("UPDATE registry_entries SET registered_on='2026-01-10'");
  check(sales,'lead-demo-a',null,'签约对应记录待核对');
  db.exec("DELETE FROM signings WHERE clientId='customer-a'");
  check(sales,'lead-demo-a','lead_received','已留资');
});

test('节点日期只来自对应真实事件，测试状态和继承案件不借用登记或签约日期', t=>{
  const dir=mkdtempSync(join(tmpdir(),'huzi-progress-dates-')),path=join(dir,'qa.sqlite');
  const store=createStore(path,{seed:true,cutoff:'2000-01-01',progressTestEnabled:true}),db=new DatabaseSync(path);
  t.after(()=>{store.close();db.close();unlinkSync(path);rmdirSync(dir);});
  const investor={role:'investor',id:'customer-a'},sales={role:'sales',id:'sales-a'},admin={role:'admin',id:'qa'};
  const lead={kind:'lead',id:'lead-demo-a'},api=store.adminProgressTest;
  db.exec(`DELETE FROM case_numbers; DELETE FROM cases;
    UPDATE lead_assignments SET salesId='sales-a' WHERE leadId='lead-demo-a';
    UPDATE leads SET createdAt='2026-01-01T16:30:00Z' WHERE id='lead-demo-a';
    UPDATE signings SET signedOn='2026-01-10' WHERE clientId='customer-a';`);
  for(const actor of [investor,sales]) {
    const detail=store.progress(actor,lead);
    assert.equal(detail.steps[0].date,'2026-01-10');assert.equal(detail.steps[0].dateLabel,'签约日期');
    assert.equal(detail.steps[1].date,undefined,'下一阶段不借用当前日期');
  }
  store.syncProgress([{...lead,revision:1,stage:'intake',node:'lead_received'}]);
  assert.equal(store.progress(investor,lead).steps[0].date,'2026-01-02','留资时间转换为上海日期');
  assert.equal(store.progress(investor,lead).steps[0].dateLabel,'留资日期');
  let detail=api.detail(admin,lead);
  for(const [stage,node] of [['filing','submitted'],['intake','signed_waiting_filing'],['intake','lead_received']]) {
    detail=api.save(admin,{...lead,revision:detail.revision,stage,node});
    for(const role of ['investor','sales']) assert.equal(detail.previews[role].steps[0].date,undefined,'测试节点不继承真实日期');
  }
  api.restore(admin,{...lead,revision:detail.revision});
  assert.equal(store.progress(investor,lead).steps[0].date,'2026-01-02');
  db.exec("UPDATE leads SET createdAt='2026-02-30T12:00:00Z' WHERE id='lead-demo-a'");
  assert.equal(store.progress(investor,lead).steps[0].date,undefined,'不把非法创建日期规范化成另一天');
  assert.equal(store.progress(investor,lead).createdOn,undefined);
  db.exec("UPDATE leads SET createdAt='2026-01-01T16:30:00Z' WHERE id='lead-demo-a'");
  db.exec("DELETE FROM company_record_progress WHERE kind='lead'; INSERT INTO cases VALUES('inherited','lead-demo-a','继承状态','2026-01-05','');");
  store.syncProgress([{kind:'case',id:'inherited',revision:1,stage:'intake',node:'signed'}]);
  for(const actor of [investor,sales]) {
    assert.equal(store.progress(actor,lead).current.label,'已签约');
    assert.equal(store.progress(actor,lead).steps[0].date,undefined,'继承案件不借用父留资的签约日期');
    assert.equal(store.progress(actor,{kind:'case',id:'inherited'}).steps[0].date,undefined,'案件登记日期不是签约日期');
  }
  db.exec(`CREATE TABLE registry_entries(entry_key TEXT PRIMARY KEY,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
    stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,filed_on TEXT,stage TEXT);
    INSERT INTO registry_entries VALUES('dated',1,'测试客户','19900000003','测试销售','测试股票','111111','','2026-01-01','2026-01-20','');`);
  const entry={kind:'registry',id:createHash('sha256').update('dated').digest('hex')};
  store.syncProgress([{kind:'registry',id:'dated',revision:1,stage:'filing',node:'submitted'}]);
  detail=api.detail(admin,entry);
  for(const role of ['investor','sales']) {
    assert.equal(detail.previews[role].steps[0].date,'2026-01-20');
    assert.equal(detail.previews[role].steps[0].dateLabel,'立案日期');
    assert.equal(detail.previews[role].filedOn,'2026-01-20');
    assert.equal(detail.previews[role].steps[1].date,undefined);
  }
  detail=api.save(admin,{...entry,revision:detail.revision,stage:'filing',node:'submitted'});
  assert.equal(detail.previews.investor.steps[0].date,undefined,'历史立案日不作为本次测试日期');
  api.restore(admin,{...entry,revision:detail.revision});
  for(const invalid of ['','2026-02-30','2999-01-01']) {
    db.prepare("UPDATE registry_entries SET filed_on=? WHERE entry_key='dated'").run(invalid);
    const previews=api.detail(admin,entry).previews;
    for(const role of ['investor','sales']) {
      assert.equal(previews[role].steps[0].date,undefined,'缺失、无效和未来日期不显示');
      assert.equal(previews[role].filedOn,undefined,'后台两角色预览顶部与节点采用同一日期校验');
    }
  }
});
