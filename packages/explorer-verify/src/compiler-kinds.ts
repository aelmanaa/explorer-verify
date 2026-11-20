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

/** The chains of one backend for one compiler kind: a list of chain ids, or `"every"` chain. */
type KindChains = readonly number[] | "every";

/** Backends and the chains on which each one's client maps one compiler kind. */
export type KindRoutes = readonly (readonly [BackendName, KindChains])[];

/** The kinds that have a list of routes: every client maps solc on every chain, so it has none. */
type ListedKind = Exclude<CompilerKind, "solc">;

/**
 * The routes of each compiler kind other than solc. A kind left out takes its list from
 * {@link COMPILER_ROUTES}. Indexed by any kind, it gives `undefined` for solc.
 */
export type CompilerRoutes = { readonly [K in ListedKind]?: KindRoutes } & {
  readonly solc?: never;
};

// References: decision 0059.
/**
 * The backends whose client maps zksolc input, each with the chains whose explorer reads the
 * zksolc fields. Blockscout maps the fields on chains 324 and 300. Keyed by chain
 * as well as backend, so that mapping Blockscout cannot send zksolc input to another instance.
 */
export const ZKSOLC_ROUTES: KindRoutes = [["blockscout", [324, 300]]];

// References: decision 0075, issue #423.
/**
 * The backends whose client maps Vyper input. Sourcify verifies Vyper on every chain it serves,
 * through the request it takes for solc. Every other backend refuses Vyper input before any
 * request; each one that maps Vyper later adds its entry here.
 */
export const VYPER_ROUTES: KindRoutes = [["sourcify", "every"]];

/** The routes of every compiler kind other than solc. */
export const COMPILER_ROUTES: { readonly [K in ListedKind]: KindRoutes } & {
  readonly solc?: never;
} = {
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
  const listed = routes[kind] ?? COMPILER_ROUTES[kind];
  const check: KindCheck = {
    verifies: (backend) =>
      listed === undefined ||
      listed.some(([name, chains]) => name === backend && covers(chains, chainId)),
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
  if (listed !== undefined && !listed.some(([, chains]) => covers(chains, chainId))) {
    throw check.refused();
  }
  return check;
}

/** Whether `chains` holds `chainId`. */
function covers(chains: KindChains, chainId: number): boolean {
  return chains === "every" || chains.includes(chainId);
}

// References: R-EXT-1, decision 0077.
/**
 * The kind check of one input: {@link kindCheck}, less the backends that map the kind but not
 * this input. Sourcify does not verify Vyper input before 0.4.0 that has interfaces: it refuses a
 * top-level `interfaces` field, and before 0.4.0 Vyper compiles every file of `sources` and cannot
 * read an interface from there. Throws when no backend is left, before any route is chosen.
 *
 * @param input - The checked input.
 * @param routes - Routes that replace those of {@link COMPILER_ROUTES} for the kinds they name.
 * @returns The check.
 * @throws ExplorerVerifyError `unsupported-compiler` when no backend verifies the input on its
 *   chain.
 * @example
 * ```ts
 * const kinds = inputCheck(checked);
 * ```
 */
export function inputCheck(input: VerifyInput, routes: CompilerRoutes = {}): KindCheck {
  const { compiler, chainId } = input;
  const check = kindCheck(compiler.kind, chainId, routes);
  if (
    compiler.kind !== "vyper" ||
    !compiler.version.startsWith("0.3.") ||
    Object.keys(compiler.input.interfaces ?? {}).length === 0
  ) {
    return check;
  }
  const refusal = newError(
    { code: "unsupported-compiler", field: "compiler.input.interfaces" },
    `Sourcify does not verify Vyper ${compiler.version} input with interfaces: before Vyper 0.4.0 the compiler cannot read an interface from sources, and Sourcify refuses a top-level interfaces field.`,
    {
      // Stryker disable next-line ArrayDeclaration: equivalent. The message holds only the checked compiler version.
      secrets: [],
      hint: "Inline each interface into the contract source, or build the contract with Vyper 0.4.0 or later, then verify again.",
    },
  );
  const verifies = (backend: BackendName): boolean =>
    backend !== "sourcify" && check.verifies(backend);
  if (!(routes.vyper ?? VYPER_ROUTES).some(([name]) => verifies(name))) {
    throw refusal;
  }
  return {
    verifies,
    refused: (backend) => (backend === "sourcify" ? refusal : check.refused(backend)),
  };
}
