// Answers the poll of the other job from a made-up body, so its recorded answer stays unused.
import { startWrapped, urlOf } from "./wrap.ts";

const OTHER_JOB = "89bd295a-5a1e-40d7-a853-739e62341b77";
const body = JSON.stringify({
  isJobCompleted: true,
  verificationId: OTHER_JOB,
  contract: {
    match: "exact_match",
    creationMatch: "exact_match",
    runtimeMatch: "exact_match",
    chainId: "421614",
    address: "0xcecf301f97d21103233E666b2C6B766195D2e5DC",
  },
});

startWrapped(
  (real) => async (input, init) =>
    urlOf(input).endsWith(`/v2/verify/${OTHER_JOB}`)
      ? new Response(body, { status: 200, headers: { "content-type": "application/json" } })
      : await real(input, init),
);
