// Black-box tests for help, the version, suggestions and the generated CLI reference (#103). They
// read only the public contract: docs/user/reference/cli.md, the skill, the shipped JSON Schemas
// and the built bin's own output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { routingTableDate } from "explorer-verify";

import { envelopeProblems, helpProblems, oneEnvelope, versionProblems } from "../helpers/schema.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 30_000 };
// Each of these runs every documented example on the bin, one after the other.
const EXAMPLES_TIMEOUT = { timeout: 90_000 };
const ROOT = new URL("../../../../", import.meta.url);
const CLI_MD = readFileSync(new URL("docs/user/reference/cli.md", ROOT), "utf8");
const SKILL_MD = readFileSync(new URL("skills/explorer-verify/SKILL.md", ROOT), "utf8");
const ESC = "\u001B";
// A made-up value; no provider uses this shape, so secret scanners leave it alone.
const SECRET = "dummysecret0f3a9c2e7b41d8a6c5e09b7d4f2a1c3e8b";

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return [...value];
}

function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return String(value);
}

function errorOf(stdout: string): Record<string, unknown> {
  const envelope = oneEnvelope(stdout);
  assert.deepEqual(envelopeProblems(envelope), []);
  assert.equal(envelope["ok"], false);
  return record(envelope["error"]);
}

function hintOf(stdout: string): string {
  return text(errorOf(stdout)["hint"]);
}

function suggestion(stdout: string): string | undefined {
  return /Did you mean (\S+)\?/.exec(hintOf(stdout))?.[1];
}

