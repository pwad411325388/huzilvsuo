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
  await get(sales,'lead','l2',404); await get(sales,'case','cold',404);
  await get(investor,'registry',publicKey('entry2'),404);
  await get(investor,'registry','entry1',404);
  assert.equal((await get(investor,'registry',row)).current.label,'已结案');
  const initial = await get(investor,'lead','l1');
  assert.deepEqual(initial.relatedCases.map(c=>c.id),['c2','c1']);
  assert.equal(initial.current.label,'已留资');
  assert.equal((await get(investor,'lead','l2')).current.label,'已留资');
  const coarse = await get(investor,'case','c2');
  assert.equal(coarse.current,null);
  assert.equal(coarse.sourceStatus,'诉讼中');
  assert.deepEqual(coarse.steps,[]);
  assert.equal('contractNumber' in await get(sales,'case','c1'),false);
  const snapshot = (kind,id,revision,stage,node,contractNumber) => ({kind,id,revision,stage,node,contractNumber});
  const first = snapshot('case','c1',1,'filing','supplement','FIXTURE-C1');
  const second = snapshot('case','c2',1,'appeal','remanded');
  assert.deepEqual(store.syncProgress([first,second]),{updated:2,unchanged:0});
  assert.deepEqual(store.syncProgress([first,second]),{updated:0,unchanged:2});
  const clientDetail = await get(investor,'case','c1');
  assert.equal(clientDetail.current.label,'待您补充材料');
  assert.deepEqual(clientDetail.steps.map(step => step.status),['reference','current','reference']);
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
    ['preparing','completed'],['submitted','completed'],['supplement','current'],
  ]);
  assert.deepEqual(store.syncProgress([{...first, revision:3}]), {updated:1,unchanged:0});
  assert.ok(!(await get(investor,'case','c1')).steps.some(s=>s.status==='completed'));
  store.syncProgress([snapshot('lead','l1',1,'intake','signed_waiting_filing'),snapshot('lead','l2',1,'intake','signed_waiting_filing')]);
  assert.equal((await get(investor,'lead','l1')).current.label,'已签约');
  assert.deepEqual((await get(investor,'lead','l1')).steps.map(s=>[s.label,s.status]), [['已留资','completed'],['已签约','current']]);
  assert.equal((await get(investor,'lead','l2')).current.label,'已签约 待立案');
  assert.equal((await get(otherSales,'lead','l2')).current.label,'已签约');
  db.exec("ALTER TABLE registry_entries ADD COLUMN progress_stage TEXT; ALTER TABLE registry_entries ADD COLUMN progress_node TEXT; ALTER TABLE registry_entries ADD COLUMN contract_number TEXT;");
  db.exec("UPDATE registry_entries SET progress_stage='debt_claim',progress_node='supplement',contract_number='FIXTURE-REG' WHERE entry_key='entry1'");
  assert.equal((await get(investor,'registry',row)).current.label,'待补充材料');
  assert.doesNotMatch(JSON.stringify(await get(investor,'registry',row)),/contract|FIXTURE-REG/i);
  assert.equal((await get(sales,'registry',row)).contractNumber,'FIXTURE-REG');
  store.syncProgress([snapshot('registry','entry1',4,null,null)]);
  const cleared = await get(sales,'registry',row);
  assert.equal(cleared.current,null); assert.equal(cleared.sourceStatus,''); assert.equal('contractNumber' in cleared,false);
  assert.deepEqual(cleared.steps,[]);
  assert.throws(() => store.syncProgress([snapshot('registry','entry1',3,'closure','closed')]),/版本/);
  db.prepare("UPDATE lead_assignments SET salesId=? WHERE leadId='l1'").run(otherSalesId);
  await get(sales,'case','c1',404);
  assert.equal((await get(otherSales,'case','c1')).contractNumber,'FIXTURE-C1');
  db.exec("DELETE FROM registry_links WHERE type='sales'");
  await get(sales,'registry',row,404);
  db.exec("UPDATE identities SET passwordChangeRequired=1 WHERE username='sales-p2'");
  await get(otherSales,'case','c1',403);
});
