"""Read only the selected main session and descendants from the private run DB."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from pyautorun.harmony_eval.session_capture import capture_sessions, session_tool_calls


class SessionCaptureTest(unittest.TestCase):
    def test_descendant_messages_and_tools_are_exported_without_unrelated_sessions(self):
        with tempfile.TemporaryDirectory(prefix='harmony-eval-session-test-') as temp:
            root = Path(temp)
            data = root / 'data/opencode'
            data.mkdir(parents=True)
            source = data / 'opencode.db'
            with sqlite3.connect(source) as db:
                db.executescript('''
                    CREATE TABLE session(id TEXT, parent_id TEXT, title TEXT);
                    CREATE TABLE message(id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
                    CREATE TABLE part(id TEXT, message_id TEXT, data TEXT, time_created INTEGER);
                ''')
                for sid, parent, title in [('main', None, 'Entry'), ('child', 'main', 'Migration'),
                                            ('grandchild', 'child', 'Stage 1'), ('unrelated', None, 'Other run')]:
                    db.execute('INSERT INTO session VALUES (?, ?, ?)', (sid, parent, title))
                    message = json.dumps({'role': 'assistant', 'agent': sid})
                    db.execute('INSERT INTO message VALUES (?, ?, ?, ?)', (sid+'-message', sid, message, 1))
                    part = {'id': sid+'-part', 'type': 'tool', 'tool': 'bash',
                            'state': {'status': 'running', 'input': {'command': 'prepare'}, 'output': sid}}
                    db.execute('INSERT INTO part VALUES (?, ?, ?, ?)', (sid+'-part', sid+'-message', json.dumps(part), 1))
            prepared = {'env': {'XDG_DATA_HOME': str(root / 'data')}}
            sessions, info = capture_sessions(prepared, 'main')
            self.assertEqual(info['mode'], 'sqlite-readonly')
            self.assertEqual(info['sub_sessions'], 2)
            self.assertEqual({s['sessionId'] for s in sessions}, {'main', 'child', 'grandchild'})
            self.assertNotIn('unrelated', json.dumps(sessions))
            calls = session_tool_calls(sessions)
            self.assertEqual(len(calls), 3)
            self.assertTrue(all(c['status'] == 'running' for c in calls))

    def test_missing_runtime_database_explicitly_falls_back_to_cli_events(self):
        with tempfile.TemporaryDirectory(prefix='harmony-eval-session-test-') as temp:
            sessions, info = capture_sessions({'env': {'XDG_DATA_HOME': temp}}, 'main')
            self.assertEqual(sessions, [])
            self.assertEqual(info['mode'], 'cli-events')
            self.assertIn('数据库', info['reason'])


if __name__ == '__main__':
    unittest.main()
