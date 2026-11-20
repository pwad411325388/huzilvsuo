import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAppServer } from '../server.mjs';
import { createStore, today } from '../store.mjs';
import { activateStoredAccount } from '../test-support/business-account.mjs';

const publicKey = key => createHash('sha256').update(key).digest('hex');
const homeRecordsPath = '/records?presentation=home';
const recordFields = ({kind,progressId,stockName,stockCode,status,registeredOn}) =>
  ({kind,progressId,stockName,stockCode,status,registeredOn});

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'huzi-investor-home-'));
  const database = join(dir, 'synthetic.sqlite');
  const store = createStore(database, { cutoff: '2000-01-01', ...options });
  const db = new DatabaseSync(database);
  const server = createAppServer({ database });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
    db.close();
    for (const filename of readdirSync(dir)) unlinkSync(join(dir, filename));
    rmdirSync(dir);
  });
  function account(phone) {
    const identity = store.registerInvestor({ phone, password: 'Investor-Home-Test!' });
    const token = store.createSession(identity);
    const clientId = store.getSession(token).id;
    db.prepare("UPDATE clients SET name='同名测试人',phone=? WHERE id=?").run(phone,clientId);
    return { identity, token, clientId, phone };
  }
  function addLead(id, owner, createdAt, stockName = '同一只股票') {
    db.prepare('INSERT INTO leads(id,clientId,stockName,stockCode,period,createdAt) VALUES(?,?,?,?,?,?)')
      .run(id, owner.clientId, stockName, '600001', '合成测试期间', createdAt);
  }
  async function get(owner, path = '/view', expected = 200) {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      headers: owner ? { Authorization: 'Bearer ' + owner.token } : {},
    });
    const data = await result.json();
    assert.equal(result.status, expected);
    return data;
  }
  return { db,store,get,addLead,owner:account('19900009701'),other:account('19900009702') };
}

function counts(home, cases, leads, unclassified, message) {
  assert.equal(home.totalRecords, cases + leads + unclassified, message);
  assert.deepEqual([home.caseCount, home.leadCount, home.unclassifiedCount], [cases, leads, unclassified], message);
  assert.ok(home.countingNote?.trim());
}

function registryFixture(db) {
  db.exec(`CREATE TABLE registry_entries(entry_key TEXT PRIMARY KEY,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
    stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,filed_on TEXT,stage TEXT,progress_stage TEXT,progress_node TEXT)`);
  return {
    insert: db.prepare(`INSERT INTO registry_entries VALUES(?,?, '同名测试人',?,'合成销售','相同股票','600002','',?,'',?,?,?)`),
    link: db.prepare("INSERT INTO registry_links VALUES('investor','同名测试人',?,?)"),
  };
}

test('首页需要有效登录，空股民无记录、提醒或最近项，强制改密时不返回首页数据', async t => {
  const { db,get,owner,addLead } = await fixture(t);
  await get(null, '/view', 401);
  await get({token:'unknown-token'}, '/view', 401);
  const { investorHome } = await get(owner);
  counts(investorHome, 0, 0, 0);
  assert.equal(investorHome.attentionCount,0);
  assert.equal(investorHome.attention,null);
  assert.deepEqual(investorHome.recent,[]);
  addLead('lead-visible-before-reset', owner, '2024-01-01');
  assert.equal((await get(owner)).investorHome.totalRecords,1);
  db.prepare('UPDATE identities SET passwordChangeRequired=1 WHERE id=?').run(owner.identity);
  const forced = await get(owner);
  assert.equal(forced.passwordChangeRequired,true);
  assert.equal('investorHome' in forced,false);
  assert.doesNotMatch(JSON.stringify(forced),/lead-visible-before-reset/);
});

