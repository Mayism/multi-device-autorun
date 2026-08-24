# Fold Control Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate fold-control-tool into harmonyos-ohostest-runner so runner auto-manages fold-server lifecycle per device and auto-deploys FoldTrigger.ets.

**Architecture:** New `src/fold.ts` module wraps fold-server.py as a managed child process. Runner starts fold-server before running suites on foldControl-marked devices, deploys FoldTrigger.ets template with correct port, and stops fold-server after. fold-server.py gets a `--port` CLI arg for multi-instance support.

**Tech Stack:** TypeScript/Node.js (runner), Python 3.6+ stdlib (fold-server.py), ArkTS (FoldTrigger.ets template).

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/fold.ts` | Create | FoldManager: start/stop/healthCheck/deployFoldTrigger |
| `src/types.ts` | Modify | Add foldControl, foldServerScript fields, fold_server_start_failed reason |
| `src/config.ts` | Modify | Parse foldControl and foldServerScript from machine.json |
| `src/runner.ts` | Modify | Integrate fold lifecycle into runDevice() |
| `src/result.ts` | Modify | Show fold info in summary |
| `src/fold-template.ts` | Create | FoldTrigger.ets template string |
| `tests/fold.test.ts` | Create | Unit tests for FoldManager |
| `config/machine.json` | Modify | Add foldServerScript path, foldControl on foldable device |
| `../fold-control-tool/fold-server.py` | Modify | Add --port and --profile CLI args |

---

### Task 1: Extend Type Definitions

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add foldControl to DeviceConfig and RawDeviceConfig**

```typescript
// In RawDeviceConfig (after hdcPort):
export interface RawDeviceConfig {
  id?: string;
  profile?: string;
  target?: string;
  hdcPort?: number;
  startEmulator?: boolean;
  foldControl?: boolean;
  testSuites?: unknown;
}

// In DeviceConfig (after testClasses):
export interface DeviceConfig {
  id: string;
  profile?: string;
  target: string;
  hdcPort?: number;
  startEmulator: boolean;
  foldControl?: boolean;
  testClasses?: string[];
}
```

- [ ] **Step 2: Add foldServerScript to MatrixConfig paths and RawMatrixConfig paths**

```typescript
// In RawMatrixConfig paths:
export interface RawMatrixConfig {
  // ... existing fields ...
  paths?: {
    hvigorw?: string;
    hdc?: string;
    emulatorBin?: string;
    emulatorDeployedDir?: string;
    foldServerScript?: string;
  };
}

// In MatrixConfig paths:
export interface MatrixConfig {
  // ... existing fields ...
  paths: {
    hvigorw: string;
    hdc: string;
    emulatorBin: string;
    emulatorDeployedDir: string;
    foldServerScript?: string;
  };
}
```

- [ ] **Step 3: Add fold_server_start_failed to BlockedReason and foldServerPort to DeviceRunResult**

```typescript
// In BlockedReason:
export type BlockedReason =
  | "emulator_start_failed"
  | "hdc_not_connected"
  | "install_failed"
  | "test_command_failed"
  | "test_output_unparseable"
  | "fold_server_start_failed";

