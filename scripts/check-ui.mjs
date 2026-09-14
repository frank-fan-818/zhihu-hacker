// 静态完整性检查：不依赖浏览器，把「界面与前端逻辑是否对得上」固定成可重复执行的检查。
// 背景：这类问题在沙箱里无法用真实浏览器验收，所以至少要能挡住这些确定性错误——
//   1. app.js 引用了 index.html 里不存在的 id
//   2. 在加载时就给「运行期才生成的按钮」绑定事件（曾经真的写错过一次：$('#retry-topic')）
//   3. 中文被编码事故破坏（U+FFFD / C1 控制符 / 常用字占比异常）
// 用法：npm run check:ui
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');
const html = read('public/index.html');
const js = read('public/app.js');
const css = read('public/style.css');

const problems = [];
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const jsIds = new Set([...js.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)].map(m => m[1]));

// 1. id 必须对得上
for (const id of jsIds) if (!htmlIds.has(id)) problems.push(`app.js 引用了 index.html 里不存在的 #${id}`);

// 2. 加载时绑定的事件只能挂在静态元素上：动态按钮必须走事件委托
for (const m of js.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)\s*\??\.\s*addEventListener/g)) {
  if (!htmlIds.has(m[1])) problems.push(`#${m[1]} 只在运行期生成，却在加载时绑定事件，应改用事件委托`);
}

// 3. CSS 里用的自定义属性必须都在 :root 定义
const defined = new Set([...css.matchAll(/--([a-z-]+)\s*:/g)].map(m => m[1]));
for (const m of css.matchAll(/var\(--([a-z-]+)\)/g)) if (!defined.has(m[1])) problems.push(`style.css 使用了未定义的变量 --${m[1]}`);

// 4. 两个问题入口与工作台的关联点必须同时在 HTML 里（避免改了一处忘另一处）
for (const id of ['topic', 'find-questions', 'question-link', 'use-question-link', 'question-results', 'draft', 'check'])
  if (!htmlIds.has(id)) problems.push(`首页缺少必需元素 #${id}`);

// 5. 编码哨兵
const MOJIBAKE = /\uFFFD|[\u0080-\u009F]|[\u9389\u95c9\u93b9\u9568\u93a4\u6d2b\u5bf0\u93b4\u6d5c\u9563\u7eef\u7f38\u93ac\u93c1\u9359\u93c8\u93b0\u93ae\u93b5\u93a9]/;
for (const f of ['public/index.html', 'public/app.js', 'public/style.css', 'src/domain.mjs', 'src/providers.mjs', 'src/server.mjs', 'README.md']) {
  const text = read(f);
  if (MOJIBAKE.test(text)) problems.push(`${f} 疑似编码损坏（发现替换字符、控制符或乱码字）`);
  const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
  if (cjk.length > 50) {
    const common = cjk.filter(ch => ch.codePointAt(0) < 0x9FA6).length / cjk.length;
    if (common < 0.9) problems.push(`${f} 常用字占比只有 ${common.toFixed(3)}，疑似编码损坏`);
  }
}

if (problems.length) {
  console.error('静态检查发现 %d 个问题：', problems.length);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`静态检查通过：${jsIds.size} 个 id 引用、${defined.size} 个 CSS 变量、7 个文件编码正常。`);
