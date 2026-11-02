"""Cloud verification must use YAML's toolchain without ambient ohpm/PATH."""
import asyncio
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from harmonyeval.integrations.agc.cloudtest import load_config
from harmonyeval.api.contracts import EvalCase, ExecutionResult
from harmonyeval.metrics.scoring import calculate_scores
from harmonyeval.verification.pipeline import pipeline


class CloudEnvironmentTest(unittest.TestCase):
    def test_cloud_builder_receives_configured_sdk_java_and_ohpm(self):
        with tempfile.TemporaryDirectory(prefix='harmony-eval-cloud-env-') as temporary:
            root = Path(temporary)
            home = root / 'deveco'
            sdk = root / 'sdk'
            java = root / 'jdk'
            project = root / 'base'
            for directory in (home, sdk, java, project):
                directory.mkdir()
            flow = {'id': 'cloud', 'type': 'CloudTest', 'teamId': 'fixture-team', 'projectId': 'fixture-project'}
            task = {'base_dir': str(root), 'active': {
                'execution': {'enviroment': {'deveco_home': str(home), 'sdk_home': str(sdk), 'java_home': str(java)}},
                'verification': [flow]}}
            case = EvalCase('fixture', 'Adapt', str(root), str(project))
            execution = ExecutionResult('completed', project=str(project))
            captured = []

            def submit(config, *args):
                captured.append(load_config({'config': config})['paths'])
                return {'fixture': True}

            def finish(*args):
                return {'status': 'completed', 'report': {'summary': {
                    'deviceCount': 1, 'devicePassed': 1, 'ruleFailed': 0, 'issueCount': 0}}}

            with patch.dict(os.environ, {'AGC_AUTH_INFO': 'fixture-auth'}), \
                 patch('harmonyeval.integrations.agc.cloudtest_submit.submit_cloud_test_for_project', side_effect=submit), \
                 patch('harmonyeval.integrations.agc.cloudtest_submit.finish_cloud_test_polling', side_effect=finish):
                results = asyncio.run(pipeline(task, case, execution, root / 'output'))
            self.assertEqual(results['cloud']['status'], 'completed')
            self.assertTrue(results['cloud']['metrics']['passed'])
            suffix = '.bat' if os.name == 'nt' else ''
            self.assertEqual(captured[0], {
                'hvigorw': str(home / f'tools/hvigor/bin/hvigorw{suffix}'),
                'ohpm': str(home / f'tools/ohpm/bin/ohpm{suffix}'),
                'sdkHome': str(sdk), 'javaHome': str(java)})
            score = calculate_scores(results, [{'dimension': 'cloud_test', 'type': 'BooleanScoring',
                'all': [{'source': 'cloud.metrics.passed', 'equals': True}]}])
            self.assertEqual(score['cloud_test']['score'], 100)


if __name__ == '__main__':
    unittest.main()