test('同股多案按案件逐项统计，提醒仅看当前节点，最近记录按各自真实登记日排序', async t => {
  const { db,store,get,owner,other,addLead } = await fixture(t);
  addLead('parent', owner, '2024-02-01');
  addLead('current-supplement', owner, '2024-06-01');
  addLead('next-supplement', owner, '2024-03-01');
  addLead('hidden-future-lead', owner, '2999-01-01');
  addLead('hidden-other-lead', other, '2024-10-01');
  db.exec(`INSERT INTO cases VALUES ('first-case','parent','早期案件','2024-04-15','待受理'),
    ('second-case','parent','另一案件','2024-05-15','诉讼中'),
    ('hidden-future-case','current-supplement','未来案件','2999-01-01','已结案'),
    ('hidden-other-case','hidden-other-lead','他人案件','2024-11-01','已受理')`);
  store.syncProgress([
    { kind:'case',id:'first-case',revision:1,stage:'filing',node:'supplement' },
    { kind:'lead',id:'current-supplement',revision:1,stage:'debt_claim',node:'supplement' },
    { kind:'lead',id:'next-supplement',revision:1,stage:'filing',node:'submitted',nextStage:'filing',nextNode:'supplement' },
    { kind:'case',id:'hidden-other-case',revision:1,stage:'filing',node:'supplement' },
  ]);
  const { investorHome: home } = await get(owner);
  counts(home,2,2,0);
  assert.equal(home.attentionCount,2);
  assert.equal(home.attention.progressId,'current-supplement');
  assert.equal(home.attention.kind,'lead');
  assert.equal(home.attention.status,'待补充材料');
  assert.deepEqual(home.recent.map(row => [row.kind,row.progressId,row.registeredOn]), [
    ['lead','current-supplement','2024-06-01'],['case','second-case','2024-05-15'],
  ]);
  for (const row of [...home.recent, home.attention]) {
    assert.equal(row.stockName,'同一只股票');
    assert.equal(row.stockCode,'600001');
  }
  assert.doesNotMatch(JSON.stringify(home),/hidden-|next-supplement|合同号/);
  const caseList = await get(owner,homeRecordsPath);
  assert.deepEqual(await get(owner,homeRecordsPath+'&follow=done'),caseList,'旧跟进参数不缩小首页全部记录');
  assert.doesNotMatch(JSON.stringify(caseList),/canFollowup|followStatus|followups|"follow":/);
  assert.equal(caseList.total,home.totalRecords);
  assert.deepEqual(caseList.items.slice(0,2).map(recordFields),home.recent.map(recordFields));
  assert.equal(home.recent[1].caseTitle,'另一案件');
  assert.equal(caseList.items.find(item => item.progressId==='first-case').caseTitle,'早期案件');
  assert.deepEqual(caseList.items.filter(item=>item.kind==='case').map(item=>[item.progressId,item.registeredOn,item.status]),[
    ['second-case','2024-05-15','诉讼中'],['first-case','2024-04-15','待您补充材料'],
  ]);
  const scoped = await get(owner,homeRecordsPath+'&period=custom&from=2024-04-01&to=2024-05-31');
  assert.equal(scoped.total,2);
  assert.equal(scoped.period,'custom');
  assert.equal(scoped.from,'2024-04-01');
  assert.equal(scoped.to,'2024-05-31');
  assert.ok(scoped.items.every(row=>row.kind==='case'),'按案件独立登记日期筛选');
  const regularList = await get(owner,'/records');
  assert.equal(regularList.total,3);
  for (const field of Object.keys(regularList)) assert.ok(Object.hasOwn(caseList, field),'保留列表响应字段 '+field);
  assert.ok(regularList.items.some(row=>row.kind==='lead' && row.progressId==='parent' && row.cases.length===2));
  assert.doesNotMatch(JSON.stringify(regularList),/homeProgress|hasOwnSnapshot/);
  const caseRow = home.recent[1];
  const caseDetail = await get(owner, '/progress?' + new URLSearchParams({ kind:caseRow.kind,id:caseRow.progressId }));
  assert.equal(caseDetail.title,'另一案件');
  store.syncProgress([{ kind:'lead',id:'current-supplement',revision:2,stage:null,node:null }]);
  const afterClear = (await get(owner)).investorHome;
  assert.equal(afterClear.attentionCount,1);
  assert.equal(afterClear.attention.kind,'case');
  assert.equal(afterClear.attention.progressId,'first-case');
  assert.equal(afterClear.attention.status,'待您补充材料');
  assert.equal(afterClear.attention.registeredOn,'2024-04-15');
  store.syncProgress([{ kind:'case',id:'first-case',revision:2,stage:'filing',node:'submitted' }]);
  const final = (await get(owner)).investorHome;
  counts(final,2,2,0);
  assert.equal(final.attentionCount,0);
  assert.equal(final.attention,null);
  store.syncProgress([{kind:'case',id:'second-case',revision:1,stage:'filing',node:'supplement'}]);
  const inherited = (await get(owner)).investorHome;
  assert.equal(inherited.attentionCount,1,'父留资仅继承案件的补料时只提醒该案件');
  assert.equal(inherited.attention.progressId,'second-case');
  db.prepare('UPDATE leads SET createdAt=? WHERE id=?').run('2024-08-01','parent');
  store.syncProgress([{kind:'lead',id:'parent',revision:1,stage:'debt_claim',node:'supplement'}]);
  const independent = (await get(owner)).investorHome;
  counts(independent,2,2,0);
  assert.equal(independent.attentionCount,2);
  assert.equal(independent.attention.progressId,'parent');
  assert.deepEqual(independent.recent.map(item => item.progressId),['current-supplement','second-case']);
});

