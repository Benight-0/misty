import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {LocalOllama} from '../ollama-runtime.mjs';

function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'archival-runtime-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const version=()=>new Response(JSON.stringify({version:'test'}));
test('managed runtime binds locally, disables cloud, preserves f16 precision and closes only its own process',async t=>{
  const dir=directory(t),child=new EventEmitter();child.pid=123;child.exitCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();let options,killed=false,checks=0,unloaded=false;
  child.kill=()=>{killed=true;child.stdout.end();child.stderr.end();child.emit('exit',0);};
  const runtime=new LocalOllama({directory:dir,concurrency:4,terminateImpl:async process=>process.kill(),spawnImpl:(file,args,input)=>{assert.deepEqual(args,['serve']);options=input;return child;},fetchImpl:async(url,input)=>{
    if(url.endsWith('/api/version')){if(!checks++)throw new Error('Not started');return version();}
    assert.equal(url,'http://127.0.0.1:11435/api/generate');assert.equal(JSON.parse(input.body).keep_alive,0);unloaded=true;return version();
  }});
  await runtime.start();assert.equal(options.windowsHide,true);assert.equal(options.env.OLLAMA_HOST,'127.0.0.1:11435');assert.equal(options.env.OLLAMA_NUM_PARALLEL,'4');assert.equal(options.env.OLLAMA_NO_CLOUD,'1');assert.equal(options.env.OLLAMA_KV_CACHE_TYPE,'f16');assert.equal(options.env.OLLAMA_FLASH_ATTENTION,'1');assert.equal(options.env.HTTPS_PROXY,'');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'ollama-runtime.json'))).concurrency,4);
  const finished=new Promise(resolve=>runtime.stream.on('close',resolve));await runtime.close();await finished;assert.equal(killed,true);assert.equal(unloaded,true);
});
test('an existing runtime adopts its saved capacity and is never terminated by a second owner',async t=>{
  const dir=directory(t);fs.writeFileSync(path.join(dir,'ollama-runtime.json'),JSON.stringify({port:11435,concurrency:2}));let calls=0;
  const runtime=new LocalOllama({directory:dir,concurrency:4,spawnImpl:()=>{throw new Error('Must not spawn');},fetchImpl:async()=>{calls++;return version();}});
  await runtime.start();assert.equal(runtime.concurrency,2);await runtime.close();assert.equal(calls,1);
});
test('an unknown local service uses one lane and invalid runtime settings are rejected',async t=>{
  const runtime=new LocalOllama({directory:directory(t),concurrency:4,fetchImpl:async()=>version()});await runtime.start();assert.equal(runtime.concurrency,1);await runtime.close();
  assert.throws(()=>new LocalOllama({directory:'x',concurrency:8}),/Invalid/);assert.throws(()=>new LocalOllama({directory:'x',port:80}),/Invalid/);
});
