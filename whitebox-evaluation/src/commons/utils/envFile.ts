import fs from "node:fs/promises";

// 将关键配置持久化到项目根目录 `.env`，同时保留未改动的其他环境变量。
export async function upsertEnvVars(
  envPath: string,
  updates: Record<string, string>,
): Promise<void> {
  let currentText = "";
  try {
    currentText = await fs.readFile(envPath, "utf-8");
  } catch {
    currentText = "";
  }

  const lines = currentText.length > 0 ? currentText.split(/\r?\n/) : [];
  const touched = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) {
      return line;
    }

    const key = match[1];
    if (!(key in updates)) {
      return line;
    }

    touched.add(key);
    return `${key}=${updates[key]}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!touched.has(key)) {
      nextLines.push(`${key}=${value}`);
    }
  }

  const normalized = nextLines
    .filter((line, index, source) => !(line === "" && index === source.length - 1))
    .join("\n");
  await fs.writeFile(envPath, `${normalized}\n`, "utf-8");
}
