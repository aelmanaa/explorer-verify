// The CLI, Foundry and Hardhat quickstarts under docs/user/start/ against the built bin (R-AX-2):
// each command-line example prints what the page shows and exits with the code it states. The
// sample request runs in a folder that holds only the downloaded file, the Foundry examples in a
// Foundry build of the Greeter, and the Hardhat examples in a Hardhat 3 build. Every run uses the
// fake explorer, so nothing reaches the network.
import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { blocks, shellExamples } from "../helpers/shell-examples.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 30_000 };
const START = new URL("../../../../docs/user/start/", import.meta.url);
const SAMPLE = "greeter-sepolia.json";
const REPO_URL = "https://raw.githubusercontent.com/aelmanaa/explorer-verify/main";
const PAGES = ["quickstart-cli.md", "quickstart-foundry.md", "quickstart-hardhat.md"];
/** The most steps a quickstart may have. */
const MAX_STEPS = 5;

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-quickstarts-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

/** A folder that holds only the sample request, as after the page's download step. */
const DOWNLOAD = join(DIR, "download");
mkdirSync(DOWNLOAD);
copyFileSync(fileURLToPath(new URL(SAMPLE, START)), join(DOWNLOAD, SAMPLE));

/** The CLI's Foundry fixture, with its build-info renamed to a hash as forge names it. */
const FOUNDRY = join(DIR, "foundry");
cpSync(join(PROJECT, "out"), join(FOUNDRY, "out"), { recursive: true });
renameSync(
  join(FOUNDRY, "out/build-info/greeter.json"),
  join(FOUNDRY, "out/build-info/8f3e2a91c04d7b65.json"),
);

/** The Hardhat 3 fixture of `@explorer-verify/hardhat`. */
const HARDHAT = join(DIR, "hardhat");
cpSync(
  fileURLToPath(new URL("../../../hardhat/test/fixtures/hardhat-3.21.2/", import.meta.url)),
  HARDHAT,
  { recursive: true },
);

/** The folder an example runs in, from the flag that names its input. */
function folderOf(args: readonly string[]): string {
  if (args.includes("--input-json")) {
    return DOWNLOAD;
  }
  if (args.includes("--hardhat")) {
    return HARDHAT;
  }
  assert.ok(args.includes("--foundry"), `no input flag in: ${args.join(" ")}`);
  return FOUNDRY;
}

for (const name of PAGES) {
  const page = readFileSync(new URL(name, START), "utf8");
  const examples = shellExamples(page, name);

  describe(`quickstart ${name}`, { concurrency: true }, () => {
    it(`has at most ${String(MAX_STEPS)} steps and ends with Next steps`, () => {
      const headings = [...page.matchAll(/^## (.+)$/gm)].map((match) => String(match[1]));
      const steps = headings.filter((heading) => heading !== "Next steps");
      assert.ok(steps.length <= MAX_STEPS, headings.join(" | "));
      assert.equal(headings.at(-1), "Next steps");
    });

    it("starts with the download of the shipped sample request", () => {
      const first = blocks(page)[0];
      assert.equal(
        first?.code,
        `repo=${REPO_URL}\ncurl -fsSLO "$repo/docs/user/start/${SAMPLE}"\n`,
      );
    });

    it("runs every command through npx: a dry run on the sample, then a verify", () => {
      const commands = blocks(page)
        .filter((block) => block.lang === "sh")
        .map((block) => block.code.split("\n").find((line) => !line.startsWith("#")) ?? "");
      assert.ok(commands.length > 0);
      for (const command of commands) {
        assert.match(command, /^npx @explorer-verify\/cli /);
      }
      const lines = examples.map(({ args }) => args.join(" "));
      assert.match(
        String(lines[0]),
        /^verify --input-json greeter-sepolia\.json --dry-run --json$/,
      );
      assert.ok(
        lines.some((line) => !line.includes("--dry-run")),
        "a run without --dry-run",
      );
    });

    for (const example of examples) {
      it(`line ${String(example.line)}: ${example.args.join(" ")}`, TIMEOUT, async () => {
        const result = await runBin(example.args, { cwd: folderOf(example.args), fake: {} });
        assert.equal(result.code, example.exitCode, `stderr:\n${result.stderr}`);
        assert.equal(result.stdout, example.stdout);
      });
    }
  });
}

describe("quickstart quickstart-hardhat.md, the plugin question", () => {
  it("says it is not a Hardhat plugin and links the Hardhat guide", () => {
    const page = readFileSync(new URL("quickstart-hardhat.md", START), "utf8");
    assert.match(page, /This is not a Hardhat plugin/);
    assert.match(page, /\(\.\.\/guides\/verify-from-a-hardhat-project\.md\)/);
  });
});
