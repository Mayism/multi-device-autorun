# Windows Web 进程控制

仅用于 Windows 上由 Runner 启动的 Web 安装命令和开发服务。macOS/Linux 不加载此模块，继续使用 Node 的 detached 进程组及 SIGTERM/SIGKILL；普通 `npm install` / TypeScript 构建均不编译此目录。

## 使用与部署

- 保留本目录与 Runner 的 `src` 或 `dist` 同级，或放在部署后 `dist/native/windows-job`。只复制 JavaScript 文件会导致 Windows Web 启动失败。
- `prebuilds/win32-{x64,arm64,ia32}/web-job.node` 按 **Node 进程架构**选择，使用稳定 Node-API v8，不需要用户安装 C 编译器或 node-gyp。
- 原生接口要求 Windows 10 / Windows Server 2016 或更新版本。构建、加载、Job 创建或关联失败时拒绝启动，不回退到不受控进程。错误保留 Win32 数字错误码。
- 当前在 Windows x64 / Node 24.18.0 实测；ARM64、ia32 仅交叉编译及 PE 文件检查，尚未在对应 Node 进程中运行。macOS/Linux 目前只有分支回归，尚无真实主机验证。

## 所有权与结束语义

每次安装或启动命令独占一个未命名 Job。Runner 直接持有不可继承的句柄，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不给予 breakaway 权限。`CreateProcessW` 通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建时关联 Job，消除先启动再绑定之间的窗口；仅传递标准输入和日志句柄。

npm 根进程退出与整组清空分别记录。根进程退出后仍保留 Job，结束阶段调用 `TerminateJobObject`，等待 Job 活跃进程数归零且根进程句柄已退出，再关闭句柄。超时或 API 错误向上抛出，保留句柄以便重试；不会按端口或进程名杀其他服务。服务层另行检查端口释放。

Runner 正常退出、崩溃或被强杀时，系统关闭其唯一 Job 句柄并终止成员进程。该机制覆盖普通进程创建链及 detached 子进程；不把通过 UAC、WMI、系统服务等外部代理另行启动的程序视为 Job 成员，也不承诺绕过操作系统限制。Windows 强制终止不执行服务的退出钩子。

## 重新构建

预编译文件由 Zig **0.15.2** 的 C 编译器生成。`include/` 中四个未修改的头文件来自 [Node.js v22.15.0](https://github.com/nodejs/node/tree/v22.15.0/src)，许可证见 `include/LICENSE`。编译器运行库许可证见 `licenses/`。源码、头文件及产物 SHA-256 和 PE 导入/导出检查记录在 `manifest.json`。

在 PowerShell 中从 Runner 根目录执行，编译器和缓存路径可指向本地工作区：

```powershell
./native/windows-job/build.ps1 -Zig '路径/zig.exe' -Architecture x64 -CacheDirectory '路径/zig-cache'
./native/windows-job/build.ps1 -Zig '路径/zig.exe' -Architecture arm64 -CacheDirectory '路径/zig-cache'
./native/windows-job/build.ps1 -Zig '路径/zig.exe' -Architecture ia32 -CacheDirectory '路径/zig-cache'
```

测试文件：`tests/windows-web-job.test.ts`（真实 Windows 进程）、`tests/web-process-platform.test.ts`（非 Windows 分支与参数编码）、`tests/web-service.test.ts`（npm 生命周期）。更新源码后应重新生成三份二进制及 manifest，并在 x64 上完成测试；其它架构的编译不等同于运行验证。

## 系统接口依据

- [Job Objects：成员继承与关闭句柄终止](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [UpdateProcThreadAttribute：JOB_LIST 与 HANDLE_LIST](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
- [Node-API 稳定 ABI](https://nodejs.org/api/n-api.html)
