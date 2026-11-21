"""Install Apollo and hand off the one notification worker. Run as root on VM."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time

APOLLO=('app/apollo.mjs','app/discord-bot.mjs','app/openai-analysis.mjs','app/misty-archive.mjs','app/misty-notifications.mjs','scripts/apollo-discord-bot.mjs')
MISTY=('app/misty-notifications.mjs','app/misty-prominence-bridge.mjs','app/misty-knowledge.mjs','app/misty-archive.mjs','scripts/misty-discord-bot.mjs')
NODE='/opt/misty-bot/bin/node'

def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def readonly(filename):return sqlite3.connect('file:'+str(filename)+'?mode=ro',uri=True)
def install(source,target):
    target=Path(target);target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(source,target);target.chmod(0o644)

def main():
    import pwd
    assert os.geteuid()==0
    stage=Path(sys.argv[1]).resolve();identity=json.loads((stage/'identity.json').read_text())
    assert identity['id']!='100000000000000045' and identity['name'].lower()=='apollo'
    for relative in (*APOLLO,*MISTY,'prominence/misty_context.py','scripts/apollo-bot.service','scripts/handoff-apollo.py'):
        assert (stage/relative).is_file(),relative
    assert (stage/'discord-token').is_file() and 50<len((stage/'discord-token').read_text().strip())<200
    with readonly('/var/lib/misty-prominence/inbox.sqlite') as db:
        assert not db.execute("SELECT 1 FROM inbox WHERE state IN ('running','delivering') LIMIT 1").fetchone(),'Owner turn active; retry after it finishes.'
    with readonly('/var/lib/misty-bot/chat.sqlite') as db:
        row=db.execute("SELECT value FROM bot_settings WHERE key='conversation_monitor'").fetchone()
        assert not row or json.loads(row[0])!='apollo','Already handed off; use a targeted repair, not a new migration.'
    assert not Path('/var/lib/apollo-bot/chat.sqlite').exists(),'Apollo database already exists; inspect it before proceeding.'
    try:account=pwd.getpwnam('apollo-bot')
    except KeyError:
        run('useradd','--system','--home','/var/lib/apollo-bot','--shell','/usr/sbin/nologin','apollo-bot');account=pwd.getpwnam('apollo-bot')
    Path('/etc/apollo-bot').mkdir(mode=0o700,exist_ok=True)
    shutil.copyfile(stage/'discord-token','/etc/apollo-bot/discord-token');Path('/etc/apollo-bot/discord-token').chmod(0o600)
    for relative in APOLLO:install(stage/relative,Path('/opt/apollo-bot')/relative)
    for relative in APOLLO:
        if relative.endswith('.mjs'):run(NODE,'--check',str(Path('/opt/apollo-bot')/relative))
    run('systemd-analyze','verify',str(stage/'scripts/apollo-bot.service'))
    dest=Path('/var/lib/apollo-bot');dest.mkdir(mode=0o700,exist_ok=True);os.chown(dest,account.pw_uid,account.pw_gid)
    init="""import {BotStore} from './app/discord-bot.mjs';import {ApolloMessenger} from './app/apollo.mjs';import {MistyNotifications} from './app/misty-notifications.mjs';const s=new BotStore('/var/lib/apollo-bot/chat.sqlite');const a=new ApolloMessenger(s,{},{});new MistyNotifications(a,{}, {name:'Apollo'});s.close();"""
    run(NODE,'--disable-warning=ExperimentalWarning','--input-type=module','-e',init,cwd='/opt/apollo-bot')
    backup=Path('/var/lib/misty-bot/apollo-before-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime()));backup.mkdir(mode=0o700)
    targets={r:str(Path('/opt/misty-bot')/r) for r in MISTY};targets['prominence/misty_context.py']='/opt/misty-prominence/misty_context.py'
    # Stop both receivers after the idle check. The collector/archive stays online.
    run('systemctl','stop','misty-prominence','misty-bot')
    for relative,target in targets.items():
        saved=backup/relative;saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,saved)
    for label,filename in [('bridge','/var/lib/misty-bot/chat.sqlite'),('fork','/var/lib/misty-prominence/inbox.sqlite')]:
        with readonly(filename) as source,sqlite3.connect(backup/(label+'.sqlite')) as db:source.backup(db)
    committed=False
    try:
        for relative,target in targets.items():
            stat=Path(target).stat();install(stage/relative,target);os.chown(target,stat.st_uid,stat.st_gid)
        drop=Path('/etc/systemd/system/misty-bot.service.d/apollo.conf');drop.parent.mkdir(parents=True,exist_ok=True)
        drop.write_text('[Service]\nEnvironment=MISTY_CHAT_NOTIFICATIONS=off\n')
        install(stage/'scripts/apollo-bot.service','/etc/systemd/system/apollo-bot.service')
        spec=importlib.util.spec_from_file_location('handoff',stage/'scripts/handoff-apollo.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        counts=module.handoff('/var/lib/misty-bot/chat.sqlite',dest/'chat.sqlite',identity,int(identity['setupStartedAt']))
        committed=True
        # A single owner-only setup message. Retried starts reuse its durable source.
        with sqlite3.connect(dest/'chat.sqlite') as db:
            db.execute('INSERT OR IGNORE INTO relay_notices(source,body) VALUES(?,?)',('setup:apollo-role-split:0000',"I'm Apollo. I'll keep an eye on your selected chats and tell you when something seems relevant. You can ask me what happened, why I mentioned it, or for the original source. Misty remains your main agent for code, Codex and other work. Your previous summaries and queued updates have been kept."))
        for file in dest.iterdir():
            if file.is_file():os.chown(file,account.pw_uid,account.pw_gid);file.chmod(0o600)
        run('systemctl','daemon-reload');run('systemctl','enable','apollo-bot');run('systemctl','start','misty-bot','misty-prominence','apollo-bot')
        time.sleep(6);run('systemctl','is-active','archival','misty-bot','misty-prominence','apollo-bot')
        report={'backup':str(backup),'identity':identity,'handoff':counts,'hashes':{relative:hashlib.sha256(Path(target).read_bytes()).hexdigest() for relative,target in targets.items()}}
        (backup/'handoff.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
    except BaseException:
        if not committed:
            for relative,target in targets.items():shutil.copy2(backup/relative,target)
            if Path('/etc/systemd/system/misty-bot.service.d/apollo.conf').exists():Path('/etc/systemd/system/misty-bot.service.d/apollo.conf').write_text('[Service]\nEnvironment=MISTY_CHAT_NOTIFICATIONS=on\n')
            run('systemctl','daemon-reload');run('systemctl','start','misty-bot','misty-prominence')
        # After commit, never overwrite new databases or replay old delivery receipts.
        # Leave the old watcher disabled and repair Apollo in place if startup failed.
        raise

if __name__=='__main__':main()
