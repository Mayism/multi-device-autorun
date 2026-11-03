"""Opt-in integration with real OpenCode and a local OpenAI-compatible server."""
import asyncio
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import yaml

from harmonyeval.config import load_task
from harmonyeval.evaluator.preflight import check_task
from harmonyeval.evaluator.runner import run_task
from harmonyeval.report.io import load_report
from harmonyeval.report.comparison import compare_reports


class ModelService(BaseHTTPRequestHandler):
    requests = []
    delay_after_tool = 0
    mcp_first = False

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        type(self).requests.append(body)
        tools = {t['function']['name']: t for t in body.get('tools', [])}
        called = any(message.get('role') == 'tool' and message.get('tool_call_id') != 'fixture_mcp'
                     for message in body.get('messages', []))
        mcp_called = any(message.get('role') == 'tool' and message.get('tool_call_id') == 'fixture_mcp'
                         for message in body.get('messages', []))
        mcp_name = next((name for name in tools if name.startswith('fixture_knowledge_')), None)
        if called and type(self).delay_after_tool:
            time.sleep(type(self).delay_after_tool)
        if type(self).mcp_first and mcp_name and not mcp_called:
            message = {'role': 'assistant', 'content': 'Read conversion knowledge.', 'tool_calls': [{
                'id': 'fixture_mcp', 'type': 'function', 'function': {'name': mcp_name,
                                                                    'arguments': json.dumps({'query': 'conversion'})}}]}
            finish = 'tool_calls'
        elif 'bash' in tools and not called:
            message = {'role': 'assistant', 'content': 'Preparing conversion.', 'tool_calls': [{
                'id': 'test_write', 'type': 'function', 'function': {'name': 'bash', 'arguments': json.dumps({
                    'command': "printf 'export function add(a, b) { return a + b; }\\n' > index.js",
                    'description': 'Create fixture conversion output'})}}]}
            finish = 'tool_calls'
        else:
            message, finish = {'role': 'assistant', 'content': 'Converted'}, 'stop'
        data = {'id': 'local-completion', 'object': 'chat.completion', 'created': 1, 'model': body.get('model', 'fixture'),
                'choices': [{'index': 0, 'message': message, 'finish_reason': finish}],
                'usage': {'prompt_tokens': 20, 'completion_tokens': 10, 'total_tokens': 30}}
        if body.get('stream'):
            delta = dict(message)
            if delta.get('tool_calls'):
                delta['tool_calls'] = [dict(index=i, **item) for i, item in enumerate(delta['tool_calls'])]
            chunk = {k: v for k, v in data.items() if k not in ('choices', 'usage')}
            chunk['object'] = 'chat.completion.chunk'
            chunk['choices'] = [{'index': 0, 'delta': delta, 'finish_reason': None}]
            ending = dict(chunk, choices=[{'index': 0, 'delta': {}, 'finish_reason': finish}], usage=data['usage'])
            payload = ('data: ' + json.dumps(chunk) + '\n\ndata: ' + json.dumps(ending) + '\n\ndata: [DONE]\n\n').encode()
            content_type = 'text/event-stream'
        else:
            payload, content_type = json.dumps(data).encode(), 'application/json'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass  # A timeout test intentionally closes an in-flight model stream.


class MCPService(BaseHTTPRequestHandler):
    methods = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        method = request.get('method')
        type(self).methods.append(method)
        if 'id' not in request:
            self.send_response(202)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if method == 'initialize':
            result = {'protocolVersion': request['params']['protocolVersion'], 'capabilities': {'tools': {}},
                      'serverInfo': {'name': 'fixture-knowledge', 'version': '1.0'}}
        elif method == 'tools/list':
            result = {'tools': [{'name': 'search', 'description': 'Find conversion knowledge.',
                                'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string'}}}}]}
        elif method == 'tools/call':
            result = {'content': [{'type': 'text', 'text': 'Preserve the exported add API.'}]}
        else:
            result = {}
        payload = json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


