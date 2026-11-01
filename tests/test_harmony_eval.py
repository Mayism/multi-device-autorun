"""Contract and lifecycle tests using actual EvalScope with local HTTP services."""
import asyncio
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import yaml

from pyautorun.harmony_eval import dataset_adapters  # Register built-in datasets for direct adapter tests.
from pyautorun.harmony_eval.task import load_task
from pyautorun.harmony_eval.core import datasets, verifiers, VerificationResult, ExecutionResult
from pyautorun.harmony_eval.runner import run_task, replay, load_report, verification_identity
from pyautorun.harmony_eval.report import compare_reports
from pyautorun.harmony_eval.score_rules import calculate_scores
from pyautorun.harmony_eval.model import resolve_api_key
from pyautorun.harmony_eval.verification import pipeline


class Service(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        type(self).requests.append(raw)
        answer = '5' if raw.get('question') == '2+3' else 'different'
        data = json.dumps({'data': {'answer': answer, 'session_id': str(len(self.requests))}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class FrameworkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Service.requests = []
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Service)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='harmony-eval-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'data').mkdir()
        (self.root / 'data/questions.jsonl').write_text(json.dumps(
            {'id': 'q1', 'question': '2+3', 'reference_answers': ['5'], 'criteria': ['correct']}) + '\n')
        self.raw = {'schema_version': 2, 'id': 'test-http', 'scenario': 'QuestionAnswering',
                    'dataset': {'type': 'text-qa', 'dir': 'data'}, 'target': {'type': 'knowledge'},
                    'knowledge': {'rounds': 2, 'execution': {'engine': 'http',
                                  'http_url': f'http://127.0.0.1:{self.server.server_port}/ask',
                                  'request': {'json': {'question': '${case.question}'}},
                                  'response': {'answer_path': 'data.answer', 'session_id_path': 'data.session_id'}},
                                  'verification': [{'id': 'qa', 'type': 'ExactMatch'}],
                                  'scoring': [{'dimension': 'quality', 'type': 'ImmediateValue', 'source': 'qa.metrics.score'}],
                                  'report': {'output_dir': 'reports', 'format': 'html'}}}

    def task(self, raw=None):
        path = self.root / 'task.yaml'
        path.write_text(yaml.safe_dump(raw or self.raw))
        return load_task(path)

    def test_native_evalscope_http_rounds_and_offline_rescore(self):
        start = len(Service.requests)
        task = self.task()
        outcome = asyncio.run(run_task(task, lambda _: None))
        self.assertEqual(outcome['exitCode'], 0)
        root, report = load_report(outcome['runRoot'])
        self.assertEqual(report['aggregate']['quality']['mean'], 100)
        self.assertEqual(report['planned_samples'], 2)
        self.assertEqual(len(Service.requests) - start, 2)
        self.assertTrue(list((root / 'evalscope/predictions').rglob('*.jsonl')))
        self.raw['knowledge']['scoring'][0]['scale'] = 0.5
        replay(self.task(), root)
        _, rescored = load_report(root)
        self.assertEqual(rescored['aggregate']['quality']['mean'], 50)
        self.assertEqual(len(Service.requests) - start, 2)
        self.raw['knowledge']['execution']['timeout'] = 30
        with self.assertRaisesRegex(ValueError, '不能复用'):
            replay(self.task(), root)

    def test_dataset_type_not_bound_to_scenario_and_agent_without_rejected(self):
        raw = deepcopy(self.raw)
        raw['scenario'] = 'KnowledgeEval'
        self.assertEqual(self.task(raw)['dataset']['type'], 'text-qa')
        raw['knowledge']['execution']['without_enable'] = True
        with self.assertRaisesRegex(ValueError, '仅用于'):
            self.task(raw)

    def test_literal_key_does_not_enter_normalized_task_or_caches(self):
        literal = 'fixture-secret.for-local-model'
        self.raw['knowledge']['verification'][0] = {'id': 'qa', 'type': 'LLM_judge', 'model': {
            'name': 'fixture-model', 'base_url': 'http://127.0.0.1:1/v1', 'api_key': literal}}
        task = self.task()
        model = task['active']['verification'][0]['model']
        self.assertEqual(resolve_api_key(model), literal)
        self.assertNotIn(literal, json.dumps(task))
        self.assertTrue(model['api_key'].startswith('__HARMONY_EVAL_INLINE_KEY_'))
        with patch.dict(os.environ, {'FIXTURE_MODEL_KEY': 'environment-key'}):
            self.assertEqual(resolve_api_key({'api_key': 'FIXTURE_MODEL_KEY'}), 'environment-key')

    def test_cycle_duplicate_ids_and_unknown_adapters_rejected(self):
        raw = deepcopy(self.raw)
        raw['knowledge']['verification'] = [{'id': 'a', 'type': 'ExactMatch', 'depends_on': ['b']},
                                             {'id': 'b', 'type': 'ExactMatch', 'depends_on': ['a']}]
        with self.assertRaisesRegex(ValueError, '成环'):
            self.task(raw)
        raw['knowledge']['verification'] = [{'id': 'same', 'type': 'ExactMatch'}, {'id': 'same', 'type': 'ExactMatch'}]
        with self.assertRaisesRegex(ValueError, '重复'):
            self.task(raw)
        raw['knowledge']['verification'] = [{'type': 'NotRegistered'}]
        with self.assertRaisesRegex(ValueError, '未知'):
            self.task(raw)

    def test_missing_evidence_never_scores_zero_and_negative_weights(self):
        results = {'ui': {'status': 'completed', 'metrics': {'pass_rate': 0.8}},
                   'code': {'status': 'completed', 'metrics': {'total_score': 65},
                            'dimensions': [{'name': 'a', 'score': 15, 'max_score': 20},
                                           {'name': 'b', 'score': 60, 'max_score': 80}]}}
        rules = [{'dimension': 'L2', 'type': 'WeightedSummation', 'base_score': 100,
                  'components': [{'name': 'UX', 'source': 'ui.metrics.pass_rate', 'range': [0, 1], 'weight': 0.5},
                                 {'name': 'Whitebox', 'source': 'code.dimensions', 'reducer': 'proportional_deduction',
                                  'cap_source': 'code.metrics.total_score', 'weight': 0.5}]}]
        self.assertEqual(calculate_scores(results, rules)['L2']['score'], 72.5)
        results['code']['status'] = 'unavailable'
        result = calculate_scores(results, rules)['L2']
        self.assertEqual(result['status'], 'unavailable')
        self.assertIsNone(result['score'])

    def test_migration_references_not_exposed_and_source_not_mutated(self):
        case = self.root / 'migration/case1'
        (case / 'source').mkdir(parents=True)
        (case / 'grading').mkdir()
        (case / 'source/input.java').write_text('original')
        (case / 'PROMPT.md').write_text('Convert the library.')
        (case / 'grading/reference.txt').write_text('hidden answer')
        (case / 'case.yaml').write_text(yaml.safe_dump({'id': 'migration1',
            'input': {'project': 'source', 'instruction': 'PROMPT.md'},
            'expected': {'tests': 'grading'}}))
        adapter = datasets.get('library-migration')()
        items = adapter.load({'dir': str(case.parent), 'type': 'library-migration'})
        workspace = self.root / 'workspace'
        adapter.prepare(items[0], workspace)
        self.assertEqual(items[0].public()['case_id'], 'migration1')
        self.assertTrue(items[0].public()['question'].startswith('Convert the library.'))
        self.assertIn('base/', items[0].public()['question'])
        self.assertNotIn('grading', items[0].public()['question'])
        self.assertEqual(adapter.project_path(items[0], workspace), workspace)
        self.assertFalse((workspace / 'grading').exists())
        (workspace / 'input.java').write_text('changed')
        self.assertEqual((case / 'source/input.java').read_text(), 'original')
        self.assertFalse((workspace / 'case.yaml').exists())

    def test_third_party_workflow_registration_and_dependencies(self):
        calls = []
        class Custom:
            def requirements(self, config):
                return []
            async def verify(self, case, execution, dependencies, context, config):
                calls.append((config['id'], sorted(dependencies)))
                return VerificationResult(config['id'], 'completed', metrics={'score': 73})
        verifiers.items['FixtureExtension'] = Custom
        self.addCleanup(verifiers.items.pop, 'FixtureExtension')
        raw = deepcopy(self.raw)
        raw['knowledge']['verification'] = [{'id': 'first', 'type': 'FixtureExtension'},
                                             {'id': 'second', 'type': 'FixtureExtension', 'depends_on': ['first']}]
        raw['knowledge']['scoring'][0]['source'] = 'second.metrics.score'
        task = self.task(raw)
        case = datasets.get('text-qa')().load(task['dataset'])[0]
        values = asyncio.run(pipeline(task, case, ExecutionResult('completed', answer='5'), self.root / 'out'))
        self.assertEqual(calls, [('first', []), ('second', ['first'])])
        self.assertEqual(values['second']['metrics']['score'], 73)

    def test_external_workflow_paths_and_evidence_invalidation(self):
        directory = self.root / 'workflows'
        directory.mkdir()
        prompt = directory / 'prompt.md'
        prompt.write_text('Version one')
        workflow = directory / 'qa.yaml'
        workflow.write_text(yaml.safe_dump({'steps': [{'id': 'match', 'type': 'ExactMatch', 'prompt_path': 'prompt.md'}],
                                             'metrics': {'score': 'match.metrics.score'}}))
        self.raw['knowledge']['verification'] = [{'id': 'qa', 'type': 'Workflow', 'workflow_path': 'workflows/qa.yaml'}]
        task = self.task()
        flow = task['active']['verification'][0]
        self.assertEqual(flow['steps'][0]['prompt_path'], str(prompt.resolve()))
        cases = datasets.get('text-qa')().load(task['dataset'])
        before = verification_identity(task, cases)
        values = asyncio.run(pipeline(task, cases[0], ExecutionResult('completed', answer='5'), self.root / 'out'))
        self.assertEqual(values['qa']['metrics']['score'], 100)
        prompt.write_text('Version two')
        self.assertNotEqual(before, verification_identity(task, cases))
        workflow.write_text(yaml.safe_dump({'steps': [{'type': 'Workflow', 'workflow_path': 'qa.yaml'}]}))
        with self.assertRaisesRegex(ValueError, '循环引用'):
            self.task()

    def test_zero_samples_transport_failure_still_writes_incomplete_report(self):
        self.raw['knowledge']['execution']['http_url'] = 'http://127.0.0.1:1/not-running'
        self.raw['knowledge']['execution']['timeout'] = 1
        outcome = asyncio.run(run_task(self.task(), lambda _: None))
        self.assertEqual(outcome['exitCode'], 1)
        _, report = load_report(outcome['runRoot'])
        self.assertEqual(report['execution_summary']['failed'], 2)
        self.assertIsNone(report['aggregate']['quality']['mean'])
        self.assertEqual(report['records'][0]['scores']['quality']['status'], 'unavailable')

    def test_verification_can_change_without_regenerating_predictions(self):
        task = self.task()
        before = len(Service.requests)
        outcome = asyncio.run(run_task(task, lambda _: None))
        self.raw['knowledge']['verification'].append({'id': 'observe', 'type': 'ToolUsage', 'target_mcp': 'disabled'})
        with self.assertRaisesRegex(ValueError, '先verify'):
            replay(self.task(), outcome['runRoot'])
        replay(self.task(), outcome['runRoot'], verify=True)
        _, data = load_report(outcome['runRoot'])
        self.assertIn('observe', data['records'][0]['verification'])
        self.assertEqual(len(Service.requests) - before, 2)

    def test_composite_workflow_and_raw_repository_layout(self):
        self.raw['knowledge']['verification'] = [{'id': 'qa', 'type': 'Workflow',
            'steps': [{'id': 'exact', 'type': 'ExactMatch'}], 'metrics': {'score': 'exact.metrics.score'}}]
        outcome = asyncio.run(run_task(self.task(), lambda _: None))
        self.assertEqual(outcome['exitCode'], 0)
        repo = self.root / 'repositories/library'
        repo.mkdir(parents=True)
        (repo / 'pubspec.yaml').write_text('name: fixture')
        cases = datasets.get('library-migration')().load({'type': 'library-migration',
            'dir': str(repo.parent), 'layout': 'repositories', 'instruction': 'Convert the current library.'})
        self.assertEqual(cases[0].case_id, 'library')
        self.assertNotIn('output_project', cases[0].expected)

    def test_common_project_directory_with_template_preserves_source(self):
        case = self.root / 'migration/template-case'
        (case / 'source').mkdir(parents=True)
        (case / 'template').mkdir()
        (case / 'source/build.gradle').write_text('original Android build')
        (case / 'template/build-profile.json5').write_text('HarmonyOS template')
        (case / 'PROMPT.md').write_text('Convert the application.')
        (case / 'case.yaml').write_text(yaml.safe_dump({'id': 'template-case', 'input': {
            'project': 'source', 'instruction': 'PROMPT.md', 'target_template': 'template'}}))
        adapter = datasets.get('android-migration')()
        item = adapter.load({'dir': str(case.parent), 'type': 'android-migration'})[0]
        workspace = self.root / 'case-output/base'
        adapter.prepare(item, workspace)
        self.assertEqual((workspace.parent / 'input/build.gradle').read_text(), 'original Android build')
        self.assertTrue((workspace / 'build-profile.json5').is_file())
        self.assertFalse((workspace / 'build.gradle').exists())
        self.assertIn('../input/', item.question)
        before = adapter.fingerprint(item)
        (case / 'template/build-profile.json5').write_text('Updated template')
        self.assertNotEqual(before, adapter.fingerprint(item))

    def test_web_composite_project_remains_locatable_without_expected_output(self):
        folder = self.root / 'multidev/web-case'
        (folder / 'base').mkdir(parents=True)
        (folder / 'web').mkdir()
        (folder / 'PROMPT.md').write_text('Adapt the web container.')
        (folder / 'metadata.json').write_text(json.dumps({'platform': 'web'}))
        (folder / 'base/project.txt').write_text('native container')
        (folder / 'web/index.html').write_text('web page')
        adapter = datasets.get('swe-bench-hm-multi-dev')()
        item = adapter.load({'dir': str(folder.parent)})[0]
        workspace = self.root / 'web-output/base'
        adapter.prepare(item, workspace)
        self.assertEqual(adapter.project_path(item, workspace), workspace.resolve() / 'base')
        self.assertTrue((workspace / 'web/index.html').is_file())
        self.assertFalse((workspace / 'metadata.json').exists())

    def test_invalid_reference_path_and_duplicate_case_ids(self):
        (self.root / 'data/second.jsonl').write_text(json.dumps({'id': 'q1', 'question': 'duplicate'}))
        with self.assertRaisesRegex(ValueError, '重复'):
            datasets.get('text-qa')().load(self.task()['dataset'])

    def test_different_rules_not_comparable(self):
        outcome = asyncio.run(run_task(self.task(), lambda _: None))
        _, data = load_report(outcome['runRoot'])
        other = deepcopy(data)
        other['scoring_fingerprint'] = 'different'
        with self.assertRaisesRegex(ValueError, '评分规则不同'):
            compare_reports(data, other, self.root / 'compare')
        result = compare_reports(data, data, self.root / 'compare')
        self.assertTrue(Path(result).is_file())
        data['scenario'] = 'KnowledgeEval'
        data['execution_config']['opencode'] = {'config_path': '/with-mcp.json'}
        for record in data['records']:
            record['execution']['capabilities']['host_config_fingerprint'] = 'same-resolved-host'
        other = deepcopy(data)
        other['execution_config']['opencode']['config_path'] = '/without-mcp.json'
        self.assertTrue(Path(compare_reports(data, other, self.root / 'compare')).is_file())
        other['records'][0]['execution']['capabilities']['host_config_fingerprint'] = 'different-host'
        with self.assertRaisesRegex(ValueError, '宿主配置'):
            compare_reports(data, other, self.root / 'compare')


if __name__ == '__main__':
    unittest.main()
