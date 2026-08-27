# 隐藏 DevEco 模拟器（Emulator.exe）的可见主窗口。
# 模拟器为 Qt/GLFW GUI 程序，主动创建可见窗口且不读取 STARTUPINFO 的显示状态，
# 因此无法通过进程创建参数隐藏，只能在窗口创建后调用 Win32 ShowWindow(SW_HIDE)。
#
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File hide-emulator-windows.ps1
# 输出: 本次成功隐藏的窗口数（0 表示当前没有可见窗口，模拟器启动早期属正常情况）。

$signature = @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@
Add-Type -MemberDefinition $signature -Name NativeMethods -Namespace EmulatorHide

$hidden = 0
Get-Process -Name Emulator -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
  ForEach-Object {
    if ([EmulatorHide.NativeMethods]::ShowWindow($_.MainWindowHandle, 0)) {
      $hidden += 1
    }
  }
Write-Output $hidden