@unittest.skipUnless(os.environ.get('HARMONY_EVAL_INTEGRATION') == '1' and shutil.which('opencode'), 'requires real OpenCode opt-in')
class OpenCodeIntegration(unittest.TestCase):
    def test_fixed_plugin_with_mcp_experiments_and_local_model(self):
        ModelService.requests = []
        ModelService.mcp_first = True
        ModelService.delay_after_tool = 0
        MCPService.methods = []
        self.addCleanup(setattr, ModelService, 'mcp_first', False)
        services = []
        for handler in (ModelService, MCPService):
            service = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            threading.Thread(target=service.serve_forever, daemon=True).start()
            self.addCleanup(service.server_close)
            self.addCleanup(service.shutdown)
            services.append(service)
        model, mcp = services
        with tempfile.TemporaryDirectory(prefix='harmony-eval-mcp-live-') as temporary:
            root = Path(temporary)
            host = root / 'global/opencode'
            host.mkdir(parents=True)
            installed = Path.home() / '.config/opencode'
            for name in ('package.json', 'package-lock.json', 'bun.lock'):
                if (installed / name).is_file():
                    shutil.copy2(installed / name, host / name)
            if (installed / 'node_modules').is_dir():
                shutil.copytree(installed / 'node_modules', host / 'node_modules')
            (host / 'opencode.json').write_text('{}')
            plugin = root / 'fixture-converter'
            plugin.mkdir()
            (plugin / 'package.json').write_text(json.dumps({'type': 'module', 'main': 'index.js'}))
            (plugin / 'index.js').write_text("export default async () => ({config(c) {c.agent ??= {}; c.agent['fixture-converter'] = {mode:'primary', prompt:'Complete conversion with available tools.'};}});")
            source = root / 'data/library'
            source.mkdir(parents=True)
            (source / 'input.java').write_text('public class Source {}')
            (root / 'mcp.json').write_text(json.dumps({'mcp': {'fixture_knowledge': {
                'type': 'remote', 'url': f'http://127.0.0.1:{mcp.server_port}/mcp', 'oauth': False, 'enabled': True}}}))
            raw = {'schema_version': 2, 'id': 'fixed-plugin-mcp', 'scenario': 'LibraryMigration',
                   'target': {'type': 'plugin_agent', 'dir': str(plugin)},
                   'dataset': {'type': 'library-migration', 'dir': 'data', 'layout': 'repositories',
                               'instruction': 'Convert input.java to index.js in the project root.',
                               'expected': {'reference_answers': ['Converted']}},
                   'experiments': [{'id': name, 'overrides': {'mcp': {'fixture_knowledge': {'enabled': flag}}}}
                                   for name, flag in [('without_mcp', False), ('with_mcp', True)]],
                   'plugin_agent': {'execution': {'engine': 'opencode', 'agent_name': 'fixture-converter',
                        'timeout': 90, 'idle_timeout': 60, 'without_enable': False, 'opencode': {'config_path': 'mcp.json'},
                        'model': {'name': 'fixture-model', 'base_url': f'http://127.0.0.1:{model.server_port}/v1',
                                  'api_key': 'fixture-secret.for-local-model'}},
                        'verification': [{'id': 'answer', 'type': 'ExactMatch'},
                                         {'id': 'usage', 'type': 'ToolUsage', 'target_mcp': 'fixture_knowledge'}],
                        'scoring': [{'dimension': 'quality', 'type': 'ImmediateValue', 'source': 'answer.metrics.score'}],
                        'report': {'output_dir': 'reports'}}}
            path = root / 'task.yaml'
            path.write_text(yaml.safe_dump(raw))
            with patch.dict(os.environ, {'XDG_CONFIG_HOME': str(root / 'global')}):
                task = load_task(path)
                plan = check_task(task)
                self.assertTrue(plan['ready'], plan)
                self.assertEqual([p['capabilities']['mcp']['fixture_knowledge']['enabled'] for p in plan['experiments']], [False, True])
                self.assertTrue(all('fixture-converter' in p['capabilities']['available_agents'] for p in plan['experiments']))
                outcome = asyncio.run(run_task(task, lambda _: None))
                run_root = Path(outcome['runRoot'])
                summary = json.loads((run_root / 'experiments-report.json').read_text())
                self.assertEqual(outcome['exitCode'], 0, summary)
                off = load_report(run_root / 'experiments/without_mcp')[1]
                on = load_report(run_root / 'experiments/with_mcp')[1]
                self.assertEqual(off['records'][0]['verification']['usage']['metrics']['attempted'], 0)
                self.assertGreater(on['records'][0]['verification']['usage']['metrics']['succeeded'], 0)
                self.assertIn('tools/call', MCPService.methods)
                self.assertTrue((run_root / 'comparisons/with_mcp/comparison.json').is_file())
                for report in (off, on):
                    record = report['records'][0]
                    self.assertIn('fixture-converter', record['execution']['capabilities']['selected_plugins'])
                    self.assertTrue((Path(record['execution']['project']) / 'index.js').is_file())
                self.assertFalse((source / 'index.js').exists())
                self.assertEqual(json.loads((root / 'mcp.json').read_text())['mcp']['fixture_knowledge']['enabled'], True)

    def test_plugin_with_without_and_real_model_proxy_conversion(self):
        ModelService.requests = []
        ModelService.delay_after_tool = 0
        self.addCleanup(setattr, ModelService, 'delay_after_tool', 0)
        service = ThreadingHTTPServer(('127.0.0.1', 0), ModelService)
        thread = threading.Thread(target=service.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(service.server_close)
        self.addCleanup(service.shutdown)
        with tempfile.TemporaryDirectory(prefix='harmony-eval-live-test-') as temporary:
            root = Path(temporary)
            global_root = root / 'global/opencode'
            global_root.mkdir(parents=True)
            installed_config = Path.home() / '.config/opencode'
            # Reuse only installed SDK dependencies, never the user's capabilities or credentials.
            for name in ('package.json', 'package-lock.json', 'bun.lock'):
                if (installed_config / name).is_file():
                    shutil.copy2(installed_config / name, global_root / name)
            if (installed_config / 'node_modules').is_dir():
                shutil.copytree(installed_config / 'node_modules', global_root / 'node_modules')
            plugin = global_root / 'plugins/fixture-converter'
            plugin.mkdir(parents=True)
            (plugin / 'package.json').write_text(json.dumps({'name': 'fixture-converter', 'version': '1.0.0', 'type': 'module', 'main': 'plugin.js'}))
            (plugin / 'plugin.js').write_text("export default async () => ({ config(c) { c.agent ??= {}; c.agent['fixture-converter'] = {mode:'primary', prompt:'Complete conversion with available tools.'}; } });")
            (global_root / 'plugins/fixture-converter.js').symlink_to(plugin / 'plugin.js')
            (global_root / 'opencode.json').write_text('{}')
            dataset = root / 'dataset/case1'
            (dataset / 'source').mkdir(parents=True)
            (dataset / 'source/input.java').write_text('public class Source { public int add(int a, int b) { return a+b; } }')
            (dataset / 'PROMPT.md').write_text('Convert input.java to index.js in the project root, exporting function add(a,b). Use bash to write it, then finish.')
            (dataset / 'case.yaml').write_text(yaml.safe_dump({'id': 'simple-library', 'input': {'project': 'source', 'instruction': 'PROMPT.md'},
                'verification': {'tests': {
                    'build_command': ['node', '--check', 'index.js'],
                    'test_command': ['node', '--input-type=module', '-e', "import {add} from './index.js'; if (add(2,3)!==5 || add(-1,1)!==0) process.exit(1)"],
                    'exit_code_is_test_result': True}}}))
            raw = {'schema_version': 2, 'id': 'library-plugin-fixture', 'scenario': 'LibraryMigration',
                   'dataset': {'type': 'library-migration', 'dir': str(dataset.parent)},
                   'target': {'type': 'plugin_agent', 'dir': str(plugin)},
                   'plugin_agent': {'execution': {'engine': 'opencode', 'agent_name': 'fixture-converter', 'timeout': 90, 'idle_timeout': 60,
                       'model': {'name': 'fixture-model', 'base_url': f'http://127.0.0.1:{service.server_port}/v1', 'api_key': 'fixture-secret.for-local-model'}},
                       'verification': [{'id': 'tests', 'type': 'LibraryTests'}, {'id': 'api', 'type': 'LibraryAPICount'}],
                       'scoring': [{'dimension': 'functional', 'type': 'ImmediateValue', 'source': 'tests.metrics.pass_rate', 'scale': 100},
                                   {'dimension': 'api_count_consistency', 'type': 'ImmediateValue', 'source': 'api.metrics.count_consistency', 'scale': 100}],
                       'report': {'output_dir': str(root / 'reports'), 'format': 'html'}}}
            def load(raw):
                path = root / 'task.yaml'
                path.write_text(yaml.safe_dump(raw))
                return load_task(path)
            with patch.dict(os.environ, {'XDG_CONFIG_HOME': str(root / 'global'), 'FIXTURE_KEY': 'local-test-key'}):
                checked = check_task(load(raw))
                self.assertIn('fixture-converter', checked['capabilities']['agents'])
                baseline = deepcopy(raw)
                baseline['plugin_agent']['execution']['without_enable'] = True
                without = check_task(load(baseline))
                self.assertEqual(without['experimentCount'], 2)
                self.assertNotIn('fixture-converter', without['experiments'][0]['capabilities']['agents'])
                self.assertFalse(without['experiments'][0]['capabilities']['plugin'])
                outcome = asyncio.run(run_task(load(baseline), lambda _: None))
                run_root = Path(outcome['runRoot'])
                _, report = load_report(run_root / 'experiments/with')
                record = report['records'][0]
                self.assertEqual(record['execution']['status'], 'completed', record['execution'])
                self.assertEqual(outcome['exitCode'], 0, record['verification'])
                self.assertEqual(record['scores']['functional']['score'], 100)
                self.assertEqual(record['scores']['api_count_consistency']['score'], 50)
                self.assertEqual(record['verification']['api']['metrics']['source_total'], 2)
                self.assertTrue((Path(record['execution']['project']) / 'index.js').is_file())
                self.assertEqual(Path(record['execution']['project']).name, 'base')
                self.assertFalse((Path(record['execution']['project']) / 'generated').exists())
                self.assertGreaterEqual(len(ModelService.requests), 2)
                self.assertTrue(record['execution']['tool_calls'])
                self.assertTrue(Path(record['execution']['usage']['trace']).is_file())
                captured = json.loads(Path(record['execution']['usage']['trace']).read_text())
                self.assertEqual(captured['session_capture']['mode'], 'sqlite-readonly', captured['session_capture'])
                self.assertTrue(captured['model_trace'])
                _, baseline_report = load_report(run_root / 'experiments/without')
                self.assertEqual(baseline_report['records'][0]['execution']['status'], 'completed')
                self.assertNotIn('fixture-converter', baseline_report['records'][0]['execution']['capabilities']['agents'])
                self.assertTrue((run_root / 'comparisons/with/comparison.json').is_file())
                comparison = compare_reports(baseline_report, report, root / 'comparison')
                self.assertTrue(Path(comparison).is_file())
                self.assertTrue((global_root / 'plugins/fixture-converter.js').is_symlink())
                timed = deepcopy(raw)
                timed['plugin_agent']['execution'].update({'timeout': 20, 'idle_timeout': 1})
                ModelService.delay_after_tool = 3
                timed_outcome = asyncio.run(run_task(load(timed), lambda _: None))
                _, timed_report = load_report(timed_outcome['runRoot'])
                partial = timed_report['records'][0]['execution']
                self.assertEqual(partial['status'], 'timed_out', partial)
                self.assertIn('连续 1 秒无输出', partial['error'])
                self.assertIn('Preparing conversion.', partial['answer'])
                partial_trace = json.loads(Path(partial['usage']['trace']).read_text())
                self.assertTrue(partial_trace['model_trace']['events'])
                self.assertEqual(partial_trace['session_capture']['mode'], 'sqlite-readonly')
                for run_root in (outcome['runRoot'], timed_outcome['runRoot']):
                    for path in Path(run_root).rglob('*'):
                        if path.is_file() and path.suffix in ('.json', '.jsonl', '.yaml', '.html'):
                            self.assertNotIn('fixture-secret.for-local-model', path.read_text(), str(path))


if __name__ == '__main__':
    unittest.main()
