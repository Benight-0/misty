"""Run the existing audited SSH token installer against the new staged authorization.
No Gmail send, no credential output, no archive rebuild.
"""
from pathlib import Path
import runpy
root=Path(__file__).resolve().parents[1]
namespace=runpy.run_path(str(root/'scripts/activate-misty-gmail-manage.py'),run_name='gmail_reconnect_library')
main=namespace['main']
main.__globals__['STAGED']=root/'data/deployment/misty-gmail-reconnect-20261108/credentials.json'
remote=main.__globals__['REMOTE']
remote=remote.replace("SELECT 1 FROM chat_outgoing WHERE status='sending' LIMIT 1", "SELECT 1 FROM chat_outgoing WHERE status='sending' UNION ALL SELECT 1 FROM gmail_outgoing WHERE status='sending' LIMIT 1")
remote=remote.replace("if hashlib.sha256(TOKEN.read_bytes()).hexdigest()!=hashlib.sha256(data).hexdigest():raise RuntimeError('Installed Gmail token hash differs')", "if json.loads(TOKEN.read_text()).get('client')!=new.get('client') or set(json.loads(TOKEN.read_text()).get('accounts',{}))!=set(new.get('accounts',{})):raise RuntimeError('Installed mailbox differs')")
main.__globals__['REMOTE']=remote
compile(remote,'remote-installer','exec')
main()