async function helpJson(args: string[]): Promise<Record<string, unknown>> {
  const result = await runBin([...args, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const envelope = oneEnvelope(result.stdout);
  assert.deepEqual(helpProblems(envelope), []);
  return record(envelope["result"]);
}

const PACKAGE_VERSIONS = {
  cli: text(
    record(JSON.parse(readFileSync(new URL("packages/cli/package.json", ROOT), "utf8")))["version"],
  ),
  core: text(
    record(
      JSON.parse(readFileSync(new URL("packages/explorer-verify/package.json", ROOT), "utf8")),
    )["version"],
  ),
};

/** The part of cli.md between the generated markers. */
function generatedSection(): string {
  const start = CLI_MD.indexOf("<!-- Generated");
  const end = CLI_MD.indexOf("<!-- End of the generated part. -->");
  assert.ok(start >= 0 && end > start, "cli.md has the generated markers");
  return CLI_MD.slice(start, end);
}

/** The body under `## heading` (or `### heading`) up to the next heading of that level or higher. */
function sectionBody(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => line === heading);
  assert.ok(at >= 0, `cli.md has ${heading}`);
  const level = heading.indexOf(" ");
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const match = /^(#+) /.exec(line);
    if (match?.[1] !== undefined && match[1].length <= level) break;
    out.push(line);
  }
  return out.join("\n");
}

function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

function codeBlock(markdown: string): string[] {
  const match = /```text\n([\s\S]*?)\n```/.exec(markdown);
  assert.ok(match?.[1] !== undefined);
  return match[1].split("\n");
}

function exampleBullets(markdown: string): { command: string; description: string }[] {
  return [...markdown.matchAll(/^- `(explorer-verify [^`]*)`: (.*)$/gm)].map((m) => ({
    command: m[1] ?? "",
    description: m[2] ?? "",
  }));
}

function optionCell(option: Record<string, unknown>): string {
  const long = `\`${text(option["name"])}${option["value"] === undefined ? "" : ` ${text(option["value"])}`}\``;
  return option["short"] === undefined ? long : `\`${text(option["short"])}\`, ${long}`;
}

function optionRows(options: unknown): string[][] {
  return list(options).map((o) => {
    const option = record(o);
    const description = text(option["description"]);
    return [
      optionCell(option),
      option["repeatable"] === true ? `${description} Repeatable.` : description,
    ];
  });
}

function expectedExit(description: string): number {
  const match = /exit (\d+)/.exec(description);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

async function runExample(command: string, description: string): Promise<void> {
  assert.ok(!/["'\\$]/.test(command), "no shell quoting needed");
  const args = command.split(" ").slice(1);
  // The examples run in a Foundry project against the fake explorer: nothing reaches the network.
  const result = await runBin(args, { cwd: PROJECT, fake: {} });
  assert.equal(result.code, expectedExit(description), `${command}\n${result.stderr}`);
  if (args.includes("--json")) {
    const envelope = oneEnvelope(result.stdout);
    if (args.includes("--version")) {
      assert.deepEqual(versionProblems(envelope), []);
    } else if (args[0] === "help" || args.includes("--help")) {
      assert.deepEqual(helpProblems(envelope), []);
    } else {
      assert.deepEqual(envelopeProblems(envelope), []);
    }
  }
  if (/not-confirmed envelope with a handle/.test(description)) {
    const error = errorOf(result.stdout);
    assert.equal(error["code"], "not-confirmed");
    assert.match(text(error["handle"]), /^ev1:/);
  }
  if (/three polls/.test(description)) {
    assert.equal(result.stderr.match(/Poll \d+/g)?.length, 3);
    assert.match(result.stdout, /^verified/);
  }
}

/** The commands that cli.md documents under `### \`name\``. */
function documentedCommands(): string[] {
  return [...generatedSection().matchAll(/^### `([a-z-]+)`$/gm)].map((m) => m[1] ?? "");
}

describe(
  "blackbox #103: every help form prints on stdout and exits 0",
  { concurrency: true },
  () => {
    // The unit tests cover every form in-process; the bin runs one of each kind.
    const forms: string[][] = [["-h"], ["help", "status"], ["status", "--help"]];
    for (const args of forms) {
      it(`${args.join(" ")}: stdout only, exit 0, examples first`, TIMEOUT, async () => {
        const result = await runBin(args);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
        const sections = result.stdout.split("\n").filter((line) => /^[A-Z][a-z ]+:$/.test(line));
        assert.equal(sections[0], "Examples:", "examples lead");
        // A command's help leaves the global sections to the CLI's own help, and points to it (#225).
        const global = ["Global options:", "Environment variables:", "Exit codes:"];
        const topic = args.includes("status");
        for (const section of ["Usage:", ...global]) {
          assert.equal(sections.includes(section), section === "Usage:" || !topic, section);
        }
        assert.match(result.stdout, /^Docs: https:\/\/\S+\/reference\/cli$/m);
        if (topic) {
          assert.match(
            result.stdout,
            /^Global options, environment variables and exit codes: explorer-verify --help$/m,
          );
        } else {
          assert.match(result.stdout, /^Docs index for agents: https:\/\/\S+\/llms\.txt$/m);
        }
        assert.ok(!result.stdout.includes(ESC));
      });
    }

    for (const args of forms) {
      it(`${args.join(" ")} --json: one valid help envelope`, TIMEOUT, async () => {
        const result = await helpJson(args);
        const topic = args.includes("status") ? "status" : null;
        assert.equal(result["topic"], topic);
        if (topic === null) {
          assert.deepEqual(
            list(result["commands"]).map((c) => record(c)["name"]),
            ["verify", "status"],
            "hidden commands are not listed",
          );
        } else {
          assert.deepEqual(
            list(result["commands"]).map((c) => record(c)["name"]),
            ["status"],
          );
        }
      });
    }

    it("the text help and the JSON help hold the same content", TIMEOUT, async () => {
      for (const args of [[], ["status"]]) {
        const json = await helpJson(["help", ...args]);
        const plain = (await runBin(["help", ...args])).stdout;
        const examplesEnd = plain.indexOf("Usage:");
        for (const example of list(json["examples"])) {
          const at = plain.indexOf(text(record(example)["command"]));
          assert.ok(at >= 0 && at < examplesEnd, "example before usage");
          assert.ok(plain.includes(text(record(example)["description"])));
        }
        for (const usage of list(json["usage"])) {
          assert.ok(plain.includes(`\n  ${text(usage)}\n`), text(usage));
        }
        if (args.length > 0) {
          // A command's text help leaves the global sections to the CLI's own help (#225).
          assert.ok(plain.includes(text(json["docsUrl"])));
          continue;
        }
        for (const option of list(json["globalOptions"])) {
          assert.ok(plain.includes(text(record(option)["description"])));
        }
        for (const variable of list(json["environment"])) {
          assert.match(plain, new RegExp(`^  ${text(record(variable)["name"])} `, "m"));
        }
        for (const exit of list(json["exitCodes"])) {
          assert.ok(plain.includes(`  ${String(record(exit)["code"])} `));
        }
        assert.ok(plain.includes(text(json["docsUrl"])));
        assert.ok(plain.includes(text(json["llmsUrl"])));
      }
    });
  },
);

describe("blackbox #103: --version", { concurrency: true }, () => {
  it("--version and -V print the CLI and core versions on two lines", TIMEOUT, async () => {
    for (const flag of ["--version", "-V"]) {
      const result = await runBin([flag]);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.equal(
        result.stdout,
        `@explorer-verify/cli ${PACKAGE_VERSIONS.cli}\nexplorer-verify ${PACKAGE_VERSIONS.core}\n`,
      );
    }
  });

  it("--version --json: valid envelope, versions, routing table date", TIMEOUT, async () => {
    const result = await runBin(["--version", "--json"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const envelope = oneEnvelope(result.stdout);
    assert.deepEqual(versionProblems(envelope), []);
    const body = record(envelope["result"]);
    assert.deepEqual(Object.keys(body), ["cli", "core", "routingTableDate"]);
    assert.equal(body["cli"], PACKAGE_VERSIONS.cli);
    assert.equal(body["core"], PACKAGE_VERSIONS.core);
    const date = text(body["routingTableDate"]);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), date);
    assert.equal(date, await routingTableDate());
  });

  it("cli.md names the version the bin prints", TIMEOUT, () => {
    assert.match(CLI_MD, new RegExp(`^Version: explorer-verify ${PACKAGE_VERSIONS.cli}$`, "m"));
  });
});

describe(
  "blackbox #103: precedence of help, version and usage errors",
  { concurrency: true },
  () => {
    it("help wins over the version, in either order", TIMEOUT, async () => {
      const help = (await runBin(["--help"])).stdout;
      for (const args of [
        ["--help", "--version"],
        ["--version", "--help"],
        ["--version", "help"],
      ]) {
        const result = await runBin(args);
        assert.equal(result.code, 0, args.join(" "));
        assert.equal(result.stdout, help, args.join(" "));
      }
      const json = await helpJson(["--version", "--help"]);
      assert.equal(json["topic"], null);
    });

    // cli.md: "A usage error wins over both: `explorer-verify --help --colour` exits 2."
    it(
      "a usage error in an option name or a global value wins over help and the version",
      TIMEOUT,
      async () => {
        for (const args of [
          ["--help", "--version", "--colour"],
          ["--version", "--color", "pink"],
          ["--help", "--quiet", "--verbose"],
        ]) {
          const result = await runBin([...args, "--json"]);
          assert.equal(result.code, 2, args.join(" "));
          assert.equal(errorOf(result.stdout)["code"], "invalid-input");
        }
      },
    );

    // cli.md: help does not check a command's own option values; the command checks them.
    it("a bad value of a command's own option does not beat help", TIMEOUT, async () => {
      for (const args of [
        ["status", "--timeout", "soon", "--help"],
        ["status", "--help", "--timeout", "-1"],
        ["help", "status", "--timeout", "soon"],
      ]) {
        const result = await runBin([...args, "--json"]);
        assert.equal(result.code, 0, args.join(" "));
        assert.deepEqual(helpProblems(oneEnvelope(result.stdout)), []);
      }
    });

    it("help of an unknown command exits 2", TIMEOUT, async () => {
      const result = await runBin(["help", "nope", "--json"]);
      assert.equal(result.code, 2);
      assert.equal(errorOf(result.stdout)["code"], "invalid-input");
    });
  },
);

describe("blackbox #103: did-you-mean suggestions", { concurrency: true }, () => {
  const close: [string[], string][] = [
    [["--colour=never", "--version"], "--color"],
    [["--verzzon"], "--version"],
    [["--logformat"], "--log-format"],
    [["status", "--timeot", "5"], "--timeout"],
    [["statsu", "--colour"], "status"],
    [["hlp"], "help"],
  ];
  for (const [args, expected] of close) {
    it(`${args.join(" ")} suggests ${expected}`, TIMEOUT, async () => {
      const result = await runBin([...args, "--json"]);
      assert.equal(result.code, 2);
      assert.equal(suggestion(result.stdout), expected);
      assert.match(result.stderr, new RegExp(`hint: Did you mean ${expected}\\?`));
    });
  }

  const none: [string, string[]][] = [
    ["far-off command", ["xyzzyq"]],
    ["more than a third differs", ["--colxx"]],
    ["two-character option", ["--js"]],
  ];
  for (const [name, args] of none) {
    it(`no suggestion for ${name}: ${args.join(" ")}`, TIMEOUT, async () => {
      const result = await runBin([...args, "--json"]);
      assert.equal(result.code, 2);
      assert.equal(suggestion(result.stdout), undefined);
      assert.ok(!result.stderr.includes("Did you mean"));
    });
  }

  it("the suggestion is always one of the CLI's own names", TIMEOUT, async () => {
    const top = await helpJson(["help"]);
    const status = await helpJson(["help", "status"]);
    const names = new Set<string>();
    for (const option of [
      ...list(top["globalOptions"]),
      ...list(record(list(status["commands"])[0])["options"]),
    ]) {
      names.add(text(record(option)["name"]));
    }
    for (const args of [["--colr"], ["status", "--timeot"], ["---color"], ["--Help"]]) {
      const result = await runBin([...args, "--json"]);
      const name = suggestion(result.stdout);
      assert.ok(name !== undefined && names.has(name), `${args.join(" ")} -> ${String(name)}`);
    }
  });
});

describe("blackbox #103: a mistyped option never echoes its value", { concurrency: true }, () => {
  // --json only: the text path writes the same error to stderr, which is checked too.
  const cases: string[][] = [
    [`--colr=${SECRET}`],
    ["--colour", SECRET],
    [`--api-key=${SECRET}`],
    ["status", `--timeot=${SECRET}`],
    ["help", SECRET],
    [`--${SECRET}`],
  ];
  for (const args of cases) {
    for (const json of [true]) {
      it(`${args.join(" ").slice(0, 40)}${json ? " --json" : ""}`, TIMEOUT, async () => {
        const result = await runBin(json ? [...args, "--json"] : args);
        assert.equal(result.code, 2);
        for (let i = 0; i + 8 <= SECRET.length; i += 1) {
          const piece = SECRET.slice(i, i + 8);
          assert.ok(!result.stdout.includes(piece), `stdout holds ${piece}`);
          assert.ok(!result.stderr.includes(piece), `stderr holds ${piece}`);
        }
      });
    }
  }
});

describe("blackbox #103: very long argv elements", { concurrency: true }, () => {
  const long = "a".repeat(100_000);
  it("100 kB elements return promptly with one envelope and no echo", TIMEOUT, async () => {
    const started = Date.now();
    const result = await runBin([
      `--colr${long}`,
      `--colr=${long}`,
      `--jsn${long}`,
      long,
      `--${long}`,
      "help",
      `statu${long}`,
      "--json",
    ]);
    const elapsed = Date.now() - started;
    assert.equal(result.code, 2);
    assert.ok(result.stdout.length < 2_000, "stdout stays short");
    assert.ok(result.stderr.length < 4_000, "stderr stays short");
    assert.ok(!result.stdout.includes("a".repeat(20)));
    assert.ok(!result.stderr.includes("a".repeat(20)));
    assert.ok(elapsed < 20_000, `took ${String(elapsed)} ms`);
    errorOf(result.stdout);
  });

  it("help with a 100 kB unknown topic exits 2 promptly", TIMEOUT, async () => {
    const result = await runBin(["help", long, "--json"]);
    assert.equal(result.code, 2);
    assert.ok(!result.stdout.includes("a".repeat(20)));
  });
});

describe("blackbox #103: colour", { concurrency: true }, () => {
  it("help and version JSON stay plain, even with --color=always", TIMEOUT, async () => {
    for (const args of [
      ["--help", "--json", "--color=always"],
      ["--version", "--json", "--color=always"],
    ]) {
      const result = await runBin(args, { env: { TERM: "xterm" } });
      assert.equal(result.code, 0);
      assert.ok(!result.stdout.includes(ESC));
      oneEnvelope(result.stdout);
    }
  });

  it(
    "a usage error's hint is coloured under --color=always, not under NO_COLOR",
    TIMEOUT,
    async () => {
      const always = await runBin(["--colour", "--color=always"]);
      assert.ok(always.stderr.includes(ESC));
      const noColor = await runBin(["--colour"], { env: { NO_COLOR: "1" } });
      assert.ok(!noColor.stderr.includes(ESC));
    },
  );
});

describe(
  "blackbox #103: every documented example runs with its exit code",
  { concurrency: true },
  () => {
    it("the examples in the bin's help", EXAMPLES_TIMEOUT, async () => {
      const seen: string[] = [];
      for (const topic of [[], ...documentedCommands().map((name) => [name])]) {
        const json = await helpJson(["help", ...topic]);
        for (const e of list(json["examples"])) {
          const example = record(e);
          seen.push(text(example["command"]));
          await runExample(text(example["command"]), text(example["description"]));
        }
      }
      assert.ok(seen.length >= 4);
    });

    it("the examples in cli.md", EXAMPLES_TIMEOUT, async () => {
      const examples = exampleBullets(generatedSection());
      assert.ok(examples.length >= 4);
      for (const { command, description } of examples) {
        await runExample(command, description);
      }
    });

    it("the skill's mistyped --color example prints the documented envelope", TIMEOUT, async () => {
      const block =
        /```sh\n# exit code (\d+)\n(explorer-verify [^\n]*)\n```\n\nIt prints:\n\n```text\n([^\n]*)\n```/.exec(
          SKILL_MD,
        );
      assert.ok(block?.[1] !== undefined && block[2] !== undefined && block[3] !== undefined);
      const result = await runBin(block[2].split(" ").slice(1));
      assert.equal(result.code, Number(block[1]));
      assert.equal(result.stdout, `${block[3]}\n`);
    });

    it("the --version --json sample in cli.md has the bin's shape", TIMEOUT, async () => {
      const sample =
        /```text\n\s*(\{"schemaVersion":1,"ok":true,"result":\{"cli"[^\n]*)\n\s*```/.exec(CLI_MD);
      assert.ok(sample?.[1] !== undefined);
      assert.deepEqual(versionProblems(JSON.parse(sample[1])), []);
    });
  },
);

describe(
  "blackbox #103: cli.md's generated section matches the bin's help",
  { concurrency: true },
  () => {
    it("usage, examples, options, variables and exit codes", TIMEOUT, async () => {
      const json = await helpJson(["help"]);
      const generated = generatedSection();
      assert.deepEqual(codeBlock(sectionBody(generated, "## Usage")), list(json["usage"]));
      assert.deepEqual(
        exampleBullets(sectionBody(generated, "## Examples")),
        list(json["examples"]).map((e) => ({
          command: text(record(e)["command"]),
          description: text(record(e)["description"]),
        })),
      );
      assert.deepEqual(
        tableRows(sectionBody(generated, "## Global options")),
        optionRows(json["globalOptions"]),
      );
      assert.deepEqual(
        tableRows(sectionBody(generated, "## Environment variables")),
        list(json["environment"]).map((v) => [
          `\`${text(record(v)["name"])}\``,
          text(record(v)["description"]),
        ]),
      );
      assert.deepEqual(
        tableRows(sectionBody(generated, "## Exit codes")),
        list(json["exitCodes"]).map((c) => [String(record(c)["code"]), text(record(c)["meaning"])]),
      );
      const plain = (await runBin(["--help"])).stdout;
      if (list(json["commands"]).length === 0) {
        const message = "This version has no public commands yet.";
        assert.ok(plain.includes(`Commands:\n  ${message}`));
        assert.ok(sectionBody(generated, "## Commands").includes(message));
      }
    });

    it("each command section matches help <command> --json", TIMEOUT, async () => {
      const generated = generatedSection();
      const names = documentedCommands();
      const top = await helpJson(["help"]);
      const listed = list(top["commands"]).map((c) => text(record(c)["name"]));
      assert.ok(names.length + listed.length > 0);
      for (const name of new Set([...names, ...listed])) {
        const json = await helpJson(["help", name]);
        const command = record(list(json["commands"])[0]);
        const body = sectionBody(generated, `### \`${name}\``);
        assert.ok(body.includes(text(command["summary"])), `${name} summary`);
        assert.deepEqual(codeBlock(body), [text(command["usage"])]);
        assert.deepEqual(
          exampleBullets(body),
          list(command["examples"]).map((e) => ({
            command: text(record(e)["command"]),
            description: text(record(e)["description"]),
          })),
        );
        assert.deepEqual(tableRows(body), optionRows(command["options"]));
        // A hidden command's section sits under "## Hidden commands", after the public ones.
        const hiddenAt = generated.indexOf("## Hidden commands");
        const at = generated.indexOf(`### \`${name}\``);
        assert.equal(hiddenAt !== -1 && at > hiddenAt, !listed.includes(name), name);
      }
    });
  },
);

describe("blackbox #103: a bare command line (R-AX-11, #225)", { concurrency: true }, () => {
  for (const args of [[], ["verify"]]) {
    const label = ["explorer-verify", ...args].join(" ");
    it(`${label}: the short help on stderr, exit 2`, TIMEOUT, async () => {
      const result = await runBin(args);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^Usage:$/m);
      assert.match(result.stderr, /^Examples:$/m);
      assert.match(result.stderr, /^Every option: explorer-verify /m);
      assert.ok(!result.stderr.includes(ESC));
    });
  }
});
