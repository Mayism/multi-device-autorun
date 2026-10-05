export function runPythonWorker(action: string, input: unknown): Promise<Buffer>;
export function runPythonWorkerSync(action: string, input: unknown): Buffer;
export function runPythonSession<T = unknown>(
  moduleName: string,
  input: unknown,
  handler: (event: any) => Promise<unknown>,
): Promise<T>;
