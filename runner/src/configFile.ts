import fs from "node:fs/promises";
import path from "node:path";
import { parseJson5ish } from "./execution/project/json5ish.js";

export type ConfigFileErrorCode =
  | "CONFIG_READ_ERROR"
  | "CONFIG_PARSE_ERROR"
  | "CONFIG_VALIDATION_ERROR";

export class ConfigFileError extends Error {
  constructor(
    message: string,
    readonly errorCode: ConfigFileErrorCode,
    readonly file: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConfigFileError";
  }
}

export async function readJsonConfigFile<T>(filePath: string): Promise<T> {
  return readConfigFile(filePath, (content) => JSON.parse(content) as T);
}

export async function readJson5ConfigFile<T>(filePath: string): Promise<T> {
  return readConfigFile(filePath, (content) => parseJson5ish(content) as T);
}

export function configFileError(filePath: string, error: unknown): Error {
  if (error instanceof ConfigFileError) return error;
  const resolvedPath = path.resolve(filePath);
  const message = error instanceof Error ? error.message : String(error);
  return new ConfigFileError(
    message.includes(resolvedPath)
      ? message
      : `config_file_invalid: ${resolvedPath}: ${message}`,
    "CONFIG_VALIDATION_ERROR",
    resolvedPath,
    { cause: error },
  );
}

async function readConfigFile<T>(
  filePath: string,
  parse: (content: string) => T,
): Promise<T> {
  const resolvedPath = path.resolve(filePath);
  let content: string;
  try {
    content = await fs.readFile(resolvedPath, "utf-8");
  } catch (error) {
    throw new ConfigFileError(
      `config_file_read_failed: ${resolvedPath}: ${formatError(error)}`,
      "CONFIG_READ_ERROR",
      resolvedPath,
      { cause: error },
    );
  }

  try {
    return parse(content);
  } catch (error) {
    throw new ConfigFileError(
      `config_file_parse_failed: ${resolvedPath}: ${formatError(error)}`,
      "CONFIG_PARSE_ERROR",
      resolvedPath,
      { cause: error },
    );
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
