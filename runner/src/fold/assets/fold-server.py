#!/usr/bin/env python3
#
# 折叠屏测试 - 宿主机折叠控制 HTTP 服务（支持 Mac/Windows）
#
# 功能：监听 HTTP 请求，收到折叠指令后执行 Emulator 命令切换折叠状态。
#       测试代码内的 triggerFold() 通过 HTTP 直接调用本服务，同步等待结果。
#
# 用法：
#   python3 src/fold/assets/fold-server.py
#   python3 src/fold/assets/fold-server.py --profile "Mate X7" --port 8766 --target 127.0.0.1:15002
#
#   保持运行，测试代码的 triggerFold('half-open') 会请求本服务。
#
# API：
#   GET /fold?state=half-open        切换折叠状态
#   GET /rotation?direction=left     旋转屏幕
#   GET /health                      健康检查
#

import argparse
import http.server
import json
import subprocess
import os
import socket
import platform
import signal

# ============ 配置 ============
# fold-server 监听端口（宿主机）
PORT = 8766
# 设备内访问端口（模拟器内 FoldTrigger 访问的端口，通过 rport 转发到 PORT）
# 用不同端口避免与 fold-server 监听冲突
DEVICE_PORT = 8765

def find_deveco_root():
    """自动探测 DevEco Studio 安装根目录（不写死路径）"""
    candidates = []

    # 1. 环境变量（最可靠）
    for env_var in ["DEVECO_SDK_HOME", "DEVECO_HOME", "HOS_SDK_HOME"]:
        val = os.environ.get(env_var, "")
        if val:
            candidates.append(val)
            # DEVECO_SDK_HOME 通常指向 sdk 目录，父目录可能是 DevEco 根
            candidates.append(os.path.dirname(val))

    if platform.system() == "Windows":
        # 2. Windows 常见安装位置（扫描盘符 + Program Files）
        for drive in ["C", "D", "E"]:
            candidates.extend([
                f"{drive}:\\Program Files\\Huawei\\DevEco Studio",
                f"{drive}:\\Program Files (x86)\\Huawei\\DevEco Studio",
            ])
        # 3. 用户目录、环境变量 USERPROFILE
        userprofile = os.environ.get("USERPROFILE", "")
        if userprofile:
            candidates.append(os.path.join(userprofile, "AppData", "Local", "Huawei", "DevEco Studio"))

        # 4. 从 PATH 找 deveco/studio 相关
        path_dirs = os.environ.get("PATH", "").split(os.pathsep)
        for d in path_dirs:
            if "deveco" in d.lower() or "huawei" in d.lower():
                # PATH 里的可能是 bin/子目录，往上找根
                candidates.append(os.path.dirname(os.path.dirname(d)))
                candidates.append(os.path.dirname(d))
    else:
        # Mac
        candidates.extend([
            "/Applications/DevEco-Studio.app/Contents",
            os.path.join(os.environ.get("HOME", ""), "Applications/DevEco-Studio.app/Contents"),
        ])

    # 验证候选，找到包含 emulator 或 sdk 的有效根目录
    for c in candidates:
        if not c or not os.path.isdir(c):
            continue
        # 验证：DevEco 根目录下应有 tools/emulator 或 sdk
        if os.path.isdir(os.path.join(c, "tools", "emulator")) or \
           os.path.isdir(os.path.join(c, "sdk")) or \
           os.path.isdir(os.path.join(c, "Contents")):
            return c
    return None


def find_emulator():
    """自动探测 emulator 路径（不写死）"""
    # emulator 二进制名
    exe_name = "emulator.exe" if platform.system() == "Windows" else "Emulator"

    # 候选路径
    candidates = []

    # 1. 从 DevEco 根目录找
    deveco_root = find_deveco_root()
    if deveco_root:
        candidates.extend([
            os.path.join(deveco_root, "tools", "emulator", exe_name),
            os.path.join(deveco_root, "Contents", "tools", "emulator", exe_name),
            os.path.join(deveco_root, "sdk", "tools", "emulator", exe_name),
        ])

    # 2. 环境变量 EMULATOR_PATH 直接指定
    env_path = os.environ.get("EMULATOR_PATH", "")
    if env_path:
        candidates.append(env_path)

    # 3. PATH 里找
    path_dirs = os.environ.get("PATH", "").split(os.pathsep)
    for d in path_dirs:
        candidates.append(os.path.join(d, exe_name))

    # 验证
    for c in candidates:
        if c and os.path.isfile(c):
            return c

    print(f"  [!] 找不到 emulator，请设置 EMULATOR_PATH 环境变量")
    return exe_name  # 兜底，让命令失败时报错


