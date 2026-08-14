# 折叠屏和旋转控制

runner 支持自动管理模拟器的折叠/旋转状态。折叠命令仅折叠屏设备可用，旋转命令所有设备可用。

## 组件

```text
测试用例
  -> FoldTrigger.ets
  -> HTTP
  -> hdc rport
  -> fold-server.py
  -> Emulator 命令
```

相关文件：

- `src/fold/assets/fold-server.py`：宿主机 HTTP 服务
- `src/fold/assets/FoldTrigger.ets`：设备端工具文件
- `src/fold/foldTriggerTemplate.ts`：runner 自动部署时使用的模板
- `src/fold/resourceManager.ts`：runner 管理端口、进程、转发和残留恢复
- `src/fold/state.ts`：按 HDC 路径和 target 保存受管实例状态

## 设备矩阵配置

在 Autorun 的 `ohosTest` 配置（或直接运行 Runner 时传入的设备矩阵文件）中标记需要控制的设备：

```json
{
  "paths": {
    "hvigorw": "/path/to/hvigorw",
    "hdc": "/path/to/hdc",
    "emulatorBin": "/path/to/Emulator",
    "emulatorDeployedDir": "/path/to/.Huawei/Emulator/deployed",
    "foldServerScript": "src/fold/assets/fold-server.py"
  },
  "devices": [
    {
      "id": "foldable",
      "profile": "Mate X7",
      "target": "127.0.0.1:5555",
      "startEmulator": false,
      "foldControl": true,
      "testSuites": ["CommonPassToPassTest", "FoldControlTest"]
    }
  ]
}
```

关键字段：

| 字段 | 说明 |
|------|------|
| `paths.foldServerScript` | fold-server.py 路径 |
| `devices[].profile` | 模拟器实例名，必须与 `~/.Huawei/Emulator/deployed/` 下的目录名一致 |
| `devices[].target` | hdc 连接地址，必须与 `hdc list targets` 输出一致 |
| `devices[].foldControl` | `true` 表示该设备启用折叠/旋转控制 |
| `devices[].testSuites` | 要执行的 suite class 列表，包含折叠测试时加入 `FoldControlTest` |

## 部署 FoldTrigger.ets

手动复制：

```bash
cp src/fold/assets/FoldTrigger.ets /path/to/your-project/<module>/src/ohosTest/ets/util/FoldTrigger.ets
```

使用部署脚本：

```bash
npm run deploy:fold -- --project /path/to/your-project
npm run deploy:fold -- --project /path/to/your-project --port 8765 --module products/entry
```

runner 自动部署：

当设备配置了 `foldControl: true` 时，runner 在运行测试前会自动部署 `FoldTrigger.ets`，并重建测试 HAP。

自动部署需要在工程里注册测试文件。在 `<module>/src/ohosTest/ets/test/List.test.ets` 中导入并调用：

```typescript
import foldTest from './FoldAbility.test';

export default function testsuite() {
  foldTest();
}
```

## 测试用例示例

在 `<module>/src/ohosTest/ets/test/` 下创建测试文件：

```typescript
import { describe, beforeAll, afterAll, it, expect } from '@ohos/hypium';
import { Driver } from '@kit.TestKit';
import { triggerFold, triggerRotation, sleep } from '../util/FoldTrigger';

export default function foldTest() {
  describe('FoldControlTest', () => {
    let driver: Driver | undefined;

    beforeAll(async () => {
      driver = Driver.create();
    });

    afterAll(async () => {
      driver = undefined;
    });

    it('trigger_rotation_left', 0, async () => {
      await triggerRotation('left', 2000);
      expect(true).assertTrue();
    });

    it('trigger_rotation_right', 0, async () => {
      await triggerRotation('right', 2000);
      expect(true).assertTrue();
    });

    it('trigger_fold_open', 0, async () => {
      await triggerFold('open', 3000);
      expect(true).assertTrue();
    });

    it('trigger_fold_half_open', 0, async () => {
      await triggerFold('half-open', 3000);
      expect(true).assertTrue();
    });

    it('trigger_fold_close', 0, async () => {
      await triggerFold('close', 3000);
      expect(true).assertTrue();
    });
  });
}
```

