import fs from "node:fs/promises";
import path from "node:path";

export class ArtifactStore {
  constructor(private readonly rootDir: string) {}

  async ensureCaseDir(caseId: string): Promise<string> {
    const dir = path.join(this.rootDir, caseId);
    await fs.mkdir(path.join(dir, "inputs"), { recursive: true });
    await fs.mkdir(path.join(dir, "intermediate"), { recursive: true });
    await fs.mkdir(path.join(dir, "outputs"), { recursive: true });
    await fs.mkdir(path.join(dir, "logs"), { recursive: true });
    return dir;
  }

  async writeJson(caseDir: string, relativePath: string, data: unknown): Promise<string> {
    const filePath = path.join(caseDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    return filePath;
  }

  async writeText(caseDir: string, relativePath: string, content: string): Promise<string> {
    const filePath = path.join(caseDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  // 追加日志等流式文本，避免覆盖前序落盘内容。
  async appendText(caseDir: string, relativePath: string, content: string): Promise<string> {
    const filePath = path.join(caseDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, content, "utf-8");
    return filePath;
  }
}
