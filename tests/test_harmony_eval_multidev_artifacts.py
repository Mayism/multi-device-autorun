"""Keep grading inputs out of generation, then retain them and UITest evidence."""
import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from evalscope.api.dataset import Sample

from harmonyeval.api.contracts import ExecutionResult
from harmonyeval.benchmarks.multidev import MultiDevDataset
from harmonyeval.benchmarks.evalscope import HarmonyBenchmarkAdapter
from harmonyeval.verification.pipeline import pipeline


class MultiDevArtifactsTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='harmony-eval-artifacts-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        source = self.root / 'dataset/case'
        (source / 'base').mkdir(parents=True)
        (source / 'base/index.ets').write_text('original')
        (source / 'PROMPT.md').write_text('Adapt this project.')
        (source / 'grading').mkdir()
        (source / 'grading/test.patch').write_text('hidden test')
        (source / 'grading/golden.patch').write_text('hidden answer')
        self.metadata = {'case_id': 'case', 'base_project': 'base',
                         'test_patch': 'grading/test.patch', 'golden_patch': 'grading/golden.patch'}
        (source / 'metadata.json').write_text(json.dumps(self.metadata))
        self.adapter = MultiDevDataset()
        self.case = self.adapter.load({'dir': str(source.parent)})[0]
        self.task = {'target': {'type': 'opencode_agent'},
                     'variant': 'with', 'active': {'execution': {'engine': 'opencode'}, 'verification': []}}

    def test_generation_archives_inputs_only_after_agent_stops_including_failure(self):
        owner = self

        class Target:
            def prepare(self, task, runtime):
                return {}

        class Executor:
            async def execute(self, case, target, context):
                workspace = Path(context['workspace'])
                output = Path(context['output'])
                owner.assertFalse((output / 'metadata.json').exists())
                owner.assertFalse((output / 'grading').exists())
                owner.assertFalse((workspace / 'grading').exists())
                (workspace / 'index.ets').write_text('adapted')
                return ExecutionResult(status)

        for status in ('completed', 'timed_out', 'error'):
            with self.subTest(status=status):
                benchmark = object.__new__(HarmonyBenchmarkAdapter)
                benchmark.adapter = self.adapter
                benchmark.task = self.task
                benchmark.cases = [self.case]
                benchmark.run_root = self.root / status
                sample = Sample(id=0, input=self.case.question,
                                metadata={'case_index': 0, 'case_id': 'case', 'round': 1})
                with patch('harmonyeval.agent.service.targets.get', return_value=Target), \
                     patch('harmonyeval.agent.service.executors.get', return_value=Executor), \
                     patch('harmonyeval.agent.service.task_model'), \
                     patch('harmonyeval.agent.service.close_model', new_callable=AsyncMock):
                    state = benchmark.run_inference(type('Model', (), {'name': 'fixture'})(), sample, '')
                execution = state.metadata['execution']
                folder = Path(execution['artifacts']['case_output'])
                self.assertEqual(execution['status'], status)
                self.assertEqual(json.loads((folder / 'metadata.json').read_text()), self.metadata)
                self.assertEqual((folder / 'grading/test.patch').read_text(), 'hidden test')
                self.assertEqual((folder / 'grading/golden.patch').read_text(), 'hidden answer')
                self.assertEqual(Path(execution['artifacts']['golden_patch']).resolve(),
                                 (folder / 'grading/golden.patch').resolve())
                self.assertNotIn('hidden answer', (folder / 'change.patch').read_text())
        self.assertEqual((Path(self.case.project) / 'index.ets').read_text(), 'original')

    def test_uitest_results_survive_temporary_project_cleanup(self):
        folder = self.root / 'output/case'
        project = folder / 'base'
        self.adapter.prepare(self.case, project)
        artifacts = self.adapter.archive_evidence(self.case, folder)
        artifacts['case_output'] = str(folder)
        execution = ExecutionResult('completed', project=str(project), workspace=str(project), artifacts=artifacts)
        task = {'active': {'execution': {'enviroment': {}}, 'verification': [
            {'id': 'ui', 'type': 'UITest', 'deveco_home': str(self.root),
             'devices': [{'id': 'phone', 'target': 'fixture-device'}]}]}}
        temporary_projects = []

        async def fake_runner(command, project, context, label, timeout):
            source = Path(command[command.index('--case') + 1])
            temporary_projects.append(source)
            self.assertTrue((source / 'metadata.json').is_file())
            self.assertEqual((source / 'grading/test.patch').read_text(), 'hidden test')
            output = Path(command[command.index('--out') + 1])
            screenshot = output / 'swe/screenshots/phone/assertion.error.png'
            screenshot.parent.mkdir(parents=True)
            screenshot.write_bytes(b'fixture screenshot')
            (output / 'result.json').write_text(json.dumps({'runs': {'swe': {
                'build': {'status': 'passed'}, 'devices': [{'testsRun': 1, 'passes': 0, 'status': 'failed'}]}}}))

        with patch('harmonyeval.verification.workflows.uitest.command_run', side_effect=fake_runner):
            result = asyncio.run(pipeline(task, self.case, execution, folder))['ui']
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['metrics']['pass_rate'], 0)
        self.assertTrue(all(not directory.exists() for directory in temporary_projects))
        self.assertEqual(result['evidence'], [str(folder / 'verification/ui/result.json')])
        self.assertTrue((folder / 'verification/ui/swe/screenshots/phone/assertion.error.png').is_file())
        self.assertTrue((folder / 'metadata.json').is_file())


if __name__ == '__main__':
    unittest.main()
