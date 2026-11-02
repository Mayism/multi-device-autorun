"""Check dependency direction, installed entry points and extension compatibility."""
import ast
from importlib import resources
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from harmonyeval.api import Registry, Workflow


class ArchitectureTest(unittest.TestCase):
    def test_core_dependency_direction(self):
        root = Path(__file__).resolve().parents[1] / 'harmonyeval'
        forbidden = {
            'api': {'agent', 'evaluator', 'verification', 'benchmarks', 'models', 'metrics', 'integrations', 'report'},
            'utils': {'api', 'agent', 'evaluator', 'verification', 'benchmarks', 'models', 'metrics', 'integrations', 'report', 'config'},
            'models': {'agent', 'evaluator', 'verification', 'benchmarks', 'integrations', 'report'},
            'metrics': {'agent', 'evaluator', 'verification', 'benchmarks', 'integrations', 'report'},
            'agent': {'evaluator', 'verification', 'benchmarks'},
            'integrations': {'evaluator', 'verification', 'benchmarks'},
        }
        failures = []
        for path in root.rglob('*.py'):
            layer = path.relative_to(root).parts[0]
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                modules = ([node.module] if isinstance(node, ast.ImportFrom) and node.module else
                           [item.name for item in node.names] if isinstance(node, ast.Import) else [])
                for module in modules:
                    if module.startswith('pyautorun'):
                        failures.append(f'{path.relative_to(root)}:{node.lineno}: retired namespace')
                    if module.startswith('harmonyeval.') and module.split('.')[1] in forbidden.get(layer, set()):
                        failures.append(f'{path.relative_to(root)}:{node.lineno}: {layer} -> {module}')
        self.assertEqual(failures, [], '\n'.join(failures))

    def test_extension_namespace_supports_current_and_previous_groups(self):
        class Extension(Workflow):
            pass
        class Entry:
            name = 'FixtureAcceptance'
            def load(self):
                return Extension
        class Installed:
            def select(self, group):
                return [Entry()] if group in ('harmonyeval.fixture', 'harmony_eval.fixture') else []
        with patch('harmonyeval.api.registry.metadata.entry_points', return_value=Installed()):
            registry = Registry('fixture')
            self.assertIs(registry.get('FixtureAcceptance'), Extension)
            self.assertEqual(len(registry.items), 1)

    def test_installed_module_and_bundled_resources_outside_repository(self):
        for package, relative in (
            ('harmonyeval.integrations.uitest', 'FoldTrigger.ets'),
            ('harmonyeval.integrations.uitest', 'fold-server.py'),
            ('harmonyeval.report', 'report.css'),
            ('harmonyeval.integrations.whitebox.resources', 'official_profiles.json'),
            ('harmonyeval.integrations.whitebox.resources', 'references/scoring/rubric.yaml'),
            ('harmonyeval.integrations.whitebox.resources', 'opencode/prompts/hmos-rule-assessment-system.md'),
        ):
            self.assertTrue(resources.files(package).joinpath(relative).is_file(), (package, relative))
        with tempfile.TemporaryDirectory(prefix='harmonyeval-installed-') as directory:
            result = subprocess.run([sys.executable, '-m', 'harmonyeval', '--help'], cwd=directory,
                                    capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('usage: harmonyeval', result.stdout)
        self.assertIn('rescore', result.stdout)


if __name__ == '__main__':
    unittest.main()
