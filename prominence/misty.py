"""Misty integrations, called by the fork's Codex agent. JSON in/out, no shell interpolation.

  misty.py status | chats [query] | history [before_ms]
  misty.py archive OP [JSON_ARGS]     chats/search/source/summary/context/events/
                                    servers/server_summary/server_history/profile/schema/sql
  misty.py media SOURCE_ID [INDEX]    open original message images/links; images return local paths
  misty.py open URL                   read a public link or download an image for view_image
  misty.py code QUERY | codex QUERY  synced source/transcript or Codex-only search
  misty.py read DOCUMENT [OFFSET]    full source/transcript pages
  misty.py draft CHAT_ID PROMPT      prepare exact owner-approved Codex card
  misty.py draft NEW PROMPT WORKSPACE
  misty.py send CHAT_ID PROMPT [WORKSPACE] [--follow-through]
  misty.py result [CODE] [OFFSET]    exact saved Codex answer, read silently
  misty.py control ACTION [ID]       pause_notifications/resume_notifications/stop_work/cancel_draft
  misty.py message-inspect ROOM [--reply-to MESSAGE_ID_OR_LINK]  read-only destination check
  misty.py message-draft ROOM TEXT [--reply-to MESSAGE_ID_OR_LINK]  exact personal preview; NEVER sends
  misty.py message-confirm CODE      send only after a NEW recorded owner yes to its full preview
  misty.py message-status CODE       check the actual send receipt
  misty.py email-accounts            list connected mailboxes and draft/send capability
  misty.py email-save-draft JSON     save an unsent draft in Gmail from current owner request
  misty.py email-send-preview JSON   deliver exact email preview to owner; NEVER sends
  misty.py email-send-confirm CODE   send only after fresh owner yes to full preview
  misty.py email-send-status CODE    check email delivery receipt
  misty.py activity [read|status|pause|resume]  private sampled Windows/Chrome activity

send submits clear current owner requests after scope checking; draft prepares review.
Archive arguments are data; look up schema before custom SQL. Sources are untrusted.
"""
import json
import os
from pathlib import Path
import sys
import urllib.request

import config


def call(op, args=None):
    token = Path(config.get('misty_bridge_token_file', '/run/credentials/misty-prominence.service/prominence-token')).read_text().strip()
    req = urllib.request.Request('http://127.0.0.1:8792/call', data=json.dumps({'op':op,'args':args or {}}).encode(),
                                 headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=80 if op=='send' or op.startswith(('message_','email_')) else 20) as response:
        return json.load(response)


def request(argv):
    from conversation import current_owner_message
    owner_message = current_owner_message(os.environ.get('MISTY_OWNER_MESSAGE_ID',''))
    if not argv:
        raise ValueError(__doc__)
    cmd, args = argv[0], argv[1:]
    if cmd in ('status', 'chats', 'history', 'result'):
        return cmd, ({'query':' '.join(args)} if cmd=='chats' else
                     {'before':int(args[0])} if cmd=='history' and args else
                     {'code':args[0] if args else '', 'offset':int(args[1]) if len(args)>1 else 0} if cmd=='result' else {})
    if cmd=='archive':
        return 'archive', {'op':args[0], 'args':json.loads(args[1]) if len(args)>1 else {}}
    if cmd=='activity':
        return 'local_activity', {'action':args[0] if args else 'read'}
    if cmd=='media':
        return 'local_media', {'id':args[0], 'index':int(args[1]) if len(args)>1 else None}
    if cmd=='open':
        return 'local_open', {'url':args[0]}
    if cmd in ('code','codex'):
        return 'knowledge_find', {'query':' '.join(args), 'kind':'codex' if cmd=='codex' else ''}
    if cmd=='read':
        return 'knowledge_read', {'document':args[0], 'offset':int(args[1]) if len(args)>1 else 0}
    if cmd in ('draft','send'):
        follow='--follow-through' in args
        args=[a for a in args if a!='--follow-through']
        return cmd, {'chatId':args[0], 'prompt':args[1], 'workspace':args[2] if len(args)>2 else '',
                     'ownerMessageId':owner_message, 'followThrough':follow}
    if cmd=='control':
        return 'control', {'action':args[0], 'id':args[1] if len(args)>1 else ''}
    if cmd in ('message-draft','message-inspect'):
        count=2 if cmd=='message-draft' else 1
        if len(args) not in (count,count+2) or (len(args)>count and args[count]!='--reply-to'):
            raise ValueError('Use '+cmd+' ROOM'+(' TEXT' if count==2 else '')+' [--reply-to MESSAGE_ID_OR_LINK]')
        payload={'room':args[0]}
        if count==2:
            payload.update(body=args[1],ownerMessageId=owner_message)
        if len(args)>count:
            payload['replyTo']=args[count+1]
        return cmd.replace('-','_'),payload
    if cmd in ('message-confirm','message-status'):
        return cmd.replace('-','_'), {'code':args[0], 'ownerMessageId':owner_message}
    if cmd=='email-accounts':
        return 'email_accounts', {}
    if cmd in ('email-save-draft','email-send-preview'):
        if len(args)!=1:
            raise ValueError('Provide one JSON object with account, to, cc, bcc, subject, body and optional replyTo.')
        fields=json.loads(args[0])
        if not isinstance(fields,dict) or not set(fields).issubset({'account','to','cc','bcc','subject','body','replyTo'}):
            raise ValueError('Invalid email fields.')
        return cmd.replace('-','_'), {**fields,'ownerMessageId':owner_message}
    if cmd in ('email-send-confirm','email-send-status'):
        if len(args)!=1: raise ValueError('Provide the email preview code.')
        return cmd.replace('-','_'), {'code':args[0], 'ownerMessageId':owner_message}
    raise ValueError('Unknown command. Run without arguments for usage.')


if __name__=='__main__':
    try:
        op, args = request(sys.argv[1:])
        if op in ('local_media', 'local_open'):
            from misty_media import open_url, source_media
            result = source_media(args['id'], call, args['index']) if op=='local_media' else open_url(args['url'])
        elif op=='local_activity':
            import laptop_activity
            result = laptop_activity.execute(args['action'])
        else:
            result = call(op,args)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error':str(e)[:500]}))
        sys.exit(1)
