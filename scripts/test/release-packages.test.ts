import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CORE,
  errorMessage,
  type Git,
  gitIn,
  readManifest,
  type ReleasePackage,
  releaseOrder,
  releasePackagesAt,
  run,
} from "../release-packages.ts";
import { commit, gitEnv, makeRepo, manifest, remove, runScript } from "./git-repo.ts";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "release-packages.ts");

/** A git stub that serves a fixed tree of manifests at any commit. */
function stubGit(manifests: Readonly<Record<string, string>>, listable = true): Git {
  return (args) => {
    if (args[0] === "ls-tree") {
      return listable
        ? { status: 0, stdout: `${Object.keys(manifests).join("\n")}\n` }
        : { status: 128, stdout: "" };
    }
    const directory = /packages\/([^/]+)\/package\.json$/.exec(args[1] ?? "")?.[1] ?? "";
    const text = manifests[directory];
    return text === undefined ? { status: 128, stdout: "" } : { status: 0, stdout: text };
  };
}

/** A published package at 0.1.0 whose directory is its name. */
function published(name: string): ReleasePackage {
  return { directory: name, name, version: "0.1.0" };
}

/** A git stub that lists one folder and has no manifest in it. */
const gaps: Git = (args) =>
  args[0] === "ls-tree" ? { status: 0, stdout: "empty\n" } : { status: 128, stdout: "" };

describe("release packages (decision 0017)", () => {
  it("reads a published manifest and skips a private one", () => {
    assert.deepEqual(readManifest("cli", "m", manifest("@explorer-verify/cli", "0.1.0")), {
      directory: "cli",
      name: "@explorer-verify/cli",
      version: "0.1.0",
    });
    assert.equal(readManifest("core", "m", manifest(CORE, "0.1.0", true)), undefined);
  });

  it("refuses a manifest that is not JSON or lacks a name or a version", () => {
    assert.throws(
      () => readManifest("a", "packages/a/package.json", "{"),
      /a\/package.json is not JSON/,
    );
    assert.throws(() => readManifest("a", "m", '{"version":"1.0.0"}'), /m has no name/);
    assert.throws(() => readManifest("a", "m", '{"name":"","version":"1.0.0"}'), /m has no name/);
    assert.throws(() => readManifest("a", "m", '{"name":"a"}'), /m has no version/);
    assert.throws(() => readManifest("a", "m", "null"), /m has no name/);
  });

  it("reads the message of a thrown value", () => {
    assert.equal(errorMessage(new Error("boom")), "boom");
    assert.equal(errorMessage("plain"), "plain");
  });

  it("puts the core first, then the others by name", () => {
    const ordered = releaseOrder([
      published("@explorer-verify/hardhat"),
      published(CORE),
      published("@explorer-verify/cli"),
    ]);
    assert.deepEqual(
      ordered.map((item) => item.name),
      [CORE, "@explorer-verify/cli", "@explorer-verify/hardhat"],
    );
    assert.deepEqual(
      releaseOrder([published("a"), published("b")]).map((item) => item.name),
      ["a", "b"],
    );
    assert.deepEqual(
      releaseOrder([published("b"), published("a"), published(CORE)]).map((item) => item.name),
      [CORE, "a", "b"],
    );
  });

  it("lists the published packages at a commit and skips a folder without a manifest", () => {
    const packages = releasePackagesAt(
      "v0.1.0",
      stubGit({
        cli: manifest("@explorer-verify/cli", "0.1.0"),
        "explorer-verify": manifest(CORE, "0.1.0"),
        foundry: manifest("@explorer-verify/foundry", "0.1.0", true),
      }),
    );
    assert.deepEqual(
      packages.map((entry) => `${entry.directory}:${entry.name}`),
      ["explorer-verify:explorer-verify", "cli:@explorer-verify/cli"],
    );
    assert.deepEqual(releasePackagesAt("HEAD", gaps), []);
  });

  it("fails when packages/ cannot be listed at the commit", () => {
    assert.throws(
      () => releasePackagesAt("nope", stubGit({}, false)),
      /cannot list packages\/ at nope/,
    );
  });

  it("prints names or directories, and refuses both flags or an empty list", () => {
    const git = stubGit({
      cli: manifest("@explorer-verify/cli", "0.1.0"),
      "explorer-verify": manifest(CORE, "0.1.0"),
    });
    assert.equal(run([], git), "explorer-verify\n@explorer-verify/cli\n");
    assert.equal(run(["--names"], git), "explorer-verify\n@explorer-verify/cli\n");
    assert.equal(run(["--directories", "--commit", "v0.1.0"], git), "explorer-verify\ncli\n");
    assert.throws(() => run(["--names", "--directories"], git), /one of --names/);
    const none = stubGit({ "explorer-verify": manifest(CORE, "0.0.0", true) });
    assert.throws(() => run([], none), /no package is published at HEAD.*removes "private": true/);
  });

  it("says with --any whether a package is published, for the release pull request", () => {
    const one = stubGit({
      cli: manifest("@explorer-verify/cli", "0.1.0", true),
      "explorer-verify": manifest(CORE, "0.1.0"),
    });
    assert.equal(run(["--any"], one), "true\n");
    const none = stubGit({
      cli: manifest("@explorer-verify/cli", "0.0.0", true),
      "explorer-verify": manifest(CORE, "0.0.0", true),
    });
    assert.equal(run(["--any"], none), "false\n");
    assert.equal(run(["--any", "--commit", "v0.1.0"], stubGit({})), "false\n");
    assert.throws(() => run(["--any", "--names"], one), /one of --names, --directories or --any/);
    assert.throws(() => run(["--any", "--directories"], one), /one of --names/);
  });

  describe("against a git repository", () => {
    let root = "";
    let first = "";
    before(() => {
      root = makeRepo("release-packages-", {
        "packages/explorer-verify/package.json": manifest(CORE, "0.0.0", true),
      });
      first = commit(root, {}, "private core");
      commit(
        root,
        {
          "packages/explorer-verify/package.json": manifest(CORE, "0.1.0"),
          "packages/cli/package.json": manifest("@explorer-verify/cli", "0.1.0"),
        },
        "publish",
      );
    });
    after(() => remove(root));

    it("reads the manifests at the commit it is given", () => {
      const git = gitIn(root);
      assert.deepEqual(
        releasePackagesAt("HEAD", git).map((entry) => entry.name),
        [CORE, "@explorer-verify/cli"],
      );
      assert.deepEqual(releasePackagesAt(first, git), []);
    });

    it("runs from the command line", () => {
      const passed = runScript(SCRIPT, ["--directories"], root, gitEnv());
      assert.equal(passed.status, 0);
      assert.equal(passed.stdout, "explorer-verify\ncli\n");
      const failed = runScript(SCRIPT, ["--commit", first], root, gitEnv());
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /no package is published/);
    });

    it("prints false with --any at a commit where every package is private", () => {
      const now = runScript(SCRIPT, ["--any"], root, gitEnv());
      assert.equal(now.status, 0);
      assert.equal(now.stdout, "true\n");
      const earlier = runScript(SCRIPT, ["--any", "--commit", first], root, gitEnv());
      assert.equal(earlier.status, 0);
      assert.equal(earlier.stdout, "false\n");
      assert.equal(earlier.stderr, "");
    });

    it("throws when git cannot start", () => {
      assert.throws(() => gitIn(path.join(root, "missing"))(["status"]), /cannot run git/);
    });
  });
});
