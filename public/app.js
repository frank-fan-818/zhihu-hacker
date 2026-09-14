const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// 差异展示：只用来给用户看改动，不参与任何服务端判断。
// 取最长公共子串之后，只保留长度 ≥2 的匹配段重新标注——
// 这样「工作效率。」里那个碰巧相同的「效」不会被当成未改动部分，整句读起来才像人话。
const MIN_MATCH=2;
function charMatch(a,b){
  const n=a.length,m=b.length;
  const d=Array.from({length:n+1},()=>new Uint16Array(m+1));
  for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)d[i][j]=a[i]===b[j]?d[i+1][j+1]+1:Math.max(d[i+1][j],d[i][j+1]);
  const out=new Uint8Array(n);
  let i=0,j=0;
  while(i<n&&j<m){
    if(a[i]===b[j]){out[i]=1;i++;j++;}
    else if(d[i+1][j]>=d[i][j+1])i++;
    else j++;
  }
  for(let s=0;s<n;){if(!out[s]){s++;continue;}let e=s;while(e<n&&out[e])e++;if(e-s<MIN_MATCH)for(let k=s;k<e;k++)out[k]=0;s=e;}
  return out;
}
function diff(oldText,newText){
  const a=[...String(oldText)],b=[...String(newText)],n=a.length,m=b.length;
  if(oldText===newText)return esc(newText);
  if(n*m>250000)return `<del class="del">${esc(oldText)}</del><ins class="ins">${esc(newText)}</ins>`;
  const keep=charMatch(a,b);
  let i=0,j=0,out='';
  const flush=list=>{if(!list.length)return;out+=`<del class="del">${esc(list.join(''))}</del>`;};
  while(j<m){
    if(i<n&&keep[i]&&a[i]===b[j]){out+=esc(a[i]);i++;j++;continue;}
    let buf=[];
    buf.push(b[j++]);
    while(j<m&&!(i<n&&keep[i]&&a[i]===b[j]))buf.push(b[j++]);
    out+=`<ins class="ins">${esc(buf.join(''))}</ins>`;
  }
  flush(a.slice(i));
  return out;
}
// 「仅调整表述」的本地候选：与 src/service.mjs 的本地规则保持同一口径的预览。
// 它只在采用前的面板里做示意，不是服务端结果，也不代表已核对事实。
function localPreview(finding){
  const raw=String(finding?.quote||'').trim().replace(/\s+/g,' ');
  if(!raw)return '';
  let text=raw.replace(/一定|必然|必定/g,'是否').replace(/[。！!？?……、，,；;：:\s]+$/,'');
  if(!text.includes('是否'))text=`是否可以说：${text}`;
  return `${text}？`;
}
let project=null, selected=null, operation=null, dirty=false, saving=null, timer, error='', status={};
// 引导式面板的本地状态：用户此刻选择的做法、本句是否已经改好。
let choice=null, decided=false;
const draft=$('#draft');
let questionContext=null,questionChoices=[],account=null,oauthConfigured=false,extraBusy=false;
// 本机先解析一遍链接：格式不对就不必发请求，也不该先把草稿存成一个错的项目上下文。
// 服务端仍会用同一套规则再校验一次，这里只是把错误提前到输入框旁边。
function localQuestionLink(value){
  const raw=String(value??'').trim().replace(/[\u200b-\u200d\ufeff\s]+/g,'');
  if(!raw)return null;
  if(/^\d+$/.test(raw))return raw.length>=5&&raw.length<=20?`https://www.zhihu.com/question/${raw}`:null;
  let url;try{url=new URL(/^https?:\/\//i.test(raw)?raw:`https://${raw}`);}catch{return null;}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;
  const path=url.pathname.split('/').filter(Boolean),at=path.indexOf('question');
  const digits=(at>=0?path[at+1]:'').replace(/\D/g,'');
  return digits.length>=5&&digits.length<=20?`https://www.zhihu.com/question/${digits}`:null;
}
// 「围绕这题写」和「粘贴链接」共用同一段起稿文字：服务端要求草稿 20—10000 字符，
// 所以「只贴了一个链接、还没动笔」这个最常见的入口不能送空文本，否则直接被拒。
function questionScaffold(title){
  const name=String(title||'').trim();
  const subject=name&&name.length<=60?`“${name}”`:'这个问题';
  return `关于${subject}，我的初步看法是：\n\n我希望先弄清楚相关事实与适用条件，再形成自己的观点。`;
}
function questionLabel(q){return q?.title||(q?.url&&/\/(\d+)$/.test(q.url)?`知乎问题 ${q.url.replace(/^.*\//,'')}`:'知乎问题');}

async function api(path,method='GET',body){
  const r=await fetch(`/api${path}`,{method,headers:method==='GET'?{}:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body||{})});
  const data=await r.json();if(!r.ok){const e=new Error(data.error?.message||'请求没有完成。');e.code=data.error?.code;throw e;}return data;
}
function notice(message){$('#notice').textContent=message;$('#notice').hidden=false;clearTimeout(notice.timer);notice.timer=setTimeout(()=>$('#notice').hidden=true,6500);}
function count(){const length=[...draft.value].length;$('#count').textContent=`${length.toLocaleString()} / 10,000 字符`;$('#check').disabled=Boolean(operation)||length<20||length>10000;}
function button(action,text,primary=false,extra=''){return `<button class="${primary?'primary':'quiet'}" data-action="${action}" ${extra}>${text}</button>`;}
// 让「定位」真的发生：在用户自己的原稿里高亮这一句，并把光标与视口带过去。
function highlight(quote,select=false){
  const layer=$('#draft-highlight');
  // 选区常带一个尾随换行；高亮层若把它也包进 mark，行数会与 textarea 不一致而错位。
  const text=String(quote||'').replace(/\n+$/,'');
  const from=text?draft.value.indexOf(text):-1;
  if(layer)layer.innerHTML=from<0?'':esc(draft.value.slice(0,from))+`<mark>${esc(text)}</mark>`+esc(draft.value.slice(from+text.length));
  if(from<0)return;
  const lineHeight=32, pad=10;
  draft.scrollTop=Math.max(0,draft.value.slice(0,from).split('\n').length*lineHeight-96);
  if(!select)return;
  if(typeof draft.focus!=='function'||typeof draft.setSelectionRange!=='function')return;
  draft.focus();draft.setSelectionRange(from,from+text.length);
  if(typeof draft.scrollIntoView==='function'){try{draft.scrollIntoView({block:'center',behavior:'smooth'});}catch{/* 无布局环境忽略 */}}
}
// 面板顶部永远回答三个问题：这是第几步、现在该做什么、做完会得到什么。
function stepRail(active,done){
  const steps=[['查看依据','用真实材料判断该不该改'],['改这一句','只动这一句，你自己决定'],['留下修改','可保存、可撤销']];
  return `<ol class="rail">${steps.map((s,i)=>{
    const n=i+1,state=done[i]?'done':(n===active?'active':'');
    return `<li class="${state}"><b>${done[i]?'✓':n}</b><span>${esc(s[0])}<i>${esc(state==='active'?s[1]:'')}</i></span></li>`;
  }).join('')}</ol>`;
}
function renderReview(){
  const review=$('#review-content');
  if(operation){
    review.innerHTML=`<div class="progress"><p class="eyebrow">一次只把一件事想清楚</p><h3>${esc(operation.stage)}</h3><div class="progress-bar"></div><p class="fine">原稿已保存。刷新页面后可以恢复任务状态。</p>${button('cancel','取消本次操作')}</div>`;
    highlight('');return;
  }
  const findings=project?.findings||[];
  const f=findings.find(x=>x.id===selected)||findings[0];selected=f?.id;
  const latest=project?.suggestions.at(-1);
  const errorHtml=error?`<p class="error" role="alert">${esc(error)}</p>`:'';
  if(!project?.lastCheck){
    highlight('');
    review.innerHTML=`${errorHtml}<div class="empty"><span class="empty-symbol">〞</span><h3>先从你的一句话开始。</h3><p>不急着重写全文。找到一处值得注意的地方，看看依据，再决定怎么改。</p><ol><li><b>01</b>定位原句，理解问题</li><li><b>02</b>看真实资料，不凭空下结论</li><li><b>03</b>保留你的语气，由你选择修改</li></ol></div>`;
    return;
  }
  const stale=project.lastCheck.revision!==project.revision;
  const engine=project.lastCheck.engine==='local_rules'?'本地规则初筛 · 未查外部资料':'模型文本初筛 · 未核对事实';
  const checkNote=project.lastCheck.note?`<p class="error" role="status">${esc(project.lastCheck.note)}</p>`:'';
  const list=findings.length>1?`<div class="item-list">${findings.map((x,i)=>`<button data-action="select" data-id="${x.id}" class="${x.id===selected?'selected':''}">第 ${i+1} 处${x.status==='deferred'?' · 已保留':''}${x.status==='addressed'?' · 已修改':''}</button>`).join('')}</div>`:'';
  const verified=f?project.verification?.[f.id]:null;
  // 原句在面板顶部固定可见：它是后面每个决定的共同对象。
  // 改过之后原句通常已不在稿子里，此时不提供「定位」，避免把人送到一个不存在的位置。
  const addressed=f?.status==='addressed';
  const stillThere=Boolean(f&&draft.value.includes(f.quote));
  const locateButton=stillThere?button('locate','在原稿中定位 ↗'):'';
  // 审稿意见的“中肯”体现在这里：先说清严重度与影响面，再给一个方向，而不是只下判断。
  const done=decided||addressed;
  // 真实语料评估显示：模型逐句检查时报出率可达四成以上，其中相当一部分属于“要求补充细节”而非真缺口
  // （见 data/reliability/review-queue.md）。所以面板要把“这条不一定要改”说出来，而不是让人以为系统已经判定；
  // 已经处理完这一句之后就不再重复这句话，否则会和结果卡冲突。
  const calibration=f&&!done?`<p class="fine">这条意见来自一次文本初筛，<b>不等于系统已经判定这句话有问题</b>；如果它只是要求你写得更详细，用下面的「暂时保留」更合适。</p>`:'';
  const severityBadge=f?.severity?`<span class="badge">${esc(f.severity)}${f.impact?` · ${esc(f.impact)}`:''}</span>`:'';
  const directionLine=f?.direction&&!addressed?`<p class="fine">可以往这个方向改：<b>${esc(f.direction)}</b>${f.direction==='补充依据'?'（先点“查这一句的依据”再改，别凭空补事实）':''}</p>`:'';
  const quoteCard=f?`<div class="quote-card${addressed?' addressed':''}"><div class="quote-card-head"><span class="quote-label">${addressed?'改之前的这一句':'这句话'}</span>${locateButton}</div><blockquote>${esc(f.quote)}</blockquote>${addressed?'':`<p class="reason">${esc(f.reason)}</p>`}${directionLine}<p class="fine">${f.status==='deferred'?'你选择暂时保留，尚不代表已核实。':addressed?(stillThere?'现在的稿子里仍然保留着这句原话。':'它已经不在当前稿子里了。'):'检查提示不等于事实判决。'}</p><span class="badge">${esc(engine)}</span>${severityBadge}</div>`:'';
  let body='';
  const suggestion=f&&!stale&&latest&&latest.baseRevision===project.revision&&!latest.applied&&!latest.full&&latest.findingId===f.id?latest:null;
  if(!f){
    // 没有候选项时绝不写成“没有问题”：这里只能说明本次用的是什么方法、它覆盖了什么。
    const local=project.lastCheck.engine!=='model';
    body=`<h3 class="decision-title">${local?'这次初筛没有需要立刻处理的项。':'这次检查没有返回明确候选。'}</h3><p class="reason">${status.model?'一次文本检查没有返回候选，不等于这篇稿子已经通过逻辑检查。':'本地规则只比对了强断言与概念错配，漏报是常态，不代表全文已经通过检查。'}</p><p class="fine">本次只做了文本检查，没有核对任何外部资料。想要更完整的一次通读，可以继续检查全文；也可以直接指定一句话去查依据。</p><div class="decision">${button('full','继续检查全文',true)}</div><details class="more"><summary>其他选择</summary><div class="actions">${button('copy','复制当前稿')}${button('download','下载 Markdown')}</div></details>`;
  }else if(decided||addressed){
    const adopted=latest?.applied?latest.text:null;
    const nextSteps=decided?`<h3 class="next">接下来</h3><div class="options"><button class="option" data-action="full"><b>继续检查全文</b><i>看看还有没有别的地方值得再看一眼</i></button><button class="option" data-action="compose"><b>整理修订稿</b><i>把已采用的修改顺成一篇候选稿</i></button><button class="option" data-action="download"><b>带走现在这一稿</b><i>下载 Markdown，含研究资料附录</i></button></div>`:'';
    body=`<div class="result-card"><span class="badge">这一步完成了</span><h3>这句话改好了。</h3>${adopted?`<p class="add-line">现在的说法：<b>${esc(adopted)}</b></p>`:''}<p class="fine">只替换了这一句，其他内容没有被改动。撤销随时可用，位置和版本都已记录。</p><div class="actions">${button('undo','撤销这次修改')}${button('download','下载 Markdown')}</div></div>${nextSteps}`;
  }else if(suggestion){
    body=`<h3 class="decision-title">改法在这里，采用前先看差别。</h3><p class="reason">${esc(suggestion.reason)}</p>
<div class="compare"><span class="compare-label">原句</span><blockquote>${esc(suggestion.quote)}</blockquote><span class="compare-label">${suggestion.wordingOnly?'候选句 · 仅调整表述，未核对事实':'候选句 · 请核对依据与你的本意'}</span><blockquote class="new-text">${esc(suggestion.text)}</blockquote><div class="diffbox">${diff(suggestion.quote,suggestion.text)}</div></div>
<div class="decision">${button('apply','采用这处修改',true,`data-id="${suggestion.id}"`)}</div><div class="options"><button class="option" data-action="edit"><b>我自己改</b><i>光标跳到这一句，候选句留在这里作参考</i></button><button class="option" data-action="choice-back"><b>换个改法</b><i>回到上一步，重新选择怎么改</i></button><button class="option" data-action="defer"><b>保留原句，先不改</b><i>记录为「已保留」，不等于已核实</i></button></div>`;
  }else if(choice==='rewrite'){
    const outline=localPreview(f);
    body=`<h3 class="decision-title">想把它改成什么样？</h3><p class="reason">这三条路都只改这一句，采用前不会动你的原稿。下面是其中最简单的一种：只把说满的话说得有余地。</p>
<div class="preview"><span class="preview-label">示意 · 仅调整表述，未核对事实</span><blockquote class="new-text">${esc(outline)}</blockquote><div class="diffbox">${diff(f.quote,outline)}</div><p class="fine">这只是本地规则给的示意，让你先看到差别，不是已经生成的候选句，也没有核对任何事实。</p></div>
<div class="options single">
<button class="option" data-action="wording"><b>就要这种改法</b><i>生成候选句，仍然先给你看差别再决定</i></button>
<button class="option" data-action="suggest"><b>用查到的材料改准确</b><i>消息更硬，但需要先有依据；没有依据时系统会提示</i></button>
<button class="option" data-action="edit"><b>我自己改，不用建议</b><i>光标跳到这一句，按你自己的意思写</i></button>
</div>
${button('back','返回上一步')}`;
  }else if(verified){
    body=`<h3 class="decision-title">材料在这里，怎么改由你定。</h3><p class="reason">${esc(verified.summary||'以上是本次真实检索到的材料，是否支持原句需要你自己判断。')}</p><div class="decision">${button('choice-rewrite','看这句话怎么改',true)}</div><div class="options"><button class="option" data-action="defer"><b>保留原句，先不改</b><i>记录为「已保留」，不等于已核实</i></button><button class="option" data-action="locate"><b>回到原稿自己写</b><i>不采用任何候选，直接编辑正文</i></button></div>`;
  }else if(stale){
    body=`<h3 class="decision-title">原稿已经更新了。</h3><p class="reason">上面这句话属于上一个版本。重新检查后，建议才会针对你现在这一稿。</p><div class="decision">${button('check','重新检查这一稿',true)}</div>`;
  }else{
    body=`<h3 class="decision-title">这句话值得再看一眼。</h3><p class="reason">它已经在你左侧的原稿里被标出来了。<b>下一步先看真实材料</b>——不凭感觉改，也不凭空换掉你的判断。</p><div class="decision">${button('verify','查这一句的依据',true)}</div><p class="fine">会在知乎与外部资料里检索这一句，把摘要放在这里。检索命中不等于支持原句。</p><div class="options"><button class="option" data-action="choice-rewrite"><b>先不看依据，直接改</b><i>可以。但这时只能调整表述，不能补事实</i></button><button class="option" data-action="defer"><b>保留原句，先不改</b><i>记录为「已保留」，不等于已核实</i></button></div>`;
  }
  // 没有候选项时，这一分支自己给了“其他选择”；再挂一条会重复同样的入口。
  const foot=stale||done||!f?'':`<details class="more"><summary>其他选择：自己编辑、暂时保留、整理成稿</summary><div class="actions">${button('edit','自己编辑这一句')}${button('defer','暂时保留这一句')}${button('compose','整理修订稿')}${button('copy','复制当前稿')}${button('download','下载 Markdown')}</div></details>`;
  review.innerHTML=`${errorHtml}${stepRail(done?3:(verified?2:1),[Boolean(verified),done,done])}${list}<div class="${done?'done':''}">${quoteCard}${checkNote}</div>${calibration}${body}${foot}`;
  highlight(!addressed&&f?f.quote:'');
}
function render(){
  count();
  const q=project?.question||questionContext;
  $('#question-context').hidden=!q;
  const qLabel=questionLabel(q);
  $('#question-context').innerHTML=q?`正在讨论：<a href="${esc(q.url)}" target="_blank" rel="noopener noreferrer">${esc(qLabel)}</a> ${button('answers','看看其他回答')}`:'';
  renderReview();
  const v=project?.verification[selected];
  $('#sources-section').hidden=!v;
  if(v){
    $('#source-summary').textContent=v.summary;
    $('#source-errors').innerHTML=v.errors.map(x=>`<p class="error">${esc(x)}</p>`).join('')+(v.baseRevision!==project.revision?'<p class="error">以下材料针对旧原稿，需重新核对其与新表述的关系。</p>':'');
    const labels={supports:'系统分析：支持部分主张',challenges:'系统分析：限制或反例',context:'仅作背景',unclear:'关系尚不明确',unreviewed:'摘要 · 尚未语义核对'};
    $('#source-grid').innerHTML=project.sources.filter(s=>v.sourceIds.includes(s.id)).map(s=>`<article class="source-card"><span class="badge">${esc(s.provider)}</span><span class="meta"> ${esc(labels[s.relation])}</span><h3>${esc(s.title)}</h3><div class="meta">${esc(s.author||'作者未提供')} · 采集于 ${esc(new Date(s.retrievedAt).toLocaleString())}</div><p class="excerpt">${esc(s.text)}</p>${s.explanation?`<p>${esc(s.explanation)}</p>`:''}<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">打开原文 ↗</a></article>`).join('')||'<p class="fine">没有可展示的真实来源。可以自行补充材料或保留不确定性。</p>';
  }
}
// 方案 B 门禁：未登录时可以完整走一遍（贴稿 → 初筛 → 查证 → 改稿），
// 但那一次的结果不写入账号库；"保留"与"继续使用"需要登录。
// 这样登录的价值是真实的（跨设备保存），而不是用来解锁按钮。
const signedIn=()=>Boolean(account);
function gateVisible(show){$('#login-gate').hidden=!(show&&oauthConfigured&&!signedIn());}
async function projects(){
  if(!signedIn()){
    $('#projects').innerHTML='<p class="fine">用知乎账号登录后，这里会保存你的研究过程，也可以在其他设备继续。</p>';
    return;
  }
  const rows=await api('/projects');$('#projects').innerHTML=rows.length?rows.map(p=>`<div class="project-row"><button data-action="open" data-id="${p.id}">${esc(p.title)}</button><span class="meta">${esc(new Date(p.updated).toLocaleDateString())}</span><button class="delete" data-action="delete" data-id="${p.id}" aria-label="删除 ${esc(p.title)}">删除</button></div>`).join(''):'<p class="fine">这里会保存你的研究过程。第一篇，从上面的草稿开始。</p>';
}
async function saveDraft(){
  if(saving){await saving;if(dirty)return saveDraft();return;}
  if(!dirty && project)return;
  // 匿名体验也维护服务端工作副本，确保检查和修改针对当前稿。
  // 关联账号才提供跨设备保存；不以禁止更新工作副本实现登录门禁。
  const text=draft.value;const expected=project?.revision;const pid=project?.id;
  $('#save-status').textContent='正在保存…';
  saving=(async()=>{
    const p=pid?await api(`/projects/${pid}`,'PATCH',{text,revision:expected}):await api('/projects','POST',{text,question:questionContext});
    project=p;dirty=draft.value!==text;
    // 服务端在保存已有草稿时会保留原有问题关联；这里把它同步回本地，避免界面比数据「少一条上下文」。
    if(project.question)questionContext=project.question;
    // 未登录时不记录本地草稿指针：跨刷新恢复属于登录后的能力
    if(signedIn())localStorage.setItem('cognitive-project',p.id);else localStorage.removeItem('cognitive-project');
    $('#save-status').textContent=dirty?'有未保存的编辑':signedIn()?'已保存 '+new Date(p.updated).toLocaleTimeString():'本次工作副本已更新 · 登录后关联账号';
    if(signedIn())await projects();else gateVisible(true);
  })();
  try{await saving;}catch(e){$('#save-status').textContent='保存失败 · 请保留当前内容';throw e;}finally{saving=null;}
}
// 「找相关问题」和「粘贴链接」最后都汇到同一个项目上下文：
// 一条真实问题 + 一篇草稿 + 同一个审稿工作台，所以只留一个绑定函数。
// 调用前必须先清掉防抖中的自动保存并置 extraBusy，避免并发的第二次保存把问题关联冲掉。
// 草稿为空时按这个问题起一段草稿：服务端要求 20—10000 字符，空文本会被直接拒绝。
async function bindQuestion(question){
  if(!draft.value.trim()){
    draft.value=questionScaffold(question.title);
    dirty=true;count();
  }
  await saveDraft();
  if(dirty)throw new Error('保存期间有新的编辑，已保留当前稿。请保存后再关联问题。');
  const payload={url:question.url,title:(question.title||'').slice(0,300)};
  project=project
    ?await api(`/projects/${project.id}`,'PATCH',{text:draft.value,question:payload,revision:project.revision})
    :await api('/projects','POST',{text:draft.value,question:payload});
  questionContext=project.question||payload;
  selected=null;error='';choice=null;decided=false;dirty=false;
  $('#question-results').innerHTML='';$('#answer-results').innerHTML='';
  $('#save-status').textContent=signedIn()?`已保存 ${new Date(project.updated).toLocaleTimeString()}`:'本次工作副本已更新 · 登录后关联账号';
  if(signedIn())localStorage.setItem('cognitive-project',project.id);
  render();
  return project;
}
async function load(id){
  if(saving)await saving;
  if(dirty && !confirm('当前有未保存的内容，确定切换吗？'))return;
  const before=draft.value;
  const loaded=await api(`/projects/${id}`);
  if(draft.value!==before){notice('加载期间有新的编辑，已保留当前稿。请保存后再切换。');return;}
  clearTimeout(timer);project=loaded;questionContext=project.question||null;$('#answer-results').innerHTML='';draft.value=project.text;dirty=false;selected=null;error='';choice=null;decided=false;
  localStorage.setItem('cognitive-project',id);$('#save-status').textContent='已保存 '+new Date(project.updated).toLocaleTimeString();render();
}
async function poll(op){
  operation=op;localStorage.setItem('cognitive-operation',op.id);render();
  while(['queued','running'].includes(operation.status)){
    await new Promise(resolve=>setTimeout(resolve,650));
    try{operation=await api(`/operations/${op.id}`);}catch(e){operation=null;throw new Error('任务状态连接中断。原稿保留，刷新页面可恢复查询。');}render();
  }
  const result=operation;operation=null;localStorage.removeItem('cognitive-operation');
  if(project?.id===op.project){project=await api(`/projects/${op.project}`);}
  error=result.error?.message||'';
  if(result.status==='cancelled')notice('已取消，原稿已保留。');
  if(result.status==='partial')notice('部分步骤未完成，已有资料已保留。');
  render();await projects();
}
async function run(type,extra={}){
  if(operation||extraBusy)return;
  extraBusy=true;
  try{
  error='';await saveDraft();
  if(dirty)throw new Error('请完成当前编辑并保存后再操作。');
  const op=await api(`/projects/${project.id}/operations`,'POST',{type,key:crypto.randomUUID(),revision:project.revision,findingId:selected,...extra});
  await poll(op);
  }finally{extraBusy=false;}
}
async function changeDraft(action,body={}){
  await saveDraft();
  if(dirty)throw new Error('保存期间有新的编辑，请保存后再采用或撤销修改。');
  const before=draft.value,pid=project.id;
  const updated=await api(`/projects/${pid}/${action}`,'POST',{...body,revision:project.revision});
  if(project?.id!==pid)return;
  project=updated;
  if(draft.value!==before){
    dirty=true;$('#save-status').textContent='有未保存的编辑';
    notice('操作已完成；请求期间的新输入已保留，请核对当前稿后保存。');
  }else{
    draft.value=project.text;dirty=false;$('#save-status').textContent='修改已保存';
    notice(action==='undo'?'已安全撤销上次修改。':'已采用这处修改。');
  }
  render();await projects();
}
async function copy(){await navigator.clipboard.write(draft.value);notice('当前稿已复制。');}
draft.addEventListener('input',()=>{
  dirty=true;count();$('#save-status').textContent='有未保存的编辑';clearTimeout(timer);
  if(project)timer=setTimeout(()=>{if(!extraBusy)saveDraft().catch(e=>{error=e.message;render();});},800);
});
setInterval(()=>{if(project&&dirty&&!saving&&!extraBusy)saveDraft().catch(e=>{error=e.message;render();});},5000);
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
$('#check').onclick=()=>run('quick_check').catch(fail);
$('#save').onclick=()=>{if(!extraBusy)saveDraft().then(render).catch(fail);};
$('#example').onclick=()=>{
  if(operation||extraBusy)return;
  if(draft.value && !confirm('示例会替换输入框中的内容，确定继续吗？'))return;
  draft.value='我正在考虑是否应该让团队更多地采用远程办公。远程办公一定能提高所有人的工作效率。通勤时间变少是一个好处，但我还想了解不同任务类型和团队沟通的影响。';
  dirty=true;count();$('#save-status').textContent='示例草稿 · 尚未保存';notice('这是一段交互示例文字，不是真实研究结果。');
};
$('#new-project').onclick=async()=>{
  if(saving){try{await saving;}catch(e){fail(e);return;}}
  if(operation||extraBusy){notice('请先等待或取消当前操作。');return;}
  if(dirty&&!confirm('当前有未保存内容，确定新建吗？'))return;
  clearTimeout(timer);project=null;questionContext=null;$('#answer-results').innerHTML='';selected=null;draft.value='';dirty=false;error='';choice=null;decided=false;localStorage.removeItem('cognitive-project');$('#save-status').textContent='尚未保存';$('#sources-section').hidden=true;render();draft.focus();
};
function fail(e){error=e.message;notice(e.message);render();}
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-action]');if(!b)return;
  const action=b.dataset.action;
  if((operation||extraBusy)&&action!=='cancel'){notice('请先完成或取消当前操作。');return;}
  const exclusive=['open','delete','apply','undo','defer'].includes(action);
  if(exclusive)extraBusy=true;
  try{
    if(action==='open'){await load(b.dataset.id);return;}
    if(action==='delete'){
      if(!confirm('删除这篇草稿及其记录？此操作无法撤销。'))return;
      if(saving)await saving;
      const before=draft.value;
      await api(`/projects/${b.dataset.id}`,'DELETE');
      if(project?.id===b.dataset.id){
        clearTimeout(timer);project=null;questionContext=null;selected=null;error='';
        if(draft.value===before)draft.value='';
        dirty=Boolean(draft.value);localStorage.removeItem('cognitive-project');
        $('#answer-results').innerHTML='';$('#sources-section').hidden=true;
        $('#save-status').textContent=dirty?'删除期间的新输入已保留 · 尚未保存':'尚未保存';render();
      }
      await projects();return;
    }
    if(action==='select'){selected=b.dataset.id;error='';choice=null;decided=false;render();return;}
    if(action==='cancel'){await api(`/operations/${operation.id}/cancel`,'POST');return;}
    // 引导面板上的决定：只切换面板状态，不发请求；真正的检索与生成仍由 run() 触发。
    if(action==='choice-rewrite'){choice='rewrite';render();return;}
    if(action==='choice-back'){choice=null;render();return;}
    if(action==='back'){choice=null;render();return;}
    if(action==='locate'){highlight(project.findings.find(x=>x.id===selected)?.quote||'',true);return;}
    if(action==='check'){decided=false;choice=null;await run('quick_check');return;}
    if(action==='verify')await run('verify_claim');
    if(action==='suggest')await run('suggest_revision');
    if(action==='wording')await run('suggest_revision',{wordingOnly:true});
    if(action==='full')await run('review_remaining');
    if(action==='compose')await run('generate_draft');
    if(action==='apply'){
      await changeDraft('apply',{suggestionId:b.dataset.id});decided=true;choice=null;render();
    }
    if(action==='undo'){await changeDraft('undo');decided=false;choice=null;error='已撤销这次修改，原句已恢复。可以重新决定怎么处理这一句。';render();}
    if(action==='defer'){
      await saveDraft();project=await api(`/projects/${project.id}/defer`,'POST',{findingId:selected,revision:project.revision});
      notice('已记为「暂时保留」。这不等于已经核实，随时可以回来处理。');render();
    }
    if(action==='edit'){highlight(project.findings.find(x=>x.id===selected)?.quote||'',true);return;}
    if(action==='copy')await copy();
    if(action==='download'){
      const refs=project.sources.map(s=>`- ${s.title} — ${s.url}`).join('\n');
      const content=`${draft.value}\n\n## 研究资料（检索摘要，非逐句核验声明）\n\n${refs||'尚未检索外部资料。'}\n`;
      const url=URL.createObjectURL(new Blob([content],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='我的修订稿.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
  }catch(e){fail(e);}finally{if(exclusive)extraBusy=false;}
});
async function init(){
  await accountStatus();
  const login=new URL(location.href).searchParams.get('login');if(login){notice(login==='success'?'知乎登录成功。':'登录没有完成，原来的匿名草稿仍保留。请检查回调配置或重试。');history.replaceState(null,'','/');}

  status=await api('/status');
  // 上次检查若退回本地规则，说明模型虽已配置但这次没跑成（密钥失效、网关故障等）：
  // 页脚不能只写“模型服务已配置”，否则用户会以为刚才那次是模型看的稿。
  const modelDown=status.model&&project?.lastCheck?.engine==='local_rules';
  $('#connection-status').textContent=`${status.model?(modelDown?'模型已配置但上次未跑成':'模型服务已配置'):'当前为本地规则初筛'} · ${status.zhihu?'知乎检索已配置':'知乎检索未配置'}`;
  render();await projects();
  // 先恢复关联项目，再恢复登录跳转期间尚未进入工作副本的文字。
  const pending=localStorage.getItem('cognitive-pending');
  // 未登录时不自动恢复上次草稿：跨刷新保留正是登录的意义所在。
  // 那一次完整体验在同一次访问里照常可用。
  const last=signedIn()?localStorage.getItem('cognitive-project'):null;if(last){try{await load(last);}catch{localStorage.removeItem('cognitive-project');}}
  if(pending){if(!draft.value||draft.value===project?.text){draft.value=pending;dirty=pending!==project?.text;$('#save-status').textContent=dirty?'有未保存的编辑':'已恢复关联草稿';count();}localStorage.removeItem('cognitive-pending');}
  const op=localStorage.getItem('cognitive-operation');if(op){try{await poll(await api(`/operations/${op}`));}catch{operation=null;localStorage.removeItem('cognitive-operation');render();}}
}
init().catch(fail);

async function accountStatus(){const a=await api('/auth');account=a.user;oauthConfigured=a.configured;$('#account-label').textContent=account?account.name:'匿名创作';$('#account-action').textContent=account?'退出登录':'知乎登录';$('#account-action').title=a.configured?'':'待开发者配置 OAuth，匿名体验可继续使用';gateVisible(Boolean(project?.lastCheck));}
// 提示条上的登录按钮与顶栏共用同一段逻辑
$('#login-gate-action').onclick=()=>$('#account-action').click();
// 登录跳转前保留本机文字，作为工作副本之外的恢复备份。
function stashDraft(){try{if(draft.value)localStorage.setItem('cognitive-pending',draft.value);}catch{/* 隐私模式忽略 */}}
async function startLogin(){
  if(dirty)await saveDraft();
  stashDraft();
  const link=project&&confirm('登录后将当前这篇草稿及研究记录关联到知乎账号？取消则只登录，草稿保留在匿名空间。');
  const r=await api('/auth/start','POST',{projectId:link?project.id:null});
  if(link)localStorage.setItem('cognitive-project',project.id);else localStorage.removeItem('cognitive-project');
  stashDraft();location.assign(r.url);
}
$('#account-action').onclick=async()=>{
  if(!account&&!oauthConfigured){notice('知乎登录尚未配置，匿名草稿仍可继续使用。');return;}
  if(operation||extraBusy){notice('请先完成当前操作。');return;}
  extraBusy=true;
  try{
    if(account){await api('/auth/logout','POST');localStorage.removeItem('cognitive-project');localStorage.removeItem('cognitive-operation');location.assign('/');return;}
    await startLogin();
  }catch(e){fail(e);}finally{extraBusy=false;}
};
$('#find-questions').onclick=async()=>{
  if(extraBusy||operation)return;extraBusy=true;$('#find-questions').disabled=true;
  const base=$('#topic').value.trim(),keyword=$('#topic-keyword').value.trim();
  // 实测：平台对某些主题（例如「远程办公」）会稳定返回空，而同一个主题加一个词就有结果。
  // 所以补充词直接拼进查询串，不假装平台在做语义扩写，界面上也写清这次实际查了什么。
  const query=[base,keyword].filter(Boolean).join(' ');
  questionChoices=[];
  $('#question-results').textContent='正在查找真实问题…';
  try{
    if(base.length<2||base.length>100)throw new Error('请输入 2—100 字符的主题。');
    const r=await api('/questions','POST',{query:keyword?query.slice(0,100):base});
    questionChoices=r.items||[];
    if(!questionChoices.length){
      const asked=r.query||query;
      const reason=r.emptyReason?`<p class="error">知乎返回：${esc(r.emptyReason)}</p>`:'';
      $('#question-results').innerHTML=`<p>这次在知乎没有查到与「${esc(asked)}」相关的问题，不代表这个主题没有讨论。</p>${reason}<p class="fine">平台的推荐对措辞很敏感：同一主题换个说法、或补一个关键词常有结果。它只做推荐，不判断观点对错。</p><div class="actions">${button('retry-topic','补一个关键词再找')}</div>`;
    }else{
      $('#question-results').innerHTML=questionChoices.map((q,i)=>`<div class="project-row"><a href="${esc(q.url)}" target="_blank" rel="noopener noreferrer">${esc(q.title)}</a><button class="quiet" data-question-index="${i}">围绕这题写</button></div>`).join('')+`<p class="fine">共 ${questionChoices.length} 条来自知乎的真实问题。点标题去知乎看原讨论，点「围绕这题写」把它变成你的草稿。</p>`;
    }
  }catch(e){
    // 主题搜索额度用完时，最有用的一句话是「换个入口」——粘贴问题链接不受这个限额影响。
    if(e.code==='QUESTION_LIMIT'){
      $('#question-results').innerHTML=`<p class="error" role="alert">${esc(e.message)}</p><div class="actions">${button('use-link-entry','改贴问题链接')}</div>`;
    }else{
      $('#question-results').innerHTML=`<p class="error" role="alert">${esc(e.message)}</p>`;
    }
  }
  finally{extraBusy=false;$('#find-questions').disabled=false;}
};
$('#use-question-link').onclick=async()=>{
  if(extraBusy||operation){notice('请先完成或取消当前操作。');return;}
  const raw=$('#question-link').value,title=$('#question-title').value.trim();
  $('#link-result').innerHTML='';
  if(!localQuestionLink(raw)){$('#link-result').innerHTML='<p class="error" role="alert">没有识别出知乎问题编号。形如 https://www.zhihu.com/question/1234567890 的链接，或直接填问题编号都可以。</p>';return;}
  if(draft.value.trim()&&!confirm('已经输入了草稿。关联问题会保留你现在的内容，继续吗？'))return;
  extraBusy=true;$('#use-question-link').disabled=true;
  try{
    // 服务端负责最终判定（移动端域名、追踪参数、/answer/ 后缀等写法）；这里传原始输入，不回传本地猜测。
    const link=await api('/questions/link','POST',{link:raw,title});
    if(!draft.value.trim()&&project){
      if(!confirm('当前草稿里还没有内容。要用这个链接新建一篇吗？'))return;
      clearTimeout(timer);project=null;questionContext=null;draft.value='';dirty=false;
      $('#sources-section').hidden=true;render();
    }
    clearTimeout(timer);
    const bound=await bindQuestion({url:link.url,title:link.title||title});
    $('#question-link').value='';$('#question-title').value='';
    $('#link-result').textContent=`已关联：${questionLabel(bound.question)}`;
    notice(`这篇草稿现在关联到「${questionLabel(bound.question)}」。回答摘要在正文下面，不会写入证据。`);
  }catch(e){$('#link-result').innerHTML=`<p class="error" role="alert">${esc(e.message)}</p>`;}
  finally{extraBusy=false;$('#use-question-link').disabled=false;}
};
$('#question-link').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#use-question-link').click();}});
$('#question-title').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#use-question-link').click();}});
document.addEventListener('click',async e=>{
  const retry=e.target.closest('[data-action="retry-topic"]');
  if(retry){$('#topic-keyword').focus();$('#topic-keyword').placeholder='补一个关键词，例如：效率、管理、工具';notice('主题本身可能太宽或太窄；补一个具体词，再点「找相关问题」。');return;}
  // 额度用完时的出路：展开链接入口并把光标放过去。这条路径不消耗主题搜索额度。
  const toLink=e.target.closest('[data-action="use-link-entry"]');
  if(toLink){
    const entry=document.querySelector('.link-entry');
    if(entry)entry.open=true;
    $('#question-link').focus();
    notice('粘贴问题链接可以直接定位到具体问题，不受主题搜索额度限制。');
    return;
  }
  const pick=e.target.closest('[data-question-index]'),answer=e.target.closest('[data-answer-offset]'),start=e.target.closest('[data-action="answers"]');
  if(!pick&&!answer&&!start)return;if(extraBusy||operation){notice('请先完成当前操作。');return;}
  extraBusy=true;
  try{
    if(pick){
      const q=questionChoices[Number(pick.dataset.questionIndex)];if(!q)return;
      if(draft.value.trim()&&!confirm('为这个问题新建草稿？当前已有草稿会先保存。'))return;
      if(!draft.value.trim()){draft.value=questionScaffold(q.title);dirty=true;count();}
      clearTimeout(timer);
      const bound=await bindQuestion({url:q.url,title:q.title});
      $('#question-results').innerHTML='';
      draft.focus();
      notice(`已为「${questionLabel(bound.question)}」建好草稿。可以改内容，也可以直接检查这段话。`);
      return;
    }
    if(!project){notice('先写下或关联一篇草稿，再看其他回答。');return;}
    // 别人怎么写不等于你该怎么写：摘要只放在这里对照，不进入证据面板，也不改动正文。
    await saveDraft();const pid=project.id;
    const result=await api(`/projects/${pid}/answers`,'POST',{offset:answer?Number(answer.dataset.answerOffset):0});
    if(project?.id!==pid)return;
    $('#answer-results').innerHTML=`<div class="answer-panel"><p class="fine">知乎回答摘要 · 来自原始讨论，尚未核对与草稿的关系；本页不会自动写入证据或修改正文。</p>${result.items.map(x=>`<blockquote>${esc(x.summary)}<br><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">打开回答 ↗</a></blockquote>`).join('')||'<p>本页没有可展示的回答摘要。</p>'}<p>${esc(result.warning)}</p>${result.nextOffset!==null?`<button class="quiet" data-answer-offset="${result.nextOffset}">加载下一页回答</button>`:''}</div>`;
  }catch(e){fail(e);}finally{extraBusy=false;}
});
