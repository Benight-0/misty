import contextlib
import io
import tempfile
import unittest
from unittest.mock import patch

import context


class ContextSearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        database = patch.object(context, 'DB', self.temp.name + '/context.db')
        database.start()
        self.addCleanup(database.stop)
        connections = []
        original_db = context.db
        def tracked_db():
            con = original_db()
            connections.append(con)
            return con
        database_calls = patch.object(context, 'db', tracked_db)
        database_calls.start()
        self.addCleanup(database_calls.stop)
        self.addCleanup(lambda: [con.close() for con in connections])

    def test_exact_matches_remain_ahead_of_broad_fallback_and_sources_are_diverse(self):
        with contextlib.closing(context.db()) as con, con:
            exact = context._add(con, 'doc', 'Princeton aid deadline', 'Princeton aid deadline', 'aid')
            context._add(con, 'doc', 'Princeton other', 'Princeton aid process', 'aid')
            context._add(con, 'doc', 'Princeton third', 'Princeton campus details', 'aid')
            other = context._add(con, 'doc', 'Deadline', 'Deadline information', 'other')
        rows = context.search('Princeton deadline', n=3)
        self.assertEqual(rows[0][0], exact)
        self.assertIn('[Princeton]', rows[0][5])
        self.assertIn(other, [row[0] for row in rows])
        self.assertLessEqual(sum(row[0] != other for row in rows), 2)

    def test_batch_get_preserves_order_and_bounds_multiple_large_results(self):
        with contextlib.closing(context.db()) as con, con:
            first = context._add(con, 'doc', 'One', 'a' * 8000, 'one')
            second = context._add(con, 'doc', 'Two', 'b' * 8000, 'two')
        self.assertEqual([i for i, _ in context.get_many([second, first])], [second, first])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            context.main(['get', str(second), str(first)])
        text = output.getvalue()
        self.assertLess(text.index(f'#{second}'), text.index(f'#{first}'))
        self.assertIn('[truncated; get this ID alone for the full text]', text)
        self.assertLess(len(text), 13000)
