// Decides whether a commit has a passing ci.yml run on main, from the answer of the GitHub API
// `GET /repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=<sha>`. The release workflow
// runs it before it builds a tag.
//
// The query filters by `head_sha` only. The API's `status`, `event` and `branch` filters can lag
// behind a run that has already completed: on 2026-11-12 a query with `status=success` returned no
// run for more than 13 minutes, while the same query with `head_sha` alone returned the run as
// completed and successful. So the filtering happens here, on the runs the API returns.
//
// A run counts when its `head_sha` is the commit, `event` is `push`, `head_branch` is `main`,
// `status` is `completed` and `conclusion` is `success`.
//
// Usage: gh api ".../ci.yml/runs?head_sha=$COMMIT&per_page=100" | node scripts/check-ci-run.ts COMMIT
// Prints one line. Exits 0 when the commit has a passing run, 1 when it has none or the input is
// not a runs answer.
import process from "node:process";
import { text as readAll } from "node:stream/consumers";

import { errorMessage, isMainModule } from "./release-packages.ts";

/** The fields of one workflow run the check reads. */
export interface WorkflowRun {
  id: number;
  headSha: string;
  event: string;
  headBranch: string;
  status: string;
  conclusion: string;
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Reads the runs from the API's answer.
 * @param answer The JSON text of the answer.
 * @returns The runs, with the fields the check reads; a missing field reads as "".
 */
export function parseRuns(answer: string): WorkflowRun[] {
  const value: unknown = JSON.parse(answer);
  const runs = field(value, "workflow_runs");
  if (!Array.isArray(runs)) {
    throw new Error("the answer has no workflow_runs array; expected the workflow runs API answer");
  }
  return runs.map((run: unknown) => {
    const id = field(run, "id");
    return {
      id: typeof id === "number" ? id : 0,
      headSha: text(field(run, "head_sha")),
      event: text(field(run, "event")),
      headBranch: text(field(run, "head_branch")),
      status: text(field(run, "status")),
      conclusion: text(field(run, "conclusion")),
    };
  });
}

/**
 * Keeps the runs that show CI passed on main for the commit.
 * @param runs The runs the API returned.
 * @param commit The full commit SHA.
 * @returns The passing push runs on main for that commit.
 */
export function passingRuns(runs: readonly WorkflowRun[], commit: string): WorkflowRun[] {
  return runs.filter(
    (run) =>
      run.headSha === commit &&
      run.event === "push" &&
      run.headBranch === "main" &&
      run.status === "completed" &&
      run.conclusion === "success",
  );
}

/**
 * Runs the command line.
 * @param argv The arguments after the script name.
 * @param answer The JSON text of the API's answer.
 * @returns The line to print and whether the commit has a passing run.
 */
export function main(argv: readonly string[], answer: string): { ok: boolean; line: string } {
  const [commit] = argv;
  if (commit === undefined || argv.length !== 1 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("usage: node scripts/check-ci-run.ts <40-character commit SHA> < runs.json");
  }
  const runs = parseRuns(answer);
  const passed = passingRuns(runs, commit);
  if (passed.length === 0) {
    const seen = runs
      .filter((run) => run.headSha === commit)
      .map(
        (run) =>
          `${run.id} (${run.event} on ${run.headBranch}: ${run.status}${run.conclusion === "" ? "" : `, ${run.conclusion}`})`,
      );
    const detail = seen.length === 0 ? "no ci.yml run" : `ci.yml runs ${seen.join(", ")}`;
    return {
      ok: false,
      line: `commit ${commit} has no passing ci.yml push run on main (${detail}). Wait for CI on main to pass, then re-run this workflow.`,
    };
  }
  return {
    ok: true,
    line: `ci.yml passed on \`${commit}\`: run ${passed.map((run) => run.id).join(", ")}.`,
  };
}

if (isMainModule(import.meta.url)) {
  try {
    const result = main(process.argv.slice(2), await readAll(process.stdin));
    if (result.ok) {
      process.stdout.write(`${result.line}\n`);
    } else {
      process.stderr.write(`${result.line}\n`);
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
