/**
 * The public contract of explorer-verify, drafted from docs/contributor/requirements.md before any
 * backend exists. Every type is experimental until 1.0: change it when an implementation shows a
 * better shape, and record the change in the decision log.
 */
import type { BackendName } from "./backend-names.ts";

/** A hex string with the `0x` prefix. */
export type Hex = `0x${string}`;

/**
 * The Solidity compiler's Standard JSON input, as solc reads it. Only the fields this library
 * reads are typed; the rest pass through to the explorer unchanged.
 *
 * @experimental
 */
export interface SolidityStandardJsonInput {
  /** Always `"Solidity"` for this input kind. */
  language: "Solidity";
  /** Source files by path, with their content. */
  sources: Record<string, { content: string }>;
  /** Compiler settings: optimizer, EVM version, libraries, metadata and so on. */
  settings: Record<string, unknown>;
}

/**
 * What to verify. `compiler` is a discriminated union so other languages (Vyper and others) can
 * be added as new members without changing existing callers (decision 0004).
 *
 * @experimental
 */
export interface VerifyInput {
  /** EVM chain id the contract is deployed on. */
  chainId: number;
  /** The deployed contract address. */
  address: Hex;
  /** The compiler and its input. */
  compiler: {
    /** The compiler family. */
    kind: "solc";
    /** Full version, as `0.8.24+commit.e11b9ed9`. */
    version: string;
    /** The Standard JSON input used for the deployment. */
    input: SolidityStandardJsonInput;
  };
  /** Fully qualified contract name, as `src/Token.sol:Token`. */
  contractName: string;
  /** ABI-encoded constructor arguments without the selector. Derived from the creation code when absent. */
  constructorArgs?: Hex;
  /** The creation transaction hash. Lets backends that support it attempt a creation match. */
  creationTxHash?: Hex;
}

/**
 * The outcome of a verification. `failed` means the explorer definitively rejected the
 * submission; any unknown or ambiguous state throws instead, so a caller never mistakes it for
 * success. `match` is `partial` when the explorer matched the code but not its metadata hash.
 *
 * @experimental
 */
export type VerifyResult =
  | { status: "verified"; backend: BackendName; match: "exact" | "partial"; explorerUrl: string }
  | {
      status: "already-verified";
      backend: BackendName;
      match: "exact" | "partial";
      explorerUrl: string;
    }
  | { status: "failed"; backend: BackendName; reason: string };
