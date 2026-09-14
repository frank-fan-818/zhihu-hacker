import { createHash, randomUUID } from 'node:crypto';
import { SEVERITIES, IMPACTS, DIRECTIONS, VAGUE_REASONS } from './review-prompt.mjs';
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
// 词表分两类，因为两类词在真实语料里的表现完全不同（来自 901 句知乎真实语料的测试）：
//   具体物品：出现在论断里多半是错配或打比方，单次命中就值得交还给作者。
//   领域/活动：本身就是常见话题（“跨考”“编程”“算法”），单独出现几乎总是正常表达，
//   只有跟另一个范畴同时出现时才算错配——否则会把“如果你不喜欢编程”这类正常句子报成问题。
const CONCRETE_TERMS = [
  ['食物', /意大利面|面条|米饭|饺子|火锅|粥|咖啡|茶叶|啤酒|酱油|辣椒|蛋糕/],
  ['建筑材料', /混凝土|水泥|钢筋|砂浆|沥青|砖块|瓷砖|木板|涂料/],
  ['体育用品', /足球|篮球|排球|乒乓球|羽毛球|球拍|球门|哑铃|跳绳/],
  ['乐器', /钢琴|小提琴|吉他|二胡|古筝|长笛|架子鼓|萨克斯/],
  ['动植物', /玫瑰|牡丹|松树|竹子|猫粮|狗粮|宠物|盆栽/],
  ['家居', /沙发|衣柜|床垫|窗帘|冰箱|洗衣机|空调/],
  ['交通工具', /自行车|摩托车|拖拉机|地铁|高铁|飞机|轮船/],
];
const DOMAIN_TERMS = [
  ['编程', /编程|代码|算法|数据库|服务器|编译器|开源/],
  ['学术', /考研|读研|论文|学历|文凭|考公/],
  ['医疗', /药物|疫苗|手术|临床|诊断/],
  ['法律', /判决|立法|条款|合规/],
];
// 标准比率单位（能量密度、单价）不是错配：125 瓦时每公斤是正常写法。
const RATIO_UNIT = /每\s*(公斤|千克|克|升|毫升|人|天|月|年|小时|分钟|公里|千米|米|瓦|度)|瓦时|千瓦时/;
const MEASURE = /([0-9０-９]+|[一二三四五六七八九十百千万两]+)\s*(米|厘米|毫米|公里|千米|吨|公斤|千克|克|升|毫升|赫兹|分贝|伏|瓦|安)/;
// 能被这些单位正常度量的对象，只用来减少误报。
// 单字词（长/重/袋…）整句匹配会误伤“提高”“大约”这类词，所以只在数量前后的小窗口里算数。
const MEASURABLE = /长|宽|高|厚|深|重|距离|长度|高度|宽度|面积|体积|重量|质量|容量|水量|水位|路程|车速|温度|能耗|网线|管道|绳子|布料|纸张|钢铁|水泥|沙子|粮食|水果|蔬菜|材料|货物|行李|桌子|椅子|床|门|窗|墙|房间|跑道|线缆|电线|水管|木板|钢板|袋|箱/;
// “需要数量或单位靠近才作数”的附近词：只在数量前后 6 个字的窗口里判断。
const MEASURABLE_NEARBY = /长|宽|高|厚|深|重|距离|长度|高度|宽度|面积|体积|重量|质量|容量|水量|水位|路程|车速|温度|能耗|网线|管道|绳子|布料|纸张|桌|椅|床|门|窗|墙|房间|跑道|线缆|电线|水管|木板|钢板|袋|箱/;
// 这些词本身可以按物理量度量（效率、成本、增长都能是数字），不参与单位错配判断。
const ABSTRACT = /问题|方案|观点|结论|方法|理论|概念|趋势|因素|价值|意义|逻辑|机制|策略|思路|效果|转化|体验|口碑|影响力|竞争力/;
const AS_PREDICATE = /[是叫称属等]|就是|算是|作为|该|应当|应该/;
// 具体物件被当成手段/原因去产生抽象结果，例如“加一张沙发就能提高转化率”。
// 这类句子多半是打比方被写成了因果，值得作者自己确认一次。
const CONCRETE_ACTION = /(加|放|换|装|买|搬|拌|配|涂|刷|贴|挂|插|拧|焊|煮|裁)\S{0,8}(就|便|才|能|会|可以|使得|导致)/;

