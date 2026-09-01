import { shellQuote } from "../execution/utils/shellQuote.js";

export function buildReversePortCommand(
  hdc: string,
  target: string,
  devicePort: number,
  port: number,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${hdcTarget(hdc, target, platform)} rport tcp:${devicePort} tcp:${port}`;
}

export function buildRemoveReversePortCommand(
  hdc: string,
  target: string,
  devicePort: number,
  port: number,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${hdcTarget(hdc, target, platform)} fport rm tcp:${devicePort} tcp:${port}`;
}

export function buildListForwardCommand(
  hdc: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${hdcTarget(hdc, target, platform)} fport ls`;
}

function hdcTarget(
  hdc: string,
  target: string,
  platform: NodeJS.Platform,
): string {
  return `${shellQuote(hdc, platform)} -t ${shellQuote(target, platform)}`;
}
