/**
 * A fake network for the example tests (R-QA-3): the browser, the example's server and Etherscan in
 * one `fetch`. A request to the server's origin goes to the example's entry point, as the platform
 * would pass it; a request to Etherscan gets the next recorded answer from
 * `packages/explorer-verify/test/fixtures/etherscan/`. Nothing leaves the process.
 */
import { readFileSync } from "node:fs";
import type { TestContext } from "node:test";
import { inspect } from "node:util";

/** The console methods the handler's `logger: console` calls. */
const LEVELS: readonly ("debug" | "info" | "warn" | "error")[] = ["debug", "info", "warn", "error"];

/**
 * Replaces the console's log methods for one test and collects what they are given, so a test can
 * check that no line holds the key (R-SEC-1).
 * @param t The test.
 * @returns The collected lines, one per call.
 */
export function captureConsole(t: TestContext): string[] {
  const lines: string[] = [];
  for (const level of LEVELS) {
    t.mock.method(console, level, (...args: unknown[]) => {
      lines.push(inspect(args, { depth: 10 }));
    });
  }
  return lines;
}

/** The made-up key of every example test. Never a real one (R-SEC-1). */
export const KEY = "dummy.key_abc~def-0001";
/** The Etherscan v2 endpoint the client sends to. */
export const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";
/** The chain of the recorded answers: Arbitrum Sepolia. */
export const CHAIN = 421614;
/** The deployer that created the recorded contract. */
export const DEPLOYER = "0x9d087fc03ae39b088326b67fa3c788236645b717";

/** A recorded Etherscan exchange: the fields the client sends and the answer. */
export interface Recorded {
  /** The request's fields without `apikey` and `chainid`: what the browser client sends. */
  readonly fields: Record<string, string>;
  readonly status: number;
  readonly body: unknown;
}

/**
 * Reads a recorded exchange by name.
 * @param name The file name under the fixtures folder, without `.json`.
 * @returns The fields and the answer.
 */
export function recorded(name: string): Recorded {
  const url = new URL(
    `../../packages/explorer-verify/test/fixtures/etherscan/${name}.json`,
    import.meta.url,
  );
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  const request: unknown = Reflect.get(Object(parsed), "request");
  const response: unknown = Reflect.get(Object(parsed), "response");
  const requestUrl: unknown = Reflect.get(Object(request), "url");
  const status: unknown = Reflect.get(Object(response), "status");
  if (typeof requestUrl !== "string" || typeof status !== "number") {
    throw new Error(`${name}: needs request.url and response.status`);
  }
  const form: unknown = Reflect.get(Object(Reflect.get(Object(request), "body")), "fields");
  const entries: [string, unknown][] =
    typeof form === "object" && form !== null
      ? Object.entries(form)
      : [...new URL(requestUrl).searchParams.entries()];
  const fields: Record<string, string> = {};
  for (const [field, value] of entries) {
    if (field !== "apikey" && field !== "chainid" && typeof value === "string") {
      fields[field] = value;
    }
  }
  return { fields, status, body: Reflect.get(Object(response), "body") };
}

/** A JSON answer from Etherscan. */
export function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** One request that reached Etherscan. */
interface UpstreamCall {
  readonly url: string;
  readonly form: URLSearchParams;
}

/** The fake network. */
export interface Network {
  /** Replaces `globalThis.fetch` in the test. */
  readonly fetch: typeof fetch;
  /** The requests that reached Etherscan, in order. */
  readonly upstream: UpstreamCall[];
  /** The URLs of requests to any other host. */
  readonly elsewhere: string[];
}

/**
 * Builds the network.
 * @param server The server's origin, such as `https://dapp.example`.
 * @param serve The example's entry point, given the `Request` the platform would build.
 * @param browserHeaders The headers a browser adds, such as `Origin` and `Sec-Fetch-Site`.
 * @param answers Etherscan's answers, one per upstream request.
 */
export function network(
  server: string,
  serve: (request: Request) => Promise<Response>,
  browserHeaders: Record<string, string>,
  answers: readonly Response[],
): Network {
  const upstream: UpstreamCall[] = [];
  const elsewhere: string[] = [];
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const origin = new URL(url).origin;
    if (origin === server) {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(browserHeaders)) {
        headers.set(name, value);
      }
      return await serve(new Request(url, { ...init, headers }));
    }
    if (url.startsWith(ETHERSCAN_API_URL)) {
      const body = init?.body;
      upstream.push({
        url,
        form: new URLSearchParams(
          body instanceof URLSearchParams || typeof body === "string" ? body : "",
        ),
      });
      const next = answers[upstream.length - 1];
      if (next === undefined) {
        throw new Error(`unexpected Etherscan request ${String(upstream.length)}`);
      }
      return next.clone();
    }
    elsewhere.push(url);
    return answer({ status: "ok" });
  };
  return { fetch: fake, upstream, elsewhere };
}

/**
 * The request the Etherscan v2 client sends for these fields: a form-encoded POST to
 * `api.etherscan.io/v2/api?chainid=<id>`, without a key, with `redirect: "manual"`.
 * @param fields The form fields.
 * @param chainId The chain.
 */
export function clientRequest(
  fields: Record<string, string>,
  chainId: number = CHAIN,
): [string, RequestInit] {
  return [
    `${ETHERSCAN_API_URL}?chainid=${String(chainId)}`,
    {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
  ];
}
