import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ArchiveStore } from './store.mjs';
import { readSource } from './source.mjs';

export const archivePath=fileURLToPath(new URL('../data/app/archive.sqlite',import.meta.url));
export async function importArchive(store,{full=false,metadata=true,reader=readSource}={}) {
  const cursor=full ? 0 : store.get('stream_cursor',0);
  const start=Date.now();
  let transaction=false;
  try {
    const records=[];
    const result=await reader(cursor,metadata,row=>records.push(row));
    store.begin({dedupe:full}); transaction=true;
    if (metadata) store.db.exec("UPDATE conversations SET source_joined=0 WHERE platform<>'gmail'");
    for(const row of records)store.ingest(row);
    store.refreshCounts();
    const status={ok:true,at:Date.now(),durationMs:Date.now()-start,sourceDurationMs:result.durationMs,records:result.records,cursor:store.get('stream_cursor',0),full,metadata};
    store.set('sync_status',status);
    if(full)store.set('last_full_sync',status);
    store.commit();
    return result;
  } catch (error) {
    if(transaction)store.rollback();
    store.set('sync_status',{ok:false,at:Date.now(),error:error.message});
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const store=new ArchiveStore(archivePath);
  try {
    console.log('Importing available local chat history...');
    console.log(JSON.stringify(await importArchive(store,{full:process.argv.includes('--full')})));
    fs.writeFileSync(fileURLToPath(new URL('../data/app/own-messages.json',import.meta.url)),JSON.stringify(store.ownCorpus(),null,2));
    console.log(JSON.stringify(store.stats()));
  } finally {store.close();}
}
