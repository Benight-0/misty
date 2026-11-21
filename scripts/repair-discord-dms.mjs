// Reconcile only history newer than each DM's verified pre-recovery checkpoint.
import fs from 'node:fs/promises';
import {ArchiveStore} from '../app/store.mjs';
import {archivePath} from '../app/import.mjs';
import {MatrixController} from '../app/matrix.mjs';
import {setTimeout as pause} from 'node:timers/promises';
const plan=JSON.parse(await fs.readFile(new URL('../data/diagnostics/dm-repair-plan.json',import.meta.url),'utf8'));
const target=process.argv[2];
const selected=target?plan.filter(p=>p.channel===target):plan;
if(!selected.length)throw new Error('No matching private chats in pre-recovery checkpoint');
const store=new ArchiveStore(archivePath),matrix=new MatrixController(store);
try {
  for(const entry of selected){
    const expected=`DM reconciliation finished for ${entry.channel}; delivery verified`;
    const result=await matrix.command('discord',`repair-dm ${entry.channel} ${entry.after}`,{timeout:180000,acceptReply:c=>c.body?.startsWith(expected)||c.body?.startsWith(`DM reconciliation failed for ${entry.channel}:`)||/Enable Matrix double puppeting|Could not read DM|Invalid Discord|DM is not already connected/.test(c.body||'')});
    console.log(JSON.stringify({channel:entry.channel,pending:!!result.pending,response:result.body}));
    if(result.pending||!result.body?.startsWith(expected))throw new Error('Reconciliation did not confirm completion; stopping');
    await pause(2000);
  }
}finally{store.close();}
