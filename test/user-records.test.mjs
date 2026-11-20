import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createUserRecords } from '../user-records.mjs';
import { createSalesBoard } from '../sales-board.mjs';
import { createBrokerBoard } from '../broker-board.mjs';
import { RequestError, createStore } from '../store.mjs';
import { createAppServer } from '../server.mjs';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activateStoredAccount } from '../test-support/business-account.mjs';
import { summarizeProgress } from '../board-progress.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(()=>db.close());
  db.exec(`CREATE TABLE clients(id TEXT,name TEXT,phone TEXT,brokerId TEXT,createdAt TEXT);
    CREATE TABLE identities(id INTEGER,role TEXT,subjectId TEXT,status TEXT);
    CREATE TABLE signings(clientId TEXT,signedOn TEXT);
    CREATE TABLE brokers(id TEXT,name TEXT,salesId TEXT,signedOn TEXT);
    CREATE TABLE sales_staff(id TEXT,name TEXT);
    CREATE TABLE leads(id TEXT,clientId TEXT,stockName TEXT,stockCode TEXT,createdAt TEXT);
    CREATE TABLE lead_assignments(leadId TEXT,salesId TEXT,version INTEGER,contactName TEXT,contactPhone TEXT);
    CREATE TABLE lead_followups(id TEXT,leadId TEXT,salesId TEXT,assignmentVersion INTEGER,note TEXT,createdAt TEXT);
    CREATE TABLE cases(id TEXT,leadId TEXT,title TEXT,status TEXT,openedOn TEXT);
    CREATE TABLE registry_entries(entry_key TEXT,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
      stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,stage TEXT,progress_stage TEXT,progress_node TEXT);
    CREATE TABLE registry_links(type TEXT,source_name TEXT,source_phone TEXT,identity_id INTEGER);
    CREATE TABLE company_record_progress(kind TEXT,record_id TEXT,stage TEXT,node TEXT,completed_nodes TEXT);
    INSERT INTO clients VALUES ('client-a','小盒','19900001001','broker-a','2026-11-01'),
      ('client-b','同名客户','19900001002','broker-b','2026-11-01'),('prospect','尚未留资','19900001003','broker-a','2026-11-02');
    INSERT INTO identities VALUES (1,'investor','client-a','active'),(2,'investor','client-b','active'),
      (3,'sales','sales-a','active'),(4,'sales','sales-b','active'),(5,'broker','broker-a','active');
    INSERT INTO sales_staff VALUES ('sales-a','销售甲'),('sales-b','销售乙');
    INSERT INTO brokers VALUES ('broker-a','共同来源','sales-a','2026-11-01'),('broker-b','别的来源','sales-b','2026-11-01');
    INSERT INTO leads VALUES ('lead-a','client-a','ANT','999999','2026-11-15T06:00:00Z'),
      ('lead-b','client-b','不能看股票','000002','2026-11-14'),('transferred','client-a','已转派股票','000003','2026-11-16');
    INSERT INTO lead_assignments VALUES ('lead-a','sales-a',2,'小盒','19900001001'),
      ('lead-b','sales-b',1,'同名客户','19900001002'),('transferred','sales-b',1,'小盒','19900001001');
    INSERT INTO lead_followups VALUES ('old-follow','lead-a','sales-b',1,'旧经办说明','2026-11-14');
    INSERT INTO cases VALUES ('case-a','lead-a','ANT索赔','已受理','2026-11-18'),
      ('old-case','lead-a','分界前示例案件','已结案','2020-01-01'),('other-case','lead-b','不能看案件','已结案','2026-11-19');
    INSERT INTO registry_entries VALUES ('raw-secret-key-a',1,'小盒','19900001001','销售甲','登记股票','000004','共同来源','2025-04-01','已结案','',''),
      ('raw-secret-key-b',2,'同名客户','19900001002','销售乙','不能看登记','000005','共同来源','2025-04-01','已结案','',''),
      ('raw-secret-key-c',3,'小盒','19900001001','销售甲','100%_股票','000006','共同来源','','已受理','',''),
      ('raw-secret-key-unlinked',4,'未关联客户','19900001004','销售甲','未关联股民股票','000007','共同来源','2026-11-01','已受理','','');
    INSERT INTO registry_links VALUES ('sales','销售甲','',3),('sales','销售乙','',4),
      ('investor','小盒','19900001001',1),('investor','同名客户','19900001002',2);
    ALTER TABLE identities ADD COLUMN name TEXT;`);
  const context = {transaction:fn=>fn(),today:()=> '2026-11-20',caseCutoff:'2026-01-01',
    requireValue(ok,message,status=400) { if(!ok) throw new RequestError(status,message); }};
  const records = createUserRecords(db,context), board = createSalesBoard(db,context);
  const sales = {role:'sales',id:'sales-a'}, investor={role:'investor',id:'client-a'}, broker={role:'broker',id:'broker-a'};
  return {db,records,board,sales,investor,broker,brokerBoard:createBrokerBoard(db,{...context,userRecords:records})};
}

