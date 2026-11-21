import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeFrames,chromeNativeMessage,encodeNative} from '../app/chrome-native.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),directory=path.join(root,'data/deployment/laptop-activity');
const config=JSON.parse(fs.readFileSync(path.join(directory,'native-host/config.json'),'utf8'));
if(process.argv[2]!==config.origin)process.exit(1);
const frames=new NativeFrames(message=>{try{process.stdout.write(encodeNative(chromeNativeMessage(message,directory)));}catch{process.stdout.write(encodeNative({error:'Native activity request rejected.'}));}});
process.stdin.on('data',chunk=>{try{frames.write(chunk);}catch{process.exit(1);}});
