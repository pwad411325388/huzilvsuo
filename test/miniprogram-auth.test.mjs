import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createAppServer } from '../server.mjs';

test('小程序真实页面逻辑完成恢复码找回、后台重置后强制改密与注销退出', async t => {
  const server = createAppServer({ admin: { username: 'mini-admin', password: 'admin-password', name: '测试管理员' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const storage = new Map();
  const app = { globalData: { token: '', pendingPromos: [] }, savePromos(codes) { this.globalData.pendingPromos = codes; } };
  let destination;
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    switchTab: ({ url }) => { destination = url; }, reLaunch: ({ url }) => { destination = url; }, showToast() {},
    request({ url, method, data, header, success, fail }) {
      fetch(url, { method, headers: header, body: method === 'POST' ? JSON.stringify(data) : undefined })
        .then(async response => success({ statusCode: response.status, data: await response.json() })).catch(fail);
    },
  };
  const clientModule = { exports: {} };
  const clientSource = readFileSync(new URL('../miniprogram/client.js', import.meta.url), 'utf8').replace('http://127.0.0.1:7101/api', base);
  vm.runInNewContext(clientSource, { wx, getApp: () => app, module: clientModule });
  const makeLogin = () => {
    let page;
    vm.runInNewContext(readFileSync(new URL('../miniprogram/pages/login/index.js', import.meta.url), 'utf8'), {
      wx, getApp: () => app, require: () => clientModule.exports, Page: value => { page = value; },
    });
    page.setData = updates => Object.assign(page.data, updates);
    return page;
  };
  const event = (value, type) => ({ detail: { value }, currentTarget: { dataset: { type } } });
  const login = makeLogin();
  login.toggle();
  await login.submit(event({ phone: '19900007701', password: 'original-password', confirm: 'original-password' }));
  assert.ok(app.globalData.token);
  assert.equal(destination, '/pages/home/index');
  const pageModule = { exports: {} };
  const boardModule = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../miniprogram/sales-board.js', import.meta.url), 'utf8'), {
    getApp: () => app, require: () => clientModule.exports, module: boardModule,
  });
  vm.runInNewContext(readFileSync(new URL('../miniprogram/page.js', import.meta.url), 'utf8'), {
    wx, getApp: () => app, require: name => name === './sales-board' ? boardModule.exports : clientModule.exports, module: pageModule,
  });
  const mine = pageModule.exports(false);
  mine.setData = updates => Object.assign(mine.data, updates);
  await mine.onShow();
  mine.toggleSecurity();
  await mine.submitSecurity(event({ currentPassword: 'original-password' }, 'code'));
  const code = mine.data.recoveryCode;
  assert.match(code, /^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);
  mine.onHide();
  assert.equal(mine.data.recoveryCode, '');
  await mine.logout();
  assert.equal(app.globalData.token, '');
  const forgotten = makeLogin();
  forgotten.toggleRecovery();
  await forgotten.submit(event({ username: '19900007701', code, password: 'recovered-password', confirm: 'mismatched' }));
  assert.match(forgotten.data.error, /不一致/);
  await forgotten.submit(event({ username: '19900007701', code, password: 'recovered-password', confirm: 'recovered-password' }));
  assert.equal(forgotten.data.recovering, false);
  assert.equal(app.globalData.token, '');
  await forgotten.submit(event({ username: '19900007701', password: 'recovered-password' }));
  assert.ok(app.globalData.token);

  const adminLogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mini-admin', password: 'admin-password' }) });
  const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
  const snapshot = await (await fetch(`${base}/view`, { headers: { Cookie: adminCookie } })).json();
  const target = snapshot.accounts.find(account => account.role === 'investor');
  const adminAction = (path, input) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ identityId: target.id, currentPassword: 'admin-password', ...input }) });
  assert.equal((await adminAction('/accounts/password', { password: 'temporary-password' })).status, 200);
  await mine.onShow();
  assert.equal(app.globalData.token, '');
  assert.equal(destination, '/pages/login/index');
  const temporary = makeLogin();
  await temporary.submit(event({ username: '19900007701', password: 'temporary-password' }));
  assert.equal(temporary.data.changing, true);
  assert.equal(destination, '/pages/login/index');
  const reopened = makeLogin();
  await reopened.onShow();
  assert.equal(reopened.data.changing, true);
  await reopened.submit(event({ currentPassword: 'temporary-password', password: 'personal-password', confirm: 'personal-password' }));
  assert.equal(app.globalData.token, '');
  assert.equal(reopened.data.changing, false);
  await reopened.submit(event({ username: '19900007701', password: 'personal-password' }));
  assert.equal(destination, '/pages/home/index');
  assert.equal((await adminAction('/accounts/status', { status: 'closed' })).status, 200);
  await mine.onShow();
  assert.equal(app.globalData.token, '');
  assert.equal(destination, '/pages/login/index');
});
