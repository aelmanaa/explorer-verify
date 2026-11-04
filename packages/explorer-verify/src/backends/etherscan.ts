/**
 * The Etherscan API v2 client (R-BE-1). One API base serves every chain, with `chainid` in the
 * query of each request. Every request is a form-encoded POST, so the key goes in the body and
 * never in the URL (decision 0016, R-SEC-1).
 *
 * Etherscan answers almost everything with HTTP 200 and puts the meaning in the `result` text. The
 * client maps each known text to an outcome or a typed error; a text it does not know is never
 * read as success, "not verified" or `failed` (R-FLOW-4). The evidence for each mapping is in
 * docs/contributor/research/2026-11-04-etherscan-client.md.
 */
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import { JOB_ID } from "../flow/handle.ts";
import { keyErrorOf, withKey } from "../http/api-keys.ts";
import { sleep } from "../http/fetch.ts";
import type { HttpRequest, RetryMode } from "../http/fetch.ts";
import { readFields } from "../internal/read-fields.ts";
import { redactExcerpt } from "../redact.ts";
import type { Handle } from "../types.ts";
import type {
  Backend,
  Context,
  Match,
  PollOutcome,
  ResolvedInput,
  SubmitOutcome,
  Target,
} from "./backend.ts";
import {
  attemptSubmit,
  checkHandle,
  REASON_LENGTH,
  send,
  submitOnce,
  UNCONFIRMED_STATUSES,
} from "./common.ts";
import type { Answer, SubmitAttempt } from "./common.ts";

const NAME: BackendName = "etherscan-v2";
const LABEL = "Etherscan";
/**
 * The wait between two submits for a contract Etherscan has not indexed yet, when the context has
 * no `pollIntervalMs`. `verify()` always sets it; a client called on its own may not.
 */
const NOT_INDEXED_WAIT_MS = 3_000;
/** The most submits sent while Etherscan finds no contract code at the address, the first included. */
export const MAX_NOT_INDEXED_TRIES = 10;
const NOT_INDEXED_HINT =
  "Check that chainId and address name a contract deployed on that chain. If it was deployed moments ago, call verify() again once the explorer shows it.";

// The `result` texts the client knows, matched at the start. Sources: the research note above.
const RATE_LIMIT = "Max calls per sec rate limit reached";
const NOT_INDEXED = "Unable to locate ContractCode at";
const NO_CHAIN = "Missing or unsupported chainid parameter";
const V1_ENDPOINT = "You are using a deprecated V1 endpoint";
const PENDING = "Pending in queue";
const PASS = "Pass - Verified";
const FAIL = "Fail - Unable to verify";
const ALREADY_VERIFIED: readonly string[] = [
  "Contract source code already verified",
  "Already Verified",
];
const NO_JOB: readonly string[] = ["Unable to locate guid", "Invalid GUID length"];

/**
 * The Etherscan API v2 client. Every request is
 * `POST https://api.etherscan.io/v2/api?chainid=<id>` with a form body that holds `module=contract`,
 * the action and its fields, and the key as `apikey`.
 *
 * | Call   | `action`            | Fields                                                    |
 * | ------ | ------------------- | --------------------------------------------------------- |
 * | lookup | `getsourcecode`     | `address`                                                 |
 * | submit | `verifysourcecode`  | the Standard JSON input, the contract, compiler, arguments |
 * | poll   | `checkverifystatus` | `guid`                                                    |
 *
 * `Max calls per sec rate limit reached` is retried by the HTTP layer as a 429 is. A daily limit
 * throws `quota-exceeded`, and a key answer `missing-api-key` or `api-key-rejected`, at once.
 *
 * @example
 * ```ts
 * const ctx: Context = {
 *   route: resolveRoute(11155111, { backend: "etherscan-v2" }, { apiKeys }),
 *   apiKeys: () => apiKeys,
 *   http: { backend: "etherscan-v2", secrets: [apiKeys["etherscan-v2"]] },
 * };
 * const match = await etherscan.lookup({ chainId: 11155111, address }, ctx);
 * ```
 */
