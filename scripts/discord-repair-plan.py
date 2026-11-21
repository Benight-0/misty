"""Read the pre-recovery snapshot in Linux; emit IDs only for existing private chats."""
import glob, json, sqlite3
snapshots=sorted(glob.glob('/out/discord-before-native-*.sqlite'))
assert snapshots, 'Pre-recovery snapshot not found'
with sqlite3.connect('file:'+snapshots[-1]+'?mode=ro',uri=True) as db:
    plan=[{'channel':r[0],'after':r[1]} for r in db.execute('''
      SELECT p.dcid,max(m.dcid) FROM portal p JOIN message m ON m.dc_chan_id=p.dcid AND m.dc_chan_receiver=p.receiver
      WHERE p.receiver=? AND p.type IN (1,3) AND p.mxid<>'' GROUP BY p.dcid
    ''',('100000000000000023',))]
with open('/out/dm-repair-plan.json','w') as output:json.dump(plan,output)
print(json.dumps({'snapshot':snapshots[-1], 'private_chats':len(plan)}))
