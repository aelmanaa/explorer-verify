// Browser smoke test (R-RUN-1, R-FLOW-5, R-SEC-2).
//
// 1. Bundles packages/explorer-verify/test/browser/entry.ts for the browser with esbuild, with code
//    splitting on, so each backend client and the routing table is a chunk of its own (decisions
//    0031 and 0040). Any Node built-in fails the build.
// 2. Starts a replay server on 127.0.0.1 that answers Sourcify's API from recorded fixtures, in
//    order. The page passes it to the library as `route.apiUrl`. The server sends only the CORS
//    headers Sourcify sends, so Chromium applies its real CORS checks, preflight included.
// 3. Runs the bundle in Node, then serves it from another port to headless Chromium, so its
//    requests to the replay server are cross-origin, as in a dapp. Every run routes to Sourcify, so
//    Chromium must load the Sourcify client's chunk and no other client's chunk. The full run and
//    the resume pass the replay server as `route.apiUrl` and must not load the routing table's
//    chunk; a third load verifies without a route and must load it (decision 0040).
// 4. Each run must give the keccak-256 vector digests, then `verified` with `exact` from
//    `verify()` and from `checkStatus()` on two handles. A fresh load then resumes the first
//    handle with `checkStatus()` alone, and another runs `verify()` without a route, which the
//    routing table sends to Sourcify: `already-verified` with the row's explorer page. Each full run also runs `createVerifyHandler` from
//    `explorer-verify/server` against an in-page fake Etherscan: it must forward a status poll
//    with the key in the body and `redirect: "manual"`, and refuse `getabi` (R-SRV-1).
//
// A request out of the recorded order, a recorded answer nobody asked for, a request to any other
// host, a WebSocket, a request header beyond the CORS-safelisted set and `content-type:
// application/json`, a cookie or `authorization` header, a submit body without its fields, an
// uncaught page error, or a request sent after a run ends fails the test.
//
// Usage: pnpm run test:browser (builds first). Options:
//   --executable-path <file>        a Chromium binary other than the one Playwright downloads
//   --entry <file>                  another page script (scripts/test-browser/ uses broken ones)
//   --drop-response-header <name>   leave a header out of every replay answer (CORS tests)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

import { bundleChunks } from "./bundle.ts";
import type { Chunks } from "./bundle.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = path.join(root, "packages/explorer-verify");
const SOURCIFY_API = "https://sourcify.dev/server";
// The globals the page script reads its config from and leaves its result promise on.
const CONFIG_GLOBAL = "explorerVerifySmokeConfig";
const RESULT_GLOBAL = "explorerVerifySmoke";
const RUN_TIMEOUT_MS = 60_000;
const UNEXPECTED_BODY = '{"customCode":"smoke_unexpected_request"}';
// The backend every run routes to: its client's chunk is the only client chunk a run may load.
const ROUTED_CLIENT = "sourcify";
// The routing table's chunk: only the run without a route may load it, and it must (decision 0040).
const TABLE_CHUNK = "table";

// verify(): lookup, submit, one pending poll, the exact match. Then checkStatus() on its handle,
// and checkStatus() on another job's handle in the same realm, which must poll that job.
const RUN_EXCHANGES = [
  "2026-11-02-lookup-not-verified",
  "2026-11-02-submit-accepted",
  "2026-11-02-job-pending",
  "2026-11-02-job-exact-match",
  "2026-11-02-job-exact-match",
  "2026-11-03-verify-job-linked-without-libraries-exact-match",
];
// checkStatus() alone in a fresh realm, on the first handle.
const RESUME_EXCHANGES = ["2026-11-02-job-exact-match"];
// verify() without a route in a fresh realm: the lookup finds the Greeter verified.
const TABLE_EXCHANGES = ["2026-11-02-lookup-exact-match"];
// The handle of the recorded submit, for the Greeter of test/browser/scenario.ts.
const HANDLE =
  "ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
// What verify() and checkStatus() return for an exact match. A route to a server other than the
// public Sourcify API gives no explorerUrl.
const VERIFIED = { ok: true, result: { status: "verified", backend: "sourcify", match: "exact" } };
// What verify() without a route returns: the routing table's route, so the row's explorer page.
const FROM_TABLE = {
  ok: true,
  result: {
    status: "already-verified",
    backend: "sourcify",
    match: "exact",
    explorerUrl: "https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
  },
};

/** What a load sets in the page's config besides `apiUrl`, and the chunks it must load. */
interface Load {
  readonly resume?: string;
  readonly fromTable?: boolean;
}