export const etherscan: Backend = {
  name: NAME,
  lookup,
  submit,
  poll,
  explorerUrl,
};

/**
 * Asks Etherscan whether the contract is verified, with `getsourcecode`. A first result with a
 * non-empty `SourceCode` is a match: `partial` when `SimilarMatch` names another contract, else
 * `exact`. An empty `SourceCode` is "not verified". Every other answer throws.
 */
async function lookup(target: Target, ctx: Context): Promise<Match | undefined> {
  const answer = await send(
    ctx,
    form(ctx, NAME, { action: "getsourcecode", address: target.address }, "safe"),
  );
  known(ctx, answer, target.chainId);
  const result = answer.fields?.get("result");
  if (answer.status === 200 && answer.fields?.get("status") === "1" && Array.isArray(result)) {
    const first = readFields(result[0]);
    const source = first?.get("SourceCode");
    if (typeof source === "string") {
      if (source === "") {
        return undefined;
      }
      const similar = first?.get("SimilarMatch");
      if (similar === undefined || similar === "") {
        return "exact";
      }
      // Similar Match: Etherscan matched the contract from another contract's verified source.
      if (typeof similar === "string") {
        return "partial";
      }
    }
  }
  throw unexpected(ctx, answer, "the lookup");
}

/** The contract's page from the routing table, such as `https://sepolia.etherscan.io/address/<address>#code`. */
function explorerUrl(target: Target, ctx: Context): string | undefined {
  return ctx.route.explorerUrl?.(target.address);
}

/**
 * Submits the source with `verifysourcecode`. A submit that may have reached Etherscan without an
 * answer (no response, a 500, 502 or 504, or a 200 whose body failed, stalled or is not JSON) is
 * never sent again blindly: the client looks the contract up first.
 */
async function submit(input: ResolvedInput, ctx: Context): Promise<SubmitOutcome> {
  const { language, sources, settings } = input.compiler.input;
  const fields: Record<string, string> = {
    action: "verifysourcecode",
    codeformat: "solidity-standard-json-input",
    sourceCode: JSON.stringify({ language, sources, settings }),
    contractaddress: input.address,
    contractname: input.contractName,
    compilerversion: `v${input.compiler.version.replace(/^v/, "")}`,
  };
  const args = (input.constructorArgs ?? "").replace(/^0x/i, "");
  if (args !== "") {
    // Etherscan's docs name `constructorArguments`; the misspelled field is the one its own
    // examples and older tools send. Both carry the same bare hex.
    fields["constructorArguments"] = args;
    fields["constructorArguements"] = args;
  }
  const req = form(ctx, NAME, fields, "submit");
  const unconfirmed = (answer: Answer): ExplorerVerifyError | undefined =>
    UNCONFIRMED_STATUSES.includes(answer.status) ||
    (answer.status === 200 && answer.fields === undefined)
      ? unexpected(ctx, answer, "the submit")
      : undefined;
  return await submitOnce(
    ctx,
    NAME,
    LABEL,
    { chainId: input.chainId, address: input.address },
    async () => await untilIndexed(ctx, req, unconfirmed),
    async (answer) => await readSubmit(input, ctx, answer),
    lookup,
  );
}

/**
 * Sends the submit, and sends it again every `pollIntervalMs` while Etherscan answers that it
 * finds no contract code at the address, as it does right after a deployment it has not indexed
 * yet. Each wait emits `verify.retry` with `reason` `not-indexed`. After
 * {@link MAX_NOT_INDEXED_TRIES} submits it throws `unexpected-response`; when the next try would
 * pass the budget's deadline, `timeout`. Both hints say to check the chain id and the address.
 */
