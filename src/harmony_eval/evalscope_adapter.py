"""Version-bounded integration with EvalScope's native evaluation lifecycle."""
import asyncio
from dataclasses import asdict
from importlib.metadata import version
import json
from pathlib import Path
import tempfile
import threading

from evalscope.api.benchmark import BenchmarkMeta, DefaultDataAdapter
from evalscope.api.dataset import DatasetDict, MemoryDataset, Sample
from evalscope.api.evaluator import TaskState
from evalscope.api.messages import ChatMessageAssistant
from evalscope.api.metric import AggScore, SampleScore, Score
from evalscope.api.model import Model, ModelAPI, GenerateConfig, ModelOutput, ChatCompletionChoice
from evalscope.api.registry import register_benchmark
from evalscope.constants import ScoreStatus
from evalscope.report import Report, Metric, Category, Subset
from evalscope.api.metric.semantics import MetricIdentity, MetricSemantics

from pyautorun.harmony_eval.core import datasets, executors, targets, ExecutionResult, PROJECT_DIRECTORY
from pyautorun.harmony_eval.execution import init_project, save_patch
from pyautorun.harmony_eval.http_protocols import call_http
from pyautorun.harmony_eval.model import evalscope_model, close_model
from pyautorun.harmony_eval.score_rules import calculate_scores
from pyautorun.harmony_eval.verification import pipeline, capture_verification_inputs


def require_evalscope():
    installed = version('evalscope')
    if not installed.startswith('1.14.'):
        raise ValueError(f'当前已验证EvalScope 1.14.x，实际安装{installed}')
    return installed


def text_output(model, text, **kwargs):
    return ModelOutput(model=model, choices=[ChatCompletionChoice(
        message=ChatMessageAssistant(content=text), stop_reason='stop')], **kwargs)


class HttpAgentModelAPI(ModelAPI):
    def __init__(self, execution):
        super().__init__(model_name='http-agent', base_url=execution['http_url'])
        self.execution = execution

    def generate(self, input, tools, tool_choice, config):
        raw = call_http(self.execution, json.loads(input[-1].text))
        return text_output(self.model_name, raw['answer'], metadata={'session_id': raw['session_id']})


def task_model(task):
    execution = task['active']['execution']
    if execution['engine'] == 'http':
        return Model(api=HttpAgentModelAPI(execution), config=GenerateConfig(retries=0, timeout=execution['timeout']))
    return evalscope_model(execution['model'], execution['timeout'])


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
        folder.mkdir(parents=True, exist_ok=True)
        workspace = folder / PROJECT_DIRECTORY
        try:
            if getattr(self, 'cancel_event', None) is not None and self.cancel_event.is_set():
                raise InterruptedError('评测已中断')
            self.adapter.prepare(case, workspace)
            asyncio.run(capture_verification_inputs(self.task, case, folder))
            if case.project:
                baseline = init_project(workspace)
            async def execute():
                target_adapter = targets.get(self.task['target']['type'])()
                with tempfile.TemporaryDirectory(prefix='harmony-eval-runtime-') as runtime:
                    target = await asyncio.to_thread(target_adapter.prepare, self.task, runtime)
                    local_model = task_model(self.task)
                    try:
                        return await executors.get(self.task['active']['execution']['engine'])().execute(
                            case.public(), target, {'task': self.task, 'workspace': str(workspace),
                                                    'output': str(folder), 'model': local_model,
                                                    'cancel_event': getattr(self, 'cancel_event', None)})
                    finally:
                        await close_model(local_model)
            execution = asyncio.run(execute())
            execution.workspace = str(workspace)
            execution.project = str(self.adapter.project_path(case, workspace)) if case.project else ''
            if case.project:
                save_patch(workspace, folder, baseline)
                if not Path(execution.project).is_dir():
                    execution.status, execution.failure_category = 'failed', 'agent'
                    execution.error = 'Agent未生成约定的目标工程: ' + execution.project
        except Exception as error:
            execution = ExecutionResult('interrupted' if isinstance(error, InterruptedError) else 'error', workspace=str(workspace),
                                         failure_category='user' if isinstance(error, InterruptedError) else 'infrastructure',
                                         error=f'{type(error).__name__}: {error}')
        execution.artifacts['case_output'] = str(folder)
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
        result = []
        for config in self.task['active']['scoring']:
            name = config['dimension']
            values = [s.score.value[name] for s in sample_scores if name in s.score.value]
            if values:
                result.append(AggScore(score=sum(values) / len(values), metric_name=name, aggregation='mean',
                                       num=len(values), metadata={'total': len(sample_scores), 'scored': len(values)}))
        return result

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