test('客户与已签约卡片按所选股票聚合实际进度，同进度合并且异进度不代替全客户', t => {
  const {db,records,board,sales,broker,brokerBoard}=fixture(t);
  db.exec(`INSERT INTO signings VALUES ('client-a','2026-11-19');
    INSERT INTO company_record_progress VALUES ('case','case-a','first_hearing','awaiting_hearing','[]');
    UPDATE registry_entries SET stage='已立案未开庭' WHERE entry_key='raw-secret-key-a'`);
  const stock = {period:'custom',from:'2026-11-15',to:'2026-11-15'};
  for (const metric of ['customers','effective']) {
    const all = board(sales,{metric}).items.find(row=>row.title==='小盒');
    assert.equal(all.status,'多个案件进度'); assert.equal(all.signingStatus,'已签约');
    const card=board(sales,{...stock,metric}).items[0];
    assert.equal(card.status,'一审待开庭'); assert.equal(card.recordCount,1);
    assert.equal(card.status,records(sales,{...stock,customerId:card.id}).items[0].status);
    const brokerCard=brokerBoard(broker,{...stock,metric,ledger:'signed'}).items[0];
    assert.equal(brokerCard.status,card.status); assert.equal(brokerCard.signingStatus,'已签约');
  }
  const historical={period:'custom',from:'2025-04-01',to:'2025-04-01',metric:'effective'};
  assert.equal(board(sales,historical).items[0].status,'已立案未开庭');
  assert.equal(brokerBoard(broker,historical).items[0].status,'已立案未开庭');
  db.exec("UPDATE registry_entries SET progress_stage='first_hearing',progress_node='awaiting_hearing' WHERE customer='小盒'");
  assert.equal(board(sales,{metric:'effective'}).items.find(row=>row.title==='小盒').status,'一审待开庭');
  assert.equal(brokerBoard(broker,{metric:'signings',period:'custom',from:'2026-11-19',to:'2026-11-19'}).items[0].status,
    '多个案件进度','按签约事件筛选的客户卡汇总其全部股票，与全部股票下钻一致');
  assert.equal(summarizeProgress([]),'进度待核对');
  assert.equal(summarizeProgress(['执行中','执行中']),'执行中');
  assert.equal(summarizeProgress(['执行中','']),'多个案件进度');
});

test('无效 ISO 登记日只计入全部，看板与股票记录不会将其归到下个月', t => {
  const {db,records,board,sales,broker,brokerBoard}=fixture(t);
  db.exec(`UPDATE leads SET createdAt='2026-02-30T00:00:00Z' WHERE id='lead-a';
    UPDATE registry_entries SET registered_on='2026-02-30T00:00:00Z' WHERE entry_key='raw-secret-key-a'`);
  const rolledOver = {period:'custom',from:'2026-03-02',to:'2026-03-02'};
  for (const [actor,customerBoard] of [[sales,board],[broker,brokerBoard]]) {
    const all = customerBoard(actor,{metric:'customers'});
    const customer = all.items.find(row=>row.title==='小盒');
    const details = records(actor,{customerId:customer.id});
    assert.equal(customer.recordCount,details.total);
    assert.equal(customer.unknownDate,true);
    for (const stock of ['ANT','登记股票']) {
      assert.equal(details.items.find(row=>row.stockName===stock).registeredOn,'');
    }
    assert.equal(customerBoard(actor,{...rolledOver,metric:'customers'}).total,0);
    assert.equal(records(actor,{...rolledOver,customerId:customer.id}).total,0);
  }
});

