"""Check remote task API status and SQLite persistence without calling a model."""

import json
import importlib.util
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.request import Request, urlopen

from http.server import ThreadingHTTPServer

from pyautorun.whitebox_api import WhiteboxApiService, make_handler
from pyautorun.tests.test_whitebox_remote import _task


@unittest.skipUnless(importlib.util.find_spec("yaml"), "PyYAML unavailable")
class WhiteboxApiTests(unittest.TestCase):
    def test_submit_status_result_and_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            def evaluator(task, *, local_case_root, case_dir):
                del task, local_case_root
                path = Path(case_dir) / "outputs" / "result.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({"basic_info": {"case_name": "demo"},
                    "overall_conclusion": {"total_score": 86, "hard_gate_triggered": False},
                    "testExecution": {"secret": True}}), encoding="utf-8")
                return {"resultPath": str(path)}
            service = WhiteboxApiService(temp, evaluator=evaluator, recover=False,
                                         review_root=Path(temp) / "review")
            server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urlopen(Request(base + "/score/run-remote-task",
                                     data=json.dumps(_task()).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")) as response:
                    self.assertTrue(json.load(response)["success"])
                for _ in range(100):
                    with urlopen(base + "/score/remote-tasks/status?taskIds=42,43") as response:
                        statuses = json.load(response)["items"]
                    if statuses[0]["status"] == "completed":
                        break
                    time.sleep(.01)
                self.assertEqual(statuses[0]["status"], "completed")
                self.assertEqual(statuses[1]["status"], "missing")
                with urlopen(base + "/score/remote-tasks/42/result") as response:
                    result = json.load(response)
                self.assertEqual(result["resultData"]["overall_conclusion"]["total_score"], 86)
                self.assertNotIn("testExecution", result["resultData"])
                with urlopen(base + "/dashboard/tasks") as response:
                    self.assertEqual(json.load(response)["items"][0]["score"], 86)
                with urlopen(base + "/dashboard/summary") as response:
                    self.assertEqual(json.load(response)["scoreSummary"]["averageScore"], 86)
                with urlopen(base + "/score/rule-violation-stats") as response:
                    self.assertEqual(json.load(response)["summary"]["totalRuns"], 1)
                with urlopen(base + "/dashboard/tasks/42/agent-trace") as response:
                    self.assertFalse(json.load(response)["traceAvailable"])
                consistency = {"id": "pair-1", "sequence": 1, "runs": []}
                with urlopen(Request(base + "/score/consistency-tasks/pair-1",
                                     data=json.dumps(consistency).encode(), method="PUT")) as response:
                    self.assertEqual(json.load(response)["item"]["id"], "pair-1")
                with urlopen(base + "/score/consistency-tasks") as response:
                    self.assertEqual(len(json.load(response)["items"]), 1)
                with urlopen(Request(base + "/score/remote-tasks/42/human-review",
                                     data=json.dumps({"manualLevel": "L3"}).encode(),
                                     method="POST")) as response:
                    self.assertTrue(json.load(response)["success"])
                self.assertTrue(list(Path(temp).glob("*_case_42_*/human-rating/manual-rating.json")))
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                worker.join()
            restarted = WhiteboxApiService(temp, evaluator=evaluator, recover=False)
            self.assertEqual(restarted.store.get_remote(42)["score"], 86)
            restarted.close()


if __name__ == "__main__":
    unittest.main()
