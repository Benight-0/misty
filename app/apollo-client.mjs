import {OpenAIAnalysis} from './openai-analysis.mjs';

// Responses can include commentary followed by final_answer, even with none
// reasoning and structured output. Only the final message is the JSON result.
// Keep complete tool rounds/phase information for continuation. Scope this to
// Apollo; the shared archive/Misty client and its workload defaults are untouched.
export function apolloFinalOutput(result){
 const output=result.output||[];
 if(output.some(item=>item.type==='function_call'))return result;
 const messages=output.filter(item=>item.type==='message');
 const final=messages.filter(item=>item.phase==='final_answer').at(-1)||messages.filter(item=>!item.phase).at(-1);
 return {...result,output:output.filter(item=>item.type!=='message'||item===final)};
}
export class ApolloAnalysis extends OpenAIAnalysis{
 constructor(options={}){
  const fetcher=options.fetchImpl||fetch;
  super({...options,fetchImpl:async(...args)=>{
   const response=await fetcher(...args);if(!response.ok)return response;
   const result=apolloFinalOutput(await response.json());
   return {ok:response.ok,status:response.status,headers:response.headers,json:async()=>result};
  }});
 }
}
