/**
 * The `scripted` command, for the in-process tests of the main loop only. It is not in the CLI's
 * command table, so neither the bin nor the package has it: the tests pass {@link WITH_SCRIPTED} to
 * `main()`. The bin tests drive `verify` and `status` against the fake explorer instead.
 *
 * It runs a verification without a network. It emits the stage events a real run emits, one debug log line whose fields are named `type`
 * and `fields` (reserved names, R-AX-14), optional retries and polls, then ends with the outcome
 * that `--outcome` names.
 */
import { ExplorerVerifyError, formatHandle } from "explorer-verify";
import type { Handle, InputIssue, VerifyResult } from "explorer-verify";

import { stringOption, usageError } from "../../src/command.ts";
import type { Command, CommandContext, RunCommand } from "../../src/command.ts";
import { COMMANDS } from "../../src/commands.ts";

/** The outcomes `--outcome` can name: one per exit code, plus `pending`. */
const OUTCOMES = [
  "verified",
  "already-verified",
  "failed",
  "missing-api-key",
  "not-confirmed",
  "network",
  "unknown-state",
  "internal-error",
  "pending",
] as const;

/** One of {@link OUTCOMES}. */
type Outcome = (typeof OUTCOMES)[number];

/** The wait before each poll, in milliseconds. */
export const POLL_MS = 50;

/** The most polls or retries the command accepts. */
const MAX_COUNT = 1000;

const BACKEND = "sourcify";
const HANDLE: Handle = {
  version: 1,
  backend: BACKEND,
  chainId: 11155111,
  address: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  jobId: "00000000-0000-4000-8000-000000000000",
};
const EXPLORER_URL = `https://repo.sourcify.dev/${String(HANDLE.chainId)}/${HANDLE.address}`;

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A whole number from 0 to {@link MAX_COUNT}, or an issue. */
function count(value: string | undefined, field: string, issues: InputIssue[]): number {
  if (value === undefined) {
    return 0;
  }
  const parsed = /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed <= MAX_COUNT)) {
    issues.push({ field, message: `must be a whole number from 0 to ${String(MAX_COUNT)}` });
    return 0;
  }
  return parsed;
}

/** The outcome `--outcome` names, `verified` when it is absent, or an issue. */
function outcomeOf(value: string | undefined, issues: InputIssue[]): Outcome {
  if (value === undefined) {
    return "verified";
  }
  const outcome = OUTCOMES.find((known) => known === value);
  if (outcome === undefined) {
    issues.push({ field: "--outcome", message: `must be one of ${OUTCOMES.join(", ")}` });
    return "verified";
  }
  return outcome;
}

/** The error an outcome throws before the submission, or `undefined` when it submits. */
function errorBeforeSubmit(
  outcome: Outcome,
  message: string | undefined,
  attempts: number,
): Error | undefined {
  if (outcome === "internal-error") {
    return new Error(message ?? "Scripted failure.");
  }
  if (outcome === "missing-api-key") {
    return new ExplorerVerifyError(
      { code: "missing-api-key", backend: "etherscan-v2" },
      "The scripted route needs an API key and none is set.",
      { secrets: [] },
    );
  }
  if (outcome === "network") {
    return new ExplorerVerifyError(
      { code: "network", backend: BACKEND, attempts },
      "The scripted explorer could not be reached.",
      { secrets: [] },
    );
  }
  return undefined;
}

/** The error of an outcome that ends after the polls without a result. */
function errorAfterSubmit(outcome: Outcome): ExplorerVerifyError {
  return outcome === "not-confirmed"
    ? new ExplorerVerifyError(
        { code: "not-confirmed", handle: HANDLE },
        "The scripted verification is still pending at the time budget.",
        { secrets: [] },
      )
    : new ExplorerVerifyError(
        { code: "unknown-state", handle: HANDLE, excerpt: "" },
        "The scripted explorer answered a status the library cannot classify.",
        { secrets: [] },
      );
}

