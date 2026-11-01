"""API count evidence, visibility and scoring; no SDK/model/device required."""
import asyncio
import json
from pathlib import Path
import tempfile
import unittest

from pyautorun.harmony_eval.api_inventory import inventory
from pyautorun.harmony_eval.core import EvalCase, ExecutionResult
from pyautorun.harmony_eval.verification import capture_verification_inputs, pipeline
from pyautorun.harmony_eval.score_rules import calculate_scores


class APICountTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="harmony-eval-api-count-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def write(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)
        return target

    def test_dart_visibility_accessors_and_non_api_text(self):
        self.write("source/pubspec.yaml", "name: fixture")
        self.write("source/lib/library.dart", '''
// class Fake { void wrong() {} }
class Box {
  Box();
  Box.named();
  int get value => 1;
  set value(int v) {}
  final int x = 1, y = 2;
  void run() { void local() {} final text = 'void fake() {}'; }
  void _hidden() {}
}
class _Hidden { void leak() {} }
typedef Callback = void Function(int x);
void top() {}
''')
        self.write("source/test/fake_test.dart", "class TestOnly { void wrong() {} }")
        self.write("source/example/lib/app.dart", "class Demo {}")
        data = inventory(self.root / "source")
        self.assertEqual(data["counts"], {"types": 2, "callables": 2, "properties": 3})
        self.assertEqual(data["files"], ["lib/library.dart"])
        self.assertTrue(all(entry["line"] > 0 for entry in data["apis"]))

    def test_typescript_exports_overloads_and_aliases(self):
        self.write("target/Index.ets", '''
export class Box {
  private hidden = 1;
  protected subclassOnly = 2;
  #secret = 3;
  constructor(public id: number) {}
  run(value: string): void;
  run(value: number): void;
  run(value: string | number) {}
  get value(): number { return 1; }
  set value(v: number) {}
  callback = () => {};
}
class Hidden { leak() {} }
const local = 1;
export { local as visible };
export function top() { function nested() {} }
export const fn = () => {};
''')
        data = inventory(self.root / "target")
        self.assertEqual(data["counts"], {"types": 1, "callables": 3, "properties": 4})
        self.assertNotIn("Hidden", {item["name"] for item in data["apis"]})
        self.assertEqual(data["languages"], ["typescript"])

    def test_java_and_kotlin_public_members(self):
        self.write("jvm/src/Box.java", '''
public class Box {
  public int x, y;
  private int hidden;
  public Box() {}
  public int read() { return x; }
  public int read(int v) { return v; }
  void packageOnly() {}
  public interface I { int read(); int SIZE = 1; }
}
class Internal { public void leak() {} }
''')
        self.write("jvm/src/Other.kt", '''
package example
class Other(val value: Int, private val secret: Int) {
    fun run() {}
    internal fun hidden() {}
}
private class Hidden {}
''')
        data = inventory(self.root / "jvm")
        self.assertEqual(data["counts"], {"types": 3, "callables": 3, "properties": 4})

    def test_mixins_enums_and_default_exports(self):
        self.write("dart/types.dart", "mixin Runner { void run() {} }\nenum Color { red, blue }")
        self.assertEqual(inventory(self.root / "dart")["counts"], {"types": 2, "callables": 1, "properties": 2})
        self.write("esm/function.js", "export default () => {}; console.log('module.exports is just text');")
        self.write("esm/class.js", "export default class { run() {} }")
        self.assertEqual(inventory(self.root / "esm")["counts"], {"types": 1, "callables": 2, "properties": 0})
        self.write("java/Color.java", "public enum Color { RED, BLUE; public void run() {} }")
        self.assertEqual(inventory(self.root / "java")["counts"], {"types": 1, "callables": 1, "properties": 2})

    def test_invalid_syntax_and_unsupported_languages_are_not_zero(self):
        bad = self.write("bad/index.ts", "export class Broken {")
        with self.assertRaisesRegex(ValueError, "解析未完整成功"):
            inventory(bad.parent)
        self.write("unknown/main.py", "def run(): pass")
        with self.assertRaisesRegex(ValueError, "未找到可统计"):
            inventory(self.root / "unknown")

    def setup_workflow(self):
        source = self.write("source/lib.dart", "class Box { int x = 1; void run() {} }").parent
        target = self.write("base/Index.ets", "export class Box { x: number = 1; run() {} }").parent
        task = {"active": {"execution": {}, "verification": [{"id": "api", "type": "LibraryAPICount"}]}}
        case = EvalCase("case1", "Convert library", str(source), str(source))
        output = self.root / "output"
        asyncio.run(capture_verification_inputs(task, case, output))
        return task, case, ExecutionResult("completed", project=str(target)), output

    def test_snapshot_and_consistency_with_missing_and_extra_apis(self):
        task, case, execution, output = self.setup_workflow()
        # Editing the source later cannot replace the pre-execution API baseline.
        (Path(case.project) / "lib.dart").write_text("class Changed {}")
        results = asyncio.run(pipeline(task, case, execution, output))
        metrics = results["api"]["metrics"]
        self.assertTrue(metrics["count_match"])
        self.assertEqual(metrics["source_total"], 3)
        self.assertEqual(metrics["count_consistency"], 1)
        evidence = output / "verification/api/api-count.json"
        self.assertEqual(json.loads(evidence.read_text())["source"]["total"], 3)
        self.assertTrue(evidence.with_suffix(".md").is_file())
        (Path(execution.project) / "Index.ets").write_text("export class Box { x: number = 1; run() {} extra() {} }")
        results = asyncio.run(pipeline(task, case, execution, output))
        self.assertEqual(results["api"]["metrics"]["count_consistency"], 0.75)
        self.assertFalse(results["api"]["metrics"]["count_match"])
        score = calculate_scores(results, [{"dimension": "api_count_consistency", "type": "ImmediateValue",
                                            "source": "api.metrics.count_consistency", "scale": 100}])
        self.assertEqual(score["api_count_consistency"]["score"], 75)
        # Equal totals cannot conceal category substitutions.
        (Path(execution.project) / "Index.ets").write_text("export class Box { run() {} extra() {} }")
        metrics = asyncio.run(pipeline(task, case, execution, output))["api"]["metrics"]
        self.assertTrue(metrics["total_match"])
        self.assertFalse(metrics["count_match"])
        self.assertEqual(metrics["count_consistency"], 0.5)

    def test_empty_public_source_or_missing_snapshot_unavailable(self):
        task, case, execution, output = self.setup_workflow()
        snapshot = output / "verification/api/input-evidence.json"
        snapshot.unlink()
        result = asyncio.run(pipeline(task, case, execution, output))["api"]
        self.assertEqual(result["status"], "unavailable")
        self.assertIn("快照", result["error"])
        (Path(case.project) / "lib.dart").write_text("class _Private {}")
        asyncio.run(capture_verification_inputs(task, case, output))
        result = asyncio.run(pipeline(task, case, execution, output))["api"]
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["metrics"], {})


if __name__ == "__main__":
    unittest.main()
