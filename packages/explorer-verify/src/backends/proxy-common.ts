/**
 * What the proxy-link code shares (R-FLOW-8): reading the answer that names the implementation,
 * the strict check of an implementation address, and the error for an answer it does not know.
 * Etherscan and Blockscout both answer
 * `The proxy's (<proxy>) implementation contract is found at <implementation> and …`.
 * Internal: the package entry point does not export it.
 */
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { Hex } from "../types.ts";
import type { Context } from "./backend.ts";
import type { Answer } from "./common.ts";

// One implementation: exactly `0x` and 40 hex digits, then " and". A longer run of hex digits does
// not match. From the live answers in docs/contributor/research/2026-11-04-proxy-linking.md.
const FOUND_ONE =
  /^The proxy's \((0x[0-9a-fA-F]{40})\) implementation contract is found at (0x[0-9a-fA-F]{40}) and (.+)$/;
// Blockscout's form for any other number of implementations, from its source.
const FOUND_NONE =
  /^The proxy's \((0x[0-9a-fA-F]{40})\) implementation contracts are found at \[\] and (.+)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO: Hex = `0x${"0".repeat(40)}`;

/** What a "found at" answer says. */
export type Found =
  | { readonly kind: "one"; readonly implementation: Hex; readonly rest: string }
  | { readonly kind: "none"; readonly rest: string };

/**
 * Reads an answer that names the implementation the explorer found for the proxy. Several
 * implementations, an address that is not exactly 40 hex digits, the zero address, or another
 * proxy than `proxy` give `undefined`: the caller then throws `proxy-link-unknown-state`.
 *
 * @param text - The `result` text.
 * @param proxy - The proxy's address, in lower case.
 * @returns One implementation in lower case, or none, with the text after it; or `undefined`.
 * @example
 * ```ts
 * const found = foundImplementation(result, target.address);
 * if (found?.kind === "one" && found.rest === "is successfully updated.") {
 *   // linked
 * }
 * ```
 */
export function foundImplementation(text: string, proxy: string): Found | undefined {
  const one = FOUND_ONE.exec(text);
  // Each group always takes part in a match, so String() never sees undefined.
  if (one !== null && String(one[1]).toLowerCase() === proxy) {
    const implementation = implementationOf(String(one[2]));
    return implementation === undefined
      ? undefined
      : { kind: "one", implementation, rest: String(one[3]) };
  }
  const none = FOUND_NONE.exec(text);
  return none !== null && String(none[1]).toLowerCase() === proxy
    ? { kind: "none", rest: String(none[2]) }
    : undefined;
}

/**
 * An implementation address in lower case: exactly `0x` and 40 hex digits, and not the zero
 * address. Anything else gives `undefined`.
 *
 * @param value - The value an explorer gave.
 * @returns The address, or `undefined`.
 * @example
 * ```ts
 * implementationOf("0x75038a8C55f5ec7196b54384FDbcffb1f2ce9920"); // "0x75038a8c…9920"
 * ```
 */
export function implementationOf(value: unknown): Hex | undefined {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    return undefined;
  }
  const address: Hex = `0x${value.slice(2).toLowerCase()}`;
  return address === ZERO ? undefined : address;
}

/**
 * `proxy-link-unknown-state` for a proxy-link answer the client does not know (R-FLOW-4). It
 * carries no handle: a link has none.
 *
 * @param ctx - The call's context, for its secrets.
 * @param backend - The backend that answered.
 * @param label - The API's name in messages, such as `Etherscan`.
 * @param answer - The answer.
 * @returns The error.
 * @example
 * ```ts
 * throw unknownLink(ctx, "blockscout", "Blockscout", answer);
 * ```
 */
export function unknownLink(
  ctx: Context,
  backend: BackendName,
  label: string,
  answer: Answer,
): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "proxy-link-unknown-state", backend, excerpt: answer.text },
    `${label} reported a proxy link state that this client does not recognise; whether the proxy is linked is not known.`,
    { secrets: ctx.http.secrets },
  );
}
