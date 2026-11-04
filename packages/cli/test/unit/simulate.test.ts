// The placeholder `simulate` command, called directly.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { VerifyEvent } from "explorer-verify";

import type { CommandContext } from "../../src/command.ts";
import { SIMULATE } from "../../src/simulate.ts";

const ignore = (): void => undefined;

function context(values: Record<string, string>, signal: AbortSignal, events: VerifyEvent[]) {
  const result: CommandContext = {
    positionals: [],
    values: new Map(Object.entries(values)),
    signal,
    logger: { debug: ignore, info: ignore, warn: ignore, error: ignore },
    onEvent: (event) => {
      events.push(event);
    },
    env: {},
  };
  return result;
}

describe("simulate", () => {
  it("rejects with the signal's reason when the signal aborted before a poll", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    const events: VerifyEvent[] = [];
    await assert.rejects(
      SIMULATE.run(context({ outcome: "pending" }, controller.signal, events)),
      reason,
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["verify.validated", "verify.routed", "verify.lookup", "verify.submitted"],
    );
  });

  it("emits one verify.retry per retry, from attempt 2", async () => {
    const events: VerifyEvent[] = [];
    await SIMULATE.run(context({ retries: "2" }, new AbortController().signal, events));
    assert.deepEqual(
      events.flatMap((event) => (event.type === "verify.retry" ? [event.attempt] : [])),
      [2, 3],
    );
  });

  it("throws a plain Error with the default message for internal-error", async () => {
    await assert.rejects(
      SIMULATE.run(context({ outcome: "internal-error" }, new AbortController().signal, [])),
      (error: unknown) => error instanceof Error && error.message === "Simulated failure.",
    );
  });
});
