/**
 * Constructor argument derivation (R-IN-3): the creation code minus the compiled creation bytecode
 * is the ABI-encoded arguments. `verify()` runs it before a submit when the caller passed no
 * `constructorArgs`, the route's backend sends arguments, and the input holds `creationBytecode`.
 * What happens when it cannot derive them is decision 0032. `verify()` loads this module with a
 * dynamic `import()` only when it derives (decision 0031). Internal: the package entry point does
 * not export it.
 */
import type { Backend, Context, Target } from "../backends/backend.ts";
import { newError } from "../error-hints.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { ErrorDetails } from "../errors.ts";
import { keyFor } from "../http/api-keys.ts";
import { request } from "../http/fetch.ts";
import type { HttpContext } from "../http/fetch.ts";
import { hexQuantity, RPC_BODY_BYTES, rpcRequest, rpcResult } from "../http/rpc.ts";
import type { Endpoint } from "../http/rpc.ts";
import { readFields } from "../internal/read-fields.ts";
import type { Observer } from "../observe.ts";
import type { Hex, Logger, VerifyInput } from "../types.ts";

/** Why the creation code shows the arguments cannot be derived. */
type Mismatch = Extract<ErrorDetails, { code: "constructor-args-unavailable" }>["reason"];

/**
 * Why no arguments were derived, when the call goes on without them (decision 0032):
 *
 * - `no-source`: nothing to ask, neither `rpcUrl` with `creationTxHash` nor an explorer source;
 * - `no-creation-code`: every source asked gave no usable answer;
 * - `factory-deployment`: the transaction did not create the contract directly, and no explorer
 *   gave its creation code;
 * - `prefix-mismatch` or `bad-length`, on a backend that does not refuse another build.
 */
type SkipReason = "no-source" | "no-creation-code" | "factory-deployment" | Mismatch;

/** What {@link deriveConstructorArgs} found: the arguments, or why there are none. */
type Derived = { readonly args: Hex } | { readonly skipped: SkipReason };

/**
 * Where the creation code may come from, in the order they are asked.
 *
 * @example
 * ```ts
 * const sources: CreationSources = {
 *   rpc: { endpoint, http },
 *   explorer: async () => await etherscan.creationCode?.(target, ctx),
 *   log,
 *   strict: true,
 * };
 * ```
 */
interface CreationSources {
  /**
   * The caller's `rpcUrl` and the HTTP context of its requests. It is asked only when the input
   * has `creationTxHash`.
   */
  readonly rpc?: { readonly endpoint: Endpoint; readonly http: HttpContext };
  /**
   * The explorer's creation code for the contract, as Etherscan's `getcontractcreation` gives it,
   * or `undefined` when it has no record. Absent when the explorer cannot be asked.
   */
  readonly explorer?: () => Promise<string | undefined>;
  /** The call's logger, which removes the call's secrets. */
  readonly log: Logger;
  /**
   * Whether a creation code that does not match `creationBytecode` throws. Set for a backend that
   * would refuse a build other than the deployed one; otherwise the call goes on without arguments.
   */
  readonly strict: boolean;
}

/**
 * The explorer errors that mean "no answer this time". The explorer source then counts as giving
 * no answer, as a JSON-RPC endpoint that fails does.
 */
const NO_ANSWER: readonly ExplorerVerifyError["code"][] = [
  "network",
  "rate-limited",
  "unexpected-response",
];

/**
 * The CREATE2 deployer most tools use (`0x4e59...956C`). A call to it holds a 32-byte salt and
 * then the init code, so the init code is the input after the salt.
 */
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
// The salt, as hex digits.
const SALT_DIGITS = 64;
// A library placeholder of solc 0.5.0 and later: `__$`, 34 hex digits and `$__`, 20 bytes.
const PLACEHOLDER = /__\$[0-9a-f]{34}\$__/;
// One ABI word, as hex digits.
const WORD_DIGITS = 64;
const HEX = /^0x[0-9a-fA-F]*$/;

/** What {@link withDerivedArgs} reads from a `verify()` call. */
export interface DeriveCall {
  /** The loaded client of the route's backend. */
  readonly backend: Backend;
  readonly ctx: Context;
  readonly settings: { readonly rpcUrl: Endpoint | undefined };
  readonly observer: Observer;
  readonly target: Target;
}

/** Why no constructor arguments were derived, as the log line says it (decision 0032). */
const SKIPPED: Record<SkipReason, string> = {
  "no-source": "No rpcUrl with creationTxHash and no explorer key to read the creation code",
  "no-creation-code": "No source gave the creation code",
  "factory-deployment":
    "creationTxHash did not create the contract directly: a factory did, or it names another transaction",
  "prefix-mismatch": "The creation code does not start with creationBytecode",
  "bad-length": "What follows creationBytecode is not whole 32-byte words",
};

