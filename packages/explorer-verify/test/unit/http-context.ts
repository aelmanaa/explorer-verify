// Builds an HttpContext for the HTTP-layer tests. A test passes a raw logger and onEvent, as a
// caller passes them to verify(); this helper turns them into the call's observer, as verify()
// does, with the context's secrets.
import type { HttpContext } from "../../src/http/fetch.ts";
import { createObserver } from "../../src/observe.ts";
import type { ObserverOptions } from "../../src/observe.ts";

/** Context fields, plus the caller's logger and callback. */
export type ContextOverrides = Partial<HttpContext> & {
  readonly logger?: ObserverOptions["logger"];
  readonly onEvent?: ObserverOptions["onEvent"];
};

/**
 * `base` with `overrides`, where `logger` and `onEvent` become one observer that redacts with the
 * resulting `secrets`.
 */
export function contextWith(base: HttpContext, overrides: ContextOverrides): HttpContext {
  const { logger, onEvent, ...rest } = overrides;
  const ctx: HttpContext = { ...base, ...rest };
  if (logger === undefined && onEvent === undefined) {
    return ctx;
  }
  return { ...ctx, observer: createObserver({ logger, onEvent, secrets: ctx.secrets }) };
}
