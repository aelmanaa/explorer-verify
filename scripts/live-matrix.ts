// The live test matrix (#66, R-QA-2): runs `verify()`, `checkStatus()` and `dryRun()` of the
// built package against real explorers on public testnets, one case at a time, and prints one JSON
// line per case. The maintainer runs it; CI does not. See docs/contributor/testing.md#live-matrix.
//
//   node scripts/live-matrix.ts <plan.json> [--note <file>] [--record <file>]
//
// The plan names the targets (backend, chain, contracts); docs/contributor/testing.md describes
// it. Keys come from the environment variable a target names in `keyEnv`, never from the plan.
// Every printed line, the note and the record pass through the package's redaction with every
// key the plan names before they are written (R-SEC-1). The exit code is 1 when any case gives
// an unexpected result, 2 when the plan or the command line is wrong.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ExplorerVerifyError,
  checkStatus,
  dryRun,
  toBackendName,
  verify,
} from "../packages/explorer-verify/dist/src/index.js";
import type {
  BackendName,
  Hex,
  RouteOverride,
  SolidityStandardJsonInput,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
} from "../packages/explorer-verify/dist/src/index.js";
import { redact } from "../packages/explorer-verify/dist/src/redact.js";
import { canonicalSources, startFake } from "./live-matrix-fake.ts";
import type { FakeVerdict } from "./live-matrix-fake.ts";

/** The cases, by number, as the issue lists them. */
export const CASES = {
  1: "verify",
  2: "already-verified",
  3: "resume",
  4: "wrong-source",
  5: "no-code",
  6: "derived-args",
  7: "cross-explorer",
  8: "missing-key",
} as const;

/** What each case expects, as a line shows it when the case throws before it has an outcome. */
const EXPECTED = {
  1: "verified exact",
  2: "already-verified exact without a submit",
  3: "abort after the submit, then verified exact in a new process",
  4: "failed with the explorer's reason",
  5: "lookup none",
  6: "verified exact",
  7: "verified on the other backend, then already-verified exact without a submit",
  8: "threw missing-api-key before any request",
} as const;

/** A case number. */
export type CaseNumber = keyof typeof CASES;

/**
 * The public testnets a plan may name without `--allow-mainnet`: Sepolia, Holesky, Hoodi, Arbitrum
 * Sepolia, Optimism Sepolia, Base Sepolia, Polygon Amoy and Avalanche Fuji.
 */
export const TESTNETS: ReadonlySet<number> = new Set([
  11155111, 17000, 560048, 421614, 11155420, 84532, 80002, 43113,
]);

/** The order the cases run in: case 4 submits a wrong source for the contract case 3 verifies. */
const ORDER: readonly CaseNumber[] = [1, 2, 4, 3, 5, 6, 7, 8];

/** One deployed contract, as the plan's contract files describe it. */
export interface Contract {
  readonly chainId: number;
  readonly address: Hex;
  readonly contractName: string;
  readonly compilerVersion: string;
  readonly creationTxHash: Hex;
  readonly creationBytecode: Hex;
  readonly constructorArgs: Hex;
  readonly input: SolidityStandardJsonInput;
}

/** One backend on one chain. */
export interface Target {
  /** A unique name, such as `sourcify/sepolia`. */
  readonly id: string;
  readonly backend: BackendName;
  /** The chain's name for people, such as `Sepolia`. */
  readonly chain: string;
  readonly chainId: number;
  /** `route.apiUrl`; `fake` starts the local fake explorer and points the route at it. */
  readonly apiUrl: string | undefined;
  /** The environment variable that holds the key for this target. */
  readonly keyEnv: string | undefined;
  /** The expected `explorerUrl`, with `{address}` for the lower-case address; none when absent. */
  readonly explorerUrl: string | undefined;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  /** An address with no code on the chain, for case 5. */
  readonly noCode: Hex | undefined;
  /** The one-byte change case 4 makes to the contract's source. */
  readonly wrongEdit: { readonly from: string; readonly to: string } | undefined;
  /** Case 1 and 2 use `fresh`; 3 and 4 `resume`; 6 `derive`; 7 `cross`. */
  readonly contracts: Readonly<Partial<Record<"fresh" | "resume" | "derive" | "cross", Contract>>>;
  /** For case 7: the route of the first verification, and how long to wait for the forwarding. */
  readonly cross:
    | { readonly route: RouteOverride; readonly waitMs: number; readonly pollMs: number }
    | undefined;
  /** For a fake target: how the fake judges submissions; `honest` unless a test breaks it. */
  readonly fakeVerdict: FakeVerdict;
  /**
   * For a fake target: the environment variable whose value the fake echoes in its answers. The
   * value counts as a secret: every output is redacted with it and checked for it (R-SEC-1).
   */
  readonly fakeEcho: string | undefined;
  readonly cases: readonly CaseNumber[];
}

/** The whole plan. */
export interface Plan {
  /** Tool versions to record in the note, such as `forge`. */
  readonly tools: Readonly<Record<string, string>>;
  readonly targets: readonly Target[];
}

