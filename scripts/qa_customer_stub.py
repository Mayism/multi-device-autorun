"""Local customer-service protocol fixture; never reads evaluation answers."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from uuid import uuid4


def answer_question(question):
    # Fixed developer-support fixtures; never load the dataset or reference answers.
    if '首选项' in question:
        return 'XML 模式的 put 修改缓存，需调用 flush 将缓存数据保存到持久化文件，异步调用应处理完成和失败。GSKV 模式下数据操作会实时落盘，无需调用 flush；不能把 XML 的 flush 要求无条件套用于 GSKV。'
    if '@Prop' in question:
        return '@Prop 与父组件建立单向同步：父组件状态变化会更新对应子组件 @Prop；子组件对 @Prop 的修改只在子组件内部生效，不反向修改父组件。适合需要响应父状态、又需要局部修改而不回传的 V1 子组件场景。'
    if 'setWindowLayoutFullScreen' in question:
        return 'setWindowLayoutFullScreen 控制沉浸式布局和系统栏区域避让，不等同于隐藏系统栏。主窗口系统栏可见性使用 setWindowSystemBarEnable；当前文档说明通过 status 控制，navigation 参数无效果。接口返回不表示显示或隐藏动画已经完成；主窗口在非全屏/最大化模式下配置不生效，进入相应模式后才生效，具体设备差异以文档为准。'
    return '请描述你遇到的 HarmonyOS 开发问题。'


class CustomerServiceHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self.respond(200, {'status': 'ok', 'mode': self.server.stub_mode})
        else:
            self.respond(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/answer':
            self.respond(404, {'error': 'not found'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 65536:
                raise ValueError('invalid request size')
            payload = json.loads(self.rfile.read(size))
            question = payload.get('question')
            if not isinstance(question, str) or not question.strip():
                raise ValueError('question must be a nonempty string')
        except (ValueError, TypeError, AttributeError):
            self.respond(400, {'error': 'expected JSON object with a question string'})
            return
        if self.server.stub_mode == 'error':
            self.respond(503, {'error': 'intentional fixture error'})
            return
        answer = answer_question(question)
        if self.server.stub_mode == 'wrong':
            answer = '演示错误回复：请稍后再试。'
        elif self.server.stub_mode == 'empty':
            answer = ''
        self.respond(200, {'data': {'answer': answer, 'session_id': uuid4().hex}})


def make_server(host='127.0.0.1', port=18081, mode='normal'):
    server = ThreadingHTTPServer((host, port), CustomerServiceHandler)
    server.stub_mode = mode
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=18081)
    parser.add_argument('--mode', choices=('normal', 'wrong', 'empty', 'error'), default='normal')
    args = parser.parse_args(argv)
    with make_server(args.host, args.port, args.mode) as server:
        print(f'Customer-service fixture: http://{server.server_address[0]}:{server.server_address[1]}/answer '
              f'(mode={args.mode})', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
