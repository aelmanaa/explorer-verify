// Decides what scripts/node-test.ts does with a run that asks for a random test order
// (`--test-randomize` or `--test-random-seed`). Node added both options in 24.16.0 and 26.1.0;
// 22.x, 24.0 to 24.15 and 26.0 do not have them.
//
// - On a Node that has them, the run starts.
// - On a Node that lacks them, a local run is skipped with a note and exit code 0.
// - With `REQUIRE_RANDOM_ORDER=1` in the environment, as in CI, the run fails with exit code 1, so
//   a random-order step cannot pass without running.
import process from "node:process";

/** The `node --test` options that run tests in a random order. */
const RANDOM_ORDER_OPTIONS: readonly string[] = ["--test-randomize", "--test-random-seed"];

/** The first Node releases that have the random-order options. */
export const RANDOM_ORDER_SINCE = "24.16.0 and 26.1.0";

/** Whether `args` ask `node --test` for a random test order. */
export function asksRandomOrder(args: readonly string[]): boolean {
  return args.some((arg) =>
    RANDOM_ORDER_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`)),
  );
}

/** Whether a Node with these allowed flags can run tests in a random order. */
export function supportsRandomOrder(
  flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
): boolean {
  return flags.has("--test-randomize");
}

/** What to do with a run: start it, skip it, or fail it. A skip or a failure has a message. */
export type RandomOrderDecision =
  | { action: "run" }
  | { action: "skip"; message: string }
  | { action: "fail"; message: string };

/** The inputs of {@link decideRandomOrder}; each defaults to the running process. */
export interface RandomOrderContext {
  flags?: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
  version?: string;
}

/** Decides whether a `node --test` run with `args` starts, is skipped or fails. */
export function decideRandomOrder(
  args: readonly string[],
  context: RandomOrderContext = {},
): RandomOrderDecision {
  if (!asksRandomOrder(args) || supportsRandomOrder(context.flags)) {
    return { action: "run" };
  }
  const version = context.version ?? process.versions.node;
  const env = context.env ?? process.env;
  const missing = `Node ${version} has no --test-randomize (added in ${RANDOM_ORDER_SINCE})`;
  if (env["REQUIRE_RANDOM_ORDER"] === "1") {
    return {
      action: "fail",
      message: `node-test: ${missing}, and REQUIRE_RANDOM_ORDER=1 requires the random-order run\n`,
    };
  }
  return { action: "skip", message: `node-test: ${missing}; skipping the random-order run\n` };
}