/** The dynamically loaded modules a load must load, and no others, with a label for messages. */
function chunksOf(mode: Load): { readonly label: string; readonly modules: readonly string[] } {
  return mode.fromTable === true
    ? {
        label: `a ${ROUTED_CLIENT} route from the routing table`,
        modules: [TABLE_CHUNK, ROUTED_CLIENT],
      }
    : { label: `a ${ROUTED_CLIENT} route with route.apiUrl`, modules: [ROUTED_CLIENT] };
}

// Request headers the CORS-safelisted set allows, plus content-type, which the library sends as
// application/json (checked below) and the preflight allows.
const SAFELISTED = new Set(["accept", "accept-language", "content-language", "content-type"]);
// Headers the runtime sets and a page script cannot: the fetch standard's forbidden request
// headers that appear here, plus user-agent. `cookie` is left out on purpose.
const RUNTIME = new Set([
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "host",
  "origin",
  "referer",
  "user-agent",
]);

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  if (at === -1) {
    return undefined;
  }
  const value = process.argv[at + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

const executablePath = option("--executable-path");
const entry = path.resolve(option("--entry") ?? path.join(pkg, "test/browser/entry.ts"));
const dropHeader = option("--drop-response-header")?.toLowerCase();

interface Recorded {
  readonly method: string;
  /** The path and query below the API base, with the address in lower case. */
  readonly path: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/** The path of a recorded URL below the API base. The client sends the address in lower case. */
function pathOf(url: string): string {
  assert.ok(url.startsWith(`${SOURCIFY_API}/`), `${url} is not below ${SOURCIFY_API}`);
  return url
    .slice(SOURCIFY_API.length)
    .replace(/\/0x[0-9a-fA-F]{40}(?=\/|\?|$)/, (address) => address.toLowerCase());
}

/** Reads `test/fixtures/sourcify/<name>.json`. */
function load(name: string): Recorded {
  const file = path.join(pkg, "test/fixtures/sourcify", `${name}.json`);
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const request = field(parsed, "request");
  const response = field(parsed, "response");
  const method = field(request, "method");
  const url = field(request, "url");
  const status = field(response, "status");
  const headers = field(response, "headers");
  const body = field(response, "body");
  assert.ok(typeof method === "string" && typeof url === "string", `${name}: request`);
  assert.ok(typeof status === "number" && typeof headers === "object" && headers !== null, name);
  // Only what Sourcify's answer means to a client: its type, its cache tags and its CORS headers.
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    assert.ok(typeof value === "string", `${name}: header ${key}`);
    const lower = key.toLowerCase();
    if (lower === "content-type" || lower === "vary" || lower.startsWith("access-control-")) {
      kept[lower] = value;
    }
  }
  return {
    method,
    path: pathOf(url),
    status,
    headers: kept,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

const PREFLIGHT = load("2026-11-03-preflight-verify");

/** Every failure any run recorded, so a request that arrives after the asserts still counts. */
const allFailures: string[] = [];

function without(headers: Record<string, string>): Record<string, string> {
  const copy = { ...headers };
  if (dropHeader !== undefined) {
    delete copy[dropHeader];
  }
  return copy;
}

/** The problems with a request's headers: credentials, or a header a page script set. */
function headerProblems(method: string, headers: IncomingHttpHeaders): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name === "cookie" || name === "authorization") {
      problems.push(`${method} sent credentials (${name})`);
    } else if (!SAFELISTED.has(name) && !RUNTIME.has(name) && !name.startsWith("sec-")) {
      problems.push(`${method} sent the header ${name}`);
    } else if (name === "content-type" && value !== "application/json") {
      problems.push(`${method} sent content-type ${String(value)}`);
    }
  }
  return problems;
}

