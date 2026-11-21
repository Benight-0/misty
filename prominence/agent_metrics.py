"""Read-only rollout counters for latency, completion, duplicates and release health."""
import json
import math
from pathlib import Path
import sqlite3
import statistics
import time

import config


def rows(name, query, params=()):
    path=Path(config.data(name))
    if not path.exists(): return []
    with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True) as db:
        try: return db.execute(query,params).fetchall()
        except sqlite3.Error: return []


def measure(days=7):
    since=time.time()-days*86400
    traces=rows('owner_trace.sqlite', '''SELECT r.run,r.handler_at,r.state,r.role,
      (SELECT min(e.at) FROM trace_events e WHERE e.run=r.run AND e.kind='published'),
      length(r.input_text),
      (SELECT count(*) FROM trace_events e WHERE e.run=r.run AND e.kind='item_start'
       AND (e.label LIKE 'Tool:%' OR e.label IN ('Command','Web search','File change'))
       AND e.label NOT LIKE '%publish_message%')
      FROM trace_runs r WHERE r.handler_at>=?''',(since*1000,))
    quick=[(sent-start)/1000 for _,start,state,role,sent,length,tools in traces
           if role=='misty' and length<=100 and tools==0 and sent is not None and 0<=sent-start<300000]
    tasks=rows('agent_tasks.sqlite','SELECT role,state,created,updated FROM tasks WHERE created>=?',(since,))
    durations=[updated-created for role,state,created,updated in tasks if state=='completed']
    summaries=rows('agent_tasks.sqlite','SELECT kind FROM task_summaries WHERE at>=?',(since,))
    outbox=rows('inbox.sqlite','SELECT run,key,receipt,state FROM conversation_outbox WHERE updated>=?',(since,))
    receipts=[receipt for _,_,receipt,state in outbox if receipt and state=='sent']
    return {'windowDays':days,'ownerTurns':len([r for r in traces if r[3]=='misty']),
            'simpleReplySecondsP50':statistics.median(quick) if quick else None,
            'simpleReplySecondsP95':sorted(quick)[math.ceil(len(quick)*.95)-1] if quick else None,
            'taskCount':len(tasks),'completedTaskSecondsP50':statistics.median(durations) if durations else None,
            'taskStates':{state:sum(1 for _,s,_,_ in tasks if s==state) for _,state,_,_ in tasks},
            'duplicateReceipts':len(receipts)-len(set(receipts)),
            'unknownDeliveries':sum(1 for *_,state in outbox if state=='unknown'),
            'releases':sum(1 for row in summaries if row[0]=='release_receipt'),
            'rollbacks':sum(1 for row in summaries if row[0]=='rollback_receipt'),
            'failedRollbacks':sum(1 for row in summaries if row[0]=='rollback_failed')}


if __name__=='__main__': print(json.dumps(measure(),sort_keys=True))
