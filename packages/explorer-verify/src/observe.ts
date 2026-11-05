/**
 * The two ways out for diagnostics: the caller's logger and the caller's `onEvent` callback
 * (R-DX-5, R-DX-6, decision 0010). Both pass the one redaction step of {@link redact} first
 * (R-SEC-1), and neither can break a verification: a logger or a callback that throws is caught.
 * Without a logger and a callback, nothing is written anywhere.
 */
import { redactHandleLine } from "./flow/format-handle.ts";
import { redact, redactingLogger } from "./redact.ts";
import type { Logger, VerifyEvent } from "./types.ts";

/**
 * Where a call sends its log lines and events. `VerifyOptions` fits it once `secrets` is added.
 *
 * @example
 * ```ts
 * const sinks: ObserverOptions = { logger: options.logger, onEvent: options.onEvent, secrets: [] };
 * ```
 */
export interface ObserverOptions {
  /** The caller's logger. Nothing is logged without it. */
  readonly logger?: Logger | undefined;
  /** The caller's event callback. Nothing is emitted without it. */
  readonly onEvent?: ((event: VerifyEvent) => void | Promise<void>) | undefined;
  /** Key values to remove from every log line and event. Pass `[]` when the call has no key. */
  readonly secrets: readonly string[];
}

/**
 * A call's safe log and event functions. Neither ever throws. One call creates one observer with
 * {@link createObserver} and passes it to every layer, so a broken callback is reported once.
 *
 * @example
 * ```ts
 * const observer = createObserver({ logger: options.logger, onEvent: options.onEvent, secrets });
 * observer.emit({ type: "verify.validated", chainId: input.chainId, address: input.address });
 * observer.log.debug("validated", { chainId: input.chainId });
 * ```
 */
export interface Observer {
  /** The caller's logger behind redaction, or a logger that does nothing. */
  readonly log: Logger;
  /** Redacts an event and passes it to the caller's callback, or does nothing. */
  readonly emit: (event: VerifyEvent) => void;
}

/** Does nothing: the method of a silent logger and the emit of a call without `onEvent`. */
const nothing = (): void => {};

/** The logger used when the caller passes none: it writes nothing (decision 0010). */
const SILENT: Logger = { debug: nothing, info: nothing, warn: nothing, error: nothing };

/** An observer that writes nothing: no logger and no callback. */
export const SILENT_OBSERVER: Observer = { log: SILENT, emit: nothing };

const CALLBACK_FAILED = "The onEvent callback threw. The error is ignored and the call goes on.";

/**
 * Builds a call's {@link Observer}.
 *
 * - `log` redacts the message and every field name and value, and drops a line whose method
 *   throws or whose promise rejects (see {@link redactingLogger}).
 * - `emit` passes a frozen, redacted copy of the event to `onEvent`. When `onEvent` throws, or
 *   returns a promise that rejects, the error is logged at `warn` the first time and ignored after
 *   that; the outcome does not change. A returned promise is not awaited.
 *
 * @param options - The caller's logger, callback and keys.
 * @returns The safe `log` and `emit`.
 * @example
 * ```ts
 * const { emit } = createObserver({ onEvent: (event) => events.push(event), secrets: [apiKey] });
 * emit({ type: "verify.retry", backend: "sourcify", attempt: 2, reason: "network", delayMs: 500 });
 * ```
 */
export function createObserver(options: ObserverOptions): Observer {
  const { logger, onEvent, secrets } = options;
  // Stryker disable next-line ConditionalExpression: equivalent when always false. redactingLogger drops the line when reading a method of an undefined logger throws, as SILENT drops it.
  const log = logger === undefined ? SILENT : redactingLogger(logger, secrets);
  if (onEvent === undefined) {
    return { log, emit: nothing };
  }
  let warned = false;
  // `type` is read by the library before the callback runs, never from the object the callback
  // got, so a callback that changes that object cannot make this throw.
  const failed = (type: VerifyEvent["type"], error: unknown): void => {
    if (warned) {
      return;
    }
    warned = true;
    try {
      log.warn(CALLBACK_FAILED, { event: type, error: describe(error) });
    } catch {
      // The error could not be read as text, for example a getter on `message` threw.
      log.warn(CALLBACK_FAILED, { event: type, error: "[unloggable]" });
    }
  };
  const emit = (event: VerifyEvent): void => {
    const safe = Object.freeze(redactEvent(event, secrets));
    const type = safe.type;
    let returned: unknown;
    try {
      returned = onEvent(safe);
    } catch (error: unknown) {
      failed(type, error);
      return;
    }
    // Stryker disable next-line ConditionalExpression: equivalent when always true. A promise resolved with undefined never rejects.
    if (returned !== undefined) {
      // Not awaited: a slow callback must not hold the call. A value that is not a promise
      // resolves at once. `resolve` calls a thenable's `then` in a later job, never here, so a
      // `then` that throws becomes a rejection instead of an exception in this call.
      void new Promise<unknown>((resolve) => {
        resolve(returned);
      }).catch((error: unknown) => {
        failed(type, error);
      });
    }
  };
  return { log, emit };
}

/**
 * A copy of `event` with only its documented fields, and every free-text value redacted
 * (R-SEC-1): the address, the API host and the handle's job id. The job id uses the handle rule
 * of the envelope and the errors, so a job id shaped like an Etherscan key still resumes. `type`,
 * `backend`, `match`, `state`, `reason` and `status` hold fixed values chosen by the library and
 * numbers hold no text, so they are copied as they are.
 *
 * @param event - The event as the library built it.
 * @param secrets - Key values to remove.
 * @returns A new event of the same type.
 * @example
 * ```ts
 * redactEvent({ type: "verify.routed", backend: "sourcify", apiHost: "sourcify.dev" }, []);
 * ```
 */
export function redactEvent(event: VerifyEvent, secrets: readonly string[]): VerifyEvent {
  switch (event.type) {
    case "verify.validated":
      return {
        type: event.type,
        chainId: event.chainId,
        address: `0x${redact(event.address.slice(2), secrets)}`,
      };
    case "verify.routed":
      return { type: event.type, backend: event.backend, apiHost: redact(event.apiHost, secrets) };
    case "verify.lookup":
      return { type: event.type, backend: event.backend, match: event.match };
    case "verify.submitted":
      return {
        type: event.type,
        backend: event.backend,
        handle: redactHandleLine(event.handle, secrets),
      };
    case "verify.poll":
      return {
        type: event.type,
        backend: event.backend,
        attempt: event.attempt,
        state: event.state,
      };
    case "verify.retry":
      return {
        type: event.type,
        backend: event.backend,
        attempt: event.attempt,
        reason: event.reason,
        delayMs: event.delayMs,
      };
    case "verify.result":
      return event.status === "failed"
        ? { type: event.type, backend: event.backend, status: event.status }
        : { type: event.type, backend: event.backend, status: event.status, match: event.match };
    default:
      return unreachable(event);
  }
}

/** Ends an exhaustive switch: the type checker rejects a call with any value. */
function unreachable(value: never): never {
  throw new TypeError(`Unknown event: ${JSON.stringify(value)}`);
}

/** An error as one line of text for the warning. Throws when the error cannot be read. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
