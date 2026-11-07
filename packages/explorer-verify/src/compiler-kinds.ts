/**
 * Which backend clients verify which compiler kind, on which chains (R-EXT-1, decisions 0004 and
 * 0057). Every client maps `solc` on every chain. A client maps `zksolc` only on the chains whose
 * explorer reads the zksolc fields it sends; the routing table passes over any other backend for
 * zksolc input, and the flow engine refuses such input before any request when the route's backend
 * does not map it there. The list is static, so the route is chosen before any client loads.
 *
 * Only the flows that take input import this module: `checkStatus()` and `linkProxy()` do not, so
 * their bundles do not hold it.
 */
import type { BackendName } from "./backend-names.ts";
import { newError } from "./error-hints.ts";
import type { ExplorerVerifyError } from "./errors.ts";
import type { VerifyInput } from "./types.ts";

/** A `compiler.kind` of {@link VerifyInput}. */
export type CompilerKind = VerifyInput["compiler"]["kind"];

/** Backends and the chains on which each one's client maps zksolc input. */
export type ZksolcRoutes = readonly (readonly [BackendName, readonly number[]])[];

/**
 * The backends whose client maps zksolc input, each with the chains whose explorer reads the
 * zksolc fields. Blockscout maps the fields on chains 324 and 300 (decision 0059). Keyed by chain
 * as well as backend, so that mapping Blockscout cannot send zksolc input to another instance.
 */
export const ZKSOLC_ROUTES: ZksolcRoutes = [["blockscout", [324, 300]]];

/** The compiler kind of one call's input, as the routing reads it. */
export interface KindCheck {
  /** Whether `backend`'s client verifies the input's kind on the call's chain. */
  readonly verifies: (backend: BackendName) => boolean;
  /**
   * `unsupported-compiler` naming `compiler.kind`, for a backend that does not verify the kind,
   * or, without one, for a chain where no backend does. The flow throws it before any request.
   */
  readonly refused: (backend?: BackendName) => ExplorerVerifyError;
}

/**
 * The kind check of input of `kind` on chain `chainId`. Throws when no backend verifies the kind on
 * the chain, before any route is chosen, so no hint names a route that would be refused.
 *
 * @param kind - The input's `compiler.kind`.
 * @param chainId - The chain of the call.
 * @param zksolc - The backends and chains that map zksolc; {@link ZKSOLC_ROUTES} by default.
 * @returns The check.
 * @throws ExplorerVerifyError `unsupported-compiler` when no backend verifies the kind on the chain.
 * @example
 * ```ts
 * kindCheck("solc", 324).verifies("sourcify"); // true
 * ```
 */
export function kindCheck(
  kind: CompilerKind,
  chainId: number,
  zksolc: ZksolcRoutes = ZKSOLC_ROUTES,
): KindCheck {
  const chain = `${kind} input on chain ${String(chainId)}`;
  const check: KindCheck = {
    verifies: (backend) =>
      kind === "solc" ||
      zksolc.some(([name, chains]) => name === backend && chains.includes(chainId)),
    refused: (backend) =>
      newError(
        { code: "unsupported-compiler", field: "compiler.kind" },
        backend === undefined
          ? `No backend of this release verifies ${chain}.`
          : `The ${backend} backend does not verify ${chain}.`,
        // The code's default hint, which names no route: unsupported backend/chain pairs name the supported kinds.
        // Stryker disable next-line ObjectLiteral,ArrayDeclaration: equivalent. The message holds only the backend, the kind and the chain id.
        { secrets: [] },
      ),
  };
  if (kind !== "solc" && !zksolc.some(([, chains]) => chains.includes(chainId))) {
    throw check.refused();
  }
  return check;
}
