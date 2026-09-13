import { createHash, randomUUID } from 'node:crypto';
export class AppError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const hash = text => createHash('sha256').update(text).digest('hex');
export const id = () => randomUUID();
export function bounded(value, min, max, name = '内容') {
  if (typeof value !== 'string' || [...value.trim()].length < min || [...value].length > max)
    throw new AppError('INVALID_INPUT', `${name}需要 ${min}—${max} 个字符。`);
  return value;
}
export function anchor(text, quote, preferred) {
  bounded(quote, 1, 10000, '原句');
  let start = preferred;
  if (!Number.isInteger(start)) {
    start = text.indexOf(quote);
    if (start >= 0 && text.indexOf(quote, start + 1) >= 0)
      throw new AppError('INVALID_ANCHOR', '原句重复，需要准确位置。');
  }
  if (start < 0 || text.slice(start, start + quote.length) !== quote)
    throw new AppError('INVALID_ANCHOR', '无法在原稿中定位这句话，请重新检查。');
  return { start, end: start + quote.length, quote, anchorHash: hash(quote) };
}
export function checkDraft(text, limit = 1) {
  const items = [];
  for (const match of text.matchAll(/[^。！？\n]+[。！？]?/g)) {
    const quote = match[0];
    if (/不能|并非|未必|不一定|不是|是否|[？?“”「」"]/.test(quote)) continue;
    if (!/一定|必然|必定|所有人|任何人|唯一|百分之百/.test(quote)) continue;
    items.push({id:id(), ...anchor(text, quote, match.index), kind:'scope',
      reason:'这里使用了范围很强的表述。可以先检查：现有依据是否覆盖了这些对象与条件？',
      phase:'preliminary', engine:'local_rules', status:'open'});
    if (items.length >= limit) break;
  }
  return items;
}
export function validateFindings(data, text, limit) {
  if (!data || !Array.isArray(data.items) || data.items.length > limit)
    throw new AppError('INVALID_MODEL_OUTPUT', '检查结果格式无效。', 502);
  return data.items.map(item => ({id:id(), ...anchor(text, item.quote, item.start),
    kind: bounded(item.kind,1,60), reason: bounded(item.reason,1,700),
    phase:'preliminary', engine:'model', status:'open'}));
}
export function validateSuggestion(data, sources) {
  const text = bounded(data?.text, 1, 12000, '候选文本');
  const reason = bounded(data?.reason, 1, 1200, '修改理由');
  const sourceIds = data?.sourceIds;
  if (!Array.isArray(sourceIds) || sourceIds.some(x => typeof x !== 'string' || !sources.some(s => s.id === x)))
    throw new AppError('INVALID_CITATION', '候选稿包含无法回溯的来源。', 502);
  // IDs are supplied separately; model-created hyperlinks are never accepted.
  if (/https?:\/\//i.test(text)) throw new AppError('INVALID_CITATION', '候选稿包含未经核对的链接。', 502);
  return {text,reason,sourceIds:[...new Set(sourceIds)]};
}
export function applySuggestion(project, suggestion) {
  if (project.revision !== suggestion.baseRevision)
    throw new AppError('REVISION_CONFLICT', '原稿版本已变化，请重新生成修改建议。', 409);
  const a = anchor(project.text, suggestion.quote, suggestion.start);
  if (a.end !== suggestion.end) throw new AppError('INVALID_ANCHOR','原句位置已变化。',409);
  return project.text.slice(0,a.start) + suggestion.text + project.text.slice(a.end);
}
export function safeUrl(value) {
  try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) ? url.href : null; } catch {return null;}
}