def find_hdc():
    """自动探测 hdc 路径（不写死）"""
    exe_name = "hdc.exe" if platform.system() == "Windows" else "hdc"

    candidates = []

    # 1. 从 DevEco 根目录找（sdk/default/openharmony/toolchains/hdc）
    deveco_root = find_deveco_root()
    if deveco_root:
        candidates.extend([
            os.path.join(deveco_root, "sdk", "default", "openharmony", "toolchains", exe_name),
            os.path.join(deveco_root, "Contents", "sdk", "default", "openharmony", "toolchains", exe_name),
            os.path.join(deveco_root, "sdk", "openharmony", "toolchains", exe_name),
        ])

    # 2. 环境变量 HDC_PATH 直接指定
    env_path = os.environ.get("HDC_PATH", "")
    if env_path:
        candidates.append(env_path)
        candidates.append(os.path.join(env_path, exe_name))

    # 3. PATH 里找
    path_dirs = os.environ.get("PATH", "").split(os.pathsep)
    for d in path_dirs:
        candidates.append(os.path.join(d, exe_name))

    # 验证
    for c in candidates:
        if c and os.path.isfile(c):
            return c

    return exe_name  # 兜底：假设在 PATH 里

EMULATOR = find_emulator()
HDC = find_hdc()
EMULATOR_INSTANCE = os.environ.get("EMULATOR_INSTANCE", "Mate X7")
OWNER_TOKEN = ""

# 启动时打印探测到的路径（方便排查）
def print_paths():
    print(f"  路径探测:")
    print(f"    DevEco 根目录: {find_deveco_root() or '未找到（用环境变量 DEVECO_SDK_HOME 指定）'}")
    print(f"    Emulator: {EMULATOR}{'  [ok]' if os.path.isfile(EMULATOR) else '  [x] 未找到'}")
    print(f"    hdc: {HDC}{'  [ok]' if os.path.isfile(HDC) else '  （用 PATH 兜底）'}")


def setup_fport(target=None):
    """建立 hdc 反向端口转发（rport）：模拟器内访问 127.0.0.1:DEVICE_PORT → 宿主机:PORT
    用不同端口避免与 fold-server 监听冲突。
    所有平台通用，模拟器内统一用 127.0.0.1 访问本服务。
    
    target: hdc target 地址（如 127.0.0.1:5555），多设备时必须指定。"""
    try:
        hdc_base = [HDC]
        if target:
            hdc_base.extend(["-t", target])

        # 确认 hdc 可用
        check = run_command(hdc_base + ["version"], timeout=5)
        if check.returncode != 0:
            print(f"  [x] hdc 不可用: {HDC}")
            print(f"    错误: {check.stderr}")
            return False

        # 清除可能存在的旧转发
        for cmd_rm in [
            f'fport rm tcp:{DEVICE_PORT} tcp:{PORT}',
            f'fport rm tcp:{DEVICE_PORT} tcp:{DEVICE_PORT}',
            f'fport rm tcp:{PORT} tcp:{DEVICE_PORT}',
        ]:
            rm_cmd = hdc_base + cmd_rm.split()
            run_command(rm_cmd, timeout=5)

        # 建立 rport（设备内 DEVICE_PORT → 宿主机 PORT）
        cmd_rport = f'rport tcp:{DEVICE_PORT} tcp:{PORT}'
        rport_cmd = hdc_base + cmd_rport.split()
        result = run_command(rport_cmd, timeout=5)

        output = (result.stdout or "") + (result.stderr or "")
        if "OK" in output:
            target_info = f" (target={target})" if target else ""
            print(f"  [ok] hdc 反向端口转发已建立（rport: 模拟器内 127.0.0.1:{DEVICE_PORT} → 宿主机:{PORT}{target_info}）")
            return True
        else:
            print(f"  [x] hdc rport 建立失败: {output}")
            target_hint = f"hdc -t {target} list target" if target else "hdc list target"
            print(f"    请确认模拟器已连接：{target_hint}")
            return False
    except FileNotFoundError:
        print(f"  [x] 找不到 hdc: {HDC}")
        print(f"    请设置 HDC_PATH 环境变量指向 hdc.exe/hdc 的路径")
        return False
    except Exception as e:
        print(f"  [x] 建立端口转发异常: {e}")
        return False


def cleanup_fport(target=None):
    """幂等删除当前实例创建的反向端口转发。"""
    hdc_base = [HDC]
    if target:
        hdc_base.extend(["-t", target])
    try:
        result = run_command(
            hdc_base + ["fport", "rm", f"tcp:{DEVICE_PORT}", f"tcp:{PORT}"],
            timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


def run_command(command, timeout):
    """使用参数数组执行命令，兼容 Windows 空格路径并避免 shell 拼接。"""
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
    )

# 允许的折叠状态
VALID_STATES = {"open", "half-open", "close"}

# 允许的旋转方向
VALID_ROTATIONS = {"left", "right"}


def do_fold(state):
    """执行 Emulator 折叠命令"""
    try:
        result = run_command(
            [EMULATOR, "-instance", EMULATOR_INSTANCE, "-foldedState", state],
            timeout=10,
        )
        output = (result.stdout or "") + (result.stderr or "")
        success = "success" in output
        if not success:
            # 打印完整输出便于排查
            print(f"    emulator 返回码: {result.returncode}")
            print(f"    emulator stdout: '{result.stdout}'")
            print(f"    emulator stderr: '{result.stderr}'")
        return success, output.strip()
    except Exception as e:
        return False, str(e)


