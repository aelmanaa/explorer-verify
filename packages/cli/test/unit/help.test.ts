// The help of the CLI and of each command (R-AX-11): examples first, then the usage, the options,
// the environment variables, the exit codes and the two links. The text, the envelope and the
// reference all come from one HelpResult.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ERROR_EXIT_CODES } from "explorer-verify";

import { readArguments } from "../../src/arguments.ts";
import type { Command } from "../../src/command.ts";
import { COMMANDS } from "../../src/commands.ts";
import {
  DOCS_URL,
  ENVIRONMENT,
  EXIT_CODES,
  helpResult,
  helpText,
  LLMS_URL,
} from "../../src/help.ts";
import { LOG_VARIABLE } from "../../src/log-level.ts";
import { helpProblems } from "../helpers/schema.ts";

const NEVER: Command["run"] = async () => await Promise.reject(new Error("must not run"));

/** A table like the one the verify and status commands will make. */
const TABLE: readonly Command[] = [
  {
    name: "verify",
    summary: "Verify a contract.",
    usage: "<input>",
    examples: [
      { args: "verify input.json --dry-run", description: "Check the input and send nothing." },
    ],
    options: {
      "dry-run": { type: "boolean", description: "Send nothing." },
      file: { type: "string", multiple: true, description: "A file." },
    },
    maxPositionals: 1,
    run: NEVER,
  },
  {
    name: "status",
    summary: "Resume a verification.",
    usage: "<handle>",
    examples: [{ args: "status ev1:x --json", description: "Ask once." }],
    options: {},
    maxPositionals: 1,
    run: NEVER,
  },
  ...COMMANDS,
];

/** Every command, of the shipped table and of the test table, each once. */
const ALL: readonly Command[] = [...new Set([...COMMANDS, ...TABLE])];

describe("help: every command's help (R-AX-11)", () => {
  for (const command of ALL) {
    it(`${command.name}: leads with an example, and lists the variables, the exit codes and the links`, () => {
      const text = helpText(helpResult(ALL, command));
      const lines = text.split("\n");
      assert.equal(lines[2], "Examples:");
      assert.ok(command.examples.length > 0);
      assert.equal(lines[3], `  explorer-verify ${command.examples[0].args}`);
      for (const variable of ENVIRONMENT) {
        assert.match(text, new RegExp(`^  ${variable.name} `, "m"));
      }
      for (const exit of EXIT_CODES) {
        assert.match(text, new RegExp(`^  ${String(exit.code)} +\\S`, "m"));
      }
      assert.ok(text.includes(DOCS_URL) && text.includes(LLMS_URL));
      assert.ok(text.indexOf("Examples:") < text.indexOf("Usage:"));
      assert.ok(text.indexOf("Usage:") < text.indexOf("Global options:"));
    });

    it(`${command.name}: every example is a valid command line of that command`, () => {
      for (const example of command.examples) {
        const args = readArguments(example.args.split(" "), ALL);
        assert.deepEqual(args.issues, [], example.args);
        assert.equal(args.command, command.name, example.args);
        assert.ok(args.positionals.length <= command.maxPositionals, example.args);
      }
    });

    it(`${command.name}: the envelope's result matches help.schema.json`, () => {
      const envelope = { schemaVersion: 1, ok: true, result: helpResult(ALL, command) };
      assert.deepEqual(helpProblems(JSON.parse(JSON.stringify(envelope))), []);
    });
  }

  it("lists a command's own options before the global ones, with placeholders", () => {
    const text = helpText(helpResult(TABLE, TABLE[0]));
    assert.ok(text.startsWith("explorer-verify verify: Verify a contract.\n"));
    assert.match(text, /^Usage:\n {2}explorer-verify verify <input> \[options\]\n/m);
    assert.match(text, /^ {2}--dry-run {7}Send nothing\.$/m);
    assert.match(text, /^ {2}--file <value> {2}A file\. Repeatable\.$/m);
    assert.ok(text.indexOf("Options:") < text.indexOf("Global options:"));
  });

  it("leaves the Options heading out for a command with none of its own", () => {
    const text = helpText(helpResult(TABLE, TABLE[1]));
    assert.doesNotMatch(text, /^Options:/m);
    assert.match(text, /^Global options:/m);
  });
});

describe("help: the CLI's own help (R-AX-11)", () => {
  it("leads with its examples, then the first example of each public command", () => {
    const help = helpResult(TABLE);
    assert.equal(help.topic, null);
    assert.deepEqual(
      help.examples.map((example) => example.command),
      [
        "explorer-verify --version --json",
        "explorer-verify help --json",
        "explorer-verify verify input.json --dry-run",
        "explorer-verify status ev1:x --json",
      ],
    );
    assert.deepEqual(
      help.commands.map((command) => command.name),
      ["verify", "status"],
    );
    const text = helpText(help);
    assert.match(text, /^Commands:\n {2}verify {2}Verify a contract\.\n {2}status {2}Resume/m);
  });

  it("never lists a hidden command", () => {
    const text = helpText(helpResult(COMMANDS));
    assert.ok(COMMANDS.every((command) => command.hidden === true));
    assert.match(text, /^Commands:\n {2}This version has no public commands yet\.$/m);
    assert.doesNotMatch(text, /simulate/);
    assert.deepEqual(JSON.parse(JSON.stringify(helpResult(COMMANDS))).commands, []);
  });

  it("runs every example of the CLI's own help without an issue", () => {
    for (const example of helpResult(COMMANDS).examples) {
      const argv = example.command.split(" ").slice(1);
      assert.deepEqual(readArguments(argv, COMMANDS).issues, [], example.command);
    }
  });

  it("matches help.schema.json, and its keys come in a fixed order (R-AX-12)", () => {
    const result = helpResult(TABLE);
    assert.deepEqual(helpProblems({ schemaVersion: 1, ok: true, result }), []);
    assert.deepEqual(Object.keys(result), [
      "topic",
      "summary",
      "usage",
      "examples",
      "commands",
      "globalOptions",
      "environment",
      "exitCodes",
      "docsUrl",
      "llmsUrl",
    ]);
    assert.deepEqual(result.globalOptions[0], {
      name: "--help",
      short: "-h",
      repeatable: false,
      description: "Print the help of the command, or of the CLI, on stdout.",
    });
    assert.deepEqual(
      result.globalOptions.find((option) => option.name === "--color"),
      {
        name: "--color",
        value: "<mode>",
        repeatable: false,
        description: "auto (default), always or never.",
      },
    );
  });

  it("gives the same text for the same table, with no terminal state in it (R-AX-12)", () => {
    assert.equal(helpText(helpResult(TABLE)), helpText(helpResult(TABLE)));
    assert.ok(!helpText(helpResult(TABLE)).includes("\u001b"));
  });
});

describe("help: environment variables and exit codes", () => {
  it("lists every exit code of the catalogue, plus 0 and 1, once and in order (R-AX-7)", () => {
    const used = [...new Set([0, 1, ...Object.values(ERROR_EXIT_CODES)])].toSorted((a, b) => a - b);
    assert.deepEqual(
      EXIT_CODES.map((exit) => exit.code),
      used,
    );
  });

  it("lists the variables the CLI reads", () => {
    assert.deepEqual(
      ENVIRONMENT.map((variable) => variable.name),
      [LOG_VARIABLE, "NO_COLOR", "TERM", "CI", "ETHERSCAN_API_KEY", "ROUTESCAN_API_KEY"],
    );
  });
});
