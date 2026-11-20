import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSigningEvidence, hasRegistrySigningEvidence } from '../data-semantics.mjs';

const day = '2026-11-20';
const historical = row => hasRegistrySigningEvidence(row, day);

test('历史签约只采用已立案事实或后续明确状态，不将登记、提交或补料算作已立案', () => {
  for (const rawStatus of ['已受理', '已立案', '已立案未开庭', '一审待开庭', '已判决',
    '二审待开庭', '执行中', '终结执行', '已结案']) {
    assert.equal(historical({ rawStatus }), true, rawStatus);
  }
  for (const rawStatus of ['撤诉', '债权申报', '重整债权已申报']) {
    assert.equal(historical({ rawStatus }), false, rawStatus);
    assert.equal(historical({ rawStatus, filedOn: '2024-02-29' }), true, rawStatus + ' with filed date');
  }
  for (const rawStatus of ['', '案件进度待核对', '含糊未知描述', '未立案', '立案退回', '待受理', '已留资', '立案材料准备中', '已提交立案']) {
    assert.equal(historical({ rawStatus, filedOn: '2024-02-29' }), false, rawStatus);
  }
  for (const filedOn of ['', '待核对', '2024-02-30', '2026-11-21', '2024-01-01T00:00:00Z']) {
    assert.equal(historical({ filedOn }), false, filedOn);
  }
});

test('公司更正与清空不回退历史状态，阶段必须是有效节点，普通系统记录保留原签约口径', () => {
  for (const [progressStage, progressNode] of [['first_hearing', 'awaiting_hearing'], ['appeal', 'remanded'],
    ['enforcement', 'in_progress'], ['closure', 'closed'], ['intake', 'signed_waiting_filing']]) {
    const row = { hasSnapshot: true, progressStage, progressNode, rawStatus: '未立案' };
    assert.equal(historical(row), true, progressStage);
    assert.equal(hasSigningEvidence(row), progressStage === 'intake', 'system must retain explicit signing only');
  }
  for (const [progressStage, progressNode] of [['', ''], ['first_hearing', 'not-a-node'], ['intake', 'lead_received'],
    ['filing', 'preparing'], ['filing', 'supplement'], ['filing', 'submitted']]) {
    assert.equal(historical({ hasSnapshot: true, progressStage, progressNode, rawStatus: '已结案', filedOn: '2020-01-01' }),
      false, progressStage + '.' + progressNode);
  }
  for (const [progressStage, progressNode] of [['settlement', 'agreed'], ['settlement', 'pending_payment'],
    ['debt_claim', 'preparing'], ['debt_claim', 'supplement'], ['debt_claim', 'compensated']]) {
    const row = {hasSnapshot: true, progressStage, progressNode};
    assert.equal(historical(row), false, 'parallel route alone is not a filed lawsuit');
    assert.equal(historical({...row, rawStatus: '执行中', filedOn: '2020-01-01'}), true, 'known prior filing survives parallel route');
    assert.equal(historical({...row, rawStatus: '案件进度待核对', filedOn: '2020-01-01'}), false, 'a disputed filing date is not independent evidence');
    assert.equal(historical({...row, rawStatus: '已立案'}), true, 'a confirmed prior filing does not require its missing date');
    assert.equal(historical({...row, rawStatus: '立案退回', filedOn: '2020-01-01'}), false);
  }
});
