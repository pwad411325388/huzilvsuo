import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createBrokerBoard } from '../broker-board.mjs';
import { RequestError } from '../store.mjs';

function fixture(t, userRecords) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE clients(id TEXT,name TEXT,phone TEXT,brokerId TEXT,createdAt TEXT);
    CREATE TABLE signings(clientId TEXT,signedOn TEXT);
    CREATE TABLE leads(id TEXT,clientId TEXT,stockName TEXT,stockCode TEXT,createdAt TEXT);
    CREATE TABLE cases(id TEXT,leadId TEXT,title TEXT,status TEXT,openedOn TEXT);
    CREATE TABLE company_record_progress(kind TEXT,record_id TEXT,stage TEXT,node TEXT,completed_nodes TEXT);
    INSERT INTO clients VALUES ('old','老客户','19900000001','broker-a','2020-01-01'),
      ('new','新客户','19900000002','broker-a','2026-11-15'),
      ('outside','别人的客户','19900000003','broker-b','2026-11-15'),
      ('prospect','','19900000004','broker-a','2026-10-31T16:00:00Z');
    INSERT INTO leads VALUES ('old-lead','old','旧股票','000001','2020-02-01'),
      ('new-lead','old','新股票','000002','2026-10-31T16:00:00Z'),
      ('other-lead','outside','不能看到股票','000003','2026-11-15');
    INSERT INTO signings VALUES ('old','2026-11-17');
    INSERT INTO cases VALUES ('closed','new-lead','新股票索赔','已结案','2026-11-17'),
      ('old-case','old-lead','早期案件','已受理','2020-02-02'),
      ('outside-case','other-lead','不能看到案件','已结案','2026-11-17');`);
  const board = createBrokerBoard(db, { userRecords, transaction: fn => fn(), today: () => '2026-11-19',
    requireValue(ok, message, status = 400) { if (!ok) throw new RequestError(status, message); } });
  return { db, board: (input = {}, actor = { role:'broker', id:'broker-a' }) => board(actor,input) };
}

test('券商所有卡片默认累计且同期间明细一致，老客户新股票按留资日纳入，保留注册待留资', t => {
  const { board } = fixture(t);
  const all = board();
  assert.equal(all.period,'all'); assert.equal(all.total,3);
  assert.deepEqual(all.metrics.map(row => row.value),[3,1,1,1,1]);
  const month = board({period:'month'});
  assert.equal(month.total,3);
  const old = month.items.find(row => row.title === '老客户');
  assert.match(old.subtitle,/新股票/); assert.doesNotMatch(old.subtitle,/旧股票/);
  assert.ok(month.items.some(row => row.title === '待留资客户'));
  for (const metric of month.metrics) assert.equal(board({period:'month',metric:metric.key}).total,metric.value);
  const day = board({period:'custom',from:'2026-11-01',to:'2026-11-01'});
  assert.equal(day.total,2,'UTC跨月按中国日期，包含注册未留资客户');
  assert.equal(day.metrics.find(row => row.key === 'closed').value,1);
  assert.ok(!JSON.stringify(all).includes('1990000'),'不暴露客户手机号');
  assert.ok(!JSON.stringify(all).includes('不能看到'));
  assert.equal(board({ledger:'negotiating'}).total,2);
  assert.equal(board({ledger:'signed',period:'month'}).total,1);
  assert.equal(board({ledger:'signed'}).items[0].title,'老客户');
});

test('新增签约独立按实际签约日，不拿登记日或当前签约状态冒充事件', t => {
  const { db, board } = fixture(t);
  db.exec("INSERT INTO company_record_progress VALUES ('lead','new-lead','intake','signed','[]')");
  const day = board({period:'custom',from:'2026-11-17',to:'2026-11-17',metric:'signings'});
  assert.equal(day.total,1); assert.equal(day.items[0].signedOn,'2026-11-17');
  assert.equal(day.metrics.find(row => row.key === 'customers').value,0);
  assert.equal(day.metrics.find(row => row.key === 'signings').label,'期间新增签约');
  assert.equal(board({period:'month',metric:'signings'}).metrics.find(row => row.key === 'signings').label,'本月新增签约');
  db.exec("UPDATE leads SET createdAt='' WHERE clientId='old'; UPDATE signings SET signedOn='2020-01-01'");
  assert.equal(board({period:'month',metric:'signings'}).metrics.find(row => row.key === 'signings').unknownDateCount,0,
    '登记日期缺失不能把明确的历史签约日说成日期不明');
  db.exec('DELETE FROM signings');
  assert.equal(board({metric:'effective'}).total,1,'有明确签约状态但没有日期');
  assert.equal(board({metric:'signings'}).total,0,'不可伪造实际签约发生时间');
});

test('历史案件不再截断，快照与显式清空覆盖旧状态，归属调整即时撤销访问', t => {
  const { db, board } = fixture(t);
  assert.equal(board({metric:'ongoing'}).total,1);
  db.exec("INSERT INTO company_record_progress VALUES ('case','old-case','closure','closed','[]')");
  assert.equal(board({metric:'ongoing'}).total,0);
  assert.equal(board({metric:'closed'}).total,2);
  db.exec("UPDATE company_record_progress SET stage='',node='' WHERE record_id='old-case'");
  assert.equal(board({metric:'closed'}).total,1);
  db.exec("UPDATE clients SET brokerId='broker-b' WHERE id='old'");
  assert.equal(board({metric:'closed'}).total,0);
  assert.equal(board().total,2);
  assert.ok(!JSON.stringify(board()).includes('老客户'));
});

test('未来记录不掩盖今天的注册客户；缺日期只累计；20条稳定分页和权限校验', t => {
  const { db, board } = fixture(t);
  db.exec("INSERT INTO leads VALUES ('future','new','未来股票','999999','2026-11-20')");
  assert.ok(board().items.some(row => row.title === '新客户' && row.subtitle === '待留资'));
  assert.doesNotMatch(JSON.stringify(board()),/未来股票/);
  const insert = db.prepare('INSERT INTO clients VALUES (?,?,?,?,?)');
  for(let n=0;n<25;n++) insert.run('page-'+n,'分页'+n,'','broker-a',n===0?'':'2020-02-01');
  const page1=board(),page2=board({offset:20});
  assert.equal(page1.total,28); assert.equal(page1.items.length,20); assert.equal(page2.items.length,8);
  assert.equal(new Set([...page1.items,...page2.items].map(row=>row.id)).size,28);
  assert.equal(board({offset:9999}).offset,20);
  assert.ok(!board({period:'month'}).items.some(row=>row.title==='分页0'));
  for (const input of [{period:'bad'},{metric:'bad'},{offset:-1},{period:'custom',from:'2026-02-30',to:'2026-03-01'},
    {period:'custom',from:'2026-11-19',to:'2026-11-01'},{period:'custom',from:'2026-11-01',to:'2026-11-20'}]) {
    assert.throws(()=>board(input),error=>error.status===400);
  }
  for (const role of ['sales','investor','admin']) assert.throws(()=>board({},{role,id:'broker-a'}),error=>error.status===403);
  assert.throws(()=>board({},{role:'broker',id:'broker-a',passwordChangeRequired:true}),error=>error.status===403);
});

test('券商五条分页连续无重漏，筛选与隐私范围不受每页数量影响', t => {
  const { db, board } = fixture(t);
  const insert = db.prepare('INSERT INTO clients VALUES (?,?,?,?,?)');
  for (let n = 0; n < 11; n++) insert.run('five-' + n, '分页客户' + n, '19900000099', 'broker-a', '2026-11-10');
  const original = board();
  assert.equal(original.limit, 20);
  assert.deepEqual(board({ limit: '20' }).items, original.items);
  const pages = [0, 5, 10].map(offset => board({ limit: '5', offset }));
  assert.deepEqual(pages.map(page => page.items.length), [5, 5, 4]);
  assert.ok(pages.every(page => page.limit === 5 && page.total === 14 && page.metrics.find(metric => metric.key === 'customers').value === 14));
  assert.deepEqual(pages.flatMap(page => page.items), original.items);
  assert.equal(new Set(pages.flatMap(page => page.items).map(item => item.id)).size, 14);
  assert.equal(board({ limit: 5, offset: 9999 }).offset, 10);
  assert.equal(board({ limit: 5, offset: 7 }).offset, 5);
  const day = board({ limit: 5, period: 'custom', from: '2026-11-10', to: '2026-11-10', offset: 10 });
  assert.equal(day.total, 11); assert.equal(day.items.length, 1);
  assert.doesNotMatch(JSON.stringify(pages), /19900000099|别人的客户|不能看到/);
  for (const limit of [0, 1, 10, 21, -5, 5.5, null, '', true, '05', '5.0', ' 5 ', [], {}]) {
    assert.throws(() => board({ limit }), error => error.status === 400);
  }
  assert.throws(() => board({ limit: 5 }, { role: 'sales', id: 'broker-a' }), error => error.status === 403);
});

test('券商客户跨三页保持日期排序和唯一性，签约以实际发生日独立排序', t => {
  const { db, board } = fixture(t);
  const insert = db.prepare('INSERT INTO clients VALUES (?,?,?,?,?)');
  for (let n = 0; n < 45; n++) insert.run('ordered-' + n, '同日客户', '', 'broker-a',
    n < 40 ? '2026-11-10' : n === 44 ? '' : '2020-01-01');
  db.exec(`INSERT INTO signings VALUES ('ordered-0','2025-01-01'),('ordered-1','2026-11-18'),('ordered-2','2026-11-01')`);
  const pages = [0, 20, 40].map(offset => board({ metric: 'customers', offset }));
  const items = pages.flatMap(page => page.items);
  assert.equal(items.length, 48); assert.equal(new Set(items.map(row => row.id)).size, 48);
  assert.equal(items.at(-1).registeredOn, '');
  const dates = items.map(row => row.registeredOn).filter(Boolean);
  assert.deepEqual(dates, dates.slice().sort().reverse());
  assert.deepEqual(board({ metric: 'customers', offset: 20 }).items, pages[1].items);
  const signed = board({ metric: 'signings' });
  assert.deepEqual(signed.items.map(row => row.signedOn), ['2026-11-18', '2026-11-17', '2026-11-01', '2025-01-01']);
  assert.match(signed.orderLabel, /实际签约日期/);
});


test('券商统计和统一记录使用相同的已关联客户档案，客户不重复且签约日期不补造', t => {
  const records = [{ id: 'registry:linked', customerId: 'old', clientId: 'old', recordKind: 'registry', customer: '老客户',
    stockName: '已关联股票', stockCode: '123456', registeredOn: '2025-05-01', status: '已受理', caseGroup: 'ongoing', signed: true }];
  const { db, board } = fixture(t, { all: () => records });
  db.exec('DELETE FROM signings');
  const full = board();
  assert.equal(full.total, 3, '已有客户新增股票不重复计人');
  const customer = full.items.find(row => row.id === 'old');
  assert.equal(customer.customerId, 'old');
  assert.equal(customer.recordCount, 3);
  assert.match(customer.subtitle, /已关联股票/);
  assert.equal(board({ metric: 'ongoing' }).total, 2);
  assert.equal(board({ metric: 'effective' }).total, 1);
  assert.equal(board({ metric: 'signings' }).total, 0, '已签约状态不能充当实际签约发生日');
  const earlier = board({ period: 'custom', from: '2025-05-01', to: '2025-05-01' });
  assert.equal(earlier.total, 1); assert.equal(earlier.items[0].recordCount, 1);
  assert.doesNotMatch(earlier.items[0].subtitle, /新股票|旧股票/);
  assert.equal(earlier.metrics.find(row => row.key === 'ongoing').value, 1);
  assert.ok(board({ metric: 'ongoing' }).items.every(row => row.customerId === 'old'));
  records.splice(0);
  assert.equal(board().items.find(row => row.id === 'old').recordCount, 2);
  assert.equal(board({ metric: 'ongoing' }).total, 1);
});

test('券商搜索只筛选当前明细，指标不变，客户股票摘要保持当前期间范围', t => {
  const {db,board}=fixture(t);
  const baseline=board({period:'month'});
  assert.equal(baseline.q,'');assert.equal(baseline.scopeTotal,baseline.total);
  for(const q of ['老客户','新股票','000002','  新股票  ']) {
    const found=board({period:'month',q});
    assert.equal(found.q,q.trim());assert.equal(found.total,1);assert.equal(found.scopeTotal,3);
    assert.deepEqual(found.metrics,baseline.metrics);assert.equal(found.items[0].recordCount,1);
    assert.equal(found.items[0].id,'old');assert.doesNotMatch(found.items[0].subtitle,/旧股票/);
  }
  assert.equal(board({period:'month',q:'旧股票'}).total,0,'本期搜索不凭期间外股票拉入客户');
  const all=board({q:'旧股票'});
  assert.equal(all.total,1);assert.equal(all.items[0].recordCount,2);
  assert.match(all.items[0].subtitle,/旧股票/);assert.match(all.items[0].subtitle,/新股票/);
  const caseFound=board({metric:'closed',q:'新股票索赔'});
  assert.equal(caseFound.total,1);assert.equal(caseFound.scopeTotal,1);assert.equal(caseFound.items[0].id,'closed');
  assert.equal(board({metric:'ongoing',q:'早期案件'}).items[0].id,'old-case');
  assert.equal(board({metric:'closed',q:'000002'}).total,1,'案件搜索包含未显示于案件标题的股票代码');
  for(const metric of baseline.metrics) assert.ok(metric.description);
  assert.equal(baseline.metrics.find(row=>row.key==='effective').label,'已签约客户');
  assert.equal(board().metrics.find(row=>row.key==='signings').label,'签约登记人数');
  assert.match(baseline.metrics.find(row=>row.key==='effective').description,/不要求填写签约日期/);
  assert.match(baseline.metrics.find(row=>row.key==='signings').description,/实际签约日期/);
  assert.equal(board({metric:'effective',ledger:'negotiating',q:'老客户'}).total,0);
  assert.equal(board({metric:'signings',period:'custom',from:'2026-11-17',to:'2026-11-17',q:'旧股票'}).total,1,
    '签约事件按实际签约日，股票搜索仍覆盖该客户全部授权档案');
  db.exec("UPDATE clients SET brokerId='broker-b' WHERE id='old'");
  assert.equal(board({q:'老客户'}).total,0);assert.equal(board({metric:'closed',q:'新股票'}).total,0);
});

test('券商姓名股票查询规范化，不受摘要截断影响，不搜电话或扩大授权', t => {
  const {db,board}=fixture(t);
  const insert=db.prepare('INSERT INTO leads VALUES (?,?,?,?,?)');
  for(let n=0;n<10;n++)insert.run('search-'+n,'old',n===9?'ＡｎＴ 隐藏股票':'普通股票'+n,'CODE'+n,'2026-11-10');
  const found=board({q:' ant 隐藏股票 '});
  assert.equal(found.total,1);assert.equal(found.items[0].recordCount,12);
  assert.doesNotMatch(found.items[0].subtitle,/隐藏股票/,'摘要8项上限不影响完整检索');
  assert.equal(board({q:'ｃｏｄｅ９'}).total,1);
  assert.equal(board({q:'19900000001'}).total,0,'不搜手机号');
  for(const q of ['不能看到','别人的客户',"' OR 1=1 --",'%','_','<script>alert(1)</script>']) {
    const result=board({q});assert.equal(result.total,0);assert.equal(result.scopeTotal,3);
    assert.deepEqual(result.metrics,board().metrics);
  }
  assert.doesNotMatch(JSON.stringify(found),/19900000001|searchTerms|progressId|contract/);
  for(const q of [null,123,{},[],true,'字'.repeat(101)]) assert.throws(()=>board({q}),error=>error.status===400);
  assert.equal(board({q:'字'.repeat(100)}).total,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM leads').get().n,13);
});

test('券商搜索在授权日期集合内完整分页，筛前数量与指标一致，末页夹紧无重漏', t => {
  const {db,board}=fixture(t), insert=db.prepare('INSERT INTO clients VALUES (?,?,?,?,?)');
  for(let n=0;n<13;n++)insert.run('match-'+n,'检索客户'+n,'','broker-a',n===12?'2020-01-01':'2026-11-10');
  insert.run('private-match','检索客户-其他券商','','broker-b','2026-11-10');
  const filters={period:'month',q:'检索客户',limit:5};
  const pages=[0,5,10].map(offset=>board({...filters,offset}));
  assert.deepEqual(pages.map(row=>row.items.length),[5,5,2]);
  assert.ok(pages.every(row=>row.total===12 && row.scopeTotal===15 && row.metrics.find(metric=>metric.key==='customers').value===15));
  const items=pages.flatMap(row=>row.items);assert.equal(new Set(items.map(row=>row.id)).size,12);
  assert.deepEqual(items,board({...filters,limit:20}).items);
  assert.deepEqual(board({...filters,offset:9999}).items,pages[2].items);
  assert.equal(board({...filters,q:'未命中',offset:9999}).offset,0);
  assert.equal(board({...filters,q:'检索客户12'}).total,0);
});

test('签约状态与文本只筛明细，概览及缺日期提示不变，scopeTotal为状态筛选后数量', t=>{
  const {db,board}=fixture(t);
  db.exec("INSERT INTO clients VALUES ('unknown-date','缺日期客户','','broker-a','')");
  for(const period of ['all','month']) {
    const base=board({period}), customerCount=base.metrics.find(row=>row.key==='customers').value;
    for(const ledger of ['signed','negotiating']) {
      const narrowed=board({period,ledger}), searched=board({period,ledger,q:'未命中',offset:999});
      assert.deepEqual(narrowed.metrics,base.metrics);
      assert.deepEqual(searched.metrics,base.metrics);
      assert.equal(narrowed.scopeTotal,ledger==='signed'?1:customerCount-1);
      assert.equal(searched.scopeTotal,narrowed.total);assert.equal(searched.total,0);assert.equal(searched.offset,0);
    }
    const emptySigned=board({period,metric:'effective',ledger:'negotiating'});
    assert.equal(emptySigned.total,0);assert.equal(emptySigned.scopeTotal,0);
    assert.equal(emptySigned.metrics.find(row=>row.key==='effective').value,1);
    assert.deepEqual(emptySigned.metrics,base.metrics);
    for(const metric of ['customers','effective','ongoing','closed']) {
      assert.ok(!board({period,metric}).notes.some(note=>/签约登记人数|本月新增签约|期间新增签约/.test(note)));
    }
    const legacy=board({period,metric:'signings',ledger:'negotiating'});
    assert.equal(legacy.total,1,'兼容旧签约事件接口，不改变其实际日期统计口径');
    assert.ok(legacy.notes.some(note=>note.includes('签约登记人数')));
    assert.deepEqual(legacy.metrics,base.metrics);
  }
});
