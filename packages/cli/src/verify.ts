// References: R-DX-1, R-AX-8, R-AX-16.
/**
 * The `verify` command: reads the build files of `--input`, the build of
 * the Foundry or Hardhat project of `--foundry` or `--hardhat`, or the whole request of
 * `--input-json`, builds and checks the input, then calls `verify()`, or `dryRun()` with
 * `--dry-run`. The address may come first, without the word `verify`.
 */
import {
  BACKEND_NAMES,
  ExplorerVerifyError,
  buildVerifyInput,
  dryRun,
  toBackendName,
  routesFor,
  validateInput,
  verify,
  verifyEach,
} from "explorer-verify";
import type {
  CheckStatusOptions,
  InputIssue,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
} from "explorer-verify";

import type { OptionSpec, OptionSpecs, OptionValue } from "./arguments.ts";
import { chainIdOf } from "./chains.ts";
import { listOption, stringOption, usageError } from "./command.ts";
import type {
  Command,
  CommandContext,
  CommandResult,
  PrepareContext,
  Prepared,
} from "./command.ts";
import { REQUIRE_OWN_SOURCE_OPTION } from "./own-source.ts";
import { PROJECT_OPTIONS, inputFromProject, projectOf } from "./project.ts";
import { FOLDER_MESSAGE, readJsonFile, readJsonRequest } from "./request.ts";
import type { JsonRequestSpec } from "./request.ts";
import { RPC_URL_OPTIONS, readRpcUrl } from "./rpc-url.ts";
import { ALL, AUTO, allDryRunRefusal, refusal, skippedByAll } from "./target.ts";
import type { Target } from "./target.ts";

/** The longest `--timeout` in seconds: the longest timer Node runs, 2^31 - 1 ms. */
const MAX_TIMEOUT_SECONDS = 2_147_483;

/** `--timeout`, shared by `verify` and `status`. */
export const TIMEOUT_OPTION: OptionSpec = {
  type: "string",
  value: "<seconds>",
  description:
    "The time budget of the whole run, polling included, in whole seconds. Default 120. A run that ends pending exits 4 with the handle.",
};

/** `--poll-interval`, shared by `verify` and `status`. */
export const POLL_INTERVAL_OPTION: OptionSpec = {
  type: "string",
  value: "<seconds>",
  description:
    "The wait between two status polls of a submitted job, in whole seconds, at least 1. Default 3.",
};

// References: R-FLOW-7, decision 0066.
/** `--index-wait`, `verify` only: a resumed handle sends no submit. */
const INDEX_WAIT_OPTION: OptionSpec = {
  type: "string",
  value: "<seconds>",
  description:
    "etherscan-v2, routescan and etherscan-compatible only: how long to keep sending the submit while the explorer finds no contract code at the address, as right after a deployment. Whole seconds from 1 to 2147483, counted from the first submit, and capped by --timeout. Default: at most 10 submits, about 27 s at the default --poll-interval, so a value under about 30 waits less.",
};

/** The backends that send the submit again while the explorer finds no contract code. */
const INDEX_WAIT_BACKENDS: readonly string[] = [
  "etherscan-v2",
  "routescan",
  "etherscan-compatible",
];

/** `--input-json`, shared by `verify` and `status`. */
export function inputJsonOption(command: string): OptionSpec {
  return {
    type: "string",
    value: "<file>",
    description: `Read the whole ${command} request as JSON from this file, or from stdin when it is -. See input.schema.json in the explorer-verify package.`,
  };
}

/** `--allow-sourcify-fallback`, shared by `verify` and `status`. */
export const FALLBACK_OPTION: OptionSpec = {
  type: "boolean",
  description:
    "Send a chain that the routing table does not list to the public Sourcify API. No effect on a listed chain. Cannot be combined with --api-url or with a --backend other than sourcify.",
};

/**
 * Whether `--backend <name>` names a backend the Sourcify fallback never reaches. `auto` and `all`
 * go with the fallback: on a chain without a row, the routing table's picks are then Sourcify. A
 * name that is no backend is left to the route check, which names it.
 */