// In DeviceRunResult (after log):
export interface DeviceRunResult {
  // ... existing fields ...
  log: string;
  blockedReason?: BlockedReason;
  foldServerPort?: number;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add fold control types to config and device schemas"
```

---

### Task 2: Modify fold-server.py to Support --port and --profile CLI

**Files:**
- Modify: `../fold-control-tool/fold-server.py`

- [ ] **Step 1: Read fold-server.py to understand current argument handling**

The file is at `/Users/zzz/robot/one2many-case/folded-case-01/fold-control-tool/fold-server.py`. Currently it accepts one positional arg for instance name.

- [ ] **Step 2: Add argparse for --port and --profile**

Replace the `sys.argv` positional arg logic in `main()` with argparse. Add `--port` (default 8766) and `--profile` (default "Mate X7"):

```python
import argparse

def main():
    global EMULATOR_INSTANCE, PORT, DEVICE_PORT
    parser = argparse.ArgumentParser(description="Fold control HTTP server")
    parser.add_argument("--profile", default=os.environ.get("EMULATOR_INSTANCE", "Mate X7"),
                        help="Emulator instance name (default: Mate X7)")
    parser.add_argument("--port", type=int, default=8766,
                        help="HTTP server listen port (default: 8766)")
    args = parser.parse_args()
    EMULATOR_INSTANCE = args.profile
    PORT = args.port
    DEVICE_PORT = args.port - 1
    # ... rest of main()
```

Also remove the old `if len(sys.argv) > 1: EMULATOR_INSTANCE = sys.argv[1]` logic.

- [ ] **Step 3: Update PORT/DEVICE_PORT from globals to use argparse values**

The PORT and DEVICE_PORT are currently module-level constants. They need to be set inside `main()` before `setup_fport()` and `HTTPServer` are called. The `print()` statements and `setup_fport()` already reference these globals, so setting them before calling those functions is sufficient.

- [ ] **Step 4: Commit**

```bash
cd /Users/zzz/robot/one2many-case/folded-case-01/fold-control-tool
git add fold-server.py
git commit -m "feat: add --port and --profile CLI args to fold-server"
```

---

### Task 3: Create FoldTrigger.ets Template

**Files:**
- Create: `src/fold-template.ts`

- [ ] **Step 1: Create template module**

```typescript
// src/fold-template.ts

/**
 * FoldTrigger.ets 模板内容。
 * __FOLD_PORT__ 在部署时替换为实际设备端口。
 */
export function foldTriggerTemplate(devicePort: number): string {
  return `import http from '@ohos.net.http';
import { Driver } from '@kit.TestKit';

/**
 * 折叠/旋转触发工具
 *
 * 通过 HTTP 请求宿主机的 fold-server，执行折叠/旋转命令。
 * 由 harmonyos-ohostest-runner 自动部署，端口在部署时注入。
 *
 * 通用连接机制：使用 hdc rport 反向端口转发，
 * 模拟器内访问 127.0.0.1:__DEPLOYED_PORT__ 转发到宿主机 fold-server。
 */

const FOLD_SERVER_HOST = '127.0.0.1';
const FOLD_SERVER_PORT = ${devicePort};

export type FoldState = 'open' | 'half-open' | 'close';
export type RotationDirection = 'left' | 'right';

async function sendCommand(path: string): Promise<void> {
  const httpRequest = http.createHttp();
  const url = \`http://\${FOLD_SERVER_HOST}:\${FOLD_SERVER_PORT}\${path}\`;
  try {
    const response = await httpRequest.request(url, {
      method: http.RequestMethod.GET,
      connectTimeout: 5000,
      readTimeout: 10000,
    });
    if (response.responseCode !== 200) {
      throw new Error(\`fold-server returned error code: \${response.responseCode}\`);
    }
    const body = JSON.parse(response.result as string) as Record<string, Object>;
    if (body['success'] !== true) {
      throw new Error(\`command failed: \${body['message'] ?? 'unknown error'}\`);
    }
  } catch (e) {
    throw new Error(
      \`cannot connect to fold-server (\${url}).\\n\` +
      \`Please check:\\n\` +
      \`1. fold-server is running on the host\\n\` +
      \`2. hdc rport forwarding is established\\n\` +
      \`3. emulator is connected: hdc list target\\n\` +
      \`Original error: \${(e as Error).message ?? e}\`
    );
  } finally {
    httpRequest.destroy();
  }
}

async function isLandscape(driver: Driver): Promise<boolean> {
  const size = await driver.getDisplaySize();
  return size.x > size.y;
}

export async function triggerFold(state: FoldState, waitAfter: number = 3000): Promise<void> {
  await sendCommand(\`/fold?state=\${state}\`);
  await sleep(waitAfter);
}

export async function triggerRotation(direction: RotationDirection, waitAfter: number = 3000): Promise<void> {
  await sendCommand(\`/rotation?direction=\${direction}\`);
  await sleep(waitAfter);
}

export async function triggerLandscapeHover(driver: Driver): Promise<void> {
  await triggerFold('half-open', 2000);
  if (!await isLandscape(driver)) {
    await triggerRotation('right', 2000);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/fold-template.ts
git commit -m "feat: add FoldTrigger.ets template with port injection"
```

---

### Task 4: Create src/fold.ts — FoldManager

**Files:**
- Create: `src/fold.ts`

- [ ] **Step 1: Define interfaces and imports**

```typescript
// src/fold.ts

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { DeviceConfig } from "./types.js";
import { foldTriggerTemplate } from "./fold-template.js";

const FOLD_SERVER_START_PORT = 8766;
const HEALTH_CHECK_TIMEOUT_MS = 10000;
const HEALTH_CHECK_INTERVAL_MS = 500;

export interface FoldServerInstance {
  port: number;
  devicePort: number;
  process: ChildProcess;
}

let nextPort = FOLD_SERVER_START_PORT;
```

- [ ] **Step 2: Implement port allocation**

```typescript
function allocatePort(): { port: number; devicePort: number } {
  const port = nextPort;
  nextPort += 1;
  return { port, devicePort: port - 1 };
}
```

- [ ] **Step 3: Implement start()**

```typescript
export async function startFoldServer(
  device: DeviceConfig,
  foldServerScript: string,
): Promise<FoldServerInstance> {
  const { port, devicePort } = allocatePort();
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  const child = spawn(pythonCmd, [
    foldServerScript,
    "--profile",
    device.profile ?? device.id,
    "--port",
    String(port),
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Collect startup output for diagnostics
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  child.on("error", () => {
    // errors handled via healthCheck
  });

  // Wait for health check
  const healthy = await healthCheck(port, HEALTH_CHECK_TIMEOUT_MS);
  if (!healthy) {
    killFoldServer({ port, devicePort, process: child });
    throw new Error("fold_server_start_failed");
  }

  return { port, devicePort, process: child };
}
```

- [ ] **Step 4: Implement stop()**

```typescript
export function killFoldServer(instance: FoldServerInstance): void {
  try {
    // Kill the process group (detached spawn)
    if (instance.process.pid) {
      process.kill(-instance.process.pid, "SIGTERM");
    }
  } catch {
    // Process may already be dead
  }
}
```

- [ ] **Step 5: Implement healthCheck()**

```typescript
export async function healthCheck(port: number, timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
  }
  return false;
}
```

- [ ] **Step 6: Implement deployFoldTrigger()**

```typescript
export async function deployFoldTrigger(
  projectPath: string,
  devicePort: number,
  moduleSrcPath: string = "entry",
): Promise<string> {
  const targetDir = path.join(projectPath, moduleSrcPath, "src", "ohosTest", "ets", "util");
  const targetFile = path.join(targetDir, "FoldTrigger.ets");

  // Check if already exists
  try {
    await fs.access(targetFile);
    // File exists, skip deployment
    return targetFile;
  } catch {
    // File doesn't exist, create it
  }

  await fs.mkdir(targetDir, { recursive: true });
  const content = foldTriggerTemplate(devicePort);
  await fs.writeFile(targetFile, content, "utf-8");
  return targetFile;
}
```

- [ ] **Step 7: Commit**

```bash
git add src/fold.ts
git commit -m "feat: add FoldManager for fold-server lifecycle and FoldTrigger deployment"
```

---

### Task 5: Update Config Loading to Parse foldControl and foldServerScript

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Parse foldServerScript in readToolPaths**

After the existing `readRequiredConfigString` calls, add optional foldServerScript:

```typescript
function readToolPaths(rawPaths: RawMatrixConfig["paths"]): MatrixConfig["paths"] {
  return {
    hvigorw: readRequiredConfigString(rawPaths?.hvigorw, "config.paths.hvigorw"),
    hdc: readRequiredConfigString(rawPaths?.hdc, "config.paths.hdc"),
    emulatorBin: readRequiredConfigString(rawPaths?.emulatorBin, "config.paths.emulatorBin"),
    emulatorDeployedDir: readRequiredConfigString(
      rawPaths?.emulatorDeployedDir,
      "config.paths.emulatorDeployedDir",
    ),
    ...(rawPaths?.foldServerScript?.trim()
      ? { foldServerScript: rawPaths.foldServerScript.trim() }
      : {}),
  };
}
```

- [ ] **Step 2: Parse foldControl in device mapping**

In the `devices` mapping inside `loadMatrixConfig`, add foldControl:

In the return object for each device (inside `.map()`), add:

```typescript
// After startEmulator line:
startEmulator: device.startEmulator ?? false,
foldControl: device.foldControl ?? false,
```

- [ ] **Step 3: Validate foldServerScript is set when any device has foldControl**

After the devices array is built, add validation:

```typescript
const hasFoldControl = devices.some((d) => d.foldControl);
if (hasFoldControl && !paths.foldServerScript) {
  throw new Error(
    "config.paths.foldServerScript is required when any device has foldControl: true."
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat: parse foldControl and foldServerScript from machine config"
```

---

### Task 6: Integrate Fold Lifecycle into Runner

**Files:**
- Modify: `src/runner.ts`

- [ ] **Step 1: Add import for fold module**

At top of file, add:

```typescript
import { startFoldServer, killFoldServer, deployFoldTrigger, healthCheck } from "./fold.js";
import type { FoldServerInstance } from "./fold.js";
```

- [ ] **Step 2: Insert fold lifecycle in runDevice()**

In `runDevice()`, after `prepareDevice()` call and before `installHaps()`, add:

```typescript
// Start fold server if device needs fold control
let foldServer: FoldServerInstance | undefined;
if (input.device.foldControl && input.config.paths.foldServerScript) {
  try {
    foldServer = await startFoldServer(input.device, input.config.paths.foldServerScript);
    logLines.push(`foldServerPort: ${foldServer.port}`);
    // Deploy FoldTrigger.ets
    const triggerPath = await deployFoldTrigger(
      input.config.project,
      foldServer.devicePort,
    );
    logLines.push(`deployedFoldTrigger: ${triggerPath}`);
  } catch (error) {
    logLines.push(`foldServerError: ${error instanceof Error ? error.message : String(error)}`);
    return blockedDevice(input, started, logLines, "fold_server_start_failed");
  }
}
```

- [ ] **Step 3: Add fold cleanup in finally block**

In the `finally` block of `runDevice()`, add fold server cleanup before emulator stop:

```typescript
finally {
  // Stop fold server if started
  if (foldServer) {
    killFoldServer(foldServer);
  }
  if (input.device.startEmulator && !input.keepEmulators) {
    // ... existing emulator stop code
  }
}
```

- [ ] **Step 4: Pass foldServerPort to DeviceRunResult**

In the success return of `runDevice()`, add `foldServerPort`:

```typescript
return {
  id: input.device.id,
  // ... existing fields ...
  log,
  ...(foldServer ? { foldServerPort: foldServer.port } : {}),
};
```

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts
git commit -m "feat: integrate fold server lifecycle into device runner"
```

---

### Task 7: Update Summary and Config Files

**Files:**
- Modify: `src/result.ts`
- Modify: `config/machine.json`

- [ ] **Step 1: Add fold info to summary markdown**

In `renderSummaryMarkdown()`, add foldServerPort to device rows. In the device info section (`### ${device.id}`), after the id line, add:

```typescript
const foldInfo = device.foldServerPort !== undefined
  ? [`- Fold Server Port: ${device.foldServerPort}`, ""]
  : [];
```

And include `foldInfo` in the device section output.

- [ ] **Step 2: Update config/machine.json**

Add `foldServerScript` to paths and `foldControl: true` to the foldable device:

```json
{
  "paths": {
    "hvigorw": "hvigorw",
    "hdc": "/Users/guoyutong/command-line-tools/sdk/default/openharmony/toolchains/hdc",
    "emulatorBin": "/Applications/DevEco-Studio.app/Contents/tools/emulator/Emulator",
    "emulatorDeployedDir": "/Users/guoyutong/.Huawei/Emulator/deployed",
    "foldServerScript": "/Users/zzz/robot/one2many-case/folded-case-01/fold-control-tool/fold-server.py"
  },
  "devices": [
    {
      "id": "phone",
      "profile": "Mate 80 Pro",
      "target": "127.0.0.1:15001",
      "hdcPort": 15001,
      "startEmulator": true,
      "testSuites": ["CommonPassToPassTest", "SmPassToPassTest"]
    },
    {
      "id": "foldable",
      "profile": "Mate X7",
      "target": "127.0.0.1:15002",
      "hdcPort": 15002,
      "startEmulator": true,
      "foldControl": true,
      "testSuites": ["CommonPassToPassTest", "SmPassToPassTest", "MdFailToPassTest"]
    },
    {
      "id": "tablet",
      "profile": "MatePad Pro 13",
      "target": "127.0.0.1:15003",
      "hdcPort": 15003,
      "startEmulator": true,
      "testSuites": ["CommonPassToPassTest", "LgFailToPassTest"]
    }
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add src/result.ts config/machine.json
git commit -m "feat: add fold info to summary and enable foldable device config"
```

---

### Task 8: Write Tests for fold.ts

**Files:**
- Create: `tests/fold.test.ts`

- [ ] **Step 1: Write tests for port allocation and template generation**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { foldTriggerTemplate } from "../src/fold-template.js";

describe("foldTriggerTemplate", () => {
  it("embeds devicePort in the generated template", () => {
    const template = foldTriggerTemplate(8765);
    assert.ok(template.includes("const FOLD_SERVER_PORT = 8765"));
  });

  it("includes triggerFold export", () => {
    const template = foldTriggerTemplate(8765);
    assert.ok(template.includes("export async function triggerFold"));
  });

  it("includes triggerRotation export", () => {
    const template = foldTriggerTemplate(8765);
    assert.ok(template.includes("export async function triggerRotation"));
  });

  it("includes triggerLandscapeHover export", () => {
    const template = foldTriggerTemplate(8765);
    assert.ok(template.includes("export async function triggerLandscapeHover"));
  });

  it("includes sleep export", () => {
    const template = foldTriggerTemplate(8765);
    assert.ok(template.includes("export function sleep"));
  });

  it("contains no placeholder after injection", () => {
    const template = foldTriggerTemplate(8765);
    assert.ok(!template.includes("__FOLD_PORT__"));
  });

  it("different ports produce different templates", () => {
    const t1 = foldTriggerTemplate(8765);
    const t2 = foldTriggerTemplate(8766);
    assert.notStrictEqual(t1, t2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

```bash
node --import tsx --test tests/fold.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add tests/fold.test.ts
git commit -m "test: add fold template unit tests"
```

---

### Task 9: Run Full Test Suite and Fix Issues

**Files:**
- Potentially any

- [ ] **Step 1: Run all existing tests**

```bash
npm test
```

Expected: All existing tests pass.

- [ ] **Step 2: Verify TypeScript compilation**

```bash
npm run build
```

Expected: Clean compilation, no type errors.

- [ ] **Step 3: Fix any issues found and commit**

```bash
git add -A
git commit -m "fix: resolve issues from full test suite run"
```

---

### Task 10: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add fold control documentation section**

Add after the "设备矩阵配置" section:

```markdown
## 折叠屏控制（可选）

如果测试矩阵中包含折叠屏设备，runner 可以自动管理折叠屏模拟器的折叠/旋转状态。

### 配置

在 `machine.json` 中：

- `paths.foldServerScript`：fold-server.py 的路径（必填，如果设备启用了 foldControl）
- `devices[].foldControl`：布尔值（默认 false），标记该设备是否需要折叠控制

runner 会为每个 foldControl 设备自动：
1. 启动独立的 fold-server 实例（自动分配端口）
2. 将 `FoldTrigger.ets` 部署到目标工程的 `ohosTest/ets/util/` 目录
3. 测试结束后停止 fold-server

### 测试用例调用

```typescript
import { triggerFold, triggerLandscapeHover, sleep } from '../util/FoldTrigger';

// 展开
await triggerFold('open', 3000);
// 折叠
await triggerFold('close', 4000);
// 悬停
await triggerFold('half-open', 3000);
// 悬停态校正到横屏
await triggerLandscapeHover(driver);
// 等待布局稳定
await sleep(1000);
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add fold control integration usage to README"
```
