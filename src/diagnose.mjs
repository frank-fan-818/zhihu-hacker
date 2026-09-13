import { diagnose } from './config.mjs';
import { createProviders } from './providers.mjs';
const d=diagnose();console.log(JSON.stringify(d,null,2));
if(process.argv.includes('--quota')){
  try{console.log(JSON.stringify(await createProviders().quota(new AbortController().signal),null,2));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
