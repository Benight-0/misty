import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('a clean installation seeds no connected identity and cannot contact an owner bot',()=>{
 const env={...process.env};
 for(const name of ['MISTY_OWNER_DISCORD_ID','MISTY_OWNER_WHATSAPP_PHONE','MISTY_OWNER_WHATSAPP_LID','ARCHIVAL_ACCESS_EMAIL'])delete env[name];
 const script="const {SELF_IDENTITIES}=await import('./app/identity.mjs');const {BOT_OWNER,BotAPI}=await import('./app/discord-bot.mjs');let calls=0;let refused=false;try{await new BotAPI({fetchImpl:()=>{calls++;throw Error('network must not run')}}).connect()}catch(e){refused=e.message.includes('MISTY_OWNER_DISCORD_ID')}console.log(JSON.stringify({count:SELF_IDENTITIES.length,owner:BOT_OWNER,calls,refused}))";
 const actual=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env,encoding:'utf8'}));
 assert.deepEqual(actual,{count:1,owner:'',calls:0,refused:true});
});

test('public source links accept only the configured archive origin and Discord channels',async()=>{
 const {safePublicSourceLink}=await import('../owner-config.mjs');
 assert.equal(safePublicSourceLink('https://archival.example.com/?source=example'),true);
 assert.equal(safePublicSourceLink('https://discord.com/channels/example'),true);
 for(const url of ['http://archival.example.com/','https://archival.example.com.evil.test/','https://user:password@archival.example.com/','https://evil.test/'])assert.equal(safePublicSourceLink(url),false);
});