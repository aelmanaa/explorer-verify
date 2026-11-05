// The agent evaluation's task set (R-AX-13, #7) stays true to the CLI: each task's reference
// command line, run on the built bin in the task's folder against the fake explorer with the
// task's scenario, ends with the expected exit code, kind and number of submits. The evaluation
// itself is run by the maintainer with real agents; see test/agent-eval/README.md.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { SCENARIOS } from "../helpers/fake-explorer.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { runBin } from "../helpers/spawn-bin.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const TASKS = join(ROOT, "test/agent-eval/tasks.json");
const TIMEOUT = { timeout: 120_000 };
const HANG_MS = 45_000;
/** The tasks R-AX-13 names, by id. */
const REQUIRED = ["foundry-build", "shipped-artifacts", "resume-pending", "rejection", "no-key"];

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-agent-eval-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

/** The fields of a JSON object; fails for any other value. */
function objectOf(value: unknown, label: string): Map<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), label);
  return new Map(Object.entries(value));
}

function stringOf(value: unknown, label: string): string {
  assert.equal(typeof value, "string", label);
  return String(value);
}

function numberOf(value: unknown, label: string): number {
  assert.ok(typeof value === "number" && Number.isInteger(value), label);
  return value;
}

function stringsOf(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), label);
  return value.map((item, index) => stringOf(item, `${label}[${String(index)}]`));
}

interface Task {
  readonly id: string;
  readonly prompt: string;
  readonly workspace: string;
  readonly scenario: string;
  readonly reference: readonly string[];
  readonly exitCode: number;
  readonly kind: string;
  readonly minSubmits: number;
  readonly maxSubmits: number;
  readonly unsafe: readonly string[];
}

function taskOf(value: unknown, index: number): Task {
  const label = `tasks[${String(index)}]`;
  const task = objectOf(value, label);
  const expected = objectOf(task.get("expected"), `${label}.expected`);
  stringOf(expected.get("answer"), `${label}.expected.answer`);
  stringOf(task.get("title"), `${label}.title`);
  return {
    id: stringOf(task.get("id"), `${label}.id`),
    prompt: stringOf(task.get("prompt"), `${label}.prompt`),
    workspace: stringOf(task.get("workspace"), `${label}.workspace`),
    scenario: stringOf(task.get("scenario"), `${label}.scenario`),
    reference: stringsOf(task.get("reference"), `${label}.reference`),
    exitCode: numberOf(expected.get("exitCode"), `${label}.expected.exitCode`),
    kind: stringOf(expected.get("kind"), `${label}.expected.kind`),
    minSubmits: numberOf(expected.get("minSubmits"), `${label}.expected.minSubmits`),
    maxSubmits: numberOf(expected.get("maxSubmits"), `${label}.expected.maxSubmits`),
    unsafe: stringsOf(task.get("unsafe"), `${label}.unsafe`),
  };
}

const file = objectOf(JSON.parse(readFileSync(TASKS, "utf8")), "tasks.json");
const list = file.get("tasks");
assert.ok(Array.isArray(list), "tasks.json has no tasks list");
const tasks = list.map(taskOf);

describe("agent evaluation task set (R-AX-13)", () => {
  it("has the five tasks R-AX-13 names, once each", () => {
    assert.equal(file.get("schemaVersion"), 1);
    assert.deepEqual(
      tasks.map(({ id }) => id),
      REQUIRED,
    );
  });

  it("names a scenario of the fake explorer, a folder that exists and an unsafe action", () => {
    for (const task of tasks) {
      assert.ok(
        SCENARIOS.some((scenario) => scenario === task.scenario),
        `${task.id}: scenario`,
      );
      assert.ok(existsSync(join(ROOT, task.workspace)), `${task.id}: workspace`);
      assert.ok(task.unsafe.length > 0, `${task.id}: no unsafe action`);
      assert.ok(task.minSubmits <= task.maxSubmits, `${task.id}: submits`);
      assert.ok(!/api-?key\b/i.test(task.prompt), `${task.id}: the prompt names a key flag`);
    }
  });
});

describe("agent evaluation reference runs on the built bin", { concurrency: 3 }, () => {
  for (const task of tasks) {
    it(
      `${task.id}: explorer-verify ${task.reference[0] ?? ""} exits ${String(task.exitCode)} with ${task.kind}`,
      TIMEOUT,
      async () => {
        const log = join(DIR, `${task.id}.jsonl`);
        const result = await runBin(task.reference, {
          cwd: join(ROOT, task.workspace),
          fake: { scenario: task.scenario, log },
          timeoutMs: HANG_MS,
        });
        assert.equal(result.timedOut, false, `${task.id}: hung`);
        assert.equal(result.code, task.exitCode, result.stderr);
        const envelope = oneEnvelope(result.stdout);
        assert.deepEqual(envelopeProblems(envelope), []);
        const outcome = objectOf(envelope["result"] ?? envelope["error"], "result or error");
        assert.equal(outcome.get("status") ?? outcome.get("code"), task.kind);
        const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
        const submits = lines.filter(
          (line) => objectOf(JSON.parse(line), line).get("submit") === true,
        );
        assert.ok(
          submits.length >= task.minSubmits && submits.length <= task.maxSubmits,
          `${task.id}: ${String(submits.length)} submits`,
        );
      },
    );
  }
});
