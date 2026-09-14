// 审稿意见契约测试：把“什么叫中肯”固定下来，防止以后改提示词时又退回空话或误报。
//
// 这里测的是提示词文本本身与理由校验的边界——不需要模型凭据，跑得快。
// 真实模型是否照做，由 scripts/verify-check-prompt.mjs 用同一批样例验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_TASK, VERIFY_TASK, REVIEW_PRINCIPLES, FINDING_KINDS, SEVERITIES, DIRECTIONS, VAGUE_REASONS } from '../src/review-prompt.mjs';
import { validateFindings, AppError } from '../src/domain.mjs';

const TEXT = '远程办公一定能提高所有人的工作效率，团队应该全面推行。';

test('check task keeps the output contract that the server actually parses', () => {
  for (const field of ['"quote"', '"start"', '"kind"', '"reason"', '"severity"', '"impact"', '"direction"']) {
    assert.ok(CHECK_TASK.includes(field), `检查提示词缺少字段 ${field}：解析端会读它`);
  }
  assert.ok(CHECK_TASK.includes('limit'), '必须告诉模型条数上限，否则无法通过 validateFindings 的长度校验');
});

test('check task carries every reachable judgement rule', () => {
  for (const kind of FINDING_KINDS) assert.ok(CHECK_TASK.includes(kind), `缺少缺口类型：${kind}`);
  for (const level of SEVERITIES) assert.ok(CHECK_TASK.includes(level), `缺少严重度档位：${level}`);
  for (const direction of DIRECTIONS) assert.ok(CHECK_TASK.includes(direction), `缺少修改方向：${direction}`);
});

test('grounded review requires claim-type calibration, not one fixed strictness', () => {
  // 中肯的关键：事实类要出处，价值判断只要求自洽，偏好不报，预测看前提。
  for (const phrase of ['事实类', '价值判断类', '个人偏好', '预测类']) {
    assert.ok(REVIEW_PRINCIPLES.includes(phrase), `缺少主张类型校准：${phrase}`);
  }
  assert.ok(/不要求它“有出处”/.test(REVIEW_PRINCIPLES), '价值判断不能被当成事实类要求出处');
});

test('the reason must point at the missing link, not judge the writing', () => {
  assert.ok(CHECK_TASK.includes('主张了什么'), '理由里必须先点明这句话主张了什么');
  assert.ok(/禁止空洞评价/.test(CHECK_TASK), '必须明确禁止空话');
  for (const vague of VAGUE_REASONS) assert.ok(CHECK_TASK.includes(vague), `空话黑名单未列出：${vague}`);
  assert.ok(/不得替作者改写/.test(CHECK_TASK), 'direction 只能给方向，不能替作者写句子');
});

test('restraint is written down: no padding, no invented problems, metaphors exempt', () => {
  assert.ok(/宁可少报/.test(CHECK_TASK), '必须写明宁可少报');
  assert.ok(/明示为比喻/.test(CHECK_TASK), '明示的比喻不该被当成论证问题');
  assert.ok(/关键词不是免检理由/.test(CHECK_TASK), '关键词既不免检也不该成为唯一判据');
});

test('verify task forbids fake balance and unsupported support claims', () => {
  for (const rule of ['不得因为材料读起来像是支持的', '没有反例就写', '优先选 unclear', '不编造数据']) {
    assert.ok(VERIFY_TASK.includes(rule), `复核提示词缺少约束：${rule}`);
  }
});

test('vague or truncated reasons are rejected instead of shown to the author', () => {
  const finding = reason => ({ items: [{ quote: '远程办公一定能提高所有人的工作效率，团队应该全面推行。', start: 0, kind: '以偏概全', reason }] });
  assert.throws(() => validateFindings(finding('这句话过于绝对，需要再想想。'), TEXT, 1), e => e instanceof AppError && e.code === 'INVALID_MODEL_OUTPUT');
  assert.throws(() => validateFindings(finding('缺乏说服力，建议修改。'), TEXT, 1), /空泛/);
  assert.throws(() => validateFindings(finding('太短。'), TEXT, 1), /空泛/);
  const ok = validateFindings(finding('这句把“一定能提高所有人的效率”当成了普遍结论，但材料只覆盖了部分任务类型，读者会追问反例。'), TEXT, 1)[0];
  assert.equal(ok.kind, '以偏概全');
  assert.equal(ok.engine, 'model');
});

test('severity, impact and direction are whitelisted, never invented', () => {
  const base = { quote: '远程办公一定能提高所有人的工作效率，团队应该全面推行。', start: 0, kind: '以偏概全', reason: '结论覆盖了所有人，但文中的依据只到部分任务类型，读者会追问反例在哪。' };
  const good = validateFindings({ items: [{ ...base, severity: '中等', impact: '影响可信度', direction: '补充条件' }] }, TEXT, 1)[0];
  assert.equal(good.severity, '中等');
  assert.equal(good.impact, '影响可信度');
  assert.equal(good.direction, '补充条件');
  // 模型自造档位或方向时不能进入数据，也不能让整个检查失败。
  const odd = validateFindings({ items: [{ ...base, severity: '致命', impact: '毁灭性', direction: '重写全文' }] }, TEXT, 1)[0];
  assert.equal(odd.severity, undefined);
  assert.equal(odd.impact, undefined);
  assert.equal(odd.direction, undefined);
});
