import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkManifest,
  checkTarballs,
  localRanges,
  main,
  manifestName,
  parseSums,
} from "../check-tarballs.ts";
import { commit, gitEnv, makeRepo, manifest, remove, runScript } from "./git-repo.ts";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "check-tarballs.ts");
const COMMIT = "a".repeat(40);
const SUM = "0".repeat(64);
const NAMES = ["explorer-verify", "@explorer-verify/cli"];

/** Packs a tarball with one package/package.json and returns its `sha256sum` line. */
function pack(directory: string, file: string, fields: Record<string, string>): string {
  const staging = mkdtempSync(path.join(tmpdir(), "tarball-"));
  mkdirSync(path.join(staging, "package"));
  writeFileSync(path.join(staging, "package", "package.json"), JSON.stringify(fields));
  execFileSync("tar", ["-czf", path.join(directory, file), "-C", staging, "package"]);
  rmSync(staging, { recursive: true, force: true });
  const sum = createHash("sha256")
    .update(readFileSync(path.join(directory, file)))
    .digest("hex");
  return `${sum}  ${file}`;
}

describe("release tarballs (R-SEC-4)", () => {
  let directory = "";
  let sums = "";
  before(() => {
    directory = mkdtempSync(path.join(tmpdir(), "check-tarballs-"));
    sums = [
      pack(directory, "explorer-verify-0.1.0.tgz", {
        name: "explorer-verify",
        version: "0.1.0",
        gitHead: COMMIT,
      }),
      pack(directory, "explorer-verify-cli-0.1.0.tgz", {
        name: "@explorer-verify/cli",
        version: "0.1.0",
        gitHead: COMMIT,
      }),
    ].join("\n");
  });
  after(() => remove(directory));

  it("parses a sha256sum listing of the expected length", () => {
    assert.deepEqual(parseSums(`${SUM}  a-1.0.0.tgz\n`, 1), [{ sha256: SUM, file: "a-1.0.0.tgz" }]);
    assert.throws(() => parseSums(`${SUM} a.tgz`, 1), /sums line 1 is not/);
    assert.throws(() => parseSums(`${SUM}  ../a.tgz`, 1), /sums line 1 is not/);
    assert.throws(
      () => parseSums(`${SUM}  a.tgz`, 2),
      /the sums list 1 tarballs; this release publishes 2/,
    );
  });

  it("checks the name, version and gitHead of a manifest", () => {
    const expected = { name: "a", version: "1.0.0", commit: COMMIT };
    checkManifest(
      "a.tgz",
      JSON.stringify({ name: "a", version: "1.0.0", gitHead: COMMIT }),
      expected,
    );
    assert.throws(
      () => checkManifest("a.tgz", JSON.stringify({ name: "a", version: "1.0.0" }), expected),
      /a\.tgz: gitHead is undefined, expected a{40}/,
    );
    assert.throws(() => checkManifest("a.tgz", "null", expected), /a\.tgz: name is undefined/);
    assert.equal(manifestName('{"name":"a"}'), "a");
    assert.equal(manifestName("{}"), "");
  });

  it("refuses a manifest that keeps a workspace: or catalog: range", () => {
    const expected = { name: "a", version: "1.0.0", commit: COMMIT };
    const packed = (fields: object) =>
      JSON.stringify({ name: "a", version: "1.0.0", gitHead: COMMIT, ...fields });
    checkManifest(
      "a.tgz",
      packed({ peerDependencies: { "explorer-verify": "^1.0.0" }, dependencies: [], bin: "x" }),
      expected,
    );
    assert.throws(
      () =>
        checkManifest(
          "a.tgz",
          packed({
            peerDependencies: { "explorer-verify": "workspace:^" },
            devDependencies: { c8: "catalog:", other: 1 },
            optionalDependencies: null,
          }),
          expected,
        ),
      /a\.tgz: devDependencies\.c8, peerDependencies\.explorer-verify still use a workspace: or catalog: range/,
    );
    assert.deepEqual(localRanges(null), []);
  });

  it("passes tarballs that match their sums and the release", () => {
    const lines = checkTarballs(directory, sums, NAMES, "0.1.0", COMMIT);
    assert.equal(lines.length, 2);
    assert.match(
      lines[0] ?? "",
      /^ok {3}explorer-verify@0\.1\.0 gitHead a{40} explorer-verify-0\.1\.0\.tgz/,
    );
  });

  it("refuses a version that is not a plain X.Y.Z", () => {
    assert.throws(
      () => checkTarballs(directory, sums, NAMES, "0.1.0-beta.1", COMMIT),
      /not a plain X\.Y\.Z/,
    );
  });

  it("refuses a tarball the sums do not list", () => {
    const first = sums.split("\n")[0] ?? "";
    assert.throws(
      () => checkTarballs(directory, first, ["explorer-verify"], "0.1.0", COMMIT),
      /holds tarballs the sums do not list: explorer-verify-cli-0\.1\.0\.tgz/,
    );
  });

  it("refuses a listed tarball that is missing or changed", () => {
    const missing = `${sums}\n${SUM}  gone-0.1.0.tgz`;
    assert.throws(
      () => checkTarballs(directory, missing, [...NAMES, "gone"], "0.1.0", COMMIT),
      /gone-0\.1\.0\.tgz is listed in the sums but missing/,
    );
    const changed = sums.replace(/^[0-9a-f]{64}/, SUM);
    assert.throws(
      () => checkTarballs(directory, changed, NAMES, "0.1.0", COMMIT),
      /explorer-verify-0\.1\.0\.tgz: SHA-256 is [0-9a-f]{64}, the pack job recorded 0{64}/,
    );
  });

  it("refuses tarballs in another order, at another version or from another commit", () => {
    assert.throws(
      () => checkTarballs(directory, sums, NAMES.toReversed(), "0.1.0", COMMIT),
      /the tarballs hold explorer-verify, @explorer-verify\/cli; this release publishes @explorer-verify\/cli, explorer-verify, in that order/,
    );
    assert.throws(
      () => checkTarballs(directory, sums, NAMES, "0.2.0", COMMIT),
      /version is "0\.1\.0", expected 0\.2\.0/,
    );
    assert.throws(
      () => checkTarballs(directory, sums, NAMES, "0.1.0", "b".repeat(40)),
      /gitHead is "a{40}", expected b{40}/,
    );
  });

  describe("from the command line", () => {
    let root = "";
    let sumsFile = "";
    before(() => {
      root = makeRepo("check-tarballs-repo-", {
        "packages/explorer-verify/package.json": manifest("explorer-verify", "0.1.0"),
        "packages/cli/package.json": manifest("@explorer-verify/cli", "0.1.0"),
      });
      commit(root, {}, "second");
      sumsFile = path.join(root, "SHA256SUMS");
      writeFileSync(sumsFile, sums);
    });
    after(() => remove(root));

    it("reads the packages at HEAD", () => {
      const args = [
        "--dir",
        directory,
        "--sums",
        sumsFile,
        "--version",
        "0.1.0",
        "--commit",
        COMMIT,
      ];
      assert.equal(main(args, root).length, 2);
      const passed = runScript(SCRIPT, args, root, gitEnv());
      assert.equal(passed.status, 0, passed.stderr);
      assert.match(passed.stdout, /^ok {3}explorer-verify@0\.1\.0/);
    });

    it("prints the failure and the usage", () => {
      const failed = runScript(SCRIPT, ["--dir", directory], root, gitEnv());
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /^FAIL usage: node scripts\/check-tarballs\.ts/);
    });
  });
});
