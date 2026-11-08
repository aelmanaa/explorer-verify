// Synthetic Sourcify protocol stand-in. No fetch reaches the network.
import { appendFileSync } from "node:fs";
const job = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const contract = {
  chainId: "11155111",
  address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
  match: null,
  creationMatch: null,
  runtimeMatch: null,
};
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? "GET";
  const submit = method === "POST";
  appendFileSync(
    process.env.POLYGLOT_LOG,
    JSON.stringify({ method, path: url.pathname, submit }) + "\n",
  );
  if (url.host !== "sourcify.dev") throw new Error("Unexpected host");
  let status = 200;
  let body;
  if (method === "GET" && /\/v2\/contract\//.test(url.pathname)) {
    status = 404;
    body = contract;
  } else if (submit && /\/v2\/verify\/11155111\//.test(url.pathname)) {
    const request = JSON.parse(init.body);
    if (!JSON.stringify(request).includes("Greeter")) throw new Error("Missing compiler input");
    status = 202;
    body = { verificationId: job };
  } else if (method === "GET" && url.pathname.endsWith("/v2/verify/" + job)) {
    const scenario = process.env.POLYGLOT_SCENARIO;
    const completed = scenario !== "pending";
    body = {
      verificationId: job,
      isJobCompleted: completed,
      jobStartTime: "2026-11-02T23:39:56Z",
      contract: { ...contract },
    };
    if (completed) body.jobFinishTime = "2026-11-02T23:39:57Z";
    if (scenario === "rejected")
      body.error = {
        customCode: "no_match",
        message: "The deployed and recompiled bytecode do not match.",
      };
    else if (completed)
      Object.assign(body.contract, {
        match: "exact_match",
        creationMatch: "exact_match",
        runtimeMatch: "exact_match",
      });
  } else throw new Error("Unexpected request");
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
};
