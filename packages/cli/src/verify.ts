/**
 * The `verify` command (R-DX-1, R-AX-8, R-AX-16): reads the build files of `--input`, or the whole
 * request of `--input-json`, builds and checks the input, then calls `verify()`, or `dryRun()`
 * with `--dry-run`. The address may come first, without the word `verify`.
 */
import { buildVerifyInput, dryRun, validateInput, verify } from "explorer-verify";
import type { InputIssue, VerifyInput, VerifyOptions } from "explorer-verify";

import type { OptionSpec, OptionSpecs, OptionValue } from "./arguments.ts";
import { listOption, stringOption, usageError } from "./command.ts";
import type {
  Command,
  CommandContext,
  CommandResult,
  PrepareContext,
  Prepared,
} from "./command.ts";
import { readJsonFile, readJsonRequest } from "./request.ts";
import type { JsonRequestSpec } from "./request.ts";

/** The longest `--timeout` in seconds: the longest timer Node runs, 2^31 - 1 ms. */
const MAX_TIMEOUT_SECONDS = 2_147_483;

/** `--timeout`, shared by `verify` and `status`. */
export const TIMEOUT_OPTION: OptionSpec = {
  type: "string",
  value: "<seconds>",
  description:
    "The time budget of the whole run, polling included, in whole seconds. Default 120. A run that ends pending exits 4 with the handle.",
};

/** `--input-json`, shared by `verify` and `status`. */
export function inputJsonOption(command: string): OptionSpec {
  return {
    type: "string",
    value: "<file>",
    once: true,
    description: `Read the whole ${command} request as JSON from this file, or from stdin when it is -. See input.schema.json in the explorer-verify package.`,
  };
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
  const value = stringOption(values, "timeout");
  if (value === undefined) {
    return undefined;
  }
  const seconds = /^[1-9]\d{0,6}$/.test(value) ? Number(value) : Number.NaN;
  if (!(seconds <= MAX_TIMEOUT_SECONDS)) {
    issues.push({
      field: "--timeout",
      message: `must be a whole number of seconds from 1 to ${String(MAX_TIMEOUT_SECONDS)}`,
    });
    return undefined;
  }
  return seconds * 1000;
}

/**
 * The options of a library call: the context's signal, logger, event writer, route and keys, and
 * the time budget when one was given.
 *
 * @param context - The command's context.
 * @param timeoutMs - The time budget, if any.
 * @returns The options.
 */
export function callOptions(context: CommandContext, timeoutMs: number | undefined): VerifyOptions {
  const { signal, logger, onEvent } = context;
  return {
    signal,
    logger,
    onEvent,
    ...context.routeOptions(),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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
  nested: { compiler: ["kind", "version", "input"] },
};

/** A chain id: a positive whole number with no leading zero. */
const CHAIN_ID = /^[1-9]\d{0,15}$/;

/** The chain id of `--chain`, or an issue. */
function chainOf(values: ReadonlyMap<string, OptionValue>, issues: InputIssue[]): number {
  const value = stringOption(values, "chain");
  if (value === undefined) {
    issues.push({ field: "--chain", message: "is needed: the chain ID, such as 11155111" });
    return 0;
  }
  const chainId = CHAIN_ID.test(value) ? Number(value) : 0;
  if (!Number.isSafeInteger(chainId) || chainId === 0) {
    issues.push({ field: "--chain", message: "must be a positive whole number" });
    return 0;
  }
  return chainId;
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

/** Reads every `--input` file, in order, or throws with an issue for each that fails. */
async function documentsOf(paths: readonly string[]): Promise<unknown[]> {
  const documents: unknown[] = [];
  const issues: InputIssue[] = [];
  for (const [index, path] of paths.entries()) {
    const read = await readJsonFile(path, `--input[${String(index + 1)}]`);
    if ("issue" in read) {
      issues.push(read.issue);
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
  const chainId = chainOf(values, issues);
  const paths = listOption(values, "input");
  if (paths.length === 0) {
    issues.push({
      field: "--input",
      message: "is needed: a build file, or the whole request with --input-json",
    });
  }
  const libraries = librariesOf(values, issues);
  if (issues.length > 0) {
    throw usageError(issues);
  }
  const contract = stringOption(values, "contract");
  const compilerVersion = stringOption(values, "compiler-version");
  const built = buildVerifyInput(await documentsOf(paths), {
    ...(contract === undefined ? {} : { contract }),
    ...(compilerVersion === undefined ? {} : { compilerVersion }),
  });
  const constructorArgs = stringOption(values, "constructor-args");
  const creationTxHash = stringOption(values, "creation-tx");
  return validateInput({
    chainId,
    address,
    ...built,
    ...(constructorArgs === undefined ? {} : { constructorArgs }),
    ...(creationTxHash === undefined ? {} : { creationTxHash }),
    ...(libraries === undefined ? {} : { libraries }),
  });
}

/** Calls `verify()`, or `dryRun()` for a dry run, with the input and the context's options. */
async function send(
  context: CommandContext,
  input: VerifyInput,
  dry: boolean,
  timeoutMs: number | undefined,
): Promise<CommandResult> {
  const options = callOptions(context, timeoutMs);
  return dry ? await dryRun(input, options) : await verify(input, options);
}

/** Reads the request, from the flags or from `--input-json`, before the keys are read. */
async function prepare(context: PrepareContext): Promise<Prepared> {
  const { values } = context;
  const issues: InputIssue[] = [];
  const timeoutMs = timeoutOf(values, issues);
  if (issues.length > 0) {
    throw usageError(issues);
  }
  const dry = values.get("dry-run") === true;
  const path = stringOption(values, "input-json");
  if (path === undefined) {
    const input = await inputFromFlags(context);
    return { values, run: async (run) => await send(run, input, dry, timeoutMs) };
  }
  const request = await readJsonRequest(
    { path, values, positionals: context.positionals, stdin: context.stdin },
    VERIFY_REQUEST,
  );
  const input = validateInput(Object.fromEntries(request.fields));
  return {
    values: request.values,
    fieldNames: request.fieldNames,
    run: async (run) => await send(run, input, dry, timeoutMs),
  };
}

const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const FOUNDRY_FILES = "--input out/build-info/greeter.json --input out/Greeter.sol/Greeter.json";

/** The options of `verify`, in help order. */
const OPTIONS: OptionSpecs = {
  chain: {
    type: "string",
    value: "<id>",
    description: "The chain ID the contract is deployed on, such as 11155111.",
  },
  input: {
    type: "string",
    value: "<file>",
    multiple: true,
    description:
      "A build file: a build-info, an artifact, Solidity metadata or a Standard JSON input.",
  },
  contract: {
    type: "string",
    value: "<path:Name>",
    description: "The contract, such as src/Greeter.sol:Greeter, when the files hold several.",
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
  "dry-run": {
    type: "boolean",
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
  usage: "<address>",
  examples: [
    {
      args: `verify ${ADDRESS} --chain 11155111 ${FOUNDRY_FILES} --dry-run --json`,
      description:
        "Check a Foundry build and look the contract up, without submitting: one envelope.",
    },
    {
      args: `${ADDRESS} --chain 11155111 ${FOUNDRY_FILES}`,
      description:
        "Verify from a Foundry build-info and artifact; the address may come first, without verify.",
    },
    {
      args: "verify --input-json verify-input.json --json",
      description: "Verify the request in a JSON file, as validateInput() returns it.",
    },
  ],
  options: OPTIONS,
  maxPositionals: 1,
  prepare,
};
