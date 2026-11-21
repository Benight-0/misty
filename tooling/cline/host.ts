// Editor services replaced by the laptop host. Never send telemetry or start an agent.
import fs from 'node:fs';
import path from 'node:path';
export function captureRunCommandsTimeout() {}
export function resolveExistingFilePath(p:string) {try{return fs.realpathSync.native(p);}catch{return undefined;}}
export class ToolResultCache { read() {throw Error('Cline cache URIs are unavailable on this laptop.');} }
export const TOOL_RESULT_CACHE_MISS='Cline cache URIs are unavailable on this laptop.';
export async function getFileIndex(cwd:string,fullAccess=false) {
 const files=new Set<string>();
 async function walk(dir:string,depth:number) {
  if(depth>20||files.size>=20000)return;
  for(const e of await fs.promises.readdir(dir,{withFileTypes:true})) {
   if(e.isSymbolicLink()||!fullAccess&&(/^(?:\.git|node_modules|data|dist|build|coverage|\.env.*)$/i.test(e.name)||/^(?:config\.json|.*\.(?:key|pem)|.*(?:token|secret|credential).*)$/i.test(e.name)))continue;
   const p=path.join(dir,e.name);if(e.isDirectory())await walk(p,depth+1);else if(e.isFile()&&(await fs.promises.stat(p)).size<=2000000)files.add(path.relative(cwd,p));
  }
 }
 await walk(cwd,0);return files;
}