test('历史登记按授权键在整份记录中统计，稳定详情键、未知日期、同名隔离及解绑生效', async t => {
  const adminCredentials = { username:'home-admin',password:'Home-Admin-Test!',name:'测试管理员' };
  const { db,store,get,owner,other } = await fixture(t,{admin:adminCredentials,seed:true,progressTestEnabled:true});
  const currentDay = today();
  const { insert,link } = registryFixture(db);
  link.run(owner.phone, owner.identity);
  link.run(other.phone, other.identity);
  for (let n=1; n<=21; n++) insert.run('ambiguous-'+n,n,owner.phone,n===1 ? '' : '2020-01-01','','','');
  insert.run('filed-registry',22,owner.phone,'2024-05-10','已立案','','');
  insert.run('closed-registry',23,owner.phone,currentDay,'已结案','closure','closed');
  insert.run('future-registry',24,owner.phone,'2999-01-01','已结案','closure','closed');
  insert.run('same-name-private',25,other.phone,'2024-08-01','已结案','closure','closed');
  const home = (await get(owner)).investorHome;
  counts(home,2,0,21);
  assert.equal(home.attentionCount,0);
  assert.deepEqual(home.recent.map(row => [row.kind,row.progressId,row.registeredOn]), [
    ['registry',publicKey('closed-registry'),currentDay],['registry',publicKey('filed-registry'),'2024-05-10'],
  ]);
  const page1 = await get(owner,homeRecordsPath), page2 = await get(owner,homeRecordsPath+'&offset=20');
  assert.deepEqual(page1.items.slice(0,2).map(recordFields),home.recent.map(recordFields));
  assert.equal(page1.total,home.totalRecords);
  assert.equal(page1.limit,20); assert.equal(page1.offset,0);
  assert.equal(page2.offset,20); assert.equal(page2.items.length,3);
  const keys = [...page1.items,...page2.items].map(row=>row.progressId);
  assert.deepEqual(new Set(keys),new Set(['closed-registry','filed-registry',...Array.from({length:21},(_,i)=>'ambiguous-'+(1+i))].map(publicKey)));
  assert.equal(keys.length,23);
  const fivePages=[];
  for (const offset of [0,5,10,15,20]) fivePages.push(await get(owner,homeRecordsPath+'&limit=5&offset='+offset));
  assert.ok(fivePages.every(page=>page.limit===5 && page.total===home.totalRecords && page.items.length<=5));
  assert.deepEqual(fivePages.flatMap(page=>page.items).map(row=>row.progressId),keys);
  assert.deepEqual(fivePages[0].items.slice(0,2).map(recordFields),home.recent.map(recordFields));
  const lastFive=await get(owner,homeRecordsPath+'&limit=5&offset=9999');
  assert.equal(lastFive.offset,20); assert.equal(lastFive.items.length,3);
  await get(owner,homeRecordsPath+'&limit=7',400);
  await get(owner,homeRecordsPath+'&limit=05',400);
  assert.equal(keys.at(-1),publicKey('ambiguous-1'),'未知登记日排在全部有效日期之后');
  assert.deepEqual((await get(owner,homeRecordsPath)).items.map(item=>item.progressId),keys.slice(0,20),'同日顺序稳定');
  const month = await get(owner,homeRecordsPath+'&period=month');
  assert.deepEqual([month.period,month.from,month.to],['month',currentDay.slice(0,7)+'-01',currentDay]);
  assert.equal(month.total,1);
  assert.equal(month.items[0].progressId,publicKey('closed-registry'));
  assert.equal((await get(owner,homeRecordsPath+'&period=custom&from=2000-01-01&to='+currentDay)).total,22);
  const key = home.recent[0].progressId;
  assert.equal((await get(owner,'/progress?kind=registry&id='+key)).stockName,'相同股票');
  await get(other,'/progress?kind=registry&id='+key,404);
  const ownOther = (await get(other)).investorHome;
  counts(ownOther,1,0,0);
  assert.equal(ownOther.recent[0].progressId,publicKey('same-name-private'));
  db.prepare('UPDATE registry_entries SET filed_on=? WHERE entry_key=?').run('2999-01-01','ambiguous-5');
  db.prepare('UPDATE registry_entries SET filed_on=? WHERE entry_key=?').run('2024-01-01','ambiguous-6');
  store.syncProgress([
    {kind:'registry',id:'ambiguous-1',revision:1,stage:'filing',node:'supplement'},
    {kind:'registry',id:'ambiguous-2',revision:1,stage:'debt_claim',node:'supplement'},
    {kind:'registry',id:'ambiguous-3',revision:1,stage:'filing',node:'submitted',nextStage:'filing',nextNode:'supplement'},
    {kind:'registry',id:'ambiguous-4',revision:1,stage:'first_hearing',node:'awaiting_hearing'},
  ]);
  const classified = (await get(owner)).investorHome;
  counts(classified,4,0,19);
  assert.equal(classified.attentionCount,2,'未标登记日期的补料也在全量提醒中');
  assert.equal(classified.attention.progressId,publicKey('ambiguous-2'),'有日期的提醒排在未知日期之前');
  const adminToken = store.createSession(store.verifyLogin(adminCredentials).id);
  const admin = store.getSession(adminToken);
  await get({token:adminToken},homeRecordsPath,403);
  store.openSalesAccount(admin,{name:'首页测试销售',username:'home-staff'});
  for (const username of ['home-staff','broker-a']) {
    const password = 'Personal-Home-Test-Password!';
    activateStoredAccount(store,username,password);
    const business = {token:store.createSession(store.verifyLogin({username,password}).id)};
    await get(business,'/records');
    await get(business,homeRecordsPath,403);
  }
  function simulate(key,stage,node) {
    const target = {kind:'registry',id:publicKey(key)};
    const { revision } = store.adminProgressTest.detail(admin,target);
    store.adminProgressTest.save(admin,{...target,revision,stage,node});
  }
  simulate('ambiguous-5','first_hearing','awaiting_hearing');
  counts((await get(owner)).investorHome,4,0,19,'模拟一审不能将未知登记算成案件');
  simulate('ambiguous-4','intake','lead_received');
  counts((await get(owner)).investorHome,4,0,19,'模拟退回留资不应抹掉正式一审记录');
  db.prepare("DELETE FROM registry_links WHERE type='investor' AND identity_id=?").run(owner.identity);
  counts((await get(owner)).investorHome,0,0,0);
  await get(owner,'/progress?kind=registry&id='+key,404);
});