/** Runs the script that the options describe. */
async function run(context: CommandContext): Promise<VerifyResult> {
  const { values, logger, onEvent, signal } = context;
  const issues: InputIssue[] = [];
  const outcome = outcomeOf(stringOption(values, "outcome"), issues);
  const polls = count(stringOption(values, "polls"), "--polls", issues);
  const retries = count(stringOption(values, "retries"), "--retries", issues);
  if (issues.length > 0) {
    throw usageError(issues);
  }
  logger.debug("Scripted run started.", {
    outcome,
    polls,
    retries,
    type: "scripted",
    fields: "scripted",
  });
  onEvent({ type: "verify.validated", chainId: HANDLE.chainId, address: HANDLE.address });
  onEvent({ type: "verify.routed", backend: BACKEND, apiHost: "sourcify.dev" });
  if (outcome === "already-verified") {
    onEvent({ type: "verify.lookup", backend: BACKEND, lookup: "exact" });
    onEvent({ type: "verify.result", backend: BACKEND, status: outcome, match: "exact" });
    return { status: outcome, backend: BACKEND, match: "exact", explorerUrl: EXPLORER_URL };
  }
  onEvent({ type: "verify.lookup", backend: BACKEND, lookup: "none" });
  for (let attempt = 2; attempt <= retries + 1; attempt++) {
    onEvent({ type: "verify.retry", backend: BACKEND, attempt, reason: "network", delayMs: 0 });
  }
  const early = errorBeforeSubmit(outcome, stringOption(values, "message"), retries + 1);
  if (early !== undefined) {
    throw early;
  }
  onEvent({ type: "verify.submitted", backend: BACKEND, handle: formatHandle(HANDLE) });
  const limit = outcome === "pending" ? Number.POSITIVE_INFINITY : polls;
  for (let attempt = 1; attempt <= limit; attempt++) {
    await sleep(POLL_MS, signal);
    onEvent({ type: "verify.poll", backend: BACKEND, attempt, state: "pending" });
  }
  if (outcome === "verified") {
    onEvent({ type: "verify.result", backend: BACKEND, status: outcome, match: "exact" });
    return { status: outcome, backend: BACKEND, match: "exact", explorerUrl: EXPLORER_URL };
  }
  if (outcome === "failed") {
    onEvent({ type: "verify.result", backend: BACKEND, status: outcome });
    return { status: outcome, backend: BACKEND, reason: "The scripted explorer rejected it." };
  }
  throw errorAfterSubmit(outcome);
}

/** The `scripted` row of a test command table. */
const SCRIPTED: Command & { readonly run: RunCommand } = {
  name: "scripted",
  // Hidden, so the tests also cover a command that no usage message or help text names.
  hidden: true,
  // Reads the keys and the route options like the real commands. It sends nothing, so it uses
  // neither.
  routed: true,
  summary: "Run a scripted verification with no network, to test the output contract.",
  usage: "",
  examples: [
    {
      args: "scripted --json --outcome not-confirmed",
      description: "Print a not-confirmed envelope with a handle, and exit 4.",
    },
    {
      args: "scripted --verbose --polls 3",
      description: "Show every stage event and three polls on stderr, then print verified.",
    },
  ],
  options: {
    outcome: {
      type: "string",
      value: "<name>",
      description: `The outcome: ${OUTCOMES.join(", ")}, which polls until cancelled. Default verified.`,
    },
    polls: {
      type: "string",
      value: "<n>",
      description: "Polls before the outcome, 0 to 1000. Default 0.",
    },
    retries: {
      type: "string",
      value: "<n>",
      description: "verify.retry events before the submit, 0 to 1000. Default 0.",
    },
    message: {
      type: "string",
      value: "<text>",
      description: "The message of the exception that --outcome internal-error throws.",
    },
  },
  maxPositionals: 0,
  run,
};

/** The CLI's command table with {@link SCRIPTED} after its commands. */
export const WITH_SCRIPTED: readonly Command[] = [...COMMANDS, SCRIPTED];
