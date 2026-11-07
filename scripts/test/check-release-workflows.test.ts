import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  main,
  PASSED,
  readWorkflow,
  WORKFLOWS,
  type WorkflowTexts,
  workflowProblems,
} from "../check-release-workflows.ts";
import { remove, runScript, writeFiles } from "./git-repo.ts";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(SCRIPTS, "..");

const REPOSITORY: WorkflowTexts = {
  promote: readFileSync(path.join(ROOT, WORKFLOWS.promote), "utf8"),
  release: readFileSync(path.join(ROOT, WORKFLOWS.release), "utf8"),
  docs: readFileSync(path.join(ROOT, WORKFLOWS.docs), "utf8"),
  releasePr: readFileSync(path.join(ROOT, WORKFLOWS.releasePr), "utf8"),
};

const RELEASE_PR = `on: push
permissions: {}
jobs:
  packages:
    outputs:
      any: \${{ steps.list.outputs.any }}
    steps:
      - id: list
        run: echo "any=$(node scripts/release-packages.ts --any)" >> "$GITHUB_OUTPUT"
  version-pr:
    needs: packages
    if: needs.packages.outputs.any == 'true'
    steps:
      - uses: changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51
        with:
          github-token: \${{ secrets.RELEASE_PR_TOKEN }}
`;

const ungated = (job: string): string =>
  `${WORKFLOWS.releasePr}: job ${job} runs changesets/action without needing a job that runs scripts/release-packages.ts --any and having if: needs.<that job>.outputs.any == 'true' (decision 0017)`;

const DOCS = `on:
  workflow_dispatch:
  workflow_call:
jobs:
  build:
    runs-on: x
  deploy:
    needs: build
    environment:
      name: github-pages
  smoke:
    needs: [deploy]
`;

const RELEASE = `on: push
permissions: {}
jobs:
  publish:
    environment: npm-publish
    permissions:
      id-token: write
  publish-dry-run:
    steps:
      - run: npm publish --dry-run x.tgz
`;

/** A promote workflow with the docs call, and a latest job built from the arguments. */
function promote(latest: string, docs = "    uses: ./.github/workflows/docs.yml\n"): string {
  return `on: workflow_dispatch
permissions: {}
jobs:
  verify:
    runs-on: x
  docs:
    needs: verify
    permissions:
      pages: write
      id-token: write
${docs}    with:
      version: \${{ inputs.version }}
  latest:
${latest}`;
}

const LATEST = `    needs: [verify, docs]
    environment: npm-latest
    permissions:
      id-token: write
    steps:
      - run: npm dist-tag add x@1.0.0 latest
`;

const top = (file: string): string =>
  `${file}: must set permissions: {} at the top, so each job grants only its own (R-SEC-4)`;

const pages = (file: string, job: string): string =>
  `${file}: job ${job} can deploy to GitHub Pages; only docs.yml, called by the docs job of ${WORKFLOWS.promote}, may (decision 0015)`;

const bypass = (job: string, where: string): string =>
  `${WORKFLOWS.docs}: job ${job}: ${where}, which can let the workflow pass without the deploy or the smoke check (decision 0015)`;

function problems(texts: Partial<WorkflowTexts>): string[] {
  return workflowProblems({
    promote: promote(LATEST),
    release: RELEASE,
    docs: DOCS,
    releasePr: RELEASE_PR,
    ...texts,
  });
}

