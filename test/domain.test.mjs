import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, anchor, applySuggestion, validateFindings, validateSuggestion, AppError, questionLink } from '../src/domain.mjs';

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
// 这一族来自真实漏报：整句没有任何绝对化词，旧规则必然返回“暂未发现明显问题”。
// 离线初筛至少要能把“概念被放错范畴”这类结构性疑点交还给作者。
test('category mismatch is located even without absolute wording', () => {
  const text = '先说结论。我认为这个意大利面就该拌42号混凝土，而不是三角铁和足球。就这样。';
  const item = checkDraft(text)[0];
  assert.equal(item.kind, '概念错配');
  assert.equal(item.quote, '我认为这个意大利面就该拌42号混凝土，而不是三角铁和足球。');
  assert.equal(text.slice(item.start, item.end), item.quote);
  assert.match(item.reason, /食物/);
  assert.match(item.reason, /范畴/);
});
test('unit mismatch inside a number phrase is reported separately', () => {
  const item = checkDraft('这套方案能节省3米的开支。')[0];
  assert.equal(item.kind, '数量与单位错配');
  assert.match(item.reason, /3米/);
});
test('a measurement attached to an abstract object is still a candidate', () => {
  const item = checkDraft('这个观点的分量有2公斤。')[0];
  assert.equal(item.kind, '数量与单位错配');
  assert.match(item.reason, /2公斤/);
});
test('measurements of real physical objects stay unflagged', () => {
  assert.equal(checkDraft('这条网线大约有3米长。').length, 0);
  assert.equal(checkDraft('这袋米重2公斤，够吃一周。').length, 0);
});
test('concrete object used as a means to an abstract result is a candidate', () => {
  const item = checkDraft('为这个方案加一张沙发就能提高转化率。')[0];
  assert.equal(item.kind, '抽象与具体混用');
});
test('mismatch family still respects quotes and questions, and stays quiet on plain prose', () => {
  assert.equal(checkDraft('有人问：“意大利面该拌混凝土吗？”我没有回答。').length, 0);
  assert.equal(checkDraft('意大利面该拌混凝土吗？').length, 0);
  assert.equal(checkDraft('为了控制预算，我们决定换一个更便宜的云服务商。').length, 0);
  assert.equal(checkDraft('我们的方案在稳定性上更高，成本也只是略高。').length, 0);
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
// 用户从地址栏复制出来的链接很少是干净的：带追踪参数、带锚点、落在回答页、手机域名。
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
    `zhihu.com/question/${id}/`,
    `  https://www.zhihu.com/question/${id}  `,
    id,
  ]) assert.equal(questionLink(input).url, expected, input);
  assert.equal(questionLink(`https://www.zhihu.com/question/${id}`).id, id);
});
test('pasted links that are not a question are refused with an actionable message', () => {
  for (const input of ['', '   ', '远程办公', 'https://www.zhihu.com/people/someone', 'https://www.zhihu.com/question/', 'https://example.com/question/123456', 'https://zhihu.com.evil.example/question/123456', '1234', 'https://www.zhihu.com/question/12345678901234567890123'])
    assert.throws(() => questionLink(input), e => e instanceof AppError && e.code === 'INVALID_INPUT', input);
});
// 反例来自真实分享文案：问题编号常常和域名分在两行，用户只会选中链接本身。
// 只认数字也可以，因为编号才是唯一标识；域名我们不猜，一律回到知乎规范地址。
test('a bare question number is accepted, an unknown host is not', () => {
  assert.equal(questionLink('368830073').url, 'https://www.zhihu.com/question/368830073');
  assert.throws(() => questionLink('https://example.com/question/123456'), /识别/);
});
test('a pasted answer link is reported as the question it belongs to, not the answer', () => {
  assert.equal(questionLink('https://www.zhihu.com/question/368830073/answer/999').url, 'https://www.zhihu.com/question/368830073');
});
