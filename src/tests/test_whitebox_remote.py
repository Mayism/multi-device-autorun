"""Exercise the Python remote task preparation and callback contract."""

from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

from pyautorun.whitebox_eval.service.remote import (download_project, prepare_remote_task, run_remote_task)


def _task():
    return {"taskId": 42, "testCase": {"id": 7, "name": "demo", "type": "incremental",
            "description": "修改页面", "input": "修改标题", "expectedOutput": "", "fileUrl": "https://example.test/original"},
            "executionResult": {"isBuildSuccess": True, "outputCodeUrl": "https://example.test/generated"},
            "callback": "https://example.test/callback"}


def _fetch(url):
    content = "old" if url.endswith("original") else "new"
    return json.dumps({"files": [{"path": "entry/src/main/Page.ets", "content": content}]}).encode(), "application/json"


class RemoteWhiteboxTests(unittest.TestCase):
    def test_prepare_manifest_and_preserve_remote_build_status(self):
        with tempfile.TemporaryDirectory() as temp:
            manifest = prepare_remote_task(_task(), Path(temp) / "case", fetch=_fetch)
            self.assertEqual(manifest["taskType"], "continuation")
            self.assertTrue(manifest["remoteBuildSuccess"])
            self.assertEqual((Path(manifest["generatedProjectPath"]) / "entry/src/main/Page.ets").read_text(), "new")
            self.assertTrue(Path(manifest["promptPath"]).is_file())

    def test_rejects_unsafe_json_and_zip_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, "unsafe path"):
                download_project("https://example.test/manifest", Path(temp) / "json",
                    fetch=lambda _url: (b'{"files":[{"path":"../escape","content":"bad"}]}', "application/json"))
            data = BytesIO()
            with ZipFile(data, "w") as archive:
                archive.writestr("../../escape", "bad")
            with self.assertRaisesRegex(ValueError, "unsafe path"):
                download_project("https://example.test/archive.zip", Path(temp) / "zip",
                    fetch=lambda _url: (data.getvalue(), "application/zip"))
            self.assertFalse((Path(temp) / "escape").exists())

    def test_callback_contains_completed_result_subset(self):
        callbacks = []
        def callback(_endpoint, payload):
            callbacks.append(payload)
            return {"uploaded": True, "message": "ok"}
        def evaluator(manifest):
            result = Path(manifest["outputDir"]) / "outputs" / "result.json"
            result.parent.mkdir(parents=True, exist_ok=True)
            result.write_text(json.dumps({"basic_info": {"case_name": "demo"},
                                          "overall_conclusion": {"total_score": 84, "max_score": 100},
                                          "details": [1]}))
            return {"status": "completed", "resultPath": str(result)}
        with tempfile.TemporaryDirectory() as temp:
            result = run_remote_task(_task(), local_case_root=temp, evaluator=evaluator,
                                     fetch=_fetch, callback=callback)
            self.assertEqual(result["taskId"], 42)
            self.assertEqual([item["status"] for item in callbacks], ["running", "completed"])
            self.assertEqual(callbacks[-1]["totalScore"], 84)
            self.assertNotIn("details", callbacks[-1]["resultData"])


if __name__ == "__main__":
    unittest.main()
