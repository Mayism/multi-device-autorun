"""Unattended OpenCode question and permission handling."""

import re


AUTOMATIC_CONFIRMATION_TEXT = "允许，请继续执行；如需选择，请采用推荐或默认方案。"
AFFIRMATIVE = re.compile(r"允许|同意|确认|继续|执行|应用|保存|覆盖|启用|接受|推荐|默认|好的|可以|是|\b(?:allow|approve|confirm|continue|proceed|accept|recommended|default|yes|ok)\b", re.I)
NEGATIVE = re.compile(r"取消|拒绝|停止|终止|放弃|跳过|稍后|不允许|不同意|否|\b(?:cancel|reject|deny|stop|abort|skip|later|no)\b", re.I)


def automatic_question_answers(questions):
    answers = []
    for question in questions if isinstance(questions, list) else []:
        options = question.get("options") or []
        if not options:
            answers.append([AUTOMATIC_CONFIRMATION_TEXT])
            continue
        def score(index):
            option = options[index]
            text = f"{option.get('label') or option.get('value') or ''} {option.get('description') or ''}".strip()
            return (1 if index == 0 else 0) + (20 if AFFIRMATIVE.search(text) else 0) - (50 if NEGATIVE.search(text) else 0)
        selected = options[max(range(len(options)), key=score)]
        answers.append([str(selected.get("label") or selected.get("value") or "").strip() or
                        AUTOMATIC_CONFIRMATION_TEXT])
    return answers


async def handle_pending_interactions(client, project_dir, replied_questions, replied_permissions,
                                      on_activity=None, on_progress=None):
    pending = 0
    replied = 0
    errors = []

    def progress(kind, details):
        if on_progress:
            on_progress(kind, details)

    try:
        questions = await client.list_questions(project_dir)
        for item in questions if isinstance(questions, list) else []:
            identifier = str(item.get("id") or item.get("requestID") or item.get("requestId") or "")
            if not identifier or identifier in replied_questions:
                continue
            pending += 1
            try:
                answers = automatic_question_answers(item.get("questions") or [])
                if not answers:
                    raise ValueError("question 请求未包含可回答的问题")
                await client.reply_question(identifier, answers, project_dir)
                replied_questions.add(identifier)
                pending -= 1
                replied += 1
                if on_activity:
                    on_activity()
                progress("question_replied", {"requestId": identifier, "answers": answers})
            except Exception as error:
                detail = {"kind": "question", "requestId": identifier, "error": str(error)}
                errors.append(detail)
                progress("interaction_error", detail)
    except Exception as error:
        detail = {"kind": "question_list", "error": str(error)}
        errors.append(detail)
        progress("interaction_error", detail)
    try:
        permissions = await client.list_permissions(project_dir)
        for item in permissions if isinstance(permissions, list) else []:
            identifier = str(item.get("id") or item.get("requestID") or item.get("requestId") or "")
            if not identifier or identifier in replied_permissions:
                continue
            pending += 1
            try:
                permission = str(item.get("permission") or "").strip().lower()
                await client.reply_permission(identifier, project_dir, "always")
                replied_permissions.add(identifier)
                pending -= 1
                replied += 1
                if on_activity:
                    on_activity()
                progress("permission_replied", {"requestId": identifier, "permission": permission, "reply": "always"})
            except Exception as error:
                detail = {"kind": "permission", "requestId": identifier, "error": str(error)}
                errors.append(detail)
                progress("interaction_error", detail)
    except Exception as error:
        detail = {"kind": "permission_list", "error": str(error)}
        errors.append(detail)
        progress("interaction_error", detail)
    return {"pending": pending, "replied": replied, "errors": errors}


AGENT_AUTO_APPROVAL_POLICY_MARKER = "# 无人值守确认策略（强制）"
AGENT_AUTO_APPROVAL_POLICY = (AGENT_AUTO_APPROVAL_POLICY_MARKER + "\n\n"
    "- 当前任务执行所需操作均已授权；不得停下来等待用户确认。\n"
    "- 如工具仍要求确认，统一选择允许、同意、继续执行或推荐方案。\n"
    "- 如存在多个合理实现且没有额外业务信息，采用推荐方案或最稳妥的默认方案继续完成任务。")


def apply_agent_session_policy(config, agent_name, policy=AGENT_AUTO_APPROVAL_POLICY):
    name = str(agent_name or "").strip()
    if not name:
        raise ValueError("注入会话策略时缺少 Agent 名称")
    config = config if isinstance(config, dict) else {}
    agents = config.get("agent") if isinstance(config.get("agent"), dict) else {}
    current = agents.get(name) if isinstance(agents.get(name), dict) else {}
    prompt = "\n\n".join(part for part in (str(current.get("prompt") or "").strip(), str(policy or "").strip()) if part)
    agents[name] = {**current, "prompt": prompt}
    config["agent"] = agents
    return config


def has_agent_session_policy(config, agent_name):
    return AGENT_AUTO_APPROVAL_POLICY_MARKER in str(((config or {}).get("agent") or {}).get(agent_name, {}).get("prompt") or "")
