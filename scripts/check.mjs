import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
let count=0;
function check(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
  const file=join(dir,entry.name);
  if(entry.isDirectory())check(file);
  else if(/\.(mjs|js)$/.test(file)){
    const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
    if(result.status!==0)process.exit(result.status||1);count++;
  }
}}
for(const dir of ['src','public','api','test'])check(dir);
console.log(`Syntax checked ${count} JavaScript files.`);
