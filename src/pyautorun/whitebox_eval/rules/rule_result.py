"""Assemble whitebox rule results and Agent review candidates in Python."""

import re


def _evidence_files(rule):
    return rule.get("matchedLocations") or rule.get("matchedFiles") or []


def _snippets(rule, workspace):
    if rule.get("matchedSnippets"):
        return rule["matchedSnippets"]
    by_path = {item["relativePath"]: item["content"] for item in workspace}
    return [by_path[path][:200] for path in rule.get("matchedFiles") or [] if by_path.get(path)]


def _evidence_index(evaluated, evidence):
    workspace = evidence["workspaceFiles"]
    index = {rule["rule_id"]: {"evidenceFiles": _evidence_files(rule),
                               "evidenceSnippets": _snippets(rule, workspace)}
             for rule in evaluated}
    fallback = ((evidence.get("changedFiles") or [])[:3] if evidence.get("changedFiles") else
                [item["relativePath"] for item in workspace[:3]])
    by_path = {item["relativePath"]: item["content"] for item in workspace}
    fallback_snippets = []
    for path in fallback:
        normalized = re.sub(r"^(?:workspace|original)/", "", path)
        content = by_path.get(normalized, "")
        if content:
            fallback_snippets.append(content[:200])
    index["__fallback__"] = {"evidenceFiles": fallback, "evidenceSnippets": fallback_snippets}
    return index


def _string_records(value):
    return [item for item in value if isinstance(item, dict) and
            all(isinstance(element, str) for element in item.values())] if isinstance(value, list) else []


def _target_checks(value):
    if not isinstance(value, list):
        return None
    checks = [{"target": item["target"], "ast_signals": _string_records(item.get("astSignals")),
               "llm_prompt": item.get("llmPrompt") if isinstance(item.get("llmPrompt"), str) else ""}
              for item in value if isinstance(item, dict) and isinstance(item.get("target"), str)]
    return checks or None


def _llm_prompt(config):
    if isinstance(config.get("llmPrompt"), str):
        return config["llmPrompt"]
    checks = _target_checks(config.get("targetChecks")) or []
    with_prompt = [item for item in checks if item["llm_prompt"]]
    if len(with_prompt) == 1:
        return with_prompt[0]["llm_prompt"]
    if with_prompt:
        return "\n".join(f'{item["target"]}: {item["llm_prompt"]}' for item in with_prompt)
    return None


def _review_evidence(rule, evaluated):
    preliminary = (evaluated.get("preliminaryData") or {}).get("reviewEvidence")
    first = preliminary[0] if isinstance(preliminary, list) and preliminary else None
    if not isinstance(first, dict):
        return None
    file = first.get("file") if isinstance(first.get("file"), str) else None
    subject = first.get("subject") if isinstance(first.get("subject"), str) else None
    source = first.get("evidence") if isinstance(first.get("evidence"), str) else first.get("source")
    question = first.get("question") if isinstance(first.get("question"), str) else None
    if not file or not subject or not source or not question:
        return None
    result = {"rule_id": rule["rule_id"], "file": file, "subject": subject,
              "evidence": source, "question": question}
    if isinstance(first.get("line"), (int, float)) and not isinstance(first["line"], bool):
        result["line"] = first["line"]
    return result


def _candidate(rule, registered, evaluated, index):
    registered = registered or {}
    evaluated = evaluated or {}
    preliminary = evaluated.get("preliminaryData") or {}
    static_precheck = preliminary.get("static_precheck")
    config = (registered.get("detector") or {}).get("config") or {}
    criteria = registered.get("decisionCriteria")
    decision = None
    if criteria:
        decision = {target: criteria[source] for source, target in
                    (("pass", "pass"), ("fail", "fail"),
                     ("notApplicable", "not_applicable"), ("review", "review"))
                    if source in criteria}
    kit = config.get("kit")
    kit = [item for item in kit if isinstance(item, str)] if isinstance(kit, list) else []
    ast_signals = _string_records(config.get("astSignals"))
    result = {"rule_id": rule["rule_id"], "rule_summary": rule["rule_summary"],
              "rule_source": rule["rule_source"], "why_uncertain": rule["conclusion"],
              "local_preliminary_signal": (static_precheck.get("signal_status")
                                           if isinstance(static_precheck, dict) and
                                           static_precheck.get("signal_status") is not None else
                                           "unknown" if registered.get("is_case_rule") else
                                           "未接入静态判定器，需要agent辅助判定"),
              "evidence_files": index.get(rule["rule_id"], {}).get("evidenceFiles", []),
              "evidence_snippets": index.get(rule["rule_id"], {}).get("evidenceSnippets", [])}
    optional = {"review_evidence": _review_evidence(rule, evaluated),
                "rule_name": registered.get("rule_name"), "priority": registered.get("priority"),
                "decision_criteria": decision, "kit": kit or None,
                "llm_prompt": _llm_prompt(config), "ast_signals": ast_signals or None,
                "target_checks": _target_checks(config.get("targetChecks")),
                "static_precheck": static_precheck,
                "is_case_rule": registered.get("is_case_rule")}
    result.update({key: value for key, value in optional.items() if value is not None})
    return result


def assemble_rule_engine_result(payload):
    registered = payload["registeredRules"]
    evaluated = payload["evaluatedRules"]
    evidence = payload["evidence"]
    case_ids = {rule["rule_id"] for rule in payload.get("runtimeRules") or []}
    by_id = {rule["rule_id"]: rule for rule in registered}
    evaluated_by_id = {rule["rule_id"]: rule for rule in evaluated}
    index = _evidence_index(evaluated, evidence)
    static = []
    for item in evaluated:
        result = {key: value for key, value in item.items()
                  if key not in ("matchedFiles", "matchedLocations", "matchedSnippets")}
        if result.get("rule_summary") is None:
            result["rule_summary"] = by_id.get(item["rule_id"], {}).get("summary") or ""
        static.append(result)
    deterministic = [{"rule_id": rule["rule_id"], "rule_summary": rule["rule_summary"],
                      "rule_source": rule["rule_source"], "result": rule["result"],
                      "conclusion": rule["conclusion"]}
                     for rule in static if rule["result"] != "未接入判定器" and
                     rule["rule_id"] not in case_ids]
    assisted = [_candidate(rule, by_id.get(rule["rule_id"]), evaluated_by_id.get(rule["rule_id"]), index)
                for rule in static if rule["result"] == "未接入判定器" or rule["rule_id"] in case_ids]
    violations = [{"rule_source": rule["rule_source"], "rule_id": rule["rule_id"],
                   "rule_summary": rule["conclusion"], "affected_items": _evidence_files(rule),
                   "handling_result": "待人工复核", "evidence": rule["conclusion"]}
                  for rule in evaluated if rule["result"] == "不满足"]
    packs = [{"pack_id": pack["packId"], "display_name": pack["displayName"],
              **({"version": pack["version"]} if pack.get("version") else {})}
             for pack in payload["enabledRulePacks"]]
    return {"staticRuleAuditResults": static, "deterministicRuleResults": deterministic,
            "caseRuleResults": [], "assistedRuleCandidates": assisted,
            "ruleViolations": violations, "enabledRulePacks": packs,
            "ruleEvidenceIndex": index, "evidenceSummary": evidence["summary"]}