describe("release workflow order (R-AX-10, R-SEC-4, decision 0015)", () => {
  it("passes on the repository's workflows", () => {
    assert.deepEqual(workflowProblems(REPOSITORY), []);
  });

  it("passes on a minimal set that keeps the order", () => {
    assert.deepEqual(problems({}), []);
  });

  it("reads needs written as one name, a list or a flow sequence", () => {
    const { jobs } = readWorkflow(
      "w.yml",
      "jobs:\n  a:\n    needs: x\n  b:\n    needs:\n      - x\n      - y\n  c: {}\n",
    );
    assert.deepEqual(
      jobs.map((job) => job.needs),
      [["x"], ["x", "y"], []],
    );
  });

  it("refuses a latest job that does not need docs (R-AX-10)", () => {
    for (const needs of ["    needs: verify\n", "    needs: [verify]\n", ""]) {
      const latest = LATEST.replace("    needs: [verify, docs]\n", needs);
      assert.deepEqual(problems({ promote: promote(latest) }), [
        `${WORKFLOWS.promote}: job latest moves latest but does not list docs in needs (R-AX-10, decision 0015)`,
      ]);
    }
  });

  it("finds a job that moves latest by its OIDC token or by npm dist-tag", () => {
    const tokenOnly = LATEST.replace(
      "      - run: npm dist-tag add x@1.0.0 latest\n",
      "      - run: echo\n",
    ).replace("    needs: [verify, docs]\n", "    needs: verify\n");
    assert.match(problems({ promote: promote(tokenOnly) }).join("\n"), /job latest moves latest/);
    const commandOnly = LATEST.replace("      id-token: write\n", "      contents: read\n").replace(
      "    needs: [verify, docs]\n",
      "",
    );
    assert.match(problems({ promote: promote(commandOnly) }).join("\n"), /job latest moves latest/);
  });

  it("refuses an if that lets latest run after a failed docs job", () => {
    for (const condition of ["always()", "${{ failure() }}", "${{ !cancelled() }}"]) {
      const latest = `    if: ${condition}\n${LATEST}`;
      assert.deepEqual(problems({ promote: promote(latest) }), [
        `${WORKFLOWS.promote}: job latest has if: ${condition}, which lets it run after a failed docs job`,
      ]);
    }
    assert.deepEqual(problems({ promote: promote(`    if: success()\n${LATEST}`) }), []);
  });

  it("refuses a latest job outside the npm-latest environment (R-SEC-4)", () => {
    for (const environment of ["", "    environment:\n      name: other\n"]) {
      const latest = LATEST.replace("    environment: npm-latest\n", environment);
      assert.deepEqual(problems({ promote: promote(latest) }), [
        `${WORKFLOWS.promote}: job latest moves latest outside the npm-latest environment (R-SEC-4)`,
      ]);
    }
    const named = LATEST.replace(
      "    environment: npm-latest\n",
      "    environment:\n      name: npm-latest\n",
    );
    assert.deepEqual(problems({ promote: promote(named) }), []);
  });

  it("refuses a promote without a job that moves latest", () => {
    assert.deepEqual(problems({ promote: promote("    steps:\n      - run: echo\n") }), [
      `${WORKFLOWS.promote}: no job moves latest; expected one that runs npm dist-tag`,
    ]);
  });

  it("refuses a docs job that does not call docs.yml with the version", () => {
    const local = promote(LATEST, "    runs-on: x\n    steps:\n      - run: exit 1\n");
    assert.deepEqual(problems({ promote: local }), [
      `${WORKFLOWS.promote}: job docs must call ./.github/workflows/docs.yml (decision 0015)`,
    ]);
    const other = promote(LATEST).replace("${{ inputs.version }}", "0.1.0");
    assert.deepEqual(problems({ promote: other }), [
      `${WORKFLOWS.promote}: job docs must pass version: \${{ inputs.version }}`,
    ]);
    const missing = promote(LATEST).replace("  docs:\n", "  site:\n");
    assert.deepEqual(problems({ promote: missing }), [
      `${WORKFLOWS.promote}: has no docs job; the promote must deploy the docs (R-AX-17)`,
      `${WORKFLOWS.promote}: job site deploys the docs; only the promote does (decision 0015)`,
      // Under another name the call holds an OIDC token, so it counts as a job that moves latest.
      `${WORKFLOWS.promote}: job site moves latest but does not list docs in needs (R-AX-10, decision 0015)`,
      `${WORKFLOWS.promote}: job site moves latest outside the npm-latest environment (R-SEC-4)`,
    ]);
  });

  it("refuses an OIDC token outside npm-publish, and a docs deploy, in release.yml", () => {
    const release = `${RELEASE}  rogue:
    permissions:
      id-token: write
  docs:
    uses: ./.github/workflows/docs.yml
`;
    assert.deepEqual(problems({ release }), [
      `${WORKFLOWS.release}: job rogue takes an OIDC token outside the npm-publish environment (R-SEC-4)`,
      `${WORKFLOWS.release}: job docs deploys the docs; only the promote does (decision 0015)`,
    ]);
  });

  it("requires permissions: {} at the top of promote.yml and release.yml (R-SEC-4)", () => {
    for (const permissions of [
      "",
      "permissions: write-all\n",
      "permissions:\n  id-token: write\n",
    ]) {
      assert.deepEqual(
        problems({
          promote: promote(LATEST).replace("permissions: {}\n", permissions),
          release: RELEASE.replace("permissions: {}\n", permissions),
        }),
        [top(WORKFLOWS.promote), top(WORKFLOWS.release)],
      );
    }
    assert.deepEqual(
      problems({ release: RELEASE.replace("permissions: {}\n", "permissions: []\n") }),
      [top(WORKFLOWS.release)],
    );
  });

  it("counts permissions: write-all as an OIDC token and pages: write", () => {
    const latest = LATEST.replace(
      "    permissions:\n      id-token: write\n",
      "    permissions: write-all\n",
    )
      .replace("      - run: npm dist-tag add x@1.0.0 latest\n", "      - run: echo\n")
      .replace("    needs: [verify, docs]\n", "    needs: verify\n");
    assert.deepEqual(problems({ promote: promote(latest) }), [
      `${WORKFLOWS.promote}: job latest can deploy to GitHub Pages; only docs.yml, called by the docs job of ${WORKFLOWS.promote}, may (decision 0015)`,
      `${WORKFLOWS.promote}: job latest moves latest but does not list docs in needs (R-AX-10, decision 0015)`,
    ]);
    const release = `${RELEASE}  rogue:\n    permissions: write-all\n`;
    assert.deepEqual(problems({ release }), [
      `${WORKFLOWS.release}: job rogue takes an OIDC token outside the npm-publish environment (R-SEC-4)`,
      `${WORKFLOWS.release}: job rogue can deploy to GitHub Pages; only docs.yml, called by the docs job of ${WORKFLOWS.promote}, may (decision 0015)`,
    ]);
  });

  it("refuses a Pages deploy outside the docs job (decision 0015)", () => {
    const withPages = `${RELEASE}  site:\n    permissions:\n      pages: write\n`;
    assert.deepEqual(problems({ release: withPages }), [pages(WORKFLOWS.release, "site")]);
    for (const action of [
      "actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346",
      "actions/deploy-pages",
    ]) {
      const withAction = `${RELEASE}  site:\n    steps:\n      - uses: ${action}\n`;
      assert.deepEqual(problems({ release: withAction }), [pages(WORKFLOWS.release, "site")]);
    }
    const other = `${RELEASE}  site:\n    steps:\n      - uses: actions/deploy-pages-extra@v1\n`;
    assert.deepEqual(problems({ release: other }), []);
    const verify = promote(LATEST).replace(
      "  verify:\n    runs-on: x\n",
      "  verify:\n    runs-on: x\n    steps:\n      - uses: actions/deploy-pages@v5\n",
    );
    assert.deepEqual(problems({ promote: verify }), [pages(WORKFLOWS.promote, "verify")]);
  });

  it("refuses if and continue-on-error in docs.yml, on jobs and on steps", () => {
    assert.deepEqual(
      problems({
        docs: DOCS.replace("    needs: [deploy]\n", "    needs: [deploy]\n    if: false\n"),
      }),
      [bypass("smoke", "job has if")],
    );
    const steps = DOCS.replace(
      "      name: github-pages\n",
      "      name: github-pages\n    continue-on-error: false\n    steps:\n      - run: a\n      - uses: actions/deploy-pages@v5\n        continue-on-error: true\n      - run: b\n        if: github.ref == 'refs/heads/main'\n        continue-on-error: true\n",
    );
    assert.deepEqual(problems({ docs: steps }), [
      bypass("deploy", "job has continue-on-error"),
      bypass("deploy", "step 2 has continue-on-error"),
      bypass("deploy", "step 3 has if"),
      bypass("deploy", "step 3 has continue-on-error"),
    ]);
  });

  it("refuses docs.yml triggers other than a dispatch and a call", () => {
    assert.deepEqual(problems({ docs: DOCS.replace("  workflow_call:\n", "  push:\n") }), [
      `${WORKFLOWS.docs}: has no workflow_call trigger, so the promote cannot call it`,
      `${WORKFLOWS.docs}: starts on push; only workflow_dispatch and workflow_call may start it`,
    ]);
    const listed = DOCS.replace(
      "on:\n  workflow_dispatch:\n  workflow_call:\n",
      "on: [workflow_call, pull_request]\n",
    );
    assert.deepEqual(problems({ docs: listed }), [
      `${WORKFLOWS.docs}: starts on pull_request; only workflow_dispatch and workflow_call may start it`,
    ]);
    const single = DOCS.replace(
      "on:\n  workflow_dispatch:\n  workflow_call:\n",
      "on: workflow_call\n",
    );
    assert.deepEqual(problems({ docs: single }), []);
    const none = DOCS.replace("on:\n  workflow_dispatch:\n  workflow_call:\n", "");
    assert.deepEqual(problems({ docs: none }), [
      `${WORKFLOWS.docs}: has no workflow_call trigger, so the promote cannot call it`,
    ]);
  });

  it("refuses a docs.yml whose smoke job does not wait for the deploy", () => {
    assert.deepEqual(problems({ docs: DOCS.replace("    needs: [deploy]\n", "") }), [
      `${WORKFLOWS.docs}: job smoke must exist and list deploy in needs`,
    ]);
    assert.deepEqual(
      problems({ docs: DOCS.replace("  deploy:\n    needs: build\n", "  deploy:\n") }),
      [`${WORKFLOWS.docs}: job deploy must exist and list build in needs`],
    );
  });

  it("accepts the release pull request gate written with ${{ }} or another job name", () => {
    const wrapped = RELEASE_PR.replace(
      "    if: needs.packages.outputs.any == 'true'\n",
      "    if: ${{ needs.packages.outputs.any=='true' }}\n",
    );
    assert.deepEqual(problems({ releasePr: wrapped }), []);
    const renamed = RELEASE_PR.replaceAll("packages", "gate").replace(
      "scripts/release-gate.ts",
      "scripts/release-packages.ts",
    );
    assert.deepEqual(problems({ releasePr: renamed }), []);
  });

  it("refuses a Version Packages job that does not wait for a published package (decision 0017)", () => {
    const variants = [
      RELEASE_PR.replace("    if: needs.packages.outputs.any == 'true'\n", ""),
      RELEASE_PR.replace(
        "    if: needs.packages.outputs.any == 'true'\n",
        "    if: always() || needs.packages.outputs.any == 'true'\n",
      ),
      RELEASE_PR.replace("    if: needs.packages.outputs.any == 'true'\n", "    if: true\n"),
      RELEASE_PR.replace("    needs: packages\n", ""),
      RELEASE_PR.replace(" --any)", ")"),
      RELEASE_PR.replace("needs.packages.outputs.any", "needs.other.outputs.any"),
    ];
    for (const releasePr of variants) {
      assert.deepEqual(problems({ releasePr }), [ungated("version-pr")]);
    }
    const second = `${RELEASE_PR}  again:\n    steps:\n      - uses: changesets/action\n        with:\n          github-token: \${{ secrets.RELEASE_PR_TOKEN }}\n`;
    assert.deepEqual(problems({ releasePr: second }), [ungated("again")]);
  });

  it("requires a custom token that can start pull request checks", () => {
    const input = "          github-token: ${{ secrets.RELEASE_PR_TOKEN }}\n";
    const message = `${WORKFLOWS.releasePr}: job version-pr must pass a separate secret or App token as github-token; GITHUB_TOKEN does not start pull request checks`;
    for (const token of [
      "",
      "${{ github.token }}",
      "${{ secrets.GITHUB_TOKEN }}",
      "${{ secrets.RELEASE_PR_TOKEN || github.token }}",
      "literal-token",
    ]) {
      const changed = RELEASE_PR.replace(
        input,
        token === "" ? "" : `          github-token: ${token}\n`,
      );
      assert.deepEqual(problems({ releasePr: changed }), [message]);
    }
    assert.deepEqual(
      problems({
        releasePr: RELEASE_PR.replace(
          input,
          "          github-token: ${{ steps.release-app.outputs.token }}\n",
        ),
      }),
      [],
    );
  });

  it("rejects an environment token that conflicts with the action input", () => {
    const line = "      - uses: changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51\n";
    const conflicting = RELEASE_PR.replace(
      line,
      line + "        env:\n          GITHUB_TOKEN: ${{ github.token }}\n",
    );
    assert.deepEqual(problems({ releasePr: conflicting }), [
      `${WORKFLOWS.releasePr}: job version-pr gives changesets/action a conflicting GITHUB_TOKEN environment value`,
    ]);
    assert.deepEqual(
      problems({
        releasePr: conflicting.replace(
          "GITHUB_TOKEN: ${{ github.token }}",
          "GITHUB_TOKEN: ${{ secrets.RELEASE_PR_TOKEN }}",
        ),
      }),
      [],
    );
  });

  it("refuses a release-pr.yml without changesets/action or without permissions: {}", () => {
    const none = RELEASE_PR.replace(
      "      - uses: changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51\n",
      "      - uses: changesets/action-extra@v1\n",
    );
    assert.deepEqual(problems({ releasePr: none }), [
      `${WORKFLOWS.releasePr}: no job runs changesets/action`,
    ]);
    assert.deepEqual(
      problems({ releasePr: RELEASE_PR.replace("permissions: {}\n", "permissions: write-all\n") }),
      [top(WORKFLOWS.releasePr)],
    );
  });

  it("throws on a workflow without jobs", () => {
    assert.throws(
      () => problems({ docs: "on: workflow_call\n" }),
      /docs\.yml: has no jobs mapping/,
    );
    assert.throws(() => problems({ release: "jobs: [a]\n" }), /release\.yml: has no jobs mapping/);
  });
});

