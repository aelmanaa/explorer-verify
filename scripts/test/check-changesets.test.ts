import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CORE_MANIFEST,
  RELEASE_1_0_0,
  changesetBumps,
  main,
  majorProblems,
} from "../check-changesets.ts";
import { manifest, remove, runScript, writeFiles } from "./git-repo.ts";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const MAJOR = '---\n"explorer-verify": major\n---\n\nRemoves a field.\n';
const MINOR =
  "---\n'explorer-verify': minor\n\"@explorer-verify/cli\": patch\n---\n\nBreaking: renames x.\n";

function tree(version: string, changesets: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), "check-changesets-"));
  writeFiles(root, {
    [CORE_MANIFEST]: manifest("explorer-verify", version),
    ".changeset/README.md": "# Changesets\n\n---\nx: major\n",
    ...Object.fromEntries(
      Object.entries(changesets).map(([name, text]) => [`.changeset/${name}`, text]),
    ),
  });
  return root;
}

describe("changesets during 0.x (decision 0017)", () => {
  it("reads the bumps of the front matter only", () => {
    assert.deepEqual(changesetBumps(MINOR), [
      { name: "explorer-verify", bump: "minor" },
      { name: "@explorer-verify/cli", bump: "patch" },
    ]);
    assert.deepEqual(changesetBumps("---\n---\n\nNothing to release.\n"), []);
    assert.throws(
      () => changesetBumps("no front matter\nx: major\n"),
      /missing or invalid frontmatter/,
    );
    assert.throws(() => changesetBumps("---\na: huge\n---\n\nx\n"), /invalid version type "huge"/);
    assert.throws(() => changesetBumps(""), /file is empty/);
  });

  it("reads major in every YAML spelling changesets accepts", () => {
    for (const front of [
      '"explorer-verify": "major"',
      "explorer-verify: major # note",
      '{"explorer-verify": major}',
    ]) {
      assert.deepEqual(changesetBumps(`---\n${front}\n---\n\nRemoves a field.\n`), [
        { name: "explorer-verify", bump: "major" },
      ]);
    }
  });

  it("refuses the quoted, commented and flow spellings of major, and an unparsable changeset", () => {
    const root = tree("0.1.0", {
      "a.md": '---\n"explorer-verify": "major"\n---\n\nx\n',
      "b.md": "---\nexplorer-verify: major # note\n---\n\nx\n",
      "c.md": '---\n{"explorer-verify": major}\n---\n\nx\n',
      "d.md": "no front matter\n",
    });
    try {
      const problems = majorProblems(root);
      assert.equal(problems.length, 4);
      for (const [index, file] of ["a.md", "b.md", "c.md"].entries()) {
        assert.match(
          problems[index] ?? "",
          new RegExp(`^\\.changeset/${file}: "explorer-verify": major is not used`),
        );
      }
      assert.match(problems[3] ?? "", /^\.changeset\/d\.md: could not parse changeset/);
    } finally {
      remove(root);
    }
  });

  it("refuses a major changeset while the core is on 0.x", () => {
    const root = tree("0.3.1", { "a.md": MAJOR, "b.md": MINOR });
    try {
      const problems = majorProblems(root);
      assert.equal(problems.length, 1);
      assert.match(
        problems[0] ?? "",
        /^\.changeset\/a\.md: "explorer-verify": major is not used during 0\.x/,
      );
    } finally {
      remove(root);
    }
  });

  it("accepts the major of the 1.0.0 release changeset, and any major from 1.0", () => {
    const zero = tree("0.9.0", { [RELEASE_1_0_0]: MAJOR, "b.md": MINOR });
    const one = tree("1.0.0", { "a.md": MAJOR });
    const odd = tree("", { "a.md": MAJOR });
    const empty = tree("0.1.0", { "a.md": MAJOR });
    writeFiles(empty, { [CORE_MANIFEST]: "null" });
    try {
      assert.deepEqual(majorProblems(zero), []);
      assert.deepEqual(majorProblems(one), []);
      assert.deepEqual(majorProblems(odd), []);
      assert.deepEqual(majorProblems(empty), []);
    } finally {
      remove(zero);
      remove(one);
      remove(odd);
      remove(empty);
    }
  });

  it("resolves the root from the script folder, and runs from the command line", () => {
    const root = tree("0.1.0", { "a.md": MAJOR });
    try {
      const relative = path.relative(path.join(SCRIPTS, ".."), root);
      assert.equal(main([relative], SCRIPTS).length, 1);
      const failed = runScript(path.join(SCRIPTS, "check-changesets.ts"), [relative], SCRIPTS);
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /major is not used during 0\.x/);
      const passed = runScript(path.join(SCRIPTS, "check-changesets.ts"), [], SCRIPTS);
      assert.equal(passed.status, 0, passed.stderr);
    } finally {
      remove(root);
    }
  });
});