// 强范围词里有一批是真信号，另一批是固定搭配里的“虚词”，后者报出来就是噪音：
// “一定的年纪”“一定要算账”“有一定程度的开放”都不是范围断言。
// 另外两类要单独处理（都来自 901 句真实语料的误报）：
//   “绝对”常被当作程度副词（绝对顶级、绝对优势），只有“绝对+动词”才是范围断言；
//   “全部”若是修饰名词（全部去办公室的人、专利全部过期），也不是范围断言。
const SCOPE_IDIOMS = /一定的|一定程度|一定要|必要性|必然性|必然趋势|唯一性|唯一办法|唯一出路|唯一选择|不一定|未必|任何人都知道|所有人都知道/;
const SCOPE_WORDS = [
  ['百分之百', q => true],
  ['必然', q => true],
  ['必定', q => true],
  ['所有人', q => true],
  ['任何人', q => true],
  ['唯一', q => true],
  ['从来', q => true],
  ['从不', q => true],
  ['无一例外', q => true],
  ['普遍认为', q => true],
  ['全都', q => true],
  ['绝对', q => !/绝对(顶级|优势|领先|第一|多数|核心|重要|正确|错误|值|好|差)/.test(q)],
  ['全部', q => !/全部[\u4e00-\u9fa5]{0,4}的/.test(q)],
];
function scopeSignal(quote) {
  if (SCOPE_IDIOMS.test(quote)) return null;
  if (/一定/.test(quote)) {
    if (/一定(会|能|要|是|得|让|使|造成|导致|出现|发生|存在|超过|高于|低于|达到|变成)/.test(quote)) return '一定';
    return null;
  }
  for (const [word, ok] of SCOPE_WORDS) if (quote.includes(word) && ok(quote)) return word;
  return null;
}
function concreteTerms(quote) {
  return CONCRETE_TERMS.filter(([, pattern]) => pattern.test(quote)).map(([label]) => label);
}
function domainTerms(quote) {
  return DOMAIN_TERMS.filter(([, pattern]) => pattern.test(quote)).map(([label]) => label);
}
// 本地规则只做“结构性疑点”筛查：领域错配、单位错配、抽象与具体混用。
// 严重度按“缺了这一环，结论还站不站得住”判定：错配通常直接推翻句子本身，抽象混用多半只是可信度问题。
// 返回 null 表示这一族规则没有线索（不等于表达已经通过检查）。
function mismatchFinding(quote) {
  const measure = MEASURE.exec(quote);
  if (measure && ABSTRACT.test(quote) && !RATIO_UNIT.test(quote)) {
    // 整句在谈可度量的对象，或数量附近 6 个字就在量具体东西，都算正常用法：
    // 只有“拿长度/重量单位去量抽象概念”才交还给作者确认。
    const from = Math.max(0, measure.index - 6), to = Math.min(quote.length, measure.index + measure[0].length + 6);
    const nearby = MEASURABLE_NEARBY.test(quote.slice(from, to));
    if (!nearby && !MEASURABLE.test(quote)) return {kind:'数量与单位错配', severity:'关键', impact:'影响核心结论', direction:'补充依据',
      reason:`这句话用「${measure[0]}」去度量一个抽象对象。可以检查：这里得到的是可测量的量，还是一个比喻？`};
  }
  const concrete = concreteTerms(quote);
  const domains = domainTerms(quote);
  const terms = [...concrete, ...domains];
  if (terms.length >= 2) return {kind:'概念错配', severity:'关键', impact:'影响核心结论', direction:'收窄范围',
    reason:`这句话把「${terms.join('」「')}」放进同一个论断里。可以检查：这些对象属于同一范畴吗，这句话是在讲事实，还是在打比方或开玩笑？`};
  if (concrete.length === 1 && ABSTRACT.test(quote) && AS_PREDICATE.test(quote)) return {kind:'概念错配', severity:'关键', impact:'影响核心结论', direction:'收窄范围',
    reason:`这句话把抽象概念和「${concrete[0]}」这类具体对象直接等同。可以检查：这是严谨的定义，还是一个比喻？`};
  if (concrete.length === 1 && ABSTRACT.test(quote) && CONCRETE_ACTION.test(quote)) return {kind:'抽象与具体混用', severity:'中等', impact:'影响可信度', direction:'补充条件',
    reason:`这句话让「${concrete[0]}」这类具体物件去产生抽象结果。可以检查：这里是不是把打比方当成了可执行的因果？`};
  return null;
}
export function checkDraft(text, limit = 1) {
  const items = [];
  for (const match of text.matchAll(/[^。！？\n]+[。！？]?/g)) {
    const quote = match[0];
    if ([...quote.trim()].length < 6 || /^[？?]/.test(quote.trim())) continue;
    // 引号里的转述和疑问句是我们自己都不主张的内容，不在这里判它。
    if (/[？?“”「」"]/.test(quote)) continue;
    const mismatch = mismatchFinding(quote);
    if (mismatch) {
      items.push({id:id(), ...anchor(text, quote, match.index), ...mismatch,
        phase:'preliminary', engine:'local_rules', status:'open'});
    } else {
      // 强断言这一族沿用原有豁免：明确的否定与转述常常是作者已经在限定自己。
      if (/不能|并非|未必|不是|是否/.test(quote)) continue;
      const signal = scopeSignal(quote);
      if (!signal) continue;
      items.push({id:id(), ...anchor(text, quote, match.index), kind:'以偏概全', severity:'中等', impact:'影响可信度', direction:'补充条件',
        reason:`这里出现了范围很强的表述「${signal}」。可以先检查：现有依据是否覆盖了这些对象与条件？`,
        phase:'preliminary', engine:'local_rules', status:'open'});
    }
    if (items.length >= limit) break;
  }
  return items;
}
export function validateFindings(data, text, limit) {
  if (!data || !Array.isArray(data.items) || data.items.length > limit)
    throw new AppError('INVALID_MODEL_OUTPUT', '检查结果格式无效。', 502);
  return data.items.map(item => {
    const reason = bounded(item.reason, 1, 700);
    // 审稿意见要能被接受，就必须说清缺的是哪一环；空话不是理由，直接当作没有给出原因。
    // 这里不做语义判断，只挡掉明确列出的空话与过短的敷衍。
    if ([...reason.trim()].length < 12 || VAGUE_REASONS.some(v => reason.includes(v)))
      throw new AppError('INVALID_MODEL_OUTPUT', '检查理由过于空泛，未给出具体缺口。', 502);
    return {id:id(), ...anchor(text, item.quote, item.start), kind: bounded(item.kind,1,60), reason,
      // 三档严重度、影响面与修改方向都是可选补充：模型没给就不编，给了就越不出白名单。
      ...(SEVERITIES.includes(item.severity)?{severity:item.severity}:{}),
      ...(IMPACTS.includes(item.impact)?{impact:item.impact}:{}),
      ...(DIRECTIONS.includes(item.direction)?{direction:item.direction}:{}),
      phase:'preliminary', engine:'model', status:'open'};
  });
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
// 作者从地址栏复制的链接常常带着这些尾巴：站内追踪参数、锚点、回答页路径、移动端域名。
// 它们不影响「这是哪个问题」，所以解析时直接丢掉，而不是让用户自己去删。
function questionId(segment) {
  const digits = String(segment ?? '').replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 20) return null;
  try { return BigInt(digits) > 0n ? digits : null; } catch { return null; }
}
const NOT_A_QUESTION = '没有识别出知乎问题编号。请粘贴形如 https://www.zhihu.com/question/1234567890 的链接，或直接输入问题编号。';
// 只认知乎自己的域名：从别的站点取一个数字拼成知乎链接属于「猜」，猜错会静默关联到一条不相干的问题。
// 粘贴「链接」和点选「问题标题」走同一个入口，所以这里比平台返回的规整 URL 宽松：
// 移动端域名、http、裸数字、带追踪参数或 /answer/123 后缀，都指向同一个问题。
export function questionLink(value) {
  const raw = String(value ?? '').trim().replace(/[\u200b-\u200d\ufeff\s]+/g, '');
  if (!raw) throw new AppError('INVALID_INPUT', '请粘贴知乎问题链接，例如 https://www.zhihu.com/question/1234567890');
  if (/^\d+$/.test(raw)) { const id = questionId(raw); if (id) return { url: `https://www.zhihu.com/question/${id}`, id, title: '' }; throw new AppError('INVALID_INPUT', NOT_A_QUESTION); }
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw new AppError('INVALID_INPUT', '这看起来不是一个链接。可以粘贴知乎问题页的地址，或直接输入问题编号。'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError('INVALID_INPUT', '只接受 http 或 https 链接。');
  if (url.username || url.password) throw new AppError('INVALID_INPUT', NOT_A_QUESTION);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const typeIn = /^\d+$/.test(url.hostname);
  if (!['zhihu.com', 'm.zhihu.com'].includes(host) && !typeIn) throw new AppError('INVALID_INPUT', NOT_A_QUESTION);
  const path = url.pathname.split('/').filter(Boolean);
  const at = path.indexOf('question');
  const id = at >= 0 ? questionId(path[at + 1]) : (host === 'zhihu.com' || host === 'm.zhihu.com' ? questionId(url.searchParams.get('q') ?? '') : null);
  if (id) return { url: `https://www.zhihu.com/question/${id}`, id, title: '' };
  throw new AppError('INVALID_INPUT', NOT_A_QUESTION);
}