function preflightProblems(headers: IncomingHttpHeaders): string[] {
  const method = headers["access-control-request-method"];
  const asked = (headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  return [
    ...(method === "GET" || method === "POST" ? [] : [`preflight for ${String(method)}`]),
    ...asked.filter((name) => name !== "content-type").map((name) => `preflight asks for ${name}`),
  ];
}

function submitProblems(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return ["the submit body is not JSON"];
  }
  return ["compilerVersion", "contractIdentifier", "stdJsonInput"]
    .filter((name) => field(parsed, name) === undefined)
    .map((name) => `the submit body has no ${name}`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return `http://127.0.0.1:${String(address.port)}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

interface Replay {
  readonly origin: string;
  readonly failures: string[];
  assertDone: (run: string) => void;
  close: () => Promise<void>;
}

/**
 * Starts a server that answers the exchanges in order, as Sourcify's API would. A request that is
 * not the next one recorded gets a 400 at once and is a failure; so is an exchange nobody asked
 * for. CORS preflights get Sourcify's recorded preflight answer and do not take a turn.
 */
async function startReplay(names: readonly string[]): Promise<Replay> {
  const queue = names.map(load);
  const failures: string[] = [];
  const fail = (message: string): void => {
    failures.push(message);
    allFailures.push(message);
  };
  let next = 0;
  const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET";
    const target = request.url ?? "/";
    const body = await readBody(request);
    for (const problem of headerProblems(method, request.headers)) {
      fail(problem);
    }
    if (method === "OPTIONS") {
      for (const problem of preflightProblems(request.headers)) {
        fail(problem);
      }
      // Sourcify echoes the requested headers (vary: Access-Control-Request-Headers).
      const asked = request.headers["access-control-request-headers"];
      const headers = { ...PREFLIGHT.headers };
      if (asked === undefined) {
        delete headers["access-control-allow-headers"];
      } else {
        headers["access-control-allow-headers"] = asked;
      }
      response.writeHead(PREFLIGHT.status, without(headers)).end();
      return;
    }
    const recorded = queue[next];
    if (recorded === undefined || recorded.method !== method || recorded.path !== target) {
      fail(`unexpected request ${method} ${target}`);
      response
        .writeHead(
          400,
          without({ "access-control-allow-origin": "*", "content-type": "application/json" }),
        )
        .end(UNEXPECTED_BODY);
      return;
    }
    next += 1;
    if (method === "POST") {
      for (const problem of submitProblems(body)) {
        fail(problem);
      }
    }
    response.writeHead(recorded.status, without(recorded.headers)).end(recorded.body);
  };
  const server = createServer((request, response) => {
    answer(request, response).catch((error: unknown) => {
      fail(`replay server: ${String(error)}`);
      response.destroy();
    });
  });
  const origin = await listen(server);
  return {
    origin,
    failures,
    assertDone: (run) => {
      assert.deepEqual(failures, [], `${run}: requests outside the recorded exchanges`);
      assert.equal(next, queue.length, `${run}: ${String(queue.length - next)} exchanges unused`);
    },
    close: async () => {
      await close(server);
    },
  };
}

/** Rejects after `RUN_TIMEOUT_MS`, so a run that never settles fails instead of hanging. */
async function withinTimeout<T>(run: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${run}: no result after ${String(RUN_TIMEOUT_MS)} ms`));
    }, RUN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The result a full run must give: the fixture's digests, then verified with exact three times. */
function expected(): unknown {
  const vectors: unknown = JSON.parse(
    readFileSync(path.join(pkg, "test/fixtures/keccak256-vectors.json"), "utf8"),
  );
  const list = field(vectors, "vectors");
  assert.ok(Array.isArray(list) && list.length > 0);
  const keccak = list.map((vector: unknown) => {
    const name = field(vector, "name");
    const digest = field(vector, "digest");
    assert.ok(typeof name === "string" && typeof digest === "string");
    return { name, digest };
  });
  return {
    keccak,
    verify: VERIFIED,
    handle: HANDLE,
    checkStatus: VERIFIED,
    otherCheckStatus: VERIFIED,
    handler: {
      forwarded: {
        status: 200,
        body: { status: "1", message: "OK", result: "Pass - Verified" },
      },
      refused: {
        status: 403,
        body: {
          status: "0",
          message: "NOTOK",
          result:
            "Only module contract with the verifysourcecode, checkverifystatus or getsourcecode action is forwarded.",
          code: "action-not-allowed",
        },
      },
      upstream: [
        {
          url: "https://api.etherscan.io/v2/api?chainid=11155111",
          redirect: "manual",
          keyInBody: true,
        },
      ],
    },
  };
}

// --- Node -----------------------------------------------------------------------------------------

/** The origins Node may send requests to: the replay server of the run in progress. */
const nodeOrigins = new Set<string>();

/**
 * Replaces the global `fetch` and `WebSocket` for the whole process. A request to any origin but
 * the current replay server, at any time, and any WebSocket are failures.
 */
function guardNode(): void {
  const real = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!nodeOrigins.has(new URL(url).origin)) {
      allFailures.push(`Node: request outside the replay server: ${url}`);
      return new Response(UNEXPECTED_BODY, { status: 400 });
    }
    return await real(input, init);
  };
  Reflect.set(globalThis, "WebSocket", function blockedWebSocket(url: unknown): never {
    allFailures.push(`Node: WebSocket ${String(url)}`);
    throw new TypeError("no WebSocket in the smoke test");
  });
}

