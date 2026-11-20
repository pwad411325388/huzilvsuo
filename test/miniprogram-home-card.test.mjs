import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { nativePages } from '../test-support/native-page.mjs';

test('三端卡片使用对应摘要和北京时间短日期，空摘要、零值、筛选和未加载分别展示', () => {
  const markup = readFileSync(new URL('../miniprogram/ui.wxml', import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(markup.match(/<wxs module="homeCopy">([\s\S]+?)<\/wxs>/)[1], { module });
  const { summary, dateLabel } = module.exports;
  assert.equal(dateLabel('2026-01-09'), '1月9日');
  assert.equal(dateLabel(''), '');
  const investor = { actor: { role: 'investor' } };
  assert.match(summary(investor), /摘要暂未提供/);
  investor.investorHome = { totalRecords: 0 };
  assert.match(summary(investor), /暂无维权记录/);
  investor.investorHome.totalRecords = 3;
  assert.equal(summary(investor), '暂无补料提醒');
  Object.assign(investor.investorHome, { attentionCount: 2,
    attention: { stockName: '测试股', stockCode: 'QA', caseTitle: '示例二案', status: '待您补充材料' } });
  assert.equal(summary(investor), '测试股 · QA · 示例二案 · 待您补充材料 · 共 2 条待关注');
  const sales = { actor: { role: 'sales' } };
  assert.equal(summary(sales, { q: '', period: 'all', data: { total: 13, customerCount: 1 } }), '13 条客户与股票记录');
  assert.equal(summary(sales, { q: '示例', period: 'all', data: { total: 0 } }), '当前筛选共 0 条客户与股票记录');
  assert.equal(summary(sales, { error: '读取失败' }), '客户与股票记录暂未加载');
  const broker = { actor: { role: 'broker' } };
  assert.equal(summary(broker, null, { period: 'all', metrics: [{ key: 'closed', value: 17 }, { key: 'ongoing', value: 0 }] }), '0 件案件在办');
  assert.equal(summary(broker, null, { period: 'month', metrics: [{ key: 'ongoing', value: 3 }] }), '本月登记的记录中，3 件案件在办');
  assert.equal(summary(broker, null, { metrics: [] }), '在办案件数暂未提供');
  assert.equal(summary(broker, null, null, '失败'), '在办案件数暂未加载');
});

function homePage(role, fetchData) {
  const app = { globalData: { token: 'fixture-token' } };
  const requests = [], scrolls = [];
  let afterScroll;
  const client = { async request(path) {
    requests.push(path);
    return path === '/view' ? { actor: { role, id: 'fixture', name: '虚构账号' }, today: '2026-01-09' } : fetchData(path);
  } };
  const wx = {
    nextTick: callback => callback(),
    pageScrollTo: ({ selector, success }) => { scrolls.push(selector); afterScroll = success; },
  };
  const page = nativePages({ app, client, wx }).page('home');
  return { page, app, requests, scrolls, finishScroll: () => afterScroll?.() };
}

test('销售首页合作入口原地滚动及聚焦，不重载或变更表单/客户列表；离页回调失效', async () => {
  const h = homePage('sales', async () => ({ total: 0, offset: 0, limit: 5, items: [] }));
  const { page } = h;
  await page.onShow();
  page.pickDate({ detail: { value: '2026-01-02' } });
  page.recordsInput({ detail: { value: '输入中的股票名称' } });
  const requests = h.requests.length;
  await page.openHomeAction();
  assert.deepEqual(h.scrolls, ['#home-cooperation']);
  h.finishScroll();
  assert.equal(page.data.cooperationFocused, true);
  assert.equal(page.data.signedOn, '2026-01-02');
  assert.equal(page.data.recordList.draft, '输入中的股票名称');
  assert.equal(page.data.recordList.expanded, false);
  assert.equal(h.requests.length, requests);
  page.blurCooperation();
  await page.openHomeAction();
  page.onHide();
  h.finishScroll();
  assert.equal(page.data.cooperationFocused, false);
});

test('券商卡片打开客户明细时复用已有查询与在途请求，按所属期间处理新指标', async () => {
  let release;
  const h = homePage('broker', path => new Promise(resolve => {
    const query = new URL(path, 'http://test').searchParams;
    const selected = query.get('metric');
    release = () => resolve({ selected, metrics: [{ key: selected }], total: 13,
      offset: Number(query.get('offset')), limit: 5, items: [] });
  }));
  const { page } = h;
  const opening = page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  const firstJump = page.openHomeAction();
  assert.equal(h.requests.length, 2, '首次请求未完成时不重复请求客户');
  release(); await opening; await firstJump;
  assert.deepEqual(h.scrolls, ['#home-board-details']);
  page.setData({ boardOffset: 5, boardPage: 2, boardLedger: 'negotiating', boardQ: '查询词', boardDraft: '未提交草稿',
    boardExpanded: false, boardPeriod: 'month' });
  await page.openHomeAction();
  assert.equal(h.requests.length, 2);
  assert.equal(page.data.boardPage, 2);
  assert.equal(page.data.boardLedger, 'negotiating');
  assert.equal(page.data.boardExpanded, true);
  const changing = page.pickBoardMetric({ currentTarget: { dataset: { key: 'ongoing' } } });
  release(); await changing;
  const jump = page.openHomeAction();
  const repeated = page.openHomeAction();
  assert.equal(h.requests.length, 4);
  const query = new URL(h.requests.at(-1), 'http://test').searchParams;
  for (const [key, value] of Object.entries({ metric:'customers',period:'month',ledger:'all',q:'查询词',offset:'0' })) {
    assert.equal(query.get(key), value);
  }
  assert.equal(page.data.boardDraft, '未提交草稿');
  const previousScrolls = h.scrolls.length;
  page.onHide();
  release(); await Promise.all([jump, repeated]);
  assert.equal(h.scrolls.length, previousScrolls, '离页后旧查询不能触发滚动');
});
