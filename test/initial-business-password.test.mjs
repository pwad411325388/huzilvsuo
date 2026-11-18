import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore, today } from '../store.mjs';

test('手动和新库示例开户使用统一临时密码，销售与券商改密和恢复均须设置个人密码', t => {
  const password = '12345678';
  const store = createStore(':memory:', {
    seed: true, admin: { username: 'qa-ops', password: 'admin-fixture', name: '测试管理员' },
  });
  t.after(() => store.close());
  const login = (username, credential) =>
    store.getSession(store.createSession(store.verifyLogin({ username, password: credential }).id));
  const admin = login('qa-ops', 'admin-fixture');
  assert.equal(store.view(admin).initialBusinessPassword, password);
  const existingProfile = store.openSalesAccount(admin, { name: '测试销售', salesId: 'sales-a', username: 'qa-sales' });
  assert.equal(existingProfile.id, 'sales-a');
  store.openSalesAccount(admin, { name: '测试销售乙', username: 'qa-other', password: 'custom-temporary' });
  assert.equal(login('qa-other', 'custom-temporary').passwordChangeRequired, true);
  const firstSales = login('qa-sales', password);
  assert.equal(firstSales.passwordChangeRequired, true);
  store.changePassword(firstSales, { currentPassword: password, password: 'sales-personal' });
  const sales = login('qa-sales', 'sales-personal');
  assert.equal(sales.passwordChangeRequired, false);
  assert.ok(!Object.hasOwn(store.view(sales), 'initialBusinessPassword'));
  const broker = store.registerBroker(sales, { name: '测试券商', signedOn: today() });
  store.openAccount(admin, { brokerId: broker.id, username: 'qa-broker', password: '' });
  for (const username of ['qa-broker', 'broker-a', 'broker-b']) {
    const provisional = login(username, password);
    assert.equal(provisional.passwordChangeRequired, true);
    assert.throws(() => store.changePassword(provisional, { currentPassword: password, password }), /不能与当前密码相同/);
    store.changePassword(provisional, { currentPassword: password, password: 'broker-personal' });
    assert.equal(login(username, 'broker-personal').passwordChangeRequired, false);
  }
  const { code } = store.issueRecoveryCode(sales, { currentPassword: 'sales-personal' });
  assert.throws(() => store.recoverPassword({ username: 'qa-sales', password, code }), /默认初始密码/);
  store.recoverPassword({ username: 'qa-sales', password: 'recovered-personal', code });
  assert.equal(login('qa-sales', 'recovered-personal').passwordChangeRequired, false);
  assert.throws(() => store.changePassword(login('qa-broker', 'broker-personal'), { currentPassword: 'broker-personal', password }), /默认初始密码/);
  store.registerInvestor({ phone: '19900008102', password });
  const investor = login('19900008102', password);
  assert.equal(investor.passwordChangeRequired, false);
  assert.ok(!Object.hasOwn(store.view(investor), 'initialBusinessPassword'));
});
