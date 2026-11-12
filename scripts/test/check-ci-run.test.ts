// Runs check-ci-run.ts on workflow runs API answers shaped like GitHub's.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { main, parseRuns, passingRuns } from "../check-ci-run.ts";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "check-ci-run.ts");
const COMMIT = "49b9780".padEnd(40, "0");
const OTHER = "1".repeat(40);

interface RunFields {
  id?: number;
  head_sha?: string;
  event?: string;
  head_branch?: string;
  status?: string;
  conclusion?: string | null;
}

function run(fields: RunFields = {}): RunFields {
  return {
    id: 43196179719,
    head_sha: COMMIT,
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    ...fields,
  };
}

const answer = (...runs: RunFields[]): string =>
  JSON.stringify({ total_count: runs.length, workflow_runs: runs });

function spawn(args: readonly string[], input: string) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", SCRIPT, ...args], {
    input,
    encoding: "utf8",
  });
}

describe("ci.yml run check for a release tag (R-SEC-4)", () => {
  it("passes on a completed, successful push run on main", () => {
    const result = main([COMMIT], answer(run()));
    assert.equal(result.ok, true);
    assert.equal(result.line, `ci.yml passed on \`${COMMIT}\`: run 43196179719.`);
  });

  it("lists every passing run", () => {
    const result = main([COMMIT], answer(run({ id: 1 }), run({ id: 2 })));
    assert.equal(result.line, `ci.yml passed on \`${COMMIT}\`: run 1, 2.`);
  });

  it("fails when the commit has no run", () => {
    const result = main([COMMIT], answer());
    assert.equal(result.ok, false);
    assert.match(result.line, /has no passing ci\.yml push run on main \(no ci\.yml run\)/);
    assert.match(result.line, /re-run this workflow/);
  });

  it("fails when the only run failed, was cancelled or is still running", () => {
    for (const fields of [
      { conclusion: "failure" },
      { conclusion: "cancelled" },
      { status: "in_progress", conclusion: null },
      { status: "queued", conclusion: null },
    ]) {
      const result = main([COMMIT], answer(run(fields)));
      assert.equal(result.ok, false, JSON.stringify(fields));
    }
    const failed = main([COMMIT], answer(run({ id: 7, conclusion: "failure" })));
    assert.match(failed.line, /ci\.yml runs 7 \(push on main: completed, failure\)/);
    const running = main([COMMIT], answer(run({ id: 8, status: "in_progress", conclusion: null })));
    assert.match(running.line, /ci\.yml runs 8 \(push on main: in_progress\)/);
  });

  it("ignores a run for another event, branch or commit", () => {
    for (const fields of [
      { event: "pull_request" },
      { event: "workflow_dispatch" },
      { head_branch: "changeset-release/main" },
      { head_sha: OTHER },
    ]) {
      assert.equal(main([COMMIT], answer(run(fields))).ok, false, JSON.stringify(fields));
    }
  });

  it("passes when a passing run sits next to failed ones", () => {
    const result = main(
      [COMMIT],
      answer(run({ id: 1, conclusion: "failure" }), run({ id: 2, event: "pull_request" }), run()),
    );
    assert.equal(result.ok, true);
    assert.match(result.line, /run 43196179719\.$/);
  });

  it("reads missing or mistyped fields as empty", () => {
    const runs = parseRuns(JSON.stringify({ workflow_runs: [{}, null, { id: "x", event: 1 }] }));
    assert.deepEqual(runs[0], {
      id: 0,
      headSha: "",
      event: "",
      headBranch: "",
      status: "",
      conclusion: "",
    });
    assert.equal(runs[2]?.event, "");
    assert.deepEqual(passingRuns(runs, COMMIT), []);
  });

  it("rejects an answer that is not a runs answer", () => {
    for (const text of ["{}", "[]", "null", '{"workflow_runs":{}}']) {
      assert.throws(() => main([COMMIT], text), /no workflow_runs array/);
    }
    assert.throws(() => main([COMMIT], "not json"), SyntaxError);
  });

  it("rejects a missing, extra or short commit", () => {
    for (const argv of [[], [COMMIT, COMMIT], ["49b9780"], [COMMIT.toUpperCase()]]) {
      assert.throws(() => main(argv, answer(run())), /usage:/);
    }
  });

  it("runs as a command: exit 0 with the line on stdout, exit 1 with it on stderr", () => {
    const passed = spawn([COMMIT], answer(run()));
    assert.equal(passed.status, 0);
    assert.match(passed.stdout, /^ci\.yml passed on/);
    const failed = spawn([COMMIT], answer());
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /has no passing ci\.yml push run on main/);
    const broken = spawn([], answer());
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /^usage:/);
  });
});