/**
 * `input` with the constructor arguments derived from the creation code (R-IN-3). When no
 * arguments are derived, it logs why and returns `input` unchanged, so the submit goes out without
 * arguments as before: at `info` when no source is configured, at `warn` otherwise (decision
 * 0032). A mismatch on a backend that refuses another build throws instead. Requests to `rpcUrl`
 * share the call's budget, signal and observer. Their log lines carry `label: "rpc"` and no
 * backend name, and their retries emit no `verify.retry` event, which names a backend. A `timeout`
 * error still names the route's backend: the budget is the call's.
 *
 * @param call - The `verify()` call, with its loaded client.
 * @param input - The checked input.
 * @param creationBytecode - `input.creationBytecode`.
 * @returns `input`, with `constructorArgs` when they were derived.
 * @throws What {@link deriveConstructorArgs} throws.
 * @example
 * ```ts
 * const resolved = await withDerivedArgs(call, checked, checked.creationBytecode);
 * ```
 */
export async function withDerivedArgs(
  call: DeriveCall,
  input: VerifyInput,
  creationBytecode: Hex,
): Promise<VerifyInput> {
  const { backend, ctx, settings, observer, target } = call;
  const { rpcUrl } = settings;
  const { creationCode } = backend;
  const { secrets, budget, fetch, signal, random } = ctx.http;
  const http: HttpContext = {
    backend: backend.name,
    label: "rpc",
    observer,
    secrets,
    maxResponseBytes: RPC_BODY_BYTES,
    // request() reads an undefined field as an absent one.
    signal,
    random,
    budget,
    fetch,
  };
  // The explorer source needs a key bound to the route: a keyless request may reach a server
  // handler, which does not forward it.
  const explorer =
    creationCode === undefined || keyFor(ctx, backend.name, ctx.route.apiBase) === undefined
      ? {}
      : { explorer: async () => await creationCode(target, ctx) };
  const derived = await deriveConstructorArgs(
    { ...input, creationBytecode },
    {
      ...(rpcUrl === undefined ? {} : { rpc: { endpoint: rpcUrl, http } }),
      ...explorer,
      log: observer.log,
      strict: backend.refusesOtherBuilds === true,
    },
  );
  const fields = { backend: backend.name };
  if ("skipped" in derived) {
    const reason = derived.skipped;
    const line = `${SKIPPED[reason]}; submitting without constructor arguments (${reason})`;
    if (reason === "no-source") {
      observer.log.info(line, { ...fields, reason });
    } else {
      observer.log.warn(line, { ...fields, reason });
    }
    return input;
  }
  observer.log.info("Derived the constructor arguments from the creation code", {
    ...fields,
    bytes: (derived.args.length - 2) / 2,
  });
  return { ...input, constructorArgs: derived.args };
}

/**
 * The ABI-encoded constructor arguments of `input.address`, derived from its creation code
 * (R-IN-3).
 *
 * 1. With `sources.rpc` and `input.creationTxHash`: reads `eth_chainId`, then the transaction.
 *    A transaction to the CREATE2 deployer gives the init code after its salt. A transaction with
 *    a `to` of `null`, or none, is read with its receipt: when the receipt's `contractAddress` is
 *    the contract, the transaction input is the creation code. Any other transaction did not
 *    create the contract directly: a factory did, or `creationTxHash` names another transaction.
 * 2. Else, or when the endpoint gives no usable answer: the explorer's creation code. An explorer
 *    error that means "no answer this time" (`network`, `rate-limited`, `unexpected-response`) is
 *    logged and counts as no answer.
 * 3. The creation code must start with `input.creationBytecode`, comparing every byte except the
 *    20-byte spans of `__$...$__` library placeholders. The rest is the arguments: a whole number
 *    of 32-byte words, `0x` when empty.
 *
 * @param input - The checked input, with `creationBytecode` in lower case with `0x`.
 * @param sources - Where to read the creation code, and whether a mismatch throws.
 * @returns The arguments, `0x` and lower-case hex, or why there are none (decision 0032).
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts.
 * @throws ExplorerVerifyError `constructor-args-unavailable` with `details.reason`
 *   `prefix-mismatch` or `bad-length` when `sources.strict` is set; `invalid-input` naming
 *   `rpcUrl` when its chain id is another chain's; `timeout` when the budget runs out; and a key
 *   error the explorer gives, such as `api-key-rejected`.
 * @example
 * ```ts
 * const sources = { rpc: { endpoint, http }, log, strict: true };
 * const derived = await deriveConstructorArgs(checked, sources);
 * ```
 */