test('看板与统一记录采用最新授权案件，未来案件不抢进度且最新或父快照清空不回退', t => {
  const {db,records,board,sales,broker,brokerBoard}=fixture(t);
  db.exec(`INSERT INTO signings VALUES ('client-a','2026-11-19');
    INSERT INTO cases VALUES ('latest-case','lead-a','最新案','已受理','2026-11-19'),
      ('future-case','lead-a','未来案','已结案','2099-01-01');
    INSERT INTO company_record_progress VALUES ('case','case-a','enforcement','in_progress','[]'),
      ('case','latest-case','first_hearing','awaiting_hearing','[]')`);
  const input={period:'custom',from:'2026-11-15',to:'2026-11-15',metric:'effective'};
  const check = expected => {
    assert.equal(board(sales,input).items[0].status,expected);
    assert.equal(brokerBoard(broker,input).items[0].status,expected);
    for (const actor of [sales,broker]) assert.equal(records(actor,input).items[0].status,expected);
    assert.equal(board(sales,input).total,1); assert.equal(brokerBoard(broker,input).total,1);
  };
  check('一审待开庭');
  assert.equal(brokerBoard(broker,{metric:'ongoing'}).items.find(row=>row.id==='latest-case').status,'一审待开庭');
  db.exec("UPDATE company_record_progress SET stage='',node='' WHERE record_id='latest-case'");
  check('进度待核对');
  db.exec(`UPDATE company_record_progress SET stage='first_hearing',node='awaiting_hearing' WHERE record_id='latest-case';
    INSERT INTO company_record_progress VALUES ('lead','lead-a','','','[]')`);
  check('进度待核对');
  db.exec(`ALTER TABLE company_record_progress ADD COLUMN testing INTEGER DEFAULT 0;
    ALTER TABLE company_record_progress ADD COLUMN contract_number TEXT DEFAULT '';
    UPDATE company_record_progress SET stage='intake',node='signed_waiting_filing',testing=1,contract_number='PRIVATE-CONTRACT'
      WHERE kind='lead' AND record_id='lead-a'`);
  check('已签约');
  assert.doesNotMatch(JSON.stringify(brokerBoard(broker,input).items),/PRIVATE-CONTRACT|19900001001|progressId|"kind"|testing|completedNodes/);
  assert.doesNotMatch(JSON.stringify(board(sales,input)),/PRIVATE-CONTRACT|testing|completedNodes/);
  db.exec("UPDATE company_record_progress SET testing=0 WHERE kind='lead' AND record_id='lead-a'");
  check('已签约');
});

test('签约客户新增股票不继承旧签约进度，多候选待核对但已签约人数不受角标影响', t => {
  const {db,records,board,sales,broker,brokerBoard}=fixture(t);
  db.exec(`INSERT INTO clients VALUES ('scope','签约范围客户','19900002001','broker-a','2026-11-01');
    INSERT INTO leads VALUES ('before-sign','scope','签约时唯一股票','600001','2026-11-10'),
      ('after-sign','scope','签约后新增股票','600002','2026-11-20');
    INSERT INTO lead_assignments VALUES ('before-sign','sales-a',1,NULL,NULL),('after-sign','sales-a',1,NULL,NULL);
    INSERT INTO signings VALUES ('scope','2026-11-15')`);
  const day = date => ({period:'custom',from:date,to:date,metric:'effective'});
  for (const [date,status] of [['2026-11-10','已签约'],['2026-11-20','已留资']]) {
    assert.equal(board(sales,day(date)).items[0].status,status);
    assert.equal(brokerBoard(broker,day(date)).items[0].status,status);
    assert.equal(records(sales,day(date)).items[0].status,status);
  }
  const beforeCount=board(sales,{metric:'effective'}).total;
  db.exec(`INSERT INTO leads VALUES ('second-before-sign','scope','同日另一股票','600003','2026-11-10');
    INSERT INTO lead_assignments VALUES ('second-before-sign','sales-a',1,NULL,NULL)`);
  const card=board(sales,day('2026-11-10')).items[0];
  assert.equal(card.status,'签约对应记录待核对'); assert.equal(card.signingStatus,'已签约');
  assert.equal(card.recordCount,2); assert.equal(board(sales,{metric:'effective'}).total,beforeCount);
  assert.equal(brokerBoard(broker,{...day('2026-11-10'),ledger:'signed'}).items[0].status,card.status);
});

