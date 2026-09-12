import type {
  CommandExecutor,
  CommandResult,
} from "../execution/types/index.js";
import { RunnerLogger } from "./logger.js";

export function createLoggedCommandExecutor(
  executor: CommandExecutor,
  logger: RunnerLogger,
  cwd: string,
): CommandExecutor {
  return async (command, requestedCwd, options): Promise<CommandResult> => {
    try {
      const result = await executor(command, requestedCwd ?? cwd, options);
      logger.recordCommand(command, result);
      return result;
    } catch (error) {
      logger.recordError(error, { command });
      throw error;
    }
  };
}
