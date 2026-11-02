"""Select the EvalScope model bridge for OpenCode or remote HTTP agents."""

from evalscope.api.model import Model, GenerateConfig
from harmonyeval.models.compatibility import evalscope_model
from harmonyeval.agent.engines.http_model import HttpAgentModelAPI


def task_model(task):
    execution = task['active']['execution']
    if execution['engine'] == 'http':
        return Model(api=HttpAgentModelAPI(execution), config=GenerateConfig(retries=0, timeout=execution['timeout']))
    return evalscope_model(execution['model'], execution['timeout'])
