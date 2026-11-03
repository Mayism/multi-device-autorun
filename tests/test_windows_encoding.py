"""Exercise real I/O boundaries under simulated Windows GBK defaults."""

import asyncio
import base64
from contextlib import asynccontextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import yaml

from harmonyeval.agent.engines.opencode import OpenCodeExecutor
from harmonyeval.agent.capabilities.loader import _write_windows_shim
from harmonyeval.agent.environments.toolchain import tool_environment
from harmonyeval.cli.main import main
from harmonyeval.config import load_task
from harmonyeval.evaluator.runner import run_task
from harmonyeval.integrations.agc.cloudtest_submit import _run_logged
from harmonyeval.integrations.uitest.ohostest_case import _apply_patch
from harmonyeval.utils.encoding import console_print, decode_output, print_json
from harmonyeval.report.comparison import compare_reports
from harmonyeval.report.io import load_report


UNICODE_TEXT = '中文 路径 🚀 𝄞'
_REAL_OPEN = Path.open
_REAL_IO_OPEN = io.open


def gbk_default_open(path, mode='r', buffering=-1, encoding=None, errors=None, newline=None):
    if 'b' not in mode and encoding in (None, 'locale'):
        encoding = 'gbk'
    return _REAL_OPEN(path, mode, buffering, encoding, errors, newline)


def gbk_default_io_open(file, mode='r', buffering=-1, encoding=None, errors=None,
                        newline=None, closefd=True, opener=None):
    if 'b' not in mode and encoding in (None, 'locale'):
        encoding = 'gbk'
    return _REAL_IO_OPEN(file, mode, buffering, encoding, errors, newline, closefd, opener)


class EncodingTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='harmonyeval-encoding-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / UNICODE_TEXT
        self.root.mkdir()

    def gbk_stream(self):
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding='gbk', errors='strict')
        self.addCleanup(stream.close)
        return raw, stream

    def test_console_logs_cannot_mask_failure_and_json_round_trips(self):
        raw, stream = self.gbk_stream()
        # Establish that the emulated terminal reproduces the reported failure.
        with self.assertRaises(UnicodeEncodeError):
            stream.write(UNICODE_TEXT)
        console_print(UNICODE_TEXT, file=stream, flush=True)
        self.assertIn(r'\U0001f680', raw.getvalue().decode('gbk'))
        json_raw, json_stream = self.gbk_stream()
        print_json({'message': UNICODE_TEXT}, file=json_stream)
        json_stream.flush()
        self.assertEqual(json.loads(json_raw.getvalue().decode('gbk')), {'message': UNICODE_TEXT})

    def test_cli_check_json_and_exception_on_gbk_redirect(self):
        raw, stream = self.gbk_stream()
        payload = {'ready': True, 'detail': UNICODE_TEXT}
        with patch('sys.stdout', stream), patch('harmonyeval.cli.main.load_task', return_value={}), \
                patch('harmonyeval.cli.main.check_task', return_value=payload):
            self.assertEqual(main(['run', 'fixture.yaml', '--check']), 0)
        stream.flush()
        self.assertEqual(json.loads(raw.getvalue().decode('gbk')), payload)
        error_raw, error_stream = self.gbk_stream()
        with patch('sys.stderr', error_stream), \
                patch('harmonyeval.cli.main.load_task', side_effect=ValueError(UNICODE_TEXT)):
            self.assertEqual(main(['run', 'fixture.yaml']), 1)
        error_stream.flush()
        self.assertIn('Harmony Eval 运行失败', error_raw.getvalue().decode('gbk'))

    def test_agent_python_children_write_utf8_even_with_inherited_gbk(self):
        env = tool_environment({}, {'PYTHONIOENCODING': 'gbk', 'PYTHONUTF8': '0'})
        output = self.root / '输出 🚀.txt'
        code = "import sys; text=sys.argv[2]; print(text); open(sys.argv[1], 'w').write(text)"
        completed = subprocess.run([sys.executable, '-c', code, str(output), UNICODE_TEXT],
                                   env=env, capture_output=True, check=True)
        self.assertEqual(completed.stdout.decode('utf-8').strip(), UNICODE_TEXT)
        self.assertEqual(output.read_text(encoding='utf-8'), UNICODE_TEXT)

    def test_native_build_gbk_log_and_raw_evidence(self):
        console = self.root / 'build.log'
        original = 'ERROR 构建失败'.encode('gbk')
        process = Mock(returncode=1)
        process.communicate.return_value = (original, None)
        logs = []
        with patch('harmonyeval.integrations.agc.cloudtest_submit.subprocess.Popen', return_value=process):
            result = _run_logged(['native-tool'], self.root, {}, console, 5, logs.append)
        self.assertEqual(result['exitCode'], 1)
        self.assertIn('构建失败', console.read_text(encoding='utf-8'))
        self.assertEqual(console.with_name(console.name + '.raw').read_bytes(), original)
        self.assertTrue(any('构建失败' in line for line in logs))

    @unittest.skipUnless(shutil.which('node'), 'Node is needed to execute the generated CLI bridge')
    def test_windows_batch_bridge_keeps_unicode_paths_out_of_batch_contents(self):
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        cli = self.root / '三方工具 🚀.cjs'
        cli.write_text('console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);', encoding='utf-8')
        with patch.object(Path, 'open', gbk_default_open):
            _write_windows_shim(bin_dir / 'fixture', cli, '.plugin-cli-0-0.cjs')
        batch = (bin_dir / 'fixture.cmd').read_bytes()
        self.assertEqual(batch.decode('gbk'), '@node "%~dp0.plugin-cli-0-0.cjs" %*\n')
        bridge = bin_dir / '.plugin-cli-0-0.cjs'
        self.assertTrue(bridge.read_text(encoding='utf-8').isascii())
        completed = subprocess.run([shutil.which('node'), str(bridge), UNICODE_TEXT], capture_output=True)
        self.assertEqual(completed.returncode, 7, completed.stderr)
        self.assertEqual(json.loads(completed.stdout.decode('utf-8')), [UNICODE_TEXT])

    def test_native_patch_failure_preserves_bytes_and_readable_message(self):
        original = '补丁不匹配'.encode('gbk')
        process = subprocess.CompletedProcess(['git'], 1, b'', original)
        log = Mock()
        with patch('harmonyeval.integrations.uitest.ohostest_case.subprocess.run', return_value=process):
            with self.assertRaisesRegex(RuntimeError, '补丁不匹配'):
                _apply_patch(self.root, self.root / 'test.patch', 'test', log)
        recorded = log.record.call_args.kwargs['result']
        self.assertEqual(base64.b64decode(recorded['stderrBase64']), original)
        self.assertEqual(recorded['stderr'], '补丁不匹配')

    def test_diagnostic_decoding_and_strict_protocol_are_separate(self):
        self.assertEqual(decode_output(UNICODE_TEXT.encode('utf-8')), UNICODE_TEXT)
        self.assertEqual(decode_output(UNICODE_TEXT.encode('gb18030')), UNICODE_TEXT)
        self.assertEqual(decode_output('中文'.encode('gbk')), '中文')
        self.assertEqual(decode_output(b'\xff'), r'\xff')
        with self.assertRaises(UnicodeDecodeError):
            decode_output('中文'.encode('gbk'), encoding='utf-8')

    def test_full_evalscope_http_run_and_reports_under_gbk_defaults(self):
        class EchoHandler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                data = json.dumps({'answer': request['question']}, ensure_ascii=False).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(('127.0.0.1', 0), EchoHandler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        data = self.root / 'cases.json'
        data.write_text(json.dumps([{'id': 'unicode', 'question': UNICODE_TEXT,
                                    'reference_answer': UNICODE_TEXT}], ensure_ascii=False), encoding='utf-8')
        raw = {'schema_version': 2, 'id': 'gbk-http', 'description': UNICODE_TEXT,
               'scenario': 'QuestionAnswering', 'target': {'type': 'knowledge'},
               'dataset': {'type': 'text-qa', 'dir': str(data)},
               'knowledge': {'execution': {'engine': 'http',
                    'http_url': f'http://127.0.0.1:{server.server_port}/echo',
                    'request': {'json': {'question': '${case.question}'}},
                    'response': {'answer_path': 'answer'}},
                    'verification': [{'id': 'qa', 'type': 'ExactMatch'}],
                    'scoring': [{'dimension': 'quality', 'type': 'ImmediateValue', 'source': 'qa.metrics.score'}],
                    'report': {'output_dir': str(self.root / 'reports')}}}
        source = self.root / 'task.yaml'
        source.write_text(yaml.safe_dump(raw, allow_unicode=True), encoding='utf-8')
        _, stream = self.gbk_stream()
        with patch.object(Path, 'open', gbk_default_open), \
                patch('io.open', gbk_default_io_open), patch('builtins.open', gbk_default_io_open), \
                patch('sys.stdout', stream), patch('sys.stderr', stream):
            result = asyncio.run(run_task(load_task(source)))
            root, report = load_report(result['runRoot'])
            self.assertEqual(result['exitCode'], 0)
            self.assertEqual(report['records'][0]['execution']['answer'], UNICODE_TEXT)
            self.assertEqual(report['aggregate']['quality']['mean'], 100)
            self.assertEqual(yaml.safe_load((root / 'task.resolved.yaml').read_text(encoding='utf-8'))['description'], UNICODE_TEXT)
            self.assertIn(UNICODE_TEXT, (root / 'index.html').read_text(encoding='utf-8'))
            compared = compare_reports(report, report, self.root / 'comparison')
            self.assertTrue(Path(compared).read_text(encoding='utf-8').startswith('<!doctype html>'))

    def test_opencode_unicode_events_stderr_and_html_under_gbk_file_defaults(self):
        event = {'type': 'text', 'sessionID': 'fixture',
                 'part': {'type': 'text', 'text': UNICODE_TEXT}}

        async def execute(stdout_bytes=None):
            stdout, stderr = asyncio.StreamReader(), asyncio.StreamReader()
            stdout.feed_data(stdout_bytes if stdout_bytes is not None else
                             (json.dumps(event, ensure_ascii=False) + '\n').encode('utf-8'))
            stdout.feed_eof()
            stderr.feed_data((UNICODE_TEXT + '\n').encode('utf-8'))
            stderr.feed_eof()
            process = SimpleNamespace(stdout=stdout, stderr=stderr, returncode=0, wait=AsyncMock(return_value=0))
            recorder = Mock()
            recorder.snapshot.return_value.model_dump.return_value = {'events': [], 'total_usage': {'total_tokens': 3}}
            route = SimpleNamespace(base_url='http://127.0.0.1:1', token='fixture-token', recorder=recorder)

            @asynccontextmanager
            async def trial_session(*_):
                yield route

            proxy = SimpleNamespace(trial_session=trial_session, shutdown=AsyncMock())
            execution = {'agent_name': 'build', 'model': {'name': 'fixture'}, 'timeout': 5, 'idle_timeout': 2}
            context = {'task': {'active': {'execution': execution}}, 'workspace': str(self.root),
                       'output': str(self.root), 'model': object()}
            target = {'binary': 'unused-opencode', 'config': {}, 'env': {},
                      'config_path': str(self.root / 'config.json')}
            with patch('evalscope.agent.external.bridge.server.ModelProxyServer.get_or_start', AsyncMock(return_value=proxy)), \
                    patch('harmonyeval.agent.engines.opencode.inspect_runtime', return_value={'agents': []}), \
                    patch('harmonyeval.agent.engines.opencode.asyncio.create_subprocess_exec', AsyncMock(return_value=process)), \
                    patch('harmonyeval.agent.traces.session_capture.capture_sessions', return_value=([], {'mode': 'fixture'})), \
                    patch.object(Path, 'open', gbk_default_open):
                # Confirm the simulation fails on a missed encoding, before exercising the fixed path.
                with self.assertRaises(UnicodeEncodeError):
                    (self.root / 'legacy.txt').write_text(UNICODE_TEXT)
                return await OpenCodeExecutor().execute({'case_id': UNICODE_TEXT, 'question': UNICODE_TEXT}, target, context)

        result = asyncio.run(execute())
        self.assertEqual(result.status, 'completed', result.error)
        self.assertEqual(result.answer, UNICODE_TEXT)
        output = self.root / 'generate'
        self.assertEqual(json.loads((output / 'events.jsonl').read_text(encoding='utf-8')), event)
        self.assertEqual(json.loads((output / 'stderr.jsonl').read_text(encoding='utf-8'))['text'], UNICODE_TEXT)
        self.assertEqual(json.loads((output / 'agent-output.json').read_text(encoding='utf-8'))['answer'], UNICODE_TEXT)
        self.assertIn(UNICODE_TEXT, (output / 'agent-output.html').read_text(encoding='utf-8'))
        invalid = b'{"type":"text","part":{"text":"\xff"}}\n'
        failed = asyncio.run(execute(invalid))
        self.assertEqual(failed.status, 'error')
        self.assertEqual(failed.failure_category, 'infrastructure')
        self.assertIn('UnicodeDecodeError', failed.error)
        self.assertEqual((output / 'events.invalid.bin').read_bytes(), invalid)


if __name__ == '__main__':
    unittest.main()
