import {createDefaultTools} from './vendor/sdk/packages/core/src/extensions/tools/definitions';
import {createFileReadExecutor} from './vendor/sdk/packages/core/src/extensions/tools/executors/file-read';
import {createSearchExecutor} from './vendor/sdk/packages/core/src/extensions/tools/executors/search';
import {createShellExecutor} from './vendor/sdk/packages/core/src/extensions/tools/executors/bash';
import {createWebFetchExecutor} from './vendor/sdk/packages/core/src/extensions/tools/executors/web-fetch';
import {createApplyPatchExecutor,computePatchChanges} from './vendor/sdk/packages/core/src/extensions/tools/executors/apply-patch';
import {createEditorExecutor} from './vendor/sdk/packages/core/src/extensions/tools/executors/editor';
export {computePatchChanges};
export function makeTools(cwd:string,fullAccess=false) {
 const executors={readFile:createFileReadExecutor(),search:createSearchExecutor({maxResults:50,fullAccess}),
  bash:createShellExecutor({timeoutMs:30000,maxOutputChars:24000}),webFetch:createWebFetchExecutor({maxResponseBytes:1000000}),
  applyPatch:createApplyPatchExecutor(),editor:createEditorExecutor()};
 const common={executors,cwd,enableSkills:false,enableAskQuestion:false,enableSubmitAndExit:false};
 // Both editing forms exist in the interface; callers choose one per operation.
 const base=createDefaultTools({...common,enableEditor:false,enableApplyPatch:true});
 return [...base,...createDefaultTools({...common,enableReadFiles:false,enableSearch:false,enableBash:false,enableWebFetch:false,enableEditor:true})];
}
