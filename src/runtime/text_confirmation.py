"""Classify unattended confirmations without affirming manual acceptance."""

import re
import unicodedata


BASIC_TESTS_REPLY = "仅基础测试"
CONTINUE_TASK_REPLY = "是，请继续执行当前任务，按既定流程推进；如需选择，请采用推荐或默认方案。"

_CAPABILITY_FAILURES = tuple(re.compile(pattern) for pattern in (
    r"(?:多模态|(?:图片|图像|视觉)(?:理解|识别)?)(?:能力)?(?:探测|检测)(?:未通过|失败|不通过)",
    r"(?:多模态|图片理解|图像理解|视觉理解)(?:能力)?(?:不足|不可用|不受支持)",
    r"(?:未通过|不支持|不具备|缺乏|缺少)(?:(?:图片|图像|视觉)(?:理解|识别|输入)|多模态)",
    r"(?:无法|不能|不支持|没法)(?:直接)?(?:读取|识别|理解|查看|看懂|分析|处理)(?:上传的|提供的)?(?:图片|图像|截图)",
    r"(?:无法|不能|没法)看图|(?:图片|图像|截图)(?:看不了|看不懂|无法理解|无法读取)",
))


def _normalized(value):
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = re.sub(r"```[\s\S]*?```|~~~[\s\S]*?~~~", "", text)
    return re.sub(r"[ \t]+", " ", re.sub(r"\\([*_`])", r"\1", re.sub(r"\*\*|__|`", "", text)))


def _clauses(text):
    return [part.strip() for part in re.split(r"(?<=[。!?;；\n])", text) if part.strip()]


def has_basic_tests_option(value):
    text = _normalized(value)
    return bool(re.search(r"基础(?:测试|验证|检查)|(?:构建|编译)(?:和|及|与|、)静态(?:检查|分析)|"
                          r"(?:不依赖|不涉及|无需)(?:设备)?(?:截图|图片|图像|视觉)(?:的)?(?:测试|验证|检查)", text))


def requests_basic_tests_confirmation(value, structured=False):
    text = _normalized(value)
    clauses = _clauses(text)
    failed = any(not re.search(r"如果|假如|倘若|若", clause) and
                 any(pattern.search(clause) for pattern in _CAPABILITY_FAILURES) for clause in clauses)
    if not failed or not has_basic_tests_option(text):
        return False
    if structured:
        return True
    actionable = [clause for clause in clauses if not re.search(
        r"(?:无需|不用|不必|不需要)[^。!?\n]{0,16}(?:确认|选择|回复|回答)", clause)]
    confirmation = re.compile(r"请(?:您)?(?:选择|确认|回复|决定)|(?:需要|等待)(?:您|用户)(?:选择|确认|回复|决定)|"
                              r"是否|要不要|愿不愿意|还是|吗|\?")
    if any(has_basic_tests_option(clause) and confirmation.search(clause) for clause in actionable):
        return True
    return any(re.search(r"(?:请(?:您)?(?:选择|确认|决定)|需要(?:您|用户)(?:选择|确认|决定))"
                         r"[^。!?\n]{0,30}(?:方式|方案|模式)\s*[:：。?]?$|"
                         r"(?:请选择|请您选择|是否继续)\s*[:：。?]?$", clause)
               and any(has_basic_tests_option(later) for later in actionable[index + 1:])
               for index, clause in enumerate(actionable))


_QUESTION = re.compile(r"(?:^|[,，:：]\s*)(?:(?:请问|请(?:您)?确认|(?:需要|等待)(?:您|用户)确认)[,，:：]?\s*)?"
                       r"(?:(?:您|你)(?:希望|想要)?|我们|我)?(?:是否|要不要|能否|可否|需不需要|可不可以|能不能|行不行|同不同意)", re.I)
_ENDING = re.compile(r"(?:可以吗|好吗|行吗|同意吗|吗)\s*[?。]?$", re.I)
_REQUEST = re.compile(r"(?:请(?:您)?|需要(?:您|用户)|等待(?:您|用户))确认")


def _question_clauses(text):
    result = []
    for raw in _clauses(text):
        clause = re.sub(r"^(?:>\s*|[-*+]\s+|\d+[.)、]\s*)+", "", raw).strip()
        if re.search(r"User has answered|\[output\]|如果|假如|无需|不用|不必|不需要", clause):
            continue
        if re.match(r"^(?:测试用例|验证项|检查项|检查是否|验证是否)", clause):
            continue
        result.append(clause)
    return result


def _is_confirmation(clause):
    return bool(_QUESTION.search(clause) or _ENDING.search(clause) or _REQUEST.search(clause))


def _needs_human(clause, has_options=False):
    patterns = [
        r"(?:请|需要|等待)(?:您|你|用户)?(?:先)?(?:提供|输入|填写|告知|指定)",
        r"(?:您|你)(?:能否|能不能|可否|是否可以|可以|能)(?:提供|输入|填写|告知|指定)",
    ]
    if not has_options:
        patterns += [r"(?:请选择|选哪个|选择哪个|哪一种|哪个方案|何时|什么时候|多少|怎么选)",
                     r"还是|或者|或是|[A-Z一二三123]\s*或\s*[A-Z一二三123]"]
    if any(re.search(pattern, clause, re.I) for pattern in patterns):
        return True
    if not _is_confirmation(clause) and not re.search(r"是否|\?", clause):
        return False
    return any(re.search(pattern, clause, re.I) for pattern in (
        r"停止|终止|暂停|取消|放弃|跳过|暂缓|不再继续",
        r"(?:切换|更换)[^。!?\n]{0,20}模型|(?:继续|进行|执行)[^。!?\n]{0,10}(?:多模态|视觉)测试",
        r"(?:是否|能否|可否)(?:仍然|仍|继续|已经|已|都|您认为|你觉得)?(?:正确|成功|完成|通过|符合|满足|满意|接受|看清|看懂)",
        r"是否(?:可以|能够)?(?:接受|认可)|(?:请(?:您)?|需要(?:您|用户))确认(?:一下)?(?:这个|当前|现在的)?(?:页面|布局|预览|效果|设计|结果)",
        r"是否(?:已经|已|正在)|是否[^。!?;；\n]{0,20}(?:了|过)(?:预览|报告|下一阶段|吗|[?。])",
        r"(?:正确|成功|完成|通过|符合预期|满意|满足要求|看清|看懂|喜欢)(?:了)?吗",
        r"(?:效果|布局|页面|预览|交互|设计|结果)[^。!?;；\n]{0,20}(?:是否(?:合适|满意|正确|符合|满足|需要调整)|符合预期|满意吗|可以接受)",
        r"^(?:这个|当前|现在的)?(?:效果|布局|页面|预览|交互|设计|结果)(?:可以|行|好吗|怎么样|如何|OK)",
        r"是否(?:执行|生成|进入|构建|编译|测试)(?:了|过|完|成功|失败)",
    ))


def requires_manual_confirmation(value, has_options=False):
    return any(_needs_human(clause, has_options) for clause in _question_clauses(_normalized(value)))


def automatic_text_reply(value):
    text = _normalized(value)
    if requests_basic_tests_confirmation(text):
        return {"text": BASIC_TESTS_REPLY, "reason": "multimodal_unavailable"}
    clauses = _question_clauses(text)
    if any(_needs_human(clause) for clause in clauses):
        return None
    return {"text": CONTINUE_TASK_REPLY, "reason": "workflow_confirmation"} if any(
        _is_confirmation(clause) for clause in clauses) else None
