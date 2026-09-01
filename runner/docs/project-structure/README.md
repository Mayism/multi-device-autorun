# 工程结构说明

`harmonyos-ohostest-runner/src` 按功能分为四个区域：case 执行、矩阵测试执行、折叠屏处理、共享基础能力。

```text
src/                              # 源码根目录
  index.ts                        # 包级公共出口，导出 CLI 解析、case API、矩阵 API 和公共类型
  cli/                            # 命令行参数解析
    parseArgs.ts                  # 解析 ohostest:matrix 参数，生成 RunMatrixInput
    parseCaseArgs.ts              # 解析 ohostest:case 参数，生成 RunCaseInput
  case/                           # case 目录执行
    config.ts                     # 读取 metadata.json，解析 patch、设备 suite 和 case 元信息
    patch.ts                      # 复制基线工程并执行 git apply
    result.ts                     # 生成 case 状态和 case 级 summary.md
    runner.ts                     # 编排 base + test_patch 与 base + test_patch + golden_patch 两轮执行
    types/                        # case 相关类型
      index.ts                    # RunCaseInput、CaseMetadata、CaseResult 等类型
  matrix/                         # 单工程矩阵测试执行
    build.ts                      # 构建 app HAP 和 ohosTest HAP，并校验产物
    config.ts                     # 读取 machine.json，发现工程信息，生成 MatrixConfig
    device.ts                     # 处理模拟器启停、hdc 连接、唤醒、安装和设备日志
    ohostest.ts                   # 构造 aa test 命令并解析 OHOS_REPORT_* 输出
    result.ts                     # 生成矩阵状态和矩阵 summary.md
    runner.ts                     # 编排构建、设备循环、suite 执行和矩阵结果写入
    types/                        # 矩阵相关类型
      index.ts                    # MatrixConfig、MatrixResult、DeviceRunResult、SuiteRunResult 等类型
    utils/                        # 矩阵辅助工具
      json5ish.ts                 # 解析 HarmonyOS 配置中的 JSON5 风格文本
      projectDiscovery.ts         # 发现 product、entry module、bundle、test module 和 HAP 路径
  fold/                           # 折叠屏和旋转控制
    server.ts                     # 导出受管生命周期、健康检查和 FoldTrigger 部署接口
    resourceManager.ts            # 管理 fold-server 进程、端口、转发和残留恢复
    forwarding.ts                 # 构造带 target 的跨平台 HDC 转发命令
    state.ts                      # 原子保存 target 级 fold-server 状态
    foldTriggerTemplate.ts        # 生成注入端口后的 FoldTrigger.ets 内容
    assets/                       # 折叠屏控制运行资产
      FoldTrigger.ets             # 设备端折叠/旋转触发工具源码
      fold-server.py              # 宿主机 HTTP 服务，调用 DevEco Emulator 命令
    types/                        # 折叠屏控制类型
    utils/                        # 折叠屏控制辅助工具
      healthCheck.ts              # 校验 fold-server 健康状态和 owner token
      ports.ts                    # 查找可用宿主机/设备端口对
  shared/                         # 共享基础能力
    command.ts                    # 命令执行、detached 进程启动和命令日志记录
    types/                        # 共享类型
      command.ts                  # CommandExecutor 和 CommandResult 类型
      index.ts                    # 共享类型出口
    utils/                        # 共享工具
      file.ts                     # 文件存在性校验
      names.ts                    # 日志文件名等名称清洗
      shellQuote.ts               # 跨平台 shell 参数转义
      sleep.ts                    # 异步等待工具
```



## 调用关系

```text
scripts/runOhosTestMatrix.ts
  -> src/index.ts
  -> cli/parseArgs.ts
  -> matrix/runner.ts
     -> matrix/config.ts
     -> matrix/build.ts
     -> matrix/device.ts
     -> matrix/ohostest.ts
     -> matrix/result.ts
     -> fold/server.ts
     -> shared/command.ts

scripts/runOhosTestCase.ts
  -> src/index.ts
  -> cli/parseCaseArgs.ts
  -> case/runner.ts
     -> case/config.ts
     -> case/patch.ts
     -> case/result.ts
     -> matrix/config.ts
     -> matrix/runner.ts
```

case 执行调用矩阵执行。折叠屏处理是矩阵执行中按设备启用的能力。共享层不依赖 `case/`、`matrix/` 或 `fold/`。