/** The folders the Node runs load the bundle from, removed when the test ends. */
const nodeFolders: string[] = [];
process.once("exit", () => {
  for (const folder of nodeFolders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

/** Loads the bundle as a new module instance and returns what it leaves on the global object. */
async function runInNode(
  bundle: Chunks,
  names: readonly string[],
  mode: Load = {},
): Promise<unknown> {
  const replay = await startReplay(names);
  nodeOrigins.add(replay.origin);
  try {
    Reflect.set(globalThis, CONFIG_GLOBAL, { apiUrl: replay.origin, ...mode });
    // A new folder per load, so each load is a new instance of every module, chunks included,
    // with no state from the last.
    const folder = mkdtempSync(path.join(tmpdir(), "explorer-verify-smoke-"));
    nodeFolders.push(folder);
    writeFileSync(path.join(folder, "package.json"), '{"type":"module"}');
    for (const [name, text] of bundle.files) {
      writeFileSync(path.join(folder, name), text);
    }
    await import(pathToFileURL(path.join(folder, bundle.entry)).href);
    const pending: unknown = Reflect.get(globalThis, RESULT_GLOBAL);
    const result: unknown = await withinTimeout("Node", Promise.resolve(pending));
    replay.assertDone("Node");
    return result;
  } finally {
    nodeOrigins.delete(replay.origin);
    await replay.close();
  }
}

// --- Chromium -------------------------------------------------------------------------------------

/**
 * What a Chromium run loaded beyond the entry's files that it should not have, or did not load: a
 * chunk of a module the load must not load, such as another client's or, for a run with
 * `route.apiUrl`, the routing table's; or no chunk of its own for a module it must load
 * (decisions 0031 and 0040).
 *
 * @param bundle - The split bundle.
 * @param scripts - The files the page requested, in order.
 * @param mode - The load: which modules it must load.
 * @returns One message per problem.
 */
function chunkProblems(bundle: Chunks, scripts: readonly string[], mode: Load): string[] {
  const { label, modules } = chunksOf(mode);
  const problems: string[] = [];
  const allowed = new Set(bundle.entryFiles);
  for (const name of modules) {
    const files = bundle.dynamic.get(name) ?? [];
    const [own] = files;
    if (own === undefined) {
      problems.push(`the bundle has no chunk of its own for ${name}`);
      continue;
    }
    for (const file of files) {
      allowed.add(file);
    }
    if (!scripts.includes(own)) {
      problems.push(`the page did not load the ${name} chunk ${own}`);
    }
  }
  for (const [name, files] of bundle.dynamic) {
    if (!modules.includes(name) && files[0] !== undefined && scripts.includes(files[0])) {
      problems.push(`${label} loaded the ${name} chunk ${files[0]}`);
    }
  }
  for (const script of scripts) {
    if (!allowed.has(script) && !problems.some((problem) => problem.endsWith(` ${script}`))) {
      problems.push(`${label} loaded ${script}`);
    }
  }
  return problems;
}

/**
 * The result the page leaves on {@link RESULT_GLOBAL}, once it settles. `goto` returns at the load
 * event, and a page script can start the scenario later: a module with a top-level `await`, such
 * as one that first loads a client chunk, runs on after the load event. The global is read only
 * once it is set, so such a page runs to its end; read at once, it was still undefined, and the
 * checks below ran while the scenario was waiting to poll.
 *
 * @param tab - The page.
 * @returns The page's result.
 */
async function resultOf(tab: Page): Promise<unknown> {
  // No timeout of its own: withinTimeout bounds the wait.
  await tab.waitForFunction((name) => Reflect.get(globalThis, name) !== undefined, RESULT_GLOBAL, {
    timeout: 0,
  });
  return await tab.evaluate(
    async (name): Promise<unknown> => await Reflect.get(globalThis, name),
    RESULT_GLOBAL,
  );
}

/** Loads the bundle in a fresh browser context, with the page and the replay on two origins. */
async function runInChromium(
  browser: Browser,
  bundle: Chunks,
  names: readonly string[],
  mode: Load = {},
): Promise<unknown> {
  const page =
    '<!doctype html><meta charset="utf-8"><title>explorer-verify smoke</title>' +
    `<script type="module" src="/${bundle.entry}"></script>`;
  // The bundle's files the page requested, in order.
  const scripts: string[] = [];
  const pages = createServer((request, response) => {
    const file = bundle.files.get((request.url ?? "/").slice(1));
    if (request.url === "/") {
      // A cookie for 127.0.0.1, which a request to the replay server carries only when it
      // includes credentials: the replay server fails on it.
      response
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "explorer-verify-smoke=1; Path=/; SameSite=Lax",
        })
        .end(page);
    } else if (file !== undefined) {
      scripts.push((request.url ?? "/").slice(1));
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(file);
    } else {
      response.writeHead(404).end();
    }
  });
  const origin = await listen(pages);
  const replay = await startReplay(names);
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    let inFlight = 0;
    // Observed, not intercepted: with a request route, Playwright answers CORS preflights itself
    // and Chromium's CORS checks never run.
    context.on("request", (request) => {
      inFlight += 1;
      const requestOrigin = new URL(request.url()).origin;
      if (requestOrigin !== origin && requestOrigin !== replay.origin) {
        const message = `Chromium: request outside the replay server: ${request.url()}`;
        replay.failures.push(message);
        allFailures.push(message);
      }
    });
    const settled = (): void => {
      inFlight -= 1;
    };
    context.on("requestfinished", settled);
    context.on("requestfailed", settled);
    await context.routeWebSocket(/.*/, async (socket) => {
      const message = `Chromium: WebSocket ${socket.url()}`;
      replay.failures.push(message);
      allFailures.push(message);
      await socket.close();
    });
    await context.addInitScript(
      ([name, config]) => {
        Reflect.set(globalThis, name, config);
      },
      [CONFIG_GLOBAL, { apiUrl: replay.origin, ...mode }] as const,
    );
    const tab = await context.newPage();
    tab.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    tab.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    const report = (): string =>
      `page errors: ${JSON.stringify(pageErrors)}; console errors: ${JSON.stringify(consoleErrors)}`;
    let result: unknown;
    try {
      await tab.goto(`${origin}/`);
      result = await withinTimeout("Chromium", resultOf(tab));
      // Requests the library sends after its promise settles still count.
      await tab.waitForLoadState("networkidle");
    } catch (error) {
      throw new Error(`Chromium run failed: ${String(error)}; ${report()}`, { cause: error });
    }
    assert.deepEqual(pageErrors, [], `uncaught errors on the page; ${report()}`);
    assert.equal(inFlight, 0, "Chromium: requests still open after the run");
    try {
      replay.assertDone("Chromium");
    } catch (error) {
      throw new Error(`${String(error)}; ${report()}`, { cause: error });
    }
    assert.deepEqual(chunkProblems(bundle, scripts, mode), [], "Chromium: chunks loaded");
    return result;
  } finally {
    await context.close();
    await replay.close();
    await close(pages);
  }
}

