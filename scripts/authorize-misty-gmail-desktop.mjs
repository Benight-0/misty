// Reauthorize the existing Archival Desktop OAuth client for VM read-only sync.
// The result is staged locally and must be transferred through the maintenance SSH connection.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ArchiveStore} from '../app/store.mjs';
import {Gmail,GMAIL_SCOPE,GMAIL_SEND_SCOPE} from '../app/gmail.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=path.join(root,'data/gmail/credentials.json');
const directory=path.join(root,'data/deployment/misty-gmail-auth');
const original=JSON.parse(await fs.readFile(source,'utf8'));
const expected=Object.keys(original.accounts||{});
if(expected.length!==1||!original.client?.client_id||!original.client?.client_secret)
  throw new Error('Expected one existing Archival Desktop OAuth account and client.');
await fs.mkdir(directory,{recursive:true,mode:0o700});
if(process.platform==='win32') {
  const user=execFileSync('whoami.exe',{encoding:'utf8'}).trim();
  execFileSync('icacls.exe',[directory,'/grant:r',`${user}:(OI)(CI)F`,'SYSTEM:(OI)(CI)F','Administrators:(OI)(CI)F'],{stdio:'ignore'});
  execFileSync('icacls.exe',[directory,'/inheritance:r'],{stdio:'ignore'});
} else await fs.chmod(directory,0o700);
const store=new ArchiveStore(':memory:');
const gmail=new Gmail(store,fn=>Promise.resolve().then(fn),{directory,readOnly:true});
gmail.wake=()=>{};
let authorized=false;
try {
  await gmail.ready;
  if(Object.keys(gmail.vault.accounts).length)throw new Error('Staged authorization already exists; inspect it before starting another.');
  await gmail.configure({installed:original.client});
  const {url}=await gmail.authorize();
  console.log('Open this Google sign-in URL in your browser and approve Gmail read-only access:');
  console.log(url);
  const deadline=Date.now()+10*60*1000;
  while(Date.now()<deadline && !gmail.vault.accounts[expected[0]])
    await new Promise(resolve=>setTimeout(resolve,1000));
  const linked=gmail.vault.accounts[expected[0]];
  if(!linked)throw new Error('Google sign-in was not completed for the existing mailbox within ten minutes.');
  if(!linked.scopes.includes(GMAIL_SCOPE)||linked.scopes.includes(GMAIL_SEND_SCOPE))
    throw new Error('Google did not grant only Gmail read access. The staged authorization will not be transferred.');
  await gmail.accessToken(expected[0],true);
  if(!linked.scopes.includes(GMAIL_SCOPE)||linked.scopes.includes(GMAIL_SEND_SCOPE))
    throw new Error('The refreshed Google token has broader scope than Gmail read-only. It will not be transferred.');
  authorized=true;
  console.log('Gmail read-only authorization refreshed and staged at '+path.join(directory,'credentials.json'));
} finally {
  await gmail.close();
  store.close();
  if(!authorized)await fs.rm(path.join(directory,'credentials.json'),{force:true});
}
