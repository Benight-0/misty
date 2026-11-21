import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=path.dirname(fileURLToPath(import.meta.url));
await build({entryPoints:[path.join(root,'entry.ts')],outfile:path.join(root,'dist/executors.mjs'),bundle:true,format:'esm',platform:'node',target:'node22',
 legalComments:'eof',plugins:[{name:'misty-host-adapters',setup(b){
 b.onResolve({filter:/^@cline\/shared$/},()=>({path:path.join(root,'shared.ts')}));
 b.onResolve({filter:/^@cline\/shared\/storage$/},()=>({path:path.join(root,'host.ts')}));
 b.onResolve({filter:/(services\/workspace|session\/services\/tool-result-cache|services\/telemetry\/core-events)$/},()=>({path:path.join(root,'host.ts')}));
 b.onLoad({filter:/executors[\\/]search\.ts$/},async a=>{
  let source=await fs.promises.readFile(a.path,'utf8');
  const edits=[
   ['maxResults?: number;','maxResults?: number;\n\tfullAccess?: boolean;'],
   ['abortSignal?: AbortSignal,\n): Promise<SearchMatch[] | null>', 'abortSignal?: AbortSignal,\n\tfullAccess = false,\n): Promise<SearchMatch[] | null>'],
   ['["--json", `--context=${contextLines}`, "--max-count=1", "-i", query]', '["--json", `--context=${contextLines}`, "--max-count=1", "-i", ...(fullAccess ? ["--hidden", "--no-ignore"] : ["-g", "!**/data/**", "-g", "!**/node_modules/**", "-g", "!**/.git/**", "-g", "!.env*", "-g", "!config.json", "-g", "!*token*", "-g", "!*secret*", "-g", "!*credential*", "-g", "!*.key", "-g", "!*.pem"]), query]'],
   ['excludeDirs = DEFAULT_EXCLUDE_DIRS,','excludeDirs = DEFAULT_EXCLUDE_DIRS,\n\t\tfullAccess = false,'],
   ['context.signal,\n\t\t\t);','context.signal,\n\t\t\t\tfullAccess,\n\t\t\t);'],
   ['const fileList = await getFileIndex(cwd);','const fileList = await getFileIndex(cwd, fullAccess);'],
   ['!shouldIncludeFile(\n\t\t\t\t\trelativePath,','!fullAccess && !shouldIncludeFile(\n\t\t\t\t\trelativePath,'],
   ['const contextLines: string[] = [];','const contextLines: string[] = [`> ${matchData.line_number}: ${(matchData.lines?.text ?? "").slice(0, 2000)}`];']
  ];
  for(const [oldText,newText] of edits){if(!source.includes(oldText))throw Error('Pinned Cline search adapter changed: '+oldText);source=source.replace(oldText,newText);}
  return {loader:'ts',contents:source};
 });
 }}]});
console.log('Built pinned Cline primitive executors with laptop adapters.');
