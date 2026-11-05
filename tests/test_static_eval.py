"""Independent static task configuration, concurrency, processes and failure isolation."""

import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import yaml

from harmonyeval.config import load_task
from harmonyeval.evaluator.coordinator import run_parallel
from harmonyeval.models.compatibility import resolve_api_key
from harmonyeval.static_eval.config import discover_skills
from harmonyeval.static_eval.service import run_check, run_static_eval


class StaticEvalTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='harmonyeval-static-test-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / '中文 空格 🚀'
        self.root.mkdir()
        self.skills = self.root / 'skills'
        for name in ('skill-a', 'nested/skill-b', 'node_modules/ignored'):
            folder = self.skills / name
            folder.mkdir(parents=True)
            (folder / 'SKILL.md').write_text('---\nname: sample\ndescription: fixture\n---\nfixture', encoding='utf-8')
        self.key = 'local-fixture.secret-key'
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {'STATIC_TEST_KEY': self.key}).start()
        self.task = {'id': 'static-test', 'target': {'type': 'skills', 'dir': str(self.skills)},
                     'active': {'execution': {'without_enable': True}, 'report': {'output_dir': str(self.root / 'reports')},
                                'static_eval': {'enabled': True, 'skill_roots': [str(self.skills)],
                                    'checks': ['quality', 'security'], 'timeout': 5, 'concurrency': 2,
                                    'model': {'name': 'fixture', 'base_url': 'http://127.0.0.1:9/v1', 'api_key': 'STATIC_TEST_KEY'}}}}

    def test_config_and_discovery_preserve_credentials_and_scope(self):
        data = self.root / 'cases.json'
        data.write_text('[{"id":"q","question":"Q"}]', encoding='utf-8')
        raw = {'schema_version': 2, 'id': 'test', 'scenario': 'QuestionAnswering',
               'target': {'type': 'knowledge'}, 'dataset': {'type': 'text-qa', 'dir': str(data)},
               'knowledge': {'static_eval': {**self.task['active']['static_eval'],
                    'model': {**self.task['active']['static_eval']['model'], 'api_key': self.key}},
                    'execution': {'engine': 'http', 'http_url': 'http://127.0.0.1:9'},
                    'verification': [], 'scoring': [], 'report': {'output_dir': './out'}}}
        path = self.root / 'task.yaml'
        path.write_text(yaml.safe_dump(raw, allow_unicode=True), encoding='utf-8')
        loaded = load_task(path)
        cfg = loaded['active']['static_eval']
        self.assertEqual(resolve_api_key(cfg['model']), self.key)
        self.assertNotIn(self.key, json.dumps(loaded))
        self.assertEqual([p.name for p in discover_skills(cfg)], ['skill-b', 'skill-a'])
        from harmonyeval.evaluator.preflight import check_task
        with patch('harmonyeval.static_eval.config.plan', side_effect=PermissionError('static inputs unavailable')):
            planned = check_task(loaded, inspect=False)
        self.assertTrue(planned['ready'])
        self.assertEqual(planned['static_eval']['status'], 'unavailable')
        raw['knowledge']['static_eval'] = {}
        path.write_text(yaml.safe_dump(raw), encoding='utf-8')
        self.assertEqual(load_task(path)['active']['static_eval'], {})
        raw['knowledge']['static_eval'] = {'model': cfg['model']}
        path.write_text(yaml.safe_dump(raw), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'skill_roots'):
            load_task(path)

    def test_parallel_branches_overlap_and_static_runs_once(self):
        main_started, static_started = threading.Event(), threading.Event()
        def main(task, on_log, cancel, root):
            main_started.set()
            self.assertTrue(static_started.wait(3), 'static branch waited for main to finish')
            path = Path(root) / 'index.html'; path.write_text('main', encoding='utf-8')
            return {'exitCode': 0, 'reportPath': str(path), 'records': 4}
        async def static(task, root, cancel, log):
            static_started.set()
            self.assertTrue(await asyncio.to_thread(main_started.wait, 3))
            root.mkdir(); path = root / 'index.html'; path.write_text('static', encoding='utf-8')
            return {'exitCode': 0, 'status': 'completed', 'reportPath': str(path)}
        with patch('harmonyeval.evaluator.coordinator.run_static_eval', side_effect=static) as called:
            result = asyncio.run(run_parallel(self.task, main, threading.Event(), lambda _: None))
        self.assertEqual(called.call_count, 1)
        self.assertEqual(result['exitCode'], 0)
        summary = json.loads((Path(result['runRoot']) / 'run-summary.json').read_text(encoding='utf-8'))
        self.assertEqual(summary['main']['records'], 4)
        self.assertNotIn('static_eval', summary['main'])

    def test_static_only_loading_does_not_require_main_dataset_or_agent(self):
        from harmonyeval.config.loader import load_static_task
        path = self.root / 'static-only.yaml'
        raw = {'id': 'static-only', 'target': {'type': 'harmonybot_agent', 'dir': './missing-bundle'},
               'harmonybot_agent': {'static_eval': self.task['active']['static_eval']}}
        path.write_text(yaml.safe_dump(raw), encoding='utf-8')
        loaded = load_static_task(path)
        self.assertEqual(len(discover_skills(loaded['active']['static_eval'])), 2)
        self.assertNotIn('execution', loaded['active'])
        self.assertEqual(resolve_api_key(loaded['active']['static_eval']['model']), self.key)

    def test_each_branch_failure_preserves_other_branch(self):
        for failed in ('main', 'static'):
            with self.subTest(failed=failed):
                completed = []
                def main(task, log, cancel, root):
                    if failed == 'main': raise RuntimeError('main failure')
                    completed.append('main')
                    return {'exitCode': 0, 'records': 1}
                async def static(*args):
                    if failed == 'static': raise RuntimeError('static failure')
                    completed.append('static')
                    return {'exitCode': 0, 'status': 'completed'}
                with patch('harmonyeval.evaluator.coordinator.run_static_eval', side_effect=static):
                    result = asyncio.run(run_parallel(self.task, main, threading.Event(), lambda _: None))
                self.assertEqual(completed, ['static' if failed == 'main' else 'main'])
                self.assertEqual(result['exitCode'], 1)
                self.assertTrue(Path(result['reportPath']).exists())

    def test_tool_failure_is_not_a_zero_or_safe_result(self):
        async def run(check, skill, model, output, timeout, cancel):
            if check == 'quality': raise ValueError('provider error ' + model['api_key'])
            return {'status': 'completed', 'metrics': {'is_safe': False, 'findings_count': 2}}
        with patch('harmonyeval.static_eval.config.metadata.version', side_effect=lambda p: {'agent-extension-eval':'0.2.0','skill-security-scan':'1.2.3'}[p]), \
                patch('harmonyeval.static_eval.service.run_check', side_effect=run) as called:
            result = asyncio.run(run_static_eval(self.task, self.root / 'out', on_log=lambda _: None))
        self.assertEqual(called.call_count, 4)
        self.assertEqual(result['exitCode'], 1)
        payload = (self.root / 'out/static-result.json').read_text(encoding='utf-8')
        self.assertNotIn(self.key, payload)
        rows = json.loads(payload)['results']
        self.assertTrue(all(r['status'] == 'unavailable' and 'metrics' not in r for r in rows if r['check']=='quality'))
        self.assertTrue(all(r['status']=='completed' and not r['metrics']['is_safe'] for r in rows if r['check']=='security'))

    def test_cancelling_task_signals_both_branches_and_keeps_summary(self):
        from harmonyeval.evaluator.runner import run_task
        main_started, static_started = threading.Event(), threading.Event()
        def main(task, log, cancel, root):
            main_started.set()
            self.assertTrue(cancel.wait(3))
            return {'exitCode': 1, 'records': 0}
        async def static(task, root, cancel, log):
            static_started.set()
            self.assertTrue(await asyncio.to_thread(cancel.wait, 3))
            return {'exitCode': 1, 'status': 'interrupted'}
        async def execute():
            future = asyncio.create_task(run_task(self.task, lambda _: None))
            self.assertTrue(await asyncio.to_thread(main_started.wait, 3))
            self.assertTrue(static_started.is_set())
            future.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await future
        with patch('harmonyeval.experiments.runner._run_sync', side_effect=main), \
                patch('harmonyeval.evaluator.coordinator.run_static_eval', side_effect=static):
            asyncio.run(execute())
        summaries = list((self.root / 'reports').rglob('run-summary.json'))
        self.assertEqual(len(summaries), 1)
        self.assertEqual(json.loads(summaries[0].read_text(encoding='utf-8'))['static_eval']['status'], 'interrupted')

    def test_worker_stdin_secret_redaction_stale_results_timeout_and_cancel(self):
        script = self.root / 'worker.py'
        script.write_text('''import json,sys,time
from pathlib import Path
r=json.load(sys.stdin); out=Path(r['output'])
print(r['model']['api_key'],flush=True)
if r['model']['name']=='slow': time.sleep(30)
if r['model']['name']=='empty': raise SystemExit(0)
(out/'quality_eval.json').write_text('{}',encoding='utf-8')
(out/'result.json').write_text(json.dumps({'status':'completed','report':'quality_eval.json'}),encoding='utf-8')
''', encoding='utf-8')
        model = {**self.task['active']['static_eval']['model'], 'api_key': self.key}
        async def run():
            output = self.root / 'worker-output'
            result = await run_check('quality', self.skills / 'skill-a', model, output, 3, command=[sys.executable,str(script)])
            self.assertEqual(result['status'], 'completed')
            self.assertNotIn(self.key, (output/'worker.log').read_text(encoding='utf-8'))
            with self.assertRaises(FileNotFoundError):
                await run_check('quality', self.skills, {**model,'name':'empty'}, output, 3, command=[sys.executable,str(script)])
            timed = await run_check('quality', self.skills, {**model,'name':'slow'}, output, .2, command=[sys.executable,str(script)])
            self.assertEqual(timed['status'], 'timed_out')
            with patch('harmonyeval.static_eval.service.time.time', side_effect=[0, 1000]):
                resumed = await run_check('quality', self.skills, {**model,'name':'slow'}, output, 300, command=[sys.executable,str(script)])
            self.assertEqual(resumed['status'], 'timed_out')
            cancel = threading.Event()
            future = asyncio.create_task(run_check('quality',self.skills,{**model,'name':'slow'},output,10,cancel,command=[sys.executable,str(script)]))
            await asyncio.sleep(.15); cancel.set()
            self.assertEqual((await future)['status'], 'interrupted')
        asyncio.run(run())


