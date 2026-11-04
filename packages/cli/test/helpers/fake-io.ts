// An in-process stand-in for the process: argv, environment, two captured streams with a chosen
// terminal state, and a signal source the test fires by hand.
import type { InputStream } from "../../src/keys.ts";
import type { Io, SignalName } from "../../src/main.ts";

export interface FakeIo {
  io: Io;
  stdout: () => string;
  stderr: () => string;
  /** Fires a signal at every listener that is still registered. */
  signal: (name: SignalName) => void;
  /** How many signal listeners are registered now. */
  listeners: () => number;
  /** How many times the CLI opened stdin. */
  stdinOpened: () => number;
}

export interface FakeIoOptions {
  env?: Record<string, string | undefined>;
  stdoutIsTerminal?: boolean;
  stderrIsTerminal?: boolean;
  /** The chunks stdin yields; none by default. */
  stdin?: readonly unknown[];
  stdinIsTerminal?: boolean;
  /** Makes reading stdin throw this. */
  stdinError?: Error;
}

/** A stdin that yields `chunks`, or throws `error` when reading. */
export function fakeStdin(chunks: readonly unknown[], isTTY = false, error?: Error): InputStream {
  return {
    isTTY,
    [Symbol.asyncIterator]: async function* () {
      if (error !== undefined) {
        throw error;
      }
      yield* chunks;
    },
  };
}

export function fakeIo(argv: readonly string[], options: FakeIoOptions = {}): FakeIo {
  let out = "";
  let err = "";
  const listeners = new Set<(signal: SignalName) => void>();
  let opened = 0;
  const io: Io = {
    argv,
    env: options.env ?? {},
    stdout: {
      write: (text) => {
        out += text;
      },
      isTTY: options.stdoutIsTerminal ?? false,
    },
    stderr: {
      write: (text) => {
        err += text;
      },
      isTTY: options.stderrIsTerminal ?? false,
    },
    stdin: () => {
      opened += 1;
      return fakeStdin(options.stdin ?? [], options.stdinIsTerminal ?? false, options.stdinError);
    },
    onSignal: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    io,
    stdout: () => out,
    stderr: () => err,
    signal: (name) => {
      for (const listener of Array.from(listeners)) {
        listener(name);
      }
    },
    listeners: () => listeners.size,
    stdinOpened: () => opened,
  };
}

/** The JSON lines of stderr, parsed. */
export function jsonLines(stderr: string): Record<string, unknown>[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`not a JSON object: ${line}`);
      }
      return Object.fromEntries(Object.entries(parsed));
    });
}
