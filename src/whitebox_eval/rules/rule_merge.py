"""Merge deterministic and Agent reviewed whitebox rule decisions."""

import re


STOP_WORDS = {"target", "rules", "rule", "true", "false", "null", "undefined", "current",
              "generated", "original", "metadata", "patch"}
CHINESE_STOP = re.compile(
    r"必须|不得|禁止|检查|是否|方案|代码|规则|当前|新增|存在|使用|通过|说明|明确|优先|涉及|需要|应当|应该|"
    r"要求|支持|实现|处理|判断|判定|输出|完成|完整|相关|对应|目标|文件|函数|方法|逻辑|能力|场景|状态|策略|"
    r"结构|系统|统一|修复|根因|原因|不能|只|未|给出|如果|当|时|前|后|中|下|上|并|且|和|与|或|的|为|到")


def _base(candidate, status, conclusion):
    return {"rule_id": candidate["rule_id"],
            "rule_summary": candidate.get("rule_summary") or candidate.get("rule_name"),
            "rule_source": candidate["rule_source"], "result": status, "conclusion": conclusion}


def _fallback(candidate, summary=None):
    precheck = candidate.get("static_precheck") or {}
    signal = precheck.get("signal_status")
    status = ("不满足" if signal == "no_target_files" or
              signal == "none_matched" and candidate.get("ast_signals") else
              "满足" if signal == "all_matched" else "待人工复核")
    if summary:
        conclusion = (f'Agent 总体判断：{summary["assistant_scope"]}（整体置信度：{summary["overall_confidence"]}）。'
                      f' 但缺少针对 {candidate["rule_id"]} 的结构化判定，已回退为待人工复核。')
    else:
        conclusion = f'Agent 未能提供有效判定，候选规则 {candidate["rule_id"]} 已回退为待人工复核。'
    if status != "待人工复核":
        conclusion += " 静态预判结果已作为评分依据，仍建议人工复核确认。"
    static = precheck.get("summary") or candidate.get("why_uncertain")
    if static:
        conclusion += " 静态预判：" + static
    if candidate.get("local_preliminary_signal"):
        conclusion += " 本地预判信号：" + candidate["local_preliminary_signal"] + "。"
    evidence = candidate.get("evidence_files") or precheck.get("target_files") or []
    if evidence:
        conclusion += " 相关证据文件：" + "、".join(evidence[:5]) + "。"
    return _base(candidate, status, conclusion)


def _irrelevant(candidate, assessment):
    if not candidate.get("is_case_rule") or assessment["decision"] == "uncertain":
        return False
    parts = [candidate.get("rule_summary"), candidate.get("rule_name"), candidate.get("llm_prompt"),
             *(candidate.get("kit") or []),
             *(item.get("name") for item in candidate.get("ast_signals") or [])]
    for check in candidate.get("target_checks") or []:
        parts += [check.get("target"), check.get("llm_prompt"),
                  *(item.get("name") for item in check.get("ast_signals") or [])]
    text = " ".join(value for value in parts if isinstance(value, str))
    code = {item.lstrip("@").lower() for item in re.findall(r"[A-Za-z_$@][A-Za-z0-9_$@.:-]{2,}", text)}
    code = {item for item in code if len(item) >= 4 and item not in STOP_WORDS}
    chinese = {piece for run in re.findall(r"[\u4e00-\u9fff]{2,}", text)
               for piece in CHINESE_STOP.sub(" ", run).split()
               if 2 <= len(piece) <= 12}
    if not code and not chinese:
        return False
    response = re.sub(r"\s+", "", assessment["reason"] + " " + " ".join(assessment["evidence_used"])).lower()
    return not any(anchor in response for anchor in code | chinese)


def _assessed(candidate, assessment):
    if _irrelevant(candidate, assessment):
        return _base(candidate, "待人工复核",
                     "Agent 输出结论与规则描述不相关，已阻断自动合并。建议人工复核或重新执行本用例以获得可信规则判定")
    statement = assessment["reason"] + " " + " ".join(assessment["evidence_used"])
    if (candidate["rule_source"] == "must_rule" and not candidate.get("is_case_rule") and
        assessment["decision"] == "uncertain" and
        re.search(r"补丁|patch|effective\.patch|read_patch", statement, re.I) and
        re.search(r"未(发现|见)|没有|无", statement)):
        return _base(candidate, "满足", assessment["reason"] + " 补丁未见相关改动，按 patch-only 评测视为无问题。")
    if (assessment["decision"] == "uncertain" and
        re.search(r"新增代码|新增内容|新增改动|补丁|patch|effective\.patch|改动", statement) and
        re.search(r"未(发现|见)(明显)?(该规则相关)?(违规|问题|风险|异常|反模式)|"
                  r"没有(发现)?(该规则相关)?(违规|问题|风险|异常|反模式)|"
                  r"无(明显)?(该规则相关)?(违规|问题|风险|异常|反模式)", statement)):
        cleaned = re.sub(r"，?需(?:要)?人工(?:review|复核)确认。?", "", assessment["reason"], flags=re.I).strip()
        return _base(candidate, "满足", (cleaned or "新增代码未发现该规则相关问题。") +
                     " 新增代码未见相关问题，按 patch-only 评测视为无问题。")
    result = {"violation": "不满足", "pass": "满足", "not_applicable": "不涉及",
              "uncertain": "待人工复核"}[assessment["decision"]]
    return _base(candidate, result, assessment["reason"])


def merge_rule_results(deterministic, candidates, agent_answer=None):
    if agent_answer is None:
        return {"ruleAgentRunStatus": "invalid_output", "ruleAgentAssessmentResult": None,
                "mergedRuleAuditResults": [*deterministic, *[_fallback(item) for item in candidates]]}
    assessments = agent_answer["rule_assessments"]
    by_id = {item["rule_id"]: item for item in assessments}
    merged = []
    for candidate in candidates:
        assessment = by_id.get(candidate["rule_id"])
        if assessment:
            merged.append(_assessed(candidate, assessment))
        elif not assessments:
            merged.append(_fallback(candidate, agent_answer["summary"]))
        else:
            merged.append(_base(candidate, "待人工复核",
                                f'Agent 未提供规则 {candidate["rule_id"]} 的分条判定，已回退为待人工复核。'))
    return {"ruleAgentRunStatus": "success", "ruleAgentAssessmentResult": agent_answer,
            "mergedRuleAuditResults": [*deterministic, *merged]}
