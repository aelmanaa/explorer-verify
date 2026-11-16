// References: R-EXT-1, decisions 0004, 0057 and 0075.
/**
 * Which backend clients verify which compiler kind, on which chains. Every client maps `solc` on
 * every chain. Each other kind has its own list: a backend and the chains on which its client maps
 * the kind. The routing table passes over any other
 * backend for such input, and the flow engine refuses the input before any request when the
 * route's backend does not map it there. The lists are static, so the route is chosen before any
 * client loads.
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

/** Backends and the chains on which each one's client maps one compiler kind. */
export type KindRoutes = readonly (readonly [BackendName, readonly number[]])[];

/**
 * The routes of each compiler kind other than solc, which every client maps on every chain. A kind
 * left out takes its list from {@link COMPILER_ROUTES}.
 */
export type CompilerRoutes = Partial<Readonly<Record<Exclude<CompilerKind, "solc">, KindRoutes>>>;

// References: decision 0059.
/**
 * The backends whose client maps zksolc input, each with the chains whose explorer reads the
 * zksolc fields. Blockscout maps the fields on chains 324 and 300. Keyed by chain
 * as well as backend, so that mapping Blockscout cannot send zksolc input to another instance.
 */
export const ZKSOLC_ROUTES: KindRoutes = [["blockscout", [324, 300]]];

// References: decision 0075.
/**
 * The backends whose client maps Vyper input. Empty in this release: every route refuses Vyper
 * input before any request. Each backend that maps Vyper later adds its entry here.
 */
export const VYPER_ROUTES: KindRoutes = [];

/** The routes of every compiler kind other than solc. */
export const COMPILER_ROUTES: Required<CompilerRoutes> = {
  zksolc: ZKSOLC_ROUTES,
  vyper: VYPER_ROUTES,
};

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
 * @param routes - Routes that replace those of {@link COMPILER_ROUTES} for the kinds they name.
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
  routes: CompilerRoutes = {},
): KindCheck {
  const chain = `${kind} input on chain ${String(chainId)}`;
  const listed = kind === "solc" ? undefined : (routes[kind] ?? COMPILER_ROUTES[kind]);
  const check: KindCheck = {
    verifies: (backend) =>
      listed === undefined ||
      listed.some(([name, chains]) => name === backend && chains.includes(chainId)),
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
  if (listed !== undefined && !listed.some(([, chains]) => chains.includes(chainId))) {
    throw check.refused();
  }
  return check;
}
