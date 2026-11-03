// Shared by the broken page scripts that scripts/test-browser/browser-smoke.test.ts feeds to the
// smoke test: each wraps the global fetch, then starts the real scenario through it.
import { start } from "../scenario.ts";

/** Whether the script runs in the browser, not in Node. */
export const inBrowser: boolean = typeof document !== "undefined";

/** The URL of a fetch input. */
export function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

/** The response with every `from` in its body replaced by `to`. */
export async function rewrite(response: Response, from: string, to: string): Promise<Response> {
  const body = (await response.text()).replaceAll(from, to);
  return new Response(body, { status: response.status, headers: response.headers });
}

/** Installs `wrap(fetch)` as the global fetch and starts the scenario. */
export function startWrapped(wrap: (real: typeof fetch) => typeof fetch): void {
  globalThis.fetch = wrap(globalThis.fetch.bind(globalThis));
  start();
}
