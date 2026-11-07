// References: R-FLOW-8, decisions 0016 and 0041.
/**
 * Links a proxy on a Blockscout instance. Blockscout detects proxies on its own; a
 * `verifyproxycontract` request asks it to read the implementation again, and
 * `checkproxyverification` with the guid it answers says what it found. Both are form-encoded
 * POSTs to the route's `/api`, built by the Blockscout client, so the hosted API gets its key in a
 * header and an instance gets none. `linkProxy()` loads this module with
 * a dynamic `import()`, so `verify()` never bundles it.
 *
 * Blockscout's answer does not say whether the implementation is verified, so one lookup on the
 * instance's REST API reads it. The evidence for each text is in
 * docs/contributor/research/2026-11-04-proxy-linking.md.
 */
import type { HttpRequest } from "../http/fetch.ts";
import { sleep } from "../http/fetch.ts";
import { readFields } from "../internal/read-fields.ts";
import { redactExcerpt } from "../redact.ts";
import type { Hex } from "../types.ts";
import type { Context, LinkStep, LinkTarget, LinkVerdict, ProxyLinker } from "./backend.ts";
import { ask, blockscout, blockscoutHosted, form, lookupRequest } from "./blockscout.ts";
import { REASON_LENGTH, resultOf, unexpected } from "./common.ts";
import type { Answer } from "./common.ts";
import { foundImplementation, implementationOf, unknownLink } from "./proxy-common.ts";

// The backend of the call: the same code links on an instance and on the hosted API (decision 0041).
const nameOf = (ctx: Context): "blockscout" | "blockscout-hosted" =>
  ctx.route.backend === "blockscout-hosted" ? "blockscout-hosted" : "blockscout";
const LABEL = "Blockscout";
const PENDING = "Verification in progress";
const LINKED: readonly string[] = [
  "is successfully updated.",
  "they've been successfully updated.",
];
// In `message`, with `status` "0" and a null `result`.
const NOT_VERIFIED = "Smart-contract not found or is not verified";
// In `message`: a request within the instance's minimum interval for one proxy, as right after
// `verify()` read the implementation.
const ONE_ATTEMPT = /^Only one attempt in (\d{1,9})ms$/;
// In `result`, with `status` "0" and `message` "NOTOK".
const NOT_DETECTED =
  "A corresponding implementation contract was unfortunately not detected for the proxy address.";
const NO_IMPLEMENTATION = "Blockscout detects no implementation for the proxy.";

/**
 * The Blockscout proxy-link code.
 *
 * | Step     | Request                                                                       |
 * | -------- | ----------------------------------------------------------------------------- |
 * | request  | `POST <apiBase>`, form `module=contract&action=verifyproxycontract&address=…` |
 * | check    | `POST <apiBase>`, form `module=contract&action=checkproxyverification&guid=…` |
 * | lookup   | `GET <apiBase>/v2/smart-contracts/{address}`                                  |
 *
 * A request within the instance's minimum interval for the proxy, `Only one attempt in <n>ms`, is
 * sent once more after `<n>` ms when that fits the time budget. When it is refused again, or the
 * wait does not fit, the REST lookup of the proxy gives the implementation Blockscout already
 * holds. An address that is not a proxy may stay `Verification in progress`: on 2026-11-04 a
 * verified contract with no delegatecall did for more than a minute, so the call ends with
 * `proxy-link-pending`.
 *
 * @example
 * ```ts
 * const step = await blockscoutProxyLinker.request({ chainId: 11155111, address }, ctx);
 * ```
 */
export const blockscoutProxyLinker: ProxyLinker = {
  request,
  check,
  verified,
};

/** Sends `verifyproxycontract`, once more after a repeat-interval refusal that fits the budget. */
async function request(target: LinkTarget, ctx: Context): Promise<LinkStep> {
  const first = await ask(ctx, nameOf(ctx), linkRequest(ctx, target), target.chainId);
  const wait = tooSoon(first);
  if (wait === undefined) {
    return readRequest(ctx, target, first);
  }
  const { budget, signal, observer } = ctx.http;
  if (budget === undefined || Date.now() + wait < budget.deadline) {
    observer?.log.warn(
      `Blockscout allows one proxy link request per ${String(wait)} ms; sending it again then`,
      { backend: nameOf(ctx), delayMs: wait },
    );
    await sleep(wait, signal);
    const second = await ask(ctx, nameOf(ctx), linkRequest(ctx, target), target.chainId);
    if (tooSoon(second) === undefined) {
      return readRequest(ctx, target, second);
    }
  }
  observer?.log.info("Blockscout refused another proxy link request; reading its record instead", {
    backend: nameOf(ctx),
  });
  return await recorded(target, ctx);
}

