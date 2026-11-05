/**
 * What the CLI writes to stdout (R-AX-5, R-AX-12): with `--json`, the one envelope of the outcome;
 * without it, a short summary of a result, and nothing for an error, whose lines go to stderr.
 * Both come from the same envelope, so they hold the same redacted values and the same text for
 * the same outcome.
 */
import type {
  BackendOutcome,
  DryRunResult,
  Envelope,
  RoutedBy,
  ErrorJson,
  VerifyResult,
} from "explorer-verify";

import { painter } from "./terminal.ts";

/** Why a dry run's backend was chosen, after its host. A backend the caller named needs no word. */
const ROUTED_BY_TEXT: Readonly<Record<RoutedBy, string>> = {
  table: ", the routing table's pick",
  fallback: ", the Sourcify fallback",
  "api-url": ", at the API URL given",
  caller: "",
};

/** The summary line of a dry run. */
function dryRunText(result: DryRunResult, paint: ReturnType<typeof painter>): string {
  const why = result.routedBy === undefined ? "" : ROUTED_BY_TEXT[result.routedBy];
  const head = `${paint("green", "dry run")} on ${result.backend} at ${result.apiHost}${why}: `;
  if (result.lookup === "skipped") {
    return `${head}lookup skipped, because ${result.backend} needs an API key and none is set. Nothing was submitted.\n`;
  }
  if (result.lookup === "none") {
    return `${head}no match, so verify would submit. Nothing was submitted.\n`;
  }
  const line = `${head}${result.lookup} match already, so verify would not submit.\n`;
  return result.explorerUrl === undefined ? line : `${line}${result.explorerUrl}\n`;
}

/**
 * The stdout text of an envelope.
 *
 * @param envelope - The envelope of the outcome.
 * @param json - Whether `--json` was given.
 * @param color - Whether stdout is coloured.
 * @returns The text, ending in a newline, or an empty string for an error without `--json`.
 */
export function stdoutText(envelope: Envelope, json: boolean, color: boolean): string {
  if (json) {
    return `${JSON.stringify(envelope)}\n`;
  }
  if ("error" in envelope) {
    return "";
  }
  const paint = painter(color);
  const { result } = envelope;
  if ("outcomes" in result) {
    return result.outcomes.map((outcome) => outcomeText(outcome, paint)).join("");
  }
  return resultText(result, paint);
}

/** The summary of a result of one backend. */
function resultText(
  result: VerifyResult | DryRunResult,
  paint: ReturnType<typeof painter>,
): string {
  if (result.status === "dry-run") {
    return dryRunText(result, paint);
  }
  if (result.status === "failed") {
    return `${paint("red", "failed")} on ${result.backend}: ${result.reason}\n`;
  }
  const line = `${paint("green", result.status)}: ${result.match} match on ${result.backend}\n`;
  return result.explorerUrl === undefined ? line : `${line}${result.explorerUrl}\n`;
}

/**
 * The summary of one backend of a run on several backends: its result as for one backend, or its
 * error's code and message, and the handle when the error carries one.
 */
function outcomeText(
  outcome: BackendOutcome<ErrorJson>,
  paint: ReturnType<typeof painter>,
): string {
  if (!("error" in outcome)) {
    return resultText(outcome.result, paint);
  }
  const { error } = outcome;
  const line = `${paint("red", error.code)} on ${outcome.backend}: ${error.message}\n`;
  return error.handle === undefined ? line : `${line}Handle: ${error.handle}\n`;
}

/**
 * The stdout text of help or the version (R-AX-11): with `--json`, an envelope with `ok: true`
 * whose `result` is `info`; without it, the text `toText` makes of it.
 *
 * @param info - The help or the version.
 * @param json - Whether `--json` was given.
 * @param toText - Makes the text of `info`.
 * @returns The text, ending in a newline.
 */
export function infoText<T>(info: T, json: boolean, toText: (info: T) => string): string {
  return json ? `${JSON.stringify({ schemaVersion: 1, ok: true, result: info })}\n` : toText(info);
}