async function untilIndexed(
  ctx: Context,
  req: HttpRequest,
  unconfirmed: (answer: Answer) => ExplorerVerifyError | undefined,
  attempt = 1,
): Promise<SubmitAttempt> {
  const delayMs = ctx.pollIntervalMs ?? NOT_INDEXED_WAIT_MS;
  const { budget, secrets, observer, signal } = ctx.http;
  const sent = await attemptSubmit(ctx, req, unconfirmed);
  if (sent.kind === "unconfirmed" || resultOf(sent.answer)?.startsWith(NOT_INDEXED) !== true) {
    return sent;
  }
  const tries = `${String(attempt)} ${attempt === 1 ? "submit" : "submits"}`;
  if (budget !== undefined && Date.now() + delayMs >= budget.deadline) {
    throw new ExplorerVerifyError(
      { code: "timeout", backend: NAME, timeoutMs: budget.timeoutMs },
      `Etherscan found no contract code at the address after ${tries}, within the ${String(budget.timeoutMs)} ms budget.`,
      { hint: NOT_INDEXED_HINT, secrets },
    );
  }
  if (attempt >= MAX_NOT_INDEXED_TRIES) {
    throw new ExplorerVerifyError(
      {
        code: "unexpected-response",
        backend: NAME,
        status: sent.answer.status,
        excerpt: sent.answer.text,
      },
      `Etherscan found no contract code at the address after ${tries}.`,
      { hint: NOT_INDEXED_HINT, secrets },
    );
  }
  observer?.log.warn(
    `Etherscan found no contract code at the address yet; submitting again in ${String(delayMs)} ms (submit ${String(attempt + 1)} of at most ${String(MAX_NOT_INDEXED_TRIES)})`,
    { backend: NAME, attempt: attempt + 1, reason: "not-indexed", delayMs },
  );
  observer?.emit({
    type: "verify.retry",
    backend: NAME,
    attempt: attempt + 1,
    reason: "not-indexed",
    delayMs,
  });
  await sleep(delayMs, signal);
  return await untilIndexed(ctx, req, unconfirmed, attempt + 1);
}

/** Maps a submit answer to its outcome. */
async function readSubmit(
  input: ResolvedInput,
  ctx: Context,
  answer: Answer,
): Promise<SubmitOutcome> {
  const result = known(ctx, answer, input.chainId);
  if (answer.status === 200 && result !== undefined) {
    if (answer.fields?.get("status") === "1" && JOB_ID.test(result)) {
      return {
        state: "submitted",
        handle: {
          version: 1,
          backend: NAME,
          chainId: input.chainId,
          address: input.address,
          jobId: result,
        },
      };
    }
    if (startsWithAny(result, ALREADY_VERIFIED)) {
      // The answer does not say the grade, and the outcome needs it: one lookup reads it.
      const match = await lookup({ chainId: input.chainId, address: input.address }, ctx);
      if (match !== undefined) {
        return { state: "already-verified", match };
      }
      throw unexpected(
        ctx,
        answer,
        "Etherscan answered that the contract is already verified, but a lookup found it not verified.",
        true,
      );
    }
  }
  throw unexpected(ctx, answer, "the submit");
}

/**
 * Asks once for the state of a job with `checkverifystatus`. The handle is checked first: it may
 * come from storage. `Fail - Unable to verify` is checked with one lookup, because it was once
 * answered for a contract that the lookup showed verified moments later.
 */
