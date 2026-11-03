"""Resolve configured execution toolchains and environment paths."""

import os
from pathlib import Path
from harmonyeval.utils.encoding import python_utf8_environment


def tool_environment(settings, base=None):
    env = python_utf8_environment(base)
    paths = []
    mapping = {"deveco_home": "DEVECO_HOME", "flutter_home": "FLUTTER_HOME",
               "java_home": "JAVA_HOME", "sdk_home": "DEVECO_SDK_HOME"}
    for key, value in settings.items():
        if not value:
            continue
        path = Path(value)
        if not path.is_dir():
            raise ValueError(f"执行环境路径不存在: {key}={path}")
        if key in mapping:
            env[mapping[key]] = str(path)
        if key == "deveco_home":
            path = path / "Contents" if (path / "Contents").is_dir() else path
            env["DEVECO_HOME"] = str(path)
            for p in (path / "tools/node/bin", path / "tools/ohpm/bin", path / "tools/hvigor/bin"):
                paths.append(str(p))
            env.setdefault("JAVA_HOME", str(path / ("jbr/Contents/Home" if os.name != "nt" else "jbr")))
            env.setdefault("DEVECO_SDK_HOME", str(path / "sdk"))
        elif key in ("java_home", "flutter_home"):
            paths.append(str(path / "bin"))
        elif key == "sdk_home":
            paths.append(str(path / "default/openharmony/toolchains"))
    env["PATH"] = os.pathsep.join(paths + [env.get("PATH", "")])
    return env
