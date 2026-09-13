import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, anchor, applySuggestion, validateFindings, validateSuggestion, AppError } from '../src/domain.mjs';

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