test('历史留资无效日期和未记日期的案件归入未知日期，首页及按期间检索保持一致', async t => {
  const { db,get,owner,addLead } = await fixture(t);
  addLead('dated',owner,'2024-07-22');
  addLead('bad-date',owner,'待核对');
  addLead('impossible-day',owner,'2024-02-30T12:00:00Z');
  addLead('two-cases',owner,'2024-12-01');
  db.exec(`INSERT INTO cases VALUES('unknown-date-case','two-cases','登记日缺失的案件','','待受理'),
    ('dated-case','two-cases','登记日明确的案件','2024-01-10','已受理')`);
  const home = (await get(owner)).investorHome;
  counts(home,2,3,0);
  assert.deepEqual(home.recent.map(item=>item.progressId),['dated','dated-case']);
  const all = await get(owner,homeRecordsPath);
  assert.deepEqual(all.items.slice(0,2).map(recordFields),home.recent.map(recordFields));
  assert.deepEqual(new Set(all.items.slice(2).map(item=>item.progressId)),new Set(['unknown-date-case','bad-date','impossible-day']));
  assert.ok(all.items.slice(2).every(item=>item.registeredOn===''));
  const year = await get(owner,homeRecordsPath+'&period=custom&from=2024-01-01&to=2024-12-31');
  assert.deepEqual(year.items.map(item=>item.progressId),['dated','dated-case']);
});

