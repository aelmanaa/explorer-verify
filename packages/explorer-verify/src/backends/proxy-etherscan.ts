/**
 * Links a proxy on Etherscan v2 and on standalone Etherscan-compatible explorers (R-FLOW-8):
 * `verifyproxycontract`, then `checkproxyverification` with the guid it answers. Both are
 * form-encoded POSTs, so the key goes in the body and never in the URL (decision 0016, R-SEC-1).
 * `linkProxy()` loads this module with a dynamic `import()`, so `verify()` never bundles it.
 *
 * `status` is never read on its own: Etherscan answered `Pending in queue` with `status` `"0"`,
 * and a refusal comes with `status` `"0"` too. Only the `result` text decides. The evidence for
 * each text is in docs/contributor/research/2026-11-04-proxy-linking.md.
 */
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import { readFields } from "../internal/read-fields.ts";
import { redactExcerpt } from "../redact.ts";
import type { Context, LinkStep, LinkTarget, LinkVerdict, ProxyLinker } from "./backend.ts";
import { REASON_LENGTH, send, unexpected } from "./common.ts";
import type { Answer } from "./common.ts";
import { knownAnswer, post } from "./etherscan.ts";
import { foundImplementation, implementationOf, unknownLink } from "./proxy-common.ts";

// The guid of a link request: 50 lowercase letters and digits, as in Etherscan's documentation
// and every live answer. Any other `result`, such as `OK`, is not polled.
const GUID = /^[a-z0-9]{50}$/;
const PENDING = "Pending in queue";
const LINKED = "is successfully updated.";
const WITHOUT_ABI = "implementation saved (unverified - without ABI).";
// The proxy points at another implementation than `expectedimplementation`.
const MISMATCH =
  /^The provided expected results are different than the retrieved implementation address!/;
// The refusals, matched at the start: an address whose code has no delegatecall (no proxy, or no
// code at all), and a proxy Etherscan has not verified, from its documentation's only example.
const REFUSALS: readonly RegExp[] = [
  /^This contract does not look like it contains any delegatecall opcode sequence\./,
  /^The proxy contract at 0x[0-9a-fA-F]{40} does not seem to be verified\./,
];

/**
 * Builds the proxy-link code of an Etherscan-style API.
 *
 * | Step     | Form body                                                                               |
 * | -------- | --------------------------------------------------------------------------------------- |
 * | request  | `module=contract&action=verifyproxycontract&address=<proxy>[&expectedimplementation=…]` |
 * | check    | `module=contract&action=checkproxyverification&guid=<guid>`                             |
 * | mismatch | `module=contract&action=getsourcecode&address=<proxy>`, for the `Implementation` it holds |
 *
 * @param name - The backend: `etherscan-v2` or `etherscan-compatible`.
 * @param label - The API's name in messages.
 * @returns The linker.
 * @example
 * ```ts
 * const linker = etherscanLinker("etherscan-v2", "Etherscan");
 * ```
 */
