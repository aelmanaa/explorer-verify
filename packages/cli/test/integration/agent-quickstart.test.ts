// The AI agent quickstart, docs/user/start/quickstart-agent.md, against the built bin (R-AX-3):
// its prompt runs only dry runs and tells the agent to ask before a submit, every command in the
// prompt and on the page prints what the page shows, and the sample the prompt downloads is the
// one the docs ship. Every run uses the fake explorer, so nothing reaches the network.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { blocks, PROGRAMS, shellExamples } from "../helpers/shell-examples.ts";
import { runBin } from "../helpers/spawn-bin.ts";

const PAGE_NAME = "quickstart-agent.md";
const USER_DOCS = new URL("../../../../docs/user/", import.meta.url);
const PAGE = readFileSync(new URL(`start/${PAGE_NAME}`, USER_DOCS), "utf8");
const SAMPLE = "greeter-sepolia.json";
const SITE = "https://aelmanaa.github.io/explorer-verify/";
const TIMEOUT = { timeout: 30_000 };

/** The page's `text` blocks titled `prompt.txt`; the page has one, the prompt. */
const LINES = PAGE.split("\n");
const PROMPTS = blocks(PAGE).filter(({ line }) =>
  String(LINES[line - 1]).startsWith("```text [prompt.txt]"),
);
const PROMPT_TEXT = PROMPTS[0]?.code ?? "";

/** The CLI commands of the prompt, with continued lines joined and leading spaces dropped. */
const PROMPT_COMMANDS = PROMPT_TEXT.replace(/[ \t]*\\\n[ \t]*/g, " ")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => PROGRAMS.some((program) => line.startsWith(`${program} `)));

/** A folder holding the sample as the prompt's download leaves it. */
const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-agent-quickstart-"));
copyFileSync(fileURLToPath(new URL(`start/${SAMPLE}`, USER_DOCS)), join(DIR, SAMPLE));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("the agent quickstart's prompt (R-AX-3)", () => {
  it("is one code block", () => {
    assert.equal(PROMPTS.length, 1);
  });

  it("runs only dry runs, and stops for the person's yes before a submit", () => {
    assert.ok(PROMPT_COMMANDS.length > 0);
    for (const command of PROMPT_COMMANDS) {
      assert.match(command, / --dry-run( |$)/, command);
    }
    assert.match(PROMPT_TEXT, /then stop/);
    assert.match(PROMPT_TEXT, /Submit only after I say yes/);
    assert.match(PROMPT_TEXT, /never print/);
  });

  it("downloads the sample the docs ship, from the site", () => {
    const urls = [...PROMPT_TEXT.matchAll(/https:\/\/\S+/g)].map(([url]) => url);
    assert.ok(urls.includes(`${SITE}llms.txt`));
    const sample = urls.find((url) => url.endsWith(`/${SAMPLE}`));
    assert.equal(sample, `${SITE}start/${SAMPLE}`);
    assert.ok(existsSync(new URL(`start/${SAMPLE}`, USER_DOCS)));
  });

  it("holds the page's dry run, which prints what the page shows", TIMEOUT, async () => {
    const [example] = shellExamples(PAGE, PAGE_NAME);
    assert.ok(example);
    const prompted = PROMPT_COMMANDS.map((command) => {
      const program = PROGRAMS.find((name) => command.startsWith(`${name} `));
      return command.slice(String(program).length + 1).split(" ");
    });
    assert.deepEqual(prompted, [example.args]);
    for (const args of prompted) {
      const result = await runBin(args, { cwd: DIR, fake: {} });
      assert.equal(result.code, example.exitCode, `stderr:\n${result.stderr}`);
      assert.equal(result.stdout, example.stdout);
    }
  });
});

describe("the agent quickstart's command-line examples (R-AX-3)", () => {
  const examples = shellExamples(PAGE, PAGE_NAME);

  it("has one example, a dry run", () => {
    assert.equal(examples.length, 1);
    assert.ok(examples.every(({ args }) => args.includes("--dry-run")));
  });

  for (const example of examples) {
    it(
      `${PAGE_NAME} line ${String(example.line)}: explorer-verify ${example.args.join(" ")}`,
      TIMEOUT,
      async () => {
        const result = await runBin(example.args, { cwd: DIR, fake: {} });
        assert.equal(result.code, example.exitCode, `stderr:\n${result.stderr}`);
        assert.equal(result.stdout, example.stdout);
      },
    );
  }
});
