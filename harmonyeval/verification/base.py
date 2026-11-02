"""Shared business workflow contract and result construction."""

from harmonyeval.api.contracts import VerificationResult
from harmonyeval.api.interfaces import Workflow


def result(config, status="completed", **kwargs):
    return VerificationResult(config["id"], status, **kwargs)
