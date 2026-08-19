import type { WorkflowLifecycleEvent } from "./types.js";

type BaseLogger = {
  info(message: string): Promise<void>;
  error(message: string): Promise<void>;
};

// WorkflowEventLogger 负责把统一事件翻译成中文节点日志。
export class WorkflowEventLogger {
  constructor(private readonly logger: BaseLogger) {}

  async log(event: WorkflowLifecycleEvent): Promise<void> {
    const nodePrefix = `[${event.label}${event.nodeId}]`;

    if (event.type === "node_started") {
      await this.logger.info(`${nodePrefix} 节点开始`);
      return;
    }

    if (event.type === "node_completed") {
      await this.logger.info(`${nodePrefix} 节点完成 summary=${event.summary}`);
      return;
    }

    await this.logger.error(`${nodePrefix} 节点失败 error=${event.errorMessage ?? "unknown"}`);
  }
}
