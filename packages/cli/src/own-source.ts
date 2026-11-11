// References: R-AX-5, R-AX-7, decision 0063, decision 0069.
/**
 * `--require-own-source`: a run whose explorer holds another contract's source at the address,
 * `already-verified` with `storedContract`, fails with exit code 1 and `ok: false` instead of
 * passing. The result keeps its fields, so a caller still reads `storedContract`. Without the
 * flag, nothing changes. `status` resumes a handle with no input, so its result never carries
 * `storedContract` and the flag is `verify`'s only.
 */
import type { VerifyResult } from "explorer-verify";
import type { ExitCode } from "explorer-verify/envelope";

import type { OptionSpec } from "./arguments.ts";
import type { CliEnvelope, GatedOutcome } from "./output.ts";

/** The `--require-own-source` option of `verify`. */
export const REQUIRE_OWN_SOURCE_OPTION: OptionSpec = {
  type: "boolean",
  description:
    "Exit 1, with ok false, when the explorer holds another contract's source at the address (already-verified with result.storedContract). Without it, that result exits 0. A partial match of this contract's own source still exits 0; --submit-over-partial can replace it.",
};

/** A result that `--require-own-source` fails: `already-verified` with `storedContract`. */
export function isOtherSource(result: VerifyResult): boolean {
  return result.status === "already-verified" && result.storedContract !== undefined;
}

/** What `--require-own-source` makes of a run: the envelope to print and its exit code. */
export interface Gated {
  readonly envelope: CliEnvelope;
  readonly code: ExitCode;
  /** The backends whose explorer holds another contract's source; empty when none does. */
  readonly backends: readonly string[];
}

/**
 * The envelope and the exit code of a run under `--require-own-source`. A result of another
 * contract's source gets `ok: false` and exit code 1. In a run on several backends, each such
 * outcome gets `ok: false` and counts as exit code 1 in the exit-code order 6, 4, 3, 2, 5, 1, 130:
 * the run's code becomes 1 when it was 0 or 130, and stays as it is otherwise.
 *
 * @param envelope - The envelope the CLI prints.
 * @param code - The exit code of the outcome.
 * @returns The envelope, the exit code and the backends that hold another contract's source.
 */
export function requireOwnSource(envelope: CliEnvelope, code: ExitCode): Gated {
  if (envelope.error !== undefined) {
    return { envelope, code, backends: [] };
  }
  const { result } = envelope;
  if ("outcomes" in result) {
    const backends: string[] = [];
    const outcomes = result.outcomes.map((outcome): GatedOutcome => {
      if (outcome.error === undefined && outcome.ok && isOtherSource(outcome.result)) {
        backends.push(outcome.backend);
        return { ...outcome, ok: false };
      }
      return outcome;
    });
    if (backends.length === 0) {
      return { envelope, code, backends };
    }
    return {
      envelope: { schemaVersion: 1, ok: false, result: { outcomes } },
      code: code === 0 || code === 130 ? 1 : code,
      backends,
    };
  }
  if (result.status !== "already-verified" || !isOtherSource(result)) {
    return { envelope, code, backends: [] };
  }
  return {
    envelope: { schemaVersion: 1, ok: false, result },
    code: 1,
    backends: [result.backend],
  };
}
