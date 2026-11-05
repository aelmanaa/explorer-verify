// The main loop's help, version and suggestions: help and the version print on stdout and exit 0
// (R-AX-11), with --json as one envelope; a mistyped command or option exits 2 with a hint that
// names the closest match (R-AX-10).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { routingTableDate } from "explorer-verify";

import type { Command } from "../../src/command.ts";
import { COMMANDS } from "../../src/commands.ts";
import { helpResult, helpText } from "../../src/help.ts";
import { main } from "../../src/main.ts";
import { fakeIo } from "../helpers/fake-io.ts";
import { envelopeProblems, helpProblems, oneEnvelope, versionProblems } from "../helpers/schema.ts";
import { WITH_SCRIPTED } from "../helpers/scripted-command.ts";

const NEVER: Command["run"] = async () => await Promise.reject(new Error("must not run"));

/** A table like the one the verify and status commands will make. */
const TABLE: readonly Command[] = [
  {
    name: "verify",
    summary: "Verify a contract.",
    usage: "<input>",
    examples: [{ args: "verify input.json --dry-run", description: "Send nothing." }],
    options: { "dry-run": { type: "boolean", description: "Send nothing." } },
    maxPositionals: 1,
    run: NEVER,
  },
  ...COMMANDS,
];

function version(file: string): string {
  const parsed: unknown = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
  return String(Reflect.get(Object(parsed), "version"));
}

async function run(argv: readonly string[], commands: readonly Command[] = WITH_SCRIPTED) {
  const fake = fakeIo(argv);
  const code = await main(fake.io, commands);
  return { code, stdout: fake.stdout(), stderr: fake.stderr() };
}

/** The `result` of a one-line envelope. */
function resultOf(stdout: string): unknown {
  return oneEnvelope(stdout)["result"];
}

describe("main: help (R-AX-11)", () => {
  it("prints the CLI's help on stdout and exits 0, for --help, -h and help", async () => {
    const expected = helpText(helpResult(COMMANDS));
    for (const argv of [["--help"], ["-h"], ["help"], ["--quiet", "help"]]) {
      const result = await run(argv);
      assert.equal(result.code, 0, argv.join(" "));
      assert.equal(result.stdout, expected, argv.join(" "));
      assert.equal(result.stderr, "", argv.join(" "));
    }
  });

  it("prints a command's help for help <command> and <command> --help", async () => {
    const scripted = WITH_SCRIPTED.find((command) => command.name === "scripted");
    assert.ok(scripted);
    const expected = helpText(helpResult(WITH_SCRIPTED, scripted));
    for (const argv of [
      ["help", "scripted"],
      ["scripted", "--help"],
      ["scripted", "-h", "x"],
    ]) {
      const result = await run(argv);
      assert.equal(result.code, 0, argv.join(" "));
      assert.equal(result.stdout, expected, argv.join(" "));
    }
  });

  it("prints one envelope with --json, which matches help.schema.json", async () => {
    const result = await run(["help", "--json"], TABLE);
    assert.equal(result.code, 0);
    const envelope = oneEnvelope(result.stdout);
    assert.deepEqual(helpProblems(envelope), []);
    assert.deepEqual(Object.keys(envelope), ["schemaVersion", "ok", "result"]);
    assert.deepEqual(resultOf(result.stdout), JSON.parse(JSON.stringify(helpResult(TABLE))));
    const topic = await run(["verify", "--help", "--json"], TABLE);
    assert.equal(Reflect.get(Object(resultOf(topic.stdout)), "topic"), "verify");
  });

  it("wins over --version, and runs no command", async () => {
    const result = await run(["verify", "--version", "--help"], TABLE);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.startsWith("explorer-verify verify: "));
  });

  it("does not check a command's own option values: the command checks them when it runs", async () => {
    const result = await run(["scripted", "--outcome", "bogus", "--help"]);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.startsWith("explorer-verify scripted: "));
    const ran = await run(["scripted", "--outcome", "bogus", "--json"]);
    assert.equal(ran.code, 2);
    assert.match(ran.stdout, /--outcome must be one of/);
  });

  it("checks the values of the global options", async () => {
    const result = await run(["scripted", "--color", "pink", "--help", "--json"]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /--color must be one of auto, always, never/);
  });

  it("gives way to a usage error, which exits 2", async () => {
    const result = await run(["--help", "--json", "--nope"]);
    assert.equal(result.code, 2);
    assert.deepEqual(envelopeProblems(oneEnvelope(result.stdout)), []);
    const topic = await run(["help", "nothing", "--json"]);
    assert.equal(topic.code, 2);
    assert.match(topic.stdout, /command is not known/);
  });
});

describe("main: version (R-AX-11)", () => {
  it("prints the CLI and core versions, one per line", async () => {
    const result = await run(["--version"]);
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      `@explorer-verify/cli ${version("../../package.json")}\nexplorer-verify ${version("../../../explorer-verify/package.json")}\n`,
    );
    assert.equal(result.stderr, "");
  });

  it("adds the routing table's date with --json, and matches version.schema.json", async () => {
    const result = await run(["--version", "--json"]);
    assert.equal(result.code, 0);
    const envelope = oneEnvelope(result.stdout);
    assert.deepEqual(versionProblems(envelope), []);
    assert.deepEqual(envelope, {
      schemaVersion: 1,
      ok: true,
      result: {
        cli: version("../../package.json"),
        core: version("../../../explorer-verify/package.json"),
        routingTableDate: await routingTableDate(),
      },
    });
  });

  it("refuses a schema-breaking version result", () => {
    assert.notDeepEqual(
      versionProblems({ schemaVersion: 1, ok: true, result: { cli: "1", core: "1" } }),
      [],
    );
    assert.notDeepEqual(
      versionProblems({
        schemaVersion: 1,
        ok: true,
        result: { cli: "1", core: "1", routingTableDate: "3 Nov" },
      }),
      [],
    );
  });
});

describe("main: suggestions (R-AX-10)", () => {
  it("explorer-verify verfy suggests verify, with exit code 2", async () => {
    const result = await run(["verfy", "--json"], TABLE);
    assert.equal(result.code, 2);
    const envelope = oneEnvelope(result.stdout);
    assert.deepEqual(envelopeProblems(envelope), []);
    const error = Object(envelope["error"]);
    assert.equal(Reflect.get(error, "code"), "invalid-input");
    assert.equal(
      Reflect.get(error, "hint"),
      "Did you mean verify? Fix the arguments the message names, then run the command again. explorer-verify --help lists the commands and options.",
    );
    assert.match(result.stderr, /hint: Did you mean verify\?/);
  });

  it("--dryrun suggests --dry-run, with exit code 2", async () => {
    const result = await run(["verify", "x", "--dryrun", "--json"], TABLE);
    assert.equal(result.code, 2);
    assert.match(
      String(Reflect.get(Object(oneEnvelope(result.stdout)["error"]), "hint")),
      /^Did you mean --dry-run\? /,
    );
  });

  it("names nothing when nothing is close", async () => {
    const result = await run(["deploy", "--json"], TABLE);
    assert.equal(result.code, 2);
    assert.match(
      String(Reflect.get(Object(oneEnvelope(result.stdout)["error"]), "hint")),
      /^Fix the arguments/,
    );
  });
});
