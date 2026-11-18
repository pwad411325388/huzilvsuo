import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAppServer } from '../server.mjs';

test('台账销售开户按原名和业务星标关联，冲突保留，临时密码与其他人的记录隔离', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'huzi-registry-batch-'));
  const database = join(directory, 'fixture.sqlite');
  const admin = { name: '测试运营', username: 'fixture-admin', password: 'admin-fixture-pass' };
  const server = createAppServer({ database, admin });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const db = new DatabaseSync(database);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close(); unlinkSync(database); rmdirSync(directory);
  });
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  async function call(url, data, token, expected = 200) {
    const response = await fetch(origin + url, {
      method: data ? 'POST' : 'GET', body: data && JSON.stringify(data),
      headers: { 'Content-Type': 'application/json', ...(url.startsWith('/admin/') && cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    });
    const body = await response.json();
    assert.equal(response.status, expected, body.message);
    if (url === '/admin/auth/login') cookie = response.headers.get('set-cookie').split(';')[0];
    return body;
  }
  const path = '/admin/registry/sales-batch';
  const apply = (token, expected) => call(path, { confirmed: true, token }, undefined, expected);
  const login = account => call('/auth/login', { platform: 'mini', username: account.username, password: account.password });
  await call('/admin/auth/login', admin);
  const empty = await call(path);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(await apply(empty.token), { created: [], review: [], linkedLabels: 0, linkedRecords: 0 });
  for (const [name, username] of [['林乙', 'sales-0001'], ['林丙', 'closed-sales'], ['林丁', 'dup-one'], ['林丁', 'dup-two']]) {
    await call('/admin/accounts/sales', { name, username, password: 'existing-sales-pass' });
  }
  const initial = await login({ username: 'sales-0001', password: 'existing-sales-pass' });
  await call('/auth/change-password', { currentPassword:'existing-sales-pass', password:'existing-personal-pass' }, initial.token);
  const existing = await login({ username: 'sales-0001', password: 'existing-personal-pass' });
  await call('/registry/sales-batch', undefined, existing.token, 403);
  await call('/registry/sales-batch', { confirmed:true, token:empty.token }, existing.token, 403);
  db.exec(`UPDATE identities SET status='closed' WHERE username='closed-sales';
    CREATE TABLE registry_entries(entry_key TEXT PRIMARY KEY,source_row INTEGER,customer TEXT,phone TEXT,sales TEXT,
      stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,filed_on TEXT,stage TEXT);
    CREATE TABLE registry_meta(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO sales_staff(id,name) VALUES ('existing-profile','林庚');`);
  const insert = db.prepare("INSERT INTO registry_entries VALUES (?,?,?,'',?,'甲股票','000001','','','','')");
  let rowNumber = 0;
  const entry = (name, person) => insert.run('entry-' + (++rowNumber), rowNumber, person, name);
  for (const name of ['林甲', '*林甲', '*林甲', '林乙', '林丙', '林丁', '主任', '林戊', '*林戊', '林庚']) entry(name, '合成股民');
  const id = db.prepare('SELECT id FROM identities WHERE username=?').get('sales-0001').id;
  db.prepare("INSERT INTO registry_links VALUES ('sales','*林戊','',?)").run(id);
  const stale = await call(path);
  entry('林甲', '新登记股民');
  await apply(stale.token, 409);
  assert.equal(db.prepare("SELECT count(*) AS n FROM identities WHERE name='林甲'").get().n, 0);
  const preview = await call(path);
  const status = Object.fromEntries(preview.rows.map(row => [row.name, row.status]));
  assert.deepEqual(status, { 林甲:'create', 林乙:'reuse', 林丙:'review', 林丁:'review', 主任:'review', 林戊:'review', 林庚:'create' });
  assert.equal(preview.rows.find(row => row.name === '林甲').recordCount, 4);
  const { created, review, linkedRecords, linkedLabels } = await apply(preview.token);
  assert.equal(review.length, 4); assert.equal(linkedRecords, 6); assert.equal(linkedLabels, 4);
  assert.equal(created.length, 2);
  assert.ok(created.every(row => row.password === '12345678'));
  const hashes = created.map(row => db.prepare('SELECT password FROM identities WHERE username=?').get(row.username).password);
  assert.notEqual(hashes[0], hashes[1]);
  for (const row of created) {
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes(row.password));
    assert.notEqual(row.username, 'sales-0001');
  }
  const newAccount = created.find(row => row.name === '林甲');
  const provisional = await login(newAccount);
  assert.equal(provisional.actor.passwordChangeRequired, true);
  await call('/registry', undefined, provisional.token, 403);
  assert.equal((await call('/view', undefined, provisional.token)).registryCount, undefined);
  await call('/auth/change-password', { currentPassword:newAccount.password, password:'replacement-credential' }, provisional.token);
  await call('/auth/login', { platform:'mini', username:newAccount.username, password:newAccount.password }, undefined, 401);
  const seller = await login({ username:newAccount.username, password:'replacement-credential' });
  const view = await call('/view', undefined, seller.token);
  assert.equal(view.registryCount, 4); assert.equal(view.registryPreview.length, 3);
  assert.deepEqual(Object.keys(view.registryPreview[0]).sort(), ['customer', 'stockName', 'stockCode', 'rowKey'].sort());
  const own = await call('/registry', undefined, seller.token);
  assert.equal(own.total, 4); assert.ok(own.items.every(item => ['林甲', '*林甲'].includes(item.sales)));
  const reused = await call('/registry', undefined, existing.token);
  assert.deepEqual(reused.items.map(item => item.sales), ['林乙', '*林戊']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM identities WHERE role='investor'").get().n,0);
  assert.equal(db.prepare("SELECT status FROM identities WHERE username='closed-sales'").get().status, 'closed');
  assert.equal(db.prepare("SELECT subjectId FROM identities WHERE username=?").get(created.find(row => row.name === '林庚').username).subjectId, 'existing-profile');
  const again = await call(path);
  assert.equal(again.rows.filter(row => row.status === 'linked').length, 3);
  const replay = await apply(again.token);
  assert.deepEqual(replay.created, []); assert.equal(replay.linkedRecords, 0);
  await apply(preview.token, 409);
});
