import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';
import { createAppServer } from '../server.mjs';
import { activateApiAccount } from '../test-support/business-account.mjs';

// Use the shipped page and request wrapper. The wx adapter forwards HTTP to the isolated server.
function miniRegistry(origin, token) {
  let page;
  const app = { globalData: { token } };
  const clientModule = { exports: {} };
  const wx = {
    async request({ url, method, header, success, fail }) {
      try {
        const endpoint = new URL(url);
        assert.equal(endpoint.origin, 'http://127.0.0.1:7101');
        assert.equal(endpoint.pathname, '/api/registry');
        const result = await fetch(origin + endpoint.pathname + endpoint.search, { method, headers: header });
        success({ statusCode: result.status, data: await result.json() });
      } catch (error) { fail(error); }
    },
  };
  const getApp = () => app;
  vm.runInNewContext(readFileSync(new URL('../miniprogram/client.js', import.meta.url), 'utf8'), { wx, getApp, module: clientModule });
  vm.runInNewContext(readFileSync(new URL('../miniprogram/pages/registry/index.js', import.meta.url), 'utf8'), {
    getApp, require: () => clientModule.exports, Page: definition => { page = definition; },
  });
  page.setData = patch => Object.assign(page.data, patch);
  return page;
}

test('管理员通过网页接口核实并关联登记人后，小程序销售和股民只读各自记录，解除关联后刷新即清空', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'huzi-mini-registry-'));
  const database = join(directory, 'demo.sqlite');
  const credentials = { username: 'registry-ops', password: 'test-password-foo', name: '测试运营' };
  const server = createAppServer({ database, admin: credentials });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    unlinkSync(database); rmdirSync(directory);
  });
  const db = new DatabaseSync(database);
  try {
    db.exec(`CREATE TABLE registry_meta(key TEXT PRIMARY KEY,value TEXT);
      INSERT INTO registry_meta VALUES ('source_name','仅后台可见.xlsx'),('imported_at','2026-11-18T00:00:00Z');
      CREATE TABLE registry_entries(entry_key TEXT PRIMARY KEY,source_row INTEGER,customer TEXT,phone TEXT,
        sales TEXT,stock_name TEXT,stock_code TEXT,source TEXT,registered_on TEXT,filed_on TEXT,stage TEXT)`);
    const insert = db.prepare("INSERT INTO registry_entries VALUES (?,?,?,?,?,?,'000001','', '2026-11-17','','')");
    insert.run('row-1',3,'甲客户','19900005555','甲销售','共同股票');
    insert.run('row-2',4,'甲客户','19900005555','乙销售','股民独有股票');
    insert.run('row-3',5,'甲客户','19900005556','甲销售','销售独有股票');
  } finally { db.close(); }
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, payload) => {
    const result = await fetch(origin + '/api' + path, {
      method: payload ? 'POST' : 'GET', headers: { ...(cookie && path.startsWith('/admin/') && { cookie }),
        ...(payload && { 'Content-Type': 'application/json' }) }, body: payload && JSON.stringify(payload),
    });
    const body = await result.json();
    assert.equal(result.status, 200, body.message);
    if (path === '/admin/auth/login') cookie = result.headers.get('set-cookie').split(';')[0];
    return body;
  };
  await call('/admin/auth/login', credentials);
  await call('/admin/accounts/sales', { name:'甲销售', username:'owner-a' });
  await activateApiAccount(origin + '/api', 'owner-a', 'sales-password');
  const seller = await call('/auth/login', { platform:'mini', username:'owner-a', password:'sales-password' });
  const investor = await call('/auth/register', { platform:'mini', phone:'19900005555', password:'investor-password' });
  const salesPage = miniRegistry(origin, seller.token);
  const investorPage = miniRegistry(origin, investor.token);
  async function check(page, stocks) {
    await page.onShow();
    assert.equal(page.data.notice, '');
    assert.deepEqual(Array.from(page.data.items, item => item.stockName), stocks);
    assert.equal(page.data.total,stocks.length);
    for (const item of page.data.items) {
      assert.ok(item.rowKey);
      assert.ok(!('entryKey' in item || 'salesLink' in item || 'sourceRow' in item || 'sourceName' in item));
    }
  }
  await check(salesPage, []); await check(investorPage, []);
  async function setLink(type, q, enabled) {
    const scope = await call('/admin/registry/candidates?' + new URLSearchParams({ entryKey:'row-1', type, q }));
    assert.equal(scope.affectedCount,2);
    await call('/admin/registry/link', {
      type, entryKey:'row-1', confirmed:true, sourceToken:scope.sourceToken,
      identityId:enabled ? scope.items[0].identityId : null,previousIdentityId:scope.currentLink?.identityId ?? null,
    });
  }
  await setLink('sales','owner-a',true);
  await setLink('investor','19900005555',true);
  await check(salesPage,['共同股票','销售独有股票']);
  await check(investorPage,['共同股票','股民独有股票']);
  investorPage.input({ detail:{value:'销售独有股票'} }); await investorPage.search();
  assert.equal(investorPage.data.total,0);
  await investorPage.reset(); investorPage.onHide(); assert.equal(investorPage.data.items.length,0);
  await setLink('investor','19900005555',false);
  await check(investorPage,[]);
  await check(salesPage,['共同股票','销售独有股票']);
  await setLink('sales','owner-a',false);
  await check(salesPage,[]);
});
