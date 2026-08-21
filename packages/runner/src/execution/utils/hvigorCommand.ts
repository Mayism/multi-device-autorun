import process from "node:process";
import { shellQuote } from "./shellQuote.js";

export function hvigorCommand(hvigorw: string, nodePath = process.execPath): string {
  const executable = hvigorw.trim();
  return executable.toLowerCase().endsWith(".js")
    ? `${shellQuote(nodePath)} ${shellQuote(executable)}`
    : shellQuote(executable);
}
