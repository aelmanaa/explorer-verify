/**
 * What the CLI writes to stdout (R-AX-5, R-AX-12): with `--json`, the one envelope of the outcome;
 * without it, a short summary of a result, and nothing for an error, whose lines go to stderr.
 * Both come from `toEnvelope`, so they hold the same redacted values and the same text for the
 * same outcome.
 */
import type { Envelope } from "explorer-verify";

import { painter } from "./terminal.ts";

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
  if (result.status === "failed") {
    return `${paint("red", "failed")} on ${result.backend}: ${result.reason}\n`;
  }
  const line = `${paint("green", result.status)}: ${result.match} match on ${result.backend}\n`;
  return result.explorerUrl === undefined ? line : `${line}${result.explorerUrl}\n`;
}
