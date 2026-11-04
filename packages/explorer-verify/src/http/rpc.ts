/**
 * A JSON-RPC endpoint the caller configures (`rpcUrl`): the request to it, the `result` of its
 * answer, and the parts of its URL that may hold a key. The bytecode resolver (decision 0026) and
 * the constructor argument derivation (R-IN-3) both read the chain through it. Internal: the
 * package entry point does not export it.
 */
import { readFields } from "../internal/read-fields.ts";
import { MIN_SECRET_LENGTH } from "../redact.ts";
import type { HttpRequest } from "./fetch.ts";

/** A checked URL the caller configured: origin and path, and the query string kept apart. */
export interface Endpoint {
  readonly apiBase: string;
  readonly search: string;
}

/** The largest JSON-RPC answer read: 1 MiB. */
export const RPC_BODY_BYTES = 1_048_576;

/**
 * The parts of a configured URL that may hold a key: each path segment and each query value of
 * at least {@link MIN_SECRET_LENGTH} characters, as written and decoded. Providers put keys in
 * either place, so both are redacted from logs and errors. The host name is not.
 *
 * @param base - The checked URL.
 * @returns The values to redact.
 * @example
 * ```ts
 * endpointSecrets({ apiBase: "https://eth-sepolia.example.com/v2/abcdef0123456789", search: "" });
 * // ["abcdef0123456789"]
 * ```
 */
export function endpointSecrets(base: Endpoint): string[] {
  const url = new URL(`${base.apiBase}${base.search}`);
  const parts = [...url.pathname.split("/"), ...[...url.searchParams].map(([, value]) => value)];
  const found = new Set<string>();
  for (const part of parts) {
    for (const each of [part, safeDecode(part)]) {
      if (each.length >= MIN_SECRET_LENGTH) {
        found.add(each);
      }
    }
  }
  return [...found];
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * One JSON-RPC call as a request for the HTTP layer: a `POST` of `{ jsonrpc, id, method, params }`
 * to the endpoint, retried on transient failures.
 *
 * @param endpoint - The checked `rpcUrl`.
 * @param method - The JSON-RPC method, such as `eth_getTransactionByHash`.
 * @param params - Its parameters.
 * @returns The request.
 * @example
 * ```ts
 * const req = rpcRequest(endpoint, "eth_chainId", []);
 * ```
 */
export function rpcRequest(endpoint: Endpoint, method: string, params: unknown[]): HttpRequest {
  return {
    url: `${endpoint.apiBase}${endpoint.search}`,
    method: "POST",
    retry: "safe",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    headers: { "content-type": "application/json" },
  };
}

/**
 * A JSON body as its own fields, or `undefined` when it is not a JSON object.
 *
 * @param text - The body.
 * @returns The fields.
 * @example
 * ```ts
 * jsonFields('{"result":"0x1"}')?.get("result"); // "0x1"
 * ```
 */
export function jsonFields(text: string): Map<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return readFields(parsed);
  } catch {
    return undefined;
  }
}

/**
 * The `result` of a JSON-RPC answer: `undefined` when the status is not 200, the body is not a
 * JSON object, or it holds no `result` (an `error` answer). A `null` result stays `null`.
 *
 * @param status - The HTTP status.
 * @param text - The body.
 * @returns The result.
 * @example
 * ```ts
 * rpcResult(200, '{"jsonrpc":"2.0","id":1,"result":null}'); // null
 * ```
 */
export function rpcResult(status: number, text: string): unknown {
  return status === 200 ? jsonFields(text)?.get("result") : undefined;
}

/**
 * A JSON-RPC hex quantity of 1 to 16 digits as a number, such as an `eth_chainId` result.
 *
 * @param value - The result.
 * @returns The number, or `undefined` when `value` is not such a quantity.
 * @example
 * ```ts
 * hexQuantity("0xaa36a7"); // 11155111
 * ```
 */
export function hexQuantity(value: unknown): number | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(value)
    ? Number(value)
    : undefined;
}

/**
 * Whether an `eth_chainId` result names `chainId`.
 *
 * @param served - The result.
 * @param chainId - The chain of the call.
 * @returns `true` for a hex quantity equal to `chainId`.
 * @example
 * ```ts
 * servesChain("0xaa36a7", 11155111); // true
 * ```
 */
export function servesChain(served: unknown, chainId: number): boolean {
  return hexQuantity(served) === chainId;
}
