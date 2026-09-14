// 真实语料上的模型评估：把 876 条真实句子按“本地规则命中 / 未命中”分层抽样，
// 交给真实模型判定，统计命中率、类型分布与耗时，并把结果落盘供人工标注。
//
//   node --env-file-if-exists=.env scripts/eval-corpus.mjs [--sample 60] [--concurrency 4]
//
// 为什么单独一个脚本：reliability-battery 测的是“不需要模型”的链路，跑得快；
// 这里每条句子要几秒模型调用，必须单独控制规模，避免一次跑掉几十分钟。
// 输出 data/reliability/model-eval.json：每条句子的模型结论原文，人工核对的对象就是它。
import { readFileSync, writeFileSync } from 'node:fs';
import { createProviders } from '../src/providers.mjs';
import { checkDraft, validateFindings } from '../src/domain.mjs';
import { CHECK_TASK } from '../src/review-prompt.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const SAMPLE = flag('--sample', 60);
const CONCURRENCY = flag('--concurrency', 4);
// 线上 quick_check 只报 1 条，review_remaining 报 6 条。默认按线上的 1 条评估，
// 否则量到的是“全文巡检”的报出率，会高估产品实际会推给用户的噪音。
const LIMIT = flag('--limit', 1);
const OUT = new URL('../data/reliability/', import.meta.url);

const sentences = JSON.parse(readFileSync(new URL('sentences.json', OUT), 'utf8'));
const providers = createProviders(process.env);
if (!providers.status.model) { console.error('未配置模型，无法评估。'); process.exit(1); }

// 分层：命中句全取（本来就不多），未命中句按固定步长抽样。
// --stride 可以换一批样本做交叉验证：同一批数字换一个抽样步长就变了，单次结果不能当结论。
const STRIDE = flag('--stride', 0);
const hit = [];
const miss = [];
for (const s of sentences) (checkDraft(s.text, 6).length ? hit : miss).push(s);
const step = STRIDE > 0 ? STRIDE : Math.max(1, Math.floor(miss.length / Math.max(1, SAMPLE - hit.length)));
const picked = [...hit, ...miss.filter((_, i) => i % step === 0).slice(0, Math.max(0, SAMPLE - hit.length))];
console.log(`语料 ${sentences.length} 条 → 命中句 ${hit.length} 条全取，未命中句每 ${step} 条取 1 → 本次评估 ${picked.length} 条`);
console.log(`并发 ${CONCURRENCY}，每条最多报 ${LIMIT} 处，预计 ${Math.ceil(picked.length / CONCURRENCY * 3 / 60)}–${Math.ceil(picked.length / CONCURRENCY * 6 / 60)} 分钟\n`);

const results = [];
let cursor = 0, done = 0;
const t0 = Date.now();
async function worker(id) {
  while (cursor < picked.length) {
    const item = picked[cursor++];
    const started = Date.now();
    const offline = checkDraft(item.text, 6);
    let record = { text: item.text, offlineKinds: offline.map(f => f.kind), ms: 0 };
    try {
      const data = await providers.model(CHECK_TASK, { text: item.text, limit: LIMIT }, AbortSignal.timeout(120000));
      const findings = validateFindings(data, item.text, LIMIT);
      record = { ...record, ms: Date.now() - started, modelFindings: findings.map(f => ({ kind: f.kind, quote: f.quote, severity: f.severity, impact: f.impact, direction: f.direction, reason: f.reason })) };
    } catch (e) {
      record = { ...record, ms: Date.now() - started, error: e.code || 'ERROR', message: e.message };
    }
    results.push(record);
    done++;
    const tag = record.error ? `ERR ${record.error}` : (record.modelFindings.length ? `报 ${record.modelFindings.map(f => f.kind).join(',')}` : '安静');
    if (done % 5 === 0 || done === picked.length) console.log(`  ${String(done).padStart(3)}/${picked.length}  ${tag}  ${item.text.slice(0, 24)}…`);
    else console.log(`  ${String(done).padStart(3)}/${picked.length}  ${tag}  ${item.text.slice(0, 24)}…`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

const reported = results.filter(r => r.modelFindings?.length);
const errors = results.filter(r => r.error);
const latencies = results.filter(r => r.ms).map(r => r.ms).sort((a, b) => a - b);
const kindCount = {};
for (const r of reported) for (const f of r.modelFindings) kindCount[f.kind] = (kindCount[f.kind] || 0) + 1;
const sevCount = {};
for (const r of reported) for (const f of r.modelFindings) sevCount[f.severity || '未给'] = (sevCount[f.severity || '未给'] || 0) + 1;
const disagree = results.filter(r => !r.error && (r.modelFindings.length > 0) !== (r.offlineKinds.length > 0));

const summary = {
  at: new Date().toISOString(), model: process.env.MODEL_NAME, limit: LIMIT, sentences: picked.length,
  reported: reported.length, quiet: results.length - reported.length - errors.length, errors: errors.length,
  reportRate: `${((reported.length / results.length) * 100).toFixed(1)}%`,
  medianMs: latencies[Math.floor(latencies.length / 2)] ?? null,
  kinds: kindCount, severities: sevCount,
  offlineVsModelDisagreement: disagree.length,
  totalMs: Date.now() - t0,
};
writeFileSync(new URL('model-eval.json', OUT), JSON.stringify({ summary, results }, null, 1));
console.log(`\n=== 模型判定（真实语料 ${picked.length} 条）===`);
console.log(`  报出问题：${reported.length} 条（${summary.reportRate}）· 未报：${summary.quiet} 条 · 出错：${errors.length} 条`);
console.log(`  单条中位耗时：${summary.medianMs} ms · 总耗时 ${(summary.totalMs / 1000 / 60).toFixed(1)} 分钟`);
console.log('  类型分布：', JSON.stringify(kindCount));
console.log('  严重度分布：', JSON.stringify(sevCount));
console.log(`  与本地规则结论不一致：${disagree.length} 条（这是要看的具体清单）`);
console.log('  明细已写入 data/reliability/model-eval.json');
