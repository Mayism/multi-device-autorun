"""Verify trace summaries redact raw prompts while raw endpoints retain them."""

import json
from pathlib import Path
import tempfile
import unittest

from pyautorun.whitebox_eval.service.trace import trace_event_raw, trace_run_raw, trace_summary


class TraceTests(unittest.TestCase):
    def test_summary_and_raw(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "outputs" / "agent-trace.json"
            path.parent.mkdir()
            path.write_text(json.dumps({"schemaVersion": 1, "runs": [{
                "id": "r1", "prompt": "secret prompt", "events": [{"id": "e1", "rawPayload": {"x": 1}}],
                "attempts": [{"id": "a1", "prompt": "secret attempt"}]}]}))
            record = {"taskId": 1, "caseDir": temp}
            summarized = trace_summary(record)
            self.assertTrue(summarized["traceAvailable"])
            self.assertNotIn("prompt", summarized["report"]["runs"][0])
            self.assertTrue(summarized["report"]["runs"][0]["events"][0]["hasRawPayload"])
            self.assertEqual(trace_run_raw(record, "r1")["prompt"], "secret prompt")
            self.assertEqual(trace_event_raw(record, "e1")["rawPayload"], {"x": 1})


if __name__ == "__main__":
    unittest.main()
