// `apiKeys` as a JavaScript caller may pass it: a backend name the type refuses (decision 0046),
// so the tests reach the runtime check without a cast.
import type { VerifyOptions } from "../../src/index.ts";

/**
 * An `apiKeys` object with one entry under any name.
 *
 * @param name - The backend name, such as `blockscout`, which TypeScript refuses.
 * @param key - The value.
 * @returns The object, typed as `VerifyOptions.apiKeys`.
 */
export function jsKeys(name: string, key: string): NonNullable<VerifyOptions["apiKeys"]> {
  const keys: Record<string, string> = { [name]: key };
  return keys;
}
