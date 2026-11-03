"""MCP experiments keep plugins fixed and reject unrelated comparison changes."""
import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml

from harmonyeval.config.loader import load_task
from harmonyeval.api.contracts import ExecutionResult
from harmonyeval.api.registry import executors, datasets
from harmonyeval.experiments.config import expand_experiments
from harmonyeval.report.comparison import compare_reports
from harmonyeval.evaluator.preflight import check_task
from harmonyeval.report.io import load_report
from harmonyeval.evaluator.replay import replay
from harmonyeval.evaluator.runner import run_task
from harmonyeval.agent.targets.opencode import OpenCodeTarget
from harmonyeval.verification.pipeline import pipeline


class ExperimentsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='harmony-eval-experiments-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.host = self.root / 'global/opencode'
        self.host.mkdir(parents=True)
        (self.host / 'opencode.json').write_text('{}')
        self.plugin = self.root / 'converter'
        self.plugin.mkdir()
        (self.plugin / 'package.json').write_text(json.dumps({'main': 'index.js'}))
        (self.plugin / 'index.js').write_text('export default async () => ({});')
        data = self.root / 'data/source'
        data.mkdir(parents=True)
        (data / 'original.js').write_text('export const original = 1;')
        (self.root / 'mcp.json').write_text(json.dumps({'mcp': {
            'knowledge': {'type': 'remote', 'url': 'http://127.0.0.1:1/mcp', 'enabled': True},
            'unrelated': {'type': 'remote', 'url': 'http://127.0.0.1:2/mcp', 'enabled': False}}}))
        self.raw = {'schema_version': 2, 'id': 'plugin-mcp', 'scenario': 'LibraryMigration',
                    'target': {'type': 'plugin_agent', 'dir': str(self.plugin)},
                    'dataset': {'type': 'library-migration', 'dir': 'data', 'layout': 'repositories',
                                'instruction': 'Convert the library.', 'expected': {'reference_answers': ['yes']}},
                    'experiments': [self.group('without_mcp', False), self.group('with_mcp', True)],
                    'plugin_agent': {'execution': {'engine': 'opencode', 'agent_name': 'converter',
                        'without_enable': False, 'opencode': {'config_path': 'mcp.json'},
                        'model': {'name': 'fixture', 'api_key': 'fixture-secret.for-local-test',
                                  'base_url': 'http://127.0.0.1:1/v1'}},
                        'verification': [{'id': 'quality', 'type': 'ExactMatch'},
                                         {'id': 'usage', 'type': 'ToolUsage', 'target_mcp': 'knowledge'}],
                        'scoring': [{'dimension': 'quality', 'type': 'ImmediateValue', 'source': 'quality.metrics.score'}],
                        'report': {'output_dir': 'reports'}}}
        self.source = {'binary': sys.executable, 'config_root': str(self.host), 'distribution': 'opencode'}
        self.addCleanup(patch.stopall)
        patch.object(OpenCodeTarget, 'source', return_value=self.source).start()

    @staticmethod
    def group(name, enabled):
        return {'id': name, 'overrides': {'mcp': {'knowledge': {'enabled': enabled}}}}

    def task(self, raw=None):
        path = self.root / 'task.yaml'
        path.write_text(yaml.safe_dump(self.raw if raw is None else raw))
        return load_task(path)

    def fixture_executor(self, calls, fail=False):
        class FixtureExecutor:
            async def execute(inner, case, target, context):
                task = context['task']
                name = task['experiment']['id']
                enabled = target['config']['mcp']['knowledge']['enabled']
                calls.append((name, enabled, context['workspace'], target['manifest']['selected_plugins']))
                if fail and not enabled:
                    raise RuntimeError('fixture execution failed')
                (Path(context['workspace']) / 'generated.txt').write_text(name)
                manifest = deepcopy(target['manifest'])
                manifest['version'] = 'fixture-1'
                manifest['mcp_comparison_effective_fingerprint'] = manifest['mcp_comparison_fingerprint']
                return ExecutionResult('completed', answer='yes' if enabled else 'no', capabilities=manifest,
                    tool_calls=[{'name': 'knowledge_search', 'status': 'completed'}] if enabled else [])
        original = executors.items['opencode']
        executors.items['opencode'] = FixtureExecutor
        self.addCleanup(executors.items.__setitem__, 'opencode', original)

    def test_config_validation_and_independent_expansion(self):
        task = self.task()
        children = expand_experiments(task)
        children[0]['active']['execution']['agent_name'] = 'other'
        self.assertEqual(children[1]['active']['execution']['agent_name'], 'converter')
        self.assertEqual(task['active']['execution']['agent_name'], 'converter')
        invalid = [[], [self.group('same', True), self.group('same', False)],
                   [self.group('../escape', True)],
                   [{'id': 'x', 'overrides': {'model': {'name': 'other'}}}],
                   [{'id': 'x', 'overrides': {'mcp': {'knowledge': {'enabled': 'false'}}}}],
                   [{'id': 'x', 'overrides': {'mcp': {'knowledge': {'enabled': True, 'url': 'other'}}}}],
                   [self.group('x', True), {'id': 'y', 'overrides': {'mcp': {'different': {'enabled': False}}}}]]
        for experiments in invalid:
            with self.subTest(experiments=experiments):
                raw = deepcopy(self.raw)
                raw['experiments'] = experiments
                with self.assertRaises(ValueError):
                    self.task(raw)
        raw = deepcopy(self.raw)
        raw['target'] = {'type': 'knowledge'}
        raw['knowledge'] = raw.pop('plugin_agent')
        raw['knowledge']['execution'] = {'engine': 'http', 'http_url': 'http://127.0.0.1:1/answer'}
        with self.assertRaisesRegex(ValueError, '仅支持'):
            self.task(raw)

    def test_private_configuration_and_undefined_mcp_preflight(self):
        before = (self.root / 'mcp.json').read_bytes()
        task = self.task()
        plan = check_task(task, inspect=False)
        self.assertTrue(plan['ready'], plan)
        self.assertEqual([p['capabilities']['mcp']['knowledge']['enabled'] for p in plan['experiments']], [False, True])
        self.assertEqual([p['capabilities']['selected_plugins'] for p in plan['experiments']], [['converter'], ['converter']])
        self.assertEqual((self.root / 'mcp.json').read_bytes(), before)
        (self.root / 'mcp.json').write_text('{}')
        failed = check_task(task, inspect=False)
        self.assertFalse(failed['ready'])
        self.assertTrue(all('未定义' in p['error'] for p in failed['experiments']))
        with self.assertRaisesRegex(ValueError, '运行前检查失败'):
            asyncio.run(run_task(task, lambda _: None))
        self.assertFalse((self.root / 'reports').exists())

    def test_evalscope_groups_outputs_comparison_and_replay(self):
        calls = []
        self.fixture_executor(calls)
        task = self.task()
        result = asyncio.run(run_task(task, lambda _: None))
        self.assertEqual(result['exitCode'], 0)
        root = Path(result['runRoot'])
        summary = json.loads((root / 'experiments-report.json').read_text())
        self.assertEqual(summary['baseline'], 'without_mcp')
        self.assertEqual(summary['status'], 'completed')
        self.assertEqual([c[0] for c in calls], ['without_mcp', 'with_mcp'])
        self.assertNotEqual(calls[0][2], calls[1][2])
        comparison = json.loads((root / 'comparisons/with_mcp/comparison.json').read_text())
        self.assertEqual(comparison['aggregate']['quality']['mean_delta'], 100)
        _, off = load_report(root / 'experiments/without_mcp')
        _, on = load_report(root / 'experiments/with_mcp')
        self.assertEqual(off['records'][0]['verification']['usage']['metrics']['attempted'], 0)
        self.assertEqual(on['records'][0]['verification']['usage']['metrics']['attempted'], 1)
        self.assertEqual((self.root / 'data/source/original.js').read_text(), 'export const original = 1;')
        self.assertFalse((self.root / 'data/source/generated.txt').exists())
        self.assertEqual((self.host / 'opencode.json').read_text(), '{}')
        for child in expand_experiments(task):
            self.assertIn('experiments/' + child['variant'], (root / 'index.html').read_text())
        raw = deepcopy(self.raw)
        raw['plugin_agent']['scoring'][0]['scale'] = 0.5
        replay(self.task(raw), root / 'experiments/with_mcp')
        _, rescored = load_report(root / 'experiments/with_mcp')
        self.assertEqual(rescored['aggregate']['quality']['mean'], 50)
        refreshed = json.loads((root / 'experiments-report.json').read_text())
        self.assertEqual(refreshed['experiments'][1]['aggregate']['quality']['mean'], 50)
        self.assertEqual(refreshed['comparisons'][0]['status'], 'unavailable')
        self.assertFalse((root / 'comparisons/with_mcp/comparison.json').exists())
        replay(self.task(raw), root / 'experiments/without_mcp')
        refreshed = json.loads((root / 'experiments-report.json').read_text())
        self.assertEqual(refreshed['comparisons'][0]['status'], 'completed')
        comparison = json.loads((root / 'comparisons/with_mcp/comparison.json').read_text())
        self.assertEqual(comparison['aggregate']['quality']['mean_delta'], 50)
        self.assertEqual(len(calls), 2)
        with self.assertRaisesRegex(ValueError, '单组报告'):
            load_report(root)
        raw['experiments'][1]['overrides']['mcp']['knowledge']['enabled'] = False
        with self.assertRaisesRegex(ValueError, '不一致'):
            replay(self.task(raw), root / 'experiments/with_mcp')
        for path in root.rglob('*'):
            if path.is_file() and path.suffix in ('.json', '.yaml', '.html'):
                self.assertNotIn('fixture-secret.for-local-test', path.read_text())
        self.assert_comparison_rejects_changes(off, on)

    def assert_comparison_rejects_changes(self, off, on):
        changes = [lambda r: r['execution_config'].update(agent_name='different'),
                   lambda r: r.update(experiment_context_fingerprint='changed-source'),
                   lambda r: r['records'][0]['execution']['capabilities'].update(mcp_comparison_fingerprint='changed-mcp-url'),
                   lambda r: r['records'][0]['execution']['capabilities'].update(mcp_comparison_effective_fingerprint='changed-plugin-agent'),
                   lambda r: r['records'][0]['execution']['capabilities']['mcp']['knowledge'].update(enabled=False)]
        for index, change in enumerate(changes):
            other = deepcopy(on)
            change(other)
            with self.subTest(change=index), self.assertRaises(ValueError):
                compare_reports(off, other, self.root / 'invalid-comparison')

    def test_failed_group_does_not_prevent_remaining_groups(self):
        calls = []
        self.fixture_executor(calls, fail=True)
        result = asyncio.run(run_task(self.task(), lambda _: None))
        self.assertEqual(result['exitCode'], 1)
        summary = json.loads((Path(result['runRoot']) / 'experiments-report.json').read_text())
        self.assertEqual(len(calls), 2)
        self.assertEqual(summary['experiments'][1]['status'], 'completed')
        self.assertEqual(summary['comparisons'][0]['status'], 'unavailable')
        _, failed = load_report(Path(result['runRoot']) / 'experiments/without_mcp')
        self.assertEqual(failed['records'][0]['scores']['quality']['status'], 'unavailable')

    def test_independent_skill_judge_does_not_inherit_mcp_experiment(self):
        skill = self.root / 'judge'
        skill.mkdir()
        (skill / 'SKILL.md').write_text('---\nname: judge\ndescription: Evaluate quality\n---\nReturn a JSON score.')
        raw = deepcopy(self.raw)
        raw['plugin_agent']['verification'] = [{'id': 'quality', 'type': 'SkillVerifier', 'skill_path': str(skill),
                                                'model': raw['plugin_agent']['execution']['model']}]
        task = expand_experiments(self.task(raw))[1]
        calls = []
        class JudgeExecutor:
            async def execute(inner, case, target, context):
                calls.append(context['task'])
                return ExecutionResult('completed', answer='{"metrics":{"score":75}}')
        case = datasets.get(task['dataset']['type'])().load(task['dataset'])[0]
        with patch.dict(executors.items, {'opencode': JudgeExecutor}):
            result = asyncio.run(pipeline(task, case, ExecutionResult('completed', project=case.project), self.root / 'judge-output'))
        self.assertEqual(result['quality']['metrics']['score'], 75, result)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('experiment', calls[0])

    def capability_raw(self):
        raw = deepcopy(self.raw)
        raw.pop('experiments')
        raw['plugin_agent']['execution']['without_enable'] = True
        return raw

    def capability_executor(self, calls, fail_without=False):
        class CapabilityExecutor:
            async def execute(inner, case, target, context):
                task = context['task']
                manifest = deepcopy(target['manifest'])
                manifest['version'] = 'fixture-1'
                name = task.get('experiment', {}).get('id', 'with')
                calls.append({'id': name, 'manifest': manifest, 'project': context['workspace'],
                              'question': case['question'], 'execution': deepcopy(task['active']['execution'])})
                if fail_without and name == 'without':
                    raise RuntimeError('without fixture failed')
                (Path(context['workspace']) / 'generated.txt').write_text(name)
                return ExecutionResult('completed', answer='yes' if manifest['target_enabled'] else 'no',
                                       capabilities=manifest)
        original = executors.items['opencode']
        executors.items['opencode'] = CapabilityExecutor
        self.addCleanup(executors.items.__setitem__, 'opencode', original)

    def test_without_enable_expands_two_groups_and_false_stays_single(self):
        task = self.task(self.capability_raw())
        self.assertNotIn('experiments', task)
        children = expand_experiments(task)
        self.assertEqual([c['variant'] for c in children], ['without', 'with'])
        self.assertEqual([c['active']['execution']['agent_name'] for c in children], ['build', 'converter'])
        self.assertEqual(task['active']['execution']['agent_name'], 'converter')
        self.assertEqual(expand_experiments(children[0]), [children[0]])
        plan = check_task(task, inspect=False)
        self.assertTrue(plan['ready'], plan)
        self.assertEqual(plan['baseline'], 'without')
        self.assertEqual([p['capabilities']['target_enabled'] for p in plan['experiments']], [False, True])
        self.assertEqual([p['capabilities']['selected_plugins'] for p in plan['experiments']], [[], ['converter']])
        raw = self.capability_raw()
        raw['plugin_agent']['execution']['without_enable'] = False
        single = self.task(raw)
        self.assertEqual(expand_experiments(single), [single])
        self.assertNotIn('experimentCount', check_task(single, inspect=False))
        raw['plugin_agent']['execution'].pop('without_enable')
        self.assertEqual(self.task(raw)['variant'], 'with')
        raw = self.capability_raw()
        raw['plugin_agent']['execution']['without_agent_name'] = 'custom-host'
        self.assertEqual(expand_experiments(self.task(raw))[0]['active']['execution']['agent_name'], 'custom-host')
        raw = self.capability_raw()
        raw['experiments'] = deepcopy(self.raw['experiments'])
        with self.assertRaisesRegex(ValueError, '不能.*同时'):
            self.task(raw)

    def test_without_comparison_runs_both_groups_replays_and_rejects_wrong_evidence(self):
        calls = []
        self.capability_executor(calls)
        raw = self.capability_raw()
        task = self.task(raw)
        outcome = asyncio.run(run_task(task, lambda _: None))
        self.assertEqual(outcome['exitCode'], 0)
        root = Path(outcome['runRoot'])
        self.assertEqual([c['id'] for c in calls], ['without', 'with'])
        self.assertEqual(calls[0]['question'], calls[1]['question'])
        self.assertEqual(calls[0]['execution']['model'], calls[1]['execution']['model'])
        self.assertNotEqual(calls[0]['project'], calls[1]['project'])
        self.assertFalse((self.root / 'data/source/generated.txt').exists())
        comparison = json.loads((root / 'comparisons/with/comparison.json').read_text())
        self.assertEqual(comparison['aggregate']['quality']['mean_delta'], 100)
        _, off = load_report(root / 'experiments/without')
        _, on = load_report(root / 'experiments/with')
        self.assertFalse(off['records'][0]['execution']['capabilities']['target_enabled'])
        self.assertTrue(on['records'][0]['execution']['capabilities']['target_enabled'])
        for change in (
            lambda r: r['execution_config'].update(agent_name='unexpected'),
            lambda r: r['execution_config']['model'].update(name='other'),
            lambda r: r['records'][0]['execution']['capabilities'].update(target_enabled=False),
            lambda r: r['records'][0]['execution']['capabilities'].update(selected_plugins=[]),
            lambda r: r.update(experiment_context_fingerprint='changed-input'),
        ):
            other = deepcopy(on)
            change(other)
            with self.assertRaises(ValueError):
                compare_reports(off, other, self.root / 'invalid-capability-comparison')
        raw['plugin_agent']['scoring'][0]['scale'] = 0.5
        for name in ('without', 'with'):
            replay(self.task(raw), root / 'experiments' / name, verify=True)
        refreshed = json.loads((root / 'comparisons/with/comparison.json').read_text())
        self.assertEqual(refreshed['aggregate']['quality']['mean_delta'], 50)
        self.assertEqual(len(calls), 2)
        raw['plugin_agent']['execution']['without_enable'] = False
        with self.assertRaisesRegex(ValueError, '不一致'):
            replay(self.task(raw), root / 'experiments/with')

    def test_without_skill_keeps_public_plugin_and_same_agent(self):
        skill = self.root / 'target-skill'
        skill.mkdir()
        (skill / 'SKILL.md').write_text('---\nname: converter-skill\ndescription: Convert code\n---\nConvert.')
        raw = self.capability_raw()
        block = raw.pop('plugin_agent')
        raw.update(target={'type': 'skills', 'dir': str(skill)}, skills=block)
        block['execution']['agent_name'] = 'build'
        block['execution']['opencode'].update(
            skills=[{'path': str(skill), 'activation': 'required'}],
            plugins=[{'source': str(self.plugin), 'id': 'public-plugin'}])
        task = self.task(raw)
        plan = check_task(task, inspect=False)
        self.assertTrue(plan['ready'], plan)
        self.assertEqual([p['capabilities']['agent'] for p in plan['experiments']], ['build', 'build'])
        self.assertEqual([p['capabilities']['selected_skills'] for p in plan['experiments']], [[], ['converter-skill']])
        self.assertEqual([p['capabilities']['required_skills'] for p in plan['experiments']], [[], ['converter-skill']])
        self.assertEqual([p['capabilities']['selected_plugins'] for p in plan['experiments']], [['public-plugin'], ['public-plugin']])
        calls = []
        self.capability_executor(calls)
        outcome = asyncio.run(run_task(task, lambda _: None))
        self.assertEqual(outcome['exitCode'], 0)

    def test_without_failure_continues_with_group(self):
        calls = []
        self.capability_executor(calls, fail_without=True)
        outcome = asyncio.run(run_task(self.task(self.capability_raw()), lambda _: None))
        self.assertEqual(outcome['exitCode'], 1)
        summary = json.loads((Path(outcome['runRoot']) / 'experiments-report.json').read_text())
        self.assertEqual([c['id'] for c in calls], ['without', 'with'])
        self.assertEqual(summary['experiments'][1]['status'], 'completed')
        self.assertEqual(summary['comparisons'][0]['status'], 'unavailable')


if __name__ == '__main__':
    unittest.main()
