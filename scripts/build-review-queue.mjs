// 生成人工可判断的评审清单：模型报出的意见 + 未报的对照句，供人工标注真实误报率。
//   node scripts/build-review-queue.mjs
// 输出 data/reliability/review-queue.md：每条一句话，人工只需勾“真问题 / 可接受”。
// 这件事必须由人做：模型报得对不对，无法用模型自评，也无法用提示词自证。
import { readFileSync, writeFileSync } from 'node:fs';
const OUT = new URL('../data/reliability/', import.meta.url);
const { summary, results } = JSON.parse(readFileSync(new URL('model-eval.json', OUT), 'utf8'));

const reported = results.filter(r => (r.modelFindings || []).length);
const quiet = results.filter(r => !r.error && !(r.modelFindings || []).length);
const lines = [];
const w = s => lines.push(s);

w('# 评审清单 · 请人工判断这些意见对不对');
w('');
w(`模型 ${summary.model} ｜ 抽样 ${summary.sentences} 条真实知乎句子 ｜ 报出 ${summary.reported} 条（${summary.reportRate}）｜ 未报 ${summary.quiet} 条 ｜ 出错 ${summary.errors} 条`);
w(`单条中位耗时 ${summary.medianMs} ms ｜ 类型分布 ${Object.entries(summary.kinds).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
w('');
w('用法：逐条在“判断”一栏写 **真问题** 或 **可接受**。');
w('“可接受”指这条意见虽然说得通，但不该占用作者的注意力——它属于要求补充细节，而不是指出真正的缺口。');
w('把标注过的这份文件发回来，我就能算出真实误报率与漏报率，而不是靠模型自评。');
w('');
w('---');
w('');
w(`## A. 模型报出的 ${reported.length} 条`);
w('');
reported.forEach((r, i) => {
  const f = r.modelFindings[0];
  w(`### A${i + 1}. ${f.kind}（${f.severity || '未给严重度'}）｜ 方向：${f.direction || '未给'}`);
  w('');
  w(`- **原句**：${r.text}`);
  w(`- **模型理由**：${f.reason}`);
  w(`- **判断**：`);
  w('');
});
w(`## B. 模型未报的 ${quiet.length} 条（对照：看有没有该报却漏掉的）`);
w('');
quiet.forEach((r, i) => {
  w(`- B${i + 1}. ${r.text}`);
});
w('');
w('> 漏报的判断标准同上：如果某句你觉得“这里确实站不住”，就是漏报，请在后面标注。');
w('');
writeFileSync(new URL('review-queue.md', OUT), lines.join('\n'));
console.log(`已写入 data/reliability/review-queue.md：报出 ${reported.length} 条待判断 + 未报 ${quiet.length} 条对照`);
