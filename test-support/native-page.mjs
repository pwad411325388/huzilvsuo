import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import vm from 'node:vm';

export const developAccountInfo = () => ({ miniProgram: { envVersion: 'develop' } });

export function isolatedRequest(apiBase) {
  const base = new URL(apiBase);
  return async ({ url, method, data, header, success, fail }) => {
    const endpoint = new URL(url);
    if (endpoint.origin !== base.origin || !endpoint.pathname.startsWith(base.pathname + '/')) {
      fail(new Error('请求地址超出隔离测试服务'));
      return;
    }
    try {
      const response = await fetch(endpoint, { method, headers: header, body: method === 'POST' ? JSON.stringify(data) : undefined });
      success({ statusCode: response.status, data: await response.json() });
    } catch (error) { fail(error); }
  };
}

export function nativePages({ app, client, wx = {}, networkConfig }) {
  const modules = new Map();
  const attach = page => { page.setData = patch => Object.assign(page.data, patch); return page; };
  function load(name) {
    if (name === 'client.js' && client) return client;
    if (name === 'network-config.js' && networkConfig) return networkConfig;
    if (modules.has(name)) return modules.get(name).exports;
    const module = { exports: {} };
    modules.set(name, module);
    vm.runInNewContext(readFileSync(new URL('../miniprogram/' + name, import.meta.url), 'utf8'), {
      wx, getApp: () => app, module, Page: definition => { module.page = definition; },
      require: relative => load(posix.normalize(posix.join(posix.dirname(name), relative)) + (relative.endsWith('.js') ? '' : '.js')),
    });
    return module.exports;
  }
  return {
    create(isHome, isRecordsPage = false) { return attach(load('page.js')(isHome, isRecordsPage)); },
    page(name) { const file = 'pages/' + name + '/index.js'; load(file); return attach(modules.get(file).page); },
    load,
  };
}
