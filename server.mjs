import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import writeExcelFile from 'write-excel-file/node';
import { createStore, RequestError, sessionSeconds } from './store.mjs';
import { reportDefinition, reportRows } from './web/report.js';

const webRoot = fileURLToPath(new URL('./web/', import.meta.url));
const runFile = promisify(execFile);
const registryImporter = fileURLToPath(new URL('./scripts/import_registry.py', import.meta.url));
const defaultRegistryFile = fileURLToPath(new URL('../测试数据/诉讼组—股民登记表格.xlsx', import.meta.url));
const assets = {
  '/': ['app-shell.html', 'text/html'],
  '/admin': ['app-shell.html', 'text/html'],
  '/admin/': ['app-shell.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/report.js': ['report.js', 'text/javascript'],
  '/analytics.js': ['analytics.js', 'text/javascript'],
  '/operations.js': ['operations.js', 'text/javascript'],
  '/overview-detail.js': ['overview-detail.js', 'text/javascript'],
  '/client-search.js': ['client-search.js', 'text/javascript'],
  '/broker-accounts.js': ['broker-accounts.js', 'text/javascript'],
  '/registry-panel.js': ['registry-panel.js', 'text/javascript'],
  '/broker-accounts.css': ['broker-accounts.css', 'text/css'],
  '/app.css': ['app.css', 'text/css'],
};
const directSession = { name: 'huzi_session', path: '/' };
const adminSession = { name: 'huzi_pc', path: '/api/admin', audience: 'admin' };
const cookieValue = (session, token, seconds) => `${session.name}=${token}; Max-Age=${seconds}; Path=${session.path}; HttpOnly; SameSite=Strict`;
const referralCookie = 'huzi_referral';
const referralCookieValue = token => `${referralCookie}=${token}; Path=/; HttpOnly; SameSite=Strict${token ? '' : '; Max-Age=0'}`;

function readCookie(request, name) {
  return new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{64})(?:;|$)`).exec(request.headers.cookie || '')?.[1];
}

function apiSession(pathname) {
  if (pathname.startsWith(`${adminSession.path}/`)) return adminSession;
  const tab = /^\/api\/business\/[a-f0-9]{32}(?=\/)/.exec(pathname)?.[0];
  return tab ? { name: 'huzi_business', path: tab, audience: 'business' } : directSession;
}

function readSession(request, session) {
  if (session === directSession && request.headers.authorization) {
    return /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization)?.[1];
  }
  return readCookie(request, session.name);
}

function checkAudience(role, session) {
  if (session.audience === 'admin' && role !== 'admin') throw new RequestError(403, '请使用运营后台管理员账号登录');
  if (session.audience === 'business' && role === 'admin') throw new RequestError(403, '请从运营后台入口登录管理员账号');
}

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
    throw new RequestError(415, '请提交 JSON 表单');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new RequestError(413, '表单过长');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // The same response covers malformed JSON and an invalid top-level value.
  }
  throw new RequestError(400, '表单格式无效');
}

function json(response, code, value) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function createCsv(rows, reportColumns) {
  const csvCell = value => {
    const text = String(value ?? '');
    const safe = /^\s*[=+@-]|^[\t\r\n]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const headings = reportColumns.map(column => column.label);
  const values = rows.map(row => reportColumns.map(column => row[column.key]));
  return `\uFEFF${[headings, ...values].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function createXlsx(rows, sheet, reportColumns) {
  const headings = reportColumns.map(column => ({ value: column.label, fontWeight: 'bold', backgroundColor: '#EAF0F7' }));
  const cells = rows.map(row => reportColumns.map(({ key }) => key === 'date' && row[key]
    ? { value: new Date(`${row.date}T00:00:00Z`), type: Date, format: 'yyyy-mm-dd' }
    : typeof row[key] === 'number' ? { value: row[key], type: Number } : { value: row[key] || '', type: String }));
  return writeExcelFile([headings, ...cells], { sheet, columns: reportColumns.map(({ width }) => ({ width })) }).toBuffer();
}

export function createAppServer({ database = ':memory:', cutoff, seed = false, admin,
  registryFile = process.env.REGISTRY_WORKBOOK || defaultRegistryFile } = {}) {
  const store = createStore(database, { cutoff, seed, admin });
  let syncingRegistry = false;
  const routes = new Map([
    ['/api/cooperations', ['sales', store.registerBroker]],
    ['/api/accounts', ['admin', store.openAccount]],
    ['/api/accounts/sales', ['admin', store.openSalesAccount]],
    ['/api/accounts/password', ['admin', store.resetAccountPassword]],
    ['/api/accounts/status', ['admin', store.setAccountStatus]],
    ['/api/accounts/recovery-code', ['admin', (actor, input) => store.issueRecoveryCode(actor, input, true)]],
    ['/api/profile/name', ['investor', store.renameInvestor]],
    ['/api/scan', ['investor', store.scan]],
    ['/api/leads', ['investor', store.addLead]],
    ['/api/followups', ['sales', store.addFollowup]],
    ['/api/companies', ['admin', store.saveCompany]],
    ['/api/assignments', ['admin', store.assignLead]],
    ['/api/channels/owner', ['admin', store.changeChannelOwner]],
    ['/api/reassign', ['admin', store.reassign]],
    ['/api/signings', ['admin', store.saveSigning]],
    ['/api/cases', ['admin', store.saveCase]],
    ['/api/registry/link', ['admin', store.registry.link]],
    ['/api/registry/sales-batch', ['admin', store.registrySalesBatch.apply]],
  ]);

  function signIn(request, response, input, register, session) {
    if (register && session === adminSession) throw new RequestError(403, '运营后台只接受管理员登录');
    const mini = session === directSession && input.platform === 'mini';
    const pending = mini ? input.referralToken : readCookie(request, referralCookie);
    const account = register ? { id: store.registerInvestor(input, pending), role: 'investor' } : store.verifyLogin(input);
    if (mini && account.role === 'admin') throw new RequestError(403, '请在 PC 后台登录管理员账号');
    checkAudience(account.role, session);
    if (!register && pending && !account.passwordChangeRequired) store.redeemReferral(account, pending);
    const token = store.createSession(account.id);
    const actor = store.getSession(token);
    store.revokeSession(readSession(request, session));
    if (mini) return json(response, 200, { token, actor });
    const cookies = [cookieValue(session, token, sessionSeconds)];
    if (pending && actor.role === 'investor' && !actor.passwordChangeRequired) cookies.push(referralCookieValue(''));
    response.setHeader('Set-Cookie', cookies);
    return json(response, 200, { actor });
  }

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const [file, contentType] = assets[url.pathname];
        response.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8`, 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
        const stream = createReadStream(resolve(webRoot, file));
        stream.on('error', () => response.destroy());
        stream.pipe(response);
        return;
      }
      const session = apiSession(url.pathname);
      const pathname = session.audience ? `/api${url.pathname.slice(session.path.length)}` : url.pathname;
      if (request.method === 'GET' && pathname === '/api/health') return json(response, 200, { mode: 'local' });
      if (!pathname.startsWith('/api/')) throw new RequestError(404, '找不到页面');
      if (request.method === 'POST' && ['/api/auth/login', '/api/auth/register'].includes(pathname)) {
        return signIn(request, response, await readBody(request), pathname === '/api/auth/register', session);
      }
      if (request.method === 'POST' && pathname === '/api/auth/recover') {
        return json(response, 200, store.recoverPassword(await readBody(request)));
      }
      const token = readSession(request, session);
      if (request.method === 'POST' && pathname === '/api/referral/capture') {
        if (session === adminSession) throw new RequestError(403, '请使用股民端打开推广入口');
        const input = await readBody(request);
        const actor = store.getSession(token);
        if (actor) {
          if (actor.passwordChangeRequired) throw new RequestError(403, '请先设置新的个人密码');
          if (actor.role !== 'investor') throw new RequestError(403, '请使用股民账号打开推广入口');
          return json(response, 200, { ...store.scan(actor, input), pending: false });
        }
        const mini = session === directSession && input.platform === 'mini';
        const captured = store.captureReferral(input, mini ? input.referralToken : readCookie(request, referralCookie));
        if (mini) return json(response, 200, { referralToken: captured.token, recorded: captured.recorded, pending: true });
        response.setHeader('Set-Cookie', referralCookieValue(captured.token));
        return json(response, 200, { recorded: captured.recorded, pending: true });
      }
      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        await readBody(request);
        store.revokeSession(token);
        response.setHeader('Set-Cookie', cookieValue(session, '', 0));
        return json(response, 200, { ok: true });
      }
      const actor = store.getSession(token);
      if (!actor) throw new RequestError(401, '请先登录');
      checkAudience(actor.role, session);
      if (request.method === 'POST' && pathname === '/api/auth/change-password') {
        const result = store.changePassword(actor, await readBody(request));
        response.setHeader('Set-Cookie', cookieValue(session, '', 0));
        return json(response, 200, result);
      }
      if (request.method === 'GET' && pathname === '/api/view') return json(response, 200, store.view(actor));
      if (actor.passwordChangeRequired) throw new RequestError(403, '请先设置新的个人密码');
      if (request.method === 'GET' && pathname === '/api/sales/board') {
        return json(response, 200, store.salesBoard(actor, Object.fromEntries(url.searchParams)));
      }
      if (request.method === 'GET' && pathname === '/api/progress') {
        return json(response, 200, store.progress(actor, Object.fromEntries(url.searchParams)));
      }
      if (request.method === 'GET' && pathname === '/api/registry/sales-batch') {
        return json(response, 200, store.registrySalesBatch.preview(actor));
      }
      if (request.method === 'GET' && pathname === '/api/registry') {
        return json(response, 200, store.registry.list(actor, Object.fromEntries(url.searchParams)));
      }
      if (request.method === 'GET' && pathname === '/api/registry/candidates') {
        return json(response, 200, store.registry.candidates(actor, Object.fromEntries(url.searchParams)));
      }
      if (request.method === 'GET' && pathname === '/api/clients/search') {
        return json(response, 200, store.searchClients(actor, Object.fromEntries(url.searchParams)));
      }
      if (request.method === 'GET' && pathname === '/api/brokers/search') {
        return json(response, 200, store.searchBrokers(actor, Object.fromEntries(url.searchParams)));
      }
      if (request.method === 'POST' && pathname === '/api/auth/recovery-code') {
        return json(response, 200, store.issueRecoveryCode(actor, await readBody(request)));
      }
      if (request.method === 'POST' && pathname === '/api/registry/sync') {
        if (actor.role !== 'admin') throw new RequestError(403, '请使用管理员账号更新登记台账');
        await readBody(request);
        if (database === ':memory:') throw new RequestError(409, '请在使用本地数据库的服务中更新登记台账');
        if (!existsSync(registryFile)) throw new RequestError(404, '找不到登记表，请核对本地工作簿位置');
        if (syncingRegistry) throw new RequestError(409, '登记台账正在更新');
        syncingRegistry = true;
        try {
          const python = process.env.REGISTRY_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
          await runFile(python, [registryImporter, resolve(registryFile), '--db', resolve(database)], {
            windowsHide: true, timeout: 300000, env: { ...process.env, PYTHONUTF8: '1' }
          });
        } catch (error) {
          throw new RequestError(503, error.code === 'ENOENT' ? '找不到 Python 解释器，请检查 REGISTRY_PYTHON 设置'
            : '未能完成更新，请检查工作簿是否已保存、表头是否完整以及数据库是否可写');
        } finally {
          syncingRegistry = false;
        }
        return json(response, 200, { ok: true });
      }
      if (request.method === 'GET' && pathname === '/api/export') {
        if (actor.role !== 'admin') throw new RequestError(403, '只有后台有权导出');
        const filters = Object.fromEntries(url.searchParams);
        const definition = reportDefinition(filters.type);
        const xlsx = filters.format === 'xlsx';
        const filename = `${['leads', 'signings', 'cases', 'sales', 'channels'].includes(filters.type) ? filters.type : 'leads'}.${xlsx ? 'xlsx' : 'csv'}`;
        const rows = reportRows(store.view(actor), filters);
        const file = xlsx ? await createXlsx(rows, definition.title, definition.columns) : createCsv(rows, definition.columns);
        response.writeHead(200, { 'Content-Type': xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
          'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename=${filename}` });
        return response.end(file);
      }
      if (request.method === 'POST' && routes.has(pathname)) {
        const [role, action] = routes.get(pathname);
        if (actor.role !== role) throw new RequestError(403, '当前身份没有操作权限');
        return json(response, 200, action(actor, await readBody(request)));
      }
      throw new RequestError(404, '找不到接口');
    } catch (error) {
      if (!(error instanceof RequestError)) console.error(error);
      if (!response.headersSent && !response.destroyed) json(response, error.status || 500,
        { message: error instanceof RequestError ? error.message : '本地服务出现异常' });
    }
  });
  server.on('close', () => store.close());
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const database = process.env.DEMO_DB || fileURLToPath(new URL('./.runtime/demo.sqlite', import.meta.url));
  if (database !== ':memory:') mkdirSync(dirname(database), { recursive: true });
  const port = Number(process.env.DEMO_PORT || 7101);
  const testMode = process.env.LOCAL_TEST_ACCOUNTS === '1';
  const configuredAdmin = process.env.APP_ADMIN_ACCOUNT || process.env.APP_ADMIN_PASSWORD;
  const admin = configuredAdmin
    ? { username: process.env.APP_ADMIN_ACCOUNT, password: process.env.APP_ADMIN_PASSWORD, name: process.env.APP_ADMIN_NAME || '运营后台' }
    : testMode ? { username: 'local-admin', password: 'LocalAdmin!012', name: '本地验收管理员' } : undefined;
  const server = createAppServer({ database, cutoff: process.env.DEMO_CASE_CUTOFF, seed: testMode, admin });
  server.listen(port, '127.0.0.1', () => console.log(`股民索赔宝 · 本地服务 http://127.0.0.1:${server.address().port}`));
}
