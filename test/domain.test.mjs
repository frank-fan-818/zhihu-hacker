import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, anchor, applySuggestion, validateFindings, validateSuggestion, AppError, questionLink } from '../src/domain.mjs';
import { questionUrl } from '../src/providers.mjs';

test('local check locates a strong assertion without claiming verification', () => {
  const text = '我正在考虑新的工作方式。远程办公一定能提高所有人的工作效率。团队应该认真讨论。';
  const item = checkDraft(text)[0];
  assert.equal(text.slice(item.start, item.end), item.quote);
  assert.equal(item.phase, 'preliminary');
  assert.equal(item.engine, 'local_rules');
});
test('negated assertion and quoted claims are not blindly flagged', () => {
  assert.equal(checkDraft('不能说远程办公一定能提高所有人的工作效率。').length, 0);
  assert.equal(checkDraft('有人说“远程办公一定更好”，我对此并不赞同。').length, 0);
});
test('repeated sentences require occurrence-aware anchors', () => {
  const text = '同一句话。同一句话。';
  const a = anchor(text, '同一句话。', 5);
  assert.equal(a.start, 5);
  assert.throws(() => anchor(text, '同一句话。'), AppError);
});
test('open questions are not classified as strong assertions', () => {
  assert.equal(checkDraft('远程办公是否能提高所有人的工作效率？').length, 0);
});
test('stale suggestion cannot overwrite changed draft', () => {
  assert.throws(() => applySuggestion({ text: '原来的句子。', revision: 2 }, { baseRevision: 1, start: 0, end: 6, quote: '原来的句子。', text: '改后的句子。' }), /版本/);
});
test('apply only replaces exact anchor range', () => {
  const text = '第一句。原来的句子。末句。';
  const a = anchor(text, '原来的句子。');
  assert.equal(applySuggestion({text, revision:1}, {...a,baseRevision:1,text:'新的句子。'}), '第一句。新的句子。末句。');
});
test('model output rejects fabricated quote', () => {
  assert.throws(() => validateFindings({items:[{quote:'不存在',reason:'无',kind:'scope'}]}, '原文', 1));
});
test('unknown citation and invalid suggestion are rejected', () => {
  assert.throws(() => validateSuggestion({text:'新句',reason:'理由',sourceIds:['fake']}, []));
  assert.throws(() => validateSuggestion({text:'',reason:'理由',sourceIds:[]}, []));
});

// 用户从地址栏复制出来的链接很少是干净的：带追踪参数、带锚点、落在回答页、手机域名、甚至只剩编号。
// 这些都应该指向同一个问题，而不是让用户自己删参数。
test('pasted question links normalize every way people actually copy them', () => {
  const id = '368830073';
  const expected = `https://www.zhihu.com/question/${id}`;
  for (const input of [
    expected,
    `https://www.zhihu.com/question/${id}/`,
    `https://www.zhihu.com/question/${id}?utm_source=wechat_session&utm_medium=social&s_r=0`,
    `https://www.zhihu.com/question/${id}/answer/2319726894`,
    `https://www.zhihu.com/question/${id}#root`,
    `https://m.zhihu.com/question/${id}`,
    `http://zhihu.com/question/${id}?share_code=abc`,
    `www.zhihu.com/question/${id}`,
    `  https://www.zhihu.com/question/${id}  `,
    id,
  ]) assert.equal(questionLink(input).url, expected, input);
  assert.equal(questionLink(expected).id, id);
});
// 拒绝时不能猜数字：宁可让用户改一次输入，也不能静默关联到一条不相干的问题。
test('pasted links that are not a question are refused with an actionable message', () => {
  for (const input of ['', '   ', '远程办公', 'https://www.zhihu.com/people/someone', 'https://www.zhihu.com/question/',
    'https://example.com/question/123456', 'https://zhihu.com.evil.example/question/123456', '1234',
    'https://www.zhihu.com/question/12345678901234567890123'])
    assert.throws(() => questionLink(input), e => e instanceof AppError && e.code === 'INVALID_INPUT', input);
});
// providers.questionUrl 是服务端接收链接的唯一入口（/api/question-url 与创建项目都用它）。
// 它必须和 questionLink 同一口径，否则界面归一化过的地址反而会在服务端被拒。
test('server-side questionUrl accepts the same forms as the shared parser', () => {
  const id = '368830073';
  const expected = `https://www.zhihu.com/question/${id}`;
  for (const input of [expected, `https://www.zhihu.com/question/${id}/answer/2319726894`,
    `https://m.zhihu.com/question/${id}`, `https://www.zhihu.com/question/${id}?utm_source=wechat_session`, id])
    assert.equal(questionUrl(input), expected, input);
  for (const bad of ['https://www.zhihu.com/people/someone', 'https://example.com/question/123456', '远程办公'])
    assert.throws(() => questionUrl(bad), /有效的知乎问题链接/, bad);
});
