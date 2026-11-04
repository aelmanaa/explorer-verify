// The CI guide, docs/user/guides/verify-from-ci-with-the-cli.md, against the built bin (R-AX-2,
// R-AX-9): its command-line examples print what the page shows, and its `scripts/verify.sh` runs
// under bash, with jq, for the exit codes it branches on. Every run uses the fake explorer, so
// nothing reaches the network.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { JOB } from "../helpers/fake-explorer.ts";
import { blocks, shellExamples } from "../helpers/shell-examples.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";

const PAGE_NAME = "verify-from-ci-with-the-cli.md";
const PAGE = readFileSync(
  new URL(`../../../../docs/user/guides/${PAGE_NAME}`, import.meta.url),
  "utf8",
);
const BIN = fileURLToPath(new URL("../../dist/src/bin.js", import.meta.url));
const PRELOAD = fileURLToPath(new URL("../helpers/fake-explorer-preload.ts", import.meta.url));
const TIMEOUT = { timeout: 60_000 };
const HANDLE = `ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:${JOB}`;

/** The page's `scripts/verify.sh`: its one bash block that starts with a shebang. */
const SCRIPT = blocks(PAGE).filter(
  (block) => block.lang === "bash" && block.code.startsWith("#!/usr/bin/env bash\n"),
);

/** Whether `bash` and `jq` can run here; the script needs both. */
const hasTools = ["bash", "jq"].every(
  (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0,
);

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-ci-page-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

/** The `explorer-verify` of most runs: the built bin behind the fake explorer. */
const BIN_SHIM = `#!/bin/sh\nexec "${process.execPath}" --import "${PRELOAD}" "${BIN}" "$@"\n`;

/**
 * A folder with an `explorer-verify` that runs `body`, put first on the PATH as
 * `node_modules/.bin` is in the workflow.
 */
function shimDir(name: string, body: string): string {
  const dir = join(DIR, `bin-${name}`);
  const shim = join(dir, "explorer-verify");
  mkdirSync(dir, { recursive: true });
  writeFileSync(shim, body);
  chmodSync(shim, 0o755);
  return dir;
}

interface ScriptRun {
  code: number | null;
  stdout: string;
  output: string;
}

/** Runs the page's script with bash in the Foundry project, on the request file `request`. */
async function runScript(
  name: string,
  request: string,
  scenario: string,
  env: Record<string, string> = {},
  shim: string = BIN_SHIM,
): Promise<ScriptRun> {
  const script = join(DIR, "verify.sh");
  writeFileSync(script, String(SCRIPT[0]?.code));
  const githubOutput = join(DIR, `github-output-${name}`);
  writeFileSync(githubOutput, "");
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const variable of ["CI", "ETHERSCAN_API_KEY", "ROUTESCAN_API_KEY", "EXPLORER_VERIFY_LOG"]) {
    delete base[variable];
  }
  const child = spawn("bash", [script, request], {
    cwd: PROJECT,
    env: {
      ...base,
      PATH: `${shimDir(name, shim)}${delimiter}${process.env["PATH"] ?? ""}`,
      FAKE_EXPLORER: scenario,
      GITHUB_OUTPUT: githubOutput,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.resume();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, stdout, output: readFileSync(githubOutput, "utf8") };
}

/** Writes a request file: the project's request, with `change` applied. */
function requestFile(name: string, change: (value: Record<string, unknown>) => void): string {
  const value: Record<string, unknown> = {
    ...JSON.parse(readFileSync(join(PROJECT, "verify-input.json"), "utf8")),
  };
  change(value);
  const file = join(DIR, `${name}.json`);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("the CI guide's command-line examples (R-AX-2)", () => {
  const examples = shellExamples(PAGE, PAGE_NAME);

  it("has a dry run, a verify with --json and a status", () => {
    const lines = examples.map(({ args }) => args.join(" "));
    assert.ok(lines.some((line) => line.includes("--dry-run")));
    assert.ok(lines.some((line) => line.startsWith("verify ") && !line.includes("--dry-run")));
    assert.ok(lines.some((line) => line.startsWith("status ")));
  });

  for (const example of examples) {
    it(`${PAGE_NAME} line ${String(example.line)}: explorer-verify ${example.args.join(" ")}`, async () => {
      const result = await runBin(example.args, { cwd: PROJECT, fake: {} });
      assert.equal(result.code, example.exitCode, `stderr:\n${result.stderr}`);
      assert.equal(result.stdout, example.stdout);
    });
  }
});

describe(
  "the CI guide's verify.sh (R-AX-9)",
  { skip: hasTools ? false : "needs bash and jq" },
  () => {
    it("is on the page once, and takes the key from no flag", () => {
      assert.equal(SCRIPT.length, 1);
      assert.doesNotMatch(String(SCRIPT[0]?.code), /--api-key|apikey/i);
    });

    it("exit code 0: prints the status and the backend", TIMEOUT, async () => {
      const run = await runScript("verified", join(PROJECT, "verify-input.json"), "verified");
      assert.equal(run.code, 0);
      assert.equal(run.stdout, "already-verified on sourcify\n");
      assert.equal(run.output, "");
    });

    it("exit code 2: fails with the code and the hint", TIMEOUT, async () => {
      const file = requestFile("bad-chain", (value) => {
        value["chainId"] = 0;
      });
      const run = await runScript("bad-chain", file, "verified");
      assert.equal(run.code, 2);
      assert.match(run.stdout, /^::error::invalid-input: \S/);
    });

    it("exit code 3: fails when the route needs a key and none is set", TIMEOUT, async () => {
      const file = requestFile("etherscan", (value) => {
        value["route"] = { backend: "etherscan-v2" };
      });
      const run = await runScript("etherscan", file, "verified");
      assert.equal(run.code, 3);
      assert.match(run.stdout, /^::error::missing-api-key: \S/);
    });

    it(
      "exit code 4 with a handle: passes, warns and writes the handle output",
      TIMEOUT,
      async () => {
        const run = await runScript("pending", join(PROJECT, "verify-input.json"), "pending", {
          // Long enough for the lookup and the submit on a slow runner; the job never ends.
          VERIFY_TIMEOUT: "4",
        });
        assert.equal(run.code, 0);
        assert.equal(
          run.stdout,
          `::warning::No verdict yet. Resume with: explorer-verify status ${HANDLE}\n`,
        );
        assert.equal(run.output, `handle=${HANDLE}\n`);
      },
    );

    it(
      "escapes %, CR and LF in explorer text, so it cannot start a workflow command",
      TIMEOUT,
      async () => {
        // An explorer-verify that prints an envelope whose hint holds the three characters.
        const envelope = JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: {
            code: "invalid-input",
            message: "m",
            hint: "50% done\r\n::warning::injected",
            docsUrl: "https://aelmanaa.github.io/explorer-verify/reference/errors/invalid-input",
            retryable: false,
          },
        });
        const shim = `#!/bin/sh\nprintf '%s\\n' '${envelope}'\nexit 2\n`;
        const run = await runScript(
          "escape",
          join(PROJECT, "verify-input.json"),
          "verified",
          {},
          shim,
        );
        assert.equal(run.code, 2);
        assert.equal(run.stdout, "::error::invalid-input: 50%25 done%0D%0A::warning::injected\n");
      },
    );
  },
);
