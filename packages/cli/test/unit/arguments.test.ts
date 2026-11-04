// readArguments: --json is found before any usage error (R-AX-5), and no issue repeats text the
// caller typed (R-AX-9).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GLOBAL_OPTIONS, readArguments } from "../../src/arguments.ts";
import type { CommandSpec, OptionSpec } from "../../src/arguments.ts";
import { COMMANDS } from "../../src/commands.ts";

const DUMMY_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678";

const COMMANDS_UNDER_TEST: readonly CommandSpec[] = [
  {
    name: "alpha",
    options: {
      file: { type: "string", multiple: true, description: "A file." },
      name: { type: "string", description: "A name." },
      fast: { type: "boolean", short: "f", description: "Fast." },
    },
  },
  { name: "beta", options: { other: { type: "string", description: "Other." } } },
  { name: "secret", hidden: true, options: {} },
];

function read(argv: readonly string[]) {
  return readArguments(argv, COMMANDS_UNDER_TEST);
}

describe("readArguments: --json (R-AX-5)", () => {
  it("finds --json anywhere before --", () => {
    assert.equal(read(["--json", "alpha"]).json, true);
    assert.equal(read(["alpha", "--json"]).json, true);
    assert.equal(read(["alpha", "--name", "x", "--json"]).json, true);
  });

  it("finds --json even when the command line has usage errors", () => {
    const args = read(["--nope", "--json", "--color"]);
    assert.equal(args.json, true);
    assert.ok(args.issues.length >= 2);
  });

  it("does not count a --json after --", () => {
    const args = read(["alpha", "--", "--json"]);
    assert.equal(args.json, false);
    assert.deepEqual(args.positionals, ["--json"]);
  });

  it("reads an option-like argument after a string option as the next option, so --json counts", () => {
    const args = read(["alpha", "--color", "--json", "--name", "-f"]);
    assert.equal(args.json, true);
    assert.equal(args.values.get("fast"), true);
    assert.deepEqual(args.issues, [
      { field: "--color", message: "needs a value" },
      { field: "--name", message: "needs a value" },
    ]);
  });

  it("counts --json with an inline value, and still refuses the value", () => {
    const args = read(["alpha", "--json=true"]);
    assert.equal(args.json, true);
    assert.deepEqual(args.issues, [{ field: "--json", message: "takes no value" }]);
  });
});

describe("readArguments: commands and options", () => {
  it("reads the command, its options and the global options", () => {
    const args = read(["-q", "alpha", "-f", "--name=n", "--file", "a", "--file", "b", "pos"]);
    assert.equal(args.command, "alpha");
    assert.deepEqual(args.positionals, ["pos"]);
    assert.deepEqual(
      [...args.values],
      [
        ["quiet", true],
        ["fast", true],
        ["name", "n"],
        ["file", ["a", "b"]],
      ],
    );
    assert.deepEqual(args.issues, []);
  });

  it("keeps the last value of an option that does not repeat", () => {
    assert.equal(read(["alpha", "--name", "a", "--name", "b"]).values.get("name"), "b");
  });

  it("accepts -, a negative number, and an inline value that starts with -", () => {
    assert.equal(read(["alpha", "--name", "-"]).values.get("name"), "-");
    assert.equal(read(["alpha", "--name", "-1"]).values.get("name"), "-1");
    assert.equal(read(["alpha", "--name=-x"]).values.get("name"), "-x");
  });

  it("refuses an option of another command, naming the command", () => {
    assert.deepEqual(read(["alpha", "--other", "x"]).issues, [
      { field: "--other", message: "is not an option of alpha" },
    ]);
  });

  it("names an unknown option by its position, never by its spelling", () => {
    assert.deepEqual(read(["alpha", "--nope", "-z"]).issues, [
      { field: "argument 2", message: "is not an option" },
      { field: "argument 3", message: "is not an option" },
    ]);
  });

  it("gives a group of short options one issue, whatever letters it holds", () => {
    const args = read(["alpha", "-SECRETKEYZ"]);
    assert.deepEqual(args.issues, [{ field: "argument 2", message: "is not an option" }]);
  });

  it("names a missing or unknown command without echoing it, and lists only visible commands", () => {
    assert.deepEqual(read([]).issues, [
      { field: "command", message: "is missing; give one of alpha, beta" },
    ]);
    const unknown = read([DUMMY_KEY]);
    assert.equal(unknown.command, undefined);
    assert.deepEqual(unknown.issues, [
      { field: "command", message: "is not known; give one of alpha, beta" },
    ]);
    assert.equal(read(["secret"]).command, "secret");
  });

  it("says so when every command is hidden", () => {
    assert.deepEqual(readArguments([], [{ name: "x", hidden: true, options: {} }]).issues, [
      {
        field: "command",
        message: "is missing; this version has no public commands yet; see the CLI reference",
      },
    ]);
  });

  it("refuses a command option when no command is known", () => {
    // `--other` takes a value in some command, so it takes `x`, and no command is left.
    assert.deepEqual(read(["--other", "x"]).issues, [
      { field: "argument 1", message: "is not an option" },
      { field: "command", message: "is missing; give one of alpha, beta" },
    ]);
  });

  it("never repeats text the caller typed in an issue (R-AX-9)", () => {
    const args = read([
      "alpha",
      `--api-key=${DUMMY_KEY}`,
      "--fast=yes",
      `--${DUMMY_KEY}`,
      `-${DUMMY_KEY}`,
      "has space",
    ]);
    assert.ok(!JSON.stringify(args.issues).includes("ABCDEF"));
    assert.deepEqual(args.issues, [
      { field: "argument 2", message: "is not an option" },
      { field: "--fast", message: "takes no value" },
      { field: "argument 4", message: "is not an option" },
      { field: "argument 5", message: "is not an option" },
    ]);
  });

  it("leaves -v unbound (R-AX-15)", () => {
    assert.deepEqual(read(["alpha", "-v"]).issues, [
      { field: "argument 2", message: "is not an option" },
    ]);
  });

  it("reports a string option with no value", () => {
    assert.deepEqual(read(["alpha", "--name"]).issues, [
      { field: "--name", message: "needs a value" },
    ]);
  });
});

describe("the command table", () => {
  it("gives an option name the same type and short alias in every command that has it", () => {
    const seen = new Map<string, OptionSpec>(Object.entries(GLOBAL_OPTIONS));
    for (const command of COMMANDS) {
      for (const [name, spec] of Object.entries(command.options)) {
        const first = seen.get(name);
        if (first !== undefined) {
          assert.equal(spec.type, first.type, `${command.name} --${name}`);
          assert.equal(spec.short, first.short, `${command.name} --${name}`);
        }
        seen.set(name, spec);
      }
    }
  });

  it("keeps simulate only until verify lands (#101)", () => {
    const names = COMMANDS.map(({ name }) => name);
    assert.ok(
      !(names.includes("verify") && names.includes("simulate")),
      "verify exists: remove the simulate placeholder (#101)",
    );
  });
});
