// Read-only live provenance check. Never publishes a sample, modifies Chrome,
// invokes Codex, sends a DM, or writes raw titles/URLs to verification artifacts.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {readChrome} from '../app/laptop-activity-local.mjs';
import {normalizeChrome,LaptopActivityStore,FRESH_MS} from '../app/laptop-activity.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=path.join(root,'data/deployment/laptop-activity');
const evidence=path.join(root,'data/deployment/misty-laptop-activity');
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const startedAt=Date.now(),native=new Map();
const database=new DatabaseSync(path.join(data,'outbox.sqlite'),{readOnly:true});database.exec('PRAGMA busy_timeout=1000');
let local;
try{
 while(Date.now()-startedAt<65000){
  const raw=readChrome(path.join(data,'chrome'));
  if(raw?.capturedAt){const chrome=normalizeChrome(raw);native.set(chrome.capturedAt,{tabsHash:hash(chrome.tabs),profilesHash:hash(chrome.profiles),observedAt:Date.now()});}
  for(const row of database.prepare('SELECT id,captured,body FROM activity_outbox WHERE captured>=? ORDER BY captured DESC LIMIT 3').all(startedAt)){
   const sample=JSON.parse(row.body),source=native.get(sample.chrome?.capturedAt);
   if(source&&source.tabsHash===hash(sample.chrome.tabs)&&source.profilesHash===hash(sample.chrome.profiles)){
    local={id:row.id,capturedAt:row.captured,bodyHash:hash(row.body),chromeCapturedAt:sample.chrome.capturedAt,tabsHash:source.tabsHash,profilesHash:source.profilesHash,nativeObservedAt:source.observedAt};break;
   }
  }
  if(local)break;
  await sleep(40);
 }
}finally{database.close();}
if(!local)throw Error('No new extension-backed outbox sample observed within 65 seconds. No data was fabricated or published.');
// Wait for the actual collector acknowledgement, not a verification replay.
let acknowledged;
for(let attempt=0;attempt<100;attempt++){
 const status=readJSON(path.join(data,'status.json'));
 if(status.capturedAt===local.capturedAt&&status.receivedAt&&status.link==='online'&&!status.error){acknowledged=status;break;}
 await sleep(50);
}
if(!acknowledged)throw Error('Collector acknowledgement was not observed.');
const remote=String.raw`
import hashlib,json,sqlite3,subprocess,time
from pathlib import Path
target=${JSON.stringify(local.id)}
stamp=lambda:int(time.time()*1000)
before=stamp()
command=['runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json','/opt/misty-prominence/venv/bin/python','/opt/misty-prominence/misty.py','activity','read']
activity=json.loads(subprocess.check_output(command,text=True,timeout=20));after=stamp()
current=activity['current'];status=activity['status']
assert current['id']==target,'Current sample changed before Misty read; rerun read-only trace'
with sqlite3.connect('file:/var/lib/misty-bot/laptop-activity.sqlite?mode=ro',uri=True) as db:
 row=db.execute('SELECT captured,received,body FROM laptop_activity_samples WHERE id=?',(target,)).fetchone()
assert row and row[0]==current['capturedAt'] and row[1]==status['receivedAt']
body=json.loads(row[2]);assert body==current
digest=lambda value:hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
chrome=current['chrome'];tabs=chrome['tabs']
assert chrome['state']=='available' and tabs
assert all(isinstance(t['title'],str) and isinstance(t['url'],str) and type(t['activeInWindow']) is bool and type(t['windowFocused']) is bool for t in tabs)
assert status['captureAgeMs']<=90000 and status['receiptAgeMs']<=90000 and status['state']!='offline_or_stale'
if (current.get('foreground') or {}).get('application','').lower()!='chrome' or current['sessionState']!='active':assert chrome.get('currentTab') is None
workflows=json.loads(Path('/var/lib/misty-prominence/workflows.json').read_text())['workflows']
jobs=[w for w in workflows.values() if w.get('kind')=='laptop_activity'];assert len(jobs)==1
w=jobs[0];assert w['id']=='laptop-activity-15m' and w['schedule']=={'every':900} and w['enabled']
services={name:subprocess.check_output(['systemctl','is-active',name],text=True).strip() for name in ['misty-activity','misty-prominence','misty-bot','apollo-bot','archival','cloudflared','misty-metrics','misty-metrics-collect.timer']}
manifest=json.loads(Path('/tmp/archival-migration/misty-laptop-activity/deployment.json').read_text())
deployed={p:hashlib.sha256(Path(p).read_bytes()).hexdigest()==v for p,v in manifest['hashes'].items()}
print(json.dumps({'sampleId':target,'capturedAt':row[0],'receivedAt':row[1],
 'vmReadStartedAt':before,'vmReadFinishedAt':after,'dbBodyHash':hashlib.sha256(row[2].encode()).hexdigest(),'mistyBodyHash':digest(current),
 'tabsHash':digest(tabs),'profilesHash':digest(chrome['profiles']),'chromeCapturedAt':chrome['capturedAt'],
 'state':status['state'],'locked':current['locked'],'idleSeconds':current['idleSeconds'],
 'captureAgeMs':status['captureAgeMs'],'receiptAgeMs':status['receiptAgeMs'],
 'foregroundApplication':(current.get('foreground') or {}).get('application'),'openWindows':len(current['windows']),
 'chrome':{'state':chrome['state'],'tabs':len(tabs),'titlesPresent':sum(bool(t['title']) for t in tabs),'urlsPresent':sum(bool(t['url']) for t in tabs),
 'profiles':len(chrome['profiles']),'windows':len(set(t['windowId'] for t in tabs)),
 'activeInWindowTabs':sum(t['activeInWindow'] for t in tabs),'focusedChromeWindows':len(set(t['windowId'] for t in tabs if t['windowFocused'])),
 'currentForegroundTabKnown':bool(chrome.get('currentTab')),'truncated':chrome['truncated'],
 'coverage':chrome['coverage'],'titlesAndURLsOmitted':True},
 'services':services,'deployedHashesMatch':deployed,
 'workflow':{k:w.get(k) for k in ['id','enabled','schedule','runs','last_run','next_run','history']}}))
`;
const requestSentAt=Date.now();
const vm=await new Promise((resolve,reject)=>{
 const child=spawn('ssh.exe',['-F',path.join(root,'data/deployment/ssh_config'),'-o','ConnectTimeout=12','archival-vm','sudo python3 -'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let output='',error='';const timer=setTimeout(()=>{child.kill();reject(Error('Read-only VM verification timed out.'));},30000);
 child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{error+=b;});child.on('error',reject);
 child.on('close',code=>{clearTimeout(timer);if(code)return reject(Error('VM trace failed: '+error.slice(-1200)));try{resolve(JSON.parse(output));}catch{reject(Error('Invalid VM trace result.'));}});child.stdin.end(remote);
});
const responseReceivedAt=Date.now();
for(const [label,left,right] of [['payload',local.bodyHash,vm.dbBodyHash],['Misty read',local.bodyHash,vm.mistyBodyHash],['Chrome tabs',local.tabsHash,vm.tabsHash],['Chrome profiles',local.profilesHash,vm.profilesHash]])if(left!==right)throw Error(label+' hash mismatch.');
if(vm.receivedAt!==acknowledged.receivedAt)throw Error('Acknowledged and persisted receipt differ.');
if(!Object.values(vm.deployedHashesMatch).every(Boolean))throw Error('Deployed components changed; review rather than overwrite.');
if(!Object.values(vm.services).every(value=>value==='active'))throw Error('An existing service is not active.');
// Check the actual freshness implementation against the observed timestamp lead.
// This in-memory fixture is ONLY a clock-boundary test, never Chrome evidence.
const base=Date.now(),lead=Math.max(0,vm.capturedAt-vm.receivedAt),clockDB=new DatabaseSync(':memory:');let now=base;
const store=new LaptopActivityStore(clockDB,{pairedWorker:()=> 'verification-only',clock:()=>now});
store.ingest({worker:'verification-only',samples:[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',capturedAt:base+lead,sessionState:'active',windows:[],chrome:null}]});
const immediate=store.status();if(immediate.state!=='active'||immediate.captureAgeMs!==0||immediate.receiptAgeMs!==0)throw Error('Small forward skew misclassified.');
now=base+FRESH_MS+1;const expired=store.status();if(expired.state!=='offline_or_stale')throw Error('Receipt age failed to expire skewed capture.');clockDB.close();
const extension=readJSON(path.join(root,'chrome/misty-activity/manifest.json'));
const nativeManifest=readJSON(path.join(data,'native-host/com.misty.laptop_activity.json'));
const installed=[];const chromeRoot=path.join(process.env.LOCALAPPDATA,'Google/Chrome/User Data');
for(const dir of fs.readdirSync(chromeRoot,{withFileTypes:true}).filter(d=>d.isDirectory()&&/^(Default|Profile \d+)$/.test(d.name)))try{
 const preferences=readJSON(path.join(chromeRoot,dir.name,'Secure Preferences'));
 const entry=preferences.extensions?.settings?.clnjolnlpoaldfhajekdaefgdenomkfd;
 if(entry)installed.push({profileDirectory:dir.name,pathMatches:path.resolve(entry.path).toLowerCase()===path.join(root,'chrome/misty-activity').toLowerCase(),disableReasons:entry.disable_reasons||[],permissions:entry.active_permissions?.api||[]});
}catch{}
const tasks=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-ScheduledTask -TaskName 'Misty Laptop Activity','Misty Codex Relay' | Select-Object TaskName,@{n='State';e={$_.State.ToString()}} | ConvertTo-Json -Compress"],{windowsHide:true,encoding:'utf8'}));
const report={verifiedAt:new Date().toISOString(),readOnlyVerification:true,testDMsSent:0,
 chain:{extensionAPI:'chrome.windows.getAll({populate:true}) + nativeMessaging',extensionId:'clnjolnlpoaldfhajekdaefgdenomkfd',permissions:extension.permissions,installedProfiles:installed,nativeAllowedOrigins:nativeManifest.allowed_origins,
 nativeCacheMatchedOutbox:true,outboxMatchedVMDatabase:true,mistyReadMatchedDatabase:true,collectorAcknowledgementMatchedReceipt:true},
 local,vm,transportRoundTrip:{requestSentAt,responseReceivedAt},
 clockCheck:{observedCaptureMinusReceiptMs:vm.capturedAt-vm.receivedAt,freshnessThresholdMs:FRESH_MS,smallSkewState:immediate.state,smallSkewCaptureAgeMs:immediate.captureAgeMs,afterReceiptExpiryState:expired.state,systemClocksChanged:false},tasks};
fs.writeFileSync(path.join(evidence,'fresh-chrome-trace.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
