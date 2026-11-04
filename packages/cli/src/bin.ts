#!/usr/bin/env node
/**
 * The `explorer-verify` bin: runs the CLI on this process's arguments, environment, streams and
 * signals, waits until both streams have taken the output, then exits with the CLI's code. The
 * explicit exit ends a run that a signal cancelled while the command still had timers pending.
 *
 * The SIGINT and SIGTERM handlers stay installed until the process exits. A signal after the
 * outcome is fixed reaches no listener and is ignored, so the envelope and the drain always finish.
 * A signal that arrives before Node has run this module cannot be caught.
 */
import process from "node:process";

import { main } from "./main.ts";
import type { SignalName } from "./main.ts";

const SIGNALS: readonly SignalName[] = ["SIGINT", "SIGTERM"];
const listeners = new Set<(signal: SignalName) => void>();

for (const signal of SIGNALS) {
  process.on(signal, () => {
    for (const listener of listeners) {
      listener(signal);
    }
  });
}

/** Resolves once `stream` has written everything queued before it, or failed to. */
function drained(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => {
      resolve();
    });
  });
}

// A reader that closed the pipe early, such as `head`, must not crash the run.
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);

const code = await main({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  // Opened only when a flag asks for stdin, so a run without one never touches it.
  stdin: () => process.stdin,
  onSignal: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
});
await Promise.all([drained(process.stdout), drained(process.stderr)]);
process.exit(code);