def do_rotation(direction):
    """执行 Emulator 旋转命令"""
    try:
        result = run_command(
            [EMULATOR, "-instance", EMULATOR_INSTANCE, "-rotation", direction],
            timeout=10,
        )
        output = (result.stdout or "") + (result.stderr or "")
        success = "success" in output
        if not success:
            print(f"    emulator 返回码: {result.returncode}")
            print(f"    emulator stdout: '{result.stdout}'")
            print(f"    emulator stderr: '{result.stderr}'")
        return success, output.strip()
    except Exception as e:
        return False, str(e)


class FoldHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        query = parse_qs(urlparse(self.path).query)

        # 折叠控制
        if self.path.startswith("/fold?"):
            state = query.get("state", [None])[0]
            if state not in VALID_STATES:
                self._respond(400, {"success": False, "error": f"无效状态: {state}"})
                return
            print(f"[{self.log_date_time_string()}] 触发折叠 → {state}")
            success, msg = do_fold(state)
            if success:
                print(f"  [ok] 已切换到 {state}")
            else:
                print(f"  [x] 切换失败: {msg}")
            self._respond(200, {"success": success, "state": state, "message": msg})

        # 旋转控制
        elif self.path.startswith("/rotation?"):
            direction = query.get("direction", [None])[0]
            if direction not in VALID_ROTATIONS:
                self._respond(400, {"success": False, "error": f"无效方向: {direction}"})
                return
            print(f"[{self.log_date_time_string()}] 触发旋转 → {direction}")
            success, msg = do_rotation(direction)
            if success:
                print(f"  [ok] 已旋转 {direction}")
            else:
                print(f"  [x] 旋转失败: {msg}")
            self._respond(200, {"success": success, "direction": direction, "message": msg})

        elif self.path == "/health":
            payload = {"status": "ok"}
            if OWNER_TOKEN:
                payload["ownerToken"] = OWNER_TOKEN
            self._respond(200, payload)
        else:
            self._respond(404, {"error": "unknown endpoint"})

    def _respond(self, code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # 静默默认日志，用自定义 print


def get_local_ips():
    """获取本机所有 IPv4 地址，方便模拟器连接"""
    ips = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    return ips


def main():
    global EMULATOR_INSTANCE, PORT, DEVICE_PORT, OWNER_TOKEN
    parser = argparse.ArgumentParser(description="Fold control HTTP server")
    parser.add_argument(
        "--profile",
        default=os.environ.get("EMULATOR_INSTANCE", "Mate X7"),
        help="Emulator instance name (default: Mate X7)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8766,
        help="HTTP server listen port (default: 8766)",
    )
    parser.add_argument(
        "--target",
        default=None,
        help="hdc target address (e.g. 127.0.0.1:5555). Required when multiple devices are connected.",
    )
    parser.add_argument(
        "--forwarding",
        choices=["self", "external"],
        default="self",
        help="Port forwarding owner (default: self)",
    )
    parser.add_argument(
        "--owner-token",
        default="",
        help="Runner owner token returned by /health in external mode",
    )
    args = parser.parse_args()
    if args.forwarding == "external" and not args.owner_token:
        parser.error("--owner-token is required when --forwarding external")
    EMULATOR_INSTANCE = args.profile
    PORT = args.port
    DEVICE_PORT = args.port - 1
    TARGET = args.target
    OWNER_TOKEN = args.owner_token

    print("=" * 50)
    print(f"折叠控制 HTTP 服务启动")
    print(f"  平台: {platform.system()}")
    print(f"  Emulator: {EMULATOR}")
    print(f"  hdc: {HDC}")
    print(f"  模拟器实例: {EMULATOR_INSTANCE}")
    print(f"  监听端口: {PORT}")
    print(f"")

    # 先绑定端口再建立 hdc 转发，避免端口冲突时误清除 rport
    server = http.server.HTTPServer(("0.0.0.0", PORT), FoldHandler)
    print(f"  [ok] HTTP 服务已绑定 0.0.0.0:{PORT}")

    def handle_termination(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, handle_termination)
    try:
        if args.forwarding == "self":
            print("  建立 hdc 端口转发...")
            if not setup_fport(TARGET):
                raise SystemExit(1)
        else:
            print("  hdc 端口转发由 runner 管理")

        print(f"")
        print(f"  连接方式: 模拟器内访问 127.0.0.1:{DEVICE_PORT}（通过 rport 转发到本服务）")
        print(f"  API: GET /fold?state=open|half-open|close")
        print(f"  API: GET /rotation?direction=left|right")
        print(f"  按 Ctrl+C 停止")
        print("=" * 50)

        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
    finally:
        if args.forwarding == "self":
            cleanup_fport(TARGET)
        server.server_close()


if __name__ == "__main__":
    main()
