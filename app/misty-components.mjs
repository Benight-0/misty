export const clip=(text,max)=>{const value=String(text||'');let end=Math.min(max,value.length);if(end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1]))end--;return value.slice(0,end);};
const same=(a,b)=>a.kind===b.kind&&a.cwd.toLowerCase()===b.cwd.toLowerCase()&&(a.id||'')===(b.id||'');
export function choicesFor(d){
 const target=JSON.parse(d.target),saved=JSON.parse(d.candidates);
 return [target,...saved].filter((v,i,a)=>a.findIndex(t=>same(t,v))===i).slice(0,25);
}
export function taskComponents(d){
 const target=JSON.parse(d.target),options=choicesFor(d).map((t,i)=>({label:clip((t.kind==='new'?'New chat: ':'')+t.title,100),value:String(i),description:clip(t.cwd,100),default:same(t,target)}));
 const button=(action,label,style)=>({type:2,custom_id:`misty:${action}:${d.code}`,label,style});
 return [{type:1,components:[{type:3,custom_id:`misty:chat:${d.code}`,placeholder:'Choose the Codex chat',min_values:1,max_values:1,options}]},{type:1,components:[button('send','Send to Codex',3),...(target.kind==='new'?[button('work','Work on this',1)]:[]),button('edit','Edit prompt',2),button('search','Find chat',2),button('cancel','Cancel',2)]}];
}
export function taskCard(d,part,index,total){
 const target=JSON.parse(d.target),last=index===total-1;
 const embed={title:index===0?'Review task':`Exact prompt (${index+1}/${total})`,description:part,color:0x8c9eff,footer:{text:`${total>1?`Prompt ${index+1}/${total} | `:''}Draft ${d.code} | Expires in 24 hours`}};
 if(index===0)embed.fields=[{name:'Send to',value:clip((target.kind==='new'?'New chat: ':'')+target.title,200)},...(target.kind==='existing'?[{name:'Chat ID',value:target.id}]:[]),{name:'Workspace',value:clip(target.cwd,500)},{name:'Why this chat',value:clip(d.reason||'Selected by you.',500)}];
 if(index===0&&target.kind==='new')embed.fields.push({name:'Work on this',value:'Authorizes this task in its own chat, including up to 6 necessary follow-ups over 24 hours. New work needs approval. Send to Codex runs one turn.'});
 return {embeds:[embed],components:last?taskComponents(d):[]};
}
export function taskProposal(d){
 const target=JSON.parse(d.target);
 return {embeds:[{description:clip(d.reason||'I can take this to Codex.',500)+'\n\n'+clip((target.kind==='new'?'New dedicated chat: ':'Chat: ')+target.title,220),footer:{text:'Proposal '+d.code+' · nothing submitted'}}],components:[{type:1,components:[{type:2,custom_id:`misty:review:${d.code}`,label:'Review & run',style:1},{type:2,custom_id:`misty:cancel:${d.code}`,label:'Cancel',style:2}]}]};
}
export function visibleNotice(body,payload={}){
 return [body,...(payload.embeds||[]).flatMap(e=>[e.title,e.description,...(e.fields||[]).map(f=>f.name+': '+f.value)])].filter(Boolean).join('\n');
}
export const disabledCard=payload=>({...payload,embeds:(payload.embeds||[]).map(e=>({...e,color:0x58616f})),components:(payload.components||[]).map(row=>({...row,components:row.components.map(c=>({...c,disabled:true}))}))});
