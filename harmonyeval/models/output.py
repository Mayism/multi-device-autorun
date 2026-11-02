"""Construct native EvalScope text model outputs."""

from evalscope.api.messages import ChatMessageAssistant
from evalscope.api.model import ModelOutput, ChatCompletionChoice


def text_output(model, text, **kwargs):
    return ModelOutput(model=model, choices=[ChatCompletionChoice(
        message=ChatMessageAssistant(content=text), stop_reason='stop')], **kwargs)
