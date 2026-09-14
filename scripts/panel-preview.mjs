// 手动验证脚本：把 public/app.js 放进最小 DOM 夹具里渲染，检查引导面板各状态的真实输出。
// 只读，不联网，不写入，不启动服务。
// 用途：改完审稿面板的文案 / 步骤 / 分支后，直接读“用户此刻看到的字是什么”，
// 不必依赖浏览器截图；交互契约由 test/audit-release.test.mjs 固定。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .replace('init().catch(fail);', '/* preview: init driven by fixture */');

const elements = new Map();
const element = selector => {
  if (!elements.has(selector)) elements.set(selector, {
    value: '', textContent: '', innerHTML: '', hidden: false, scrollTop: 0, dataset: {},
    addEventListener() {}, insertAdjacentHTML() {}, focus() {}, setSelectionRange() {}, scrollIntoView() {},
    click() { return this.onclick?.(); },
  });
  return elements.get(selector);
};
const context = vm.createContext({
  document: { querySelector: element, addEventListener() {} },
  window: { addEventListener() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout: () => 1, clearTimeout() {}, setInterval() {},
  confirm: () => true, crypto: { randomUUID: () => 'fixture-key' },
  location: { assign() {}, href: 'https://fixture.invalid/' },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
});
vm.runInContext(source, context);

const draftText = [
  '远程办公这件事，我自己试了半年。',
  '远程办公一定能提高所有人的工作效率。',
  '通勤时间变少是一个好处，但我还想了解不同任务类型和团队沟通的影响。',
].join('\n');
const finding = { id: 'f1', quote: '远程办公一定能提高所有人的工作效率。', kind: '以偏概全', severity: '中等', impact: '影响可信度', direction: '补充条件', reason: '这句话把“所有人”当成了结论的适用范围，但你举的是个人半年的体验，读者会追问这半年的样本覆盖了哪些任务类型。', start: draftText.indexOf('远程办公一定能'), status: 'open', baseRevision: 1 };
const project = { id: 'p1', revision: 1, text: draftText, updated: 0, question: null, findings: [finding], suggestions: [], history: [], sources: [], verification: {}, lastCheck: { engine: 'model', revision: 1, at: new Date().toISOString() } };

const set = (patch, extra = '') => vm.runInContext(
  `project=${JSON.stringify({ ...project, ...patch })};selected=null;error='';${extra}draft.value=project.text;render();`,
  context,
);
const label = title => `\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`;
const textOf = html => html
  .replace(/<button[^>]*>/g, '\n  [按钮] ').replace(/<\/button>/g, '')
  .replace(/<li[^>]*>/g, '\n· ').replace(/<br>/g, '\n')
  .replace(/<(b|h3|blockquote|p|div|details|summary|span|ol)[^>]*>/g, '\n')
  .replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n')
  .replace(/[ \t]+\n/g, '\n').trim();

const panel = () => textOf(element('#review-content').innerHTML);
const marks = () => (element('#draft-highlight').innerHTML.match(/<mark>/g) || []).length;
const diffs = () => (element('#review-content').innerHTML.match(/<div class="diffbox">.*?<\/div>/s) || ['(无)'])[0];

console.log(label('① 初筛完成，还没查依据（唯一主动作：查这一句的依据）'));
set({}, 'choice=null;decided=false;');
console.log(panel());
console.log(`\n[原稿高亮] <mark> 数量 = ${marks()}（应 ≥1；定位必须真的发生）`);

console.log(label('② 点「先不看依据，直接改」：先看到改前→改后的差别'));
vm.runInContext('choice="rewrite";decided=false;render();', context);
console.log(panel());
console.log(`\n[差异标记 HTML] ${diffs()}`);

console.log(label('③ 已查依据，拿到真实材料'));
const verification = { f1: { baseRevision: 1, time: Date.now(), sourceIds: [], errors: [], summary: '检索到 3 条相关讨论，主要集中在任务类型的差异；没有任何来源支持「所有人」。' } };
set({ verification }, 'choice=null;decided=false;');
console.log(panel());

console.log(label('④ 已生成候选句：原句 / 候选句 / 字符级差异'));
set({ suggestions: [{ id: 's1', findingId: 'f1', quote: finding.quote, text: '远程办公是否能提高效率，可能取决于任务类型和团队沟通方式。', reason: '把「所有人」的范围收回到「取决于任务类型」，并去掉未经支持的因果。', wordingOnly: false, baseRevision: 1, applied: false }] }, 'choice=null;decided=false;');
console.log(panel());

console.log(label('⑤ 已采用：成果感 + 接下来做什么'));
set({ revision: 2, text: draftText.replace(finding.quote, '远程办公是否能提高效率，可能取决于任务类型和团队沟通方式。'), history: [{ text: draftText, revision: 1, appliedAt: new Date().toISOString(), suggestion: 's1', reason: '收窄范围' }], suggestions: [{ id: 's1', findingId: 'f1', quote: finding.quote, text: '远程办公是否能提高效率，可能取决于任务类型和团队沟通方式。', reason: '收窄范围', wordingOnly: false, baseRevision: 1, applied: true }] }, 'choice=null;decided=true;');
console.log(panel());
console.log(`\n[原稿高亮] <mark> 数量 = ${marks()}（采用后原句已被替换，应为 0）`);

console.log(label('⑥ 兜底：本次初筛没有需要立刻处理的项'));
set({ findings: [] }, 'choice=null;decided=false;');
console.log(panel());

console.log(label('⑦ 兜底：原稿已改，检查过期'));
set({ revision: 9 }, 'choice=null;decided=false;');
console.log(panel());

console.log(label('⑧ 兜底：本地规则初筛（无模型）'));
set({ lastCheck: { engine: 'local_rules', revision: 1, at: new Date().toISOString() } }, 'choice=null;decided=false;');
console.log(element('#review-content').innerHTML.slice(0, 260));

console.log(label('⑨ 模型配了却没跑成：必须说清这次是谁看的稿'));
set({ findings: [], lastCheck: { engine: 'local_rules', revision: 1, at: new Date().toISOString(), note: '模型未能完成这次检查（模型服务请求失败（HTTP 401）。），本次结果来自本地规则初筛，只覆盖部分结构与概念错配。' } }, 'choice=null;decided=false;');
console.log(panel());
