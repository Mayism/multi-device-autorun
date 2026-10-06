"""OpenCode human rating gap analysis through the Python runtime."""

import json
import os
from pathlib import Path
import socket
from uuid import uuid4

from .whitebox_opencode import OpenCodeServer, create_runtime, run_prompt
from .whitebox_resources import ROOT as WHITEBOX_RESOURCES


CONCLUSIONS = {"human_rating_needs_improvement", "scoring_system_needs_improvement",
               "both_need_review", "insufficient_evidence"}


def parse_gap_analysis(value):
    value = json.loads(value) if isinstance(value, str) else value
    if not isinstance(value, dict) or set(value) != {"primaryConclusion", "confidence", "reasonSummary",
            "humanRatingReview", "scoringSystemReview", "evidence", "recommendedActions"}:
        raise ValueError("gap analysis output has invalid fields")
    if value["primaryConclusion"] not in CONCLUSIONS or value["confidence"] not in ("high", "medium", "low"):
        raise ValueError("gap analysis conclusion or confidence is invalid")
    if not isinstance(value["reasonSummary"], str) or not value["reasonSummary"].strip():
        raise ValueError("gap analysis reasonSummary is required")
    for key in ("humanRatingReview", "scoringSystemReview"):
        review = value[key]
        if not isinstance(review, dict) or set(review) != {"needsImprovement", "reason"} or \
                not isinstance(review["needsImprovement"], bool) or not isinstance(review["reason"], str) or \
                not review["reason"].strip():
            raise ValueError(f"gap analysis {key} is invalid")
    for key in ("evidence", "recommendedActions"):
        if not isinstance(value[key], list) or not value[key] or any(
                not isinstance(item, str) or not item.strip() for item in value[key]):
            raise ValueError(f"gap analysis {key} must be a nonempty string array")
    return value


def run_gap_analysis(case_dir, manual, result, *, environ=None, runner=run_prompt):
    env = dict(os.environ if environ is None else environ)
    env.setdefault("HMOS_OPENCODE_HOST", "127.0.0.1")
    if not env.get("HMOS_OPENCODE_PORT"):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            env["HMOS_OPENCODE_PORT"] = str(listener.getsockname()[1])
    env.setdefault("HMOS_OPENCODE_TIMEOUT_MS", "180000")
    env.setdefault("HMOS_OPENCODE_MAX_OUTPUT_BYTES", "1048576")
    runtime = create_runtime(WHITEBOX_RESOURCES, runtime_name="human-gap-" + str(manual["taskId"]) +
                             "-" + uuid4().hex[:8], environ=env)
    prompt = "\n".join((
        "你是人工评级差异分析 agent，必须使用 hmos-human-rating-gap-analysis skill。",
        "只能阅读当前 sandbox 文件；不能运行命令、访问网络或修改业务文件。",
        "对比 manual_rating_record 和 result_json；判断差异归因，引用可复核证据，不要重新打分。",
        "将最终 JSON 写入 metadata/agent-output/human-rating-gap-analysis.json；最终回复只包含 output_file。",
        "manual_rating_record:", json.dumps(manual, ensure_ascii=False, indent=2),
        "result_json:", json.dumps(result, ensure_ascii=False, indent=2)))
    with OpenCodeServer(runtime):
        output = runner(runtime, {"prompt": prompt, "sandboxRoot": str(case_dir),
            "requestTag": "human-rating-gap-analysis-" + str(manual["taskId"]),
            "agent": "hmos-human-rating-gap-analysis",
            "outputFile": "metadata/agent-output/human-rating-gap-analysis.json"})
    return parse_gap_analysis(output["rawText"])