async function poll(handle: Handle, ctx: Context): Promise<PollOutcome> {
  checkHandle(handle, NAME, LABEL, ctx);
  const answer = await send(
    ctx,
    form(ctx, handle.backend, { action: "checkverifystatus", guid: handle.jobId }, "safe"),
  );
  const result = known(ctx, answer, handle.chainId);
  if (answer.status !== 200 || result === undefined) {
    throw unexpected(ctx, answer, "the job status request");
  }
  if (result.startsWith(PENDING)) {
    return { state: "pending" };
  }
  if (result.startsWith(PASS)) {
    return { state: "verified", match: "exact" };
  }
  if (startsWithAny(result, ALREADY_VERIFIED)) {
    return { state: "already-verified" };
  }
  if (result.startsWith(FAIL)) {
    // A lookup that fails throws: a verdict it could not check is not reported as `failed`. An
    // exact match means the job did verify the source. A partial one is Etherscan's own match from
    // another contract's source, while the submitted source was rejected: `already-verified`.
    const match = await lookup(handle, ctx);
    return match === undefined
      ? { state: "failed", reason: redactExcerpt(result, ctx.http.secrets, REASON_LENGTH) }
      : match === "exact"
        ? { state: "verified", match }
        : { state: "already-verified", match };
  }
  if (startsWithAny(result, NO_JOB)) {
    throw new ExplorerVerifyError(
      { code: "job-not-found", handle },
      `Etherscan does not know the verification job ${handle.jobId}.`,
      { secrets: ctx.http.secrets },
    );
  }
  throw new ExplorerVerifyError(
    { code: "unknown-state", handle, excerpt: answer.text },
    `Etherscan reported a job state for ${handle.jobId} that this client does not recognise; the result is not known.`,
    { secrets: ctx.http.secrets },
  );
}

/**
 * A form-encoded POST to the route's API base, `chainid` in the query, with the key the key rule
 * allows in the body. The body is built with `URLSearchParams` only, so a value cannot add a
 * field.
 */
function form(
  ctx: Context,
  backend: BackendName,
  fields: Record<string, string>,
  retry: RetryMode,
): HttpRequest {
  return withKey(ctx, backend, {
    url: ctx.route.requestUrl(""),
    method: "POST",
    body: new URLSearchParams({ module: "contract", ...fields }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    retry,
    rateLimited,
  });
}

/** Whether a body is Etherscan's per-second rate-limit answer, which comes with HTTP 200. */
function rateLimited(body: string): boolean {
  // A lookup body can hold a whole source: only a body that holds the text is parsed.
  if (!body.includes(RATE_LIMIT)) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    const result = readFields(parsed)?.get("result");
    return typeof result === "string" && result.startsWith(RATE_LIMIT);
  } catch {
    return false;
  }
}

/**
 * Throws for an answer any call can get: a key or daily-limit answer, an unsupported chain, or a
 * v1 endpoint. Returns the `result` text, or `undefined` when `result` is not text.
 */
function known(ctx: Context, answer: Answer, chainId: number): string | undefined {
  const { fields } = answer;
  if (fields === undefined) {
    return undefined;
  }
  const keyError = keyErrorOf(NAME, Object.fromEntries(fields), ctx.http.secrets);
  if (keyError !== undefined) {
    throw keyError;
  }
  const result = resultOf(answer);
  if (result?.startsWith(NO_CHAIN) === true) {
    throw new ExplorerVerifyError(
      { code: "unsupported-chain", backend: NAME, chainId },
      `Etherscan does not support chain ${String(chainId)}.`,
      { secrets: ctx.http.secrets },
    );
  }
  if (result?.startsWith(V1_ENDPOINT) === true) {
    throw unexpected(
      ctx,
      answer,
      "Etherscan answered that the request went to its deprecated v1 API; the route must name the v2 API.",
      true,
    );
  }
  return result;
}

/** The `result` field when it is text. */
function resultOf(answer: Answer): string | undefined {
  const result = answer.fields?.get("result");
  return typeof result === "string" ? result : undefined;
}

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}

/**
 * `unexpected-response` with the answer's status and text. `what` names the request, as
 * `the lookup`, or is the whole message when `whole` is set.
 */
function unexpected(
  ctx: Context,
  answer: Answer,
  what: string,
  whole = false,
): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "unexpected-response", backend: NAME, status: answer.status, excerpt: answer.text },
    whole
      ? what
      : `Etherscan gave an answer to ${what} that this client does not recognise (status ${String(answer.status)}).`,
    { secrets: ctx.http.secrets },
  );
}
