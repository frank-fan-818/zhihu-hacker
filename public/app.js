const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let project=null, selected=null, operation=null, dirty=false, saving=null, timer, error='', status={},showHistory=false;
const draft=$('#draft');
let questionContext=null,questionChoices=[],account=null,oauthConfigured=false,extraBusy=false;

async function api(path,method='GET',body){
  const r=await fetch(`/api${path}`,{method,headers:method==='GET'?{}:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body||{})});
  const data=await r.json();if(!r.ok){const e=new Error(data.error?.message||'请求没有完成。');e.code=data.error?.code;throw e;}return data;
}
function notice(message){$('#notice').textContent=message;$('#notice').hidden=false;clearTimeout(notice.timer);notice.timer=setTimeout(()=>$('#notice').hidden=true,6500);}
function count(){const length=[...draft.value].length;$('#count').textContent=`${length.toLocaleString()} / 10,000 字符`;$('#check').disabled=Boolean(operation)||length<20||length>10000;}
function button(action,text,primary=false,extra=''){return `<button class="${primary?'primary':'quiet'}" data-action="${action}" ${extra}>${text}</button>`;}
async function downloadExport(format='markdown',preview=false){
  const response=await fetch(`/api/projects/${project.id}/export?format=${encodeURIComponent(format)}`);
  if(!response.ok){let data={};try{data=await response.json();}catch{}throw new Error(data.error?.message||'导出没有完成。');}
  const blob=await response.blob(),url=URL.createObjectURL(blob);
  if(preview){const win=window.open(url,'_blank','noopener,noreferrer');if(!win)notice('浏览器阻止了预览窗口，请允许弹出窗口后重试。');}
  else{const a=document.createElement('a');a.href=url;a.download=`我的修订稿.${format==='markdown'?'md':format}`;a.click();}
  setTimeout(()=>URL.revokeObjectURL(url),10000);
}
function render(){
  count();
  const q=project?.question||questionContext;
  $('#question-context').hidden=!q;
  $('#question-context').innerHTML=q?`正在讨论：<a href="${esc(q.url)}" target="_blank" rel="noopener noreferrer">${esc(q.title)}</a> ${button('answers','看看其他回答')}${q.detail?`<blockquote class="question-detail">${esc(q.detail)}</blockquote>`:''}`:'';
  const review=$('#review-content');
  if(operation){review.innerHTML=`<div class="progress"><p class="eyebrow">一次只把一件事想清楚</p><h3>${esc(operation.stage)}</h3><div class="progress-bar"></div><p class="fine">原稿已保存。刷新页面后可以恢复任务状态。</p>${button('cancel','取消本次操作')}</div>`;return;}
  const f=project?.findings.find(f=>f.id===selected)||project?.findings[0];selected=f?.id;
  const latest=project?.suggestions.at(-1);
  const errorHtml=error?`<p class="error" role="alert">${esc(error)}</p>`:'';
  if(!project?.lastCheck){
    const hasAnswers=project?.answers?.length>0;
    review.innerHTML=`${errorHtml}<div class="empty"><span class="empty-symbol">〞</span><h3>先从你的一句话开始。</h3><p>不急着重写全文。找到一处值得注意的地方，看看依据，再决定怎么改。</p>${hasAnswers?'<p class="fine">已加载回答摘要，可以随时"对比回答"看看你的草稿和其他回答的关系。</p>':''}<ol><li><b>01</b>定位原句，理解问题</li><li><b>02</b>看真实资料，不凭空下结论</li><li><b>03</b>保留你的语气，由你选择修改</li></ol></div>`;
  }else{
    const stale=project.lastCheck.revision!==project.revision;
    const isCompare=project.lastCheck.phase==='answer_compare';
    const engine=isCompare?'回答对比分析 · 基于已有回答摘要':project.lastCheck.engine==='local_rules'?'本地规则初筛 · 未查外部资料':'模型文本初筛 · 未核对事实';
    const kindLabels={unique_point:'独特观点',answer_gap:'可补充内容',reinforcement:'互相印证'};
    const list=project.findings.length>1?`<div class="item-list">${project.findings.map((x,i)=>`<button data-action="select" data-id="${x.id}" class="${x.id===selected?'selected':''}">${isCompare?(kindLabels[x.kind]||x.kind):`第 ${i+1} 处`}${x.status==='deferred'?' · 已保留':''}</button>`).join('')}</div>`:'';
    const completed=project.history.length && project.history.at(-1).revision+1===project.revision;
    const hasAnswers=project?.answers?.length>0;
    const context=f?(f.start===-1
      ?`<span class="badge">${esc(engine)}</span>${list}<h3>${esc(kindLabels[f.kind]||f.kind)||'值得关注'}</h3><p class="reason">${esc(f.reason)}</p><p class="fine">这是其他回答中提到、你的草稿尚未涉及的内容。可以考虑补充，也可以保留自己的方向。</p>`
      :`<span class="badge">${esc(engine)}</span>${list}<h3>${isCompare?esc(kindLabels[f.kind]||f.kind):'这句话，值得再看一眼。'}</h3><blockquote>${esc(f.quote)}</blockquote><p class="reason">${esc(f.reason)}</p><p class="fine">${f.status==='deferred'?'你选择暂时保留，尚不代表已核实。':'检查提示不等于事实判决。'}</p>`)
      :`<span class="badge">${esc(engine)}</span><h3>${isCompare?'对比未发现明显差异。':'暂未发现明显的论证问题。'}</h3><p class="reason">${status.model?'本次检查没有返回明确候选。':'本地规则只检查部分强断言，不代表全文逻辑已经通过检查。'}</p><p class="fine">${isCompare?'你的草稿与现有回答在主要观点上没有明显冲突或遗漏。':'没有进行外部事实核对。可编辑后重新检查。'}</p>`;
    const findingActions=f&&!stale
      ?(isCompare
        ?(f.start===-1?button('defer','暂时保留'):'')+button('verify','查看依据 ↗',true)+button('wording','仅调整表述')+button('defer','暂时保留')
        :button('verify','查看依据 ↗',true)+button('suggest','帮我改准确')+button('wording','仅调整表述')+button('defer','暂时保留'))
      :'';
    review.innerHTML=`${errorHtml}${completed?'<span class="badge">已保存你的修改</span><p class="reason">这一次修改，由你决定。可以继续检查全文，也可以带着当前稿结束。</p>':''}${context}${stale?'<p class="error">原稿已更新，以上检查属于旧版本。请重新检查后再查证或修改。</p>':''}<div class="actions">${findingActions}</div><div class="actions">${button('full','继续检查全文')}${hasAnswers?button('compare','对比回答'):''}${button('compose','整理修订稿')}${button('copy','复制当前稿')}${button('download','下载带引用 Markdown')}${button('preview','预览 HTML')}${project.history.length?button('history',showHistory?'收起版本记录':'查看版本记录'):''}${completed?button('undo','撤销上次修改'):''}</div>`;
    if(latest && latest.baseRevision===project.revision && !latest.applied && (latest.full||latest.findingId===selected)){
      review.insertAdjacentHTML('beforeend',`<div class="suggestion"><label>修改前</label><blockquote>${esc(latest.quote)}</blockquote><label>候选修改 · ${latest.wordingOnly?'仅调整表述，未核对事实':'请核对依据与个人意图'}</label><blockquote class="new-text">${esc(latest.text)}</blockquote><p class="reason">${esc(latest.reason)}</p><div class="actions">${button('apply','采用这处修改',true,`data-id="${latest.id}"`)}${button('edit','自己编辑')}</div></div>`);
    }
  }
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
    // 未登录时不记录本地草稿指针：跨刷新恢复属于登录后的能力
    if(signedIn())localStorage.setItem('cognitive-project',p.id);else localStorage.removeItem('cognitive-project');
    $('#save-status').textContent=dirty?'有未保存的编辑':signedIn()?'已保存 '+new Date(p.updated).toLocaleTimeString():'本次工作副本已更新 · 登录后关联账号';
    if(signedIn())await projects();else gateVisible(true);
  })();
  try{await saving;}catch(e){$('#save-status').textContent='保存失败 · 请保留当前内容';throw e;}finally{saving=null;}
}
async function load(id){
  if(saving)await saving;
  if(dirty && !confirm('当前有未保存的内容，确定切换吗？'))return;
  const before=draft.value;
  const loaded=await api(`/projects/${id}`);
  if(draft.value!==before){notice('加载期间有新的编辑，已保留当前稿。请保存后再切换。');return;}
  clearTimeout(timer);project=loaded;questionContext=project.question||null;$('#answer-results').innerHTML='';draft.value=project.text;dirty=false;selected=null;error='';
  localStorage.setItem('cognitive-project',id);$('#save-status').textContent='已保存 '+new Date(project.updated).toLocaleTimeString();render();
}
async function poll(op){
  operation=op;localStorage.setItem('cognitive-operation',op.id);render();
  // SSE reduces status polling while retaining polling as a fallback for older proxies.
  try {
    if (window.EventSource) {
      await new Promise((resolve, reject) => {
        const events = new EventSource(`/api/operations/${op.id}/events`);
        const timeout = setTimeout(() => { events.close(); reject(new Error('SSE timeout')); }, 70000);
        const finish = () => { clearTimeout(timeout); events.close(); resolve(); };
        events.addEventListener('operation', event => { operation=JSON.parse(event.data); render(); if(!['queued','running'].includes(operation.status)) finish(); });
        events.onerror = () => { events.close(); reject(new Error('SSE unavailable')); };
      });
    } else throw new Error('SSE unavailable');
  } catch {
    while(['queued','running'].includes(operation.status)){
      await new Promise(resolve=>setTimeout(resolve,650));
      try{operation=await api(`/operations/${op.id}`);}catch(e){operation=null;throw new Error('任务状态连接中断。原稿保留，刷新页面可恢复查询。');}render();
    }
    if(showHistory && project.history.length){
      review.insertAdjacentHTML('beforeend',`<details class="history-panel" open><summary>版本记录（最近 ${project.history.length} 次）</summary>${project.history.slice().reverse().map(h=>`<article class="history-entry"><div class="meta">第 ${h.revision} 版 · ${esc(new Date(h.appliedAt).toLocaleString())}</div><blockquote>${esc(h.text)}</blockquote><p class="fine">${esc(h.reason||'已保存的修改')}</p></article>`).join('')}</details>`);
    }
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
  clearTimeout(timer);project=null;questionContext=null;$('#answer-results').innerHTML='';selected=null;draft.value='';dirty=false;error='';localStorage.removeItem('cognitive-project');$('#save-status').textContent='尚未保存';$('#sources-section').hidden=true;render();draft.focus();
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
    if(action==='select'){selected=b.dataset.id;render();return;}
    if(action==='cancel'){await api(`/operations/${operation.id}/cancel`,'POST');return;}
    if(action==='verify')await run('verify_claim');
    if(action==='suggest')await run('suggest_revision');
    if(action==='wording')await run('suggest_revision',{wordingOnly:true});
    if(action==='full')await run('review_remaining');
    if(action==='compare')await run('compare_answers');
    if(action==='compose')await run('generate_draft');
    if(action==='apply'){
      await changeDraft('apply',{suggestionId:b.dataset.id});
    }
    if(action==='undo')await changeDraft('undo');
    if(action==='defer'){await saveDraft();project=await api(`/projects/${project.id}/defer`,'POST',{findingId:selected,revision:project.revision});render();}
    if(action==='edit')draft.focus();
    if(action==='copy')await copy();
    if(action==='history'){showHistory=!showHistory;render();}
    if(action==='download'){
      await downloadExport('markdown');
    }
    if(action==='preview')await downloadExport('html',true);
  }catch(e){fail(e);}finally{if(exclusive)extraBusy=false;}
});
async function init(){
  await accountStatus();
  const login=new URL(location.href).searchParams.get('login');if(login){notice(login==='success'?'知乎登录成功。':'登录没有完成，原来的匿名草稿仍保留。请检查回调配置或重试。');history.replaceState(null,'','/');}

  status=await api('/status');
  $('#connection-status').textContent=`${status.model?'模型服务已配置':'当前为本地规则初筛'} · ${status.zhihu?'知乎检索已配置':'知乎检索未配置'}`;
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
  $('#question-results').textContent='正在查找真实问题…';
  try{questionChoices=await api('/questions','POST',{query:$('#topic').value});$('#question-results').innerHTML=questionChoices.map((q,i)=>`<div class="project-row"><a href="${esc(q.url)}" target="_blank" rel="noopener noreferrer">${esc(q.title)}</a><button class="quiet" data-question-index="${i}">围绕这题写</button></div>`).join('')||'<p>没有找到相关问题，可以换一个更具体的主题。</p>';}
  catch(e){$('#question-results').textContent=e.message;}finally{extraBusy=false;$('#find-questions').disabled=false;}
};
$('#load-question-url').onclick=async()=>{
  if(extraBusy||operation)return;extraBusy=true;$('#load-question-url').disabled=true;
  $('#url-results').textContent='正在加载问题信息…';
  try{
    const url=$('#question-url-input').value.trim();
    if(!url){$('#url-results').textContent='请粘贴知乎问题链接。';return;}
    const info=await api('/question-url','POST',{url});
    if(draft.value&&!confirm('为这个问题新建草稿？当前已有草稿会先保存。'))return;
    if(dirty)await saveDraft();
    project=null;questionContext=info;selected=null;error='';$('#answer-results').innerHTML='';
    draft.value=`关于"${info.title}"，我的初步看法是：

我希望先弄清楚相关事实与适用条件，再形成自己的观点。`;
    dirty=true;await saveDraft();render();draft.focus();
    // 自动加载第一页回答
    if(project?.id){
      try{
        const result=await api(`/projects/${project.id}/answers`,'POST',{offset:0});
        $('#answer-results').innerHTML=`<div class="answer-panel"><p class="fine">知乎回答摘要 · 来自原始讨论，供参考和对比；本页不会自动写入证据或修改正文。</p>${result.items.map(x=>`<blockquote>${esc(x.summary)}<br><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">打开回答 ↗</a></blockquote>`).join('')||'<p>本问题暂无可展示的回答摘要。</p>'}<p>${esc(result.warning)}</p>${result.nextOffset!==null?`<button class="quiet" data-answer-offset="${result.nextOffset}">加载下一页回答</button>`:''}</div>`;
        project=await api(`/projects/${project.id}`);
        render();
      }catch(e){$('#answer-results').innerHTML=`<p class="fine">${esc(e.message)} 可以先写草稿，稍后再加载回答。</p>`;}
    }
  }catch(e){$('#url-results').textContent=e.message;}finally{extraBusy=false;$('#load-question-url').disabled=false;}
};
document.addEventListener('click',async e=>{
  const pick=e.target.closest('[data-question-index]'),answer=e.target.closest('[data-answer-offset]'),start=e.target.closest('[data-action="answers"]');
  if(!pick&&!answer&&!start)return;if(extraBusy||operation){notice('请先完成当前操作。');return;}
  extraBusy=true;
  try{
    if(pick){
      if(draft.value&&!confirm('为这个问题新建草稿？当前已有草稿会先保存。'))return;
      if(dirty)await saveDraft();
      if(dirty)throw new Error('保存期间有新的编辑，已保留当前稿。请保存后再新建。');
      const q=questionChoices[Number(pick.dataset.questionIndex)];if(!q)return;
      project=null;questionContext=q;selected=null;error='';draft.value=`关于“${q.title}”，我的初步看法是：

我希望先弄清楚相关事实与适用条件，再形成自己的观点。`;dirty=true;
      $('#answer-results').innerHTML='';await saveDraft();render();draft.focus();return;
    }
    await saveDraft();const pid=project.id;
    const result=await api(`/projects/${pid}/answers`,'POST',{offset:answer?Number(answer.dataset.answerOffset):0});
    if(project?.id!==pid)return;
    $('#answer-results').innerHTML=`<div class="answer-panel"><p class="fine">知乎回答摘要 · 来自原始讨论，尚未核对与草稿的关系；本页不会自动写入证据或修改正文。</p>${result.items.map(x=>`<blockquote>${esc(x.summary)}<br><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">打开回答 ↗</a></blockquote>`).join('')||'<p>本页没有可展示的回答摘要。</p>'}<p>${esc(result.warning)}</p>${result.nextOffset!==null?`<button class="quiet" data-answer-offset="${result.nextOffset}">加载下一页回答</button>`:''}</div>`;
  }catch(e){fail(e);}finally{extraBusy=false;}
});
