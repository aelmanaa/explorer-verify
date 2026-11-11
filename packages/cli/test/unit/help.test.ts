// The help of the CLI and of each command (R-AX-11): examples first, then the usage and the options;
// the CLI's own help adds the environment variables, the exit codes and the two links. The text, the envelope and the
// reference all come from one HelpResult.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ERROR_EXIT_CODES } from "explorer-verify/envelope";

import { readArguments } from "../../src/arguments.ts";
import type { Command } from "../../src/command.ts";
import { COMMANDS } from "../../src/commands.ts";
import {
  commandHelp,
  DOCS_URL,
  ENVIRONMENT,
  EXIT_CODES,
  helpResult,
  helpText,
  LLMS_URL,
  shortHelpText,
  usageLines,
} from "../../src/help.ts";
import { LOG_VARIABLE } from "../../src/log-level.ts";
import { helpProblems } from "../helpers/schema.ts";
import { WITH_SCRIPTED } from "../helpers/scripted-command.ts";

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
  ...COMMANDS.filter((command) => command.hidden === true),
];

/** Every command, of the shipped table and of the test table, each once. */
const ALL: readonly Command[] = [...new Set([...COMMANDS, ...TABLE])];

describe("help: every command's help (R-AX-11)", () => {
  for (const command of ALL) {
    it(`${command.name}: leads with an example, and points to the CLI's help for the global sections (#225)`, () => {
      const text = helpText(helpResult(ALL, command));
      const lines = text.split("\n");
      assert.equal(lines[2], "Examples:");
      assert.ok(command.examples.length > 0);
      assert.equal(lines[3], `  explorer-verify ${command.examples[0].args}`);
      assert.ok(text.indexOf("Examples:") < text.indexOf("Usage:"));
      for (const heading of ["Global options:", "Environment variables:", "Exit codes:"]) {
        assert.doesNotMatch(text, new RegExp(`^${heading}`, "m"));
      }
      assert.ok(
        text.endsWith(
          `Global options, environment variables and exit codes: explorer-verify --help\nDocs: ${DOCS_URL}\n`,
        ),
      );
      // The envelope keeps every section, for a program that reads one topic only.
      const result = helpResult(ALL, command);
      assert.equal(result.environment, ENVIRONMENT);
      assert.equal(result.exitCodes, EXIT_CODES);
      assert.equal(result.llmsUrl, LLMS_URL);
    });

    it(`${command.name}: the short help has the usage and two examples, and names the full help (R-AX-11)`, () => {
      const text = shortHelpText(helpResult(ALL, command));
      const lines = text.split("\n");
      assert.equal(lines[2], "Usage:");
      assert.ok(text.includes(`  explorer-verify ${command.examples[0].args}\n`));
      const shown = command.examples.slice(0, 2).length;
      assert.equal(
        lines.filter((line) => line.startsWith("  explorer-verify ")).length,
        usageLines(command).length + shown,
      );
      assert.ok(text.endsWith(`Every option: explorer-verify help ${command.name}\n`));
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

  it("lists a command's own options, with placeholders", () => {
    const text = helpText(helpResult(TABLE, TABLE[0]));
    assert.ok(text.startsWith("explorer-verify verify: Verify a contract.\n"));
    assert.match(text, /^Usage:\n {2}explorer-verify verify <input> \[options\]\n/m);
    assert.match(text, /^ {2}--dry-run {7}Send nothing\.$/m);
    assert.match(text, /^ {2}--file <value> {2}A file\. Repeatable\.$/m);
    assert.ok(text.indexOf("Options:") < text.indexOf("Global options, environment"));
  });

  it("leaves the Options heading out for a command with none of its own", () => {
    const text = helpText(helpResult(TABLE, TABLE[1]));
    assert.doesNotMatch(text, /^Options:/m);
  });

  it("gives verify a usage line for each way to call it, naming what it needs (#225)", () => {
    const verify = COMMANDS.find(({ name }) => name === "verify");
    assert.ok(verify !== undefined);
    assert.deepEqual(helpResult(COMMANDS, verify).usage, [
      "explorer-verify verify <address> --chain <chain> --input <file>... (--backend <name> | --dry-run) [options]",
      "explorer-verify verify <address> --chain <chain> (--foundry <dir> | --hardhat <dir>) --contract <path:Name> (--backend <name> | --dry-run) [options]",
      "explorer-verify verify --input-json <file> [options]",
    ]);
    // The command's own entry keeps the first line, as help.schema.json has one per command.
    assert.equal(commandHelp(verify).usage, helpResult(COMMANDS, verify).usage[0]);
    const text = helpText(helpResult(COMMANDS, verify));
    assert.match(text, /^ {2}-c, --chain <chain> +The chain/m);
    assert.match(text, /^ {2}-i, --input <file> +A build file/m);
    assert.match(text, /^ {2}-n, --dry-run +Check the input/m);
    assert.match(text, /^ {2}--poll-interval <seconds> +The wait between two status polls/m);
  });

  // --submit-over-partial, --index-wait and --require-own-source each add a line.
  it("keeps help verify to 52 lines at most, down from 64 (#225)", () => {
    const verify = COMMANDS.find(({ name }) => name === "verify");
    assert.ok(verify !== undefined);
    const lines = helpText(helpResult(COMMANDS, verify)).split("\n").length - 1;
    assert.ok(lines <= 52, `${String(lines)} lines`);
  });
});

describe("help: the short help of a bare command line (R-AX-11)", () => {
  it("shows each public command's first example, not the help and version ones", () => {
    const text = shortHelpText(helpResult(TABLE));
    assert.equal(
      text,
      [
        "explorer-verify: Verify the source of deployed smart contracts on block explorers.",
        "",
        "Usage:",
        "  explorer-verify <command> [options]",
        "  explorer-verify help [<command>]",
        "",
        "Examples:",
        "  explorer-verify verify input.json --dry-run",
        "      Check the input and send nothing.",
        "  explorer-verify status ev1:x --json",
        "      Ask once.",
        "",
        "Every option: explorer-verify --help",
        "",
      ].join("\n"),
    );
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
    const text = helpText(helpResult(WITH_SCRIPTED));
    assert.ok(WITH_SCRIPTED.some((command) => command.hidden === true));
    assert.match(text, /^Commands:\n {2}verify +Verify a deployed\b.*\n {2}status +Resume\b/m);
    assert.doesNotMatch(text, /scripted/);
    assert.deepEqual(
      helpResult(WITH_SCRIPTED).commands.map((command) => command.name),
      ["verify", "status"],
    );
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
      [
        LOG_VARIABLE,
        "NO_COLOR",
        "TERM",
        "CI",
        "ETHERSCAN_API_KEY",
        "ROUTESCAN_API_KEY",
        "BLOCKSCOUT_API_KEY",
      ],
    );
  });
});
