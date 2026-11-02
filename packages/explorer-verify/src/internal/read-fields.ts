/**
 * Readers shared by the checks of untrusted caller values: `parseHandle`, `validateInput` and
 * `resolveRoute`. Internal: not exported from the package entry point.
 */

const ADDRESS = /^0x([0-9a-fA-F]{40})$/;

/**
 * Own enumerable fields of `value`, read once. `undefined` when `value` is not a non-array object
 * or when reading it throws, as a hostile Proxy or getter does. The thrown error is dropped: it may
 * repeat a caller value.
 */
export function readFields(value: unknown): Map<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    if (Array.isArray(value)) {
      return undefined;
    }
    return new Map<string, unknown>(Object.entries(value));
  } catch {
    return undefined;
  }
}

/**
 * The 40 hex digits of an address after its `0x`, in the case given, or `undefined` when `value`
 * is not a string of `0x` followed by exactly 40 hex digits. Format only: the EIP-55 checksum is
 * not checked.
 */
export function addressDigits(value: unknown): string | undefined {
  return typeof value === "string" ? ADDRESS.exec(value)?.[1] : undefined;
}

/** `value` when it is a positive safe integer, the only valid chain id, else `undefined`. */
export function readChainId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
