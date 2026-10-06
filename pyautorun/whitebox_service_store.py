"""SQLite task index compatible with the former Node whitebox service."""

import json
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import time

from .whitebox_consistency import normalize_consistency


REMOTE_COLUMNS = {"caseDir": "case_dir", "testCaseId": "test_case_id",
                  "testCaseName": "test_case_name", "testCaseType": "test_case_type",
                  "remoteTaskFile": "remote_task_file", "error": "error",
                  "caseName": "case_name", "taskType": "task_type", "score": "score",
                  "hardGateTriggered": "hard_gate_triggered", "resultAvailable": "result_available",
                  "resultError": "result_error", "risks": "risks_json"}


class WhiteboxServiceStore:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "score-index.sqlite3"
        with self._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS remote_task (
                  task_id INTEGER PRIMARY KEY, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
                  updated_at_ms INTEGER NOT NULL, case_dir TEXT, token TEXT, test_case_id INTEGER,
                  test_case_name TEXT, test_case_type TEXT, error TEXT, remote_task_file TEXT,
                  recovery_attempt_count INTEGER, last_recovery_at_ms INTEGER, case_name TEXT,
                  task_type TEXT, score REAL, hard_gate_triggered INTEGER,
                  result_available INTEGER NOT NULL DEFAULT 0, result_error TEXT, risks_json TEXT
                );
                CREATE TABLE IF NOT EXISTS consistency_task (
                  id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, payload_json TEXT NOT NULL,
                  updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS rule_violation_run (
                  task_id INTEGER PRIMARY KEY, case_id TEXT NOT NULL, test_case_id INTEGER NOT NULL,
                  case_name TEXT NOT NULL, completed_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS rule_violation_item (
                  task_id INTEGER NOT NULL, item_index INTEGER NOT NULL DEFAULT 0,
                  pack_id TEXT NOT NULL, rule_id TEXT NOT NULL, rule_summary TEXT NOT NULL,
                  rule_source TEXT NOT NULL, pack_display_name TEXT, conclusion TEXT NOT NULL,
                  PRIMARY KEY(task_id, item_index),
                  FOREIGN KEY(task_id) REFERENCES rule_violation_run(task_id) ON DELETE CASCADE
                );
            """)

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def _remote(row):
        if row is None:
            return None
        record = {"taskId": row["task_id"], "status": row["status"],
                  "createdAt": row["created_at_ms"], "updatedAt": row["updated_at_ms"]}
        for key, column in REMOTE_COLUMNS.items():
            if row[column] is not None:
                value = row[column]
                if key in ("hardGateTriggered", "resultAvailable"):
                    value = bool(value)
                elif key == "risks":
                    value = json.loads(value)
                record[key] = value
        return record

    def get_remote(self, task_id):
        with self._connect() as db:
            return self._remote(db.execute("SELECT * FROM remote_task WHERE task_id=?", (task_id,)).fetchone())

    def list_remote(self):
        with self._connect() as db:
            return [self._remote(row) for row in db.execute("SELECT * FROM remote_task ORDER BY task_id")]

    def upsert_remote(self, task_id, status, **fields):
        now = int(time.time() * 1000)
        columns = ["task_id", "status", "created_at_ms", "updated_at_ms"]
        values = [task_id, status, now, now]
        for key, value in fields.items():
            column = REMOTE_COLUMNS.get(key)
            if column is None:
                raise ValueError(f"unsupported remote task field: {key}")
            columns.append(column)
            values.append(json.dumps(value, ensure_ascii=False) if key == "risks" else
                          int(value) if key in ("hardGateTriggered", "resultAvailable") and value is not None
                          else value)
        update = ["status=excluded.status", "updated_at_ms=excluded.updated_at_ms"] + [
            f"{column}=excluded.{column}" for column in columns[4:]]
        sql = (f'INSERT INTO remote_task ({", ".join(columns)}) VALUES '
               f'({", ".join("?" for _ in columns)}) ON CONFLICT(task_id) DO UPDATE SET '
               + ", ".join(update))
        with self._connect() as db:
            db.execute(sql, values)
        return self.get_remote(task_id)

    def delete_remote(self, task_id):
        with self._connect() as db:
            db.execute("DELETE FROM rule_violation_item WHERE task_id=?", (task_id,))
            db.execute("DELETE FROM rule_violation_run WHERE task_id=?", (task_id,))
            cursor = db.execute("DELETE FROM remote_task WHERE task_id=?", (task_id,))
            return cursor.rowcount > 0

    def write_rule_violations(self, task_id, case_id, test_case_id, case_name, completed_at_ms, rules):
        with self._connect() as db:
            db.execute("INSERT INTO rule_violation_run(task_id, case_id, test_case_id, case_name, completed_at_ms) "
                       "VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET case_id=excluded.case_id, "
                       "test_case_id=excluded.test_case_id, case_name=excluded.case_name, "
                       "completed_at_ms=excluded.completed_at_ms",
                       (task_id, case_id, test_case_id, case_name, completed_at_ms))
            db.execute("DELETE FROM rule_violation_item WHERE task_id=?", (task_id,))
            for index, rule in enumerate(rules):
                db.execute("INSERT INTO rule_violation_item(task_id, item_index, pack_id, rule_id, "
                           "rule_summary, rule_source, pack_display_name, conclusion) "
                           "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                           (task_id, index, rule["pack_id"], rule["rule_id"], rule["rule_summary"],
                            rule["rule_source"], rule.get("pack_display_name"), rule["conclusion"]))

    def list_rule_violations(self):
        with self._connect() as db:
            rows = db.execute("SELECT r.task_id, r.case_id, r.test_case_id, r.case_name, "
                              "r.completed_at_ms, i.pack_id, i.rule_id, i.rule_summary, "
                              "i.rule_source, i.pack_display_name, i.conclusion "
                              "FROM rule_violation_run r LEFT JOIN rule_violation_item i "
                              "ON i.task_id=r.task_id ORDER BY r.task_id, i.item_index").fetchall()
        by_task = {}
        for row in rows:
            task_id = row["task_id"]
            if task_id not in by_task:
                by_task[task_id] = {"taskId": task_id, "caseId": row["case_id"],
                    "testCaseId": row["test_case_id"], "caseName": row["case_name"],
                    "completedAt": row["completed_at_ms"], "rules": []}
            if row["rule_id"]:
                by_task[task_id]["rules"].append({"pack_id": row["pack_id"],
                    "rule_id": row["rule_id"], "rule_summary": row["rule_summary"],
                    "rule_source": row["rule_source"], "pack_display_name": row["pack_display_name"],
                    "conclusion": row["conclusion"], "result": "不满足"})
        return list(by_task.values())

    def list_consistency(self):
        with self._connect() as db:
            return [json.loads(row["payload_json"]) for row in db.execute(
                "SELECT payload_json FROM consistency_task ORDER BY sequence, id")]

    def upsert_consistency(self, item):
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip() or \
                isinstance(item.get("sequence"), bool) or not isinstance(item.get("sequence"), (int, float)):
            raise ValueError("consistency task needs id and numeric sequence")
        with self._connect() as db:
            row = db.execute("SELECT payload_json FROM consistency_task WHERE id=?", (item["id"],)).fetchone()
            payload = normalize_consistency({**(json.loads(row["payload_json"]) if row else {}), **item})
            db.execute("INSERT INTO consistency_task(id, sequence, payload_json, updated_at_ms) "
                       "VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence, "
                       "payload_json=excluded.payload_json, updated_at_ms=excluded.updated_at_ms",
                       (payload["id"], payload["sequence"], json.dumps(payload, ensure_ascii=False),
                        int(time.time() * 1000)))
        return payload

    def replace_consistency(self, items):
        if not isinstance(items, list):
            raise ValueError("consistency tasks must be an array")
        with self._connect() as db:
            if not items and db.execute("SELECT 1 FROM consistency_task LIMIT 1").fetchone():
                raise ValueError("Refusing to replace existing consistency tasks with an empty collection")
            db.execute("DELETE FROM consistency_task")
            for item in items:
                if not isinstance(item, dict) or not isinstance(item.get("id"), str) or \
                        isinstance(item.get("sequence"), bool) or not isinstance(item.get("sequence"), (int, float)):
                    raise ValueError("consistency task needs id and numeric sequence")
                item = normalize_consistency(item)
                db.execute("INSERT INTO consistency_task(id, sequence, payload_json, updated_at_ms) "
                           "VALUES (?, ?, ?, ?)", (item["id"], item["sequence"],
                           json.dumps(item, ensure_ascii=False), int(time.time() * 1000)))
        return self.list_consistency()

    def delete_consistency(self, task_id):
        with self._connect() as db:
            return db.execute("DELETE FROM consistency_task WHERE id=?", (task_id,)).rowcount > 0
