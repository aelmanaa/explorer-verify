// References: R-AX-5, R-AX-10, R-SEC-1.
/**
 * The CLI's words for an error: a hint that names the CLI's flags and
 * environment variables instead of the library's options, and the next command to run when one
 * exists. The library's hints name `checkStatus()`, `details.handle` or `apiKeys`, which a person
 * at a shell or an agent cannot act on.
 *
 * A hint is filled in only with values that cannot hold a key: a handle, contract names, a source
 * path and a backend name, each already redacted by the library.
 */
import { ERROR_HINTS, tryParseHandle } from "explorer-verify";
import type { BackendName, DetailsJsonOf, ErrorCode, ErrorJson } from "explorer-verify";

import { KEY_VARIABLES } from "./keys.ts";

/** The program name at the start of a next command. */
const PROGRAM = "explorer-verify";

/** The most candidates a hint or the text error lists; the rest are counted. */
export const MAX_LISTED = 20;

/** The errors the CLI built itself, whose hint already names the CLI's flags. */
const OWN = new WeakSet<object>();

/**
 * Marks an error the CLI built itself, such as a usage error, so its hint is kept as it is.
 *
 * @param error - The error.
 * @returns The same error.
 */
export function ownHint<E extends object>(error: E): E {
  OWN.add(error);
  return error;
}

/**
 * Whether the CLI built `error` itself.
 *
 * @param error - Any value.
 * @returns `true` for an error passed to {@link ownHint}.
 */
export function hasOwnHint(error: unknown): boolean {
  return typeof error === "object" && error !== null && OWN.has(error);
}

/**
 * The library's words in a hint, in order. A word with a CLI form is rewritten to it, such as
 * `options.contract` to `--contract`. A word with none (`undefined`) names an API that only a
 * caller of the library can act on, such as a call, a `details` field or `apiKeys`: a hint that
 * still holds one after the rewrites is replaced by the code's CLI hint. The build helpers' hints
 * reach the CLI through `--foundry` and `--hardhat`; a test feeds every one of them through this.
 */
const WORDS: readonly (readonly [RegExp, string | undefined])[] = [
  // The library's hint for a chain without a row, as a whole.
  [
    /^Set allowSourcifyFallback: true, or set route\.apiUrl and route\.backend\.$/,
    "Pass --allow-sourcify-fallback to verify on the public Sourcify API, or pass --api-url with --backend.",
  ],
  [/\b(?:options\.)?outDir\b/g, "--out-dir"],
  [/\bthe contract \(options\.contract\)/g, "--contract"],
  [/\boptions\.contract\b/g, "--contract"],
  [/\b([Pp]ass) contract as\b/g, "$1 --contract as"],
  [/\b([Pp]ass) artifact with\b/g, "$1 --artifact with"],
  [/\bunder root\b/g, "under the project folder"],
  [/\bproject root\b/g, "project folder"],
  [/\bone entry of details\.candidates\b/g, "one of the paths listed"],
  [/\bone of the candidates \(details\.candidates\)/g, "one of the paths listed"],
  [/\bcall again\b/g, "run the command again"],
  [/\(\)/, undefined],
  [/\bdetails\./, undefined],
  [/\boptions\./, undefined],
  [/\bapiKeys\b/, undefined],
  [/\broute\./, undefined],
  [/\brpcUrl\b/, undefined],
  [/\btimeoutMs\b/, undefined],
  [/\bipfsGateway\b/, undefined],
  [/\bconstructorArgs\b/, undefined],
  [/\bcreationBytecode\b/, undefined],
  [/\bcheckStatus\b/, undefined],
];

/**
 * A library hint in the CLI's words, or `undefined` when a word with no CLI form is left.
 *
 * @param hint - The library's hint.
 * @returns The hint with the CLI's flags, or `undefined`.
 */
export function inCliWords(hint: string): string | undefined {
  let text = hint;
  for (const [word, flag] of WORDS) {
    if (flag !== undefined) {
      text = text.replace(word, flag);
    } else if (word.test(text)) {
      return undefined;
    }
  }
  return text;
}

