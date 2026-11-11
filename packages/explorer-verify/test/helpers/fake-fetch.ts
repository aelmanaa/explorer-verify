/**
 * The one fake `fetch` the backend tests replay recorded explorer responses through (testing.md).
 * Fixtures live in `test/fixtures/<backend>/<YYYY-MM-DD>-<endpoint>.json`.
 */
import { readFileSync } from "node:fs";

/** A recorded exchange: the request that was sent and the response that came back. */
export interface Fixture {
  /** Where the response comes from: a live recording with its time, or the document it follows. */
  readonly source: string;
  readonly request: { readonly method: string; readonly url: string };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    /** The JSON body, or a string sent as is. */
    readonly body: unknown;
  };
}

/** One call the fake received. */
export interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly headers: Headers;
  /** The `cache` mode the request asked for, such as `no-store`, or `undefined`. */
  readonly cache: RequestCache | undefined;
}

/** What the fake does on one call: answer with a fixture or a response, or reject. */
export type Step = Fixture | Response | Error;

/**
 * Reads `test/fixtures/<backend>/<name>.json`.
 *
 * @example
 * ```ts
 * const fixture = loadFixture("sourcify", "2026-11-02-lookup-exact-match");
 * ```
 */
export function loadFixture(backend: string, name: string): Fixture {
  const url = new URL(`../fixtures/${backend}/${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  return toFixture(parsed, name);
}

/** The response a fixture recorded, as a new `Response`. */
export function responseOf(fixture: Fixture): Response {
  const { status, headers, body } = fixture.response;
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...headers },
  });
}

/**
 * A fake `fetch` that plays `steps` in order, one per call, and records each call. A call after
 * the last step rejects, so a test that sends more requests than it expects fails.
 */
export function replay(...steps: Step[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body:
        typeof body === "string"
          ? body
          : body instanceof URLSearchParams
            ? body.toString()
            : undefined,
      headers: new Headers(init?.headers),
      cache: init?.cache,
    });
    const step = steps[calls.length - 1];
    if (step === undefined) {
      throw new Error(`unexpected request ${String(calls.length)}`);
    }
    if (step instanceof Error) {
      throw step;
    }
    return step instanceof Response ? step.clone() : responseOf(step);
  };
  return { fetch: fake, calls };
}

function toFixture(value: unknown, name: string): Fixture {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${name}: not an object`);
  }
  const source: unknown = Reflect.get(value, "source");
  const req: unknown = Reflect.get(value, "request");
  const res: unknown = Reflect.get(value, "response");
  if (
    typeof source !== "string" ||
    typeof req !== "object" ||
    req === null ||
    typeof res !== "object" ||
    res === null
  ) {
    throw new Error(`${name}: needs source, request and response`);
  }
  const method: unknown = Reflect.get(req, "method");
  const url: unknown = Reflect.get(req, "url");
  const status: unknown = Reflect.get(res, "status");
  const headers: unknown = Reflect.get(res, "headers");
  if (
    typeof method !== "string" ||
    typeof url !== "string" ||
    typeof status !== "number" ||
    typeof headers !== "object" ||
    headers === null
  ) {
    throw new Error(`${name}: bad request or response`);
  }
  const headerMap: Record<string, string> = {};
  for (const [key, entry] of Object.entries(headers)) {
    if (typeof entry === "string") {
      headerMap[key] = entry;
    }
  }
  return {
    source,
    request: { method, url },
    response: { status, headers: headerMap, body: Reflect.get(res, "body") },
  };
}
