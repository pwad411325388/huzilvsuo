import assert from 'node:assert/strict';

const initialPassword = '12345678';

export function activateStoredAccount(store, username, personalPassword) {
  const identity = store.verifyLogin({ username, password: initialPassword });
  const actor = store.getSession(store.createSession(identity.id));
  assert.equal(actor.passwordChangeRequired, true);
  store.changePassword(actor, { currentPassword: initialPassword, password: personalPassword });
}

export async function activateApiAccount(api, username, personalPassword) {
  const login = await fetch(api + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: initialPassword, platform: 'mini' }),
  });
  const session = await login.json();
  assert.equal(login.status, 200, session.message);
  assert.equal(session.actor.passwordChangeRequired, true);
  const changed = await fetch(api + '/auth/change-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token },
    body: JSON.stringify({ currentPassword: initialPassword, password: personalPassword }),
  });
  assert.equal(changed.status, 200, (await changed.json()).message);
}
