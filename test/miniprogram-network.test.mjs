import assert from 'node:assert/strict';
import test from 'node:test';
import { nativePages } from '../test-support/native-page.mjs';

function clientAt(apiBase, version, handler) {
  const app = { globalData: { token:'test-session' } };
  const wx = { request:handler };
  if (version) wx.getAccountInfoSync = () => ({ miniProgram:{envVersion:version} });
  return nativePages({ app,wx,networkConfig:{apiBase} }).load('client.js');
}

test('开发与体验版按配置访问电脑，登录请求和现有令牌沿用原协议', async () => {
  for (const [base,version] of [['http://192.168.2.43:7101/api/','develop'],['http://127.0.0.1:7101/api','trial']]) {
    let received;
    const client = clientAt(base,version,request => {
      received = request;
      request.success({statusCode:200,data:{accepted:true}});
    });
    const input = {username:'test-user',password:'test-password'};
    const result = await client.request('/auth/login',input);
    assert.equal(result.accepted,true);
    assert.equal(received.url,base.replace(/\/$/,'') + '/auth/login');
    assert.equal(received.method,'POST');
    assert.equal(received.data,input);
    assert.equal(received.header.Authorization,'Bearer test-session');
  }
});

test('无效地址或正式版的本机地址在发送请求前拦截，未知版本沿用正式版约束', async () => {
  let calls = 0;
  const send = request => { calls++; request.success({statusCode:200,data:{}}); };
  for (const base of ['ftp://service.example/api','https://u:SECRET@service.example/api','http://service.example/api?q=SECRET',
    'https://service.example/api#SECRET','http://192.168.2.300:7101/api','http://localhost:70000/api','//localhost/api']) {
    await assert.rejects(clientAt(base,'develop',send).request('/view'),error => /配置无效/.test(error.message) && !error.message.includes('SECRET'));
  }
  for (const version of ['release',undefined]) {
    for (const base of ['http://service.example/api','http://192.168.2.43:7101/api','https://127.0.0.1/api',
      'https://192.168.2.43/api','https://localhost/api','https://dev.local/api']) {
      await assert.rejects(clientAt(base,version,send).request('/view'),/公网 HTTPS/);
    }
  }
  assert.equal(calls,0);
  await clientAt('https://service.example/api','release',send).request('/view');
  assert.equal(calls,1);
});

test('连接错误只显示检测地址，业务返回的账号错误仍单独显示', async () => {
  const rejectNetwork = call => call.fail({errMsg:'test-password test-session'});
  const local = clientAt('http://192.168.2.43:7101/api','develop',rejectNetwork);
  await assert.rejects(local.request('/auth/login',{password:'test-password'}),error =>
    error.message.includes('http://192.168.2.43:7101/api/health') && error.message.includes('同一 Wi-Fi') &&
    error.message.includes('启动真机调试.cmd') && error.message.includes('重新编译并扫码真机调试') && !/test-password|test-session|auth\/login/.test(error.message));
  const loopback = clientAt('http://127.0.0.1:7101/api','develop',rejectNetwork);
  await assert.rejects(loopback.request('/view'),/电脑.*127\.0\.0\.1:7101\/api\/health.*重新编译并扫码真机调试/);
  const release = clientAt('https://service.example/api','release',rejectNetwork);
  await assert.rejects(release.request('/view'),error=>/检查手机网络/.test(error.message) && !/真机调试|Wi-Fi|test-session/.test(error.message));
  const denied = clientAt('http://127.0.0.1:7101/api','develop',call => call.success({statusCode:401,data:{message:'账号或密码错误'}}));
  await assert.rejects(denied.request('/auth/login',{}),error=>error.status===401 && error.message==='账号或密码错误');
});
