"""Read this run's OpenCode main/child sessions before its private DB is removed."""
import json
from contextlib import closing
from pathlib import Path
import sqlite3


def capture_sessions(prepared, root_id):
    if not root_id:
        return [], {"mode": "cli-events", "reason": "CLI未返回主会话ID"}
    # Never search the user's HOME or global OpenCode/HarmonyBot databases.
    data_root = Path(prepared["env"]["XDG_DATA_HOME"]).resolve() / "opencode"
    errors = []
    for source in sorted(data_root.glob("*.db")):
        if source.is_symlink():
            continue
        try:
            with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA query_only=ON")
                sessions = {row["id"]: dict(row) for row in db.execute("SELECT * FROM session")}
                if root_id not in sessions:
                    continue
                selected = {root_id}
                while True:
                    children = {sid for sid, info in sessions.items() if info.get("parent_id") in selected}
                    if children <= selected:
                        break
                    selected |= children
                output = []
                for sid in [root_id, *sorted(selected - {root_id})]:
                    messages = []
                    for row in db.execute("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id", (sid,)):
                        info = json.loads(row["data"])
                        info.setdefault("id", row["id"])
                        info.setdefault("sessionID", sid)
                        parts = [json.loads(p["data"]) for p in db.execute(
                            "SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id", (row["id"],))]
                        messages.append({"info": info, "parts": parts})
                    output.append({"sessionId": sid, "parentId": sessions[sid].get("parent_id"),
                                   "title": sessions[sid].get("title"), "messages": messages})
                return output, {"mode": "sqlite-readonly", "sessions": len(output),
                                "sub_sessions": len(output) - 1, "scope": "main session and descendants only"}
        except (sqlite3.Error, ValueError, TypeError, KeyError) as error:
            errors.append(type(error).__name__ + ": " + str(error))
    return [], {"mode": "cli-events", "reason": "运行期数据库不可用或版本不兼容", "errors": errors}


def session_tool_calls(sessions):
    calls = []
    for session in sessions:
        for message in session.get("messages", []):
            for part in message.get("parts", []):
                if part.get("type") != "tool":
                    continue
                state = part.get("state", {})
                calls.append({"id": part.get("id"), "session_id": session["sessionId"], "name": part.get("tool"),
                              "input": state.get("input", {}), "status": state.get("status"),
                              "output": state.get("output"), "error": state.get("error")})
    return calls
