import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createBrokerBoard } from '../broker-board.mjs';
import { RequestError } from '../store.mjs';

function fixture(t) {
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
  const board = createBrokerBoard(db, { transaction: fn => fn(), today: () => '2026-11-19',
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
