/**
 * Everything the CLI writes to stderr (R-AX-6, R-AX-14, R-AX-15): log lines from the logger, the
 * stage events from `onEvent`, the error of a run, and a spinner. stdout never receives any of it.
 *
 * Text lines are for people and may change in any release. With `--log-format json`, each line is
 * one JSON object with `schemaVersion`, `level`, `message` and `type`, then the event's or the
 * logger's fields. A field with a reserved name goes under a nested `fields` object.
 */
import type {
  ErrorJson,
  LogFields,
  Logger,
  LogValue,
  RoutedBy,
  VerifyEvent,
} from "explorer-verify";

import { detailLines, shellLine, visible } from "./hints.ts";
import { shows } from "./log-level.ts";
import type { LineLevel, LogFormat, LogLevel } from "./log-level.ts";
import { painter } from "./terminal.ts";
import type { Style } from "./terminal.ts";

/** A stream the CLI writes to, such as `process.stdout`. */
export interface OutputStream {
  /** Writes text as it is. */
  write: (text: string) => void;
  /** Whether the stream is a terminal. */
  readonly isTTY?: boolean | undefined;
}

/** The version of the JSON line shape, the same as the envelope's (R-AX-14). */
const SCHEMA_VERSION = 1;

/** Names a field cannot take at the top level of a JSON line. */
const RESERVED: ReadonlySet<string> = new Set([
  "schemaVersion",
  "level",
  "message",
  "type",
  "fields",
]);

/** The level of each event's line (R-AX-15). */
const EVENT_LEVELS: Readonly<Record<VerifyEvent["type"], LineLevel>> = {
  "verify.validated": "debug",
  "verify.routed": "debug",
  "verify.lookup": "debug",
  "verify.submitted": "info",
  "verify.poll": "debug",
  "verify.retry": "warn",
  "verify.result": "info",
  "proxy.routed": "debug",
  "proxy.poll": "debug",
  "proxy.retry": "warn",
  "proxy.result": "info",
};

/** The text before a line of each level, and its style. Info lines have none. */
const PREFIXES: Readonly<Record<LineLevel, { text: string; style: Style } | undefined>> = {
  debug: { text: "debug:", style: "dim" },
  info: undefined,
  warn: { text: "warning:", style: "yellow" },
  error: { text: "error:", style: "red" },
};

/** The frames of the spinner, plain ASCII so every terminal draws them. */
const FRAMES = ["|", "/", "-", "\\"];
/** How often the spinner draws its next frame, in milliseconds. */
const FRAME_MS = 100;
/** Moves to the start of the line and clears it. */
const CLEAR_LINE = "\r\u001B[2K";

/** The text of `verify.routed`: the backend, its host and how it was chosen. */
function routedMessage(event: Extract<VerifyEvent, { readonly type: "verify.routed" }>): string {
  const head = `Routed to ${event.backend} at ${event.apiHost}`;
  const names = event.skipped?.split(",") ?? [];
  const skipped = names.length === 0 ? undefined : names.join(", ");
  const them = names.length === 1 ? "it" : "them";
  const why: Record<RoutedBy, string> = {
    table:
      skipped === undefined
        ? "the first backend the routing table lists for the chain"
        : `the routing table's pick: ${skipped} skipped, because no API key is set for ${them}`,
    fallback: "the Sourcify fallback for a chain the routing table does not list",
    caller: "the backend the caller named",
    "api-url": "the API URL the caller gave",
  };
  return event.routedBy === undefined ? `${head}.` : `${head}, ${why[event.routedBy]}.`;
}

/** The person-readable text of an event. */
export function eventMessage(event: VerifyEvent): string {
  // Every type is listed, so a new event type fails the exhaustiveness lint until it is added.
  let message: string;
  switch (event.type) {
    case "verify.validated":
      message = `Input is valid: chain ${String(event.chainId)}, contract ${event.address}.`;
      break;
    case "verify.routed":
      message = routedMessage(event);
      break;
    case "proxy.routed":
      message = `Proxy route on ${event.backend} at ${event.apiHost}.`;
      break;
    case "verify.lookup":
      message = `Lookup on ${event.backend}: ${event.lookup}.`;
      break;
    case "verify.submitted":
      message = `Submitted to ${event.backend}. Handle: ${event.handle}`;
      break;
    case "proxy.poll":
    case "verify.poll":
      message = `Poll ${String(event.attempt)} on ${event.backend}: ${event.state}.`;
      break;
    case "proxy.retry":
    case "verify.retry":
      message = `Retrying ${event.backend} after ${event.reason}: attempt ${String(event.attempt)} in ${String(event.delayMs)} ms.`;
      break;
    case "proxy.result":
    case "verify.result":
      message =
        "match" in event
          ? `Result from ${event.backend}: ${event.status}, ${event.match} match.`
          : `Result from ${event.backend}: ${event.status}.`;
      break;
  }
  return message;
}

