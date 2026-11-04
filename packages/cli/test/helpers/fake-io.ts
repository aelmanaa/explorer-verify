// An in-process stand-in for the process: argv, environment, two captured streams with a chosen
// terminal state, and a signal source the test fires by hand.
import type { Io, SignalName } from "../../src/main.ts";

export interface FakeIo {
  io: Io;
  stdout: () => string;
  stderr: () => string;
  /** Fires a signal at every listener that is still registered. */
  signal: (name: SignalName) => void;
  /** How many signal listeners are registered now. */
  listeners: () => number;
}

export interface FakeIoOptions {
  env?: Record<string, string | undefined>;
  stdoutIsTerminal?: boolean;
  stderrIsTerminal?: boolean;
}

export function fakeIo(argv: readonly string[], options: FakeIoOptions = {}): FakeIo {
  let out = "";
  let err = "";
  const listeners = new Set<(signal: SignalName) => void>();
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
