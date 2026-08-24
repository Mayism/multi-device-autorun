import { ArtifactStore } from "./artifactStore.js";

// CaseLogger 同时负责控制台输出与 run.log 落盘，保证本地和部署路径一致。
export class CaseLogger {
  constructor(
    private readonly artifactStore: ArtifactStore,
    private readonly caseDir: string,
  ) {}

  async info(message: string): Promise<void> {
    const line = this.formatLine("INFO", message);

    console.log(line.trimEnd());
    await this.artifactStore.appendText(this.caseDir, "logs/run.log", line);
  }

  async warn(message: string): Promise<void> {
    const line = this.formatLine("WARN", message);

    console.warn(line.trimEnd());
    await this.artifactStore.appendText(this.caseDir, "logs/run.log", line);
  }

  async error(message: string): Promise<void> {
    const line = this.formatLine("ERROR", message);

    console.error(line.trimEnd());
    await this.artifactStore.appendText(this.caseDir, "logs/run.log", line);
  }

  private formatLine(level: "INFO" | "WARN" | "ERROR", message: string): string {
    return `[${new Date().toISOString()}] [${level}] ${message}\n`;
  }
}