test('统一股票记录同时包含本人两类资料，销售可一次搜索新留资和登记，客户卡ID完全对齐', t=>{
  const {records,board,sales,investor}=fixture(t);
  const own=records(investor), assigned=records(sales);
  assert.equal(own.total,4); assert.equal(own.customerCount,1);
  assert.equal(assigned.total,4); assert.equal(assigned.customerCount,2);
  assert.equal(records(sales,{q:'小盒'}).total,3);
  assert.equal(records(sales,{q:'ANT'}).items[0].stockCode,'999999');
  assert.equal(records(sales,{q:'000004'}).items[0].stockName,'登记股票');
  assert.equal(records(sales,{q:'19900001001'}).total,3);
  assert.equal(records(sales,{q:'%_'}).total,1,'搜索按字面匹配，不把百分号当通配符');
  assert.doesNotMatch(JSON.stringify(assigned),/raw-secret-key|sourceType|历史登记|系统留资|不能看|已转派/);
  assert.ok(assigned.items.every(row=> !('recordKind' in row) && !('clientId' in row)));
  const customer=board(sales,{metric:'customers'}).items.find(row=>row.title==='小盒');
  const detail=records(sales,{customerId:customer.id});
  assert.equal(detail.total,3); assert.equal(detail.customerCount,1);
  assert.equal(records(sales,{customerId:'unknown'}).total,0);
  const lead=detail.items.find(row=>row.kind==='lead');
  assert.equal(lead.status,'已受理'); assert.deepEqual(lead.cases.map(row=>row.id),['case-a','old-case']);
  assert.doesNotMatch(JSON.stringify(detail),/canFollowup|followStatus|followups|旧经办|"version"|"leadId"/);
  assert.doesNotMatch(JSON.stringify(own),/canFollowup|followStatus|followups|旧经办/);
});

test('旧跟进筛选忽略且历史内容不输出，转派与解除关联立即撤销，快照清空不回退旧进度', t=>{
  const {db,records,sales,investor}=fixture(t);
  const original=records(sales,{limit:5});
  for(const follow of ['pending','done','invalid']) assert.deepEqual(records(sales,{follow,limit:5}),original);
  db.exec("INSERT INTO lead_followups VALUES ('current-follow','lead-a','sales-a',2,'本次跟进','2026-11-20')");
  assert.deepEqual(records(sales,{follow:'done',limit:5}),original);
  assert.equal(db.prepare('SELECT count(*) AS n FROM lead_followups').get().n,2);
  db.exec("INSERT INTO company_record_progress VALUES ('case','case-a','closure','closed','[]'),('registry','raw-secret-key-a','','','[]')");
  assert.equal(records(investor,{q:'ANT'}).items[0].status,'已结案');
  assert.equal(records(investor,{q:'000004'}).items[0].status,'进度待核对');
  db.exec("UPDATE lead_assignments SET salesId='sales-b',version=3 WHERE leadId='lead-a'");
  assert.equal(records(sales,{q:'ANT'}).total,0); assert.equal(records(sales,{follow:'done'}).total,records(sales).total);
  assert.equal(records(investor,{q:'ANT'}).total,1);
  db.exec("DELETE FROM registry_links WHERE type='sales' AND source_name='销售甲'");
  assert.equal(records(sales).total,0);
  db.exec("DELETE FROM registry_links WHERE type='investor' AND identity_id=1");
  assert.equal(records(investor).total,2);
});

