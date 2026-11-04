/**
 * A fake Etherscan for the server handler tests (R-QA-3): a `fetch` that records every upstream
 * request the handler sends and answers from a list of steps, plus readers for the recorded
 * Etherscan requests and answers in `test/fixtures/etherscan/`.
 */
import { readFileSync } from "node:fs";

/** One upstream request the fake received. */
export interface UpstreamCall {
  readonly url: string;
  readonly method: string;
  /** `init.redirect` as the handler set it. */
  readonly redirect: RequestRedirect | undefined;
  /** The form body, parsed. Empty when the body was not a `URLSearchParams`. */
  readonly form: URLSearchParams;
  /** The body as sent, as text. */
  readonly bodyText: string;
  readonly headers: Headers;
}

/** What the fake does on one call: answer, reject, or wait for the signal and reject with it. */
export type ExplorerStep = Response | Error | "hang";

/**
 * A fake explorer that plays `steps` in order, one per call. A call after the last step rejects,
 * so a request the test did not expect fails the test. `called` resolves on the first call.
 *
 * @example
 * ```ts
 * const explorer = fakeExplorer(json({ status: "1", message: "OK", result: "guid" }));
 * const handler = createVerifyHandler({ apiKey, chains: [1], fetch: explorer.fetch });
 * ```
 */
export function fakeExplorer(...steps: ExplorerStep[]): {
  fetch: typeof fetch;
  calls: UpstreamCall[];
  called: Promise<void>;
} {
  const calls: UpstreamCall[] = [];
  let onCall: (() => void) | undefined;
  const called = new Promise<void>((resolve) => {
    onCall = resolve;
  });
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body;
    const text =
      body instanceof URLSearchParams ? body.toString() : typeof body === "string" ? body : "";
    calls.push({
      url,
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      form: new URLSearchParams(body instanceof URLSearchParams ? body : ""),
      bodyText: text,
      headers: new Headers(init?.headers),
    });
    onCall?.();
    const step = steps[calls.length - 1];
    if (step === undefined) {
      throw new Error(`unexpected upstream request ${String(calls.length)}`);
    }
    if (step === "hang") {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }
    if (step instanceof Error) {
      throw step;
    }
    return step.clone();
  };
  return { fetch: fake, calls, called };
}

/** A JSON response. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** A recorded Etherscan exchange: the request's form fields and the answer. */
export interface EtherscanFixture {
  /** The form fields the request sent, without `apikey`. */
  readonly fields: Record<string, string>;
  /** The chain id from the request URL. */
  readonly chainId: string;
  readonly status: number;
  readonly body: unknown;
}

/**
 * Reads `test/fixtures/etherscan/<name>.json`. The recorded `apikey` field is dropped: the client
 * never sends one to the handler.
 */
export function etherscanFixture(name: string): EtherscanFixture {
  const url = new URL(`../fixtures/etherscan/${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  const req: unknown = Reflect.get(Object(parsed), "request");
  const res: unknown = Reflect.get(Object(parsed), "response");
  const requestUrl: unknown = Reflect.get(Object(req), "url");
  const status: unknown = Reflect.get(Object(res), "status");
  if (typeof requestUrl !== "string" || typeof status !== "number") {
    throw new Error(`${name}: needs request.url and response.status`);
  }
  const query = new URL(requestUrl).searchParams;
  const recorded: unknown = Reflect.get(Object(Reflect.get(Object(req), "body")), "fields");
  const fields: Record<string, string> = {};
  const source: [string, unknown][] =
    typeof recorded === "object" && recorded !== null
      ? Object.entries(recorded)
      : [...query.entries()].filter(([field]) => field !== "chainid");
  for (const [field, value] of source) {
    if (field !== "apikey" && typeof value === "string") {
      fields[field] = value;
    }
  }
  return {
    fields,
    chainId: query.get("chainid") ?? "",
    status,
    body: Reflect.get(Object(res), "body"),
  };
}
