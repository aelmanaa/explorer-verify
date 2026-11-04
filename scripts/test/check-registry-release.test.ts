import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkPackage,
  checkProvenance,
  checkRegistryRelease,
  compareVersions,
  fetchAttestations,
  main,
  npmView,
  REPOSITORY,
  type View,
} from "../check-registry-release.ts";
import { gitEnv, makeRepo, manifest, remove, runScript, writeFiles } from "./git-repo.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "check-registry-release.ts");
/**
 * The SLSA statement npm served for hardhat-kms@0.10.1 on 2026-11-03, a package published by a
 * release.yml of the same shape; only the Sigstore bundle around the payload is left out.
 */
const RECORDED = path.join(HERE, "fixtures", "attestations-hardhat-kms-0.10.1.json");
const RECORDED_COMMIT = "90d1b969480923ab6474fdde4fcf213689d27996";
const COMMIT = "c".repeat(40);
const URL_A = "https://registry.npmjs.org/-/npm/v1/attestations/a@0.2.0";
const PROVENANCE = { url: URL_A, provenance: { predicateType: "https://slsa.dev/provenance/v1" } };

/** What `npm view name@version --json` prints for a published version. */
function viewJson(version: string, tags: Record<string, string>, extra: object = {}): string {
  return JSON.stringify({
    version,
    "dist-tags": tags,
    gitHead: COMMIT,
    dist: { attestations: PROVENANCE },
    ...extra,
  });
}

/** A view stub that answers every spec with the same output. */
function stub(stdout: string, status = 0): View {
  return () => ({ status, stdout });
}

/** An attestations document whose SLSA statement names a release of this repository. */
function attestations(name: string, version: string, commit: string, statement: object = {}) {
  const payload = {
    subject: [{ name: `pkg:npm/${name.replace(/^@/, "%40")}@${version}` }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: `refs/tags/v${version}`,
            repository: `https://github.com/${REPOSITORY}`,
            path: ".github/workflows/release.yml",
          },
        },
        resolvedDependencies: [{ digest: { gitCommit: commit } }],
      },
    },
    ...statement,
  };
  return {
    attestations: [
      { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1" },
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: { payload: Buffer.from(JSON.stringify(payload)).toString("base64") },
        },
      },
    ],
  };
}