test('券商仅按当前客户身份获得统一记录，同名来源不授权，不泄露手机号及跟进内容', t=>{
  const {db,records,broker}=fixture(t);
  const result=records(broker);
  assert.equal(result.total,5); assert.equal(result.customerCount,2);
  assert.equal(records(broker,{customerId:'client-a'}).total,4);
  assert.equal(records(broker,{q:'19900001001'}).total,0,'隐藏手机号不能成为查询侧信道');
  assert.doesNotMatch(JSON.stringify(result),/1990000|raw-secret|不能看|未关联股民|旧经办|followups|progressId/);
  assert.equal(result.items.find(row=>row.customer==='尚未留资').status,'待留资');
  assert.ok(result.items.every(row=>!row.canFollowup && !('kind' in row) && !('phone' in row)));
  const internal=records.all(broker);
  assert.equal(internal.filter(row=>row.recordKind==='registry').length,2);
  assert.equal(internal.filter(row=>row.recordKind==='client').length,1);
  db.exec("UPDATE clients SET brokerId='broker-b' WHERE id='client-a'");
  assert.equal(records(broker).total,1);
});

test('搜索完整股票集合，不受摘要八项截断；同日跨页不重复且日期筛选有首尾边界', t=>{
  const {db,records,sales,investor}=fixture(t);
  const add=db.prepare('INSERT INTO registry_entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<43;i++) add.run('many-'+i,100+i,'小盒','19900001001','销售甲','完整股票'+i,String(100000+i),'共同来源','2026-11-10','','','');
  add.run('future',999,'小盒','19900001001','销售甲','未来记录','888888','共同来源','2026-11-21','','','');
  add.run('boundary',998,'小盒','19900001001','销售甲','上海月首','888889','共同来源','2026-11-01','','','');
  assert.equal(records(sales,{q:'完整股票42'}).total,1);
  const pages=[0,20,40].map(offset=>records(investor,{offset}));
  const rows=pages.flatMap(page=>page.items);
  assert.equal(rows.length,48); assert.equal(new Set(rows.map(row=>row.id)).size,48);
  assert.equal(rows.at(-1).registeredOn,''); assert.doesNotMatch(JSON.stringify(rows),/未来记录/);
  assert.deepEqual(records(investor,{offset:20}).items,pages[1].items);
  assert.ok(pages.every(page=>page.limit===20));
  const smallPages=Array.from({length:10},(_,index)=>records(investor,{limit:'5',offset:index*5}));
  assert.deepEqual(smallPages.flatMap(page=>page.items),rows);
  assert.ok(smallPages.every(page=>page.limit===5 && page.total===48 && page.items.length<=5));
  assert.equal(smallPages.at(-1).items.length,3);
  assert.deepEqual(records(investor,{limit:5,offset:9999}).items,smallPages.at(-1).items);
  assert.equal(records(investor,{limit:5,offset:7}).offset,5);
  const dayLast=records(investor,{limit:5,period:'custom',from:'2026-11-10',to:'2026-11-10',offset:9999});
  assert.equal(dayLast.total,43); assert.equal(dayLast.offset,40); assert.equal(dayLast.items.length,3);
  assert.equal(records(sales,{limit:5,q:'不能看'}).total,0);
  assert.equal(records(investor,{limit:5,q:'没有',offset:1000}).offset,0);
  for(const limit of [0,1,10,21,-5,5.5,null,'',true,'05','5.0',' 5 ',[],{}]) {
    assert.throws(()=>records(investor,{limit}),error=>error.status===400);
  }
  assert.equal(records(investor,{period:'custom',from:'2026-11-10',to:'2026-11-10'}).total,43);
  assert.equal(records(investor,{period:'month'}).total,46);
  assert.equal(records(investor,{q:'没有',offset:1000}).offset,0);
  assert.throws(()=>records(sales,{q:'x'.repeat(101)}),/100/);
  for(const input of [{period:'custom',from:'2026-02-30',to:'2026-11-20'},{period:'custom',from:'2026-11-01',to:'2026-11-21'},
    {offset:-1},{customerId:5}]) assert.throws(()=>records(sales,input));
});

test('未关联、停用销售和非业务账号不会取得登记，强制改密角色被拒绝', t=>{
  const {db,records,sales}=fixture(t);
  assert.throws(()=>records({role:'admin',id:'a'},{limit:5}),error=>error.status===403);
  assert.throws(()=>records({...sales,passwordChangeRequired:true}),error=>error.status===403);
  assert.equal(records({role:'sales',id:'unknown'}).total,0);
  db.exec("UPDATE identities SET status='closed' WHERE id=3");
  assert.equal(records(sales,{q:'登记股票'}).total,0);
});


test('统一记录HTTP与真实券商看板共享快照事务，账号注销立即失效，管理员不得进入使用端接口', async t=>{
  const directory=mkdtempSync(join(tmpdir(),'unified-records-')), database=join(directory,'qa.sqlite');
  const credentials={username:'unified-admin',password:'fictional-admin-only',name:'合成管理员'};
  const store=createStore(database,{seed:true,admin:credentials,cutoff:'2000-01-01'});
  const token=(username,password)=>store.createSession(store.verifyLogin({username,password}).id);
  const adminToken=token(credentials.username,credentials.password),admin=store.getSession(adminToken);
  store.openSalesAccount(admin,{salesId:'sales-a',name:'测试销售甲',username:'unified-sales'});
  activateStoredAccount(store,'unified-sales','fictional-sales-only');
  activateStoredAccount(store,'broker-a','fictional-broker-only');
  const salesToken=token('unified-sales','fictional-sales-only'),brokerToken=token('broker-a','fictional-broker-only');
  const identity=store.registerInvestor({phone:'19900007001',password:'fictional-investor-only'});
  const investorToken=store.createSession(identity),investor=store.getSession(investorToken);
  store.scan(investor,{code:'DEMO-A'});
  store.addLead(investor,{name:'跨入口客户',phone:'19900007001',stockName:'统一股票',stockCode:'600001',period:'测试',consent:true});
  const db=new DatabaseSync(database);
  const seller=db.prepare("SELECT id FROM identities WHERE username='unified-sales'").get().id;
  db.exec(`CREATE TABLE registry_entries(entry_key TEXT,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
    stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,stage TEXT);
    INSERT INTO registry_entries VALUES ('joined-row',1,'跨入口客户','19900007001','测试销售甲','另一股票','600002','示例券商 A','2025-11-01','已结案');`);
  db.prepare("INSERT INTO registry_links VALUES ('sales','测试销售甲','',?)").run(seller);
  db.prepare("INSERT INTO registry_links VALUES ('investor','跨入口客户','19900007001',?)").run(identity);
  const server=createAppServer({database,cutoff:'2000-01-01'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();db.close();for(const path of readdirSync(directory))unlinkSync(join(directory,path));rmdirSync(directory);});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function get(path,session,status=200) {
    const response=await fetch(base+path,{headers:session?{Authorization:'Bearer '+session}:{}});
    const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;
  }
  for(const session of [salesToken,investorToken,brokerToken]) {
    const result=await get('/api/records?q='+encodeURIComponent('跨入口客户'),session);
    assert.equal(result.total,2);assert.equal(result.customerCount,1);
  }
  await get('/api/broker/board',brokerToken);
  await get('/api/records',null,401);
  await get('/api/records',adminToken,403);
  store.setAccountStatus(admin,{identityId:seller,status:'closed',currentPassword:credentials.password});
  await get('/api/records',salesToken,401);
  assert.equal((await get('/api/records',investorToken)).total,2);
});


test('按同一身份的新旧姓名或当前资料搜索返回全部授权股票，股票关键词仍只匹配具体记录', t=>{
  const {db,records,sales,broker}=fixture(t);
  db.exec("UPDATE registry_entries SET customer='张三' WHERE entry_key='raw-secret-key-a'; INSERT INTO registry_links VALUES ('investor','张三','19900001001',1)");
  const before=records(sales,{q:'小盒'});assert.equal(before.total,3);
  assert.equal(records(sales,{q:'张三'}).total,3,'旧表姓名也能找到此人全部授权股票');
  assert.equal(records(sales,{q:'登记股票'}).total,1,'股票搜索不扩到同人其他股票');
  db.exec("UPDATE clients SET name='盒先生',phone='19900009999' WHERE id='client-a'");
  assert.equal(records(sales,{q:'盒先生'}).total,3);assert.equal(records(sales,{q:'19900009999'}).total,3);
  db.exec("UPDATE identities SET name='账号昵称' WHERE id=1");
  assert.equal(records(sales,{q:'账号昵称'}).total,3,'账号显示名称变化也能命中完整授权客户记录');
  assert.equal(records(broker,{q:'账号昵称'}).total,4);
  assert.equal(records(sales,{q:'盒先生',period:'month'}).total,1,'姓名搜索仍遵守期间');
  assert.equal(records(broker,{q:'盒先生'}).total,4);
  assert.equal(records(broker,{q:'19900009999'}).total,0);
  assert.doesNotMatch(JSON.stringify(records(sales)),/nameAliases|phoneAliases/);
  db.exec("INSERT INTO registry_entries VALUES ('same-name-independent',99,'小盒','19900002222','销售甲','另一身份股票','200001','','2026-11-01','','','')");
  assert.equal(records(sales,{q:'19900001001'}).total,3,'电话命中的客户不因同名带出另一个人');
  assert.ok(records(sales,{q:'19900001001'}).items.every(row=>row.stockCode!=='200001'));
});

test('券商签约筛选先汇总当前证据，跨月签约不改变登记日期，既有旧案证据与看板一致', t=>{
  const {db,records,broker,sales,brokerBoard}=fixture(t);
  assert.equal(records(broker,{ledger:'signed'}).total,4,'已绑定的历史结案和已受理登记构成该客户的签约证据');
  assert.equal(records(broker,{ledger:'negotiating'}).total,1);
  db.exec("UPDATE leads SET createdAt='2026-10-01' WHERE clientId='client-a'; INSERT INTO signings VALUES ('client-a','2026-11-19')");
  assert.equal(brokerBoard(broker,{metric:'signings',period:'month'}).total,1);
  const own=records(broker,{customerId:'client-a',period:'all',ledger:'signed'});
  assert.equal(own.total,4);assert.ok(own.items.every(row=>row.signingStatus==='已签约'));
  assert.equal(records(broker,{customerId:'client-a',period:'month',ledger:'signed'}).total,0,'签约日期不能冒充股票登记日期');
  assert.equal(records(broker,{ledger:'negotiating'}).total,1,'未留资占位客户仍可查洽谈中');
  assert.ok(own.items.some(row=>row.status==='已受理'),'签约标签不覆盖案件进度');
  assert.throws(()=>records(sales,{ledger:'signed'}),/仅适用于券商/);
  db.exec("DELETE FROM signings; UPDATE registry_entries SET stage='' WHERE customer='小盒'");
  assert.equal(records(broker,{ledger:'signed'}).total,0,'普通系统案件的结案状态不会替代签约证据');
  db.exec("INSERT INTO company_record_progress VALUES ('case','old-case','intake','signed','[]')");
  assert.equal(records(broker,{ledger:'signed'}).total,4);
  assert.equal(brokerBoard(broker,{metric:'effective'}).total,1);
  assert.ok(records(broker,{q:'ANT'}).items[0].cases.some(row=>row.id==='old-case'));
  assert.ok(records(sales,{q:'ANT'}).items[0].cases.some(row=>row.id==='old-case'),'销售可读自己经办股票的全部既有案件');
});

test('股票已有案件时签约待立案节点沿用详情的已签约展示，不产生倒退状态', t=>{
  const {db,records,investor}=fixture(t);
  db.exec("INSERT INTO company_record_progress VALUES ('lead','lead-a','intake','signed_waiting_filing','[]')");
  assert.equal(records(investor,{q:'ANT'}).items[0].status,'已签约');
});