test('测试快照只按有效备份恢复正式建案证据，原表阶段仅在原本无公司快照时使用', async t => {
  const credentials = {username:'home-reviewer',password:'Investor-Home-Review-QA!',name:'测试管理员'};
  const { db,store,owner,get } = await fixture(t,{admin:credentials,progressTestEnabled:true});
  const { insert,link } = registryFixture(db);
  const key = 'private-registry-key-of-stage-only-record';
  insert.run(key,1,owner.phone,'2024-03-01','','first_hearing','awaiting_hearing');
  link.run(owner.phone,owner.identity);
  const admin = store.getSession(store.createSession(store.verifyLogin(credentials).id));
  const record = {kind:'registry',id:publicKey(key)};
  const adminTest = store.adminProgressTest;
  const form = () => ({...record,revision:adminTest.detail(admin,record).revision});
  const simulate = (stage,node) => adminTest.save(admin,{...form(),stage,node});
  async function assertCase(expected, reason) {
    counts((await get(owner)).investorHome,expected,0,1-expected,reason);
  }
  await assertCase(1,'原始登记的一审结构化节点本身是建案证据');
  simulate('intake','lead_received');
  const backup = db.prepare("SELECT original_snapshot FROM admin_progress_test_backup WHERE kind='registry' AND record_id=?");
  assert.equal(JSON.parse(backup.get(key).original_snapshot),null);
  await assertCase(1,'有效备份证实原本无公司快照时，继续按原表节点计案');

  adminTest.restore(admin,form());
  store.syncProgress([{kind:'registry',id:key,revision:1,stage:null,node:null}]);
  await assertCase(0,'公司明确清空后不回退原表');
  simulate('first_hearing','awaiting_hearing');
  assert.equal(JSON.parse(backup.get(key).original_snapshot).stage,'');
  await assertCase(0,'有效备份中的明确清空也不回退原表');

  adminTest.restore(admin,form());
  store.syncProgress([{kind:'registry',id:key,revision:2,stage:'first_hearing',node:'awaiting_hearing'}]);
  simulate('appeal','awaiting_hearing');
  await assertCase(1,'相符的正式一审备份仍然有效');
  db.prepare("UPDATE admin_progress_test_backup SET applied_snapshot='{}' WHERE kind='registry' AND record_id=?").run(key);
  await assertCase(0,'备份与当前测试快照不相符时不能据此计案');
  db.prepare("DELETE FROM admin_progress_test_backup WHERE kind='registry' AND record_id=?").run(key);
  await assertCase(0,'测试缺乏备份时不把模拟节点算成案件');
  const regular = await get(owner,'/records');
  assert.equal(regular.items[0].progressId,record.id);
  assert.doesNotMatch(JSON.stringify(regular),/homeProgress|sourceProgress|entryKey|entry_key|private-registry-key/);
});

