import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
// Wait for the launcher process, not for pipe handles inherited by its detached
// service on Windows. A healthy background service must not hold the test open.
const ps = (file, args = []) => new Promise((resolve,reject)=>{
  const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args],
    {windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8');});
  child.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8');});
  const timer=setTimeout(()=>child.kill(),45000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('exit',(code,signal)=>{clearTimeout(timer);child.stdout.destroy();child.stderr.destroy();
    if(code===0)resolve({stdout,stderr});else reject(Object.assign(new Error(stdout+'\n'+stderr),{code,signal}));});
});
function temporary(t) {
  const directory=mkdtempSync(join(tmpdir(),'huzi-startup-test-'));
  t.after(()=>{
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep) && basename(directory).startsWith('huzi-startup-test-'));
    rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  return directory;
}
async function availablePort() {
  const probe=createServer(); await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port; await new Promise(resolve=>probe.close(resolve)); return port;
}

test('Windows启动器筛选物理内网网卡，稳定选择优先级并拒绝错误进程与PID复用', {skip:!windows}, async t=>{
  const directory=temporary(t), script=join(directory,'checks.ps1');
  const helpers=join(root,'scripts','local_runtime.ps1').replaceAll("'","''");
  writeFileSync(script,'\ufeff'+`
$ErrorActionPreference='Stop'
. '${helpers}'
$base=@{Status='Up';HardwareInterface=$true;InterfaceType=71;Gateway='192.168.1.1';Name='WLAN';Description='Physical';RouteMetric=0;InterfaceMetric=35;InterfaceIndex=15;Address='192.168.1.5'}
function Candidate($changes) { $v=$base.Clone(); foreach($k in $changes.Keys){$v[$k]=$changes[$k]}; [pscustomobject]$v }
$items=@((Candidate @{}),(Candidate @{Name='Ethernet';InterfaceType=6;InterfaceIndex=18;InterfaceMetric=10;Address='10.0.0.3'}),
 (Candidate @{Description='WireGuard VPN';InterfaceMetric=1;Address='10.2.0.1'}),(Candidate @{HardwareInterface=$false;Address='10.3.0.1'}),
 (Candidate @{Gateway='';Address='192.168.5.2'}),(Candidate @{Address='169.254.1.2'}),(Candidate @{Status='Down';Address='192.168.3.2'}))
if((Select-LanCandidate $items).Address -ne '10.0.0.3'){throw 'metric selection'}
if((Select-LanCandidate $items '192.168.1.5').InterfaceIndex -ne 15){throw 'explicit selection'}
$rejected=$false; try { Select-LanCandidate $items '10.2.0.1' | Out-Null } catch {$rejected=$true}; if(-not $rejected){throw 'VPN selection'}
foreach($ip in @('127.0.0.1','169.254.1.1','172.32.0.1','8.8.8.8','::1')){if(Test-PrivateIPv4 $ip){throw 'not private'}}
foreach($ip in @('10.0.0.1','172.16.0.1','172.31.255.254','192.168.1.2')){if(-not (Test-PrivateIPv4 $ip)){throw 'private rejected'}}
$script='C:\\test folder\\server.mjs';$time=[datetime]::UtcNow
$p=[pscustomobject]@{ProcessId=321;ExecutablePath='C:\\node.exe';CreationDate=$time;CommandLine='"C:\\node.exe" "'+$script+'"'}
$m=[pscustomobject]@{pid=321;port=7101;script=$script;executable=$p.ExecutablePath;startedAt=$time.ToUniversalTime().ToString('o')}
if(-not (Test-OwnedServer $m $p $script 7101)){throw 'valid ownership'}
$p.CreationDate=$time.AddSeconds(1);if(Test-OwnedServer $m $p $script 7101){throw 'reused pid'}
$p.CreationDate=$time;$p.CommandLine='node server.mjs';if(Test-OwnedServer $m $p $script 7101){throw 'relative unknown process'}
Write-Output 'ok'
`);
  assert.match((await ps(script)).stdout,/ok/);
});

test('Windows启动器实际隔离验证：本机到LAN切换、配置持久化、重复复用和恢复本机', {skip:!windows,timeout:90000}, async t=>{
  const pids=new Set();
  t.after(async()=>{for(const pid of pids){try{process.kill(pid)}catch{}} await new Promise(resolve=>setTimeout(resolve,250));});
  const directory=temporary(t), scripts=join(directory,'scripts'), runtime=join(directory,'.runtime');
  mkdirSync(scripts);mkdirSync(join(directory,'miniprogram'));mkdirSync(join(directory,'node_modules','write-excel-file'),{recursive:true});
  writeFileSync(join(directory,'node_modules','write-excel-file','package.json'),'{}');
  copyFileSync(join(root,'scripts','start_local.ps1'),join(scripts,'start_local.ps1'));
  const helpers=readFileSync(join(root,'scripts','local_runtime.ps1'),'utf8');
  writeFileSync(join(scripts,'local_runtime.ps1'),helpers+`
function Get-LanCandidates { [pscustomobject]@{Status='Up';HardwareInterface=$true;InterfaceType=71;Gateway='192.168.2.1';Name='WLAN';Description='Physical';RouteMetric=0;InterfaceMetric=35;InterfaceIndex=15;Address='192.168.2.43'} }
`);
  writeFileSync(join(directory,'server.mjs'),`import {createServer} from 'node:http';
createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(req.url==='/api/health'?JSON.stringify({mode:'local'}):'<title>股民索赔宝 · 沪紫律师事务所</title><script src="/app.js"></script>')}).listen(Number(process.env.DEMO_PORT),process.env.DEMO_HOST);`);
  const launcher=join(scripts,'start_local.ps1'), port=await availablePort();
  const manifest=()=>JSON.parse(readFileSync(join(runtime,'server-process.json'),'utf8'));
  await ps(launcher,['-LocalOnly','-Port',String(port)]);pids.add(manifest().pid);
  assert.equal(manifest().host,'127.0.0.1');
  const localPid=manifest().pid;
  await ps(launcher);assert.equal(manifest().pid,localPid,'healthy reuse');
  const lan=await ps(launcher,['-Lan']);pids.add(manifest().pid);
  assert.notEqual(manifest().pid,localPid);assert.equal(manifest().host,'0.0.0.0');
  assert.match(lan.stdout,new RegExp('192\\.168\\.2\\.43:'+port+'/api/health'));
  assert.equal(JSON.parse(readFileSync(join(runtime,'startup-config.json'),'utf8')).mode,'lan');
  assert.match(readFileSync(join(directory,'miniprogram','network-config.js'),'utf8'),new RegExp('192\\.168\\.2\\.43:'+port+'/api'));
  const lanPid=manifest().pid;await ps(launcher);assert.equal(manifest().pid,lanPid,'autostart keeps LAN mode');
  const original=readFileSync(join(runtime,'server-process.json'),'utf8');
  writeFileSync(join(runtime,'server-process.json'),JSON.stringify({...manifest(),startedAt:'wrong-start-time'}));
  await assert.rejects(ps(launcher,['-LocalOnly']),error=>error.code===1);
  process.kill(lanPid,0);assert.equal(JSON.parse(readFileSync(join(runtime,'startup-config.json'),'utf8')).mode,'lan');
  writeFileSync(join(runtime,'server-process.json'),original);
  await ps(launcher,['-LocalOnly']);pids.add(manifest().pid);
  assert.equal(manifest().host,'127.0.0.1');assert.notEqual(manifest().pid,lanPid);
  assert.match(readFileSync(join(directory,'miniprogram','network-config.js'),'utf8'),new RegExp('127\\.0\\.0\\.1:'+port+'/api'));
});
