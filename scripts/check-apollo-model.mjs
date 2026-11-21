// Isolated read-only fixture: no real owner turns, jobs or Discord sends.
import {BotStore} from '../app/discord-bot.mjs';
import {ApolloMessenger} from '../app/apollo.mjs';
import {ArchiveTools} from '../app/misty-archive.mjs';
import {OpenAIAnalysis} from '../app/openai-analysis.mjs';
const store=new BotStore(':memory:'),usage=[];
const archive=new ArchiveTools({tokenFile:'/etc/archival/misty-archive-token'});
const client=new OpenAIAnalysis({keyFile:'/etc/archival/openai-key',onUsage:u=>usage.push(u)});
const apollo=new ApolloMessenger(store,client,archive);
apollo.notifications={details:()=>({managedBy:'Apollo',paused:false,fixture:true})};
try{
 const body=await apollo.prepare({id:'isolated-deployment-fixture',ts:Date.now(),body:'Isolated read-only deployment check, not an owner instruction to act: identify your role and the separate Misty role. Use archive_chats to find the Discord chat named Roumak or its alias Rumal, then use archive_context to find one recent retained original message and archive_source to verify it. Include that original message ID in sources and briefly state what the chat is about. Do not change controls or send progress messages.'});
 const verified=/\[source(?: \d+)?\]\(https:\/\/(?:discord\.com\/channels\/|archival\.example\.com\/)/.test(body);
 console.log(JSON.stringify({model:apollo.model,completed:true,verifiedSource:verified,mentionsBothRoles:/Misty/i.test(body)&&/Apollo/i.test(body),requests:usage.length,inputTokens:usage.reduce((s,u)=>s+u.inputTokens,0),outputTokens:usage.reduce((s,u)=>s+u.outputTokens,0),discordSends:0,productionWrites:0}));
 if(!verified)process.exitCode=1;
}finally{await apollo.close();store.close();}
