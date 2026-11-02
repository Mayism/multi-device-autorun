"""Create per-sample OpenCode environment variables and private storage paths."""
import os
from pathlib import Path
from .toolchain import tool_environment


def private_environment(runtime, execution, bin_dir, config_root):
    env = tool_environment(execution.get("enviroment", {}))
    for key in list(env):
        if key.startswith("OPENCODE_"):
            del env[key]
    for key, directory in (("XDG_CONFIG_HOME", "xdg-config"), ("XDG_DATA_HOME", "data"),
                           ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state")):
        env[key] = str(runtime / directory)
        (runtime / directory).mkdir(exist_ok=True)
    env.update({"OPENCODE_CONFIG_DIR": str(config_root), "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
                "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1", "OPENCODE_DISABLE_AUTOUPDATE": "true",
                "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1", "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS": "1",
                "OPENCODE_DISABLE_MODELS_FETCH": "1",
                "PATH": str(bin_dir) + os.pathsep + env.get("PATH", "")})
    # Global.Path.home otherwise discovers ~/.opencode even with project configs disabled.
    private_home = runtime / "home"
    private_home.mkdir(exist_ok=True)
    env["OPENCODE_TEST_HOME"] = str(private_home)
    return env
