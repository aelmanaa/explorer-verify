// The browser smoke scenario (R-RUN-1, R-FLOW-5). scripts/browser-smoke.ts bundles entry.ts, which
// runs it, and runs that bundle in Node and in headless Chromium against a local server that
// replays recorded Sourcify answers. Both runs must give the same results.
//
// `verify` and `checkStatus` come from the built package, as a dapp imports them. Keccak-256 is
// internal and not exported, so the vectors run on its source file, bundled with the rest.
import { checkStatus, verify } from "explorer-verify";
import type { VerifyResult } from "explorer-verify";

import { keccak256 } from "../../src/internal/keccak.ts";
import vectors from "../fixtures/keccak256-vectors.json" with { type: "json" };

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
}

function bytesOf(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
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
 * Starts the scenario the test asked for and leaves its promise on `explorerVerifySmoke`. The test
 * sets `explorerVerifySmokeConfig` first: `apiUrl`, and `resume` for a resume-only load.
 *
 * @throws Error when the config is missing or malformed.
 */
export function start(): void {
  const config: unknown = Reflect.get(globalThis, "explorerVerifySmokeConfig");
  const apiUrl: unknown =
    typeof config === "object" && config !== null ? Reflect.get(config, "apiUrl") : undefined;
  const resume: unknown =
    typeof config === "object" && config !== null ? Reflect.get(config, "resume") : undefined;
  if (typeof apiUrl !== "string") {
    throw new TypeError("explorerVerifySmokeConfig.apiUrl is not set");
  }
  Reflect.set(
    globalThis,
    "explorerVerifySmoke",
    typeof resume === "string" ? resumeScenario(resume, apiUrl) : runScenario(apiUrl),
  );
}
