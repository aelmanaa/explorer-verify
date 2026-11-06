// The browser smoke scenario (R-RUN-1, R-FLOW-5). scripts/browser-smoke.ts bundles entry.ts, which
// runs it, and runs that bundle in Node and in headless Chromium against a local server that
// replays recorded Sourcify answers. Both runs must give the same results.
//
// The full run and the resume pass the replay server as `route.apiUrl`, so they load no routing
// table. The table run passes no route: the table routes the call to Sourcify, and a `fetch`
// option sends Sourcify's requests to the replay server (decision 0040).
//
// `verify` and `checkStatus` come from the built package, as a dapp imports them. Keccak-256 is
// internal and not exported, so the vectors run on its source file, bundled with the rest.
import { checkStatus, verify } from "explorer-verify";
import type { VerifyResult } from "explorer-verify";
import { BACKEND_NAMES, toBackendName } from "explorer-verify/backends";
import { sourcify } from "explorer-verify/clients/sourcify";
import { verify as coreVerify } from "explorer-verify/core";
import { exitCodeOf, toEnvelope } from "explorer-verify/envelope";
import { ERROR_CODES, ExplorerVerifyError } from "explorer-verify/errors";
import { formatHandle, isHandleString, parseHandle, tryParseHandle } from "explorer-verify/handle";
import { createVerifyHandler } from "explorer-verify/server";

import { keccak256 } from "../../src/internal/keccak.ts";
import vectors from "../fixtures/keccak256-vectors.json" with { type: "json" };

// The public Sourcify API, where the routing table sends a Sepolia call that needs no key.
const SOURCIFY_API = "https://sourcify.dev/server";
// The Greeter on Sepolia whose responses the fixtures recorded. scripts/browser-smoke.ts expects
// this address in the handle.
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const SEPOLIA = 11155111;
// A finished job on Arbitrum Sepolia that the fixtures also recorded.
const OTHER_HANDLE =
  "ev1:sourcify:421614:0xcecf301f97d21103233e666b2c6b766195d2e5dc:89bd295a-5a1e-40d7-a853-739e62341b77";

// Each call's budget. A passing run needs about 1 second; a broken one, such as a missing CORS
// header that fails every request, ends after the retries this budget allows instead of 120 s.
const TIMEOUT_MS = 10_000;

/** A call's result, or the error it threw, in a form that crosses from the page to Node. */
type Outcome =
  | { readonly ok: true; readonly result: VerifyResult }
  | { readonly ok: false; readonly error: string };

/** What one run of the scenario gives. */
interface ScenarioResult {
  /** Each vector's name and the digest computed for it. */
  readonly keccak: readonly { readonly name: string; readonly digest: string }[];
  readonly verify: Outcome;
  /** The handle from the `verify.submitted` event, in its one-line form. */
  readonly handle: string | undefined;
  /** `checkStatus` on that handle string. */
  readonly checkStatus: Outcome | undefined;
  /** `checkStatus` on another job's handle, after the first one, in the same realm. */
  readonly otherCheckStatus: Outcome;
  /** The server handler, run in this realm against an in-page fake Etherscan (R-SRV-1). */
  readonly handler: HandlerResult;
  /** The handle, errors, backends and envelope subpaths, run on the handle and the result. */
  readonly subpaths: SubpathResult | undefined;
}

/** What the names of the four subpaths of decision 0055 give in this realm. */
interface SubpathResult {
  /** `formatHandle(parseHandle(handle))`. */
  readonly roundTrip: string;
  readonly isHandleString: boolean;
  /** Whether `tryParseHandle` gives `undefined` for a value that is not a handle. */
  readonly tryParseBad: boolean;
  /** The `code` of the error `parseHandle` throws, when it is an `ExplorerVerifyError`. */
  readonly parseBadCode: string | undefined;
  /** Whether `ERROR_CODES` lists `network`. */
  readonly listsNetwork: boolean;
  /** `toBackendName("sourcify")`. */
  readonly backend: string | undefined;
  /** Whether `BACKEND_NAMES` lists `sourcify`. */
  readonly listsSourcify: boolean;
  /** `exitCodeOf` and the envelope's `ok` for the result of `verify()`. */
  readonly exitCode: number;
  readonly envelopeOk: boolean;
}

