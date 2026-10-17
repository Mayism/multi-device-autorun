"""Keep one local ZIP for each case without temporary runtime metadata."""

from pathlib import Path

from pyautorun.orchestration.artifact_cleanup import CASE_METADATA_FILES, OMITTED_GENERATE_FILES
from pyautorun.reporting.archive import create_zip


def archive_cases(batch_root, summary, on_log=lambda _message: None):
    root = Path(batch_root)
    archived = []
    for result in summary.get("results") or []:
        name = result.get("case")
        if not name:
            continue
        case_dir = root / name
        if not case_dir.is_dir():
            on_log(f"{name}: 用例目录不存在，跳过")
            continue
        local = case_dir / f"{name}_{summary.get('batchId') or root.name}.zip"
        excluded = [local, *(case_dir / item for item in CASE_METADATA_FILES),
                    *(case_dir / "generate" / item for item in OMITTED_GENERATE_FILES)]
        try:
            content = create_zip({"sources": [{"dirPath": str(case_dir), "prefix": ""}],
                                  "excludeAbsPaths": [str(item) for item in excluded]})
            local.write_bytes(content)
            archived.append(str(local))
            on_log(f"{name}: 本地 ZIP 已保存 → {local}")
        except Exception as error:
            on_log(f"{name}: 打包失败: {error}")
    return archived