function etherscanLinker(name: BackendName, label: string): ProxyLinker {
  /**
   * Sends `verifyproxycontract`: a guid to check, or a refusal. Any other answer throws
   * `unexpected-response`: nothing started, so there is no link state to report.
   */
  async function request(target: LinkTarget, ctx: Context): Promise<LinkStep> {
    const fields: Record<string, string> = {
      action: "verifyproxycontract",
      address: target.address,
    };
    if (target.expectedImplementation !== undefined) {
      fields["expectedimplementation"] = target.expectedImplementation;
    }
    const answer = await send(ctx, post(ctx, name, fields));
    const result = knownAnswer(name, label, ctx, answer, target.chainId);
    if (answer.status === 200 && result !== undefined) {
      // Stryker disable next-line OptionalChaining: equivalent. knownAnswer gives a result only for an answer with fields.
      if (answer.fields?.get("status") === "1" && GUID.test(result)) {
        return { state: "submitted", jobId: result };
      }
      if (MISMATCH.test(result)) {
        return await mismatch(target, ctx);
      }
      const refused = refusal(ctx, result);
      if (refused !== undefined) {
        return refused;
      }
    }
    throw unexpected(ctx, name, label, answer, "the proxy link request");
  }

  /** Sends `checkproxyverification` once and maps its `result` text. */
  async function check(jobId: string, target: LinkTarget, ctx: Context): Promise<LinkVerdict> {
    const answer = await send(
      ctx,
      post(ctx, name, { action: "checkproxyverification", guid: jobId }),
    );
    const result = knownAnswer(name, label, ctx, answer, target.chainId);
    if (answer.status !== 200 || result === undefined) {
      throw unexpected(ctx, name, label, answer, "the proxy link status request");
    }
    if (result.startsWith(PENDING)) {
      return { state: "pending" };
    }
    if (MISMATCH.test(result)) {
      return await mismatch(target, ctx);
    }
    return readResult(ctx, answer, result, target);
  }

  /** The step a final `checkproxyverification` text gives. `Error!` and every unknown text throw. */
  function readResult(
    ctx: Context,
    answer: Answer,
    result: string,
    target: LinkTarget,
  ): LinkVerdict {
    const found = foundImplementation(result, target.address);
    if (found?.kind === "one") {
      if (found.rest === LINKED) {
        return {
          state: "linked",
          implementation: found.implementation,
          implementationVerified: true,
        };
      }
      if (found.rest === WITHOUT_ABI) {
        return {
          state: "linked",
          implementation: found.implementation,
          implementationVerified: false,
        };
      }
    }
    const refused = refusal(ctx, result);
    if (refused !== undefined) {
      return refused;
    }
    throw unknownLink(ctx, name, label, answer);
  }

  /**
   * The refusal for another implementation than expected does not name the one the explorer
   * holds: one `getsourcecode` reads the `Implementation` of its record of the proxy. An empty or
   * malformed one leaves it absent. The refusal is definitive, so a lookup that fails, or answers
   * in another form, also leaves it absent and is logged at `warn`. An abort still rejects.
   */
  async function mismatch(target: LinkTarget, ctx: Context): Promise<LinkVerdict> {
    try {
      const answer = await send(
        ctx,
        post(ctx, name, { action: "getsourcecode", address: target.address }),
      );
      knownAnswer(name, label, ctx, answer, target.chainId);
      const result = answer.fields?.get("result");
      if (answer.status !== 200 || !Array.isArray(result)) {
        // Stryker disable next-line StringLiteral: equivalent. The catch block below logs only the code of this error, never its message.
        throw unexpected(ctx, name, label, answer, "the lookup of the proxy");
      }
      return {
        state: "mismatch",
        implementation: implementationOf(readFields(result[0])?.get("Implementation")),
      };
    } catch (error: unknown) {
      if (ctx.http.signal?.aborted === true || !(error instanceof ExplorerVerifyError)) {
        throw error;
      }
      ctx.http.observer?.log.warn(
        `${label} refused the link for another implementation; the lookup of the one it holds failed (${error.code})`,
        { backend: name, code: error.code },
      );
      return { state: "mismatch", implementation: undefined };
    }
  }

  return { request, check };
}

/** `not-linked` with the explorer's text, redacted and cut, when the text is a known refusal. */
function refusal(ctx: Context, result: string): LinkVerdict | undefined {
  return REFUSALS.some((pattern) => pattern.test(result))
    ? { state: "not-linked", reason: redactExcerpt(result, ctx.http.secrets, REASON_LENGTH) }
    : undefined;
}

/**
 * The proxy-link code of the Etherscan v2 API.
 *
 * @example
 * ```ts
 * const step = await etherscanProxyLinker.request({ chainId: 11155111, address }, ctx);
 * ```
 */
export const etherscanProxyLinker: ProxyLinker = etherscanLinker("etherscan-v2", "Etherscan");

/**
 * The proxy-link code of a standalone Etherscan-compatible explorer, at the route's `apiUrl`.
 *
 * @example
 * ```ts
 * const step = await compatibleProxyLinker.request({ chainId: 296, address }, ctx);
 * ```
 */
export const compatibleProxyLinker: ProxyLinker = etherscanLinker(
  "etherscan-compatible",
  "Etherscan-compatible explorer",
);
