import { AppError, id, hash, bounded, checkDraft, validateFindings, validateSuggestion, applySuggestion } from './domain.mjs';

const terminal = status => ['succeeded','partial','failed','cancelled'].includes(status);
const checkTask = '检查草稿。返回 {"items":[{"quote":"逐字原句","start":UTF16起点整数,"kind":"问题类型","reason":"具体原因"}]}。不要凑问题；否定、引用、讽刺不能仅按绝对化词误判。items 数不超过 limit。';
export class Service {
  constructor(store,providers,{waitUntil=()=>{}}={}){this.store=store;this.providers=providers;this.controllers=new Map();this.usage=new Map();this.waitUntil=waitUntil;}
  async create(owner,text,question=null) {
    bounded(text,20,10000,'草稿');
    return this.store.create({id:id(),owner,text,original:text,title:text.trim().slice(0,32),revision:1,
      ...(question?{question}:{}),findings:[],sources:[],verification:{},suggestions:[],history:[],created:new Date().toISOString()});
  }
  // 乐观并发控制：应用层先读后写存在检查-使用间隙，两个并发请求可能都通过
  // `p.revision!==revision` 检查，后写的那次会覆盖前一次。这里把比较下推到
  // 数据库的条件 UPDATE（见 store.saveIfRevision），由写入本身决定成败。
  async saveGuarded(p,baseRevision,message,options) {
    const saved=await this.store.saveIfRevision(p,baseRevision,options);
    if(!saved)throw new AppError('REVISION_CONFLICT',message,409);
    return saved;
  }
  async edit(owner,project,text,revision) {
    const p=await this.store.get(project,owner);bounded(text,20,10000,'草稿');
    if(p.revision!==revision) throw new AppError('REVISION_CONFLICT','其他页面已经更新原稿，请先复制本地内容再加载最新版本。',409);
    if(p.text===text)return p;
    p.text=text;
    return this.saveGuarded(p,revision,'其他页面已经更新原稿，请先复制本地内容再加载最新版本。');
  }
  async apply(owner,project,suggestionId,revision) {
    const p=await this.store.get(project,owner);
    if(p.revision!==revision) throw new AppError('REVISION_CONFLICT','原稿版本已变化，请重新生成建议。',409);
    const s=p.suggestions.find(s=>s.id===suggestionId);
    if(!s)throw new AppError('NOT_FOUND','修改建议不存在。',404);
    const text=applySuggestion(p,s);
    bounded(text,20,10000,'修订稿');
    p.history.push({text:p.text,revision:p.revision,appliedAt:new Date().toISOString(),suggestion:s.id,reason:s.reason});
    p.history=p.history.slice(-20);p.text=text;
    s.applied=true;
    const item=p.findings.find(x=>x.id===s.findingId);if(item)item.status='addressed';
    return this.saveGuarded(p,revision,'原稿版本已变化，请重新生成建议。');
  }
  async undo(owner,project,revision) {
    const p=await this.store.get(project,owner);const last=p.history.at(-1);
    if(p.revision!==revision || !last || p.revision!==last.revision+1)
      throw new AppError('REVISION_CONFLICT','已有后续编辑，无法安全撤销。请对照原稿自行修改。',409);
    p.text=last.text;p.history.pop();
    p.findings.forEach(x=>{if(x.status==='addressed')x.status='open';});
    return this.saveGuarded(p,revision,'已有后续编辑，无法安全撤销。请对照原稿自行修改。');
  }
  async defer(owner,project,findingId,revision) {
    const p=await this.store.get(project,owner);
    if(p.revision!==revision)throw new AppError('REVISION_CONFLICT','原稿已变化。',409);
    const f=p.findings.find(x=>x.id===findingId);if(!f)throw new AppError('NOT_FOUND','检查项不存在。',404);
    f.status='deferred';
    return this.saveGuarded(p,revision,'原稿已变化。',{preserveRevision:true});
  }
  async cancel(owner,opId) {
    const op=await this.store.getOp(opId,owner);
    if(!terminal(op.status)){op.status='cancelled';await this.store.updateOp(op);this.controllers.get(opId)?.abort();}
    return this.store.getOp(opId,owner);
  }
  async remove(owner,project) {
    await this.store.get(project,owner);
    for(const [opId,controller] of this.controllers){try{const op=await this.store.getOp(opId,owner);if(op.project===project)controller.abort();}catch{/* another session */}}
    await this.store.delete(project,owner);
  }
  async start(owner,project,args) {
    const p=await this.store.get(project,owner);
    const {type,key,findingId,wordingOnly=false}=args;
    if(!['quick_check','review_remaining','verify_claim','suggest_revision','generate_draft','compare_answers'].includes(type))throw new AppError('INVALID_INPUT','未知操作。');
    bounded(key,8,100,'操作标识');
    const signature=hash(JSON.stringify({type,findingId,wordingOnly,revision:args.revision}));
    const previous=await this.store.byKey(project,key,owner);
    if(previous){if(previous.signature!==signature)throw new AppError('IDEMPOTENCY_CONFLICT','请求标识不能用于不同操作。',409);return previous;}
    if(p.revision!==args.revision)throw new AppError('REVISION_CONFLICT','原稿已变化，请重新检查。',409);
    if(this.controllers.size>=6)throw new AppError('BUSY','当前任务较多，请稍后再试。',429);
    const recent=(this.usage.get(owner)||[]).filter(t=>Date.now()-t<3600000);
    if(recent.length>=30)throw new AppError('RATE_LIMIT','本小时操作次数已达到本地限制，请稍后再试。',429);
    const finding=p.findings.find(f=>f.id===findingId);
    if(['verify_claim','suggest_revision'].includes(type) && (!finding || finding.baseRevision!==p.revision))
      throw new AppError('STALE_FINDING','这条检查针对旧稿，请重新检查当前原稿。',409);
    if(type==='suggest_revision' && !wordingOnly && !p.verification[findingId]?.sourceIds?.length)
      throw new AppError('EVIDENCE_REQUIRED','先查看依据，或明确选择“仅调整表述”。',409);
    const op={id:id(),project,owner,key,type,signature,baseRevision:p.revision,status:'queued',stage:'准备中',created:new Date().toISOString(),deadline:Date.now()+60000,calls:[]};
    const admitted=await this.store.createOp(op);
    if(admitted.id!==op.id)return admitted;
    this.usage.set(owner,[...recent,Date.now()]);
    const controller=new AbortController();this.controllers.set(op.id,controller);
    this.waitUntil(this.run(op,p,{finding,wordingOnly},AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])));
    return op;
  }
  async run(op,snapshot,args,signal) {
    const checkpoint=async()=>{
      if(signal.aborted)throw new AppError('CANCELLED','已取消。');
      const current=await this.store.getOp(op.id,op.owner);
      if(terminal(current.status))throw new AppError('CANCELLED','已取消。');
      const p=await this.store.get(op.project,op.owner);
      if(p.revision!==op.baseRevision)throw new AppError('STALE_RESULT','原稿已改变，本次结果没有覆盖新稿。',409);
      return p;
    };
    const stage=async text=>{await checkpoint();op.status='running';op.stage=text;if(!await this.store.updateOp(op))throw new AppError('CANCELLED','操作已经结束。',409);};
    try {
      let apply;let partial=false;
      if(['quick_check','review_remaining'].includes(op.type)) {
        await stage(this.providers.status.model?'正在检查论证':'正在进行本地规则初筛');
        const limit=op.type==='quick_check'?1:6;
        const findings=this.providers.status.model
          ? validateFindings(await this.providers.model(checkTask,{text:snapshot.text,limit},signal),snapshot.text,limit)
          : checkDraft(snapshot.text,limit);
        findings.forEach(f=>f.baseRevision=snapshot.revision);
        apply=p=>{
          for(const f of findings){const existing=p.findings.find(x=>x.baseRevision===p.revision && x.start===f.start && x.quote===f.quote);if(existing)Object.assign(f,{id:existing.id,status:existing.status});}
          p.findings=findings;p.lastCheck={engine:this.providers.status.model?'model':'local_rules',at:new Date().toISOString(),revision:p.revision,phase:'draft_check'};
        };
      } else if(op.type==='verify_claim') {
        const previous=snapshot.verification[args.finding.id];
        if(previous && !previous.errors.length && previous.baseRevision===snapshot.revision && Date.now()-previous.time<1800000){
          await stage('读取已保存资料');apply=()=>{};op.cached=true;
        } else {
          if(!this.providers.status.zhihu)throw new AppError('ZHIHU_NOT_CONFIGURED','尚未配置知乎 Access Secret，没有发起搜索，也没有生成证据。',503);
          await stage('正在查找知乎讨论与外部资料');
          const results=await Promise.allSettled(['zhihu_search','global_search'].map(async kind=>{
            const call={kind,status:'running',at:Date.now()};op.calls.push(call);if(!await this.store.updateOp(op))throw new AppError('CANCELLED','操作已经结束。',409);
            try{const sources=await this.providers.search(kind,args.finding.quote,signal);call.status='succeeded';return sources;}
            catch(e){call.status='failed';throw e;}finally{call.duration=Date.now()-call.at;}
          }));
          await checkpoint();
          const sources=results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
          const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason instanceof AppError?r.reason.message:'搜索连接中断或超时。');
          const emptyReasons=results.filter(r=>r.status==='fulfilled'&&r.value.emptyReason).map(r=>r.value.emptyReason);
          partial=errors.length>0;
          const unique=[...new Map(sources.map(s=>[s.url,s])).values()];
          let summary='以下为实际检索摘要，尚未做语义支持核对。请打开来源阅读；检索命中不代表支持原句。';
          if(unique.length && this.providers.status.model){
            await stage('正在比较材料与原句');
            try{
              const analysis=await this.providers.model('返回 {"summary":"具体局限与关系解释","relations":[{"sourceId":"输入中的id","type":"supports|challenges|context|unclear","explanation":"基于摘要的解释"}]}。不强行制造正反双方。', {claim:args.finding.quote,sources:unique.map(s=>({id:s.id,text:s.text}))},signal);
              bounded(analysis.summary,1,1500);
              if(!Array.isArray(analysis.relations))throw new Error('schema');
              for(const r of analysis.relations){const s=unique.find(s=>s.id===r.sourceId);if(!s||!['supports','challenges','context','unclear'].includes(r.type))throw new Error('schema');s.relation=r.type;s.explanation=bounded(r.explanation,1,700);}
              summary=analysis.summary;
            }catch(e){if(signal.aborted)throw e;partial=true;unique.forEach(s=>{s.relation='unreviewed';delete s.explanation;});errors.push('语义分析未完成；真实检索摘要已保留。');}
          }
          apply=p=>{
            p.sources.push(...unique);
            p.verification[args.finding.id]={baseRevision:p.revision,time:Date.now(),sourceIds:unique.map(s=>s.id),summary:unique.length?summary:'本次检索未获得可展示的相关资料，不能据此判断原句成立。'+(emptyReasons.length?' 平台说明：'+emptyReasons.join('；'):''),errors};
          };
        }
      } else if(op.type==='suggest_revision') {
        await stage('正在生成修改对照');
        const sources=snapshot.sources.filter(s=>snapshot.verification[args.finding.id]?.sourceIds.includes(s.id));
        let data;
        if(this.providers.status.model){data=validateSuggestion(await this.providers.model('返回 {"text":"候选句","reason":"具体修改理由","sourceIds":[]}。只修改目标原句，保留语气；wordingOnly=true时不引入事实，将未证实断言改为开放问题或明确待核查。只使用给定来源ID，不写URL。', {quote:args.finding.quote,context:snapshot.text,sources,wordingOnly:args.wordingOnly},signal),sources);}
        else {
          if(!args.wordingOnly)throw new AppError('MODEL_NOT_CONFIGURED','尚未配置模型。可以自行编辑，或选择仅调整表述。',503);
          let text=args.finding.quote.trim().replace(/一定|必然|必定/g,'是否').replace(/[。！]$/,'');
          if(!text.includes('是否'))text=`是否可以说：${text}`;
          data={text:`${text}？`,reason:'本地规则仅将断言改为待讨论的问题，会改变句式；没有核对事实，也没有添加依据。',sourceIds:[]};
        }
        const suggestion={...data,id:id(),findingId:args.finding.id,baseRevision:snapshot.revision,start:args.finding.start,end:args.finding.end,quote:args.finding.quote,wordingOnly:args.wordingOnly};
        apply=p=>{p.suggestions.push(suggestion);};
      } else if(op.type==='compare_answers') {
        if(!this.providers.status.model)throw new AppError('MODEL_NOT_CONFIGURED','对比回答需要模型服务。请配置后再试。',503);
        const answers=snapshot.answers||[];
        if(!answers.length)throw new AppError('INVALID_INPUT','请先加载该问题的回答，再进行对比。',400);
        stage('正在对比草稿与现有回答');
        const analysis=await this.providers.model(
          '你是回答分析师。用户草稿是针对一个知乎问题的回答。以下是该问题其他回答的摘要和用户草稿。找出：1.草稿中独特于其他回答的观点（unique_point）；2.其他回答提到但草稿未涉及的内容（answer_gap）；3.草稿与其他回答一致可互相印证的观点（reinforcement）。返回 {"items":[{"quote":"草稿中的原句","start":UTF16起点整数或-1,"kind":"unique_point|answer_gap|reinforcement","reason":"具体说明"}]}。quote必须是草稿中逐字出现的原文；start为-1时表示该观点是草稿中缺失的内容，quote用简短描述代替。items不超过6。',
          {draft:snapshot.text,answers:answers.map(a=>a.summary.slice(0,2000))},signal);
        if(!analysis||!Array.isArray(analysis?.items)||analysis.items.length>6)throw new AppError('INVALID_MODEL_OUTPUT','对比结果格式无效。',502);
        const findings=analysis.items.map(item=>{
          if(item.start===-1||item.start===undefined){
            return{id:id(),quote:String(item.quote||'').slice(0,500),start:-1,end:-1,kind:String(item.kind||'answer_gap').slice(0,60),
              reason:bounded(item.reason,1,700),phase:'answer_compare',engine:'model',status:'open'};
          }
          try{return{id:id(),...anchor(snapshot.text,String(item.quote),Number(item.start)),kind:bounded(item.kind,1,60),
            reason:bounded(item.reason,1,700),phase:'answer_compare',engine:'model',status:'open'};}
          catch{return{id:id(),quote:String(item.quote||'').slice(0,500),start:-1,end:-1,kind:bounded(item.kind,1,60),
            reason:bounded(item.reason,1,700),phase:'answer_compare',engine:'model',status:'open'};}
        });
        apply=p=>{p.findings=findings;p.lastCheck={engine:'model',at:new Date().toISOString(),revision:p.revision,phase:'answer_compare'};};
      } else {
        await stage('正在整理候选全文');
        const data=validateSuggestion(await this.providers.model('返回 {"text":"候选全文","reason":"修改说明","sourceIds":[]}。保留用户当前稿的主张与语气，不恢复已经删掉的断言，不增加新事实。只整理输入，引用来源仅从给定ID选择，不写URL。', {text:snapshot.text,sources:snapshot.sources},signal),snapshot.sources);
        const suggestion={...data,id:id(),baseRevision:snapshot.revision,start:0,end:snapshot.text.length,quote:snapshot.text,full:true};
        apply=p=>p.suggestions.push(suggestion);
      }
      op.status=partial?'partial':'succeeded';op.stage='已完成';
      let committed=false;
      for(let attempt=0;attempt<5;attempt++){
        const p=await checkpoint();const expectedVersion=p.version??0;apply(p);
        if(await this.store.commitResult(p,op,expectedVersion)){committed=true;break;}
      }
      if(!committed)throw new AppError('REVISION_CONFLICT','项目正在被更新，请重试。',409);
    }catch(e){
      try{
        const current=await this.store.getOp(op.id,op.owner);
        if(!terminal(current.status)){
          op.status=signal.aborted?'cancelled':'failed';
          op.error={code:e instanceof AppError?e.code:'OPERATION_FAILED',message:e instanceof AppError?e.message:'操作中断或服务响应无效。已有原稿已保留。'};
          await this.store.updateOp(op);
        }
      }catch{/* deleted projects must never be resurrected */}
    }finally{this.controllers.delete(op.id);}
  }
}
