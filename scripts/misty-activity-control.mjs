import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/deployment/laptop-activity'),file=path.join(dir,'control.json');
const command=process.argv[2]||'status';fs.mkdirSync(dir,{recursive:true});let control={};try{control=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
if(['pause','resume'].includes(command)){control={...control,paused:command==='pause',intent:command==='pause',requestedAt:Date.now()};const temp=file+'.tmp-'+process.pid;fs.writeFileSync(temp,JSON.stringify(control),{mode:0o600});fs.renameSync(temp,file);}
else if(command!=='status')throw Error('Use status, pause or resume.');
let status={};try{status=JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8'));}catch{}
console.log(JSON.stringify({control,status:{...status,fresh:!!status.at&&Date.now()-status.at<=90000,ageSeconds:status.at?Math.floor((Date.now()-status.at)/1000):null}},null,2));
