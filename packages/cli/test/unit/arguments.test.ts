// readArguments: --json is found before any usage error (R-AX-5), and no issue repeats text the
// caller typed (R-AX-9).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { commandOptions, GLOBAL_OPTIONS, readArguments } from "../../src/arguments.ts";
import type { CommandSpec, OptionSpec } from "../../src/arguments.ts";
import { COMMANDS } from "../../src/commands.ts";
import { REFUSED_KEY_MESSAGE, REFUSED_KEY_OPTIONS } from "../../src/keys.ts";

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
      { field: "--api-key", message: REFUSED_KEY_MESSAGE },
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
      for (const [name, spec] of Object.entries(commandOptions(command))) {
        const first = seen.get(name);
        if (first !== undefined) {
          assert.equal(spec.type, first.type, `${command.name} --${name}`);
          assert.equal(spec.short, first.short, `${command.name} --${name}`);
        }
        seen.set(name, spec);
      }
    }
  });

  it("keeps the simulate placeholder hidden behind verify and status", () => {
    // The contract tests still drive every exit path and signal through simulate on the built
    // bin; it stays hidden until they run against a fake explorer.
    assert.deepEqual(
      COMMANDS.map(({ name, hidden }) => [name, hidden === true]),
      [
        ["verify", false],
        ["status", false],
        ["simulate", true],
      ],
    );
  });
});

describe("readArguments: help and version (R-AX-11)", () => {
  it("reads --help, -h and the word help, with or without a command", () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["help", "--json"]]) {
      const args = read(argv);
      assert.equal(args.help, true, argv.join(" "));
      assert.equal(args.command, undefined);
      assert.deepEqual(args.issues, [], argv.join(" "));
    }
    const topic = read(["help", "alpha", "--fast"]);
    assert.equal(topic.help, true);
    assert.equal(topic.command, "alpha");
    assert.deepEqual(topic.positionals, []);
    assert.deepEqual(topic.issues, []);
    const flag = read(["alpha", "--help"]);
    assert.equal(flag.help, true);
    assert.equal(flag.command, "alpha");
    assert.equal(read(["alpha"]).help, false);
  });

  it("reports only takes no value for --help=yes, not a missing command", () => {
    const args = read(["--help=yes"]);
    assert.equal(args.help, false);
    assert.deepEqual(args.issues, [{ field: "--help", message: "takes no value" }]);
    assert.deepEqual(read(["--version=1"]).issues, [
      { field: "--version", message: "takes no value" },
    ]);
  });

  it("reads -hh as -h given twice", () => {
    const args = read(["-hh"]);
    assert.equal(args.help, true);
    assert.deepEqual(args.issues, []);
  });

  it("gives help for a hidden command when it is named", () => {
    assert.equal(read(["help", "secret"]).command, "secret");
  });

  it("refuses an unknown topic, and more than one", () => {
    assert.deepEqual(read(["help", "gamma"]).issues, [
      { field: "command", message: "is not known; give one of alpha, beta" },
    ]);
    assert.deepEqual(read(["help", "alpha", "beta"]).issues, [
      { field: "help", message: "takes at most one command" },
    ]);
  });

  it("reads --version without a command", () => {
    const args = read(["--version", "--json"]);
    assert.equal(args.values.get("version"), true);
    assert.deepEqual(args.issues, []);
    assert.deepEqual(read(["--version", "gamma"]).issues, [
      { field: "command", message: "is not known; give one of alpha, beta" },
    ]);
  });
});

