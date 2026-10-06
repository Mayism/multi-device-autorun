"""Validate the local whitebox result against its Draft 2020-12 contract."""

import json
from pathlib import Path


def validate_whitebox_result(result, schema_path):
    try:
        from jsonschema import Draft202012Validator
    except ImportError as error:
        raise RuntimeError("Python 白盒结果校验需要 jsonschema；安装 pip install '.[whitebox]'") from error

    schema = json.loads(Path(schema_path).read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(result), key=lambda item: (list(map(str, item.absolute_path)), item.message))
    if errors:
        detail = "; ".join(f"/{'/'.join(map(str, error.absolute_path))} {error.message}" for error in errors)
        raise ValueError(f"Schema validation failed: {detail}")
