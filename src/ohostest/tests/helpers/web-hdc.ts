import type { CommandResult } from "../../src/execution/types/index.js";

export const commandResult = (stdout = "", exitCode = 0): CommandResult => ({
  stdout,
  stderr: "",
  exitCode,
  durationMs: 1,
});

/** Stateful device stub: no real HDC, SDK, emulator or network forwarding. */
export class WebHdc {
  readonly mappings = new Map<string, string>();
  readonly commands: string[] = [];
  readonly events: string[] = [];
  retainOnRemove = false;
  rejectCreate = false;

  constructor(readonly targets = ["127.0.0.1:15001"]) {}

  run = async (command: string): Promise<CommandResult> => {
    this.commands.push(command);
    const target = command.match(/ -t ["']?([^"'\s]+)/)?.[1] ?? "";
    if (command.includes("list targets"))
      return commandResult(this.targets.join("\n"));
    if (command.includes("fport ls"))
      return commandResult(
        [...this.mappings]
          .map(([device, port]) => `${device} tcp:5175 ${port} [Reverse]`)
          .join("\n"),
      );
    if (command.includes(" rport ")) {
      this.events.push(`add:${target}`);
      if (this.rejectCreate || this.mappings.has(target))
        return commandResult("[Fail]TCP Port listen failed at 5175.");
      this.mappings.set(target, "tcp:5175");
      return commandResult("Forwardport result:OK.");
    }
    if (command.includes("fport rm")) {
      this.events.push(`remove:${target}`);
      if (!this.retainOnRemove) this.mappings.delete(target);
      return commandResult(
        "Remove forward ruler success, ruler:tcp:5175 tcp:5175.",
      );
    }
    if (command.includes("aa test")) {
      this.events.push(`test:${target}`);
      return commandResult(
        "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n",
      );
    }
    return commandResult();
  };
}
