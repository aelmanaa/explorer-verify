/**
 * Merges library link addresses into the Standard JSON input (R-IN-4). Kept out of `verify()`:
 * for a contract linked after compiling, the addresses change the metadata hash (live probe E,
 * 2026-11-03).
 */
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import { readFields } from "../internal/read-fields.ts";
import type { VerifyInput } from "../types.ts";
import { validateInput } from "./validate.ts";

/**
 * Returns the input with each address of `libraries` added to `compiler.input.settings.libraries`,
 * in the Standard JSON shape `{ "<path>": { "<Name>": "<address>" } }` (R-IN-4). Entries already
 * in `settings.libraries` are kept. Without `libraries`, the input comes back unchanged.
 *
 * `verify()` does not do this (decision 0025). Solidity's metadata includes `settings.libraries`,
 * so for a contract that was compiled without them and linked afterwards, as Foundry and Hardhat
 * do, the input with the addresses compiles to a different metadata hash. In a live test on
 * 2026-11-03, Sourcify then gave only a partial match, and Etherscan found the address itself
 * ({@link https://github.com/aelmanaa/explorer-verify/blob/main/docs/contributor/research/2026-11-03-m2-live-probes.md#e-a-contract-linked-to-an-external-library | probe E}). Use this for an explorer that needs the addresses in the input.
 *
 * The input is checked with `validateInput` first, so the result is a new, normalised copy that
 * shares no object with `input`, and the addresses are in lower case.
 *
 * @param input - The input to check and link. Any value is accepted, as for `validateInput`.
 * @returns A new {@link VerifyInput} whose `settings.libraries` holds every address of `libraries`.
 * @throws ExplorerVerifyError with code `invalid-input` when `validateInput` rejects the input,
 *   including a value `settings.libraries` already holds for the same library, under its path or
 *   under the empty path, that is not the same address; or when `settings.libraries`, or its entry
 *   for a library's path, is not an object.
 * @example
 * ```ts
 * import { linkLibraries } from "explorer-verify";
 *
 * const linked = linkLibraries({
 *   ...input,
 *   libraries: { "src/MathLib.sol:MathLib": "0xd0B737fC4e4195144824eB07b2d1bb778525b86B" },
 * });
 * // linked.compiler.input.settings.libraries:
 * // { "src/MathLib.sol": { MathLib: "0xd0b737fc4e4195144824eb07b2d1bb778525b86b" } }
 * ```
 * @experimental
 */
export function linkLibraries(input: unknown): VerifyInput {
  const checked = validateInput(input);
  const { libraries } = checked;
  if (libraries === undefined) {
    return checked;
  }
  const settings = checked.compiler.input.settings;
  const conflict = "conflicts with compiler.input.settings.libraries";
  // Entries for other paths are copied as they are.
  const merged = readFields(settings["libraries"] ?? {});
  if (merged === undefined) {
    throw invalid([{ field: "compiler.input.settings.libraries", message: "must be an object" }]);
  }
  const issues: InputIssue[] = [];
  let position = 0;
  for (const [name, address] of Object.entries(libraries)) {
    position++;
    const colon = name.lastIndexOf(":");
    const path = name.slice(0, colon);
    const library = name.slice(colon + 1);
    const entry = merged.get(path);
    const names = entry === undefined ? new Map<string, unknown>() : readFields(entry);
    // solc applies a library under the empty path to every file.
    const shared = readFields(merged.get(""))?.get(library);
    if (
      names === undefined ||
      (shared !== undefined && (typeof shared !== "string" || shared.toLowerCase() !== address))
    ) {
      issues.push({ field: `libraries.${String(position)}`, message: conflict });
      continue;
    }
    names.set(library, address);
    // Object.fromEntries defines each key as an own property, so a name such as __proto__ stays.
    merged.set(path, Object.fromEntries(names));
  }
  if (issues.length > 0) {
    throw invalid(issues);
  }
  return {
    ...checked,
    compiler: {
      ...checked.compiler,
      input: {
        ...checked.compiler.input,
        settings: { ...settings, libraries: Object.fromEntries(merged) },
      },
    },
  };
}

/** An `invalid-input` error listing `issues`, which name fields and never repeat a value. */
function invalid(issues: InputIssue[]): ExplorerVerifyError {
  const fields = issues.map((issue) => issue.field).join(", ");
  return new ExplorerVerifyError(
    { code: "invalid-input", issues },
    `The input is invalid: ${fields}.`,
    { secrets: [] },
  );
}