## API

```typescript
import { triggerFold, triggerRotation, triggerLandscapeHover, sleep } from '../util/FoldTrigger';

await triggerRotation('left', 2000);
await triggerRotation('right', 2000);

await triggerFold('open', 3000);
await triggerFold('close', 4000);
await triggerFold('half-open', 3000);

await triggerLandscapeHover(driver);
await sleep(1000);
```

| 方法 | 参数 | 说明 | 适用设备 |
|------|------|------|----------|
| `triggerRotation` | `direction: 'left' \| 'right'`, `waitAfter?: number` | 旋转屏幕 | 所有设备 |
| `triggerFold` | `state: 'open' \| 'close' \| 'half-open'`, `waitAfter?: number` | 切换折叠状态 | 折叠屏 |
| `triggerLandscapeHover` | `driver: Driver` | 半折态校正到横屏 | 折叠屏 |
| `sleep` | `ms: number` | 等待指定毫秒 | 所有设备 |

## 自动管理流程

runner 为每个 `foldControl: true` 的设备自动：

1. 根据 HDC 路径和设备 target 读取系统临时目录中的状态文件，恢复上次异常中断遗留的进程和转发
2. 从宿主机端口 `8766`、设备内端口 `8765` 开始查找端口对，最多尝试 100 对
3. 以 `--forwarding external` 启动 fold-server，并使用随机 owner token 校验 `/health`，避免误连到旧服务
4. 使用带 `-t <target>` 的 HDC 命令建立反向转发；建立失败时回滚当前实例并尝试下一端口对
5. 部署 `FoldTrigger.ets`、重建测试 HAP、安装产物并执行测试套件
6. 先保存测试结果，再删除并验证 HDC 转发、停止 fold-server、等待宿主机端口关闭并删除状态文件
7. fold 资源清理完成后，才停止模拟器或进入下一台设备、SWE/Answer 阶段

端口信息记录在 `result.json` 的 `devices[].foldServerPort` 和 `summary.md` 的设备详情中。

候选端口对：

| 尝试顺序 | 宿主机端口 | 设备内端口 |
|----------|------------|------------|
| 第 1 对 | 8766 | 8765 |
| 第 2 对 | 8767 | 8766 |
| 第 3 对 | 8768 | 8767 |

设备和阶段串行执行。上一实例完整释放后，下一实例可以重新使用第一对端口；若宿主机端口已被占用或 HDC 转发冲突，则继续尝试下一对。

状态文件只属于相同的 `HDC 路径 + target`。恢复时，仅当 `/health` 返回的 owner token 与状态文件一致时才会结束旧进程；如果端口已被其他服务占用，runner 不会误杀该服务，而是将设备标记为 `blocked`，阻断原因是 `fold_cleanup_failed`。清理失败不会丢弃已经生成的 suite 和 test 统计，且优先于其他阻断原因。

## 独立运行 fold-server.py

直接运行 Python 脚本时，默认使用 `self` 模式，由脚本建立和释放 HDC 转发：

```bash
python3 src/fold/assets/fold-server.py \
  --profile "Mate X7" \
  --port 8766 \
  --target 127.0.0.1:5555
```

也可显式指定 `--forwarding self`。转发建立失败时脚本直接退出；正常退出、Ctrl+C 或服务异常时都会在统一清理流程中删除转发。

`external` 是 runner 的受管模式，转发由 TypeScript runner 负责，必须同时提供 owner token：

```bash
python3 src/fold/assets/fold-server.py \
  --profile "Mate X7" \
  --port 8766 \
  --target 127.0.0.1:5555 \
  --forwarding external \
  --owner-token <random-token>
```

Windows 可将 `python3` 替换为 `python`。HDC、Emulator 和包含空格的可执行文件路径均按参数数组执行，target 会完整保留。