function fallbackNeverReaches(name: string): boolean {
  return name !== AUTO && name !== ALL && (toBackendName(name) ?? "sourcify") !== "sourcify";
}

/**
 * Throws the usage error of `--allow-sourcify-fallback` in a combination where it can change
 * nothing: with `--api-url`, which skips the routing table, or with a `--backend` other than
 * `sourcify`, which the fallback never reaches. A repeated `--backend` always names one such
 * backend. A name that is no backend is left to the route check, which names it.
 *
 * @param values - The option values to run with, the request's route included.
 * @param fieldNames - The request field behind each option that the request filled.
 * @throws ExplorerVerifyError `invalid-input`, exit code 2.
 */
export function checkFallback(
  values: ReadonlyMap<string, OptionValue>,
  fieldNames: ReadonlyMap<string, string>,
): void {
  if (values.get("allow-sourcify-fallback") !== true) {
    return;
  }
  const field = "--allow-sourcify-fallback";
  const issues: InputIssue[] = [];
  if (values.has("api-url")) {
    issues.push({
      field,
      message: `cannot be combined with ${fieldNames.get("--api-url") ?? "--api-url"}: the URL names the server, so the routing table is not used`,
    });
  }
  const backend = values.get("backend");
  const names = typeof backend === "string" ? [backend] : listOption(values, "backend");
  if (names.some(fallbackNeverReaches)) {
    issues.push({
      field,
      message: `cannot be combined with a ${fieldNames.get("--backend") ?? "--backend"} other than sourcify: the fallback only reaches Sourcify`,
    });
  }
  if (issues.length > 0) {
    throw usageError(issues);
  }
}

/**
 * The time budget of `--timeout` in milliseconds, `undefined` when it is absent, or an issue.
 *
 * @param values - The checked option values.
 * @param issues - Receives the issue.
 * @returns The budget.
 */
export function timeoutOf(
  values: ReadonlyMap<string, OptionValue>,
  issues: InputIssue[],
): number | undefined {
  return millisecondsOf(values, "timeout", issues);
}

/**
 * The wait between two polls of `--poll-interval` in milliseconds, `undefined` when it is absent,
 * or an issue.
 *
 * @param values - The checked option values.
 * @param issues - Receives the issue.
 * @returns The wait.
 */
export function pollIntervalOf(
  values: ReadonlyMap<string, OptionValue>,
  issues: InputIssue[],
): number | undefined {
  return millisecondsOf(values, "poll-interval", issues);
}

/**
 * How long `--index-wait` keeps sending the submit, in milliseconds, `undefined` when it is
 * absent, or an issue.
 *
 * @param values - The checked option values.
 * @param issues - Receives the issue.
 * @returns The wait.
 */
function indexWaitOf(
  values: ReadonlyMap<string, OptionValue>,
  issues: InputIssue[],
): number | undefined {
  return millisecondsOf(values, "index-wait", issues);
}

/** A whole number of seconds from 1 to the longest timer, in milliseconds, or an issue. */
function millisecondsOf(
  values: ReadonlyMap<string, OptionValue>,
  name: string,
  issues: InputIssue[],
): number | undefined {
  const value = stringOption(values, name);
  if (value === undefined) {
    return undefined;
  }
  const seconds = /^[1-9]\d{0,6}$/.test(value) ? Number(value) : Number.NaN;
  if (!(seconds <= MAX_TIMEOUT_SECONDS)) {
    issues.push({
      field: `--${name}`,
      message: `must be a whole number of seconds from 1 to ${String(MAX_TIMEOUT_SECONDS)}`,
    });
    return undefined;
  }
  return seconds * 1000;
}

/** The time settings of a run: `--timeout` and `--poll-interval`, each when given. */
export interface Timing {
  readonly timeoutMs: number | undefined;
  readonly pollIntervalMs: number | undefined;
}

