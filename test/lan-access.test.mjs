import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer, isLoopbackAddress } from '../server.mjs';
import { createStore } from '../store.mjs';

test('LAN只能访问业务接口；管理员登录、会话和恢复被拒绝，伪造Host/转发头不绕过', async t=>{
  const directory=mkdtempSync(join(tmpdir(),'huzi-lan-access-')), database=join(directory,'fixture.sqlite');
  const admin={username:'lan-admin',password:'LocalAdmin-private-test!',name:'合成管理员'};
  const store=createStore(database,{admin});
  const identity=store.verifyLogin(admin), adminToken=store.createSession(identity.id), actor=store.getSession(adminToken);
  const recovery=store.issueRecoveryCode(actor,{currentPassword:admin.password});
  const investorId=store.registerInvestor({phone:'19900006789',password:'investor-lan-test!'});
  const investorToken=store.createSession(investorId), investor=store.getSession(investorToken);
  const investorRecovery=store.issueRecoveryCode(investor,{currentPassword:'investor-lan-test!'});
  const server=createAppServer({database}), db=new DatabaseSync(database);
  // Exercise the real request handler with only the TCP peer address substituted.
  // Production never reads this header; it is installed exclusively by this test.
  server.prependListener('request',request=>Object.defineProperty(request.socket,'remoteAddress',{
    configurable:true,value:request.headers['x-test-remote'] || '127.0.0.1'}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();db.close();
    for(const file of readdirSync(directory))unlinkSync(join(directory,file));rmdirSync(directory);});
  const base='http://127.0.0.1:'+server.address().port;
  const request=(path,{remote=true,token,body,headers={}}={})=>fetch(base+path,{method:body?'POST':'GET',headers:{
    ...(remote?{'x-test-remote':'192.168.2.100'}:{}),...(token?{Authorization:'Bearer '+token}:{}),
    ...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  for(const path of ['/admin','/admin/','/api/admin/health','/api/admin/view','/api/admin/auth/login']) {
    assert.equal((await request(path,{body:path.endsWith('login')?admin:undefined,headers:{Host:'127.0.0.1','X-Forwarded-For':'127.0.0.1'}})).status,403,path);
  }
  for(const platform of [undefined,'mini']) assert.equal((await request('/api/auth/login',{body:{...admin,platform}})).status,403);
  for(const path of ['/api/view','/api/export','/api/accounts','/api/registry','/api/auth/change-password','/api/auth/logout']) {
    const body=path==='/api/accounts'?{username:'must-not-create'}:path.includes('change-password')?{currentPassword:admin.password,password:'never-change-admin!'}:path.endsWith('logout')?{}:undefined;
    assert.equal((await request(path,{token:adminToken,body})).status,403,path);
  }
  const tableSnapshot=()=>JSON.stringify(['identities','auth_sessions','password_recovery','recovery_attempts'].map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()));
  const before=tableSnapshot();
  for(const code of ['invalid',recovery.code]) assert.equal((await request('/api/auth/recover',{body:{username:admin.username,password:'admin-after-recovery!',code}})).status,403);
  assert.equal(tableSnapshot(),before,'远端管理员恢复不改密码/会话、不消耗恢复码和限流次数');
  assert.equal((await request('/api/health')).status,200);
  assert.equal((await request('/api/view',{token:investorToken})).status,200);
  const loggedIn=await request('/api/auth/login',{body:{username:investor.account,password:'investor-lan-test!',platform:'mini'}});
  assert.equal(loggedIn.status,200);assert.ok((await loggedIn.json()).token);
  assert.equal((await request('/api/auth/recover',{body:{username:investor.account,password:'investor-after-recovery!',code:investorRecovery.code}})).status,200);
  for(const remote of ['127.0.0.1','::1','::ffff:127.0.0.1']) {
    assert.equal((await request('/admin',{headers:{'x-test-remote':remote}})).status,200);
    assert.equal((await request('/api/view',{token:adminToken,headers:{'x-test-remote':remote}})).status,200);
  }
  assert.equal((await request('/api/auth/recover',{remote:false,body:{username:admin.username,password:'admin-after-recovery!',code:recovery.code}})).status,200);
  assert.equal(store.verifyLogin({username:admin.username,password:'admin-after-recovery!'}).role,'admin');
  for(const address of ['127.0.0.1','127.0.0.2','::1','::ffff:127.0.0.1'])assert.equal(isLoopbackAddress(address),true);
  for(const address of ['192.168.2.100','10.0.0.2','::ffff:192.168.2.100','',undefined])assert.equal(isLoopbackAddress(address),false);
});
