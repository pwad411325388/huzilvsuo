import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectProgressDisplay } from '../progress-display.mjs';

const day = '2026-11-20';
const project = (rawStatus, fields = {}, role = 'investor', kind = 'registry') =>
  projectProgressDisplay({ rawStatus, ...fields }, { role, kind, currentDay: day });

test('十二类缺节点原始状态按已知事实投影，不能把审级、申报结果或撤诉推成已完成', () => {
  const matrix = [
    ['已立案未开庭', '立案', '待开庭'], ['未立案', '立案', '立案材料准备中'],
    ['重整债权已申报', '债权申报', '申报结果待确认'], ['立案退回', '立案', '后续处理待确认'],
    ['破产债权已申报', '债权申报', '申报结果待确认'], ['判决生效待执行', '判决', '执行中'],
    ['已立案', '立案', '待确认'], ['撤诉', '诉讼', null],
    ['已提交调解申请', '调解与和解', '调解结果待确认'], ['重整债权已确认', '债权申报', '待确认'],
  ];
  for (const role of ['investor', 'sales']) for (const [raw, stageLabel, next] of matrix) {
    const result = project(raw, {}, role);
    assert.equal(result.current.stageLabel, stageLabel, raw);
    assert.equal(result.current.label, raw);
    assert.equal(result.current.uncertain, undefined);
    assert.equal(result.steps[0].status, 'current');
    assert.equal(result.steps[1]?.label ?? null, next);
    assert.ok(result.steps.slice(1).every(step => step.status === 'next' && !step.date));
    assert.equal(result.steps.length, next ? 2 : 1);
  }
  const filed = project('已立案未开庭');
  assert.equal(filed.current.note, '审级待核对');
  assert.equal(filed.steps[1].stageLabel, '开庭');
  assert.doesNotMatch(JSON.stringify(filed), /一审|二审/);
  for (const raw of ['重整债权已申报', '破产债权已申报', '重整债权已确认']) assert.doesNotMatch(JSON.stringify(project(raw)), /获赔|到账/);
  for (const raw of ['撤诉', '已撤诉', '终结执行']) {
    assert.equal(project(raw).steps.length, 1); assert.doesNotMatch(JSON.stringify(project(raw)), /已结案/);
  }
});

test('展示白名单覆盖导入器和粗状态解析器全部受支持值，不放行任意叙述', () => {
  const importer = readFileSync(new URL('../scripts/import_registry.py', import.meta.url), 'utf8');
  const stages = importer.match(/STAGES = \{([\s\S]*?)\n\}/)[1];
  const points = importer.match(/PROGRESS_POINTS = \{([\s\S]*?)\n\}/)[1];
  const resolver = readFileSync(new URL('../lead-progress.mjs', import.meta.url), 'utf8').match(/const coarseStatuses = new Set\(\[([\s\S]*?)\]\)/)[1];
  const labels = new Set([...stages.matchAll(/"([^"]+)"/g), ...points.matchAll(/"([^"]+)":\s*\(/g), ...resolver.matchAll(/'([^']+)'/g)].map(match => match[1]));
  for (const label of labels) {
    const result = project(label);
    assert.equal(!!result.current.uncertain, label === '案件进度待核对', label);
    assert.ok(result.steps.length >= 1 && result.steps.length <= 3, label);
  }
  for (const label of ['', '案件进度待核对', '已立案未开庭 电话19900000001', '合同SECRET-123', '<script>私人信息</script>']) {
    const result = project(label, { filedOn: '2026-01-01' });
    assert.equal(result.current.label, '待核对'); assert.equal(result.current.uncertain, true);
    assert.equal(result.steps.length, 1); assert.equal(result.steps[0].uncertain, true); assert.equal(result.steps[0].hideDate, true);
    assert.equal(result.steps[0].date, undefined);
    assert.equal(result.notice, '当前资料尚未明确具体阶段，请以律所确认结果为准。');
    assert.doesNotMatch(JSON.stringify(result), /19900000001|SECRET|script|私人信息|历史|结构化|同步/);
  }
});

test('正式快照清空和无效字段阻止旧文本回退，投影无副作用', () => {
  for (const fields of [{ hasSnapshot: true }, { progressStage: 'first_hearing', progressNode: 'unknown' },
    { progressStage: 'unknown' }, { progressNode: 'unknown' }]) {
    const row = Object.freeze({ rawStatus: '已立案未开庭', filedOn: '2026-01-01', ...fields });
    const result = projectProgressDisplay(row, { role: 'sales', kind: 'registry', currentDay: day });
    assert.equal(result.current.uncertain, true);
    assert.equal(result.steps.length, 1); assert.equal(result.steps[0].date, undefined);
  }
  assert.equal(project('已立案', {}, 'broker').current.uncertain, true);
});

test('只有同一登记的立案节点采用有效真实立案日，不套登记日、案件日期或未来日期', () => {
  for (const raw of ['已立案', '已立案未开庭']) {
    const result = project(raw, { filedOn: '2026-01-10', registeredOn: '2026-01-01' });
    assert.equal(result.steps[0].date, '2026-01-10'); assert.equal(result.steps[0].dateLabel, '立案日期');
    assert.ok(result.steps.slice(1).every(step => !step.date));
    for (const invalid of ['', '2026-02-30', '2999-01-01', '2026-01-01T00:00:00Z']) assert.equal(project(raw, { filedOn: invalid }).steps[0].date, undefined);
    for (const kind of ['lead', 'case']) assert.equal(project(raw, { filedOn: '2026-01-10', openedOn: '2026-01-02' }, 'sales', kind).steps[0].date, undefined);
    assert.equal(project(raw, { filedOn: '2026-01-10', testing: true }).steps[0].date, undefined);
  }
  for (const raw of ['未立案', '立案退回', '案件进度待核对', '', '已判决', '重整债权已申报']) {
    assert.equal(project(raw, { filedOn: '2026-01-10', registeredOn: '2026-01-01' }).steps[0].date, undefined);
  }
});

test('精确原文别名不丢失和解含义，角色补材料与签约旁注遵循现有规则', () => {
  assert.equal(project('已和解待支付').steps[0].label, '已和解待支付');
  assert.equal(project('立案待补充材料').current.label, '待您补充材料');
  assert.equal(project('立案待补充材料', {}, 'sales').current.label, '待补充材料');
  assert.equal(project('已签约待立案').steps[0].note, '待立案');
  assert.equal(project('已签约待立案', {}, 'sales').steps[0].note, undefined);
});
