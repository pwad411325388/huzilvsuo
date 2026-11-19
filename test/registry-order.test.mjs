import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRegistry } from '../registry.mjs';
import { createStore, RequestError } from '../store.mjs';

test('历史登记全量按材料日期排序后分页，同日固定行号，个人预览及搜索沿用同序', t => {
  const db = new DatabaseSync(':memory:'); t.after(()=>db.close());
  db.exec(`CREATE TABLE identities(id INTEGER PRIMARY KEY,role TEXT,subjectId TEXT,status TEXT,username TEXT,name TEXT);
    INSERT INTO identities VALUES (1,'sales','s','active','seller','测试销售'),(2,'investor','i','active','investor','同名客户');
    CREATE TABLE registry_entries(entry_key TEXT,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,stock_name TEXT,stock_code TEXT,
      source TEXT,registered_on TEXT,filed_on TEXT,stage TEXT);
    CREATE TABLE registry_meta(key TEXT,value TEXT);`);
  const registry=createRegistry(db,{transaction:fn=>fn(),audit:()=>{},requireValue(ok,message,status=400){if(!ok)throw new RequestError(status,message);}});
  db.exec("INSERT INTO registry_links VALUES ('sales','测试销售','',1),('investor','同名客户','19900000001',2)");
  const insert=db.prepare('INSERT INTO registry_entries VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const dates=Array.from({length:47},(_,i)=>i<25?'2026-11-18':i<44?'2025-01-01':i===44?'':i===45?'2026-02-30':null);
  for(let i=46;i>=0;i--) insert.run('key-'+String(i).padStart(3,'0'),100-i,'同名客户','19900000001','测试销售','共同股票',String(i),'来源',dates[i],'','已受理');
  const expected=Array.from({length:47},(_,i)=>({i,sourceRow:100-i,date:i<44?dates[i]:null})).sort((a,b)=>{
    if(a.date===null||b.date===null)return a.date===b.date?a.sourceRow-b.sourceRow:a.date===null?1:-1;
    return b.date.localeCompare(a.date)||a.sourceRow-b.sourceRow;
  });
  for(const actor of [{role:'admin',id:'a'},{role:'sales',id:'s'},{role:'investor',id:'i'}]){
    const pages=[0,20,40].map(offset=>registry.list(actor,{offset}));
    const items=pages.flatMap(page=>page.items);
    assert.equal(items.length,47);
    assert.deepEqual(items.map(row=>Number(row.stockCode)),expected.map(row=>row.i));
    assert.equal(new Set(items.map(row=>row.rowKey||row.entryKey)).size,47);
    assert.deepEqual(registry.list(actor,{offset:20}).items,pages[1].items,'返回同页顺序不变');
    assert.deepEqual(registry.list(actor,{q:'共同股票',offset:20}).items,pages[1].items,'搜索同一结果仍先整体排序');
    assert.match(pages[0].orderLabel,/材料登记日期从新到旧/);
  }
  const preview=registry.salesOverview({role:'sales',id:'s'});
  const first=registry.list({role:'sales',id:'s'},{}).items.slice(0,3);
  assert.deepEqual(preview.registryPreview.map(row=>row.rowKey),first.map(row=>row.rowKey));
  assert.deepEqual(preview.registryPreview.map(row=>row.registeredOn),first.map(row=>row.registeredOn));
  assert.equal(db.prepare('SELECT count(*) AS n FROM registry_entries').get().n,47);
});

test('后台所有角色账号按正常在前注销在后，同组新建先，人员及券商选项状态排序', t=>{
  const store=createStore(':memory:',{seed:true,admin:{username:'order-admin',password:'Order-admin-2026',name:'测试管理员'}});
  t.after(()=>store.close());
  const admin=store.getSession(store.createSession(store.verifyLogin({username:'order-admin',password:'Order-admin-2026'}).id));
  store.openSalesAccount(admin,{salesId:'sales-a',name:'第一销售',username:'order-sales-a'});
  store.openSalesAccount(admin,{salesId:'sales-b',name:'第二销售',username:'order-sales-b'});
  for(const username of ['broker-a','order-sales-b']){
    const account=store.view(admin).accounts.find(row=>row.username===username);
    store.setAccountStatus(admin,{identityId:account.id,status:'closed',currentPassword:'Order-admin-2026'});
  }
  const view=store.view(admin),ranks=view.accounts.map(row=>row.status==='active'?0:1);
  assert.deepEqual(ranks,ranks.slice().sort());
  for(const status of ['active','closed']){
    const ids=view.accounts.filter(row=>row.status===status).map(row=>row.id);
    assert.deepEqual(ids,ids.slice().sort((a,b)=>b-a));
  }
  assert.equal(view.sales.at(-1).username,'order-sales-b');
  assert.equal(view.brokers.at(-1).username,'broker-a');
  assert.match(view.accountOrderLabel,/创建顺序从新到旧/);
  const salesperson = { role: 'sales', id: 'sales-a' };
  store.registerBroker(salesperson, { name: '待开户券商', signedOn: '2026-11-01' });
  assert.deepEqual(store.view(salesperson).metrics.find(metric => metric.kind === 'broker').records.map(row => row.status), ['待开户', '已注销'], '兼容业务看板也将注销渠道排后');
});
