/**
 * fetch() wrapper that aborts after `timeoutMs` (default 10s).
 * Use for every external HTTP call to prevent socket pile-up
 * when an upstream (gateway, Twilio, OSM, etc.) stalls.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
