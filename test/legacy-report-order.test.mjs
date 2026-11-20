import test from 'node:test';
import assert from 'node:assert/strict';
import { reportRows, reportDefinition } from '../web/report.js';

test('兼容报表保留注销业务并按状态和业务量排序，明细及实际签约按日期稳定排序', () => {
  const view = {
    sales: [{ id: 'closed', name: '001', username: 'closed', accountStatus: 'closed' },
      { id: 'pending', name: '待开户' }, { id: 'active', name: '在职', username: 'active', accountStatus: 'active' }],
    brokers: [{ id: 'closed-b', name: '001', salesId: 'closed', username: 'closed-b', accountStatus: 'closed', signedOn: '2026-11-19' },
      { id: 'pending-b', name: '待开户', salesId: 'pending', signedOn: '2026-11-18' },
      { id: 'active-b', name: '正常券商', salesId: 'active', username: 'active-b', accountStatus: 'active', signedOn: '2026-11-01' }],
    clients: [{ id:'c1', name:'同名', signedOn:'2026-11-01', createdAt:'2026-11-19', signingNumber:2 },
      { id:'c2', name:'同名', signedOn:'2026-11-18', createdAt:'2020-01-01', signingNumber:1 }],
    assignments: [{ id:'l3', number:'LZ-000003', clientId:'c3', name:'同名', createdOn:'', status:'待跟进', brokerId:'closed-b',salesId:'closed' },
      { id:'l2', number:'LZ-000002', clientId:'c2', name:'同名', createdOn:'2026-11-18', status:'待跟进',brokerId:'active-b',salesId:'active' },
      { id:'l1', number:'LZ-000001', clientId:'c1', name:'同名', createdOn:'2026-11-18', status:'待跟进',brokerId:'closed-b',salesId:'closed' }],
    cases: [{ id:'k2',recordNumber:2,leadId:'l2',openedOn:'2026-11-18',status:'已结案' },
      { id:'k1',recordNumber:1,leadId:'l1',openedOn:'2026-11-18',status:'已受理' }],
  };
  const original = JSON.stringify(view);
  assert.ok(reportRows(view,{type:'leads'}).every(row => row.status === '已分配'), '兼容旧快照时根据归属展示派单状态');
  assert.equal(reportDefinition('leads').columns.find(column => column.key === 'status').label, '分配状态');
  assert.doesNotMatch(JSON.stringify(reportDefinition('sales').columns), /跟进|followed|pending/);
  assert.ok(reportRows(view,{type:'sales'}).every(row => !('followed' in row) && !('pending' in row)));
  assert.deepEqual(reportRows(view,{type:'sales'}).map(row=>row.id),['active','pending','closed']);
  assert.equal(reportRows(view,{type:'channels'}).at(-1).id,'closed-b');
  assert.deepEqual(reportRows(view,{type:'leads'}).map(row=>row.number),['LZ-000001','LZ-000002','LZ-000003']);
  assert.deepEqual(reportRows(view,{type:'cases'}).map(row=>row.number),['AJ-000001','AJ-000002']);
  assert.deepEqual(reportRows(view,{type:'signings'}).map(row=>row.date),['2026-11-18','2026-11-01'],
    '按实际签约日而非客户创建日期');
  for(const type of ['leads','cases','signings','sales','channels']) {
    const reversed=Object.fromEntries(Object.entries(view).map(([key,rows])=>[key,rows.slice().reverse()]));
    assert.deepEqual(reportRows(reversed,{type}),reportRows(view,{type}), '相同数据不能随输入顺序换页');
  }
  assert.equal(JSON.stringify(view),original,'排序不更改业务快照');

  const progressView = { ...view, cases: [
    { id:'current', leadId:'l2', brokerId:'active-b', status:'一审待开庭', caseGroup:'ongoing' },
    { id:'legacy', leadId:'l2', brokerId:'active-b', status:'已受理' },
    { id:'unconfirmed', leadId:'l2', brokerId:'active-b', status:'诉讼中', caseGroup:'unknown' },
  ] };
  assert.equal(reportRows(progressView,{type:'sales'}).find(row => row.id === 'active').ongoing, 2,
    '在办案件按正式分类统计，缺少分类的旧记录才使用状态回退');
  assert.equal(reportRows(progressView,{type:'channels'}).find(row => row.id === 'active-b').ongoing, 2);
});
