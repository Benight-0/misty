import fs from 'node:fs';

function strictSchema(schema){
  const copy=structuredClone(schema);
  const enums=new Map(),definitions={};
  function visit(value){if(!value||typeof value!=='object')return;
    if(value.type==='string'&&Array.isArray(value.enum)&&value.enum.length){const signature=JSON.stringify(value.enum);let name=enums.get(signature);if(!name){name='allowed_'+enums.size;enums.set(signature,name);definitions[name]={type:'string',enum:value.enum};}delete value.type;delete value.enum;value.$ref='#/$defs/'+name;return;}
    if(value.type==='object'){value.additionalProperties=false;value.required=Object.keys(value.properties||{});}
    for(const v of Object.values(value))if(v&&typeof v==='object')Array.isArray(v)?v.forEach(visit):visit(v);
  }
  visit(copy);if(enums.size)copy.$defs={...copy.$defs,...definitions};return copy;
}
export class OpenAIAnalysis{
  constructor({keyFile,fetchImpl=fetch,onUsage=()=>{}}={}){this.keyFile=keyFile;this.fetch=fetchImpl;this.onUsage=onUsage;}
  async generate({model,messages,schema,outputBudget,signal,room,reasoningEffort='none',tools=[],executeTool=null,_toolRound=0}){
    if(!['none','low','medium','high','xhigh','max'].includes(reasoningEffort))throw new Error('Invalid reasoning effort.');
    const key=fs.readFileSync(this.keyFile,'utf8').trim();if(!key.startsWith('sk-'))throw new Error('Analysis API key file is invalid.');
    const started=Date.now();let response;
    try{response=await this.fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},signal,
      body:JSON.stringify({model,store:false,reasoning:{effort:reasoningEffort},input:messages,max_output_tokens:outputBudget,
        ...(tools.length?{tools,parallel_tool_calls:false,tool_choice:_toolRound<5?'auto':'none',include:['reasoning.encrypted_content']}:{}),
        text:{format:{type:'json_schema',name:'archival_briefing',strict:true,schema:strictSchema(schema)}}})});}
    catch(error){if(signal?.aborted)throw error;throw new Error('Analysis API connection failed; the batch remains queued.');}
    if(!response.ok){const status=response.status,header=response.headers?.get?.('retry-after');
      const retry=Number(header)||Math.max(0,(Date.parse(header)-Date.now())/1000)||0;
      const error=new Error('Analysis API returned HTTP '+status+(retry?' (retry after '+Math.ceil(retry)+' seconds)':'')+'. No messages or credentials were logged.');
      // Share upstream backoff across parallel lanes, without blocking collection or the UI.
      if(status===429||status===503){error.retryAt=Date.now()+Math.max(1000,(retry||20)*1000);this.retryAt=Math.max(this.retryAt||0,error.retryAt);}
      throw error;}
    let result;try{result=await response.json();}catch{throw new Error('Analysis API returned an unreadable response.');}
    const usage=result.usage||{};
    this.onUsage({room,model,requestId:result.id||'',at:Date.now(),inputTokens:usage.input_tokens||0,outputTokens:usage.output_tokens||0,cachedTokens:usage.input_tokens_details?.cached_tokens||0,status:result.status||''});
    if(result.status!=='completed')throw new Error('Analysis API output was incomplete; this batch remains queued.');
    const calls=(result.output||[]).filter(o=>o.type==='function_call');
    if(calls.length){
      if(!executeTool||_toolRound>=5||calls.length>2)throw new Error('Archive tool budget exceeded.');
      const outputs=[];
      for(const call of calls){let value;
        try{if(!tools.some(t=>t.name===call.name))throw Error();value=await executeTool(call.name,JSON.parse(call.arguments));}
        catch{value={error:'Tool request rejected or temporarily unavailable. No action was taken.'};}
        let output=JSON.stringify(value);if(Buffer.byteLength(output)>140000)output=JSON.stringify({error:'Result exceeded tool budget; narrow the query.'});
        outputs.push({type:'function_call_output',call_id:call.call_id,output});
      }
      return this.generate({model,messages:[...messages,...result.output,...outputs],schema,outputBudget,signal,room,reasoningEffort,tools,executeTool,_toolRound:_toolRound+1});
    }
    const parts=(result.output||[]).filter(o=>o.type==='message').flatMap(o=>o.content||[]);
    if(parts.some(p=>p.type==='refusal'))throw new Error('Analysis API declined this batch; the original history remains stored.');
    const text=parts.filter(p=>p.type==='output_text').map(p=>p.text).join('');
    if(!text)throw new Error('Analysis API returned no analysis text.');
    return {message:{content:text},done_reason:'stop',prompt_eval_count:usage.input_tokens||0,eval_count:usage.output_tokens||0,total_duration:(Date.now()-started)*1e6,request_id:result.id||'',reasoning_effort:reasoningEffort,reasoning_tokens:usage.output_tokens_details?.reasoning_tokens||0};
  }
}
export {strictSchema};
