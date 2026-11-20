import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLeadProgress,resolveCaseProgress } from '../lead-progress.mjs';

const day='2026-11-20',basic={createdAt:'2026-11-01T00:00:00Z',signedOn:day,signingMatch:'single'};
test('实际签约仅做无快照无案件的回退，已确定更先进状态与显式清空优先',()=>{
  for(const role of ['investor','sales']) {
    assert.equal(resolveLeadProgress(basic,[],role,day).current.node,'signed_waiting_filing');
    assert.equal(resolveLeadProgress({...basic,signedOn:'2026-11-21'},[],role,day).current.node,'lead_received');
    assert.equal(resolveLeadProgress({...basic,signingMatch:'ambiguous'},[],role,day).sourceStatus,'签约对应记录待核对');
    assert.equal(resolveLeadProgress({...basic,signingMatch:'none'},[],role,day).current.node,'lead_received');
    const advanced={hasSnapshot:true,progressStage:'appeal',progressNode:'awaiting_hearing',completedNodes:'[]'};
    assert.equal(resolveLeadProgress(basic,[advanced],role,day).current.stage,'appeal');
    assert.equal(resolveLeadProgress({...basic,...advanced},[{rawStatus:'已结案'}],role,day).current.stage,'appeal');
    const cleared={hasSnapshot:true,progressStage:'',progressNode:''};
    assert.equal(resolveLeadProgress({...basic,...cleared},[advanced],role,day).current,null);
    assert.equal(resolveLeadProgress(basic,[cleared],role,day).status,'进度待核对');
    assert.equal(resolveLeadProgress(basic,[{rawStatus:'诉讼中'}],role,day).sourceStatus,'诉讼中');
    assert.equal(resolveLeadProgress(basic,[{rawStatus:'已结案'}],role,day).current.node,'closed');
  }
});
test('案件粗状态与有下一路线的当前快照都沿用角色字典，不伪造未知进度',()=>{
  assert.equal(resolveCaseProgress({rawStatus:'一审待开庭'},'investor').current.node,'awaiting_hearing');
  assert.equal(resolveCaseProgress({rawStatus:'无法确认的业务原文'},'investor').status,'进度待核对');
  const row={hasSnapshot:true,progressStage:'filing',progressNode:'supplement',nextStage:'filing',nextNode:'submitted'};
  assert.equal(resolveCaseProgress(row,'investor').status,'待您补充材料');
  assert.equal(resolveCaseProgress(row,'sales').status,'待补充材料');
  assert.equal(resolveCaseProgress(row,'investor').nextState.node,'submitted');
});

test('已有立案日期或明确后续状态不再声称待立案，清空快照仍优先',()=>{
  const signed={hasSnapshot:true,progressStage:'intake',progressNode:'signed_waiting_filing',nextStage:'filing',nextNode:'preparing'};
  for(const role of ['investor','sales']) {
    for(const evidence of [{filedOn:'2026-11-01'},...['一审已开庭','一审已开庭待判决','判决生效待执行','终结执行','执行获赔'].map(rawStatus=>({rawStatus}))]) {
      const value=resolveCaseProgress({...signed,...evidence},role,day);
      assert.equal(value.current.node,'signed'); assert.equal(value.nextState,null);
      assert.equal(resolveLeadProgress({...basic,...signed},[{...signed,...evidence}],role,day).current.node,'signed');
    }
    assert.equal(resolveCaseProgress({...signed,filedOn:'2999-01-01'},role,day).current.node,'signed_waiting_filing');
    assert.equal(resolveCaseProgress({...signed,progressStage:'',progressNode:'',filedOn:'2026-11-01',rawStatus:'已结案'},role,day).current,null);
  }
});
