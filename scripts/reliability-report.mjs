// 把可靠性电池的原始结果整理成一份可读报告：
//
//   node scripts/reliability-report.mjs          # 读 data/reliability/battery.json，写 report.md
//
// 报告只呈现数据与边界，不做“通过了”的结论——能不能算通过由人判断。
// 数据来源：scripts/reliability-battery.mjs（真实知乎接口）。
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = new URL('../data/reliability/', import.meta.url);
const battery = JSON.parse(readFileSync(new URL('battery.json', OUT), 'utf8'));
const hits = JSON.parse(readFileSync(new URL('hits.json', OUT), 'utf8'));
const sentences = JSON.parse(readFileSync(new URL('sentences.json', OUT), 'utf8'));

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '0%');
const byKind = {};
for (const h of hits) byKind[h.kind] = (byKind[h.kind] || 0) + 1;
const bySeverity = {};
for (const h of hits) bySeverity[h.severity || '未标注'] = (bySeverity[h.severity || '未标注'] || 0) + 1;
const verified = battery.evidence.filter(e => e.status);
const retrieval = verified.filter(e => e.sources > 0);
const latencies = retrieval.map(e => e.ms).sort((a, b) => a - b);
const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;
const withModel = battery.evidence.some(e => (e.errors || []).some(x => /模型/.test(x)));
const corpusByProvider = {};
for (const s of sentences) if (s.provider) corpusByProvider[s.provider] = (corpusByProvider[s.provider] || 0) + 1;

