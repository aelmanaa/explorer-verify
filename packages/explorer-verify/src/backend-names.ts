/**
 * The explorer verification APIs explorer-verify targets. A backend is one such API; each gets its
 * own client, and a per-chain routing table maps a chain id to one of them
 * (docs/contributor/architecture.md).
 *
 * @experimental
 */
export const BACKEND_NAMES = [
  "etherscan-v2",
  "etherscan-compatible",
  "blockscout",
  "blockscout-hosted",
  "sourcify",
  "routescan",
] as const;

/**
 * One of {@link BACKEND_NAMES}.
 *
 * @experimental
 */
export type BackendName = (typeof BACKEND_NAMES)[number];

/**
 * Looks up a backend by name.
 *
 * @param value - Any value, for example a string from configuration.
 * @returns The matching {@link BackendName}, or `undefined` when `value` names none.
 * @experimental
 */
export function toBackendName(value: unknown): BackendName | undefined {
  return BACKEND_NAMES.find((name) => name === value);
}

/**
 * A backend that takes a key from `VerifyOptions.apiKeys`: `etherscan-v2`, `routescan` or
 * `blockscout-hosted`. The other backends take no key there: `sourcify` and `blockscout` take
 * none, and a standalone explorer (`etherscan-compatible`) takes its key as `route.apiKey`, next to
 * its `apiUrl`.
 *
 * @example
 * ```ts
 * import type { KeyedBackendName } from "explorer-verify";
 *
 * const backend: KeyedBackendName = "etherscan-v2";
 * ```
 * @experimental
 */
export type KeyedBackendName = Extract<
  BackendName,
  "etherscan-v2" | "routescan" | "blockscout-hosted"
>;
