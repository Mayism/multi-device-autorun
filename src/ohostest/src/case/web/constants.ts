// Runtime policy belongs to the Runner, not to individual Case metadata.
export const WEB_STARTUP_TIMEOUT_MS = 60_000;

// Shared by host readiness and device-to-host forwarding.
export const WEB_SERVER_PORT = 5175;
export const WEB_READY_URL = `http://127.0.0.1:${WEB_SERVER_PORT}/`;
