// 手动验收：把真实模型接到提示词上跑同一批样例，给出可复核的判定。
//
//   node --env-file-if-exists=.env scripts/verify-check-prompt.mjs [--model 模型名] [--verbose]
//
// 为什么要有这个脚本：提示词的质量只能靠真实模型回答来验收，不能靠读文本。
// 这里复用 src/providers.mjs 的真实请求路径与 src/review-prompt.mjs 的真实提示词，
// 再用 validateFindings 做与线上相同的校验——模型编造 quote、写空话理由都会在这里暴露。
//
// 每个样例量两件事：
//   1. 判定对不对：该报的报了（HIT），不该报的没报（CLEAN）。
//   2. 意见中不中肯：理由是否具体、是否给了严重度与修改方向（MISSING DIRECTION / VAGUE）。
// 样例与判定标准见 test/fixtures/prompt-samples.json；离线规则单测见 test/check-prompt.test.mjs。
import { readFileSync } from 'node:fs';
import { createProviders } from '../src/providers.mjs';
import { CHECK_TASK, VAGUE_REASONS } from '../src/review-prompt.mjs';
import { validateFindings, AppError } from '../src/domain.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const verbose = args.includes('--verbose');
const modelOverride = flag('--model');

const samples = JSON.parse(readFileSync(new URL('../test/fixtures/prompt-samples.json', import.meta.url), 'utf8'));
const env = { ...process.env };
if (modelOverride) env.MODEL_NAME = modelOverride;

if (!env.MODEL_BASE_URL || !env.MODEL_NAME || !env.MODEL_API_KEY) {
  console.error('缺少模型配置：需要 MODEL_BASE_URL、MODEL_NAME、MODEL_API_KEY（可放进 .env 后用 --env-file-if-exists 加载）。');
  process.exit(1);
}
console.log(`模型：${env.MODEL_NAME} @ ${env.MODEL_BASE_URL}\n样例：${samples.length} 条（report ${samples.filter(s => s.expect === 'report').length} / quiet ${samples.filter(s => s.expect === 'quiet').length}）\n`);

const providers = createProviders(env);
// 意见质量：中肯的最低门槛是“说清缺口 + 给得出方向”。这两项模型不给，作者就拿不到有用的话。
function quality(findings) {
  if (!findings.length) return { issues: [], text: '' };
  const issues = [];
  const vague = findings.filter(f => VAGUE_REASONS.some(v => f.reason.includes(v)));
  if (vague.length) issues.push('VAGUE');
  const noDirection = findings.filter(f => !f.direction);
  if (noDirection.length) issues.push('MISSING DIRECTION');
  const noSeverity = findings.filter(f => !f.severity);
  if (noSeverity.length) issues.push('MISSING SEVERITY');
  const text = findings.map(f => `[${f.severity || '无档位'}·${f.impact || '无影响面'}] ${f.kind} → ${f.direction || '（没给方向）'}`).join(' | ');
  return { issues, text };
}

const rows = [];
for (const sample of samples) {
  const started = Date.now();
  let outcome, kinds = '', detail = '';
  try {
    const data = await providers.model(CHECK_TASK, { text: sample.text, limit: 6 }, new AbortController().signal);
    const findings = validateFindings(data, sample.text, 6);
    const q = quality(findings);
    kinds = findings.map(f => f.kind).join(',');
    // allowKinds：同一条缺口可以合理地归入多个类型，例如“加一张沙发就能提高转化率”
    // 报成“因果缺失”同样成立。判定标准是“报得对不对”，不是“分类跟样例一模一样”。
    const allowed = sample.allowKinds || null;
    const matching = allowed ? findings.filter(f => allowed.includes(f.kind)) : findings;
    const hit = allowed ? matching.length > 0 : findings.length > 0;
    const extra = findings.length > 0 && !hit;
    outcome = (sample.expect === 'report' && hit) ? 'HIT' : (sample.expect === 'quiet' && !hit) ? 'CLEAN' : hit ? 'FALSE POSITIVE' : 'MISSED';
    if (extra) outcome += ' (kinds:' + kinds + ')';
    if (q.issues.length) outcome += ` +${q.issues.join('+')}`;
    if (verbose) detail = (allowed && hit ? matching : findings).map(f => `\n      [${f.kind}] ${f.quote}\n        ${f.reason}${f.direction ? `\n        方向：${f.direction}` : ''}`).join('');
    else detail = q.text ? `\n      ${q.text}` : '';
  } catch (e) {
    outcome = 'ERROR';
    detail = `\n      ${e instanceof AppError ? `${e.code}：` : ''}${e.message}`;
  }
  rows.push({ sample, outcome, kinds, detail, ms: Date.now() - started });
  console.log(`${outcome.padEnd(38)} ${sample.id.padEnd(28)} ${String(Date.now() - started).padStart(5)}ms  ${kinds}${detail}`);
}

const count = needle => rows.filter(r => r.outcome.startsWith(needle)).length;
const errors = rows.filter(r => r.outcome === 'ERROR');
console.log(`\n判定结果：命中 ${count('HIT')} · 正确安静 ${count('CLEAN')} · 误报 ${count('FALSE POSITIVE')} · 漏报 ${count('MISSED')} · 出错 ${count('ERROR')}`);
const qualityCount = needle => rows.filter(r => r.outcome.includes(needle)).length;
console.log(`意见质量：空话理由 ${qualityCount('VAGUE')} 条 · 没给方向 ${qualityCount('MISSING DIRECTION')} 条 · 没给严重度 ${qualityCount('MISSING SEVERITY')} 条`);
if (errors.length) console.log('出错样例的失败原因见上方：MODEL_UNAVAILABLE 说明服务端拒绝（密钥、额度或网关），INVALID_MODEL_OUTPUT 说明模型没按契约输出或理由过于空泛。');
const clean = count('FALSE POSITIVE') === 0 && count('MISSED') === 0 && count('ERROR') === 0;
const grounded = rows.every(r => !r.outcome.includes('VAGUE') && !r.outcome.includes('MISSING DIRECTION'));
console.log(clean && grounded
  ? '判定：这批样例上提示词与模型配合可用（无误报、无漏报、每条意见都给了方向）。'
  : `判定：判定准确性${clean ? '通过' : '未通过'}，意见完整性${grounded ? '通过' : '未通过'}；不要把这批结果当作已验收。`);
process.exit(clean && grounded ? 0 : 1);
