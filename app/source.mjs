import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const joined = "SELECT room_id FROM current_state_events WHERE type='m.room.member' AND state_key='@owner:localhost' AND membership='join'";
const bridged = 'SELECT DISTINCT c.room_id FROM current_state_events c WHERE c.type=\'m.bridge\' AND c.room_id IN (' + joined + ')';

export function sourceSql(cursor = 0, metadata = true) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid source cursor');
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='90s';
${metadata ? `SELECT json_build_object('kind','room','id',r.room_id,'state',jsonb_object_agg(c.type,j.json::jsonb->'content'))
FROM (${joined}) r JOIN current_state_events c ON c.room_id=r.room_id JOIN event_json j ON j.event_id=c.event_id
WHERE c.type IN ('m.room.name','m.room.create','m.bridge','m.room.encryption','m.room.topic')
GROUP BY r.room_id;
SELECT json_build_object('kind','identity','id',p.full_user_id,'name',p.displayname) FROM profiles p WHERE p.full_user_id IS NOT NULL;
` : ''}
SELECT json_build_object('kind','event','stream',e.stream_ordering,'received',e.received_ts,'event',j.json::jsonb || jsonb_build_object('event_id',e.event_id,'room_id',e.room_id))
FROM events e JOIN event_json j ON j.event_id=e.event_id
WHERE ${cursor === 0 ? 'TRUE' : 'e.stream_ordering > '+cursor} AND e.outlier=false AND e.rejection_reason IS NULL
AND e.type IN ('m.room.message','m.sticker','m.room.redaction','m.room.encrypted','fi.mau.discord.history','com.beeper.message_send_status')
AND e.room_id IN (${bridged})
AND NOT EXISTS(SELECT 1 FROM redactions r WHERE r.redacts=e.event_id)
ORDER BY e.stream_ordering;
SELECT json_build_object('kind','redacted','id',r.redacts) FROM redactions r JOIN events e ON e.event_id=r.event_id
WHERE e.stream_ordering > ${cursor} AND e.room_id IN (${bridged});
SELECT json_build_object('kind','watermark','cursor',coalesce(max(stream_ordering),0),'messages',count(*) FILTER (WHERE type='m.room.message')) FROM events;
COMMIT;`;
}

export async function readSource(cursor, metadata, onRecord) {
  const start = performance.now();
  const child = spawn('docker', ['compose','exec','-T','postgres','psql','-U','synapse','-d','synapse','-qAt','-v','ON_ERROR_STOP=1'], {
    cwd: workspace, windowsHide: true, stdio: ['pipe','pipe','pipe'],
  });
  let buffer = '', errorText = '', count = 0, parseError;
  child.stderr.on('data', chunk => { errorText += chunk.toString().slice(0, 4000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,index).trim(); buffer = buffer.slice(index+1);
      if (!line.startsWith('{')) continue;
      try { onRecord(JSON.parse(line)); count++; }
      catch (err) { parseError = err; child.kill(); return; }
    }
  });
  const timer = setTimeout(() => child.kill(), 120000);
  child.stdin.end(sourceSql(cursor, metadata));
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => {
        if (parseError) reject(parseError);
        else if (code !== 0) reject(new Error('Local database read failed. Ensure Docker Desktop and the messaging stack are running. ' + (errorText.includes('timeout') ? 'Database query timed out.' : '')));
        else resolve();
      });
    });
    return { records: count, durationMs: Math.round(performance.now()-start) };
  } finally { clearTimeout(timer); }
}

// Keep the local psql pipe open: no Docker startup on every incremental poll.
// The marker is emitted only after COMMIT, so SQLite can commit its checkpoint safely.
export class LiveSource {
  constructor() { this.child=null; this.pending=null; this.buffer=''; }
  open() {
    if(this.child) return;
    const child=spawn('docker',['compose','exec','-T','postgres','psql','-U','synapse','-d','synapse','-qAt','-v','ON_ERROR_STOP=1'],{cwd:workspace,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child=child;
    child.stdout.setEncoding('utf8');
    child.stderr.on('data',()=>{});
    child.stdout.on('data',chunk=>{
      this.buffer+=chunk;
      let n;
      while((n=this.buffer.indexOf('\n'))>=0) {
        const line=this.buffer.slice(0,n).trim();this.buffer=this.buffer.slice(n+1);
        const job=this.pending;
        if(!job || !line.startsWith('{'))continue;
        try {
          const row=JSON.parse(line);
          if(row.kind==='done') {clearTimeout(job.timer);this.pending=null;job.resolve({records:job.count,durationMs:Math.round(performance.now()-job.start)});}
          else {job.onRecord(row);job.count++;}
        } catch(error) {this.fail(error);}
      }
    });
    child.on('error',()=>this.fail(new Error('Cannot start the local database reader. Is Docker running?')));
    child.on('close',()=>{if(this.child===child){this.child=null;this.buffer='';this.fail(new Error('Local database reader stopped. It will reconnect automatically.'));}});
    child.stdin.on('error',()=>this.fail(new Error('Local database connection closed.')));
  }
  fail(error) {
    const job=this.pending;this.pending=null;
    if(job){clearTimeout(job.timer);job.reject(error);}
    const child=this.child;this.child=null;this.buffer='';child?.kill();
  }
  read(cursor,metadata,onRecord) {
    if(this.pending) return Promise.reject(new Error('A database snapshot is already running'));
    this.open();
    return new Promise((resolve,reject)=>{
      const job={resolve,reject,onRecord,start:performance.now(),count:0};
      job.timer=setTimeout(()=>this.fail(new Error('Local database query timed out.')),120000);
      this.pending=job;
      this.child.stdin.write(sourceSql(cursor,metadata)+"\nSELECT json_build_object('kind','done');\n");
    });
  }
  close(){this.fail(new Error('Reader closed'));}
}