// --- main -----------------------------------------------------------------------------------------

const bundle = await bundleChunks({ entry });
const want = expected();
guardNode();
assert.deepEqual(await runInNode(bundle, RUN_EXCHANGES), want, "the Node run");
assert.deepEqual(
  await runInNode(bundle, RESUME_EXCHANGES, { resume: HANDLE }),
  VERIFIED,
  "the Node resume",
);
assert.deepEqual(
  await runInNode(bundle, TABLE_EXCHANGES, { fromTable: true }),
  FROM_TABLE,
  "the Node run without a route",
);
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  // No host but 127.0.0.1 resolves, so nothing reaches the network even if a check misses it.
  args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
});
try {
  assert.deepEqual(await runInChromium(browser, bundle, RUN_EXCHANGES), want, "the Chromium run");
  assert.deepEqual(
    await runInChromium(browser, bundle, RESUME_EXCHANGES, { resume: HANDLE }),
    VERIFIED,
    "the Chromium resume",
  );
  assert.deepEqual(
    await runInChromium(browser, bundle, TABLE_EXCHANGES, { fromTable: true }),
    FROM_TABLE,
    "the Chromium run without a route",
  );
} finally {
  await browser.close();
}
assert.deepEqual(allFailures, [], "requests outside the recorded exchanges");
const checked = allFailures.length;
// Node's fetch stays guarded until the process ends: a request sent after the runs still fails.
process.once("beforeExit", () => {
  if (allFailures.length > checked) {
    process.stderr.write(`late requests: ${allFailures.slice(checked).join(", ")}\n`);
    process.exitCode = 1;
  }
});
process.stdout.write(
  "browser smoke: Node and Chromium ran the same bundle and agree: the keccak-256 vectors match; " +
    `Chromium loaded the ${ROUTED_CLIENT} client chunk and no other, and the ${TABLE_CHUNK} chunk ` +
    "only without a route; verify() and checkStatus() returned verified with exact, also after a " +
    "fresh load, and verify() without a route already-verified with the row's page\n",
);
