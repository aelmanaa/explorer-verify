/**
 * A fake browser for the dapp example's tests (R-QA-3): a wallet that answers EIP-1193 requests,
 * an in-memory `localStorage`, and a `fetch` that sends the page's own paths to the dapp's routes
 * and Sourcify's URLs to answers recorded under `packages/explorer-verify/test/fixtures/sourcify/`.
 * No wallet, no browser and nothing outside the process.
 */
import { readFileSync } from "node:fs";
import type { TestContext } from "node:test";

/** The page's origin. A `handlerUrl` path resolves against it (decision 0046). */
export const ORIGIN = "https://dapp.example";

// The page's work must not wait on real I/O while a test drives the mock clock: a slow read
// would let the clock run ahead and spend the call's budget. So the build files are read here,
// once, and served from memory (the server's tests read them through the routes), and the
// explorer clients, the routing table and the handlerUrl code that verify() loads with import()
// are loaded here, so its import() takes them from the module cache.
const PAGE_FILES: ReadonlyMap<string, string> = new Map(
  ["Greeter.deploy.json", "Greeter.verify.json"].map((name) => [
    `/contracts/${name}`,
    readFileSync(new URL(`../dapp/public/contracts/${name}`, import.meta.url), "utf8"),
  ]),
);
const library = import.meta.resolve("explorer-verify");
for (const chunk of [
  "backends/sourcify.js",
  "backends/etherscan.js",
  "http/handler-url.js",
  "input/constructor-args.js",
  "routing/table.js",
]) {
  await import(new URL(chunk, library).href);
}
/** The Sepolia Greeter of the recorded Sourcify and Etherscan answers. */
export const ADDRESS = "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC";
/** The account the fake wallet shares, checksummed as viem returns it. Made up. */
export const ACCOUNT = "0x00000000000000000000000000000000000000A1";
/** The creation transaction the fake wallet returns. Made up. */
export const TX_HASH: string = `0x${"ab".repeat(32)}`;
/** The handle of the job that `2026-11-02-submit-accepted` recorded. */
export const RECORDED_HANDLE =
  "ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";

/** The globals each test replaced, with what they held before the test's first replacement. */
const replaced = new WeakMap<TestContext, Map<string, PropertyDescriptor | undefined>>();

/**
 * Sets a global for one test and puts back, after the test, what it held before the test first
 * set it, however often the test sets it. Node 25 and later define `localStorage` themselves;
 * replacing it keeps a run from reading a file.
 * @param t The test.
 * @param name The global's name.
 * @param value Its value in the test.
 */
export function setGlobal(t: TestContext, name: string, value: unknown): void {
  let originals = replaced.get(t);
  if (originals === undefined) {
    originals = new Map();
    replaced.set(t, originals);
    const saved = originals;
    t.after(() => {
      for (const [global, before] of saved) {
        if (before === undefined) {
          Reflect.deleteProperty(globalThis, global);
        } else {
          Reflect.defineProperty(globalThis, global, before);
        }
      }
    });
  }
  if (!originals.has(name)) {
    originals.set(name, Reflect.getOwnPropertyDescriptor(globalThis, name));
  }
  Reflect.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** The `Storage` methods the dapp calls, in memory. */
export class MemoryStorage {
  readonly items: Map<string, string> = new Map();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** One request the page sent to the wallet. */
export interface WalletCall {
  readonly method: string;
  readonly params: unknown;
}

/** The wallet's behaviour. */
export interface WalletOptions {
  /** The accounts it shares; `[ACCOUNT]` when absent. */
  readonly accounts?: readonly string[];
  /** The receipt's status: `0x1` (success) when absent. */
  readonly status?: "0x1" | "0x0";
  /** Called when the page asks for the receipt, so a test can look at the page's state then. */
  readonly onReceipt?: () => void;
}

/** A receipt as a node returns it, for the creation of the Greeter at `ADDRESS`. */
function receipt(status: string): Record<string, unknown> {
  return {
    transactionHash: TX_HASH,
    transactionIndex: "0x0",
    blockHash: `0x${"cd".repeat(32)}`,
    blockNumber: "0x10",
    from: ACCOUNT,
    to: null,
    contractAddress: status === "0x1" ? ADDRESS : null,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status,
    type: "0x2",
  };
}

/**
 * A wallet that answers the EIP-1193 requests viem sends to deploy and to wait for the receipt.
 * @param options The accounts and the receipt's status.
 * @returns The provider to set as `window.ethereum`, and the requests it received.
 */
export function fakeWallet(options: WalletOptions = {}): {
  provider: { request: (args: { method: string; params?: unknown }) => Promise<unknown> };
  calls: WalletCall[];
} {
  const calls: WalletCall[] = [];
  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    calls.push({ method, params });
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return options.accounts ?? [ACCOUNT];
      case "wallet_switchEthereumChain":
        return null;
      case "eth_chainId":
        return "0xaa36a7";
      case "eth_sendTransaction":
        return TX_HASH;
      case "eth_blockNumber":
        return "0x10";
      case "eth_getTransactionReceipt":
        options.onReceipt?.();
        return receipt(options.status ?? "0x1");
      default:
        throw new Error(`the fake wallet does not answer ${method}`);
    }
  };
  return { provider: { request }, calls };
}

