import process from "node:process";
import { shellQuote } from "./shellQuote.js";

export function hvigorCommand(hvigorw: string): string {
  const executable = hvigorw.trim();
  return executable.toLowerCase().endsWith(".js")
    ? `${shellQuote(process.execPath)} ${shellQuote(executable)}`
    : shellQuote(executable);
}
