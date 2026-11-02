"""Adapt remote agent answers to EvalScope ModelAPI outputs."""

import json
from evalscope.api.model import ModelAPI
from harmonyeval.agent.engines.http_protocols import call_http
from harmonyeval.models.output import text_output


class HttpAgentModelAPI(ModelAPI):
    def __init__(self, execution):
        super().__init__(model_name='http-agent', base_url=execution['http_url'])
        self.execution = execution

    def generate(self, input, tools, tool_choice, config):
        raw = call_http(self.execution, json.loads(input[-1].text))
        return text_output(self.model_name, raw['answer'], metadata={'session_id': raw['session_id']})
