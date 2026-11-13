// References: R-FLOW-1, decision 0063.
/**
 * Whether the source an explorer holds for an address is the input's. Outside parties store a
 * match for a common contract within minutes of its deployment, under another contract name and
 * compiler version. Such a match does not verify the caller's source, so `verify()` submits over
 * it (docs/contributor/research/2026-11-10-foreign-matches.md).
 */
import type { Stored } from "../backends/backend.ts";
import type { StoredContract, VerifyInput } from "../types.ts";

/**
 * The contract the explorer holds when it is not the input's, or `undefined` when it is, or when
 * the answer names no contract and no compiler.
 *
 * - Names: a stored `path:Name`, as Sourcify gives it, is compared with the whole
 *   `contractName`; a stored `Name` with the part of `contractName` after its last `:`.
 * - Compiler versions: compared without a leading `v` and in lower case. When one of the two has
 *   no `+commit.` part, only the parts before `+` are compared. A zksolc input compares its
 *   `solcVersion`, which is what Blockscout stores as the compiler version.
 *
 * @param stored - The stored contract, as a lookup read it.
 * @param input - The checked input.
 * @returns The stored contract, or `undefined`.
 * @example
 * ```ts
 * const other = otherContract({ name: "SimpleStorage", compilerVersion: "v0.8.33" }, input);
 * ```
 */
export function otherContract(stored: Stored, input: VerifyInput): StoredContract | undefined {
  const { name, compilerVersion } = stored;
  const own = input.contractName;
  const { compiler } = input;
  if (
    (name === undefined ||
      name === (name.includes(":") ? own : own.slice(own.lastIndexOf(":") + 1))) &&
    (compilerVersion === undefined ||
      sameVersion(
        compilerVersion,
        compiler.kind === "zksolc" ? compiler.solcVersion : compiler.version,
      ))
  ) {
    return undefined;
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(compilerVersion === undefined ? {} : { compilerVersion }),
  };
}

/**
 * The start of a message about another contract's source: the explorer, and the stored
 * contract's name and compiler version, those the explorer gives.
 *
 * @param label - The explorer's label, from `BACKEND_LABELS`.
 * @param other - The stored contract.
 * @returns The text, such as
 *   `Sourcify holds another contract's source (SimpleStorage, 0.8.33+commit.64118f21)`.
 * @example
 * ```ts
 * log.info(`${heldText("Sourcify", other)}; submitting this source.`);
 * ```
 */
export function heldText(label: string, other: StoredContract): string {
  return `${label} holds another contract's source (${Object.values(other).join(", ")})`;
}

/** Two compiler versions as the same release: see {@link otherContract}. */
function sameVersion(stored: string, own: string): boolean {
  const a = parts(stored);
  const b = parts(own);
  return a[0] === b[0] && (a.length < 2 || b.length < 2 || a[1] === b[1]);
}

/** A version without a leading `v`, in lower case, split at `+`. */
function parts(version: string): string[] {
  // Stryker disable next-line Regex,MethodExpression: equivalent. A compiler version has a `v` only as its first character, and both versions compared get the same case.
  return version.replace(/^v/i, "").toLowerCase().split("+");
}
