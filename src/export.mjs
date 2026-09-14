import { safeUrl } from './domain.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const date = value => value ? new Date(value).toISOString().slice(0, 10) : '未知日期';

export function exportDocument(project, format = 'markdown') {
  const sources = Array.isArray(project.sources) ? project.sources : [];
  const findings = Array.isArray(project.findings) ? project.findings : [];
  const verification = project.verification && typeof project.verification === 'object' ? project.verification : {};
  const sourceNo = new Map(sources.map((source, index) => [source.id, index + 1]));
  const evidence = findings.map(finding => {
    const check = verification[finding.id];
    const refs = (check?.sourceIds || []).map(sourceId => sourceNo.get(sourceId)).filter(Boolean);
    return { quote: finding.quote, reason: finding.reason, status: finding.status || 'open', refs };
  });
  const clean = {
    schemaVersion: project.schemaVersion || 1,
    id: project.id,
    title: project.title,
    text: project.text,
    original: project.original,
    revision: project.revision,
    version: project.version,
    question: project.question || null,
    findings: evidence,
    sources: sources.map((source, index) => ({
      number: index + 1, id: source.id, provider: source.provider, title: source.title,
      url: safeUrl(source.url), author: source.author || '', text: source.text || '',
      relation: source.relation || 'unreviewed', evidenceType: source.evidenceType || 'search_snippet',
      retrievedAt: source.retrievedAt || null, contentHash: source.contentHash || null,
    })),
    exportedAt: new Date().toISOString(),
  };
  if (format === 'json') return { body: JSON.stringify(clean, null, 2), contentType: 'application/json; charset=utf-8', extension: 'json' };
  const lines = [clean.title ? `# ${clean.title}` : '# 我的修订稿', '', clean.text, '', '## 逐句检查与依据', ''];
  if (!evidence.length) lines.push('尚未完成检查。');
  else for (const item of evidence) lines.push(`- ${item.quote}：${item.reason}${item.refs.length ? `（依据：${item.refs.map(number => `[${number}]`).join('')}）` : '（尚未关联依据）'}`);
  lines.push('', '## 研究资料（检索摘要，非逐句核验声明）', '');
  if (!clean.sources.length) lines.push('尚未检索外部资料。');
  else for (const source of clean.sources) lines.push(`[${source.number}] ${source.title} — ${source.url}\n    ${source.provider} · ${source.evidenceType} · ${date(source.retrievedAt)}\n    ${source.text.replace(/\s+/g, ' ').trim()}`);
  lines.push('', '> 导出内容由认知调试器整理；搜索摘要不等于原文或事实认证。');
  if (format === 'html') {
    const html = `<!doctype html><meta charset="utf-8"><title>${esc(clean.title || '我的修订稿')}</title><article><h1>${esc(clean.title || '我的修订稿')}</h1><p class="draft">${esc(clean.text).replace(/\n/g, '<br>')}</p><h2>逐句检查与依据</h2><ul>${evidence.map(item => `<li><strong>${esc(item.quote)}</strong>：${esc(item.reason)}${item.refs.length ? `（依据：${item.refs.map(number => `[${number}]`).join('')}）` : '（尚未关联依据）'}</li>`).join('') || '<li>尚未完成检查。</li>'}</ul><h2>研究资料</h2><ol>${clean.sources.map(source => `<li><a rel="noopener noreferrer" href="${esc(source.url)}">${esc(source.title)}</a><div>${esc(source.provider)} · ${esc(source.evidenceType)} · ${date(source.retrievedAt)}</div><p>${esc(source.text)}</p></li>`).join('') || '<li>尚未检索外部资料。</li>'}</ol><small>搜索摘要不等于原文或事实认证。</small></article>`;
    return { body: html, contentType: 'text/html; charset=utf-8', extension: 'html' };
  }
  return { body: lines.join('\n'), contentType: 'text/markdown; charset=utf-8', extension: 'md' };
}