@unittest.skipUnless(os.environ.get('HARMONY_EVAL_STATIC_INTEGRATION') == '1', 'opt-in real wheel APIs with local LLM server')
class WheelIntegrationTest(unittest.TestCase):
    def test_both_wheels_reach_local_llm_and_render_native_reports(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from importlib.metadata import distribution
        import re
        dist = distribution('agent-extension-eval')
        rubric_file = next(p for p in dist.files if p.name == 'quality_rubric.json')
        rubric = json.loads(Path(dist.locate_file(rubric_file)).read_text(encoding='utf-8'))
        quality = {'pattern': rubric['patterns'][0], 'knowledge_ratio': {'E': .5, 'A': .5, 'R': 0},
                   'critical_issues': [], 'top3_improvements': [], 'findings': [], 'improvements': [], 'consistency_adjudications': [],
                   'dimensions': [{'id': d['id'], 'score': d['weight'], 'confidence': d['confidence'],
                       'evidence': 'SKILL.md:L1 包含技能声明', 'rationale': '本地测试固定响应，仅验证接口转换。',
                       'low_confidence': d['id']=='D10'} for d in rubric['dimensions']]}
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(body)
                if self.path == '/answer':
                    payload = b'{"answer":"A"}'
                    self.send_response(200); self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload)
                    return
                prompt = json.dumps(body.get('messages', []), ensure_ascii=False)
                if 'knowledge_ratio' in prompt and 'D10' in prompt:
                    answer = quality
                elif 'summary_text' in prompt and 'expected_assessment' in prompt:
                    match = re.search(r'expected_assessment[^:]*:\s*\\?"([^"\\]+)', prompt)
                    answer = {'assessment': match.group(1) if match else 'safe', 'summary_text': '本地接口验证，结果需结合扫描证据。'}
                else: answer = {'findings': []}
                payload = json.dumps({'id':'fixture','object':'chat.completion','created':1,'model':body['model'],
                    'choices':[{'index':0,'message':{'role':'assistant','content':json.dumps(answer, ensure_ascii=False)},'finish_reason':'stop'}],
                    'usage':{'prompt_tokens':10,'completion_tokens':10,'total_tokens':20}}, ensure_ascii=False).encode('utf-8')
                self.send_response(200); self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(payload))); self.end_headers(); self.wfile.write(payload)
        server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(thread.join); self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix='harmonyeval-static-wheel-') as temporary:
            root=Path(temporary); skill=root/'fixture-skill'; skill.mkdir()
            (skill/'SKILL.md').write_text('---\nname: fixture-skill\ndescription: Use this skill only when checking a fixed local arithmetic example.\n---\n# fixture-skill\n读取输入中的两个数字，计算相加结果并返回。\n', encoding='utf-8')
            task={'id':'real-wheel-fixture','active':{'static_eval':{'enabled':True,'skill_roots':[str(skill)],'checks':['quality','security'],
                'concurrency':2,'timeout':60,'model':{'name':'fixture','api_key':'STATIC_FIXTURE_KEY','base_url':f'http://127.0.0.1:{server.server_port}/v1'}}}}
            questions = root / 'cases.json'
            questions.write_text('[{"id":"q","question":"Q","reference_answer":"A"}]', encoding='utf-8')
            raw = {'schema_version': 2, 'id': task['id'], 'scenario': 'QuestionAnswering',
                   'dataset': {'type': 'text-qa', 'dir': str(questions)}, 'target': {'type': 'knowledge'},
                   'knowledge': {'rounds': 2, 'static_eval': task['active']['static_eval'],
                        'execution': {'engine': 'http', 'http_url': f'http://127.0.0.1:{server.server_port}/answer',
                            'request': {'json': {'question': '${case.question}'}}, 'response': {'answer_path': 'answer'}},
                        'verification': [{'id': 'qa', 'type': 'ExactMatch'}],
                        'scoring': [{'dimension': 'quality', 'type': 'ImmediateValue', 'source': 'qa.metrics.score'}],
                        'report': {'output_dir': str(root / 'reports')}}}
            source = root / 'task.yaml'
            source.write_text(yaml.safe_dump(raw), encoding='utf-8')
            from harmonyeval.evaluator.runner import run_task
            with patch.dict(os.environ,{'STATIC_FIXTURE_KEY':'fixture-static-secret.for-local-server'}):
                result=asyncio.run(run_task(load_task(source),lambda _:None))
            run_root = Path(result['runRoot'])
            static_root = run_root / 'static-eval'
            payload=json.loads((static_root/'static-result.json').read_text(encoding='utf-8'))
            main_report = json.loads((run_root / 'task-report.json').read_text(encoding='utf-8'))
            self.assertEqual(main_report['aggregate']['quality']['mean'], 100)
            self.assertEqual(len(main_report['records']), 2)
            self.assertEqual(result['exitCode'],0,payload)
            self.assertEqual(len(payload['results']),2)
            self.assertGreaterEqual(len(requests),2)
            for item in payload['results']:
                report=static_root/item['html_path']
                self.assertTrue(report.is_file())
                raw=json.loads(report.with_suffix('.json').read_text(encoding='utf-8'))
                if item['check']=='quality':
                    self.assertEqual(raw['max'],120)
                    self.assertEqual(len(raw['dimensions']),10)
                else:
                    self.assertIn('llm_analyzer',raw['analyzers_used'])
                    self.assertFalse(raw.get('analyzers_failed'))
            for path in run_root.rglob('*'):
                if path.is_file():
                    self.assertNotIn('fixture-static-secret.for-local-server',path.read_text(encoding='utf-8'))
            # The wheel must keep overflow diagnostic-only instead of starting
            # another Agent or turning an unscored report into a quality score.
            before = len(requests)
            overflow_root = root / 'overflow'
            overflow = asyncio.run(run_check('quality', skill, {
                **task['active']['static_eval']['model'], 'api_key': 'fixture-static-secret.for-local-server',
                'max_context_tokens': 32,
            }, overflow_root, 60))
            self.assertEqual(overflow['status'], 'unavailable')
            self.assertEqual(overflow['metrics'], {})
            self.assertEqual(len(requests), before)
            native = json.loads((overflow_root / 'quality_eval.json').read_text(encoding='utf-8'))
            self.assertTrue(native['context_overflow'])
            self.assertIsNone(native['total'])


if __name__ == '__main__':
    unittest.main()