/** The outcome of one case: one JSON line. */
export interface CaseLine {
  readonly target: string;
  readonly backend: BackendName;
  readonly chain: string;
  readonly chainId: number;
  readonly case: CaseNumber;
  readonly name: (typeof CASES)[CaseNumber];
  readonly address: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
  readonly durationMs: number;
  /** The requests the case sent, as `<method> <action or path>`, in order. */
  readonly requests: readonly string[];
  readonly explorerUrl?: string;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------------------------
// Reading the plan. Every value is checked; nothing is cast.

/** A plan or command-line error: exit code 2. */
export class PlanError extends Error {
  override name = "PlanError";
}

function entriesOf(value: unknown, what: string): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlanError(`${what} must be an object`);
  }
  return new Map(Object.entries(value));
}

function stringOf(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new PlanError(`${what} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : stringOf(value, what);
}

function numberOf(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PlanError(`${what} must be a non-negative integer`);
  }
  return value;
}

function hexOf(value: unknown, what: string): Hex {
  const text = stringOf(value, what);
  if (!/^0x[0-9a-fA-F]*$/.test(text)) {
    throw new PlanError(`${what} must be 0x-prefixed hex`);
  }
  return `0x${text.slice(2)}`;
}

/**
 * Reads a contract file: what the deployment helper writes for each contract.
 *
 * @param value - The parsed file.
 * @param what - Where it came from, for errors.
 * @returns The contract.
 * @example
 * ```ts
 * const contract = parseContract(JSON.parse(readFileSync(file, "utf8")), file);
 * ```
 */
export function parseContract(value: unknown, what: string): Contract {
  const fields = entriesOf(value, what);
  const input = entriesOf(fields.get("input"), `${what} input`);
  if (input.get("language") !== "Solidity") {
    throw new PlanError(`${what} input.language must be Solidity`);
  }
  const sources: Record<string, { content: string }> = {};
  for (const [file, entry] of entriesOf(input.get("sources"), `${what} input.sources`)) {
    const content = entriesOf(entry, `${what} input.sources.${file}`).get("content");
    if (typeof content !== "string") {
      throw new PlanError(`${what} input.sources.${file}.content must be a string`);
    }
    sources[file] = { content };
  }
  const settings = Object.fromEntries(entriesOf(input.get("settings"), `${what} input.settings`));
  return {
    chainId: numberOf(fields.get("chainId"), `${what} chainId`),
    address: hexOf(fields.get("address"), `${what} address`),
    contractName: stringOf(fields.get("contractName"), `${what} contractName`),
    compilerVersion: stringOf(fields.get("compilerVersion"), `${what} compilerVersion`),
    creationTxHash: hexOf(fields.get("creationTxHash"), `${what} creationTxHash`),
    creationBytecode: hexOf(fields.get("creationBytecode"), `${what} creationBytecode`),
    constructorArgs: hexOf(fields.get("constructorArgs"), `${what} constructorArgs`),
    input: { language: "Solidity", sources, settings },
  };
}

function caseNumbers(value: unknown, what: string): CaseNumber[] {
  if (!Array.isArray(value)) {
    throw new PlanError(`${what} must be an array of case numbers`);
  }
  return value.map((each: unknown) => {
    const found = ORDER.find((number) => number === each);
    if (found === undefined) {
      throw new PlanError(`${what} holds ${JSON.stringify(each)}, not a case number 1 to 8`);
    }
    return found;
  });
}

/**
 * Reads a plan. Every target must be on a chain in {@link TESTNETS}, unless `allowMainnet` is
 * set, and every contract file must name its target's chain.
 *
 * @param value - The parsed plan file.
 * @param read - Reads a contract file by path, relative to the plan.
 * @param options - `allowMainnet`, from the `--allow-mainnet` flag.
 * @returns The plan.
 * @example
 * ```ts
 * const plan = parsePlan(JSON.parse(text), (file) => JSON.parse(readFileSync(file, "utf8")));
 * ```
 */
export function parsePlan(
  value: unknown,
  read: (file: string) => unknown,
  options: { readonly allowMainnet?: boolean } = {},
): Plan {
  const fields = entriesOf(value, "plan");
  const tools: Record<string, string> = {};
  for (const [name, version] of entriesOf(fields.get("tools") ?? {}, "plan.tools")) {
    tools[name] = stringOf(version, `plan.tools.${name}`);
  }
  const rawTargets = fields.get("targets");
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw new PlanError("plan.targets must be a non-empty array");
  }
  const ids = new Set<string>();
  const targets = rawTargets.map((raw: unknown, index): Target => {
    const what = `plan.targets[${String(index)}]`;
    const target = entriesOf(raw, what);
    const id = stringOf(target.get("id"), `${what}.id`);
    if (ids.has(id)) {
      throw new PlanError(`${what}.id ${id} is used twice`);
    }
    ids.add(id);
    const backend = toBackendName(stringOf(target.get("backend"), `${what}.backend`));
    if (backend === undefined) {
      throw new PlanError(`${what}.backend is not a backend name`);
    }
    const contracts: Partial<Record<"fresh" | "resume" | "derive" | "cross", Contract>> = {};
    for (const [role, file] of entriesOf(target.get("contracts") ?? {}, `${what}.contracts`)) {
      if (role !== "fresh" && role !== "resume" && role !== "derive" && role !== "cross") {
        throw new PlanError(`${what}.contracts.${role} is not fresh, resume, derive or cross`);
      }
      const name = stringOf(file, `${what}.contracts.${role}`);
      contracts[role] = parseContract(read(name), name);
    }
    const rawEdit = target.get("wrongEdit");
    const edit = rawEdit === undefined ? undefined : entriesOf(rawEdit, `${what}.wrongEdit`);
    const rawCross = target.get("cross");
    const cross = rawCross === undefined ? undefined : entriesOf(rawCross, `${what}.cross`);
    const crossBackend =
      cross === undefined
        ? undefined
        : toBackendName(stringOf(cross.get("backend"), `${what}.cross.backend`));
    if (cross !== undefined && crossBackend === undefined) {
      throw new PlanError(`${what}.cross.backend is not a backend name`);
    }
    const crossApiUrl = optionalString(cross?.get("apiUrl"), `${what}.cross.apiUrl`);
    const verdict = target.get("fakeVerdict") ?? "honest";
    if (verdict !== "honest" && verdict !== "accept-all" && verdict !== "reject-all") {
      throw new PlanError(`${what}.fakeVerdict must be honest, accept-all or reject-all`);
    }
    const cases = caseNumbers(target.get("cases"), `${what}.cases`);
    const parsed: Target = {
      id,
      backend,
      chain: stringOf(target.get("chain"), `${what}.chain`),
      chainId: numberOf(target.get("chainId"), `${what}.chainId`),
      apiUrl: optionalString(target.get("apiUrl"), `${what}.apiUrl`),
      keyEnv: optionalString(target.get("keyEnv"), `${what}.keyEnv`),
      explorerUrl: optionalString(target.get("explorerUrl"), `${what}.explorerUrl`),
      timeoutMs: numberOf(target.get("timeoutMs") ?? 300_000, `${what}.timeoutMs`),
      pollIntervalMs: numberOf(target.get("pollIntervalMs") ?? 5000, `${what}.pollIntervalMs`),
      noCode:
        target.get("noCode") === undefined
          ? undefined
          : hexOf(target.get("noCode"), `${what}.noCode`),
      wrongEdit:
        edit === undefined
          ? undefined
          : {
              from: stringOf(edit.get("from"), `${what}.wrongEdit.from`),
              to: stringOf(edit.get("to"), `${what}.wrongEdit.to`),
            },
      contracts,
      cross:
        cross === undefined || crossBackend === undefined
          ? undefined
          : {
              route: {
                backend: crossBackend,
                ...(crossApiUrl === undefined ? {} : { apiUrl: crossApiUrl }),
              },
              waitMs: numberOf(cross.get("waitMs") ?? 300_000, `${what}.cross.waitMs`),
              pollMs: numberOf(cross.get("pollMs") ?? 15_000, `${what}.cross.pollMs`),
            },
      fakeVerdict: verdict,
      fakeEcho: optionalString(target.get("fakeEcho"), `${what}.fakeEcho`),
      cases,
    };
    if (!TESTNETS.has(parsed.chainId) && options.allowMainnet !== true) {
      throw new PlanError(
        `${what}.chainId ${String(parsed.chainId)} is not a known testnet; pass --allow-mainnet to run on it`,
      );
    }
    for (const [role, contract] of Object.entries(contracts)) {
      if (contract.chainId !== parsed.chainId) {
        throw new PlanError(
          `${what}.contracts.${role} is on chain ${String(contract.chainId)}, not ${String(parsed.chainId)}`,
        );
      }
    }
    for (const number of cases) {
      const missing = needs(parsed, number);
      if (missing !== undefined) {
        throw new PlanError(`${what} runs case ${String(number)} but has no ${missing}`);
      }
    }
    return parsed;
  });
  return { tools, targets };
}

/** What case `number` needs that `target` lacks, or `undefined`. */
function needs(target: Target, number: CaseNumber): string | undefined {
  const { contracts } = target;
  const present: Record<CaseNumber, Record<string, unknown>> = {
    1: { "contracts.fresh": contracts.fresh },
    2: { "contracts.fresh": contracts.fresh },
    3: { "contracts.resume": contracts.resume },
    4: { "contracts.resume": contracts.resume, wrongEdit: target.wrongEdit },
    5: { "contracts.fresh": contracts.fresh, noCode: target.noCode },
    6: { "contracts.derive": contracts.derive },
    7: { "contracts.cross": contracts.cross, cross: target.cross },
    8: { "contracts.fresh": contracts.fresh, keyEnv: target.keyEnv },
  };
  return Object.entries(present[number]).find(([, value]) => value === undefined)?.[0];
}

// ---------------------------------------------------------------------------------------------
// Watching requests. Every request the library sends goes through `globalThis.fetch`; the watch
// names it by method and action (or Sourcify path) and files it under the case that sent it.

/** The requests of the running case, and its label in the record. */
interface CaseContext {
  readonly requests: string[];
  readonly label: string;
}

const current = new AsyncLocalStorage<CaseContext>();

/**
 * Names a request without its values: the method and the Etherscan `action`, or the Sourcify
 * path with its chain, address and job id removed.
 *
 * @param url - The request URL.
 * @param method - The request method.
 * @param body - The request body, when it is a form.
 * @returns For example `POST verifysourcecode` or `GET /v2/contract`.
 * @example
 * ```ts
 * describeRequest(new URL("https://sourcify.dev/server/v2/contract/1/0xab"), "GET", undefined);
 * // "GET /v2/contract"
 * ```
 */
export function describeRequest(url: URL, method: string, body: unknown): string {
  const action =
    (body instanceof URLSearchParams ? body.get("action") : null) ?? url.searchParams.get("action");
  if (action !== null) {
    return `${method} ${action}`;
  }
  const sourcify = /\/v2\/(?:contract|verify)\//.exec(url.pathname);
  return `${method} ${sourcify === null ? "other" : sourcify[0].slice(0, -1)}`;
}

/** One recorded request and its answer, redacted. */
export interface RecordEntry {
  readonly case: string;
  readonly at: string;
  readonly request: string;
  readonly url: string;
  readonly status: number;
  readonly body: string;
}

/**
 * Replaces `globalThis.fetch` with one that files each request under the running case and adds
 * each answer to `record`, as received. The record holds keys until it is written: the write
 * redacts and checks it (R-SEC-1).
 *
 * @param record - Receives one entry per request.
 * @returns A function that puts the previous `fetch` back.
 * @example
 * ```ts
 * const restore = watchFetch([]);
 * restore();
 * ```
 */
export function watchFetch(record: RecordEntry[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const name = describeRequest(url, init?.method ?? "GET", init?.body);
    const context = current.getStore();
    context?.requests.push(name);
    const response = await original(input, init);
    record.push({
      case: context?.label ?? "outside a case",
      at: new Date().toISOString(),
      request: name,
      url: url.href,
      status: response.status,
      body: await response.clone().text(),
    });
    return response;
  };
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------------------------
// Running the cases.

/** What a run shares: the environment, the keys to redact, and this script's path. */
interface RunContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The environment variables that hold secrets: every `keyEnv` and `fakeEcho` of the plan. */
  readonly secretEnvs: readonly string[];
  readonly secrets: readonly string[];
  readonly script: string;
}

/** A target with the fake's URL filled in, and its key. */
interface Resolved {
  readonly target: Target;
  readonly apiUrl: string | undefined;
  readonly key: string | undefined;
  readonly crossRoute: RouteOverride | undefined;
}

/**
 * The options of one call: the route pinned to the backend, the key, and the time budget. The key
 * goes in `route.apiKey` for a route with `apiUrl`, and in `apiKeys` otherwise (R-SEC-2).
 */
function callOptions(
  backend: BackendName,
  apiUrl: string | undefined,
  key: string | undefined,
  budget: { readonly timeoutMs: number; readonly pollIntervalMs: number },
): VerifyOptions {
  const keyed = key !== undefined;
  return {
    route: {
      backend,
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(keyed && apiUrl !== undefined ? { apiKey: key } : {}),
    },
    ...(keyed && apiUrl === undefined ? { apiKeys: { [backend]: key } } : {}),
    timeoutMs: budget.timeoutMs,
    pollIntervalMs: budget.pollIntervalMs,
  };
}

/** The options of a call to `resolved`, with its key unless `withKey` is false. */
function optionsOf(resolved: Resolved, withKey: boolean): VerifyOptions {
  const { target, apiUrl, key } = resolved;
  return callOptions(target.backend, apiUrl, withKey ? key : undefined, target);
}

/** The `verify()` input for `contract`, with the arguments given or left to derive. */
function inputOf(contract: Contract, args: "given" | "derived"): VerifyInput {
  return {
    chainId: contract.chainId,
    address: contract.address,
    compiler: { kind: "solc", version: contract.compilerVersion, input: contract.input },
    contractName: contract.contractName,
    creationTxHash: contract.creationTxHash,
    ...(args === "given"
      ? { constructorArgs: contract.constructorArgs }
      : { creationBytecode: contract.creationBytecode }),
  };
}

/**
 * `input` with the first `from` in the contract's own source file replaced by `to`.
 *
 * @param input - The verify input.
 * @param edit - The change.
 * @returns The changed input.
 * @example
 * ```ts
 * const wrong = withWrongSource(input, { from: "MARK = 660402", to: "MARK = 660403" });
 * ```
 */
export function withWrongSource(
  input: VerifyInput,
  edit: { readonly from: string; readonly to: string },
): VerifyInput {
  const file = input.contractName.slice(0, input.contractName.lastIndexOf(":"));
  const source = input.compiler.input.sources[file];
  if (source === undefined || !source.content.includes(edit.from)) {
    throw new PlanError(`wrongEdit.from is not in ${file}`);
  }
  return {
    ...input,
    compiler: {
      ...input.compiler,
      input: {
        ...input.compiler.input,
        sources: {
          ...input.compiler.input.sources,
          [file]: { content: source.content.replace(edit.from, edit.to) },
        },
      },
    },
  };
}

/** A thrown value as text: the error code and message for the library's errors. */
function describeError(error: unknown): string {
  return error instanceof ExplorerVerifyError
    ? `threw ${error.code}: ${error.message}`
    : `threw ${String(error)}`;
}

/** What a case did, and whether that was the expected outcome. */
interface Outcome {
  readonly address: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
  readonly explorerUrl?: string | undefined;
  readonly detail?: string | undefined;
}

/** `, no explorerUrl` when `value` is undefined. */
function page(value: string | undefined): string {
  return value === undefined ? ", no explorerUrl" : "";
}

/** Case 1, 2 and 6: a verify() that must give `status`, an exact match and the right page. */
async function verifyCase(
  resolved: Resolved,
  contract: Contract,
  args: "given" | "derived",
  status: "verified" | "already-verified",
): Promise<Outcome> {
  const types: string[] = [];
  const result = await verify(inputOf(contract, args), {
    ...optionsOf(resolved, true),
    onEvent: (event: VerifyEvent) => {
      types.push(event.type);
    },
  });
  const url = resolved.target.explorerUrl?.replace("{address}", contract.address.toLowerCase());
  const submitted = types.includes("verify.submitted");
  const expected = `${status} exact${status === "verified" ? "" : " without a submit"}${page(url)}`;
  if (result.status === "failed") {
    return { address: contract.address, expected, actual: `failed: ${result.reason}`, ok: false };
  }
  return {
    address: contract.address,
    expected,
    actual: `${result.status} ${result.match}${submitted ? "" : " without a submit"}${page(result.explorerUrl)}`,
    ok:
      result.status === status &&
      result.match === "exact" &&
      submitted === (status === "verified") &&
      result.explorerUrl === url,
    explorerUrl: result.explorerUrl,
  };
}

/** Runs `checkStatus` on `handle` in a new process: what case 3 needs (R-FLOW-5). */
async function resumeInNewProcess(
  run: RunContext,
  resolved: Resolved,
  handle: string,
): Promise<{ status: string; requests: readonly string[] }> {
  const payload = JSON.stringify({
    handle,
    backend: resolved.target.backend,
    apiUrl: resolved.apiUrl,
    keyEnv: resolved.target.keyEnv,
    secretEnvs: run.secretEnvs,
    timeoutMs: resolved.target.timeoutMs,
    pollIntervalMs: resolved.target.pollIntervalMs,
  });
  // The process prints one JSON line. Anything else, such as a crash on stderr, fails the parse
  // below with its text in the message. Some Node versions, such as 24.0.0, warn on stderr that
  // type stripping is experimental; the flag keeps that warning out.
  const output = await new Promise<string>((resolve) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", run.script, "--resume", payload],
      { env: { ...run.env }, encoding: "utf8" },
      (_error, stdout, stderr) => {
        resolve(`${stdout}${stderr}`);
      },
    );
  });
  const answer = entriesOf(JSON.parse(output), "the resume process output");
  return {
    status: stringOf(answer.get("status"), "the resume status"),
    requests: [answer.get("requests")].flat().map(String),
  };
}

/** Case 3: abort after the submit, then resume with the stored handle in a new process. */
async function resumeCase(
  run: RunContext,
  resolved: Resolved,
  contract: Contract,
  context: CaseContext,
): Promise<Outcome> {
  const controller = new AbortController();
  const stop = new Error("stopped after the submit");
  let handle = "";
  let thrown: unknown;
  try {
    const result = await verify(inputOf(contract, "given"), {
      ...optionsOf(resolved, true),
      signal: controller.signal,
      onEvent: (event: VerifyEvent) => {
        if (event.type === "verify.submitted") {
          handle = event.handle;
          controller.abort(stop);
        }
      },
    });
    thrown = new Error(`verify() returned ${result.status} instead of rejecting`);
  } catch (error: unknown) {
    thrown = error;
  }
  const expected = "abort after the submit, then verified exact in a new process";
  if (thrown !== stop) {
    return { address: contract.address, expected, actual: describeError(thrown), ok: false };
  }
  const resumed = await resumeInNewProcess(run, resolved, handle);
  context.requests.push(...resumed.requests.map((each) => `resumed ${each}`));
  return {
    address: contract.address,
    expected,
    actual: `aborted after the submit, then ${resumed.status} in a new process`,
    ok: resumed.status === "verified exact",
    detail: `handle ${handle}`,
  };
}

/** Case 4: a source with one byte changed must give `failed` with the explorer's reason. */
async function wrongSourceCase(
  resolved: Resolved,
  contract: Contract,
  edit: { readonly from: string; readonly to: string },
): Promise<Outcome> {
  const result = await verify(
    withWrongSource(inputOf(contract, "given"), edit),
    optionsOf(resolved, true),
  );
  const expected = "failed with the explorer's reason";
  return result.status === "failed"
    ? {
        address: contract.address,
        expected,
        actual: "failed",
        ok: result.reason !== "",
        detail: `reason: ${result.reason}`,
      }
    : {
        address: contract.address,
        expected,
        actual: `${result.status} ${result.match}`,
        ok: false,
      };
}

/** Case 5: a lookup of an address with no code finds nothing. */
async function noCodeCase(resolved: Resolved, contract: Contract, address: Hex): Promise<Outcome> {
  const result = await dryRun(
    { ...inputOf(contract, "given"), address },
    optionsOf(resolved, true),
  );
  return {
    address,
    expected: "lookup none",
    actual: `lookup ${result.lookup}`,
    ok: result.lookup === "none",
  };
}

/** Case 7: after a verification on another backend, this backend answers `already-verified`. */
async function crossCase(
  resolved: Resolved,
  contract: Contract,
  cross: NonNullable<Target["cross"]>,
  route: RouteOverride,
): Promise<Outcome> {
  const other = String(route.backend);
  const first = await verify(inputOf(contract, "given"), {
    route,
    timeoutMs: resolved.target.timeoutMs,
    pollIntervalMs: resolved.target.pollIntervalMs,
  });
  if (first.status === "failed") {
    return {
      address: contract.address,
      expected: `verified on ${other}, then already-verified exact without a submit`,
      actual: `failed on ${other}: ${first.reason}`,
      ok: false,
    };
  }
  // Wait for the other backend to forward the verification, then verify here.
  const started = performance.now();
  let lookup = (await dryRun(inputOf(contract, "given"), optionsOf(resolved, true))).lookup;
  while (lookup === "none" && performance.now() - started < cross.waitMs) {
    await new Promise((resolve) => {
      setTimeout(resolve, cross.pollMs);
    });
    lookup = (await dryRun(inputOf(contract, "given"), optionsOf(resolved, true))).lookup;
  }
  const waited = Math.round(performance.now() - started);
  const then = await verifyCase(resolved, contract, "given", "already-verified");
  return {
    ...then,
    expected: `verified on ${other}, then ${then.expected}`,
    actual: `${first.status} ${first.match} on ${other}, then ${then.actual}`,
    ok: first.status === "verified" && then.ok,
    detail: `lookup ${lookup} after ${String(waited)} ms`,
  };
}

/** Case 8: without the key, `missing-api-key` before any request, and no key in the error. */
async function missingKeyCase(
  resolved: Resolved,
  contract: Contract,
  secrets: readonly string[],
  context: CaseContext,
): Promise<Outcome> {
  const expected = "threw missing-api-key before any request";
  try {
    const result = await verify(inputOf(contract, "given"), optionsOf(resolved, false));
    return { address: contract.address, expected, actual: `returned ${result.status}`, ok: false };
  } catch (error: unknown) {
    const text = `${JSON.stringify(error)} ${String(error)}`;
    const requests = context.requests.length;
    return {
      address: contract.address,
      expected,
      actual: `${describeError(error).split(":")[0] ?? ""} after ${String(requests)} requests`,
      ok:
        error instanceof ExplorerVerifyError &&
        error.code === "missing-api-key" &&
        requests === 0 &&
        secrets.every((secret) => !text.includes(secret)),
    };
  }
}

/** `value`, which `parsePlan` already checked is present. */
function need<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new PlanError("the plan lacks what this case needs");
  }
  return value;
}

/** Runs case `number` of `resolved` and returns its line. */
async function runCase(run: RunContext, resolved: Resolved, number: CaseNumber): Promise<CaseLine> {
  const { target } = resolved;
  const { contracts } = target;
  const context: CaseContext = { requests: [], label: `${target.id} case ${String(number)}` };
  const runners: Record<CaseNumber, () => Promise<Outcome>> = {
    1: async () => await verifyCase(resolved, need(contracts.fresh), "given", "verified"),
    2: async () => await verifyCase(resolved, need(contracts.fresh), "given", "already-verified"),
    3: async () => await resumeCase(run, resolved, need(contracts.resume), context),
    4: async () => await wrongSourceCase(resolved, need(contracts.resume), need(target.wrongEdit)),
    5: async () => await noCodeCase(resolved, need(contracts.fresh), need(target.noCode)),
    6: async () => {
      const outcome = await verifyCase(resolved, need(contracts.derive), "derived", "verified");
      const reads = context.requests.filter((each) => each.endsWith(" getcontractcreation"));
      return { ...outcome, detail: `getcontractcreation requests: ${String(reads.length)}` };
    },
    7: async () =>
      await crossCase(
        resolved,
        need(contracts.cross),
        need(target.cross),
        need(resolved.crossRoute),
      ),
    8: async () => await missingKeyCase(resolved, need(contracts.fresh), run.secrets, context),
  };
  const started = performance.now();
  const outcome = await current.run(context, async (): Promise<Outcome> => {
    try {
      return await runners[number]();
    } catch (error: unknown) {
      // The case threw before it had an outcome: keep what it expected and the address it used.
      const addresses: Record<CaseNumber, string | undefined> = {
        1: contracts.fresh?.address,
        2: contracts.fresh?.address,
        3: contracts.resume?.address,
        4: contracts.resume?.address,
        5: target.noCode,
        6: contracts.derive?.address,
        7: contracts.cross?.address,
        8: contracts.fresh?.address,
      };
      return {
        address: addresses[number] ?? "",
        expected: EXPECTED[number],
        actual: describeError(error),
        ok: false,
      };
    }
  });
  return {
    target: target.id,
    backend: target.backend,
    chain: target.chain,
    chainId: target.chainId,
    case: number,
    name: CASES[number],
    address: outcome.address,
    expected: outcome.expected,
    actual: outcome.actual,
    ok: outcome.ok,
    durationMs: Math.round(performance.now() - started),
    requests: context.requests,
    ...(outcome.explorerUrl === undefined ? {} : { explorerUrl: outcome.explorerUrl }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  };
}

/** Runs every case of `target` in order, and calls `print` with each line. */
async function runTarget(
  run: RunContext,
  target: Target,
  print: (line: CaseLine) => void,
): Promise<CaseLine[]> {
  // `main` checked that every named variable is set.
  const key = target.keyEnv === undefined ? undefined : run.env[target.keyEnv];
  // A fake starts for a target or a cross route whose apiUrl is `fake`.
  const fake =
    target.apiUrl === "fake" || target.cross?.route.apiUrl === "fake"
      ? await startFake({
          contracts: Object.values(target.contracts).map((contract) => ({
            address: contract.address,
            sources: canonicalSources(contract.input.sources),
            constructorArgs: contract.constructorArgs,
            creationCode: `${contract.creationBytecode}${contract.constructorArgs.slice(2)}`,
          })),
          key,
          verdict: target.fakeVerdict,
          echo: target.fakeEcho === undefined ? undefined : run.env[target.fakeEcho],
        })
      : undefined;
  // Sourcify paths sit at the fake's root, the Etherscan form API at /api.
  const api = (apiUrl: string | undefined, backend: BackendName | undefined): string | undefined =>
    fake === undefined || apiUrl !== "fake"
      ? apiUrl
      : `${fake.url}${backend === "sourcify" ? "" : "/api"}`;
  const crossApi = api(target.cross?.route.apiUrl, target.cross?.route.backend);
  const resolved: Resolved = {
    target,
    apiUrl: api(target.apiUrl, target.backend),
    key,
    crossRoute:
      target.cross === undefined
        ? undefined
        : { ...target.cross.route, ...(crossApi === undefined ? {} : { apiUrl: crossApi }) },
  };
  const lines: CaseLine[] = [];
  try {
    for (const number of ORDER.filter((each) => target.cases.includes(each))) {
      const line = await runCase(run, resolved, number);
      print(line);
      lines.push(line);
    }
  } finally {
    await fake?.close();
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The note.

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/**
 * The results as Markdown: the run's times and versions, then one table row per case.
 *
 * @param lines - The case lines.
 * @param about - The run's start and end, and the versions.
 * @returns The Markdown text.
 * @example
 * ```ts
 * const text = noteOf(lines, { started, finished, versions: { node: process.version } });
 * ```
 */
export function noteOf(
  lines: readonly CaseLine[],
  about: {
    readonly started: string;
    readonly finished: string;
    readonly versions: Readonly<Record<string, string>>;
  },
): string {
  const versions = Object.entries(about.versions).map(([name, version]) => `- ${name}: ${version}`);
  const rows = lines.map((line) => {
    const address =
      line.address === ""
        ? ""
        : line.explorerUrl === undefined
          ? `\`${line.address}\``
          : `[\`${line.address}\`](${line.explorerUrl})`;
    const notes = [...line.requests.map((each) => `\`${each}\``), line.detail ?? ""]
      .filter((each) => each !== "")
      .join(", ");
    return `| ${String(line.case)} ${line.name} | \`${line.backend}\` | ${line.chain} (${String(line.chainId)}) | ${address} | ${cell(line.expected)} | ${cell(line.actual)} | ${line.ok ? "yes" : "**no**"} | ${(line.durationMs / 1000).toFixed(1)} | ${cell(notes)} |`;
  });
  const unexpected = lines.filter((line) => !line.ok).length;
  return [
    `Run from ${about.started} to ${about.finished}. ${String(lines.length)} cases, ${String(unexpected)} unexpected.`,
    "",
    ...versions,
    "",
    "| Case | Backend | Chain | Address | Expected | Result | As expected | Seconds | Requests and detail |",
    "| ---- | ------- | ----- | ------- | -------- | ------ | ----------- | ------- | ------------------- |",
    ...rows,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The command.

/** The `--resume` mode: one `checkStatus` call, printed as one JSON line. */
/** The values of the named environment variables that are set and not empty. */
function secretsOf(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return names.map((name) => env[name] ?? "").filter((each) => each !== "");
}

/**
 * Checks text before it is written: throws when any secret is in it, so nothing with a key reaches
 * stdout or a file (R-SEC-1). It does not redact; callers redact first.
 *
 * @param text - What is about to be written.
 * @param secrets - The run's secrets.
 * @returns `text`, unchanged.
 * @example
 * ```ts
 * checkOutput(redact(line, secrets), secrets);
 * ```
 */
export function checkOutput(text: string, secrets: readonly string[]): string {
  if (secrets.some((secret) => text.includes(secret))) {
    throw new Error("a secret is in the output; nothing was written");
  }
  return text;
}

/** `text` redacted with `secrets`, then checked with {@link checkOutput}. */
function safeOutput(text: string, secrets: readonly string[]): string {
  return checkOutput(redact(text, secrets), secrets);
}

async function resumeMode(
  payload: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const fields = entriesOf(JSON.parse(payload), "the --resume payload");
  const backend = toBackendName(stringOf(fields.get("backend"), "backend"));
  if (backend === undefined) {
    throw new PlanError("backend is not a backend name");
  }
  const keyEnv = optionalString(fields.get("keyEnv"), "keyEnv");
  const key = keyEnv === undefined ? undefined : env[keyEnv];
  const secrets = secretsOf([fields.get("secretEnvs")].flat().map(String), env);
  const options = callOptions(backend, optionalString(fields.get("apiUrl"), "apiUrl"), key, {
    timeoutMs: numberOf(fields.get("timeoutMs"), "timeoutMs"),
    pollIntervalMs: numberOf(fields.get("pollIntervalMs"), "pollIntervalMs"),
  });
  const handle = stringOf(fields.get("handle"), "handle");
  const context: CaseContext = { requests: [], label: "resume" };
  const restore = watchFetch([]);
  try {
    const status = await current.run(context, async (): Promise<string> => {
      try {
        const result = await checkStatus(handle, options);
        return result.status === "failed"
          ? `failed: ${result.reason}`
          : `${result.status} ${result.match}`;
      } catch (error: unknown) {
        return describeError(error);
      }
    });
    return safeOutput(JSON.stringify({ status, requests: context.requests }), secrets);
  } finally {
    restore();
  }
}

const USAGE =
  "usage: node scripts/live-matrix.ts <plan.json> [--note <file>] [--record <file>] [--allow-mainnet]";

/** The secrets of the run in this process, for the error line of the command (R-SEC-1). */
const KNOWN_SECRETS: string[] = [];

/**
 * Runs the matrix from the command line.
 *
 * @param argv - The arguments after the script name.
 * @param env - The environment, for the keys.
 * @param write - Writes one line of standard output.
 * @returns The exit code: 0 when every case is as expected, 1 when one is not.
 * @example
 * ```ts
 * process.exitCode = await main(process.argv.slice(2), process.env, (line) => console.log(line));
 * ```
 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  write: (line: string) => void,
): Promise<number> {
  const script = fileURLToPath(import.meta.url);
  if (argv[0] === "--resume") {
    write(await resumeMode(stringOf(argv[1], "the --resume payload"), env));
    return 0;
  }
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let flag: string | undefined;
  for (const arg of argv) {
    if (flag !== undefined) {
      flags.set(flag, arg);
      flag = undefined;
    } else if (arg === "--note" || arg === "--record") {
      flag = arg;
    } else if (arg === "--allow-mainnet") {
      flags.set(arg, "");
    } else if (arg.startsWith("--")) {
      throw new PlanError(`unknown option ${arg}; ${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  const [planFile] = positional;
  if (planFile === undefined || positional.length > 1 || flag !== undefined) {
    throw new PlanError(USAGE);
  }
  const dir = path.dirname(path.resolve(planFile));
  const plan = parsePlan(
    JSON.parse(readFileSync(planFile, "utf8")),
    (file): unknown => JSON.parse(readFileSync(path.resolve(dir, file), "utf8")),
    { allowMainnet: flags.has("--allow-mainnet") },
  );
  // Every secret the plan names, so every output is redacted with all of them (R-SEC-1). All of
  // them must be set before any target starts.
  const secretEnvs = plan.targets.flatMap((target) =>
    [target.keyEnv, target.fakeEcho].flatMap((name) => (name === undefined ? [] : [name])),
  );
  const unset = secretEnvs.filter((name) => (env[name] ?? "") === "");
  if (unset.length > 0) {
    throw new PlanError(`set ${[...new Set(unset)].join(", ")} in the environment`);
  }
  const secrets = secretsOf(secretEnvs, env);
  KNOWN_SECRETS.push(...secrets);
  const record: RecordEntry[] = [];
  const restore = watchFetch(record);
  const run: RunContext = { env, secretEnvs, secrets, script };
  const started = new Date().toISOString();
  let lines: CaseLine[];
  try {
    const perTarget = await Promise.all(
      plan.targets.map(
        async (target) =>
          await runTarget(run, target, (line) => {
            write(checkOutput(redact(JSON.stringify(line), secrets), secrets));
          }),
      ),
    );
    lines = perTarget.flat();
  } finally {
    restore();
  }
  const outputs: [string | undefined, () => string][] = [
    [
      flags.get("--note"),
      () => {
        const pkg = entriesOf(
          JSON.parse(
            readFileSync(
              path.resolve(path.dirname(script), "../packages/explorer-verify/package.json"),
              "utf8",
            ),
          ),
          "package.json",
        );
        return noteOf(lines, {
          started,
          finished: new Date().toISOString(),
          versions: {
            "explorer-verify": String(pkg.get("version")),
            node: process.version,
            ...plan.tools,
          },
        });
      },
    ],
    [flags.get("--record"), () => `${record.map((entry) => JSON.stringify(entry)).join("\n")}\n`],
  ];
  for (const [file, text] of outputs) {
    if (file !== undefined) {
      writeFileSync(file, checkOutput(redact(text(), secrets), secrets));
    }
  }
  return lines.every((line) => line.ok) ? 0 : 1;
}

if (path.resolve(String(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env, (line) => {
      process.stdout.write(`${line}\n`);
    });
  } catch (error: unknown) {
    process.stderr.write(`${redact(String(error), KNOWN_SECRETS)}\n`);
    process.exitCode = error instanceof PlanError ? 2 : 1;
  }
}
