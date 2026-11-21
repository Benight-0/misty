"""Configure local owner-only appservice double puppeting without printing secrets."""
from pathlib import Path
import secrets, yaml

registration = Path('data/synapse/appservices/doublepuppet.yaml')
if registration.exists():
    reg = yaml.safe_load(registration.read_text())
else:
    reg = {'id':'archival-doublepuppet','url':None,'as_token':secrets.token_hex(32),'hs_token':secrets.token_hex(32),
           'sender_localpart':'archival_doublepuppet','rate_limited':False,
           'namespaces':{'users':[{'regex':'^@owner:localhost$','exclusive':False}]}}
    registration.write_text(yaml.safe_dump(reg,sort_keys=False))
homeserver = Path('data/synapse/homeserver.yaml')
config = yaml.safe_load(homeserver.read_text())
entry = '/data/appservices/doublepuppet.yaml'
if entry not in config['app_service_config_files']:
    text=homeserver.read_text()
    existing=config['app_service_config_files'][-1]
    assert text.count('- '+existing)==1
    text=text.replace('- '+existing,'- '+existing+'\n  - '+entry)
    homeserver.write_text(text)
bridge = Path('data/discord/config.yaml')
text = bridge.read_text()
config = yaml.safe_load(text)
old = config['bridge']['login_shared_secret_map']
if old.get('localhost') != 'as_token:'+reg['as_token']:
    needle='    login_shared_secret_map:\n'
    assert text.count(needle)==1
    # Preserve the commented config; add localhost alongside the shipped example entry.
    text=text.replace(needle,needle+'        localhost: "as_token:'+reg['as_token']+'"\n')
    bridge.write_text(text)
print('Owner-only local double-puppet registration configured; restart Synapse and Discord')