/** What the server handler answered, and what it sent to the fake Etherscan. */
interface HandlerResult {
  readonly forwarded: { readonly status: number; readonly body: unknown };
  readonly refused: { readonly status: number; readonly body: unknown };
  readonly upstream: readonly {
    readonly url: string;
    readonly redirect: string | undefined;
    readonly keyInBody: boolean;
  }[];
}

/**
 * Runs `createVerifyHandler` in this realm with a fake Etherscan `fetch`, so no request leaves the
 * page: a status poll it forwards, then a `getabi` it refuses (R-SRV-1, R-SRV-3).
 */
async function runHandler(): Promise<HandlerResult> {
  // A made-up key. Never a real one (R-SEC-1).
  const apiKey = "dummy-key-0001";
  const upstream: { url: string; redirect: string | undefined; keyInBody: boolean }[] = [];
  const handler = createVerifyHandler({
    apiKey,
    chains: [SEPOLIA],
    fetch: async (input, init) => {
      const body = init?.body;
      upstream.push({
        url: input instanceof Request ? input.url : String(input),
        redirect: init?.redirect,
        keyInBody: body instanceof URLSearchParams && body.get("apikey") === apiKey,
      });
      return await Promise.resolve(
        new Response(JSON.stringify({ status: "1", message: "OK", result: "Pass - Verified" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });
  const form = (fields: Record<string, string>): Request =>
    new Request(`https://dapp.example/api/verify?chainid=${String(SEPOLIA)}`, {
      method: "POST",
      body: new URLSearchParams(fields),
    });
  const forwarded = await handler(
    form({ module: "contract", action: "checkverifystatus", guid: "abc123" }),
  );
  const refused = await handler(form({ module: "contract", action: "getabi", address: GREETER }));
  return {
    forwarded: { status: forwarded.status, body: await forwarded.json() },
    refused: { status: refused.status, body: await refused.json() },
    upstream,
  };
}

function bytesOf(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/**
 * Runs the names of `explorer-verify/handle`, `/errors`, `/backends` and `/envelope` on the
 * submitted handle and the result of `verify()` (decision 0055).
 *
 * @param handle - The one-line handle the run submitted.
 * @param result - What `verify()` returned.
 * @returns What each name gave.
 */
function runSubpaths(handle: string, result: VerifyResult): SubpathResult {
  let parseBadCode: string | undefined;
  try {
    parseHandle("ev1:nowhere");
  } catch (error) {
    parseBadCode = error instanceof ExplorerVerifyError ? error.code : undefined;
  }
  return {
    roundTrip: formatHandle(parseHandle(handle)),
    isHandleString: isHandleString(handle),
    tryParseBad: tryParseHandle("ev1:nowhere") === undefined,
    parseBadCode,
    listsNetwork: ERROR_CODES.includes("network"),
    backend: toBackendName("sourcify"),
    listsSourcify: BACKEND_NAMES.includes("sourcify"),
    exitCode: exitCodeOf(result),
    envelopeOk: toEnvelope(result).ok,
  };
}

async function settle(call: Promise<VerifyResult>): Promise<Outcome> {
  return await call.then(
    (result): Outcome => ({ ok: true, result }),
    (error: unknown): Outcome => ({
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }),
  );
}

/**
 * Hashes the keccak-256 vectors, runs `verify()` on the Greeter, then `checkStatus()` on the
 * handle it submitted and on another job's handle.
 *
 * @param apiUrl - The base URL of the server that replays Sourcify's answers.
 * @returns The digests and the three outcomes.
 */
async function runScenario(apiUrl: string): Promise<ScenarioResult> {
  const keccak = vectors.vectors.map(({ name, inputHex }) => ({
    name,
    digest: keccak256(bytesOf(inputHex)),
  }));
  const options = { route: { apiUrl }, timeoutMs: TIMEOUT_MS };
  const submitted: string[] = [];
  const verified = await settle(
    verify(
      {
        chainId: SEPOLIA,
        address: GREETER,
        compiler: {
          kind: "solc",
          version: "0.8.24+commit.e11b9ed9",
          input: {
            language: "Solidity",
            sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
            settings: { optimizer: { enabled: true, runs: 200 } },
          },
        },
        contractName: "contracts/Greeter.sol:Greeter",
      },
      {
        ...options,
        pollIntervalMs: 1_000,
        onEvent: (event) => {
          if (event.type === "verify.submitted") {
            submitted.push(event.handle);
          }
        },
      },
    ),
  );
  const [handle] = submitted;
  return {
    keccak,
    verify: verified,
    handle,
    checkStatus: handle === undefined ? undefined : await settle(checkStatus(handle, options)),
    otherCheckStatus: await settle(checkStatus(OTHER_HANDLE, options)),
    handler: await runHandler(),
    subpaths:
      handle === undefined || !verified.ok ? undefined : runSubpaths(handle, verified.result),
  };
}

/**
 * Runs only `checkStatus()` on a handle string, in a realm where `verify()` never ran, as after a
 * page reload.
 *
 * @param handle - The one-line handle a first run gave.
 * @param apiUrl - The base URL of the server that replays Sourcify's answers.
 * @returns The outcome.
 */
async function resumeScenario(handle: string, apiUrl: string): Promise<Outcome> {
  return await settle(checkStatus(handle, { route: { apiUrl }, timeoutMs: TIMEOUT_MS }));
}

/**
 * Runs only `verify()` without a route, in a fresh realm: the routing table chooses Sourcify for
 * Sepolia, which needs no key, so the call loads the table's chunk (decision 0040). The `fetch`
 * option sends each request for the public Sourcify API to the replay server instead.
 *
 * @param apiUrl - The base URL of the server that replays Sourcify's answers.
 * @returns The outcome: already verified, with the row's explorer page.
 */
async function tableScenario(apiUrl: string): Promise<Outcome> {
  const viaReplay: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const sent = url.startsWith(`${SOURCIFY_API}/`)
      ? `${apiUrl}${url.slice(SOURCIFY_API.length)}`
      : url;
    return await globalThis.fetch(sent, init);
  };
  return await settle(
    verify(
      {
        chainId: SEPOLIA,
        address: GREETER,
        compiler: {
          kind: "solc",
          version: "0.8.24+commit.e11b9ed9",
          input: {
            language: "Solidity",
            sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
            settings: { optimizer: { enabled: true, runs: 200 } },
          },
        },
        contractName: "contracts/Greeter.sol:Greeter",
      },
      { fetch: viaReplay, timeoutMs: TIMEOUT_MS },
    ),
  );
}

/**
 * Runs `verify()` from `explorer-verify/core` with the Sourcify client and no table, in a fresh
 * realm (decision 0052). The client is in the page's own code, so the call loads no chunk: no
 * client's and not the routing table's.
 *
 * @param apiUrl - The base URL of the server that replays Sourcify's answers.
 * @returns The outcome: already verified, with no explorer page for a server that is not Sourcify.
 */
async function coreScenario(apiUrl: string): Promise<Outcome> {
  return await settle(
    coreVerify(
      {
        chainId: SEPOLIA,
        address: GREETER,
        compiler: {
          kind: "solc",
          version: "0.8.24+commit.e11b9ed9",
          input: {
            language: "Solidity",
            sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
            settings: { optimizer: { enabled: true, runs: 200 } },
          },
        },
        contractName: "contracts/Greeter.sol:Greeter",
      },
      { clients: [sourcify()], route: { backend: "sourcify", apiUrl }, timeoutMs: TIMEOUT_MS },
    ),
  );
}

/**
 * Starts the scenario the test asked for and leaves its promise on `explorerVerifySmoke`. The test
 * sets `explorerVerifySmokeConfig` first: `apiUrl`, `resume` for a resume-only load,
 * `fromTable: true` for a load that verifies without a route, and `core: true` for a load that
 * verifies through `explorer-verify/core`.
 *
 * @throws Error when the config is missing or malformed.
 */
export function start(): void {
  const config: unknown = Reflect.get(globalThis, "explorerVerifySmokeConfig");
  const read = (name: string): unknown =>
    typeof config === "object" && config !== null ? Reflect.get(config, name) : undefined;
  const apiUrl = read("apiUrl");
  const resume = read("resume");
  if (typeof apiUrl !== "string") {
    throw new TypeError("explorerVerifySmokeConfig.apiUrl is not set");
  }
  Reflect.set(
    globalThis,
    "explorerVerifySmoke",
    read("core") === true
      ? coreScenario(apiUrl)
      : read("fromTable") === true
        ? tableScenario(apiUrl)
        : typeof resume === "string"
          ? resumeScenario(resume, apiUrl)
          : runScenario(apiUrl),
  );
}
