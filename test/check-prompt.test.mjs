// 离线回归：没有模型时，本地规则对样例句必须给出稳定、可解释的结果。
//
// 这批样例来自一次真实漏报（“意大利面拌42号混凝土”被判为“暂未发现明显的论证问题”）。
// 这里固定两类要求：
//   1) 结构性缺口必须命中：概念错配、单位错配、范围强断言；
//   2) 正常表达必须保持安静：正常物理度量、已被作者收窄、转述、提问。
//      误报比漏报更伤信任，安静用例失败要当成回归处理。
//
// 说明：本地规则比模型保守（例如“不清楚”式的模糊表述它本来就不判），
// 所以这里只放“本地规则能判定”的样例。模型能力用同一套标准的
// test/fixtures/prompt-samples.json + scripts/verify-check-prompt.mjs 验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkDraft } from '../src/domain.mjs';

const samples = JSON.parse(readFileSync(new URL('./fixtures/check-samples.json', import.meta.url), 'utf8'));
const report = samples.filter(s => s.expect === 'report');
const quiet = samples.filter(s => s.expect === 'quiet');

test('sample fixture covers both directions and every case is usable prose', () => {
  assert.ok(report.length >= 4, '必须至少有 4 条应当命中的样例');
  assert.ok(quiet.length >= 5, '必须至少有 5 条应当安静的样例');
  for (const s of samples) {
    assert.ok(s.text.length >= 8, `${s.id}: 文本太短，不如实反映真实草稿`);
    assert.ok(['report', 'quiet'].includes(s.expect), `${s.id}: expect 只能是 report/quiet`);
  }
});

for (const sample of report) {
  test(`offline rules flag: ${sample.id}`, () => {
    const items = checkDraft(sample.text, 6);
    assert.ok(items.length >= 1, `${sample.id} 未被本地规则命中：${sample.text}`);
    // 命中必须能回到原文：锚点错了，后面所有操作都会指向错误的位置。
    for (const item of items) assert.equal(sample.text.slice(item.start, item.end), item.quote);
    assert.equal(items[0].engine, 'local_rules');
  });
}

for (const sample of quiet) {
  test(`offline rules stay quiet: ${sample.id}`, () => {
    const items = checkDraft(sample.text, 6);
    assert.equal(items.length, 0, `${sample.id} 属于误报：${items.map(i => i.kind).join(',')}`);
  });
}
