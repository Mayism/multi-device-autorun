import fs from "node:fs/promises";

export async function verifyFileExists(filePath: string): Promise<void> {
  await fs.access(filePath);
}