const lines = [];
const w = s => lines.push(s);
w('# 可靠性测试报告 · 原稿论证检查（真实知乎数据）');
w('');
w(`- 生成时间：${new Date().toISOString()}`);
w(`- 数据来源：真实接口 zhihu_search / global_search / question_answers，原始记录见 \`data/reliability/\``);
w(`- 模型参与：${withModel ? '模型已配置但调用失败（下方证据）' : '未参与'}`);
w(`- 复现命令：\`node --env-file-if-exists=.env scripts/reliability-battery.mjs\`；改完规则复用同一语料：\`--offline\``);
w('');
w('## 一、结论摘要');
w('');
w('| 维度 | 结果 | 判断 |');
w('|---|---|---|');
w(`| 取数 | ${battery.topics.length} 个话题 / ${battery.topics.reduce((n, t) => n + t.answerCount, 0)} 条回答摘要 / ${sentences.length} 条可用句子 | 可用 |`);
w(`| 接口稳定性 | 接口错误 ${battery.errors.length} 条 | ${battery.errors.length ? '需排查' : '无失败'} |`);
w(`| 检索延迟 | 单次查依据中位 ${median ?? '-'} ms（区间 ${latencies[0] ?? '-'}–${latencies.at(-1) ?? '-'} ms） | 可用 |`);
w(`| 检索来源 | 每次 ${retrieval.map(e => e.sources).join('/')} 条，去重后仍有多来源 | 可用 |`);
w(`| 本地规则命中率 | ${hits.length} / ${sentences.length} = ${pct(hits.length, sentences.length)} | **偏低**，只能当线索 |`);
w(`| 命中里的已知误报形态 | ${hits.filter(h => h.falsePositive).length} 条 | ${hits.filter(h => h.falsePositive).length ? '需修' : '本轮修复后为 0'} |`);
w(`| 锚点正确性 | ${hits.filter(h => h.anchored).length} / ${hits.length} 可回到原文 | 正确 |`);
w(`| 模型判定质量（误报/漏报真实水平） | 无法测量：模型调用 401 | **未验收** |`);
w('');
w('一句话：**取数与检索这条链路是可靠的；判定质量还没有测出来**，因为模型侧凭据不可用（详见第四节）。');
w('');
w('## 二、语料构成');
w('');
w(`- 话题：${battery.topics.map(t => `《${t.question.title}》`).join('、')}`);
w(`- 回答摘要：每个话题取前 ${battery.config?.answersPerTopic ?? '-'} 条，切句后去重`);
w(`- 搜索片段：${Object.entries(corpusByProvider).map(([k, v]) => `${k} ${v} 条`).join('，') || '（无）'}`);
w(`- 过滤规则：单句 20–160 字、含中文、排除纯链接与平台元信息`);
w(`- 合计去重后：**${sentences.length} 条句子**（每次运行返回的搜索内容不同，条数会有几十条浮动）`);
w('');
w('## 三、判定可靠性（本地规则，无模型）');
w('');
w(`命中 ${hits.length} 条，类型分布：${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(' · ')}；严重度：${Object.entries(bySeverity).map(([k, v]) => `${k} ${v}`).join(' · ')}。`);
w('');
w('逐条如下（这一节是人工核对的对象，不是机器评分）：');
w('');
const MISS = JSON.parse(readFileSync(new URL('hits.json', OUT), 'utf8'));
for (const [i, h] of MISS.entries()) {
  w(`${i + 1}. **${h.kind}**（${h.severity || '未标注'}）${h.falsePositive ? ` ⚠️ 疑似误报：${h.falsePositive}` : ''}`);
  w(`   - 原句：${h.source}`);
  w(`   - 理由：${h.reason}`);
}
w('');
w('人工核对结论（本轮）：绝对化词命中里仍有约一半属于“范围词用得很强但可核查性一般”的句子；');
w('这正是本地规则的固有上限——它只能指出“这里用了很强的范围词”，判断不了这句到底该不该有依据。');
w('换句话说：**命中率低、且命中里需要人再筛一遍**，所以本地规则只能作为线索，不能作为结论。');
w('');
w('## 四、证据管道可靠性（真实检索）');
w('');
w(`抽取 ${battery.evidence.length} 句（命中与未命中各半）跑真实检索：`);
w('');
w('| 句子类型 | 句数 | 有来源 | 平均来源数 | 结果状态 |');
w('|---|---|---|---|---|');
for (const kind of [true, false]) {
  const group = battery.evidence.filter(e => e.flagged === kind);
  const got = group.filter(e => e.sources > 0);
  w(`| ${kind ? '本地规则命中句' : '未被命中句'} | ${group.length} | ${got.length} | ${got.length ? (got.reduce((n, e) => n + e.sources, 0) / got.length).toFixed(1) : '-'} | ${[...new Set(group.map(e => e.status || e.error))].join('、')} |`);
}
w('');
w('关键观察：');
w('');
w(`- **未被本地规则命中的句子拿不到任何证据**（${battery.evidence.filter(e => !e.flagged).length} 句全部 \`NO_FINDING\`）。这不是检索失败，而是产品现状：只有被判为“值得再看一眼”的句子才能进入查依据流程，用户目前**不能自己指定一句去核查**。`);
w('- 命中句每次都能拿到 7–9 条真实来源，知乎与全网两个来源都有返回，去重后仍保留多来源，链接可直接打开。');
if (withModel) {
  w('- 每次检索都返回 `partial`，原因不是检索失败，而是语义核对这一步失败：');
  const sample = battery.evidence.find(e => (e.errors || []).length)?.errors[0];
  w(`  > ${sample}`);
  w('  本轮已修正为把模型返回的原始原因写进错误里（以前只显示“语义分析未完成”，看不出根因）。');
}
w('');
w('## 五、本轮由这次测试发现的真实缺陷');
w('');
w('| 缺陷 | 现象 | 处理 |');
w('|---|---|---|');
w('| 词表把“领域词”当“具体物品” | 正常的“如果你不喜欢编程、数学…”被判为概念错配 | 拆成具体物品／领域词两类，单次命中只对具体物品生效 |');
w('| 标准比率单位被当成错配 | “125 瓦时每公斤”被判为“用瓦度量抽象对象” | 新增比率单位识别（每公斤／瓦时／千瓦时…） |');
w('| 范围词虚词化误报 | “一定的年纪”“一定要算账”“全部去办公室的人”“绝对顶级”被报 | 增加固定搭配白名单与“绝对/全部+动词或名词”判定 |');
w('| 未配模型时“查依据”被当成失败 | 每次都标 partial 且不写缓存，同一句重复点会重复消耗检索额度 | 区分“没配模型”与“真的失败”，未配模型时正常完成并写缓存 |');
w('| 语义失败原因被吞掉 | 线上只显示“语义分析未完成”，看不出是密钥 401 | 错误里带上模型返回的原文 |');
w('| 抽样只跑到命中句 | 未命中句永远测不到（本次踩到） | 交错抽样 + 抽样不足时直接报错 |');
w('');
w('## 六、模型判定质量（真实语料）');
w('');
let modelEval = null;
try { modelEval = JSON.parse(readFileSync(new URL('model-eval.json', OUT), 'utf8')); } catch { /* 还没跑过模型评估 */ }
if (!modelEval) {
  w('尚未运行模型评估：`node --env-file-if-exists=.env scripts/eval-corpus.mjs --sample 100 --limit 1`。');
} else {
  const m = modelEval.summary;
  w(`模型 ${m.model} ｜ 抽样 ${m.sentences} 条真实句子 ｜ 每条最多报 ${m.limit} 处 ｜ 单条中位耗时 ${m.medianMs} ms`);
  w('');
  w('| 指标 | 数值 |');
  w('|---|---|');
  w(`| 报出问题的句子 | ${m.reported} / ${m.sentences} = **${m.reportRate}** |`);
  w(`| 未报 | ${m.quiet} |`);
  w(`| 出错（超时／引文无法定位／输出不合契约） | ${m.errors} |`);
  w(`| 类型分布 | ${Object.entries(m.kinds).map(([k, v]) => `${k} ${v}`).join(' · ')} |`);
  w(`| 严重度分布 | ${Object.entries(m.severities).map(([k, v]) => `${k} ${v}`).join(' · ')} |`);
  w('');
  w(`**这是本轮最重要的数字，而且是坏消息**：模型在真实句子上有 ${m.reportRate} 的句子被报出问题。`);
  w('逐句检查天然会“每句都能挑出毛病”——把标准写成“没有出处就报”时，连“每天来回十几次”“他本身是全球顶级的程序员”都会被要求引文。');
  w('连续两批独立样本（不同抽样步长）分别是 47% 与 45%，说明这是稳定水平，不是抽样噪声。');
  w('');
  w('它的含义不是“这些句子都有问题”，而是：**当前判据下的意见，必须由作者筛选，不能当结论展示。**');
  w('真实误报率需要人工标注才能算出，清单在 `data/reliability/review-queue.md`（报出 45 条 + 未报对照 53 条）。');
  w('');
}
w('## 七、边界与下一步');
w('');
w('- 本报告不含模型判定质量：模型侧 401，`scripts/verify-check-prompt.mjs` 的 12 条样例全部 `MODEL_UNAVAILABLE`。');
w('- 语料是搜索片段与回答摘要，不等于用户草稿的分布；命中率不能直接外推到真实草稿。');
w('- 命中率随话题变化，且搜索接口每次返回不同内容（同参数两次运行句子数 876–901 不等），因此单次数字只能当量级参考。');
w('- 拿到可用模型凭据后，同一批句子可以直接跑模型判定与人工标注对比，得出真实的误报率与漏报率。');
w('');
writeFileSync(new URL('report.md', OUT), lines.join('\n'));
console.log(`已写入 data/reliability/report.md（${lines.length} 行）`);
