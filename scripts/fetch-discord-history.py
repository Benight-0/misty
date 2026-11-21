"""Linux reader. Credentials stay in memory; stdout is private JSONL consumed by Archival."""
import collections, concurrent.futures, http.client, json, sqlite3, sys, threading, time

DB='file:/database/bridge.db?mode=ro'
with sqlite3.connect(DB,uri=True) as db:
    token=db.execute('SELECT discord_token FROM user WHERE mxid=?',('@owner:localhost',)).fetchone()[0]
jobs=collections.deque(json.loads(sys.stdin.readline()))
local=threading.local()
global_lock=threading.Lock()
global_retry_until=0

def fetch(channel,before):
    global global_retry_until
    query='?limit=100'+('&before='+before if before else '')
    for attempt in range(6):
        try:
            with global_lock: wait_until=global_retry_until
            time.sleep(max(0,wait_until-time.monotonic(),getattr(local,'next_allowed',0)-time.monotonic()))
            if not getattr(local,'connection',None):local.connection=http.client.HTTPSConnection('discord.com',timeout=40)
            captured=int(time.time()*1000)
            local.connection.request('GET','/api/v9/channels/'+channel+'/messages'+query,headers={'Authorization':token,'User-Agent':'Mozilla/5.0'})
            response=local.connection.getresponse();payload=response.read()
            if response.will_close:local.connection.close();local.connection=None
            if response.status==200:
                delay=.25
                if response.getheader('X-RateLimit-Remaining')=='0':delay=max(delay,float(response.getheader('X-RateLimit-Reset-After','1')))
                local.next_allowed=time.monotonic()+delay
                return json.loads(payload),captured
            if response.status in (401,403,404):raise RuntimeError('Discord returned HTTP '+str(response.status))
            if response.status==429:
                try:
                    info=json.loads(payload);delay=float(info.get('retry_after',5))
                    if info.get('global'):
                        with global_lock:global_retry_until=max(global_retry_until,time.monotonic()+delay)
                except Exception:delay=15
            else:delay=min(60,5*2**attempt)
        except RuntimeError:raise
        except Exception:
            if getattr(local,'connection',None):local.connection.close();local.connection=None
            delay=min(60,5*2**attempt)
        time.sleep(max(1,delay))
    raise RuntimeError('Discord history request failed after retries')

def fetch_page(job):
    channel=job['channel'];before=job.get('before_id','')
    if not channel.isdigit() or (before and not before.isdigit()):raise SystemExit('Invalid channel or cursor')
    try:
        messages,captured=fetch(channel,before)
        if not isinstance(messages,list):raise RuntimeError('Invalid Discord history response')
        ids=[m['id'] for m in messages]
        if len(ids)!=len(set(ids)) or (before and any(int(i)>=int(before) for i in ids)):raise RuntimeError('Discord returned an overlapping history page')
        links=[]
        if ids or len(messages)<100:
            with sqlite3.connect(DB,uri=True) as db:
                sql='SELECT dcid,mxid FROM message WHERE dc_chan_id=?'
                args=[channel]
                if len(messages)==100:sql+=' AND dcid IN ('+','.join('?' for _ in ids)+')';args+=ids
                links=[{'remote_id':r[0],'event_id':r[1]} for r in db.execute(sql+' ORDER BY dc_attachment_id',args)]
        next_before=str(min(int(i) for i in ids)) if ids else before
        if before and ids and int(next_before)>=int(before):raise RuntimeError('History cursor did not move backward')
        page={'room':job['room'],'channel':channel,'messages':messages,'links':links,'from_before':before,'before_id':next_before,'complete':len(messages)<100,'fetched_at':captured}
    except Exception as error:
        page={'room':job['room'],'channel':channel,'error':str(error) if isinstance(error,RuntimeError) else 'History reader failed'}
    return page

# At most three independent channels in flight; stdout and checkpoint acknowledgements remain serial.
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    pending={}
    while jobs or pending:
        while jobs and len(pending)<3:
            job=jobs.popleft();pending[pool.submit(fetch_page,job)]=job
        done,_=concurrent.futures.wait(pending,return_when=concurrent.futures.FIRST_COMPLETED)
        for future in done:
            job=pending.pop(future);page=future.result()
            print(json.dumps(page,separators=(',',':')),flush=True)
            ack=sys.stdin.readline().strip()
            if not ack:jobs.clear();break
            if ack=='ok' and not page.get('error') and not page['complete']:
                job['before_id']=page['before_id']
                if job['channel']=='100000000000000037':jobs.appendleft(job)
                else:jobs.append(job)
        if not ack:break