describe("check-release-workflows.ts", () => {
  it("passes on the repository", () => {
    assert.deepEqual(main([], SCRIPTS), []);
    const result = runScript(path.join(SCRIPTS, "check-release-workflows.ts"), [], ROOT);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${PASSED}\n`);
    assert.equal(result.status, 0);
  });

  it("prints each problem and exits 1", () => {
    const root = mkdtempSync(path.join(tmpdir(), "check-release-workflows-"));
    try {
      writeFiles(root, {
        [WORKFLOWS.promote]: promote(LATEST.replace("    needs: [verify, docs]\n", "")),
        [WORKFLOWS.release]: RELEASE,
        [WORKFLOWS.docs]: DOCS,
        [WORKFLOWS.releasePr]: RELEASE_PR,
      });
      const result = runScript(path.join(SCRIPTS, "check-release-workflows.ts"), [root], ROOT);
      assert.equal(
        result.stderr,
        `${WORKFLOWS.promote}: job latest moves latest but does not list docs in needs (R-AX-10, decision 0015)\n`,
      );
      assert.equal(result.stdout, "");
      assert.equal(result.status, 1);
    } finally {
      remove(root);
    }
  });

  it("reports a workflow that is not YAML as one problem", () => {
    const root = mkdtempSync(path.join(tmpdir(), "check-release-workflows-"));
    try {
      writeFiles(root, {
        [WORKFLOWS.promote]: "jobs: [\n",
        [WORKFLOWS.release]: RELEASE,
        [WORKFLOWS.docs]: DOCS,
        [WORKFLOWS.releasePr]: RELEASE_PR,
      });
      const found = main([root], SCRIPTS);
      assert.equal(found.length, 1);
      assert.doesNotMatch(found[0] ?? "", /\n/);
    } finally {
      remove(root);
    }
  });
});
