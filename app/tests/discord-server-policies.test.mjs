import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDiscordServerChoices} from '../discord-server-policies.mjs';

const inventory={complete:true,servers:[{id:'100000000000000005',name:'Priority'},{id:'100000000000000011',name:'Normal'},{id:'100000000000000014',name:'Small'},{id:'100000000000000016',name:'Ignored'},{id:'100000000000000018',name:'Pending'}]};
test('classification accepts SP, whitespace and lower case while keeping undecided entries pending',()=>{
 const text=['1. [ SP ] **Priority** - `100000000000000005`','2. [s] **Normal** - `100000000000000011`','3. [G] **Small** - `100000000000000014`','4. [I] **Ignored** - `100000000000000016`','5. [ ] **Pending** - `100000000000000018`'].join('\n');
 const manifest=parseDiscordServerChoices(text,inventory);assert.deepEqual(manifest.counts,{G:1,GP:0,S:1,SP:1,I:1,unassigned:1});assert.equal(manifest.choices[0].treatment,'SP');
});
test('classification refuses invalid labels, malformed entries, duplicate and invented IDs',()=>{
 for(const text of ['1. [X] **Priority** - `100000000000000005`','1. [S] Missing ID','1. [S] **Invented** - `100000000000000027`','1. [S] **One** - `100000000000000005`\n2. [SP] **Duplicate** - `100000000000000005`'])assert.throws(()=>parseDiscordServerChoices(text,inventory));
 assert.throws(()=>parseDiscordServerChoices('nothing',inventory));assert.throws(()=>parseDiscordServerChoices('1. [S] **One** - `100000000000000005`',{...inventory,complete:false}));
});
