// 可靠性电池：用真实知乎数据压测“原稿论证检查”这一条链路。
//
//   node --env-file-if-exists=.env scripts/reliability-battery.mjs [--topics N] [--answers N] [--verify N]
//
// 数据来自真实接口（zhihu_search / global_search / question_answers），全部落盘到
// data/reliability/，其他人可以复核同一批材料，不必重复消耗额度。
//
// 这个脚本只测“不需要模型”的部分，因为模型凭据当前不可用：
//   A. 取数可靠性：真实回答能不能取到，返回结构是否符合契约
//   B. 判定可靠性：真实句子上的命中率、类型分布、误报（已知类型清单）
//   C. 证据管道可靠性：检索延迟、去重、缓存命中、空结果与错误分类
// 模型参与的判定质量（误报/漏报的真实水平）由 scripts/verify-check-prompt.mjs 单独验收，
// 这里只把真实句子整理成待验收语料。脚本开头会明确打印这一边界。
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createProviders } from '../src/providers.mjs';
import { checkDraft } from '../src/domain.mjs';
import { Store } from '../src/store.mjs';
import { Service } from '../src/service.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const TOPICS = flag('--topics', 8);
const PER_TOPIC = flag('--answers', 3);
const VERIFY_SENTENCES = flag('--verify', 8);
// --offline：不联网，直接复用 data/reliability/sentences.json 重跑判定。
// 改完规则要立刻量效果时用它：真实语料只在第一次抓取时消耗额度，之后都是免费的回归。
const OFFLINE = args.includes('--offline');
const SUFFIX = (() => { const i = args.indexOf('--suffix'); return i >= 0 ? args[i + 1] : ''; })();
const OUT = new URL('../data/reliability/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const outFile = name => new URL(`${name}${SUFFIX}.json`, OUT);

const providers = createProviders(process.env);
const signal = () => AbortSignal.timeout(30000);
const results = { startedAt: new Date().toISOString(), offline: OFFLINE, config: { topics: TOPICS, answersPerTopic: PER_TOPIC, verifySentences: VERIFY_SENTENCES }, topics: [], sentences: [], evidence: [], cache: [], errors: [] };
const t0 = Date.now();

if (!OFFLINE && !providers.status.zhihu) {
  console.error('缺少 ZHIHU_ACCESS_SECRET，无法取真实数据。');
  process.exit(1);
}
console.log('模型配置存在性：', providers.status.model ? '已配置（但下面所有判定都走本地规则，不使用模型）' : '未配置');
console.log(OFFLINE ? '模式：--offline，复用已抓取的真实语料，不产生任何接口调用。\n' : '本批只测离线规则与证据管道；模型判定质量需要 scripts/verify-check-prompt.mjs 单独验收。\n');

// 话题选口语化、结论密度高的领域：更容易出现强断言与数量断言，适合压测判定。
const TOPICS_LIST = [
  '远程办公的效率', '考研还是工作', 'AI 会不会取代程序员', '健身增肌怎么吃',
  '新能源汽车值不值得买', '大学生该不该考证', '一线城市还是回老家', '短视频对注意力的影响',
].slice(0, TOPICS);

const safe = async (label, fn) => {
  try { return await fn(); }
  catch (e) { results.errors.push({ label, code: e.code || 'ERROR', message: e.message }); console.log(`    ✗ ${label}：${e.code || ''} ${e.message}`); return null; }
};

// A. 取数：主题 → 问题 → 回答摘要
if (!OFFLINE) {
console.log('=== A. 取数可靠性 ===');
for (const topic of TOPICS_LIST) {
  const questions = await safe(`推荐问题「${topic}」`, () => providers.questions(topic, signal()));
  if (!questions?.length) continue;
  const question = questions[0];
  const page = await safe(`回答摘要「${question.title}」`, () => providers.answers(question.url, 0, signal()));
  const items = (page?.items || []).slice(0, PER_TOPIC);
  results.topics.push({ topic, question: { title: question.title, url: question.url }, answerCount: items.length, isEnd: page?.isEnd ?? null, nextOffset: page?.nextOffset ?? null });
  console.log(`  ${topic} → 《${question.title}》 取到 ${items.length} 条回答摘要`);
  for (const item of items) {
    results.sentences.push(...splitSentences(item.summary).map(text => ({ text, topic, questionUrl: question.url, answerUrl: item.url })));
  }
}

// 句子切分：与线上一致的朴素切分，但去掉明显不是“论断”的碎片（标签、纯链接、过短）。
function splitSentences(blob) {
  return String(blob || '')
    .replace(/<[^>]*>/g, '')
    .split(/(?<=[。！？；!?;])|\n+/)
    .map(s => s.trim())
    .filter(s => [...s].length >= 20 && [...s].length <= 160)
    .filter(s => !/^https?:|^图|^编辑于|^发布于|^关注|^赞同|^评论/.test(s))
    .filter(s => /[\u4e00-\u9fa5]/.test(s));
}

// A2. 补充语料：搜索接口返回的是内容全文片段（最长 5000 字），比回答摘要更接近真实发帖。
// 同时用真实句子跑一次“查依据”，这样证据管道的输入就是真实的主张，而不是造出来的测试串。
console.log('\n=== A2. 取数可靠性（搜索）===');
// 去重：同一句话可能被多个回答/来源重复引用
const seen = new Set();
results.sentences = results.sentences.filter(s => (seen.has(s.text) ? false : (seen.add(s.text), true)));
console.log(`  回答摘要去掉重复后：${results.sentences.length} 条`);
const SEARCH_QUERIES = TOPICS_LIST.map(t => `${t} 真的更好吗`);
const searchCorpus = [];
for (const q of SEARCH_QUERIES) {
  for (const kind of ['zhihu_search', 'global_search']) {
    const items = await safe(`${kind}「${q}」`, () => providers.search(kind, q, signal()));
    for (const it of items || []) {
      searchCorpus.push(...splitSentences(it.text).map(text => ({ text, topic: q, provider: kind, url: it.url, title: it.title, relation: it.relation, authorityLevel: it.authorityLevel })));
    }
    console.log(`  ${kind.padEnd(14)}「${q}」→ ${(items || []).length} 条来源，累计句子 ${searchCorpus.length}`);
    if (searchCorpus.length >= 900) break;
  }
  if (searchCorpus.length >= 900) break;
}
const seen2 = new Set();
for (const s of searchCorpus) { if (seen2.has(s.text)) continue; seen2.add(s.text); results.sentences.push(s); }
console.log(`  搜索语料去重后合计句子：${results.sentences.length} 条`);
writeFileSync(new URL('sentences.json', OUT), JSON.stringify(results.sentences, null, 1));
} else {
  results.sentences = JSON.parse(readFileSync(new URL('sentences.json', OUT), 'utf8'));
  console.log(`=== 复用真实语料：${results.sentences.length} 条句子（未联网）===`);
}

// B. 判定：对真实句子跑本地规则
console.log('\n=== B. 判定可靠性（本地规则，无模型）===');
const hits = [];
for (const s of results.sentences) {
  const items = checkDraft(s.text, 6);
  for (const item of items) {
    // 锚点必须能回到原句，否则高亮与后续操作都会指错位置
    const anchored = s.text.slice(item.start, item.end) === item.quote;
    hits.push({ ...item, topic: s.topic, anchored, source: s.text });
  }
}
const hitSentences = new Set(hits.map(h => h.source)).size;
const kindCount = {};
for (const h of hits) kindCount[h.kind] = (kindCount[h.kind] || 0) + 1;
const sevCount = {};
for (const h of hits) sevCount[h.severity || '无'] = (sevCount[h.severity || '无'] || 0) + 1;
console.log(`  命中句子：${hitSentences} / ${results.sentences.length}（${pct(hitSentences, results.sentences.length)}）`);
console.log('  类型分布：', JSON.stringify(kindCount));
console.log('  严重度分布：', JSON.stringify(sevCount));
console.log(`  锚点校验：${hits.filter(h => h.anchored).length} / ${hits.length} 可回到原文`);

// 误报台账：本地规则的已知误报形态——正常物理度量、作者已收窄、转述、提问、标准比率单位。
// 命中里凡符合这些特征的都要逐条列出来，不能只报“命中率”就当测试通过。
const FALSE_POSITIVE_SHAPES = [
  ['提问句', /[？?]/],
  ['作者已收窄', /不能|并非|未必|不是|是否/],
  ['引号转述', /[“”「」"]/],
  ['标准比率单位', /每\s*(公斤|千克|克|升|人|天|月|年|小时|瓦|度)|瓦时/],
  ['无害固定搭配', /一定的|一定程度|一定要/],
];
const reviewed = hits.map(h => ({ ...h, falsePositive: FALSE_POSITIVE_SHAPES.find(([, re]) => re.test(h.source))?.[0] || null }));
const fps = reviewed.filter(h => h.falsePositive);
console.log(`  疑似误报（命中里带提问/否定/引号/比率单位/无害搭配特征）：${fps.length}`);
results.hits = reviewed;
results.verdict = { sentences: results.sentences.length, hitSentences, kinds: kindCount, severities: sevCount, falsePositives: fps.length };
writeFileSync(outFile('hits'), JSON.stringify(reviewed, null, 1));

// C. 证据管道：真实检索 + 去重 + 缓存 + 空结果/错误分类
if (!OFFLINE) {
console.log('\n=== C. 证据管道可靠性 ===');
const store = new Store(':memory:');
const service = new Service(store, providers);
const hitSources = new Set(hits.map(h => h.source));
const isFlagged = text => hitSources.has(text);
const hitPick = results.sentences.filter(s => isFlagged(s.text)).slice(0, Math.ceil(VERIFY_SENTENCES / 2)).map(s => ({ text: s.text, flagged: true }));
const missPick = results.sentences.filter(s => !isFlagged(s.text)).slice(0, Math.max(0, VERIFY_SENTENCES - hitPick.length)).map(s => ({ text: s.text, flagged: false }));
// 交错排列：否则“命中句”会把额度用光，未命中句一条都跑不到（第一次跑就是这样）。
const pick = [];
for (let i = 0; i < Math.max(hitPick.length, missPick.length); i++) {
  if (hitPick[i]) pick.push(hitPick[i]);
  if (missPick[i]) pick.push(missPick[i]);
}
console.log(`  抽取 ${pick.length} 句（命中 ${pick.filter(p => p.flagged).length} · 未命中 ${pick.filter(p => !p.flagged).length}）跑真实检索`);
const hitReason = new Map(hits.map(h => [h.source, h]));
for (const p of pick) { const h = hitReason.get(p.text); if (h) p.via = `${h.kind}（${h.severity}）`; }
// 抽样必须两类都覆盖：只跑命中句会得出“检索质量很好”的假结论（这个坑真踩过）。
if (!hitPick.length || !missPick.length) throw new Error(`抽样失败：命中句 ${hitPick.length} 条、未命中句 ${missPick.length} 条，无法比较两类句子的检索质量。`);
console.log(`  抽样构成：hitPick=${hitPick.length} missPick=${missPick.length} → pick=${pick.length}`);
for (const [i, p] of pick.entries()) {
  const project = await service.create('reliability', p.text);
  const checked = await waitOp(store, await service.start('reliability', project.id, { type: 'quick_check', key: `rel-check-${i}`, revision: 1 }));
  const withFinding = store.get(project.id, 'reliability');
  const finding = withFinding.findings[0];
  if (!finding) { results.evidence.push({ text: p.text, flagged: p.flagged, engine: withFinding.lastCheck?.engine, error: checked.error?.code || 'NO_FINDING' }); continue; }
  const started = Date.now();
  const op = await waitOp(store, await service.start('reliability', project.id, { type: 'verify_claim', key: `rel-verify-${i}`, revision: 1, findingId: finding.id }));
  const after = store.get(project.id, 'reliability');
  const v = after.verification[finding.id];
  const sources = after.sources.filter(s => v?.sourceIds?.includes(s.id));
  results.evidence.push({
    text: p.text, flagged: p.flagged, engine: withFinding.lastCheck?.engine,
    status: op.status, ms: Date.now() - started,
    sources: sources.length, providers: [...new Set(sources.map(s => s.provider))],
    relations: [...new Set(sources.map(s => s.relation))],
    summary: v?.summary || '', errors: v?.errors || [],
    urls: sources.map(s => s.url),
  });
  console.log(`  [${op.status}] ${sources.length} 条来源 / ${Date.now() - started}ms · ${p.flagged ? '命中句' : '未命中句'} · ${p.text.slice(0, 22)}…`);
  // 缓存：同一 finding 再查一次，应命中 30 分钟缓存、不产生新的检索
  if (i === 0) {
    const before2 = results.evidence.at(-1);
    const started2 = Date.now();
    const op2 = await waitOp(store, await service.start('reliability', project.id, { type: 'verify_claim', key: `rel-verify-${i}-again`, revision: 1, findingId: finding.id }));
    const after2 = store.get(project.id, 'reliability');
    const cachedSame = after2.sources.length === after.sources.length;
    results.cache.push({ cached: Boolean(op2.cached), sourceCountStable: cachedSame, firstMs: before2.ms, secondMs: Date.now() - started2 });
    console.log(`  缓存复核：cached=${Boolean(op2.cached)} 来源数不变=${cachedSame} 第二次耗时=${Date.now() - started2}ms`);
  }
}
store.close();
} else {
  console.log('\n=== C. 证据管道：本次 --offline，未重复调用接口 ===');
}

const report = { ...results, finishedAt: new Date().toISOString(), totalMs: Date.now() - t0 };
writeFileSync(outFile('battery'), JSON.stringify(report, null, 1));
writeFileSync(outFile('verdict'), JSON.stringify({ ...results.verdict, offline: OFFLINE, errors: results.errors, finishedAt: report.finishedAt }, null, 1));
console.log(`\n原始数据已写入 data/reliability/（battery${SUFFIX}.json / hits${SUFFIX}.json / sentences.json）`);
console.log(`总耗时 ${(report.totalMs / 1000).toFixed(1)}s，接口错误 ${results.errors.length} 条`);

function pct(a, b) { return b ? `${((a / b) * 100).toFixed(1)}%` : '0%'; }
async function waitOp(store, op) {
  for (let i = 0; i < 400; i++) {
    const cur = store.getOp(op.id, op.owner);
    if (!['queued', 'running'].includes(cur.status)) return cur;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('operation timeout');
}
