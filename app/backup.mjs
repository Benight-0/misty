import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { archivePath } from './import.mjs';
const directory=fileURLToPath(new URL('../data/app/backups/',import.meta.url));
fs.mkdirSync(directory,{recursive:true});
const filename=directory+'archival-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite';
const db=new DatabaseSync(archivePath);db.exec('PRAGMA busy_timeout=15000');
try{db.exec("VACUUM INTO '"+filename.replace(/'/g,"''")+"'");}finally{db.close();}
const backup=new DatabaseSync(filename,{readOnly:true});
try {
  if(backup.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Backup verification failed');
  console.log('Consistent local backup saved and verified: '+filename);
}finally{backup.close();}