/**
 * The spinner's text for the stage an event starts, such as `Waiting for sourcify: pending, poll 3`.
 * The spinner shows it whatever the level, so a run at `info` still shows each poll.
 *
 * @param event - The event.
 * @returns The text.
 */
export function stageText(event: VerifyEvent): string {
  let stage: string;
  switch (event.type) {
    case "verify.validated":
      stage = "Checked the input";
      break;
    case "proxy.routed":
    case "verify.routed":
      stage = `Routed to ${event.backend}`;
      break;
    case "verify.lookup":
      stage = `Looked the contract up on ${event.backend}`;
      break;
    case "verify.submitted":
      stage = `Submitted to ${event.backend}, waiting for the result`;
      break;
    case "proxy.poll":
    case "verify.poll":
      stage = `Waiting for ${event.backend}: ${event.state}, poll ${String(event.attempt)}`;
      break;
    case "proxy.retry":
    case "verify.retry":
      stage = `Retrying ${event.backend} after ${event.reason}`;
      break;
    case "proxy.result":
    case "verify.result":
      stage = `Result from ${event.backend}: ${event.status}`;
      break;
  }
  return stage;
}

/**
 * The library's `info` lines that repeat what the CLI already prints, each known by a fixed part
 * of its message and a field it always sets: the `verify.submitted` and `verify.result` events'
 * lines, and the dry run's lookup line, which the `verify.routed` line and stdout state.
 */
const REPEATED_LINES: readonly { readonly marker: RegExp; readonly field: string }[] = [
  { marker: / accepted the submission\. Resume it with this handle: /, field: "handle" },
  { marker: /^Result: /, field: "status" },
  { marker: /^Dry run: /, field: "routedBy" },
];

/**
 * Whether a library log line repeats an event or the result. A text run at `info` shows the
 * event's line only, and the log line at `debug` (R-AX-14). The match reads the message and the
 * fields, never the order of the lines, so a line from another backend in between changes nothing.
 *
 * @param message - The log line's message.
 * @param fields - The log line's fields.
 * @returns Whether the line repeats one the CLI prints.
 */
export function repeats(message: string, fields: LogFields | undefined): boolean {
  return REPEATED_LINES.some(
    ({ marker, field }) => marker.test(message) && fields?.[field] !== undefined,
  );
}

/** A field value in a text line: bare when it has no space, quote or `=`, else as JSON. */
function textValue(value: LogValue): string {
  if (typeof value === "string") {
    return /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
  }
  return String(value);
}

/**
 * One JSON line. Fields with a reserved name go under a nested `fields` object, so a field named
 * `fields` appears as `fields.fields`. `Object.fromEntries` defines each key as data, so a field
 * named `__proto__` stays a field.
 */
export function jsonLine(
  level: LineLevel,
  message: string,
  type: string,
  fields: LogFields,
): string {
  const top: [string, LogValue][] = [];
  const nested: [string, LogValue][] = [];
  for (const [name, value] of Object.entries(fields)) {
    (RESERVED.has(name) ? nested : top).push([name, value]);
  }
  const line: [string, LogValue | Record<string, LogValue>][] = [
    ["schemaVersion", SCHEMA_VERSION],
    ["level", level],
    ["message", message],
    ["type", type],
    ...top,
  ];
  if (nested.length > 0) {
    line.push(["fields", Object.fromEntries(nested)]);
  }
  return JSON.stringify(Object.fromEntries(line));
}

/** The options of {@link createStderr}. */
export interface StderrOptions {
  /** The stream, `process.stderr` in the bin. */
  stream: OutputStream;
  /** The level in effect. */
  level: LogLevel;
  /** `text` for people, `json` for programs. */
  format: LogFormat;
  /** Whether text lines are coloured. */
  color: boolean;
  /** Whether the spinner may run. */
  spinner: boolean;
  /** The clock of the spinner's elapsed time, in milliseconds. `Date.now` by default. */
  now?: () => number;
}

/** The stderr writer of one run. */
export interface Stderr {
  /** The logger passed to the library. */
  readonly logger: Logger;
  /** The event callback passed to the library. `level` replaces the event's own level. */
  readonly onEvent: (event: VerifyEvent, level?: LineLevel) => void;
  /** Writes one log line, when its level is shown. */
  log: (level: LineLevel, message: string, fields?: LogFields) => void;
  /** Writes the error of the run at level `error`, with the next command when there is one. */
  error: (error: ErrorJson, next?: readonly string[]) => void;
  /** Starts the spinner, when the terminal rules allow it. */
  startSpinner: (label: string) => void;
  /** Stops the spinner and clears its line. */
  stopSpinner: () => void;
}

/**
 * Builds the stderr writer of one run.
 *
 * @param options - The stream, the level, the format, colour and whether a spinner may run.
 * @returns The writer.
 */
