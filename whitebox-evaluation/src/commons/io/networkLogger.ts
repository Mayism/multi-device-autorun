function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readResponseMessage(response: Response): Promise<string> {
  try {
    const text = await response.clone().text();
    if (!text) {
      return response.statusText || "HTTP request failed";
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { message?: unknown }).message === "string"
      ) {
        return (parsed as { message: string }).message;
      }
    } catch {
      // Fall through to raw response text.
    }
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch (error) {
    return formatError(error);
  }
}

function getRequestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" || input instanceof URL ? String(input) : input.url;
}

function getRequestMethod(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): string {
  const inputMethod = typeof input === "string" || input instanceof URL ? undefined : input.method;
  return String(init?.method ?? inputMethod ?? "GET").toUpperCase();
}

export async function fetchWithNetworkLogging(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const url = getRequestUrl(input);
  const method = getRequestMethod(input, init);
  const startedAt = Date.now();

  console.info(`network_request_triggered method=${method} url=${url}`);
  try {
    const response = await fetch(input, init);
    console.info(
      `network_response_received method=${method} url=${url} status=${response.status} ok=${String(response.ok)} elapsedMs=${String(Date.now() - startedAt)}`,
    );
    if (!response.ok) {
      const message = await readResponseMessage(response);
      console.error(
        `network_request_failed method=${method} url=${url} code=${String(response.status)} message=${message} elapsedMs=${String(Date.now() - startedAt)}`,
      );
    }
    return response;
  } catch (error) {
    console.error(
      `network_request_failed method=${method} url=${url} code=FETCH_ERROR message=${formatError(error)} elapsedMs=${String(Date.now() - startedAt)}`,
    );
    throw error;
  }
}