describe("readArguments: suggestions (R-AX-10)", () => {
  const table: readonly CommandSpec[] = [
    {
      name: "verify",
      options: { "dry-run": { type: "boolean", description: "Send nothing." } },
    },
    { name: "status", options: {} },
    { name: "simulate", hidden: true, options: { outcome: { type: "string", description: "O." } } },
  ];

  it("suggests the closest command: verfy gives verify", () => {
    const args = readArguments(["verfy"], table);
    assert.equal(args.suggestion, "verify");
    assert.deepEqual(args.issues, [
      { field: "command", message: "is not known; give one of verify, status" },
    ]);
    assert.equal(readArguments(["help", "stauts"], table).suggestion, "status");
    // The word help is suggested like a command.
    assert.equal(readArguments(["hlp"], table).suggestion, "help");
    assert.equal(readArguments(["hellp"], table).suggestion, "help");
  });

  it("suggests the closest option: --dryrun gives --dry-run", () => {
    const args = readArguments(["verify", "--dryrun"], table);
    assert.equal(args.suggestion, "--dry-run");
    assert.deepEqual(args.issues, [{ field: "argument 2", message: "is not an option" }]);
    assert.equal(readArguments(["verify", "--jsno"], table).suggestion, "--json");
    assert.equal(readArguments(["--colour=never", "verify"], table).suggestion, "--color");
  });

  it("compares an option with every public command's options when no command is named", () => {
    assert.equal(readArguments(["--dryrun", "--help"], table).suggestion, "--dry-run");
  });

  it("puts a mistyped command before a mistyped option", () => {
    assert.equal(readArguments(["verfy", "--jsno"], table).suggestion, "verify");
  });

  it("keeps the first mistyped option's suggestion", () => {
    assert.equal(readArguments(["verify", "--jsno", "--dryrun"], table).suggestion, "--json");
  });

  it("suggests nothing when nothing is close, and never a hidden command or its options", () => {
    assert.equal(readArguments(["deploy"], table).suggestion, undefined);
    assert.equal(readArguments(["simulat"], table).suggestion, undefined);
    assert.equal(readArguments(["verify", "--outcom", "x"], table).suggestion, undefined);
    assert.equal(readArguments(["verify", `--${DUMMY_KEY}`], table).suggestion, undefined);
    assert.equal(readArguments(["verify", "-x"], table).suggestion, undefined);
    assert.equal(readArguments(["verify"], table).suggestion, undefined);
  });

  it("suggests nothing for a valid option of a command that was not named", () => {
    const args = readArguments(["--dry-run"], table);
    assert.equal(args.suggestion, undefined);
    assert.deepEqual(args.issues, [
      { field: "argument 1", message: "is not an option" },
      { field: "command", message: "is missing; give one of verify, status" },
    ]);
  });

  it("reads 1 MB unknown options quickly, comparing only until a suggestion is found", () => {
    const long = "y".repeat(1_000_000);
    const started = performance.now();
    const args = readArguments(["verify", `--${long}`, "--dryrun", `--${long}z`], table);
    assert.ok(performance.now() - started < 2000, "readArguments took too long on 1 MB");
    assert.equal(args.suggestion, "--dry-run");
    assert.equal(args.issues.length, 3);
    assert.ok(
      args.issues.every((issue) => !issue.field.includes(long) && !issue.message.includes(long)),
    );
  });

  it("compares a hidden command's options once that command is named", () => {
    assert.equal(readArguments(["simulate", "--outcom", "x"], table).suggestion, "--outcome");
  });
});

describe("readArguments: refused key options come before suggestions (R-AX-9, R-AX-10)", () => {
  const key = "plaindummykeyvalue";
  for (const name of REFUSED_KEY_OPTIONS) {
    for (const form of [[`--${name}`, key], [`--${name}=${key}`]]) {
      it(`refuses ${form.length === 1 ? `--${name}=<key>` : `--${name} <key>`} without a suggestion`, () => {
        const args = readArguments(["simulate", ...form], COMMANDS);
        assert.deepEqual(args.issues, [{ field: `--${name}`, message: REFUSED_KEY_MESSAGE }]);
        assert.equal(args.suggestion, undefined);
        assert.deepEqual(args.positionals, []);
        assert.ok(!JSON.stringify(args.issues).includes(key));
      });
    }
  }

  it("suggests a CLI name for another typo, never the refused value", () => {
    const args = readArguments(
      ["simulate", "--etherscan-api-key", key, "--api-key-fil", "k.txt"],
      COMMANDS,
    );
    assert.equal(args.suggestion, "--api-key-file");
    assert.ok(!JSON.stringify({ ...args, values: [...args.values] }).includes(key));
  });
});
