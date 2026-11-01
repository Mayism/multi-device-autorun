"""Real local protocol exchanges, cancellation and evaluation failure semantics."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from pyautorun.harmony_eval.core import EvalCase, ExecutionResult
from pyautorun.harmony_eval.http_protocols import call_http, substitute
from pyautorun.harmony_eval.verification import CloudTest, pipeline, parse_judge


class ProtocolService(BaseHTTPRequestHandler):
    submits = 0
    polls = 0

    def log_message(self, *args):
        pass

    def respond(self, data, content_type='application/json'):
        data = data.encode()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path == '/stream':
            self.respond('data: {"delta":"鸿"}\n\ndata: {"delta":"蒙"}\n\ndata: [DONE]\n\n', 'text/event-stream')
        elif self.path == '/submit':
            type(self).submits += 1
            self.respond('{"job_id":"job1"}')

    def do_GET(self):
        type(self).polls += 1
        self.respond('{"status":"completed","answer":"finished"}')


class ProtocolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), ProtocolService)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_sse_and_submit_poll_only_submit_once(self):
        base = f'http://127.0.0.1:{self.server.server_port}'
        case = {'question': 'question', 'case_id': 'case1'}
        stream = call_http({'http_url': base + '/stream', 'timeout': 3,
                            'response': {'protocol': 'sse'}}, case)
        self.assertEqual(stream['answer'], '鸿蒙')
        before = ProtocolService.submits
        answer = call_http({'http_url': base + '/submit', 'timeout': 3,
            'response': {'protocol': 'poll', 'poll': {'url': base + '/jobs/${job_id}', 'interval': 0.01}}}, case)
        self.assertEqual(answer['answer'], 'finished')
        self.assertEqual(ProtocolService.submits - before, 1)

    def test_variable_substitution_does_not_expose_grading_fields(self):
        with self.assertRaisesRegex(ValueError, '不允许'):
            substitute('${case.reference_answers}', {'question': 'q', 'case_id': 'q1'})
        with self.assertRaisesRegex(ValueError, '未知请求变量'):
            substitute('${__import__("os")}', {'question': 'q', 'case_id': 'q1'})

    def test_judge_invalid_total_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '不得超过'):
            parse_judge(json.dumps({'score': 90, 'reason': 'test', 'dimensions': [
                {'name': 'quality', 'max_score': 100, 'score': 50}]}))
        with self.assertRaisesRegex(ValueError, '有限数值'):
            parse_judge('{"score":NaN,"reason":"invalid"}')

    def test_cancellation_kills_a_running_workflow_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / 'project'
            project.mkdir()
            marker = root / 'should-not-exist'
            command = [sys.executable, '-c', f'import time; from pathlib import Path; time.sleep(5); Path({str(marker)!r}).touch()']
            task = {'active': {'execution': {'enviroment': {}}, 'verification': [{'id': 'command', 'type': 'Command', 'command': command}]}}
            from pyautorun.harmony_eval.task import load_task  # builtin registration is normally performed by load_task
            from pyautorun.harmony_eval import verification
            cancelled = threading.Event()
            async def run():
                future = asyncio.create_task(pipeline(task, EvalCase('c1', 'q', str(root)),
                    ExecutionResult('completed', project=str(project)), root / 'out', cancelled))
                await asyncio.sleep(0.15)
                cancelled.set()
                return await future
            start = time.monotonic()
            results = asyncio.run(run())
            self.assertLess(time.monotonic() - start, 2)
            self.assertEqual(results['command']['status'], 'unavailable')
            self.assertFalse(marker.exists())

    def test_cloud_completion_does_not_mean_tests_passed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / 'project'
            project.mkdir()
            context = {'output': str(root), 'env': {}, 'task': {'base_dir': str(root)}, 'temporary_projects': []}
            with patch('pyautorun.cloud.cloudtest_submit.submit_cloud_test_for_project', return_value={}), \
                 patch('pyautorun.cloud.cloudtest_submit.finish_cloud_test_polling', return_value={
                     'status': 'completed', 'report': {'summary': {'deviceCount': 2, 'devicePassed': 1, 'deviceFailed': 1}}}):
                result = asyncio.run(CloudTest().verify(EvalCase('c1', 'q', str(root)),
                    ExecutionResult('completed', project=str(project)), {}, context, {'id': 'cloud', 'type': 'CloudTest'}))
            self.assertFalse(result.metrics['passed'])
            self.assertEqual(result.metrics['pass_rate'], 0.5)
            import shutil
            for p in context['temporary_projects']:
                shutil.rmtree(p)


if __name__ == '__main__':
    unittest.main()
