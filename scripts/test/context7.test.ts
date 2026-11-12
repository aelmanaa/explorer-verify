// Tests the rules for context7.json (scripts/context7.ts) on fixtures, and runs them on the
// repository's own file.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkContext7,
  checkContext7File,
  CONTEXT7_FILE,
  MAX_RULE_LENGTH,
  SCHEMA_FIELDS,
} from "../context7.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DESCRIPTION = "Verifies contracts.";
const FOLDERS = new Set(["docs/user", "skills", "examples"]);
const isFolder = (folder: string): boolean => FOLDERS.has(folder);

const VALID = {
  $schema: "https://context7.com/schema/context7.json",
  projectTitle: "explorer-verify",
  description: DESCRIPTION,
  folders: ["docs/user", "skills", "examples"],
  excludeFolders: ["docs/contributor", "test"],
  excludeFiles: ["CHANGELOG.md"],
  rules: ["Run a dry run first."],
};

function check(config: unknown): string[] {
  return checkContext7(JSON.stringify(config), isFolder, DESCRIPTION);
}

describe("R-AX-1: context7.json lists the user docs for Context7", () => {
  it("passes on the repository's own file", () => {
    assert.deepEqual(checkContext7File(root), []);
  });

  it("passes on a file that follows every rule", () => {
    assert.deepEqual(check(VALID), []);
  });

  it("refuses text that is not a JSON object", () => {
    assert.deepEqual(checkContext7("{", isFolder, DESCRIPTION), [
      `${CONTEXT7_FILE}: not valid JSON`,
    ]);
    assert.deepEqual(checkContext7("[]", isFolder, DESCRIPTION), [
      `${CONTEXT7_FILE}: not a JSON object`,
    ]);
  });

  it("refuses a field the schema does not have", () => {
    assert.ok(!SCHEMA_FIELDS.includes("folder"));
    assert.deepEqual(check({ ...VALID, folder: ["docs/user"] }), [
      `${CONTEXT7_FILE}: "folder" is not a field of the Context7 schema`,
    ]);
  });

  it("refuses a folder that does not exist", () => {
    assert.deepEqual(check({ ...VALID, folders: ["docs/user", "docs/missing"] }), [
      `${CONTEXT7_FILE}: "folders" names docs/missing, which is not a folder`,
    ]);
  });

  it("refuses the contributor docs or a folder under them in folders", () => {
    assert.deepEqual(check({ ...VALID, folders: ["docs/user", "docs/contributor/"] }), [
      `${CONTEXT7_FILE}: "folders" must not include docs/contributor/`,
    ]);
    assert.deepEqual(check({ ...VALID, folders: ["docs/contributor/decisions"] }), [
      `${CONTEXT7_FILE}: "folders" must not include docs/contributor/decisions`,
    ]);
  });

  it("refuses empty or missing folders", () => {
    const expected = [`${CONTEXT7_FILE}: "folders" must list at least one folder`];
    assert.deepEqual(check({ ...VALID, folders: [] }), expected);
    assert.deepEqual(check({ ...VALID, folders: "docs/user" }), expected);
  });

  it("refuses a file that does not exclude the contributor docs", () => {
    const expected = [`${CONTEXT7_FILE}: "excludeFolders" must list docs/contributor`];
    assert.deepEqual(check({ ...VALID, excludeFolders: ["test"] }), expected);
    // JSON.stringify drops a field whose value is undefined.
    assert.deepEqual(check({ ...VALID, excludeFolders: undefined }), expected);
  });

  it("refuses rules Context7 would reject", () => {
    assert.deepEqual(check({ ...VALID, rules: "Run a dry run first." }), [
      `${CONTEXT7_FILE}: "rules" must be a list of strings`,
    ]);
    assert.deepEqual(check({ ...VALID, rules: ["ok", " ", "x".repeat(MAX_RULE_LENGTH + 1)] }), [
      `${CONTEXT7_FILE}: rule 2 must be 1 to ${String(MAX_RULE_LENGTH)} characters`,
      `${CONTEXT7_FILE}: rule 3 must be 1 to ${String(MAX_RULE_LENGTH)} characters`,
    ]);
    assert.deepEqual(check({ ...VALID, rules: undefined }), []);
  });

  it("refuses a description that differs from the core package's", () => {
    assert.deepEqual(check({ ...VALID, description: "Something else." }), [
      `${CONTEXT7_FILE}: "description" must match the description in packages/explorer-verify/package.json`,
    ]);
  });

  it("reads the folders and the core description from a repository root", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "context7-"));
    try {
      mkdirSync(path.join(fixture, "packages/explorer-verify"), { recursive: true });
      mkdirSync(path.join(fixture, "docs/user"), { recursive: true });
      writeFileSync(path.join(fixture, "skills"), "a file, not a folder");
      writeFileSync(path.join(fixture, "packages/explorer-verify/package.json"), "{}");
      writeFileSync(
        path.join(fixture, CONTEXT7_FILE),
        JSON.stringify({ ...VALID, description: "", folders: ["docs/user", "skills", "examples"] }),
      );
      assert.deepEqual(checkContext7File(fixture), [
        `${CONTEXT7_FILE}: "folders" names skills, which is not a folder`,
        `${CONTEXT7_FILE}: "folders" names examples, which is not a folder`,
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