async function deriveConstructorArgs(
  input: VerifyInput & { readonly creationBytecode: Hex },
  sources: CreationSources,
): Promise<Derived> {
  const { rpc, explorer, log } = sources;
  const txHash = input.creationTxHash;
  if ((rpc === undefined || txHash === undefined) && explorer === undefined) {
    return { skipped: "no-source" };
  }
  const fromRpc =
    rpc === undefined || txHash === undefined
      ? undefined
      : await readCreation(input, txHash, rpc, log);
  // "factory" is a reason, not a creation code.
  let code = fromRpc === "factory" ? undefined : fromRpc;
  if (code === undefined && explorer !== undefined) {
    try {
      code = await explorer();
    } catch (error: unknown) {
      if (!(error instanceof ExplorerVerifyError) || !NO_ANSWER.includes(error.code)) {
        throw error;
      }
      log.warn("The explorer gave no creation code this time", { code: error.code });
    }
  }
  if (code === undefined) {
    return { skipped: fromRpc === "factory" ? "factory-deployment" : "no-creation-code" };
  }
  const derived = argumentsOf(code.toLowerCase(), input.creationBytecode);
  if (typeof derived !== "string" && sources.strict) {
    throw mismatch(derived.skipped, input);
  }
  return typeof derived === "string" ? { args: derived } : derived;
}

/**
 * The creation code from the transaction, `factory` when the transaction did not create the
 * contract directly, or `undefined` when the endpoint gave no usable answer.
 */
async function readCreation(
  input: VerifyInput,
  txHash: Hex,
  rpc: NonNullable<CreationSources["rpc"]>,
  log: Logger,
): Promise<string | undefined> {
  const served = hexQuantity(await rpcCall(rpc, "eth_chainId", []));
  if (served !== undefined && served !== input.chainId) {
    throw newError(
      {
        code: "invalid-input",
        issues: [{ field: "rpcUrl", message: "serves another chain than chainId" }],
      },
      "The options are invalid: rpcUrl.",
      {
        hint: "Pass a JSON-RPC endpoint of the contract's chain as rpcUrl.",
        secrets: rpc.http.secrets,
      },
    );
  }
  const tx =
    served === undefined
      ? undefined
      : readFields(await rpcCall(rpc, "eth_getTransactionByHash", [txHash]));
  const to = tx?.get("to");
  const data = tx?.get("input");
  if (typeof data !== "string" || !HEX.test(data)) {
    log.warn("rpcUrl: no usable creation transaction", {});
    return undefined;
  }
  if (typeof to === "string") {
    return to.toLowerCase() === CREATE2_DEPLOYER ? `0x${data.slice(2 + SALT_DIGITS)}` : "factory";
  }
  // A `to` of `null`, or none: the receipt says which contract the transaction created.
  const created = readFields(await rpcCall(rpc, "eth_getTransactionReceipt", [txHash]))?.get(
    "contractAddress",
  );
  if (typeof created !== "string") {
    log.warn("rpcUrl: no usable receipt for the creation transaction", {});
    return undefined;
  }
  return created.toLowerCase() === input.address ? data : "factory";
}

/**
 * One JSON-RPC call's `result`, or `undefined` when the endpoint gave none or the request failed
 * after the HTTP layer's retries. The budget running out throws `timeout`, and an abort throws.
 */
async function rpcCall(
  rpc: NonNullable<CreationSources["rpc"]>,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const { http, endpoint } = rpc;
  try {
    const response = await request(http, rpcRequest(endpoint, method, params));
    const result = rpcResult(response.status, await response.text());
    return result ?? undefined;
  } catch (error: unknown) {
    if (http.signal?.aborted === true || !(error instanceof ExplorerVerifyError)) {
      throw error;
    }
    if (error.details.code === "timeout") {
      // The details name the route's backend; the message names the endpoint that ran out.
      throw newError(
        error.details,
        `The time budget ran out while reading the creation transaction from rpcUrl (${method}).`,
        // Stryker disable next-line ObjectLiteral: equivalent. The details come redacted from the first error, and the message names only the method.
        { secrets: http.secrets },
      );
    }
    return undefined;
  }
}

/** The arguments after `compiled` in `code`, or why they cannot be derived. */
function argumentsOf(code: string, compiled: string): Hex | { readonly skipped: Mismatch } {
  const prefix = compiled.slice(2);
  const body = code.replace(/^0x/, "");
  let offset = 0;
  for (const part of prefix.split(PLACEHOLDER)) {
    if (!body.startsWith(part, offset)) {
      return { skipped: "prefix-mismatch" };
    }
    // Each part but the last is followed by a placeholder: 40 hex digits of any value.
    offset += part.length + 40;
  }
  const rest = body.slice(prefix.length);
  if (body.length < prefix.length) {
    return { skipped: "prefix-mismatch" };
  }
  return rest.length % WORD_DIGITS === 0 ? `0x${rest}` : { skipped: "bad-length" };
}

function mismatch(reason: Mismatch, input: VerifyInput): ExplorerVerifyError {
  return newError(
    { code: "constructor-args-unavailable", reason },
    reason === "prefix-mismatch"
      ? `The creation code of ${input.address} does not start with creationBytecode: the input differs from the deployed build.`
      : `What follows creationBytecode in the creation code of ${input.address} is not whole 32-byte words.`,
    // Stryker disable next-line ObjectLiteral,ArrayDeclaration: equivalent. The message holds only the address, never a key.
    { secrets: [] },
  );
}
