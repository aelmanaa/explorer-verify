// Edge cases of the main loop: redaction across the message cut (R-SEC-1), signals outside the
// command and during the output (R-AX-7), a stderr that throws, and usage-error wording.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it } from "node:test";

import type { VerifyResult } from "explorer-verify";

import type { Command } from "../../src/command.ts";
import { main, tidyStack } from "../../src/main.ts";
import { fakeIo } from "../helpers/fake-io.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";

const DUMMY_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678";

async function run(argv: readonly string[]) {
  const fake = fakeIo(argv);
  const code = await main(fake.io);
  return { code, stdout: fake.stdout(), stderr: fake.stderr() };
}

function command(name: string, body: Command["run"], maxPositionals = 0): Command {
  return { name, summary: "A test command.", options: {}, maxPositionals, run: body };
}

const NEVER: Command["run"] = async () => await Promise.reject(new Error("must not run"));

describe("main: internal-error redaction (R-SEC-1)", () => {
  it("redacts a key that straddles the 500-character cut", async () => {
    // The cut applies to "Error: <message>"; the key starts 10 characters before it.
    const padding = `${"x".repeat(500 - "Error: ".length - 11)} `;
    const result = await run([
      "simulate",
      "--json",
      "--outcome",
      "internal-error",
      "--message",
      `${padding}${DUMMY_KEY}`,
    ]);
    assert.equal(result.code, 6);
    for (const fragment of [DUMMY_KEY.slice(0, 10), DUMMY_KEY.slice(0, 8)]) {
      assert.ok(!result.stdout.includes(fragment), fragment);
      assert.ok(!result.stderr.includes(fragment), fragment);
    }
    assert.match(result.stdout, /x \[redac/);
  });

  it("replaces the home directory in the --verbose stack", async () => {
    const home = homedir();
    const fake = fakeIo(["custom", "--verbose"]);
    const error = new Error("boom");
    error.stack = `Error: boom\n    at run (${home}/project/node_modules/x.js:1:1)`;
    await main(fake.io, [command("custom", async () => await Promise.reject(error))]);
    assert.ok(!fake.stderr().includes(home));
    assert.match(fake.stderr(), /~\/project\/node_modules\/x\.js/);
  });

  it("leaves a stack alone when the home directory is / or empty", () => {
    assert.equal(tidyStack("at /a/b", "/"), "at /a/b");
    assert.equal(tidyStack("at /a/b", ""), "at /a/b");
    assert.equal(tidyStack("at /h/b and /h/c", "/h"), "at ~/b and ~/c");
  });
});

describe("main: signals outside the command (R-AX-7)", () => {
  it("finishes as cancelled when a signal arrives before the command runs", async () => {
    const fake = fakeIo(["early", "--json"]);
    const early: Command = {
      name: "early",
      summary: "Fires a signal while its options are read.",
      get options() {
        fake.signal("SIGTERM");
        return {};
      },
      maxPositionals: 0,
      run: NEVER,
    };
    assert.equal(await main(fake.io, [early]), 130);
    assert.match(fake.stdout(), /"message":"The run was cancelled by SIGTERM\."/);
  });

  it("finishes as cancelled when a signal arrives as the command returns", async () => {
    const fake = fakeIo(["custom", "--json"]);
    const result: VerifyResult = { status: "verified", backend: "sourcify", match: "exact" };
    const code = await main(fake.io, [
      command("custom", async () => {
        fake.signal("SIGINT");
        return await Promise.resolve(result);
      }),
    ]);
    assert.equal(code, 130);
  });

  it("ignores a signal once the outcome is fixed, so the envelope is written in full", async () => {
    const fake = fakeIo(["simulate", "--json"]);
    let out = "";
    const io = {
      ...fake.io,
      stdout: {
        write: (text: string) => {
          fake.signal("SIGINT");
          out += text;
        },
      },
    };
    assert.equal(await main(io), 0);
    assert.equal(oneEnvelope(out)["ok"], true);
  });
});

describe("main: a stderr that throws", () => {
  it("keeps the envelope and the exit code", async () => {
    for (const [argv, expected] of [
      [["simulate", "--json", "--verbose"], 0],
      [["simulate", "--json", "--outcome", "network"], 5],
    ] as const) {
      const fake = fakeIo(argv);
      const io = {
        ...fake.io,
        stderr: {
          write: () => {
            throw new Error("EPIPE");
          },
        },
      };
      assert.equal(await main(io), expected, argv.join(" "));
      assert.deepEqual(envelopeProblems(oneEnvelope(fake.stdout())), []);
    }
  });
});

describe("main: usage-error wording", () => {
  it("lists at most 20 issues and counts the rest", async () => {
    const extra = Array.from({ length: 25 }, (_, index) => `--x${String(index)}`);
    const result = await run(["simulate", "--json", ...extra]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /argument 22 is not an option; and 5 more\./);
  });

  it("refuses a negative --polls with the range", async () => {
    const result = await run(["simulate", "--json", "--polls", "-1"]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /--polls must be a whole number from 0 to 1000/);
  });

  it("says a command takes at most N arguments when N is not 0", async () => {
    const fake = fakeIo(["two", "a", "b", "c"]);
    assert.equal(await main(fake.io, [command("two", NEVER, 2)]), 2);
    assert.match(fake.stderr(), /two takes at most 2 arguments/);
  });
});
