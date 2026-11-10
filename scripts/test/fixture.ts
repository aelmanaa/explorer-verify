// A small repository tree that passes every agent-docs rule. Each test copies it into a fresh
// temporary folder and breaks one rule.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CORE_ENTRY, RAW_MAIN } from "../agent-docs.ts";

/** The user index page of the fixture. */
export const README = "docs/user/README.md";
/** The agent page of the fixture. */
export const AGENT = "docs/user/guides/using-from-an-agent.md";
/** An image the index page links. */
export const IMAGE = "docs/user/img/logo.png";
/** The skill of the fixture, at the repository root. */
export const SKILL = "skills/explorer-verify/SKILL.md";

const LLMS_TXT = `# explorer-verify

> Verifies contract source on block explorers.

## User docs

- [Index](${RAW_MAIN}${README}): the index
- [Agents](${RAW_MAIN}${AGENT}): the agent page
- [Skill](${RAW_MAIN}${SKILL}): the skill

## Contributor docs

- [AGENTS](${RAW_MAIN}AGENTS.md): start here
- [Elsewhere](https://example.com/page.md): not in this repository
`;

/** The files of the fixture, by path. */
export const VALID: Readonly<Record<string, string>> = {
  "packages/explorer-verify/package.json": JSON.stringify({
    name: "fixture-package",
    version: "1.2.3",
    type: "module",
    files: ["docs/", "skills/", "llms.txt"],
  }),
  // The built entry point, which check-packed-files.ts reads the error codes from.
  [CORE_ENTRY]: "export const ERROR_CODES = [];\n",
  "llms.txt": LLMS_TXT,
  [README]: `# User docs

Version: explorer-verify 1.2.3

Agents: [llms.txt](../../llms.txt).

See [the agent page](guides/using-from-an-agent.md#notes), [guides](guides/) and [AGENTS](../../AGENTS.md).

![logo](img/logo.png)
`,
  [IMAGE]: "PNG",
  [SKILL]: `---
name: explorer-verify
---

Read [llms.txt](../../llms.txt), [the agent page](../../docs/user/guides/using-from-an-agent.md#notes), [stop](#stop) and [AGENTS](../../AGENTS.md).

## Stop
`,
  [AGENT]: `# Using explorer-verify from an agent

Version: explorer-verify 1.2.3

Agents: [llms.txt](../../../llms.txt).

## Submit is permanent

## Safe steps

## API keys

## Etherscan plan rule

## Notes

Back to the [index](../README.md#user-docs), [this section](#notes), the [top](#) and [a host](//example.com/x.md).

<!-- docs-style: legacy -->
`,
  "docs/contributor/notes.md": "# Notes\n\n[Requirements](requirements.md)\n",
  "docs/contributor/requirements.md": "# Requirements\n",
  "AGENTS.md": "# AGENTS\n",
};

/** Creates a fresh copy of the fixture and returns its root. */
export function makeFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "agent-docs-"));
  writeFiles(root, VALID);
  return root;
}

/** Removes a fixture. */
export function removeFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Writes files into a fixture, creating folders. */
export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

/** Replaces the first `from` in a fixture file with `to`, and fails when `from` is absent. */
export function edit(root: string, file: string, from: string, to: string): void {
  const text = readFileSync(path.join(root, file), "utf8");
  assert.ok(text.includes(from), `${file} has no ${from}`);
  writeFileSync(path.join(root, file), text.replace(from, to));
}

/** Reads a fixture file. */
export function read(root: string, file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}
