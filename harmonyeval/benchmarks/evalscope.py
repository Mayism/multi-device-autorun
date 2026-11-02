"""Bridge cases and workflow results to native EvalScope samples and scores."""

import asyncio
import threading
from harmonyeval.metrics.aggregation import aggregate_sample_scores
from harmonyeval.evaluator.sample import execute_sample
from dataclasses import asdict
from pathlib import Path
from evalscope.api.benchmark import BenchmarkMeta, DefaultDataAdapter
from evalscope.api.dataset import DatasetDict, MemoryDataset, Sample
from evalscope.api.evaluator import TaskState
from evalscope.api.metric import SampleScore, Score
from evalscope.api.registry import register_benchmark
from evalscope.constants import ScoreStatus
from evalscope.report import Report, Metric, Category, Subset
from evalscope.api.metric.semantics import MetricIdentity, MetricSemantics
from harmonyeval.api.registry import datasets
from harmonyeval.api.contracts import ExecutionResult
from harmonyeval.metrics.scoring import calculate_scores
from harmonyeval.verification.pipeline import pipeline
from harmonyeval.models.output import text_output


@register_benchmark(BenchmarkMeta(name='harmony_eval', dataset_id='local://harmony-eval',
                                  subset_list=['default'], default_subset='default', few_shot_mode='disabled',
                                  pretty_name='Harmony Eval',
                                  metric_list=[], extra_params={'task': None, 'run_root': None},
                                  description='Harmony Eval adapter-driven evaluation'))
class HarmonyBenchmarkAdapter(DefaultDataAdapter):
    def __init__(self, benchmark_meta, task_config=None):
        super().__init__(benchmark_meta, task_config)
        self.task = self.extra_params['task']
        self.run_root = Path(self.extra_params['run_root'])
        self.adapter = datasets.get(self.task['dataset']['type'])()
        self.cases = self.adapter.load(self.task['dataset'])
        self.records, self.record_lock = [], threading.Lock()

    def load_dataset(self):
        samples = []
        for round_index in range(1, self.task['active']['rounds'] + 1):
            for index, case in enumerate(self.cases):
                samples.append(Sample(id=len(samples), input=case.question,
                                      target=case.expected.get('reference_answers', []),
                                      metadata={'case_index': index, 'case_id': case.case_id, 'round': round_index}))
        self.test_dataset = DatasetDict({'default': MemoryDataset(samples=samples, name=self.name)})
        return self.test_dataset

    def run_inference(self, model, sample, output_dir, **kwargs):
        case = self.cases[sample.metadata['case_index']]
        number = sample.metadata['round']
        folder = self.run_root / 'variants' / self.task['variant'] / f'round-{number:02d}' / 'cases' / case.case_id
        execution = execute_sample(self.task, case, folder, getattr(self, 'cancel_event', None), adapter=self.adapter)
        state = TaskState(model=str(model.name), sample=sample, completed=True,
                          output=text_output(str(model.name), execution.answer))
        state.metadata.update({'execution': execution.to_dict(), 'case_output': str(folder)})
        return state

    def calculate_metrics(self, task_state):
        case = self.cases[task_state.metadata['case_index']]
        execution = ExecutionResult(**task_state.metadata['execution'])
        results = asyncio.run(pipeline(self.task, case, execution, task_state.metadata['case_output'],
                                      getattr(self, 'cancel_event', None)))
        scores = calculate_scores(results, self.task['active']['scoring'])
        record = {'case_id': case.case_id, 'round': task_state.metadata['round'],
                  'case': asdict(case), 'input_fingerprint': self.adapter.fingerprint(case),
                  'execution': execution.to_dict(), 'verification': results, 'scores': scores}
        with self.record_lock:
            self.records.append(record)
        values = {name: score['score'] for name, score in scores.items() if score['status'] == 'scored'}
        return SampleScore(sample_id=task_state.sample_id,
                           score=Score(value=values, status=ScoreStatus.SUCCESS if values else ScoreStatus.EXCLUDED,
                                       prediction=execution.answer, explanation=execution.error or None,
                                       metadata={'verification': results, 'scores': scores}),
                           sample_metadata={'case_id': case.case_id, 'round': task_state.metadata['round']})

    def aggregate_scores(self, sample_scores):
        return aggregate_sample_scores(sample_scores, self.task['active']['scoring'])

    def generate_report(self, scores, model_name, output_dir, **kwargs):
        metrics = []
        for subset, values in scores.items():
            for value in values:
                metrics.append(Metric(identity=MetricIdentity(name=value.metric_name, aggregation='mean'),
                                      num=value.num, score=value.score, macro_score=value.score,
                                      semantics=MetricSemantics(semantic_id='harmony_eval.' + value.metric_name,
                                                               metric_name=value.metric_name,
                                                               kind='quality', direction='higher_is_better', raw_unit='points'),
                                      categories=[Category(name=('all',), num=value.num, score=value.score,
                                                           macro_score=value.score,
                                                           subsets=[Subset(name=subset, score=value.score, num=value.num)])]))
        return Report(name=self.name, dataset_name=self.name, model_name=model_name, metrics=metrics)