/**
 * The options of a library call: the context's signal, logger, event writer, route and keys, the
 * Sourcify fallback of `--allow-sourcify-fallback`, and the time budget and the poll interval when
 * given.
 *
 * @param context - The command's context.
 * @param timing - The time budget and the poll interval, each if given.
 * @returns The options.
 */
export function callOptions(context: CommandContext, timing: Timing): CheckStatusOptions {
  const { signal, logger, onEvent } = context;
  const { apiKeys, route } = context.routeOptions();
  const { timeoutMs, pollIntervalMs } = timing;
  return {
    signal,
    logger,
    onEvent,
    ...(apiKeys === undefined ? {} : { apiKeys }),
    ...(route === undefined ? {} : { route }),
    ...(context.values.get("allow-sourcify-fallback") === true
      ? { allowSourcifyFallback: true }
      : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  };
}

/**
 * The verify request of `--input-json`: the fields of `VerifyInput`, and those of `compiler`,
 * which `input.schema.json` closes. A test checks them against the schema.
 */
export const VERIFY_REQUEST: JsonRequestSpec = {
  command: "verify",
  fields: [
    "chainId",
    "address",
    "compiler",
    "contractName",
    "constructorArgs",
    "creationTxHash",
    "creationBytecode",
    "libraries",
  ],
  nested: { compiler: ["kind", "version", "solcVersion", "solcFork", "input"] },
};

/** The request field of each route option, for an issue about one the request left out. */
const REQUEST_FIELD_NAMES: ReadonlyMap<string, string> = new Map([
  ["--backend", "route.backend"],
  ["--api-url", "route.apiUrl"],
]);

/** The chain id of `--chain`, or an issue and the closest chain name. */
function chainOf(
  values: ReadonlyMap<string, OptionValue>,
  issues: InputIssue[],
): { readonly chainId: number; readonly suggestion?: string } {
  const value = stringOption(values, "chain");
  if (value === undefined) {
    issues.push({
      field: "--chain",
      message: "is needed: the chain ID or name, such as 11155111 or sepolia",
    });
    return { chainId: 0 };
  }
  const read = chainIdOf(value);
  if ("chainId" in read) {
    return read;
  }
  issues.push(read.issue);
  return read.suggestion === undefined
    ? { chainId: 0 }
    : { chainId: 0, suggestion: read.suggestion };
}

/** The library addresses of `--library path:Name=address`, by name, or issues. */
function librariesOf(
  values: ReadonlyMap<string, OptionValue>,
  issues: InputIssue[],
): Record<string, string> | undefined {
  const given = listOption(values, "library");
  if (given.length === 0) {
    return undefined;
  }
  const libraries: [string, string][] = [];
  given.forEach((entry, index) => {
    const field = `--library[${String(index + 1)}]`;
    const at = entry.lastIndexOf("=");
    const name = entry.slice(0, at);
    if (at < 1 || at === entry.length - 1 || !name.includes(":")) {
      issues.push({ field, message: "must be path:Name=address" });
    } else if (libraries.some(([known]) => known === name)) {
      issues.push({ field, message: "names a library that an earlier --library names" });
    } else {
      libraries.push([name, entry.slice(at + 1)]);
    }
  });
  return Object.fromEntries(libraries);
}

/** The issue of an `--input` that names a folder: a project goes to `--foundry` or `--hardhat`. */
const FOLDER_INPUT_MESSAGE =
  "names a folder, not a file: for a Foundry or Hardhat project, pass --foundry <dir> or --hardhat <dir> with --contract path:Name";

/**
 * The issue of a command line with more arguments than `verify` takes. When `--artifact` or
 * `--input` is given, the extra argument is most likely a second file that a shell glob such as
 * `--input out/build-info/*.json` expanded to, so the issue says what the option takes.
 *
 * @param values - The checked option values.
 * @returns The issue, or `undefined` for the default one.
 */
function extraArgumentsIssue(values: ReadonlyMap<string, OptionValue>): InputIssue | undefined {
  if (values.has("artifact")) {
    return {
      field: "--artifact",
      message: "takes one file: name the artifact of the build you deployed",
    };
  }
  return values.has("input")
    ? { field: "--input", message: "takes one file; repeat --input for each" }
    : undefined;
}

/** The core's issue field for a library, `libraries.<n>`, counted from 1. */
const LIBRARY_FIELD = /^libraries\.(\d+)$/;

/** The CLI's words for the core's library issues: why the value is invalid and what to pass. */
const LIBRARY_MESSAGES: ReadonlyMap<string, string> = new Map([
  [
    "must be keyed by path:Name of compiler.input.sources",
    "must name a library in a source file of the build as path:Name before the =, with the source path the build uses, such as src/Lib.sol:Lib, or project/contracts/Lib.sol:Lib for Hardhat 3",
  ],
  [
    "must be 0x followed by 40 hex digits",
    "must give the library's address after the =, as 0x followed by 40 hex digits",
  ],
]);

/**
 * The core's `invalid-input` error for the input of the flags, as a usage error that names
 * `--library[n]` for each `libraries.<n>` issue. The `--library` values reach the core in the order
 * given, so position n of the core is the n-th `--library`. Any other error comes back as it is.
 */
function libraryUsageError(error: unknown): unknown {
  if (!(error instanceof ExplorerVerifyError) || error.details.code !== "invalid-input") {
    return error;
  }
  const { issues } = error.details;
  if (!issues.some((issue) => LIBRARY_FIELD.test(issue.field))) {
    return error;
  }
  return usageError(
    issues.map((issue) => {
      const position = LIBRARY_FIELD.exec(issue.field)?.[1];
      return position === undefined
        ? issue
        : {
            field: `--library[${position}]`,
            message: LIBRARY_MESSAGES.get(issue.message) ?? issue.message,
          };
    }),
  );
}

/** Reads every `--input` file, in order, or throws with an issue for each that fails. */
async function documentsOf(paths: readonly string[]): Promise<unknown[]> {
  const documents: unknown[] = [];
  const issues: InputIssue[] = [];
  for (const [index, path] of paths.entries()) {
    const read = await readJsonFile(path, `--input[${String(index + 1)}]`);
    if ("issue" in read) {
      issues.push(
        read.issue.message === FOLDER_MESSAGE
          ? { field: read.issue.field, message: FOLDER_INPUT_MESSAGE }
          : read.issue,
      );
    } else {
      documents.push(read.value);
    }
  }
  if (issues.length > 0) {
    throw usageError(issues);
  }
  return documents;
}

/** The input the flags describe: the build files, the address, the chain and the extras. */
async function inputFromFlags(context: PrepareContext): Promise<VerifyInput> {
  const { values, positionals } = context;
  const issues: InputIssue[] = [];
  const address = positionals[0];
  if (address === undefined) {
    issues.push({ field: "verify", message: "needs the contract address" });
  }
  const chain = chainOf(values, issues);
  const project = projectOf(values, issues);
  const paths = listOption(values, "input");
  const projectGiven = values.has("foundry") || values.has("hardhat");
  if (paths.length === 0 && !projectGiven) {
    issues.push({
      field: "--input",
      message:
        "is needed: a build file, --foundry or --hardhat with --contract, or the whole request with --input-json",
    });
  }
  const libraries = librariesOf(values, issues);
  if (issues.length > 0) {
    throw usageError(issues, chain.suggestion);
  }
  const contract = stringOption(values, "contract");
  const compilerVersion = stringOption(values, "compiler-version");
  const built =
    project === undefined
      ? buildVerifyInput(await documentsOf(paths), {
          ...(contract === undefined ? {} : { contract }),
          ...(compilerVersion === undefined ? {} : { compilerVersion }),
        })
      : await inputFromProject(project);
  const constructorArgs = stringOption(values, "constructor-args");
  const creationTxHash = stringOption(values, "creation-tx");
  try {
    return validateInput({
      chainId: chain.chainId,
      address,
      ...built,
      ...(constructorArgs === undefined ? {} : { constructorArgs }),
      ...(creationTxHash === undefined ? {} : { creationTxHash }),
      ...(libraries === undefined ? {} : { libraries }),
    });
  } catch (error) {
    throw libraryUsageError(error);
  }
}

/**
 * What a run sends besides the input: whether it is a dry run, the budget, the wait for the
 * explorer to index the contract, the RPC URL, the target
 * the caller named, and the field that names it, `--backend` or `route.backend`.
 */
interface SendSettings {
  readonly dry: boolean;
  readonly timing: Timing;
  /** The wait of `--index-wait`, when given. */
  readonly indexWaitMs: number | undefined;
  readonly rpcUrl: string | undefined;
  readonly target: Target;
  readonly field: string;
}

/**
 * Calls `verify()`, `dryRun()` for a dry run, or `verifyEach()` when `--backend` is repeated or
 * `all`, with the input and the context's options.
 */
async function send(
  context: CommandContext,
  input: VerifyInput,
  settings: SendSettings,
): Promise<CommandResult> {
  const { dry, timing, indexWaitMs, rpcUrl, target } = settings;
  // When the routing table chooses the backend, the routed line says which one and why, at info.
  const tableChooses = target === AUTO || target === undefined;
  const options: VerifyOptions = {
    ...callOptions(context, timing),
    ...(indexWaitMs === undefined ? {} : { indexWaitMs }),
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
    ...(context.values.get("submit-over-partial") === true ? { submitOverPartial: true } : {}),
    ...(tableChooses
      ? {
          onEvent: (event: VerifyEvent) => {
            context.onEvent(event, event.type === "verify.routed" ? "info" : undefined);
          },
        }
      : {}),
  };
  const { backends, route } = context.routeOptions();
  const named = backends ?? (route?.backend === undefined ? [] : [route.backend]);
  if (
    settings.indexWaitMs !== undefined &&
    target === "named" &&
    !named.some((name) => INDEX_WAIT_BACKENDS.includes(name))
  ) {
    context.logger.warn(
      `--index-wait has no effect on ${named.join(", ")}: only etherscan-v2, routescan and etherscan-compatible send the submit again while the explorer finds no contract code.`,
    );
  }
  if (target === ALL) {
    if (dry) {
      throw await allDryRunRefusal(input, settings.field);
    }
    const result = await verifyEach(input, { ...options, backends: ALL });
    // The library leaves out a backend that needs a key it lacks; the caller learns which (#225).
    const { listed } = await routesFor(input.chainId, {});
    const ran = result.outcomes.map((outcome) => outcome.backend);
    for (const line of skippedByAll(listed, ran)) {
      context.logger.warn(line);
    }
    return result;
  }
  if (backends !== undefined) {
    return await verifyEach(input, { ...options, backends });
  }
  if (target === undefined && !dry) {
    // A submit publishes source and cannot be undone, so the caller names where it goes.
    throw await refusal(input, options, settings.field);
  }
  return dry ? await dryRun(input, options) : await verify(input, options);
}

/** What `auto` and `all` let the routing table do, for an issue that combines one of them. */
const TABLE_WORDS: Readonly<Record<typeof AUTO | typeof ALL, string>> = {
  auto: "auto lets the routing table pick one",
  all: "all verifies on every backend the routing table lists for the chain",
};

// References: R-AX-8, R-AX-9, R-RT-4.
/**
 * The target of a run: `auto`, `all`, `named` for `--backend` naming
 * backends, or `undefined` when none is given. `auto` and `all` are removed from the values, so
 * the routing table picks the backends. Each stands alone: with another `--backend`, with
 * `--api-url` or with a key flag it is an issue, because none of them can say which backend they
 * are for. `all` with `--dry-run` is refused once the chain is known. `--api-url` needs `--backend`
 * naming the backend that serves that API. `fieldNames` gives the request field of each option that
 * `--input-json` filled.
 */
function targetOf(
  values: ReadonlyMap<string, OptionValue>,
  fieldNames: ReadonlyMap<string, string>,
): { readonly values: ReadonlyMap<string, OptionValue>; readonly target: Target } {
  const name = (option: string): string => fieldNames.get(option) ?? option;
  const backend = values.get("backend");
  const names = typeof backend === "string" ? [backend] : listOption(values, "backend");
  const issues: InputIssue[] = [];
  const table = names.find((each) => each === AUTO || each === ALL);
  if (values.has("api-url") && (names.length === 0 || table !== undefined)) {
    issues.push({
      field: name("--api-url"),
      message: `needs ${name("--backend")} naming the backend that serves this API${table === undefined ? "" : `, not ${table}: the URL replaces the routing table`}`,
    });
  }
  if (table !== undefined && names.length > 1) {
    issues.push({
      field: name("--backend"),
      message: `cannot combine ${table} with another backend: ${TABLE_WORDS[table]}`,
    });
  }
  for (const option of ["--api-key-file", "--api-key-stdin"]) {
    if (table !== undefined && values.has(option.slice(2))) {
      issues.push({
        field: option,
        message: `cannot be used with ${name("--backend")} ${table}: name the backend the key is for`,
      });
    }
  }
  if (issues.length > 0) {
    throw usageError(issues);
  }
  if (table === undefined) {
    return { values, target: names.length > 0 ? "named" : undefined };
  }
  const without = new Map(values);
  without.delete("backend");
  return { values: without, target: table };
}

/**
 * Reads the request, from the flags or from `--input-json`, before the keys are read. The RPC URL
 * is read first, so its parts that can hold a key are secrets before anything else can fail.
 */
async function prepare(context: PrepareContext): Promise<Prepared> {
  const { values } = context;
  const issues: InputIssue[] = [];
  const timing: Timing = {
    timeoutMs: timeoutOf(values, issues),
    pollIntervalMs: pollIntervalOf(values, issues),
  };
  const indexWaitMs = indexWaitOf(values, issues);
  const rpc = await readRpcUrl(context);
  if (rpc.issues !== undefined) {
    throw usageError([...issues, ...rpc.issues]);
  }
  const dry = values.get("dry-run") === true;
  if (dry && listOption(values, "backend").length > 1) {
    issues.push({
      field: "--dry-run",
      message: "cannot be combined with a repeated --backend: dry run one backend at a time",
    });
  }
  if (issues.length > 0) {
    throw usageError(issues);
  }
  const sent = { dry, timing, indexWaitMs, rpcUrl: rpc.rpcUrl };
  const path = stringOption(values, "input-json");
  if (path === undefined) {
    checkFallback(values, new Map());
    const chosen = targetOf(values, new Map());
    const input = await inputFromFlags(context);
    const settings: SendSettings = { ...sent, target: chosen.target, field: "--backend" };
    return { values: chosen.values, run: async (run) => await send(run, input, settings) };
  }
  const request = await readJsonRequest(
    { path, values, positionals: context.positionals, stdin: context.stdin },
    VERIFY_REQUEST,
  );
  checkFallback(request.values, request.fieldNames);
  const chosen = targetOf(request.values, new Map([...REQUEST_FIELD_NAMES, ...request.fieldNames]));
  const input = validateInput(Object.fromEntries(request.fields));
  const settings: SendSettings = { ...sent, target: chosen.target, field: "route.backend" };
  return {
    values: chosen.values,
    fieldNames: request.fieldNames,
    run: async (run) => await send(run, input, settings),
  };
}

const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const FOUNDRY = "--foundry . --contract src/Greeter.sol:Greeter";

/** The options of `verify`, in help order. */
const OPTIONS: OptionSpecs = {
  // The route option, repeatable here only: a repeated --backend runs verifyEach() (R-RT-4).
  backend: {
    type: "string",
    value: "<name>",
    multiple: true,
    description: `Where to submit: ${BACKEND_NAMES.join(", ")}; auto for the routing table's pick; or all for every backend of the chain's row that can run, not with --dry-run. Needed to submit; a dry run takes one backend or none. Give it more than once to verify on each backend named in one run.`,
  },
  chain: {
    type: "string",
    short: "c",
    value: "<chain>",
    description:
      "The chain the contract is deployed on: its ID, such as 11155111, or its name, such as sepolia. The CLI reference lists the names.",
  },
  ...PROJECT_OPTIONS,
  contract: {
    type: "string",
    value: "<path:Name>",
    description:
      "The contract as path:Name, such as src/Greeter.sol:Greeter, or as Name when one contract has that name. Needed with --foundry and --hardhat, and when the build files hold several.",
  },
  input: {
    type: "string",
    short: "i",
    value: "<file>",
    multiple: true,
    description:
      "A build file: a build-info, an artifact, Solidity metadata or a Standard JSON input. Repeat it for each file. In a project, use --foundry or --hardhat instead.",
  },
  "compiler-version": {
    type: "string",
    value: "<version>",
    description: "The full solc version, such as 0.8.24+commit.e11b9ed9, when the files lack it.",
  },
  "constructor-args": {
    type: "string",
    value: "<hex>",
    description: "The ABI-encoded constructor arguments, 0x first, without the selector.",
  },
  "creation-tx": {
    type: "string",
    value: "<hash>",
    description: "The hash of the transaction that created the contract.",
  },
  library: {
    type: "string",
    value: "<path:Name=address>",
    multiple: true,
    description: "The address of a linked library.",
  },
  timeout: TIMEOUT_OPTION,
  "poll-interval": POLL_INTERVAL_OPTION,
  "index-wait": INDEX_WAIT_OPTION,
  ...RPC_URL_OPTIONS,
  "allow-sourcify-fallback": FALLBACK_OPTION,
  "submit-over-partial": {
    type: "boolean",
    description:
      "Submit when the explorer holds only a partial match of this contract's source, so it can replace it with an exact one. An exact match never submits. On Routescan every match is partial, so it submits over every match, and Routescan replaces the source it holds, an exact one included.",
  },
  "require-own-source": REQUIRE_OWN_SOURCE_OPTION,
  "dry-run": {
    type: "boolean",
    short: "n",
    description:
      "Check the input, resolve the route and look the contract up, then stop before the submit. Needs no API key.",
  },
  "input-json": inputJsonOption("verify"),
};

/** The `verify` row of the command table. */
export const VERIFY: Command = {
  name: "verify",
  routed: true,
  summary:
    "Verify a deployed contract's source. Looks it up first, and submits only when the explorer lacks it.",
  usage: "<address> --chain <chain> --input <file>... (--backend <name> | --dry-run)",
  moreUsage: [
    "<address> --chain <chain> (--foundry <dir> | --hardhat <dir>) --contract <path:Name> (--backend <name> | --dry-run)",
    "--input-json <file>",
  ],
  examples: [
    {
      args: `verify ${ADDRESS} --chain 11155111 ${FOUNDRY} --dry-run --json`,
      description:
        "Check the Greeter of the Foundry project in this folder and look it up, without submitting: one envelope.",
    },
    {
      args: `${ADDRESS} -c sepolia ${FOUNDRY} --backend sourcify`,
      description:
        "Verify on Sourcify from the Foundry project's build; the address may come first, without verify, and the chain may be a name.",
    },
    {
      args: `verify ${ADDRESS} --chain 11155111 ${FOUNDRY} --backend auto`,
      description:
        "Verify where the routing table points: the first backend the chain lists that needs no key or has one.",
    },
    {
      args: `verify ${ADDRESS} --chain 999999 ${FOUNDRY} --allow-sourcify-fallback --dry-run --json`,
      description:
        "Check a contract on a chain that the routing table does not list, on the public Sourcify API.",
    },
    {
      args: `verify ${ADDRESS} --chain 11155111 --input build/build-info.json --input build/Greeter.json --backend sourcify`,
      description:
        "Verify from build files kept outside a project, such as those a package ships: repeat --input for each file.",
    },
    {
      args: "verify --input-json verify-input.json --json",
      description:
        "Verify the request in a JSON file, as validateInput() returns it, with route.backend naming where to submit.",
    },
  ],
  options: OPTIONS,
  maxPositionals: 1,
  extraArguments: extraArgumentsIssue,
  prepare,
};