/** The `verifyproxycontract` request. */
function linkRequest(ctx: Context, target: LinkTarget): HttpRequest {
  return form(ctx, nameOf(ctx), { action: "verifyproxycontract", address: target.address }, "safe");
}

/** The wait a repeat-interval refusal asks for, in milliseconds, or `undefined` for any other answer. */
function tooSoon({ status, fields }: Answer): number | undefined {
  const message = fields?.get("message");
  const wait =
    status === 200 && fields?.get("status") === "0" && typeof message === "string"
      ? ONE_ATTEMPT.exec(message)
      : null;
  return wait === null ? undefined : Number(wait[1]);
}

/**
 * Maps a request answer: a uid of the documented form (the proxy's 40 hex digits and a hex
 * timestamp) to check, or `not-linked` for a proxy Blockscout has not verified. Any other answer
 * throws `unexpected-response`: nothing started.
 */
function readRequest(ctx: Context, target: LinkTarget, answer: Answer): LinkStep {
  const { status, fields } = answer;
  const result = resultOf(answer);
  const uid = new RegExp(`^${target.address.slice(2)}[0-9a-f]{1,16}$`);
  if (status === 200 && fields?.get("status") === "1" && result !== undefined && uid.test(result)) {
    return { state: "submitted", jobId: result };
  }
  const message = fields?.get("message");
  if (status === 200 && fields?.get("status") === "0" && message === NOT_VERIFIED) {
    return { state: "not-linked", reason: NOT_VERIFIED };
  }
  throw unexpected(ctx, nameOf(ctx), LABEL, answer, "the proxy link request");
}

/** Sends `checkproxyverification` once and maps its answer. */
async function check(jobId: string, target: LinkTarget, ctx: Context): Promise<LinkVerdict> {
  const name = nameOf(ctx);
  const answer = await ask(
    ctx,
    name,
    form(ctx, name, { action: "checkproxyverification", guid: jobId }, "safe"),
    target.chainId,
  );
  const result = answer.status === 200 ? resultOf(answer) : undefined;
  if (result === undefined) {
    throw unexpected(ctx, nameOf(ctx), LABEL, answer, "the proxy link status request");
  }
  if (result === PENDING) {
    return { state: "pending" };
  }
  if (result === NOT_DETECTED) {
    return { state: "not-linked", reason: redactExcerpt(result, ctx.http.secrets, REASON_LENGTH) };
  }
  const found = foundImplementation(result, target.address);
  if (found !== undefined && LINKED.includes(found.rest)) {
    return found.kind === "one"
      ? { state: "linked", implementation: found.implementation }
      : { state: "not-linked", reason: NO_IMPLEMENTATION };
  }
  // `Unknown UID` included: the uid came from this call, so Blockscout forgetting it is unknown.
  throw unknownLink(ctx, nameOf(ctx), LABEL, answer);
}

/**
 * The implementation Blockscout already holds for the proxy, from its REST lookup: `linked` for
 * one, `not-linked` for none. Several, or one that is not an address, throw
 * `proxy-link-unknown-state`; an answer in another form throws `unexpected-response`.
 */
async function recorded(target: LinkTarget, ctx: Context): Promise<LinkVerdict> {
  const name = nameOf(ctx);
  const answer = await ask(ctx, name, lookupRequest(ctx, name, target.address), target.chainId);
  const listed = answer.status === 200 ? answer.fields?.get("implementations") : undefined;
  if (!Array.isArray(listed)) {
    throw unexpected(ctx, nameOf(ctx), LABEL, answer, "the lookup of the proxy");
  }
  if (listed.length === 0) {
    return { state: "not-linked", reason: NO_IMPLEMENTATION };
  }
  const implementation: Hex | undefined =
    listed.length === 1 ? implementationOf(readFields(listed[0])?.get("address_hash")) : undefined;
  if (implementation === undefined) {
    throw unknownLink(ctx, nameOf(ctx), LABEL, answer);
  }
  return { state: "linked", implementation };
}

/** Whether the instance holds the implementation's verified source: one lookup. */
async function verified(implementation: Hex, chainId: number, ctx: Context): Promise<boolean> {
  const client = nameOf(ctx) === "blockscout" ? blockscout : blockscoutHosted;
  return (await client.lookup({ chainId, address: implementation }, ctx)) !== undefined;
}
