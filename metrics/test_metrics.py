from datetime import datetime
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import collect
import server
import resources


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = collect.connect(self.root / 'test.sqlite')
        self.addCleanup(self.db.close)

    def test_cost_counts_cached_and_cache_write_once_and_includes_output(self):
        self.assertAlmostEqual(collect.estimate('gpt-6.1-sol', dict(input=1000,cached=500,write=200,output=100)), .00215)
        self.assertAlmostEqual(collect.estimate('gpt-5.6-luna', dict(input=1000,cached=500,output=100)), .00023)
        self.assertIsNone(collect.estimate('future-model', dict(input=1000)))
        self.assertAlmostEqual(collect.estimate('gpt-6.1-sol', dict(input=300000, output=1000)), 1.215)
        self.assertAlmostEqual(collect.estimate('gpt-6.1-sol', dict(input=1000,output=100), 'fast'), .006)

    def test_luna_verified_rates_cache_long_context_and_tiers(self):
        self.assertAlmostEqual(collect.estimate('gpt-6-luna', dict(input=1000,cached=500,write=200,output=100)), .00011)
        self.assertAlmostEqual(collect.estimate('gpt-6-luna-2026-09-29', dict(input=1000,output=100)), .00015)
        self.assertAlmostEqual(collect.estimate('gpt-6-luna', dict(input=300000,output=1000)), .06075)
        self.assertAlmostEqual(collect.estimate('gpt-6-luna', dict(input=1000,output=100), 'fast'), .00030)
        self.assertAlmostEqual(collect.estimate('gpt-6-luna', dict(input=1000,output=100), 'batch'), .000075)
        self.assertIsNone(collect.estimate('gpt-6-luna', dict(input=1000), 'unknown-tier'))

    def test_saved_luna_repricing_is_idempotent_preserves_counters_cursors_and_existing_prices(self):
        old_rates={k:v for k,v in collect.RATES.items() if k!='gpt-6-luna'}
        with patch.object(collect,'RATES',old_rates):
            for key,source,model in [('old','apollo','gpt-6-luna'),('dated','apollo','gpt-6-luna-2026-09-29'),
                                     ('unknown','apollo','unknown-model'),('ephemeral','misty-agent','gpt-6-luna')]:
                collect.record(self.db,key,source,model,1000,dict(input=1000,cached=500,output=100))
        collect.record(self.db,'priced','apollo','gpt-6-luna',1000,dict(input=1000,output=100))
        self.db.execute("UPDATE usage SET cost=9 WHERE id='priced'")
        collect.save(self.db,'db:apollo',123)
        before=[tuple(r) for r in self.db.execute('SELECT id,source,model,at,input,cached,write,output FROM usage ORDER BY id')]
        self.assertEqual(collect.price_saved_luna(self.db),2)
        self.assertEqual(collect.price_saved_luna(self.db),0)
        self.assertEqual(collect.state(self.db,'db:apollo'),123)
        self.assertEqual(before,[tuple(r) for r in self.db.execute('SELECT id,source,model,at,input,cached,write,output FROM usage ORDER BY id')])
        self.assertEqual(self.db.execute("SELECT cost FROM usage WHERE id='priced'").fetchone()[0],9)
        self.assertEqual(self.db.execute('SELECT count(*) FROM usage WHERE cost IS NULL').fetchone()[0],2)
        self.db.commit()
        with closing(collect.connect(self.root/'test.sqlite')) as reopened:
            self.assertEqual(collect.price_saved_luna(reopened),0)
            self.assertAlmostEqual(reopened.execute("SELECT cost FROM usage WHERE id='old'").fetchone()[0],.000105)
            snapshot=collect.snapshot(reopened,{},1000,[])
            self.assertAlmostEqual(sum(t['estimatedUsd'] or 0 for t in snapshot['usage']['tasks']),snapshot['usage']['estimatedUsd'])

    def test_shared_response_id_not_counted_twice_and_incremental_import(self):
        remote = self.root / 'source.sqlite'
        with closing(sqlite3.connect(remote)) as c, c:
            c.execute('CREATE TABLE bot_usage(request_id TEXT,model TEXT,input_tokens INT,output_tokens INT,cached_tokens INT,at INT)')
            c.execute("INSERT INTO bot_usage VALUES('resp1','gpt-5.6-luna',1000,100,0,10000)")
        collect.read_database(self.db,'misty',remote,'bot_usage')
        collect.read_database(self.db,'apollo',remote,'bot_usage')
        collect.read_database(self.db,'misty',remote,'bot_usage')
        self.assertEqual(self.db.execute('select count(*) from usage').fetchone()[0], 1)
        with closing(sqlite3.connect(remote)) as c, c:
            c.execute("INSERT INTO bot_usage VALUES('resp2','gpt-5.6-luna',200,10,0,20000)")
        collect.read_database(self.db,'misty',remote,'bot_usage')
        self.assertEqual(self.db.execute('select sum(input) from usage').fetchone()[0], 1200)

    def test_codex_cumulative_duplicates_partial_write_and_resume(self):
        path = self.root / 'rollout.jsonl'
        def usage(inp,cached,out):
            total=dict(input_tokens=inp,cached_input_tokens=cached,cache_write_input_tokens=inp-cached,output_tokens=out)
            return dict(type='event_msg',timestamp='2026-10-23T12:00:00Z',payload=dict(type='token_count',info=dict(total_token_usage=total,last_token_usage=total)))
        entries=[dict(type='session_meta',payload=dict(id='fixture')),dict(type='turn_context',payload=dict(model='gpt-6.1-sol')),usage(1000,0,100),usage(1000,0,100)]
        path.write_text(''.join(json.dumps(e)+'\n' for e in entries))
        collect.read_log(self.db,path)
        with path.open('a') as f:f.write(json.dumps(usage(2500,1000,200)))
        collect.read_log(self.db,path)
        self.assertEqual(self.db.execute('select count(*) from usage').fetchone()[0],1)
        with path.open('a') as f:f.write('\n')
        collect.read_log(self.db,path)
        collect.read_log(self.db,path)
        row=self.db.execute('select sum(input),sum(cached),sum(output) from usage').fetchone()
        self.assertEqual(tuple(row),(2500,1000,200))

    def test_public_snapshot_has_only_aggregates_and_ist_days(self):
        # 20:00 UTC is already the next calendar day in India.
        stamp=int(datetime.fromisoformat('2026-10-23T20:00:00+00:00').timestamp()*1000)
        collect.record(self.db,'PRIVATE_REQUEST_ID','misty','gpt-5.6-luna',stamp,dict(input=1000,output=100))
        data=collect.snapshot(self.db,dict(cpuPercent=10),stamp,[])
        encoded=json.dumps(data)
        self.assertNotIn('PRIVATE_REQUEST_ID',encoded)
        self.assertNotIn('room_id',encoded)
        self.assertNotIn('/var/',encoded)
        self.assertEqual(data['usage']['daily'][-1]['date'],'2026-10-24')
        self.assertGreater(data['usage']['todayEstimatedUsd'],0)
        self.assertEqual(data['history'],[])

    def test_cpu_uses_interval_delta_and_handles_restarts(self):
        self.assertEqual(collect.cpu_delta([1000,800],[1100,850]),50)
        self.assertIsNone(collect.cpu_delta([1000,800],[1000,800]))
        self.assertIsNone(collect.cpu_delta([1000,800],[900,700]))

    def test_cpu_p95_rolling_window_valid_samples_and_nearest_rank(self):
        now = 1800000000000
        start = now - 7 * 86400000
        rows = [(start + i * 60000, i + 1, 50, 50) for i in range(100)]
        rows += [(start - 1, 100, 50, 50), (now + 1, 100, 50, 50),
                 (now - 1, None, 50, 50), (now - 2, -1, 50, 50),
                 (now - 3, 101, 50, 50), (now - 4, float('inf'), 50, 50)]
        self.db.executemany('INSERT INTO samples VALUES(?,?,?,?)', rows)
        collect.save(self.db, 'db:apollo', 123)
        before = [tuple(r) for r in self.db.execute('SELECT * FROM samples ORDER BY at')]
        result = collect.snapshot(self.db, {}, now, [])['cpuSevenDays']
        self.assertEqual(result['p95Percent'], 95)
        self.assertEqual(result['sampleCount'], 100)
        self.assertEqual(result['firstAt'], start)
        self.assertEqual(result['lastAt'], start + 99 * 60000)
        self.assertEqual(result['windowEndAt'], now)
        self.assertEqual(result['method'], 'nearest-rank')
        self.assertEqual(collect.state(self.db, 'db:apollo'), 123)
        self.assertEqual(before, [tuple(r) for r in self.db.execute('SELECT * FROM samples ORDER BY at')])
        self.db.commit()
        with closing(collect.connect(self.root / 'test.sqlite')) as reopened:
            self.assertEqual(collect.cpu_seven_days(reopened, now), result)

    def test_cpu_p95_empty_single_zero_and_inclusive_end(self):
        self.assertIsNone(collect.cpu_seven_days(self.db, 1000)['p95Percent'])
        self.assertEqual(collect.cpu_seven_days(self.db, 1000)['sampleCount'], 0)
        self.db.execute('INSERT INTO samples VALUES(1000,0,50,50)')
        result = collect.cpu_seven_days(self.db, 1000)
        self.assertEqual(result['p95Percent'], 0)
        self.assertEqual(result['firstAt'], 1000)
        self.assertEqual(result['lastAt'], 1000)
        self.assertEqual(collect.cpu_seven_days(self.db, 1000 + 7 * 86400000)['sampleCount'], 1)
        self.assertIsNone(collect.cpu_seven_days(self.db, 1001 + 7 * 86400000)['p95Percent'])

    def test_task_totals_match_cost_and_merge_agent_and_chat_without_double_counting(self):
        for key, source in [('a','analysis'),('b','apollo'),('c','misty'),('d','misty-agent')]:
            collect.record(self.db,key,source,'gpt-5.6-luna',1000,dict(input=1000,output=100))
        collect.record(self.db,'b','apollo','gpt-5.6-luna',1000,dict(input=1000,output=100))
        self.db.commit()
        # Reopen the persisted ledger: no backfill/reclassification write is needed.
        with closing(collect.connect(self.root/'test.sqlite')) as reopened:
            rows=collect.task_breakdown(reopened)
        self.assertEqual({r['task'] for r in rows},{'summaries','apollo','misty'})
        self.assertEqual(sum(r['records'] for r in rows),4)
        self.assertAlmostEqual(sum(r['estimatedUsd'] for r in rows),self.db.execute('select sum(cost) from usage').fetchone()[0])
        self.assertAlmostEqual(sum(r['shareOfPricedCostPercent'] for r in rows),100)
        misty=next(r for r in rows if r['task']=='misty')
        self.assertEqual(misty['records'],2)
        self.assertAlmostEqual(misty['shareOfPricedCostPercent'],50)

    def test_task_unpriced_and_zero_cost_are_honest_and_do_not_divide_by_zero(self):
        self.assertEqual(collect.task_breakdown(self.db),[])
        collect.record(self.db,'unpriced','apollo','unverified-model',1000,dict(input=50))
        row=collect.task_breakdown(self.db)[0]
        self.assertIsNone(row['estimatedUsd'])
        self.assertIsNone(row['shareOfPricedCostPercent'])
        collect.record(self.db,'zero','misty','gpt-5.6-luna',1000,{})
        rows=collect.task_breakdown(self.db)
        self.assertTrue(all(r['shareOfPricedCostPercent'] is None for r in rows))
        collect.record(self.db,'priced','apollo','gpt-5.6-luna',1000,dict(input=1000))
        row=next(r for r in collect.task_breakdown(self.db) if r['task']=='apollo')
        self.assertEqual(row['unpricedRecords'],1)
        self.assertGreater(row['estimatedUsd'],0)
        self.assertEqual(row['shareOfPricedCostPercent'],100)

    def test_unknown_task_source_is_fixed_public_label_not_private_source_text(self):
        collect.record(self.db,'PRIVATE_REQUEST','PRIVATE_CHAT_OR_PATH','gpt-5.6-luna',1000,dict(input=100))
        data=collect.snapshot(self.db,{},1000,[])
        encoded=json.dumps(data)
        self.assertNotIn('PRIVATE_CHAT_OR_PATH',encoded)
        self.assertNotIn('PRIVATE_REQUEST',encoded)
        self.assertEqual(data['usage']['tasks'][0]['task'],'other')
        self.assertIn('Historical logs do not support a finer reliable split',data['usage']['taskBreakdownNote'])

    def test_live_sampler_updates_and_bounds_history(self):
        sampler = resources.Sampler()
        host = dict(cpuPercent=10, memoryPercent=60)
        with patch.object(resources, 'read_host', return_value=((100, 90), host)), patch.object(resources.time, 'time', return_value=1000):
            sampler.sample()
        first = sampler.snapshot()
        self.assertEqual(first['refreshSeconds'], 5)
        with patch.object(resources, 'read_host', return_value=((200, 100), dict(cpuPercent=90, memoryPercent=65))), patch.object(resources.time, 'time', return_value=1005):
            sampler.sample()
        second = sampler.snapshot()
        self.assertGreater(second['updatedAt'], first['updatedAt'])
        self.assertEqual(second['host']['cpuPercent'], 90)
        second['history'].clear()
        self.assertEqual(len(sampler.snapshot()['history']), 2)
        with patch.object(resources, 'read_host', return_value=((300, 200), host)), patch.object(resources.time, 'time', return_value=2000):
            sampler.sample()
        self.assertEqual(len(sampler.snapshot()['history']), 1)

    def test_public_server_whitelist_and_no_credentials_or_write_endpoint(self):
        snapshot=self.root/'metrics.json';snapshot.write_text('{"schema":1}')
        with patch.object(server,'SNAPSHOT',snapshot):
            http=server.Server(('127.0.0.1',0),server.Handler)
            thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            try:
                base='http://127.0.0.1:'+str(http.server_port)
                with urllib.request.urlopen(base+'/metrics.json') as response:
                    self.assertEqual(response.status,200)
                    self.assertIsNone(response.headers.get('Set-Cookie'))
                    self.assertEqual(json.load(response),dict(schema=1))
                    self.assertIn("default-src 'none'",response.headers['Content-Security-Policy'])
                sampler=resources.Sampler()
                sampler.value=dict(schema=1,updatedAt=123,host=dict(cpuPercent=30),history=[])
                with patch.object(server,'RESOURCES',sampler):
                    with urllib.request.urlopen(base+'/resources.json') as response:
                        self.assertEqual(response.headers['Cache-Control'],'no-store')
                        self.assertIsNone(response.headers.get('Set-Cookie'))
                        self.assertEqual(json.load(response)['host']['cpuPercent'],30)
                for path in ['/../../etc/passwd','/%2e%2e/metrics.sqlite','/api/chats','/archive.sqlite','/metrics.json/extra']:
                    with self.assertRaises(urllib.error.HTTPError) as e:urllib.request.urlopen(base+path)
                    self.assertEqual(e.exception.code,404)
                with self.assertRaises(urllib.error.HTTPError) as e:urllib.request.urlopen(urllib.request.Request(base+'/metrics.json',data=b'{}'))
                self.assertEqual(e.exception.code,501)
            finally:
                http.shutdown();http.server_close();thread.join()

    def test_ephemeral_logger_retains_only_counters(self):
        sys.path.insert(0,str(Path(__file__).parents[1]/'prominence'))
        import config
        import usage_metrics
        with patch.object(config,'DATA_DIR',str(self.root)):
            self.assertTrue(usage_metrics.record('fixture','gpt-5.6-luna',dict(input_tokens=20,cached_input_tokens=5,output_tokens=10,prompt='PRIVATE_TEXT')))
        content=(self.root/'api-usage.jsonl').read_text()
        self.assertNotIn('PRIVATE_TEXT',content)
        collect.read_log(self.db,self.root/'api-usage.jsonl',ephemeral=True)
        collect.read_log(self.db,self.root/'api-usage.jsonl',ephemeral=True)
        self.assertEqual(self.db.execute('select count(*) from usage').fetchone()[0],1)


if __name__=='__main__':unittest.main()