test('无独立案件的股票按当前一审执行获赔进度计展示案件，预告和签约不计案且不重复造案',async t=>{
  const credentials={username:'home-case-count-admin',password:'Home-Case-Count-QA!',name:'测试管理'};
  const {db,store,owner,get,addLead}=await fixture(t,{admin:credentials,progressTestEnabled:true});
  addLead('progress-only-stock',owner,'2024-03-01');
  const target={kind:'lead',id:'progress-only-stock'};
  const admin=store.getSession(store.createSession(store.verifyLogin(credentials).id));
  const originalLeads=db.prepare('SELECT * FROM leads ORDER BY id').all();
  const originalCases=db.prepare('SELECT * FROM cases ORDER BY id').all();
  counts((await get(owner)).investorHome,0,1,0);
  store.syncProgress([{...target,revision:1,stage:'intake',node:'signed_waiting_filing',nextStage:'enforcement',nextNode:'in_progress'}]);
  counts((await get(owner)).investorHome,0,1,0,'签约及下一步执行预告不能算已进入案件');
  for(const [stage,node,expected] of [
    ['filing','preparing',0],['filing','submitted',0],
    ['first_hearing','awaiting_hearing',1],['appeal','awaiting_hearing',1],
    ['enforcement','in_progress',1],['enforcement','compensated',1],
    ['closure','pending_payment',1],['closure','payment_received',1],['closure','closed',1],
    ['intake','lead_received',0],
  ]) {
    const form=store.adminProgressTest.detail(admin,target);
    store.adminProgressTest.save(admin,{...target,revision:form.revision,stage,node});
    const home=(await get(owner)).investorHome;
    counts(home,expected,1-expected,0,stage+'.'+node);
    const rows=await get(owner,homeRecordsPath+'&limit=5');
    assert.equal(rows.total,1);
    assert.equal(rows.items[0].kind,'lead','计数分类不修改原始详情键');
    assert.equal(rows.items[0].progressId,target.id);
    const detail=await get(owner,'/progress?'+new URLSearchParams(target));
    assert.equal(home.recent[0].status,detail.current.label);
    assert.equal(rows.items[0].status,detail.current.label);
    assert.deepEqual(db.prepare('SELECT * FROM leads ORDER BY id').all(),originalLeads);
    assert.deepEqual(db.prepare('SELECT * FROM cases ORDER BY id').all(),originalCases,'展示计数不会创建或修改案件');
  }
  const form=store.adminProgressTest.detail(admin,target);
  store.adminProgressTest.restore(admin,{...target,revision:form.revision});
  counts((await get(owner)).investorHome,0,1,0,'恢复原签约状态后不残留模拟案件数');
  store.syncProgress([{...target,revision:2,stage:'enforcement',node:'compensated'}]);
  counts((await get(owner)).investorHome,1,0,0,'正式同步执行获赔也按同一口径显示');
  db.prepare('INSERT INTO cases VALUES (?,?,?,?,?)').run('new-real-case',target.id,'独立案件','2024-04-01','执行中');
  counts((await get(owner)).investorHome,1,0,0,'后续建立独立案件时替换父留资展示而不是再加一件');
  db.prepare('INSERT INTO cases VALUES (?,?,?,?,?)').run('another-real-case',target.id,'第二案件','2024-05-01','已受理');
  counts((await get(owner)).investorHome,2,0,0,'一条股票记录的多件案件仍分别计数且不加父留资');
});
