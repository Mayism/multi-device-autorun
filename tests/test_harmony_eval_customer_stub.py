"""Exercise the supplied customer-service task through EvalScope, without an LLM."""
import asyncio
from pathlib import Path
import tempfile
import threading
import unittest

from harmonyeval.config.loader import load_task
from harmonyeval.benchmarks.text_qa import TextDataset
from harmonyeval.report.io import load_report
from harmonyeval.evaluator.runner import run_task
from harmonyeval.experiments.config import expand_experiments
from scripts.qa_customer_stub import make_server


class CustomerStubTest(unittest.TestCase):
    def test_customer_and_mcp_tasks_share_inputs_and_reference_documents(self):
        root = Path(__file__).resolve().parents[1]
        paths = ['scenarios/question-answering/task.customer-service.yaml', 'scenarios/knowledge-eval/task.yaml']
        shared = root / 'scenarios/knowledge-eval/data/cases.json'
        adapter = TextDataset()
        datasets = []
        for name in paths:
            task = load_task(root / name)
            self.assertEqual(Path(task['dataset']['dir']), shared)
            children = expand_experiments(task)
            if name.startswith('scenarios/knowledge-eval/'):
                self.assertEqual([child['variant'] for child in children], ['without_mcp', 'with_mcp'])
            for child in children:
                self.assertEqual(Path(child['dataset']['dir']), shared)
                cases = adapter.load(child['dataset'])
                self.assertEqual(len(cases), 3)
                for case in cases:
                    for reference in case.expected['reference_documents']:
                        self.assertTrue((Path(case.root) / reference).is_file())
                datasets.append([(case.case_id, adapter.fingerprint(case), adapter.evidence_fingerprint(case)) for case in cases])
        self.assertEqual(len(datasets), 3)
        self.assertEqual(datasets[0], datasets[1])
        self.assertEqual(datasets[1], datasets[2])

    def test_json_dataset_http_stub_and_real_scores(self):
        source = Path(__file__).resolve().parents[1] / 'scenarios/question-answering/task.customer-service.yaml'
        with tempfile.TemporaryDirectory(prefix='harmony-eval-customer-test-') as temporary:
            for mode, expected in [('normal', 100), ('wrong', 0)]:
                with self.subTest(mode=mode):
                    server = make_server(port=0, mode=mode)
                    worker = threading.Thread(target=server.serve_forever, daemon=True)
                    worker.start()
                    try:
                        task = load_task(source)
                        task['active']['execution']['http_url'] = f'http://127.0.0.1:{server.server_port}/answer'
                        task['active']['report']['output_dir'] = str(Path(temporary) / mode)
                        result = asyncio.run(run_task(task, lambda _: None))
                        self.assertEqual(result['exitCode'], 0)  # A valid zero score is not an infrastructure error.
                        _, report = load_report(result['runRoot'])
                        self.assertEqual(report['planned_samples'], 3)
                        self.assertEqual(report['execution_summary']['completed'], 3)
                        self.assertEqual(report['aggregate']['answer_correctness']['mean'], expected)
                        self.assertTrue(all(record['execution']['artifacts'].get('remote_session_id')
                                            for record in report['records']))
                        self.assertTrue((Path(result['runRoot']) / 'index.html').is_file())
                    finally:
                        server.shutdown()
                        server.server_close()
                        worker.join()


if __name__ == '__main__':
    unittest.main()
