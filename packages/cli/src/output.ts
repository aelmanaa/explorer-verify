// References: R-AX-5, R-AX-12.
/**
 * What the CLI writes to stdout: with `--json`, the one envelope of the outcome;
 * without it, a short summary of a result, and nothing for an error, whose lines go to stderr.
 * Both come from the same envelope, so they hold the same redacted values and the same text for
 * the same outcome.
 */
import type {
  BackendOutcome,
  DryRunResult,
  RoutedBy,
  ErrorJson,
  StoredContract,
  VerifyResult,
  LinkProxyResult,
} from "explorer-verify";
import type { Envelope } from "explorer-verify/envelope";

import { cliErrorJson, nextCommand, visible } from "./hints.ts";
import type { HintContext } from "./hints.ts";
import { painter } from "./terminal.ts";

/** Why a dry run's backend was chosen, after its host. A backend the caller named needs no word. */
const ROUTED_BY_TEXT: Readonly<Record<RoutedBy, string>> = {
  table: ", the routing table's pick",
  fallback: ", the Sourcify fallback",
  "api-url": ", at the API URL given",
  caller: "",
};

/** The summary line of a dry run. */
function dryRunText(
  result: DryRunResult,
  paint: ReturnType<typeof painter>,
  overPartial: boolean,
): string {
  const why = result.routedBy === undefined ? "" : ROUTED_BY_TEXT[result.routedBy];
  const head = `${paint("green", "dry run")} on ${result.backend} at ${result.apiHost}${why}: `;
  if (result.lookup === "skipped") {
    return `${head}lookup skipped, because ${result.backend} needs an API key and none is set. Nothing was submitted.\n`;
  }
  if (result.lookup === "none") {
    return `${head}no match, so a run without --dry-run would submit. Nothing was submitted.\n`;
  }
  if (result.storedContract !== undefined) {
    return `${head}${result.lookup} match from another contract's source (${storedText(result.storedContract)}), so a run without --dry-run would submit. Nothing was submitted.\n`;
  }
  if (result.lookup === "partial" && overPartial) {
    return `${head}partial match of this source, so a run without --dry-run would submit over it (--submit-over-partial). Nothing was submitted.\n`;
  }
  const line = `${head}${result.lookup} match already, so a run without --dry-run would not submit${result.lookup === "partial" ? " unless --submit-over-partial is set" : ""}.\n`;
  return result.explorerUrl === undefined ? line : `${line}${result.explorerUrl}\n`;
}

/**
 * One outcome of a run on several backends, as the CLI prints it: the library's, or, under
 * `--require-own-source`, an `already-verified` result of another contract's source with
 * `ok: false`.
 */
export type GatedOutcome =
  | BackendOutcome<ErrorJson>
  | (Omit<Extract<BackendOutcome<ErrorJson>, { ok: true }>, "ok"> & {
      /** `false`: the explorer holds another contract's source. */
      ok: false;
    });

// References: R-AX-5, R-AX-10.
/**
 * The envelope the CLI prints: the library's, with the CLI's hint in each error, and, for an
 * error, `nextCommand` when one command resumes the run.
 */
export type CliEnvelope =
  | Exclude<Envelope, { readonly error: ErrorJson }>
  | {
      /** The version of this document's form. */
      schemaVersion: 1;
      /** `false`: with `--require-own-source`, the explorer holds another contract's source. */
      ok: false;
      /** An `already-verified` result with `storedContract`. */
      result: VerifyResult;
      /** Results carry no error. */
      error?: never;
    }
  | {
      /** The version of this document's form. */
      schemaVersion: 1;
      /** `false`: at least one backend failed, or holds another contract's source. */
      ok: false;
      /** One outcome per backend, in the order of `--backend`. */
      result: { outcomes: GatedOutcome[] };
      /** Results carry no error. */
      error?: never;
    }
  | {
      /** The version of this document's form. */
      schemaVersion: 1;
      /** `false`: the run failed. */
      ok: false;
      /** The error, with the CLI's hint. */
      error: ErrorJson;
      /** Errors carry no result. */
      result?: never;
      /** The command to run next, as an argv array, when one exists. */
      nextCommand?: string[];
    };

