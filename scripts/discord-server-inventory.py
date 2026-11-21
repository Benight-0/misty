"""Read channel metadata for the explicitly selected Discord memberships only.

Run on the VM; credentials are read from its protected file and never printed.
No messages are requested and this script does not change selections.
"""
import concurrent.futures
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = 'https://discord.com/api/v9'

def main():
    manifest = json.loads(Path(sys.argv[1]).read_text())
    token = Path('/etc/archival/discord-token').read_text().strip()
    def get(path):
        for attempt in range(5):
            req = urllib.request.Request(BASE+path, headers={'Authorization':token,'User-Agent':'ArchivalLocal/1.0'})
            try:
                with urllib.request.urlopen(req,timeout=25) as r:return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code==429:
                    try:delay=float(json.load(e).get('retry_after',5))
                    except Exception:delay=5
                    print(json.dumps({'rateLimited':path.split('?')[0],'retrySeconds':round(delay,2)}),flush=True)
                    time.sleep(min(60,max(1,delay)));continue
                raise RuntimeError('HTTP '+str(e.code)) from None
            except (TimeoutError,urllib.error.URLError):
                raise RuntimeError('Network timeout or connection error') from None
        raise RuntimeError('Rate limited; retry later')
    me=get('/users/@me')
    if me['id']!='100000000000000023':raise RuntimeError('Wrong Discord account')
    guilds={g['id']:g for g in get('/users/@me/guilds?limit=200')}
    def fetch(choice):
        gid=choice['id'];g=guilds.get(gid)
        result={**choice,'channels':[],'errors':[],'skipped':0}
        if not g:result['errors'].append('No longer joined');return result
        try:
            base=int(g.get('permissions','0'))
            admin=g.get('owner') or bool(base&8)
            member=None if admin else get('/guilds/'+gid+'/members/'+me['id'])
            roles=set(member.get('roles',[])) if member else set()
            def allowed(c):
                if admin:return True
                bits=base;over=c.get('permission_overwrites',[])
                for o in over:
                    if o['id']==gid:bits=(bits&~int(o['deny']))|int(o['allow'])
                deny=allow=0
                for o in over:
                    if o['type']==0 and o['id'] in roles:deny|=int(o['deny']);allow|=int(o['allow'])
                bits=(bits&~deny)|allow
                for o in over:
                    if o['type']==1 and o['id']==me['id']:bits=(bits&~int(o['deny']))|int(o['allow'])
                return bool(bits&1024) and bool(bits&65536)
            channels=get('/guilds/'+gid+'/channels')
            parents={c['id']:c for c in channels}
            result['channels']=[c for c in channels if c['type'] in (0,5) and allowed(c)]
            result['skipped']=sum(c['type'] in (0,5) and not allowed(c) for c in channels)
            # Active threads are returned only as visible to this account.
            if choice['treatment'] in ('G','GP'):
                try:
                    for c in get('/guilds/'+gid+'/threads/active').get('threads',[]):
                        parent=parents.get(c.get('parent_id'))
                        if parent and allowed(parent):result['channels'].append(c)
                except RuntimeError as e:result['errors'].append('Active threads: '+str(e))
            else:
                result['errors'].append('Active thread inventory unavailable to this user session; visible threads are discovered live.')
            # Accessible archived threads matter for full-history G/GP treatment.
            if choice['treatment'] in ('G','GP'):
                for c in channels:
                    if c['type'] not in (0,5,15,16) or not allowed(c):continue
                    for endpoint in ('threads/archived/public','users/@me/threads/archived/private'):
                        before='';seen=set()
                        for _ in range(100):
                            try:
                                page=get('/channels/'+c['id']+'/'+endpoint+'?limit=100'+('&before='+before if before else ''))
                                threads=page.get('threads',[])
                                if threads and all(t['id'] in seen for t in threads):
                                    result['errors'].append('Archived thread pagination did not advance: '+c['id']);break
                                seen.update(t['id'] for t in threads);result['channels'].extend(threads)
                                if not page.get('has_more') or not threads:break
                                before=threads[-1]['id'] if endpoint.startswith('users/') else threads[-1]['thread_metadata']['archive_timestamp']
                            except RuntimeError as e:
                                result['errors'].append('Archived threads '+c['id']+': '+str(e));break
            unique={c['id']:{'id':c['id'],'guild_id':gid,'name':c.get('name','Discord channel'),'type':c['type'],'parent_id':c.get('parent_id','')} for c in result['channels']}
            result['channels']=list(unique.values())
        except RuntimeError as e:result['errors'].append(str(e))
        return result
    selected=[c for c in manifest['choices'] if c['treatment'] in ('S','SP','G','GP')]
    partial=Path(sys.argv[2]+'.partial');results=[]
    if partial.exists():
        saved=json.loads(partial.read_text())
        if int(time.time()*1000)-saved['at']<3600000:
            wanted={c['id']:c for c in selected}
            results=[r for r in saved['servers'] if r['id'] in wanted and r['treatment']==wanted[r['id']]['treatment'] and r['channels']]
    completed={r['id'] for r in results}
    print(json.dumps({'resumed':len(completed),'remaining':len(selected)-len(completed)}),flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(fetch,c) for c in selected if c['id'] not in completed]
        for future in concurrent.futures.as_completed(futures):
            r=future.result();results.append(r)
            Path(sys.argv[2]+'.partial').write_text(json.dumps({'at':int(time.time()*1000),'complete':False,'servers':results},ensure_ascii=False))
            print(json.dumps({'completed':len(results),'server':r['id'],'channels':len(r['channels']),'errors':r['errors']}),flush=True)
    payload={'at':int(time.time()*1000),'complete':True,'servers':results}
    Path(sys.argv[2]).write_text(json.dumps(payload,ensure_ascii=False))
    print(json.dumps({'servers':len(results),'channels':sum(len(r['channels']) for r in results),'skipped':sum(r['skipped'] for r in results),'errors':[{'id':r['id'],'errors':r['errors']} for r in results if r['errors']]}))

if __name__=='__main__':main()
