import fs from 'node:fs';
import path from 'node:path';
import {normalizeChrome} from './laptop-activity.mjs';

export function encodeNative(value){const body=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32LE(body.length);return Buffer.concat([header,body]);}
export class NativeFrames {
 constructor(receive){this.receive=receive;this.buffer=Buffer.alloc(0);}
 write(data){this.buffer=Buffer.concat([this.buffer,data]);while(this.buffer.length>=4){const size=this.buffer.readUInt32LE(0);if(size>100000||size===0)throw Error('Native message too large.');if(this.buffer.length<4+size)return;const value=JSON.parse(this.buffer.subarray(4,4+size).toString('utf8'));this.buffer=this.buffer.subarray(4+size);this.receive(value);}}
}
export function chromeNativeMessage(message,directory,{clock=Date.now}={}){
 const file=path.join(directory,'control.json');let control={};try{control=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
 let remote={};try{remote=JSON.parse(fs.readFileSync(path.join(directory,'remote.json'),'utf8'));}catch{}
 const paused=control.paused===true||remote.paused===true;
 if(message.op==='control'){
  if(typeof message.paused!=='boolean')throw Error('Invalid pause setting.');
  const temp=file+'.native-'+process.pid;fs.writeFileSync(temp,JSON.stringify({...control,paused:message.paused,intent:message.paused,requestedAt:clock()}),{mode:0o600});fs.renameSync(temp,file);
  return {paused:message.paused,changePending:true};
 }
 if(message.op==='status'){
  let lastCaptureAt=null;const folder=path.join(directory,'chrome');
  if(fs.existsSync(folder))for(const name of fs.readdirSync(folder).filter(n=>/^[a-f0-9-]{36}\.json$/i.test(n)).slice(0,8))try{const sample=JSON.parse(fs.readFileSync(path.join(folder,name),'utf8'));lastCaptureAt=Math.max(lastCaptureAt||0,sample.capturedAt);}catch{}
  return {paused,lastCaptureAt};
 }
 if(message.op!=='sample')throw Error('Unsupported native request.');
 if(paused)return {paused:true,stored:false};
 const raw=message.sample;
 if(!/^[a-f0-9-]{36}$/i.test(raw?.profile||'')||!Array.isArray(raw.tabs))throw Error('Invalid Chrome profile snapshot.');
 const normalized=normalizeChrome({...raw,profiles:[raw.profile]},clock());if(normalized.state!=='available')throw Error('Invalid Chrome sample timestamp.');
 const chromeDir=path.join(directory,'chrome');fs.mkdirSync(chromeDir,{recursive:true});
 const profiles=fs.readdirSync(chromeDir).filter(n=>/^[a-f0-9-]{36}\.json$/i.test(n));if(profiles.length>=8&&!profiles.includes(raw.profile+'.json'))throw Error('Maximum Chrome profiles reached.');
 const target=path.join(chromeDir,raw.profile+'.json'),temp=target+'.tmp-'+process.pid;
 fs.writeFileSync(temp,JSON.stringify({profile:raw.profile,capturedAt:raw.capturedAt,tabs:normalized.tabs,truncated:normalized.truncated}),{mode:0o600});fs.renameSync(temp,target);
 // Do not overwrite controls: another native host/collector may have changed them.
 return {stored:true,capturedAt:raw.capturedAt,tabs:normalized.tabs.length};
}