/**
 * The envelope the CLI prints for an outcome's envelope: each error's hint in the CLI's words, and
 * `nextCommand` for an error that one command resumes. The order of keys is kept, and
 * `nextCommand` comes last.
 *
 * @param envelope - The library's envelope.
 * @param context - Whether the CLI built the error, where the run read its key, and whether it prints JSON.
 * @returns The envelope to print.
 */
export function cliEnvelope(envelope: Envelope, context: HintContext): CliEnvelope {
  if (envelope.error !== undefined) {
    const error = cliErrorJson(envelope.error, context);
    const next = nextCommand(error, context);
    return { ...envelope, error, ...(next === undefined ? {} : { nextCommand: next }) };
  }
  if (!("outcomes" in envelope.result)) {
    return envelope;
  }
  if (envelope.ok) return envelope;
  const outcomes = envelope.result.outcomes.map((outcome) =>
    outcome.error !== undefined
      ? { ...outcome, error: cliErrorJson(outcome.error, { ...context, own: false }) }
      : outcome,
  );
  return { schemaVersion: 1, ok: false, result: { outcomes } };
}

/**
 * The stdout text of an envelope.
 *
 * @param envelope - The envelope of the outcome.
 * @param json - Whether `--json` was given.
 * @param color - Whether stdout is coloured.
 * @param overPartial - Whether `--submit-over-partial` was given, for a dry run's summary.
 * @returns The text, ending in a newline, or an empty string for an error without `--json`.
 */
export function stdoutText(
  envelope: CliEnvelope,
  json: boolean,
  color: boolean,
  overPartial = false,
): string {
  if (json) {
    return `${JSON.stringify(envelope)}\n`;
  }
  if (envelope.error !== undefined) {
    return "";
  }
  const paint = painter(color);
  const { result } = envelope;
  if ("outcomes" in result) {
    return result.outcomes.map((outcome) => outcomeText(outcome, paint)).join("");
  }
  return resultText(result, paint, overPartial, envelope.ok);
}

/**
 * The summary of a result of one backend. `ok` is `false` for a verified result that
 * `--require-own-source` fails, whose status is then red.
 */
function resultText(
  result: VerifyResult | DryRunResult | LinkProxyResult,
  paint: ReturnType<typeof painter>,
  overPartial: boolean,
  ok: boolean,
): string {
  if (result.status === "dry-run") {
    return dryRunText(result, paint, overPartial);
  }
  if (result.status === "failed") {
    return `${paint("red", "failed")} on ${result.backend}: ${visible(result.reason)}\n`;
  }
  if (result.status === "linked") return `linked on ${result.backend}: ${result.implementation}\n`;
  if (result.status === "mismatch")
    return `mismatch on ${result.backend}: expected ${result.expectedImplementation}\n`;
  if (result.status === "not-linked")
    return `not-linked on ${result.backend}: ${visible(result.reason)}\n`;
  const stored =
    result.status === "already-verified" && result.storedContract !== undefined
      ? `, from another contract's source (${storedText(result.storedContract)})`
      : "";
  const line = `${paint(ok ? "green" : "red", result.status)}: ${result.match} match on ${result.backend}${stored}\n`;
  return result.explorerUrl === undefined ? line : `${line}${result.explorerUrl}\n`;
}

// References: decision 0063.
/** A stored contract in a summary: its name and compiler version, as the explorer gives them. */
function storedText(stored: StoredContract): string {
  return `${visible(stored.name ?? "no name given")}, compiler ${visible(stored.compilerVersion ?? "not given")}`;
}

/**
 * The summary of one backend of a run on several backends: its result as for one backend, or its
 * error's code and message, and the handle when the error carries one.
 */
function outcomeText(outcome: GatedOutcome, paint: ReturnType<typeof painter>): string {
  if (outcome.error === undefined) {
    // A run on several backends is never a dry run.
    return resultText(outcome.result, paint, false, outcome.ok);
  }
  const { error } = outcome;
  const line = `${paint("red", error.code)} on ${outcome.backend}: ${visible(error.message)}\n`;
  return error.handle === undefined ? line : `${line}Handle: ${error.handle}\n`;
}

// References: R-AX-11.
/**
 * The stdout text of help or the version: with `--json`, an envelope with `ok: true`
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
