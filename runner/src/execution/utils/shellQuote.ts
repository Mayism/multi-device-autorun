export function shellQuote(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  if (platform === "win32") {
    return quoteWindowsArg(value);
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}
