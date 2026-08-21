export function interruptionError(reason = "Autorun 执行被中断") {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  error.code ||= "AUTORUN_INTERRUPTED";
  return error;
}

export function throwIfInterrupted(signal) {
  if (signal?.aborted) throw interruptionError(signal.reason);
}