/** A `data:` URL that `fetch` answers with the document, so no test reaches the network. */
function dataUrl(document: object): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(document)).toString("base64")}`;
}

/** checkPackage on a version whose dist-tags are `tags`. */
function checkTags(tags: Record<string, string>, version = "0.2.0") {
  return checkPackage("a", version, COMMIT, stub(viewJson(version, tags)));
}

/** checkPackage on 0.2.0 on beta, with `extra` fields in the npm view output. */
function checkExtra(extra: object, tags: Record<string, string> = { beta: "0.2.0" }) {
  return checkPackage("a", "0.2.0", COMMIT, stub(viewJson("0.2.0", tags, extra)));
}

/** Attestations for a@0.2.0 whose statement names `workflow`. */
function withWorkflow(workflow: object) {
  return attestations("a", "0.2.0", COMMIT, {
    predicate: {
      buildDefinition: {
        externalParameters: { workflow },
        resolvedDependencies: [{ digest: { gitCommit: COMMIT } }],
      },
    },
  });
}

/** `npm view` output for a package at 0.2.0 whose attestation URL serves `document`. */
function published(latest: string, document: object): string {
  return viewJson(
    "0.2.0",
    { beta: "0.2.0", latest },
    {
      gitHead: "HEAD",
      dist: { attestations: { url: dataUrl(document), provenance: {} } },
    },
  );
}

/** npm view for the command-line test: the CLI is already latest, the core is not. */
const cliView: View = (spec) => {
  const name = spec.slice(0, spec.lastIndexOf("@"));
  const latest = name.startsWith("@") ? "0.2.0" : "0.1.0";
  return { status: 0, stdout: published(latest, attestations(name, "0.2.0", "HEAD")) };
};

describe("registry check before the promote (R-SEC-4)", () => {
  it("compares versions by X.Y.Z, a prerelease below its release", () => {
    assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
    assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
    assert.ok(compareVersions("0.1.0", "1.0.0") < 0);
    assert.ok(compareVersions("0.1.1", "0.1.0") > 0);
    assert.ok(compareVersions("0.1.0-beta.1", "0.1.0") < 0);
    assert.ok(compareVersions("0.1.0", "0.1.0-beta.1") > 0);
    assert.equal(compareVersions("0.1.0-a", "0.1.0-a"), 0);
    assert.throws(() => compareVersions("latest", "0.1.0"), /cannot compare latest with 0\.1\.0/);
  });

  it("passes a version on beta with gitHead and provenance, and says when it is latest", () => {
    assert.deepEqual(checkTags({ beta: "0.2.0", latest: "0.1.0" }), {
      name: "a",
      alreadyLatest: false,
      attestationsUrl: URL_A,
    });
    assert.equal(checkTags({ beta: "0.2.0", latest: "0.2.0" }).alreadyLatest, true);
    assert.equal(checkTags({ beta: "0.1.0" }, "0.1.0").alreadyLatest, false);
  });

  it("refuses a version that is not on npm", () => {
    const missing = JSON.stringify({ error: { code: "E404" } });
    assert.throws(
      () => checkPackage("a", "0.2.0", COMMIT, stub(missing, 1)),
      /a@0\.2\.0 is not on npm/,
    );
    assert.throws(() => checkPackage("a", "0.2.0", COMMIT, stub("", 0)), /a@0\.2\.0 is not on npm/);
    assert.throws(
      () => checkPackage("a", "0.2.0", COMMIT, stub(viewJson("0.1.0", { beta: "0.2.0" }))),
      /is not on npm/,
    );
  });

  it("refuses a version beta does not point at", () => {
    assert.throws(
      () => checkPackage("a", "0.2.0", COMMIT, stub(viewJson("0.2.0", { beta: "0.3.0" }))),
      /the beta dist-tag of a is "0\.3\.0", not 0\.2\.0/,
    );
  });

  it("refuses another gitHead, a missing provenance and a latest above the version", () => {
    assert.throws(
      () => checkExtra({ gitHead: "d" }),
      /has gitHead "d", but tag v0\.2\.0 points at c{40}/,
    );
    assert.throws(
      () => checkExtra({ dist: {} }),
      /a@0\.2\.0 has no provenance attestation \(R-SEC-4\)/,
    );
    assert.throws(
      () => checkExtra({ dist: { attestations: { provenance: {} } } }),
      /has no provenance attestation/,
    );
    assert.throws(
      () => checkExtra({}, { beta: "0.2.0", latest: "0.3.0" }),
      /latest of a is 0\.3\.0, above 0\.2\.0/,
    );
  });

  it("checks every package, and refuses a prerelease or an empty list", () => {
    const view = stub(viewJson("0.2.0", { beta: "0.2.0" }));
    assert.equal(checkRegistryRelease(["a", "b"], "0.2.0", COMMIT, view).length, 2);
    assert.throws(
      () => checkRegistryRelease(["a"], "0.2.0-beta.1", COMMIT, view),
      /not a plain X\.Y\.Z/,
    );
    assert.throws(() => checkRegistryRelease([], "0.2.0", COMMIT, view), /no package is published/);
  });

  describe("provenance statement", () => {
    const expected = { name: "a", version: "0.2.0", commit: COMMIT, repository: REPOSITORY };

    it("reads a recorded npm attestation", () => {
      const recorded: unknown = JSON.parse(readFileSync(RECORDED, "utf8"));
      checkProvenance(recorded, {
        name: "hardhat-kms",
        version: "0.10.1",
        commit: RECORDED_COMMIT,
        repository: "aelmanaa/hardhat-kms",
      });
      assert.throws(
        () => checkProvenance(recorded, { ...expected, name: "hardhat-kms", version: "0.10.1" }),
        /names repository "https:\/\/github\.com\/aelmanaa\/hardhat-kms", expected https:\/\/github\.com\/aelmanaa\/explorer-verify/,
      );
    });

    it("passes a statement that names this package, repository, workflow, tag and commit", () => {
      checkProvenance(attestations("a", "0.2.0", COMMIT), expected);
      checkProvenance(attestations("@explorer-verify/cli", "0.2.0", COMMIT), {
        ...expected,
        name: "@explorer-verify/cli",
      });
    });

    it("refuses a statement that names anything else", () => {
      const refusals: [object, RegExp][] = [
        [attestations("b", "0.2.0", COMMIT), /names subject "pkg:npm\/b@0\.2\.0"/],
        [attestations("a", "0.2.0", "d".repeat(40)), /names commit "d{40}", expected c{40}/],
        [attestations("a", "0.2.0", COMMIT, { subject: "x" }), /names subject undefined/],
        [attestations("a", "0.2.0", COMMIT, { predicate: {} }), /names repository undefined/],
      ];
      for (const [document, reason] of refusals) {
        assert.throws(() => checkProvenance(document, expected), reason);
      }
    });

    it("refuses a statement from another workflow or ref", () => {
      const base = {
        ref: "refs/tags/v0.2.0",
        repository: `https://github.com/${REPOSITORY}`,
        path: ".github/workflows/release.yml",
      };
      assert.throws(
        () =>
          checkProvenance(withWorkflow({ ...base, path: ".github/workflows/ci.yml" }), expected),
        /names workflow "\.github\/workflows\/ci\.yml"/,
      );
      assert.throws(
        () => checkProvenance(withWorkflow({ ...base, ref: "refs/heads/main" }), expected),
        /names ref "refs\/heads\/main", expected refs\/tags\/v0\.2\.0/,
      );
    });

    it("refuses a document without a SLSA statement, or one that is not JSON", () => {
      for (const document of [null, {}, { attestations: {} }, { attestations: [{}] }]) {
        assert.throws(
          () => checkProvenance(document, expected),
          /a@0\.2\.0 has no SLSA provenance attestation/,
        );
      }
      const garbled = {
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: { dsseEnvelope: { payload: Buffer.from("not json").toString("base64") } },
          },
        ],
      };
      assert.throws(() => checkProvenance(garbled, expected), /statement of a@0\.2\.0 is not JSON/);
    });

    it("fetches an attestations document and refuses a failed answer", async () => {
      assert.deepEqual(await fetchAttestations(dataUrl({ attestations: [] })), {
        attestations: [],
      });
      const server = await import("node:http").then(({ createServer }) =>
        createServer((_request, response) => {
          response.statusCode = 404;
          response.end("{}");
        }),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      try {
        await assert.rejects(fetchAttestations(`http://127.0.0.1:${port}/a`), /answered 404/);
      } finally {
        server.close();
      }
    });
  });

  describe("from the command line", () => {
    let root = "";
    let bin = "";
    before(() => {
      root = makeRepo("check-registry-", {
        "packages/explorer-verify/package.json": manifest("explorer-verify", "0.2.0"),
        "packages/cli/package.json": manifest("@explorer-verify/cli", "0.2.0"),
      });
      // A fake npm that prints $FAKE_NPM_DIR/<spec>.json, with / and @ in the spec as _.
      bin = mkdtempSync(path.join(tmpdir(), "fake-npm-"));
      writeFiles(bin, {
        npm: '#!/bin/sh\ncat "$FAKE_NPM_DIR/$(printf %s "$2" | tr "/@" "__").json"\n',
      });
      chmodSync(path.join(bin, "npm"), 0o755);
    });
    after(() => {
      remove(root);
      remove(bin);
    });

    it("reads the packages at the commit, checks provenance and writes the moves", async () => {
      const output = path.join(root, "out");
      const lines = await main(
        ["--version", "0.2.0", "--commit", "HEAD", "--output", output],
        root,
        cliView,
        fetchAttestations,
      );
      assert.deepEqual(lines, [
        "ok   explorer-verify@0.2.0: on beta, gitHead HEAD, provenance from aelmanaa/explorer-verify .github/workflows/release.yml",
        "ok   @explorer-verify/cli@0.2.0: on beta, gitHead HEAD, provenance from aelmanaa/explorer-verify .github/workflows/release.yml, already latest",
      ]);
      assert.equal(readFileSync(output, "utf8"), "move=explorer-verify\n");
      await assert.rejects(
        main(
          ["--version", "0.2.0", "--commit", "HEAD", "--repository", "someone/else"],
          root,
          cliView,
          fetchAttestations,
        ),
        /names repository "https:\/\/github\.com\/aelmanaa\/explorer-verify", expected https:\/\/github\.com\/someone\/else/,
      );
      await assert.rejects(
        main(["--version", "0.2.0"], root, stub(""), fetchAttestations),
        /usage: node scripts\/check-registry-release\.ts/,
      );
    });

    it("runs npm view and prints the result or the failure", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "fake-npm-views-"));
      const write = (name: string, text: string) =>
        writeFileSync(path.join(dir, `${name.replaceAll(/[/@]/g, "_")}_0.2.0.json`), text);
      try {
        for (const name of ["explorer-verify", "@explorer-verify/cli"]) {
          write(name, published("0.1.0", attestations(name, "0.2.0", "HEAD")));
        }
        // The fake npm first; git, sh and tr from the system folders.
        const env = gitEnv({ PATH: `${bin}:/usr/bin:/bin`, FAKE_NPM_DIR: dir });
        const args = ["--version", "0.2.0", "--commit", "HEAD"];
        const passed = runScript(SCRIPT, args, root, env);
        assert.equal(passed.status, 0, passed.stderr);
        assert.match(passed.stdout, /ok {3}explorer-verify@0\.2\.0/);
        write("explorer-verify", viewJson("0.2.0", { beta: "0.1.0" }));
        const failed = runScript(SCRIPT, args, root, env);
        assert.equal(failed.status, 1);
        assert.match(failed.stderr, /^FAIL the beta dist-tag of explorer-verify is "0\.1\.0"/);
      } finally {
        remove(dir);
      }
    });

    it("throws when npm cannot start", () => {
      assert.throws(() => npmView("a@1.0.0", { PATH: path.join(bin, "empty") }), /cannot run npm/);
    });
  });
});
