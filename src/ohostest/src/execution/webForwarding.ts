import {
  buildListForwardCommand,
  buildRemoveReversePortCommand,
  buildReversePortCommand,
} from "../fold/forwarding.js";
import type { CommandResult } from "./types/index.js";

interface WebForwardingInput {
  hdc: string;
  target: string;
  port: number;
  runCommand: (command: string) => Promise<CommandResult>;
}

type ForwardingError = "web_forward_failed" | "web_forward_cleanup_failed";

/** Borrows an existing identical mapping, and removes only a mapping it creates. */
export class WebPortForwarding {
  private owned = false;

  constructor(private readonly input: WebForwardingInput) {}

  async start(): Promise<void> {
    const { hdc, target, port } = this.input;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw this.error("web_forward_failed", "invalid port");
    const existing = await this.destinations("web_forward_failed");
    if (existing.some((destination) => destination !== `tcp:${port}`))
      throw this.error("web_forward_failed", "device port has another mapping");
    if (existing.length) return;
    await this.run(
      buildReversePortCommand(hdc, target, port, port),
      "web_forward_failed",
    );
    // Retain ownership if verification fails, so device cleanup can still run.
    this.owned = true;
    if (
      !(await this.destinations("web_forward_failed")).includes(`tcp:${port}`)
    )
      throw this.error("web_forward_failed", "mapping was not established");
  }

  async stop(): Promise<void> {
    if (!this.owned) return;
    const { hdc, target, port } = this.input;
    const existing = await this.destinations("web_forward_cleanup_failed");
    if (existing.some((destination) => destination !== `tcp:${port}`))
      throw this.error(
        "web_forward_cleanup_failed",
        "mapping changed; retained",
      );
    if (existing.length) {
      await this.run(
        buildRemoveReversePortCommand(hdc, target, port, port),
        "web_forward_cleanup_failed",
      );
      if (
        (await this.destinations("web_forward_cleanup_failed")).includes(
          `tcp:${port}`,
        )
      )
        throw this.error("web_forward_cleanup_failed", "mapping still exists");
    }
    this.owned = false;
  }

  private async destinations(errorCode: ForwardingError): Promise<string[]> {
    const { hdc, target, port } = this.input;
    const result = await this.run(
      buildListForwardCommand(hdc, target),
      errorCode,
    );
    return result.stdout.split(/\r?\n/).flatMap((line) => {
      // HDC versions may include the target even when -t was supplied.
      const match = line
        .trim()
        .match(/^(?:(\S+)\s+)?(\S+)\s+(\S+)\s+\[Reverse\]$/i);
      if (
        !match ||
        (match[1] && match[1] !== target) ||
        match[2] !== `tcp:${port}`
      )
        return [];
      return [match[3]];
    });
  }

  private async run(
    command: string,
    errorCode: ForwardingError,
  ): Promise<CommandResult> {
    try {
      const result = await this.input.runCommand(command);
      const output = `${result.stdout}\n${result.stderr}`.trim();
      if (result.exitCode !== 0 || /\[Fail\]/i.test(output))
        throw new Error(output || `hdc exit ${result.exitCode}`);
      return result;
    } catch (error) {
      throw this.error(
        errorCode,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private error(code: ForwardingError, detail: string): Error {
    return new Error(
      `${code}: target=${this.input.target}, port=${this.input.port}: ${detail}`,
    );
  }
}
