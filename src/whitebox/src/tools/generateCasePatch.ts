import path from "node:path";
import { generateCasePatch } from "../commons/io/patchGenerator.js";

function parseArg(argv: string[], flag: string): string | undefined {
  const index = argv.findIndex((item) => item === flag);
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const casePath = parseArg(argv, "--case");
  if (!casePath) {
    throw new Error("Missing required --case <case-path> argument.");
  }
  const outputArg = parseArg(argv, "--output");
  const resolvedCasePath = path.resolve(process.cwd(), casePath);
  const outputPath = outputArg
    ? path.resolve(process.cwd(), outputArg)
    : path.join(resolvedCasePath, "diff", "changes.patch");

  await generateCasePatch(resolvedCasePath, outputPath);

  console.log(`Patch generated at ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
