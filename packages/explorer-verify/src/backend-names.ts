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