/** A recorded Sourcify exchange. */
export interface SourcifyAnswer {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly body: unknown;
}

function sourcifyAnswer(name: string): SourcifyAnswer {
  const file = new URL(
    `../../packages/explorer-verify/test/fixtures/sourcify/${name}.json`,
    import.meta.url,
  );
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const request: unknown = Reflect.get(Object(parsed), "request");
  const response: unknown = Reflect.get(Object(parsed), "response");
  const method: unknown = Reflect.get(Object(request), "method");
  const url: unknown = Reflect.get(Object(request), "url");
  const status: unknown = Reflect.get(Object(response), "status");
  if (typeof method !== "string" || typeof url !== "string" || typeof status !== "number") {
    throw new Error(`${name}: needs request.method, request.url and response.status`);
  }
  return { method, url, status, body: Reflect.get(Object(response), "body") };
}

/** Whether a request is the recorded one. Sourcify takes the address in any case. */
function matches(recorded: SourcifyAnswer, method: string, url: string): boolean {
  return recorded.method === method && recorded.url.toLowerCase() === url.toLowerCase();
}

/** The browser's network. */
export interface BrowserNetwork {
  /** Replaces `globalThis.fetch` in the test. */
  readonly fetch: typeof fetch;
  /** The Sourcify requests, as `METHOD url`. */
  readonly sourcify: string[];
}

/**
 * Builds the browser's network.
 * @param routes The dapp's routes (`dappRoutes`), which get the page's own paths.
 * @param answers Sourcify's answers, in order: a recorded one by fixture name, or one made in the
 *   test. A name that ends in `*` answers every further request with the same method and URL.
 */
export function browserNetwork(
  routes: (request: Request) => Promise<Response>,
  answers: readonly (string | SourcifyAnswer)[] = [],
): BrowserNetwork {
  const sourcify: string[] = [];
  const queue: (string | SourcifyAnswer)[] = [...answers];
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const given = input instanceof Request ? input.url : String(input);
    // A request to the page's own origin, as a path or as an absolute URL.
    const url = given.startsWith(`${ORIGIN}/`) ? given.slice(ORIGIN.length) : given;
    const file = PAGE_FILES.get(url);
    if (file !== undefined) {
      return new Response(file, { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (url.startsWith("/")) {
      const headers = new Headers(init?.headers);
      headers.set("sec-fetch-site", "same-origin");
      return await routes(new Request(`${ORIGIN}${url}`, { ...init, headers }));
    }
    if (!url.startsWith("https://sourcify.dev/")) {
      throw new Error(`the page sent an unexpected request to ${url}`);
    }
    const method = init?.method ?? "GET";
    sourcify.push(`${method} ${url}`);
    let next = queue[0];
    if (typeof next === "string" && next.endsWith("*")) {
      const repeated = sourcifyAnswer(next.slice(0, -1));
      if (matches(repeated, method, url)) {
        next = repeated;
      } else {
        queue.shift();
        next = queue[0];
      }
    }
    if (next === undefined) {
      throw new Error(`no recorded answer for ${method} ${url}`);
    }
    if (next === queue[0]) {
      queue.shift();
    }
    const recorded = typeof next === "string" ? sourcifyAnswer(next) : next;
    if (!matches(recorded, method, url)) {
      throw new Error(`the answer for ${recorded.method} ${recorded.url} got ${method} ${url}`);
    }
    return new Response(JSON.stringify(recorded.body), {
      status: recorded.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  return { fetch: fake, sourcify };
}

/** The most mock time a test may drive: past every budget the page sets. */
const MAX_TICKS = 3_600;

/**
 * Ticks the mock clock one second at a time until `done` returns true. The page's work then
 * waits only on microtasks and mock timers, so the number of ticks it needs is the same on every
 * run; the bound is in mock seconds, not wall time.
 * @param t The test, with `t.mock.timers` enabled.
 * @param done Whether the work has finished.
 * @returns Whether it finished within the bound.
 */
export async function drive(t: TestContext, done: () => boolean): Promise<boolean> {
  for (let tick = 0; tick < MAX_TICKS && !done(); tick += 1) {
    // Lets every queued promise job run before the clock moves.
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  return done();
}

/**
 * Settles a promise whose work waits on timers, with the test's mock timers on.
 * @param t The test, with `t.mock.timers` enabled.
 * @param promise The work.
 */
export async function settle<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  const state = { done: false };
  promise.then(
    () => (state.done = true),
    () => (state.done = true),
  );
  await drive(t, () => state.done);
  return await promise;
}