export function createStderr(options: StderrOptions): Stderr {
  const { stream, level, format } = options;
  const paint = painter(options.color);
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let label = "";
  let started = 0;

  // stderr is diagnostic: a stream that throws must not cost the run its stdout or exit code.
  const write = (text: string): void => {
    try {
      stream.write(text);
    } catch {
      // Nothing more to do: stderr refused the line.
    }
  };

  const drawFrame = (): void => {
    const seconds = Math.max(0, Math.floor((now() - started) / 1000));
    write(`${CLEAR_LINE}${FRAMES[frame % FRAMES.length] ?? ""} ${label} (${String(seconds)} s)`);
    frame += 1;
  };

  const writeLine = (text: string): void => {
    write(`${timer === undefined ? "" : CLEAR_LINE}${text}\n`);
    if (timer !== undefined) {
      drawFrame();
    }
  };

  const textLine = (lineLevel: LineLevel, message: string, fields: LogFields): string => {
    const prefix = PREFIXES[lineLevel];
    const parts = prefix === undefined ? [] : [paint(prefix.style, prefix.text)];
    parts.push(message);
    for (const [name, value] of Object.entries(fields)) {
      parts.push(`${name}=${textValue(value)}`);
    }
    return parts.join(" ");
  };

  const log = (lineLevel: LineLevel, message: string, fields: LogFields = {}): void => {
    if (!shows(lineLevel, level)) {
      return;
    }
    writeLine(
      format === "json"
        ? jsonLine(lineLevel, message, "log", fields)
        : textLine(lineLevel, message, fields),
    );
  };

  const onEvent = (event: VerifyEvent, given?: LineLevel): void => {
    label = stageText(event);
    const lineLevel = given ?? EVENT_LEVELS[event.type];
    if (!shows(lineLevel, level)) {
      return;
    }
    const message = eventMessage(event);
    if (format === "json") {
      const { type, ...rest } = event;
      const fields: LogFields = rest;
      writeLine(jsonLine(lineLevel, message, type, fields));
    } else {
      writeLine(textLine(lineLevel, message, {}));
    }
  };

  const error = (json: ErrorJson, next?: readonly string[]): void => {
    if (!shows("error", level)) {
      return;
    }
    const fields: Record<string, LogValue> = {
      code: json.code,
      hint: json.hint,
      docsUrl: json.docsUrl,
      retryable: json.retryable,
    };
    if (json.handle !== undefined) {
      fields["handle"] = json.handle;
    }
    // A cancelled run on several backends: each running job, as `<backend> <handle>`. Log fields
    // are flat, so the JSON line joins them with ", ".
    const handles = (json.handles ?? []).map(({ backend, handle }) => `${backend} ${handle}`);
    if (handles.length > 0) {
      fields["handles"] = handles.join(", ");
    }
    // The next command as one line, each word quoted for a shell when it needs it.
    const command = next === undefined ? undefined : shellLine(next);
    if (command !== undefined) {
      fields["nextCommand"] = command;
    }
    if (format === "json") {
      writeLine(jsonLine("error", json.message, "log", fields));
      return;
    }
    // The issues and candidates a person needs to fix the input; other details stay in --json.
    const lines = [
      `${paint("red", "error:")} ${visible(json.message)} (${json.code})`,
      ...detailLines(json).map((line) => `  ${visible(line)}`),
      `  hint: ${visible(json.hint)}`,
      `  docs: ${json.docsUrl}`,
    ];
    if (json.handle !== undefined) {
      lines.push(`  handle: ${visible(json.handle)}`);
    }
    for (const line of handles) {
      lines.push(`  handle: ${visible(line)}`);
    }
    if (command !== undefined) {
      lines.push(`  next: ${command}`);
    }
    writeLine(lines.join("\n"));
  };

  // A logger line: an `info` line that repeats an event or the result drops to `debug` in text.
  const logged = (lineLevel: LineLevel, message: string, fields?: LogFields): void => {
    const repeated = lineLevel === "info" && format === "text" && repeats(message, fields);
    log(repeated ? "debug" : lineLevel, message, fields);
  };

  return {
    logger: {
      debug: (message, fields) => {
        logged("debug", message, fields);
      },
      info: (message, fields) => {
        logged("info", message, fields);
      },
      warn: (message, fields) => {
        logged("warn", message, fields);
      },
      error: (message, fields) => {
        logged("error", message, fields);
      },
    },
    onEvent,
    log,
    error,
    startSpinner: (text) => {
      if (!options.spinner || timer !== undefined) {
        return;
      }
      label = text;
      started = now();
      timer = setInterval(drawFrame, FRAME_MS);
      timer.unref();
      drawFrame();
    },
    stopSpinner: () => {
      if (timer === undefined) {
        return;
      }
      clearInterval(timer);
      timer = undefined;
      write(CLEAR_LINE);
    },
  };
}
