# fold-control-tool 多设备整合设计

## 目标

将 `fold-control-tool`（折叠屏模拟器折叠/旋转控制工具）融入 `harmonyos-ohostest-runner`，
实现 runner 自动管理 fold-server 生命周期 + 自动部署设备端工具。

## 整合范围

两端都整合：

- **服务端**：runner 管理 fold-server.py 的启动/停止，支持多设备（每设备独立实例/端口）
- **设备端**：runner 自动将 FoldTrigger.ets 部署到目标 HarmonyOS 工程的 ohosTest 目录

## 配置扩展

### paths 层级
`config/machine.json` 的 `paths` 新增 `foldServerScript`：

```json
{
  "paths": {
    "foldServerScript": "/path/to/fold-control-tool/fold-server.py"
  }
}
```

### device 层级
每个 device 新增可选字段 `foldControl`（默认 false）：

```json
{
  "devices": [
    {
      "id": "foldable",
      "foldControl": true
    }
  ]
}
```

### 端口
fold-server 端口由 runner 自动分配，起始 8766，每设备递增。设备内访问端口 = 宿主机端口 - 1。

## 新增模块：src/fold.ts

### FoldServerInstance
```typescript
interface FoldServerInstance {
  port: number;        // 宿主机端口
  devicePort: number;  // 设备内访问端口
  process: ChildProcess;
}
```

### FoldManager API
- `start(device, foldServerScript)` → 启动 fold-server.py detached 子进程，传入 `--profile` 和 `--port` 参数
- `stop(instance)` → kill 进程 + `hdc fport rm` 清理转发
- `healthCheck(port)` → GET /health 轮询检测，最多 10 秒
- `deployFoldTrigger(projectPath, devicePort)` → 复制模板到 `<project>/<entry>/src/ohosTest/ets/util/`，替换端口占位符

### fold-server.py 改造
- 新增 `--port` CLI 参数指定监听端口（替代硬编码的 8766）
- DEVICE_PORT = PORT - 1

## Runner 集成

`runDevice()` 中插入 fold-server 生命周期：

```
if foldControl:
  FoldManager.start() + healthCheck
  FoldManager.deployFoldTrigger()
installHaps()
runSuites()
if foldControl:
  FoldManager.stop()
```

## FoldTrigger.ets 模板

内嵌到 runner 源码中，端口使用 `__FOLD_PORT__` 占位符，部署时替换。

## 错误处理

- fold-server 启动失败 → blocked，reason = `fold_server_start_failed`
- 健康检查超时 → 同上
- 中途崩溃 → 不阻塞，记录到 device log
- FoldTrigger.ets 已存在 → 默认跳过

## 类型扩展

- `DeviceConfig` 新增 `foldControl?: boolean`
- `MatrixConfig.paths` 新增 `foldServerScript?: string`
- `BlockedReason` 新增 `"fold_server_start_failed"`
- `DeviceRunResult` 新增 `foldServerPort?: number`

## 测试

新增 `tests/fold.test.ts`：端口分配、命令构建、模板替换、健康检查 mock。
