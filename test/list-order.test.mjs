import assert from 'node:assert/strict';
import test from 'node:test';
import { accountRank, compareAccounts, compareName, compareRecent, compareOldest, comparePending,
  compareSalesSummary, compareSourceSummary } from '../web/list-order.js';

test('账号状态排序保留注销记录，开户队列可选择待开户优先，中文姓名有稳定ID兜底', () => {
  const rows = [{ id: 'closed', name: '阿甲', status: '已注销' }, { id: 'pending', name: '阿乙', status: '待开户' },
    { id: 'b', name: '周同名', status: '正常' }, { id: 'a', name: '周同名', status: '正常' }];
  assert.deepEqual(rows.slice().sort(compareAccounts).map(row => row.id), ['a', 'b', 'pending', 'closed']);
  assert.deepEqual(rows.slice().sort((a,b) => compareAccounts(a,b,true)).map(row => row.id), ['pending', 'a', 'b', 'closed']);
  assert.equal(accountRank('active'), 0); assert.equal(accountRank('pending'), 1); assert.equal(accountRank('closed'), 2);
  assert.equal(accountRank('待关联 / 分配'), 1);
  assert.ok(compareName({ title: '同名', number: 'LZ-000001' }, { title: '同名', number: 'LZ-000002' }) < 0);
});

test('销售和来源摘要先账号组，再客户档案数、登记数，兼容旧统计字段', () => {
  const rows = [{ id: 'closed', name: '阿甲', status: 'closed', customerCount: 999, recordCount: 999 },
    { id: 'many-records', name: '甲', status: 'active', customers: 1, leads: 99 },
    { id: 'more-customers', name: '乙', status: 'active', customerCount: 2, recordCount: 2 },
    { id: 'more-tied-records', name: '乙', status: 'active', customerCount: 2, recordCount: 3 },
    { id: 'pending', name: '丙', status: 'pending', customerCount: 200, recordCount: 200 }];
  assert.deepEqual(rows.slice().sort(compareSalesSummary).map(row => row.id), ['more-tied-records','more-customers','many-records','pending','closed']);
  const sources = [{ id: 'closed', title: '已注销', sourceStatus: 'closed', customerCount: 999 },
    { id: 'history', title: '历史分类', sourceStatus: 'active', customerCount: 2 },
    { id: 'active', title: '已开户', sourceStatus: 'active', customerCount: 1 },
    { id: 'pending', title: '待开户', sourceStatus: 'pending', customerCount: 99 }];
  assert.deepEqual(sources.sort(compareSourceSummary).map(row => row.id), ['history','active','pending','closed']);
});

test('日期新旧排序均把无效或缺日期放末位，同日同名用唯一编号稳定分页', () => {
  const rows = [{ id: 'missing', title: '丙', registeredOn: '', createdAt: '2099-01-01' },
    { id: 'invalid', title: '丁', registeredOn: '2026-02-30' }, { id: 'old', title: '乙', registeredOn: '2025-01-01' },
    { id: 'b', title: '同名', registeredOn: '2026-11-19' }, { id: 'a', title: '同名', registeredOn: '2026-11-19' }];
  const recent = rows.slice().sort(compareRecent).map(row => row.id), oldest = rows.slice().sort(compareOldest).map(row => row.id);
  assert.deepEqual(recent.slice(0, 3), ['a','b','old']); assert.deepEqual(oldest.slice(0, 3), ['old','a','b']);
  assert.deepEqual(new Set(recent.slice(3)), new Set(['missing','invalid']));
  assert.deepEqual(new Set(oldest.slice(3)), new Set(['missing','invalid']));
  assert.ok(compareRecent({ id:'a', date:'2026-01-01', createdAt:'2099-01-01' }, { id:'b', date:'2026-02-01' }) > 0,
    '业务报表date优先于客户注册时间');
  assert.deepEqual(rows.slice().reverse().sort(compareRecent).map(row => row.id), recent);
});

test('待处理队列先新待分配，再历史待核和待关联，各组旧记录先处理', () => {
  const rows = [{ id:'history', queue:'registry_unlinked', registeredOn:'2000-01-01' },
    { id:'newer', queue:'system_new', registeredOn:'2026-11-19' }, { id:'legacy', queue:'system_legacy', registeredOn:'2001-01-01' },
    { id:'older', queue:'system_new', registeredOn:'2026-11-01' }, { id:'unknown', queue:'system_new', registeredOn:'' }];
  assert.deepEqual(rows.sort(comparePending).map(row => row.id), ['older','newer','unknown','legacy','history']);
});
