// Runs the built bin the way an agent does (R-QA-3): stdout and stderr piped, stdin closed unless a
// test asks otherwise, and an environment without the variables that change the output.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BIN: string = fileURLToPath(new URL("../../dist/src/bin.js", import.meta.url));
const PRELOAD: string = fileURLToPath(new URL("fake-explorer-preload.ts", import.meta.url));

/** The folder the documented examples run in: a Foundry build of the Greeter, and its request. */
export const PROJECT: string = fileURLToPath(new URL("../fixtures/project/", import.meta.url));

/** Variables of the test runner's environment that the CLI reads; each test sets its own. */
const CLEARED = [
  "CI",
  "NO_COLOR",
  "TERM",
  "FORCE_COLOR",
  "EXPLORER_VERIFY_LOG",
  "ETHERSCAN_API_KEY",
  "ROUTESCAN_API_KEY",
];

export interface BinResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface BinOptions {
  env?: Record<string, string>;
  /**
   * `ignore` closes stdin (the default); `open` leaves a pipe that never ends; `ended` ends it at
   * once; a string is written to the pipe, which then ends.
   */
  stdin?: "ignore" | "open" | "ended" | { text: string };
  /** Runs the bin with stdin on a pseudo-terminal, through `python3`; stdout and stderr stay pipes. */
  stdinTerminal?: boolean;
  /** The working folder of the bin. */
  cwd?: string;
  /**
   * Loads the fake explorer before the bin, with this scenario, so no request reaches the network.
   * `log` names a file that gets one JSON line per request.
   */
  fake?: { scenario?: string; log?: string };
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

/**
 * Runs its arguments with stdin on a new pseudo-terminal and stdout and stderr inherited, and
 * exits with the child's code. Nothing is ever typed on the terminal, so a child that waits on
 * stdin hangs until the test's timeout.
 */
const PTY_SCRIPT = [
  "import os, pty, subprocess, sys",
  "leader, follower = pty.openpty()",
  "sys.exit(subprocess.run(sys.argv[1:], stdin=follower).returncode)",
].join("\n");

/** The Unix tool that makes a named pipe; Node has no API for it. */
const MKFIFO = "mkfifo";

/** Makes a named pipe (FIFO) at `path`. Unix only. */
export function makeFifo(path: string): void {
  const result = spawnSync(MKFIFO, [path], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error("mkfifo failed");
  }
}

/** Whether `python3` with its `pty` module can run here, for the pseudo-terminal tests. */
export function hasPty(): boolean {
  if (process.platform === "win32") {
    return false;
  }
  const probe = spawnSync("python3", ["-I", "-c", "import pty"], { stdio: "ignore" });
  return probe.status === 0;
}

export function runBin(args: readonly string[], options: BinOptions = {}): Promise<BinResult> {
  return new Promise((resolve, reject) => {
    const stdin = options.stdin ?? "ignore";
    const { fake } = options;
    const bin = fake === undefined ? [BIN] : ["--import", PRELOAD, BIN];
    const fakeEnv: Record<string, string> =
      fake === undefined
        ? {}
        : {
            FAKE_EXPLORER: fake.scenario ?? "verified",
            ...(fake.log === undefined ? {} : { FAKE_EXPLORER_LOG: fake.log }),
          };
    const [file, argv]: [string, string[]] =
      options.stdinTerminal === true
        ? ["python3", ["-I", "-c", PTY_SCRIPT, process.execPath, ...bin, ...args]]
        : [process.execPath, [...bin, ...args]];
    const child = spawn(file, argv, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: environment({ ...fakeEnv, ...options.env }),
      stdio: [stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin === "ended") {
      child.stdin?.end();
    } else if (typeof stdin === "object") {
      child.stdin?.end(stdin.text);
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
