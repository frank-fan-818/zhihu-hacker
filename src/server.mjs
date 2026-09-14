import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { Service } from './service.mjs';
import { createProviders } from './providers.mjs';
import { AppError, hash } from './domain.mjs';
import { OAuth } from './oauth.mjs';
import { questionUrl } from './providers.mjs';
import { createStore } from './kv.mjs';
import { RedisStore } from './redis-store.mjs';
import { createBudget } from './budget.mjs';
import { exportDocument } from './export.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const publicProject=p=>{const {owner,...safe}=p;return safe;};
const publicOp=op=>{const {owner,signature,key,...safe}=op;return safe;};
// SQLite is a local development store only. Vercel always selects shared Redis.
const defaultFile=process.env.SQLITE_DIR?join(process.env.SQLITE_DIR,'app.sqlite'):join(root,'data','app.sqlite');
export function createApp({file,providers=createProviders(),oauth=new OAuth(),store:providedStore,kv=createStore(),waitUntil=()=>{}}={}) {
  if(process.env.VERCEL&&!providedStore&&!file&&kv.kind!=='redis')throw new AppError('KV_NOT_CONFIGURED','Vercel 必须配置共享持久数据库，不能使用临时磁盘保存草稿。',503);
  const sharedProjects=Boolean(process.env.VERCEL)||process.env.PROJECT_STORE==='redis';
  const store=providedStore||(file?new Store(file):sharedProjects?new RedisStore(kv):new Store(process.env.SQLITE_FILE||defaultFile));
  const service=new Service(store,providers,{waitUntil});const budget=createBudget(kv,process.env);
  try{store.cleanupOperations?.();}catch{/* cleanup is best effort and must not block startup */}
  const questionCalls=new Map();
  const answerBusy=new Set();
  const consumeQuestionBudget=owner=>{const recent=(questionCalls.get(owner)||[]).filter(t=>Date.now()-t<3600000);if(recent.length>=20)throw new AppError('RATE_LIMIT','本小时问题与回答查询较多，请稍后再试。',429);questionCalls.set(owner,[...recent,Date.now()]);};
  const server=http.createServer(async(req,res)=>{
    const requestId=randomUUID();
    res.setHeader('X-Request-Id',requestId);
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control','no-store');
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    try{
      const host=req.headers.host;
      if(!host)throw new AppError('BAD_REQUEST','缺少请求主机。');
      const base=`http://${host}`;
      const allowedHost=process.env.APP_ORIGIN?new URL(process.env.APP_ORIGIN).host:null;
      const hostAllowed=allowedHost?host===allowedHost||host===`www.${allowedHost}`:['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname);
      if(!hostAllowed)throw new AppError('FORBIDDEN','请求主机不受支持。',403);
      const url=new URL(req.url,base);
      if(allowedHost&&host!==allowedHost){res.writeHead(308,{Location:new URL(url.pathname+url.search,process.env.APP_ORIGIN).href});res.end();return;}
      const cookies=[];
      const setCookie=(value,name='cognitive_session')=>{cookies.push(`${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.APP_ORIGIN?.startsWith('https:')?'; Secure':''}`);res.setHeader('Set-Cookie',cookies);};
      let token=req.headers.cookie?.match(/(?:^|;\s*)cognitive_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      if(!token){token=randomBytes(32).toString('hex');setCookie(token);}
      const anonymous=req.headers.cookie?.match(/(?:^|;\s*)cognitive_anonymous=([a-f0-9]{64})(?:;|$)/)?.[1]||token;
      if(!req.headers.cookie?.includes('cognitive_anonymous='))setCookie(anonymous,'cognitive_anonymous');
      if(url.pathname==='/auth/zhihu/callback'&&req.method==='GET'){
        try{const result=await oauth.finish(token,url.searchParams);
          if(result.projectId)await store.transfer(result.projectId,result.previousOwner,result.session.owner);
          setCookie(result.cookie);res.writeHead(303,{Location:'/?login=success'});res.end();
        }catch(e){res.writeHead(303,{Location:'/?login=failed'});res.end();}return;
      }
      if(!url.pathname.startsWith('/api/')){
        if(req.method!=='GET')throw new AppError('NOT_FOUND','页面不存在。',404);
        const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
        const file=files[url.pathname];if(!file)throw new AppError('NOT_FOUND','页面不存在。',404);
        const mime=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html';
        res.writeHead(200,{'Content-Type':`${mime}; charset=utf-8`});res.end(await readFile(join(root,'public',file)));return;
      }
      if(req.headers['sec-fetch-site']==='cross-site')throw new AppError('FORBIDDEN','不允许跨站访问。',403);
      if(!['GET','HEAD'].includes(req.method)){
        const allowed=process.env.APP_ORIGIN||base;
        if(req.headers.origin && req.headers.origin!==allowed)throw new AppError('FORBIDDEN','不允许跨站写入。',403);
        if(req.headers['content-type']!=='application/json')throw new AppError('BAD_REQUEST','需要 JSON 请求。');
      }
      const session=await oauth.session(token),owner=session?.owner||hash(anonymous);
      // Only Vercel's platform-written header is trusted; local deployments use
      // the socket address, never client-provided X-Forwarded-For.
      const ip=process.env.VERCEL?String(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim():req.socket?.remoteAddress||'unknown';
      let body={};
      if(!['GET','HEAD'].includes(req.method)){
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>128000)throw new AppError('TOO_LARGE','请求内容过大。',413);chunks.push(chunk);}
        try{body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new AppError('INVALID_JSON','JSON 格式错误。');}
        if(!body || typeof body!=='object'||Array.isArray(body))throw new AppError('INVALID_JSON','请求格式错误。');
      }
      const path=url.pathname.split('/').filter(Boolean);
      if(url.pathname==='/api/auth'&&req.method==='GET'){send(200,{configured:oauth.configured,user:session?{name:session.name}:null});return;}
      if(url.pathname==='/api/auth/start'&&req.method==='POST'){
        if(session)throw new AppError('ALREADY_LOGGED_IN','请先退出当前账号。');
        await budget.consume(owner,ip,'write');
        if(body.projectId)await store.get(body.projectId,owner);
        send(200,{url:await oauth.start(token,body.projectId||null,owner)});return;
      }
      if(url.pathname==='/api/auth/logout'&&req.method==='POST'){
        await oauth.logout(token);setCookie(randomBytes(32).toString('hex'));send(200,{loggedOut:true});return;
      }
      if(url.pathname==='/api/questions'&&req.method==='POST'){
        await budget.consume(owner,ip);
        consumeQuestionBudget(owner);
        send(200,await providers.questions(body.query,new AbortController().signal));return;
      }
      if(url.pathname==='/api/question-url'&&req.method==='POST'){
        consumeQuestionBudget(owner);
        send(200,await providers.questionInfo(body.url,new AbortController().signal));return;
      }
      if(path[1]==='status'&&req.method==='GET'){send(200,{...providers.status,storage:store.kind||'sqlite',mode:providers.status.model?'model':'local_rules'});return;}
      if(path[1]==='projects'){
        const project=path[2];
        if(!project){
          if(req.method==='GET'){send(200,await store.list(owner));return;}
          if(req.method==='POST'){await budget.consume(owner,ip,'write');const question=body.question?{url:questionUrl(body.question.url),title:String(body.question.title||'').slice(0,300)}:null;const p=await service.create(owner,body.text,question);send(201,publicProject(p));return;}
        }else if(path.length===3){
          if(req.method==='GET'){send(200,publicProject(await store.get(project,owner)));return;}
          if(req.method==='PATCH'){send(200,publicProject(await service.edit(owner,project,body.text,body.revision)));return;}
          if(req.method==='DELETE'){await service.remove(owner,project);send(200,{deleted:true});return;}
        }else if(path[3]==='export'&&['GET','POST'].includes(req.method)){
          const format=String(req.method==='POST'?body.format:url.searchParams.get('format')||'markdown').toLowerCase();
          if(!['markdown','html','json'].includes(format))throw new AppError('INVALID_INPUT','导出格式只支持 markdown、html 或 json。');
          const document=exportDocument(await store.get(project,owner),format);
          res.writeHead(200,{'Content-Type':document.contentType,'Content-Disposition':`attachment; filename="cognitive-draft.${document.extension}"`});res.end(document.body);return;
        }else if(req.method==='POST'){
          if(path[3]==='answers'){
            const p=await store.get(project,owner);if(!p.question)throw new AppError('INVALID_INPUT','当前草稿未关联知乎问题。');
            if(answerBusy.has(project))throw new AppError('BUSY','正在加载回答，请勿重复请求。',409);
            const offset=body.offset??0;
            if(offset!==0&&offset!==p.answerPage?.nextOffset)throw new AppError('INVALID_INPUT','请按返回的分页位置继续。');
            if(p.answerPage?.at&&Date.now()-p.answerPage.at<2000)throw new AppError('RATE_LIMIT','请稍后再加载。',429);
            await budget.consume(owner,ip);consumeQuestionBudget(owner);answerBusy.add(project);
            try{const revision=p.revision;const result=await providers.answers(p.question.url,offset,new AbortController().signal);
            const latest=await store.get(project,owner);if(latest.revision!==revision)throw new AppError('STALE_RESULT','原稿已变化，未覆盖当前内容。',409);
            latest.answerPage={...result,at:Date.now()};
            latest.answers=offset===0?result.items:[...(latest.answers||[]),...result.items];
            if(!await store.saveIfRevision(latest,revision,{preserveRevision:true}))throw new AppError('REVISION_CONFLICT','原稿已变化，请重试。',409);send(200,result);return;
            }finally{answerBusy.delete(project);}
          }
          if(path[3]==='operations'){await store.get(project,owner);await budget.consume(owner,ip);send(202,publicOp(await service.start(owner,project,body)));return;}
          if(path[3]==='apply'){send(200,publicProject(await service.apply(owner,project,body.suggestionId,body.revision)));return;}
          if(path[3]==='undo'){send(200,publicProject(await service.undo(owner,project,body.revision)));return;}
          if(path[3]==='defer'){send(200,publicProject(await service.defer(owner,project,body.findingId,body.revision)));return;}
        }
      }
      if(path[1]==='operations'&&path[2]){
        if(path[3]==='events'&&req.method==='GET'){
          const opId=path[2];
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
          let closed=false;req.on('close',()=>{closed=true;});
          let previous='';
          for(let i=0;i<240&&!closed;i++){
            const current=publicOp(await store.getOp(opId,owner));
            const payload=JSON.stringify(current);
            if(payload!==previous){res.write(`event: operation\ndata: ${payload}\n\n`);previous=payload;}
            if(!['queued','running'].includes(current.status))break;
            await new Promise(r=>setTimeout(r,500));
          }
          if(!closed)res.end();
          return;
        }
        if(req.method==='GET'){send(200,publicOp(await store.getOp(path[2],owner)));return;}
        if(path[3]==='cancel'&&req.method==='POST'){send(200,publicOp(await service.cancel(owner,path[2])));return;}
      }
      throw new AppError('NOT_FOUND','接口不存在。',404);
    }catch(e){if(!res.headersSent)send(e instanceof AppError?e.status:500,{error:{code:e instanceof AppError?e.code:'SERVER_ERROR',message:e instanceof AppError?e.message:'服务暂时无法完成请求，请重试。',retryable:e instanceof AppError?e.status>=500||e.status===429:false,requestId}});else res.end();}
  });
  return {server,store,service,oauth};
}
// 把原生 (req,res) 处理器接到无服务器运行时上。Vercel 的 Node 运行时接受
// (req,res) 签名，静态资源也由本处理器回源，这样路由表只有一份实现。
export function createRequestHandler(options={}){
  const {server}=createApp(options);
  return (req,res)=>server.emit('request',req,res);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createApp();
  const port=Number(process.env.PORT||4317), host=process.env.HOST||'127.0.0.1';
  app.server.listen(port,host,()=>console.log(`认知调试器已启动：http://${host}:${port}`));
}