/** What the CLI knows about the run that changes its words. */
export interface HintContext {
  /** Whether the CLI built the error itself, so its hint is kept. */
  readonly own?: boolean;
  /** Whether the run read its key from `--api-key-file` or `--api-key-stdin`. */
  readonly keyFlag?: boolean;
  /** Whether the run prints JSON, so the next command does too. */
  readonly json?: boolean;
}

/** The environment variable that holds the key of `backend`, if it has one. */
function keyVariable(backend: BackendName): string | undefined {
  return KEY_VARIABLES.find((each) => each.backend === backend)?.name;
}

/** Where the CLI reads the key of `backend`, for a hint. */
function keySources(backend: BackendName): string {
  const variable = keyVariable(backend);
  const flags = `--api-key-file <path> or --api-key-stdin with --backend ${backend}`;
  return variable === undefined
    ? `pass ${flags} and --api-url`
    : `set ${variable}, or pass ${flags}`;
}

/** A list of names, the first {@link MAX_LISTED}, with the rest counted. */
export function listed(names: readonly string[]): string {
  const shown = names.slice(0, MAX_LISTED).join(", ");
  const left = names.length - MAX_LISTED;
  return left > 0 ? `${shown} and ${String(left)} more` : shown;
}

/** The hint of `incomplete-input`, by the field that is missing. */
function incompleteHint(details: DetailsJsonOf<"incomplete-input">): string {
  const hints: Readonly<Record<typeof details.field, string>> = {
    contract:
      details.candidates.length === 0
        ? "Pass --contract as path:Name, such as src/Greeter.sol:Greeter."
        : `Pass --contract with one of: ${listed(details.candidates)}.`,
    compilerVersion:
      "Pass --compiler-version with the full version, such as 0.8.24+commit.e11b9ed9, or add an --input file that holds the contract metadata.",
    sources:
      "Pass the build-info file of the same build with --input: it holds every source the metadata lists.",
    input:
      "Pass a build-info file or a Standard JSON input with --input. With Foundry, build with forge build --build-info.",
  };
  return hints[details.field];
}

/** The hint of `rate-limited`: the wait the explorer asked for, in seconds, when it said. */
function rateLimitedHint(details: DetailsJsonOf<"rate-limited">): string {
  const ms = details.retryAfterMs;
  const wait =
    ms === undefined || !Number.isFinite(ms) || ms <= 0
      ? "a few seconds"
      : `${String(Math.ceil(ms / 1_000))} s`;
  return `The explorer limited the requests. Wait ${wait}, then run the command again.`;
}

/** The hint of `cancelled`: resume the jobs the explorer accepted, never submit again. */
function cancelledHint(error: ErrorJson<"cancelled">): string {
  if (error.handle !== undefined) {
    return `Resume the accepted submission with ${PROGRAM} status ${error.handle} instead of submitting again.`;
  }
  if (error.handles !== undefined) {
    return `Resume each handle listed with ${PROGRAM} status <handle> instead of submitting again.`;
  }
  return "The run was cancelled before any explorer accepted a submission. Run the command again.";
}

/**
 * The hint of a code whose handle resumes the job: run `status` with it, with `--api-url` for an
 * Etherscan-compatible explorer and the key flag when the run read its key from one.
 */
function statusHint(error: ErrorJson<"not-confirmed">, context: HintContext): string {
  const { details } = error;
  const extra = [
    ...(details.handle.split(":")[1] === "etherscan-compatible"
      ? ["--api-url <the same URL>"]
      : []),
    ...(context.keyFlag === true ? ["the same key flag"] : []),
  ];
  const route = extra.length === 0 ? "" : ` with ${extra.join(" and ")}`;
  return `The explorer is still verifying. Run ${PROGRAM} status ${details.handle}${route} later to continue polling, or raise --timeout. Running verify again would submit again.`;
}

/** The CLI hint of each code that needs none of its details. */
const FIXED: Readonly<
  Record<
    Exclude<
      ErrorCode,
      | "not-confirmed"
      | "cancelled"
      | "incomplete-input"
      | "rate-limited"
      | "source-mismatch"
      | "missing-api-key"
      | "api-key-rejected"
      | "handler-refused"
    >,
    string
  >
