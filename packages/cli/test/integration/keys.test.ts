// Keys on the built bin (R-AX-9, R-SEC-1, R-QA-3): a dummy key from each variable, from
// `--api-key-file` and from `--api-key-stdin` never reaches stdout or stderr, no flag takes a key,
// and `--api-key-stdin` with stdin a terminal exits 2 at once. `simulate` reads the keys like the
// real commands; `--message` puts the key in an internal error, which the CLI must remove.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { jsonLines } from "../helpers/fake-io.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { hasPty, runBin } from "../helpers/spawn-bin.ts";
import type { BinOptions } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 30_000 };
// Lower-case: no generic redaction pattern matches it, so only the CLI's knowledge of the keys it
// read can remove it.
const KEY = "bb5dummyclibinkeyhh9ze";

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-bin-keys-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});
const KEY_FILE = join(DIR, "key.txt");
writeFileSync(KEY_FILE, `${KEY}\n`);

const SOURCES: readonly { name: string; args: string[]; options: BinOptions }[] = [
  { name: "ETHERSCAN_API_KEY", args: [], options: { env: { ETHERSCAN_API_KEY: KEY } } },
  { name: "ROUTESCAN_API_KEY", args: [], options: { env: { ROUTESCAN_API_KEY: KEY } } },
  {
    name: "--api-key-file",
    args: ["--api-key-file", KEY_FILE, "--backend", "routescan"],
    options: {},
  },
  {
    name: "--api-key-stdin",
    args: ["--backend", "etherscan-v2", "--api-key-stdin"],
    options: { stdin: { text: `${KEY}\n` } },
  },
];

describe("bin: a key never reaches stdout or stderr (R-AX-9, R-SEC-1)", () => {
  for (const source of SOURCES) {
    it(
      `from ${source.name}, in an internal error at debug with JSON lines and --json`,
      TIMEOUT,
      async () => {
        const result = await runBin(
          [
            "simulate",
            "--json",
            "--verbose",
            "--log-format",
            "json",
            ...source.args,
            "--outcome",
            "internal-error",
            "--message",
            `the explorer said ${KEY}`,
          ],
          source.options,
        );
        assert.equal(result.code, 6, result.stderr);
        assert.ok(!result.stdout.includes(KEY));
        assert.ok(!result.stderr.includes(KEY));
        const envelope = oneEnvelope(result.stdout);
        assert.deepEqual(envelopeProblems(envelope), []);
        assert.match(result.stdout, /the explorer said \[redacted\]/);
        assert.ok(jsonLines(result.stderr).some((line) => line["level"] === "debug"));
      },
    );

    it(`from ${source.name}, in text mode`, TIMEOUT, async () => {
      const result = await runBin(
        ["simulate", "--verbose", ...source.args, "--outcome", "internal-error", "--message", KEY],
        source.options,
      );
      assert.equal(result.code, 6, result.stderr);
      assert.ok(!(result.stdout + result.stderr).includes(KEY));
    });
  }
});

describe("bin: no flag takes a key (R-AX-9)", () => {
  for (const flag of ["--api-key", "--apikey", "--key"]) {
    it(`refuses ${flag} with exit 2 and never echoes the value`, TIMEOUT, async () => {
      const result = await runBin(["simulate", "--json", flag, KEY]);
      assert.equal(result.code, 2);
      assert.ok(!(result.stdout + result.stderr).includes(KEY));
      assert.match(result.stdout, new RegExp(`${flag} is not accepted`));
      assert.match(result.stdout, /ETHERSCAN_API_KEY/);
    });
  }
});

describe("bin: --api-key-stdin (R-AX-9)", () => {
  it(
    "exits 2 at once when stdin is a terminal",
    { ...TIMEOUT, skip: hasPty() ? false : "needs python3 with its pty module" },
    async () => {
      const result = await runBin(
        ["simulate", "--json", "--backend", "etherscan-v2", "--api-key-stdin"],
        {
          stdinTerminal: true,
          stdin: "ignore",
        },
      );
      assert.equal(result.code, 2, result.stderr);
      const envelope = oneEnvelope(result.stdout);
      assert.deepEqual(envelopeProblems(envelope), []);
      assert.match(
        result.stdout,
        /--api-key-stdin needs the key piped on stdin, and stdin is a terminal/,
      );
    },
  );

  it("reads the key from a pipe that ends", TIMEOUT, async () => {
    const result = await runBin(
      ["simulate", "--json", "--backend", "etherscan-v2", "--api-key-stdin"],
      {
        stdin: { text: KEY },
      },
    );
    assert.equal(result.code, 0, result.stderr);
  });

  it("exits 2 when the pipe is empty", TIMEOUT, async () => {
    const result = await runBin(
      ["simulate", "--json", "--backend", "etherscan-v2", "--api-key-stdin"],
      { stdin: "ended" },
    );
    assert.equal(result.code, 2);
    assert.match(result.stdout, /--api-key-stdin gave an empty key/);
  });
});
