// 校验文档里的相对路径引用能否解析到存在的文件。
//
//   node scripts/verify-doc-links.mjs
//
// 引用分三类，只有第一类必须解析成功：
//   文档相对（可点击）—— 相对当前文档，点击应能打开
//   仓库相对（正文语境）—— 相对仓库根，常见于描述"某个文件在哪里"
//   外部包内路径   —— 例如官方 skill 压缩包里的 references/*.md，不属于本仓库
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { repoRoot } from './_shared.mjs';

const REPO = repoRoot();
const DOCS = join(REPO, 'docs', 'plans');
const files = readdirSync(DOCS).filter(f => f.endsWith('.md'));
console.log(`检查 ${files.length} 个文档\n`);

const report = { docRelative: 0, repoRelative: 0, external: 0, broken: 0 };
for (const f of files) {
  const full = join(DOCS, f);
  const text = readFileSync(full, 'utf8');
  const refs = [...new Set([...text.matchAll(/`([^`\s]*\/[^`\s]*\.(?:md|mjs|js|json|sql|html|css))`/g)].map(m => m[1]))];
  if (!refs.length) continue;
  console.log(`${f}`);
  for (const ref of refs) {
    const asDoc = resolve(dirname(full), ref);
    const asRepo = resolve(REPO, ref);
    if (existsSync(asDoc)) {
      report.docRelative++;
      console.log(`  ✅ 文档相对  ${ref}  ->  ${asDoc.replace(REPO + '\\', '')}`);
    } else if (existsSync(asRepo)) {
      report.repoRelative++;
      console.log(`  ◐  仓库相对  ${ref}  ->  ${asRepo.replace(REPO + '\\', '')}   （正文语境，不可点击）`);
    } else if (/[*]/.test(ref)) {
      report.external++;
      console.log(`  ◐  含通配符  ${ref}   （描述性引用）`);
    } else if (/^(zhihu|references)\//.test(ref)) {
      report.external++;
      console.log(`  ◐  外部包内  ${ref}   （官方 skill 压缩包内部路径，不属于本仓库）`);
    } else {
      report.broken++;
      console.log(`  ❌ 无法解析  ${ref}`);
    }
  }
}
console.log(`\n文档相对（可点击） ${report.docRelative}   仓库相对 ${report.repoRelative}   描述性/外部 ${report.external}   真实失效 ${report.broken}`);
process.exit(report.broken === 0 ? 0 : 1);