> = {
  "invalid-input":
    "Fix what the message names, and each issue listed under it, then run the command again. explorer-verify --help lists every option.",
  "unsupported-chain":
    "Check --chain, or pass a --backend that serves the chain. --backend auto lets the routing table pick one.",
  network:
    "Check the network connection and the explorer's status page, then run the command again.",
  timeout:
    "Run the command again, or raise --timeout. The explorer had not accepted the submission, so nothing is pending.",
  "unexpected-response":
    "Run the command again later. If it persists, check the explorer's status page and report the status and excerpt that --json prints.",
  "in-progress":
    "Wait for the explorer to finish its current verification of this contract, then run the command again.",
  "unknown-state":
    "Do not retry automatically. Check the contract on the explorer, and report the excerpt that --json prints.",
  "job-not-found":
    "Do not retry automatically. Check the contract on the explorer; if it is not verified, run verify again.",
  "insufficient-artifact":
    "ABI and bytecode are not enough to verify. Pass the build-info or the Solidity metadata of the same build with --input.",
  "unsupported-compiler": ERROR_HINTS["unsupported-compiler"],
  "verification-inconclusive":
    "Wait a minute, then run verify again: it looks the contract up first and submits only when the contract is not verified.",
  "quota-exceeded":
    "The key's daily limit is spent. Run the command again after the explorer resets the limit, or use a key on a plan with a higher limit.",
  "internal-error": ERROR_HINTS["internal-error"],
  "no-metadata-hash": "Pass the build files with --input instead.",
  "metadata-unavailable":
    "Run the command again later. --json lists each source tried and what it answered.",
  "constructor-args-unavailable":
    "Pass --constructor-args with the ABI-encoded arguments, or check the --input files against the deployed build.",
  "proxy-link-pending":
    "The explorer had not finished linking the proxy. Link it again later; a new request is safe.",
  "proxy-link-unknown-state":
    "Do not retry automatically. Check the proxy's page on the explorer, and report the excerpt that --json prints.",
  "not-indexed":
    "Check the chain and the address (--chain and --address, or chainId and address in the request). If the contract was deployed in the last few minutes, run the command again in a minute.",
};

/**
 * The CLI hint of an error: one sentence or two that name flags, environment variables and
 * commands, filled in with values that cannot hold a key.
 *
 * @param error - The error object, as the envelope holds it.
 * @param context - What the CLI knows about the run.
 * @returns The hint.
 */
export function cliHint(error: ErrorJson, context: HintContext = {}): string {
  if (error.code === "not-confirmed") {
    return statusHint(error, context);
  }
  if (error.code === "cancelled") {
    return cancelledHint(error);
  }
  if (error.code === "incomplete-input") {
    return incompleteHint(error.details);
  }
  if (error.code === "rate-limited") {
    return rateLimitedHint(error.details);
  }
  if (error.code === "source-mismatch") {
    return `Pass the source file ${error.details.path} exactly as it was compiled, byte for byte, line endings included, or pass the build-info of the same build with --input.`;
  }
  if (error.code === "missing-api-key") {
    return `${error.details.backend} needs an API key: ${keySources(error.details.backend)}. --backend sourcify needs no key.`;
  }
  if (error.code === "api-key-rejected") {
    const { backend } = error.details;
    const where =
      context.keyFlag === true
        ? "the key file or stdin you passed"
        : (keyVariable(backend) ?? "the key you passed");
    return `${backend} refused the key. Check the key in ${where} on the explorer's account page: it may be mistyped, revoked or issued by another explorer.`;
  }
  if (error.code === "handler-refused") {
    const code = error.details.handlerCode === "" ? "a refusal" : error.details.handlerCode;
    return `The server handler refused the request with ${code}. Do not retry: change the handler's createVerifyHandler options for it, redeploy the handler, then run the command again.`;
  }
  return FIXED[error.code];
}

/**
 * The command that resumes the run, as an argv array, when one exists: `explorer-verify status`
 * with the handle of `not-confirmed`, or of a cancelled run with one handle. It never submits, and
 * it runs as it is: there is none when the command would need more than the CLI repeats. That is a
 * handle that does not parse, such as one whose job id was redacted; a handle of
 * `etherscan-compatible`, which needs the API URL; and a run that read its key from
 * `--api-key-file` or `--api-key-stdin`, which the next command would lack.
 *
 * @param error - The error object.
 * @param context - Whether the run printed JSON and where it read its key.
 * @returns The argv, or `undefined`.
 */
