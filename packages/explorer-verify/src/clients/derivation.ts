// References: decision 0052.
/**
 * The constructor argument derivation that the clients of `explorer-verify/clients/*` which take
 * constructor arguments bring, imported statically. The Sourcify client does not
 * import it.
 */
import type { DeriveLoader } from "../flow/verify.ts";
import { withDerivedArgs } from "../input/constructor-args.ts";

/**
 * Gives the derivation. One object, so the engine keeps what it gave, as it does for the default
 * entry's loader.
 *
 * @returns The derivation.
 * @example
 * ```ts
 * export const etherscanV2 = defineClient({ backend: etherscan, derivation });
 * ```
 */
export const derivation: DeriveLoader = async () => await Promise.resolve(withDerivedArgs);
