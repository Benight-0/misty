import fs from 'node:fs';
import {createHash} from 'node:crypto';

const [listPath,reviewPath,outputPath]=process.argv.slice(2);
if(!outputPath)throw new Error('Usage: parse-whatsapp-group-choices.mjs LIST.md REVIEW.json OUTPUT.json');
const text=fs.readFileSync(listPath,'utf8'),review=JSON.parse(fs.readFileSync(reviewPath,'utf8'));
const sourceEntries=new Map(review.entries.map(e=>[e.number,e]));
const seen=new Set(),choices=[];
for(const line of text.split(/\r?\n/)){
 if(!/^\d+\.\s/.test(line))continue;
 const match=line.match(/^(\d+)\.\s+\[\s*([GSI]?)\s*\]\s/);
 if(!match)throw new Error('Expected G, S, I or blank on every numbered entry.');
 const number=Number(match[1]),entry=sourceEntries.get(number);
 if(!entry||seen.has(number))throw new Error('Unknown or duplicated review number.');
 seen.add(number);choices.push({...entry,treatment:match[2]});
}
if(choices.length!==review.entries.length)throw new Error('Missing review entries.');
const sourceHash=createHash('sha256').update(text).digest('hex');
let previous;try{previous=JSON.parse(fs.readFileSync(outputPath,'utf8'));}catch{}
const manifest={cutoff:previous?.sourceHash===sourceHash?previous.cutoff:Date.now(),continuousTracking:false,source:listPath,sourceHash,choices};
fs.writeFileSync(outputPath,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({cutoff:manifest.cutoff,counts:choices.reduce((n,c)=>(n[c.treatment||'unassigned']=(n[c.treatment||'unassigned']||0)+1,n),{})}));
