// Runs the built bin the way an agent does (R-QA-3): stdout and stderr piped, stdin closed unless a
// test asks otherwise, and an environment without the variables that change the output.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BIN: string = fileURLToPath(new URL("../../dist/src/bin.js", import.meta.url));

/** Variables of the test runner's environment that the CLI reads; each test sets its own. */
const CLEARED = ["CI", "NO_COLOR", "TERM", "FORCE_COLOR", "EXPLORER_VERIFY_LOG"];

export interface BinResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface BinOptions {
  env?: Record<string, string>;
  /** `ignore` closes stdin (the default); `open` leaves a pipe that never ends. */
  stdin?: "ignore" | "open" | "ended";
  /** Called with each stderr chunk and the child, for example to send a signal. */
  onStderr?: (text: string, child: ChildProcess) => void;
}

function environment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CLEARED) {
    delete env[name];
  }
  return { ...env, ...extra };
}

export function runBin(args: readonly string[], options: BinOptions = {}): Promise<BinResult> {
  return new Promise((resolve, reject) => {
    const stdin = options.stdin ?? "ignore";
    const child = spawn(process.execPath, [BIN, ...args], {
      env: environment(options.env ?? {}),
      stdio: [stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin === "ended") {
      child.stdin?.end();
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(stderr, child);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      child.stdin?.destroy();
      resolve({ code, signal, stdout, stderr });
    });
  });
}
