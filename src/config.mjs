import { storeStatus } from './kv.mjs';

export function diagnose(env=process.env){
  const issues=[];
  const modelKeys=['MODEL_BASE_URL','MODEL_NAME','MODEL_API_KEY'];
  const oauthKeys=['ZHIHU_OAUTH_APP_ID','ZHIHU_OAUTH_APP_KEY','ZHIHU_OAUTH_REDIRECT_URI','APP_ORIGIN'];
  const model=modelKeys.every(k=>Boolean(env[k]));
  if(modelKeys.some(k=>env[k])&&!model)issues.push('模型配置不完整：需要 MODEL_BASE_URL、MODEL_NAME、MODEL_API_KEY。');
  if(env.MODEL_BASE_URL){try{const u=new URL(env.MODEL_BASE_URL);if(u.username||u.password||u.search||u.hash||(!['https:'].includes(u.protocol)&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname))))throw Error();}catch{issues.push('MODEL_BASE_URL 必须是无凭据/查询参数的 HTTPS 基础地址或本机 HTTP 地址。');}}
  let oauth=oauthKeys.every(k=>Boolean(env[k]));
  if(oauthKeys.slice(0,3).some(k=>env[k])&&!oauth)issues.push('OAuth 配置不完整：需要 App ID、App Key、回调地址和 APP_ORIGIN。');
  if(oauth){try{const u=new URL(env.ZHIHU_OAUTH_REDIRECT_URI),origin=new URL(env.APP_ORIGIN);if(u.protocol!=='https:'||u.origin!==origin.origin||origin.href!==origin.origin+'/'||u.pathname!=='/auth/zhihu/callback'||u.search||u.hash||u.username||u.password)throw Error();}catch{oauth=false;issues.push('OAuth 需要同源 HTTPS，APP_ORIGIN 仅含来源，回调路径固定 /auth/zhihu/callback，不带查询参数。');}}
  const store=storeStatus(env);
  if(store.issue)issues.push(store.issue);
  return {zhihu:Boolean(env.ZHIHU_ACCESS_SECRET),model,oauth,store,issues,verified:false};
}