export function nextCommand(error: ErrorJson, context: HintContext = {}): string[] | undefined {
  const handle =
    error.code === "not-confirmed" || error.code === "cancelled" ? error.handle : undefined;
  const parsed = tryParseHandle(handle);
  if (
    parsed === undefined ||
    handle === undefined ||
    parsed.backend === "etherscan-compatible" ||
    context.keyFlag === true
  ) {
    return undefined;
  }
  return [PROGRAM, "status", handle, ...(context.json === true ? ["--json"] : [])];
}

/** Words of a `missing-api-key` message that name the library's options. */
const LIBRARY_KEY_MESSAGE = /\bapiKeys\b|\bhandlerUrl\b|\broute\.apiKey\b/;

/**
 * The error object in the CLI's words. A hint the CLI built itself is kept. The library's default
 * hint becomes the code's CLI hint. Any other library hint is rewritten word by word, and when a
 * word with no CLI form is left, it becomes the code's CLI hint too. A `missing-api-key` message
 * that names the library's options says what is missing instead.
 *
 * @param error - The error object from the envelope.
 * @param context - What the CLI knows about the run.
 * @returns The same fields, with the hint and message the CLI prints.
 */
export function cliErrorJson(error: ErrorJson, context: HintContext = {}): ErrorJson {
  // A route with its own API URL takes only the key given for it (decision 0053).
  const forUrl = error.message.includes("route.apiUrl") ? " for this --api-url" : "";
  const message =
    error.code === "missing-api-key" && LIBRARY_KEY_MESSAGE.test(error.message)
      ? `${error.details.backend} needs an API key${forUrl} and none is set.`
      : error.message.replace(
          /^The documents and options\.sources lack\b/,
          "The --input files lack",
        );
  if (context.own === true) {
    return error;
  }
  // A `timeout` keeps the CLI's hint, which names --timeout and says nothing is pending.
  const words =
    error.hint === ERROR_HINTS[error.code] || error.code === "timeout"
      ? undefined
      : inCliWords(error.hint);
  return { ...error, message, hint: words ?? cliHint(error, context) };
}

/**
 * The error's issues and candidates for a person, under the error line. An issue that the message
 * already states in full is left out, so a usage error does not list its issues twice.
 *
 * @param error - The error object.
 * @returns One line per issue, or one line of candidates, without indentation.
 */
export function detailLines(error: ErrorJson): string[] {
  if (error.code === "invalid-input") {
    return error.details.issues
      .map((issue) => `${issue.field} ${issue.message}`)
      .filter((line) => !error.message.includes(line))
      .map((line) => `issue: ${line}`);
  }
  if (error.code === "incomplete-input" && error.details.candidates.length > 0) {
    const what = error.details.field === "sources" ? "missing sources" : "candidates";
    return [`${what}: ${listed(error.details.candidates)}`];
  }
  return [];
}

/**
 * Whether a UTF-16 code is a character a terminal acts on or that reorders or hides text: a C0 or
 * C1 control character, DEL, a bidi mark, embedding, override or isolate, a line or paragraph
 * separator, or the byte order mark.
 */
function isControl(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff
  );
}

/**
 * Text for a terminal line: each control, bidi or format character shown as `\uXXXX`, so a value
 * from an explorer's answer or a build file cannot start another line, such as a forged `next:`
 * line, send an ANSI or OSC sequence, or show its text in another order.
 *
 * @param text - Text from an error.
 * @returns The text with every control character escaped.
 */
export function visible(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += isControl(code) ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
  return out;
}

// A word a POSIX shell reads as it is.
const PLAIN_WORD = /^[A-Za-z0-9_:./=-]+$/;

/**
 * A command line for a person to copy into a shell: each word outside `[A-Za-z0-9_:./=-]` in
 * single quotes, with any quote in it escaped.
 *
 * @param argv - The command as an argument array.
 * @returns The command as one line.
 */
export function shellLine(argv: readonly string[]): string {
  return argv
    .map((word) => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`))
    .join(" ");
}
