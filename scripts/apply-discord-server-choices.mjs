import fs from 'node:fs';
import {ArchiveStore} from '../app/store.mjs';
import {nativeSchema} from '../app/native-ingest.mjs';
import {configureDiscordServers,nativeDiscordServerPlans} from '../app/discord-server-policies.mjs';

const [filename,manifestFile,inventoryFile]=process.argv.slice(2);
if(!filename||!manifestFile||!inventoryFile)throw Error('Usage: node scripts/apply-discord-server-choices.mjs ARCHIVE MANIFEST CHANNEL_INVENTORY');
const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8')),inventory=JSON.parse(fs.readFileSync(inventoryFile,'utf8'));
const store=new ArchiveStore(filename);
try{nativeSchema(store);configureDiscordServers(store,manifest,inventory);console.log(JSON.stringify({counts:manifest.counts,channels:nativeDiscordServerPlans(store).length,activated:store.get('discord_server_classification')}));}finally{store.close();}
