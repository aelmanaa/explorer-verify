// A fake Sourcify, Etherscan, Routescan and JSON-RPC endpoint for the CLI tests: a `fetch` that
// answers from the core package's recorded answers for the Greeter, and reports each request it
// gets. The unit tests
// put it in `globalThis.fetch`, so the CLI injects no `fetch` and the key checks stay on; the bin
// tests load it with `--import` through fake-explorer-preload.ts.
import { readFileSync } from "node:fs";

/**
 * What the explorer holds:
 * - `verified`: the contract is verified, with an exact match.
 * - `partial`: the contract is verified, with a partial match; a submit is accepted, and its job
 *   ends with an exact match.
 * - `partial-pending`, `partial-rejected`, `partial-forgotten`: a partial match, and a job that
 *   never ends, ends with `no_match`, or is unknown to the explorer.
 * - `new`: not verified; a submit is accepted, and its job ends with an exact match.
 * - `pending`: not verified; a submit is accepted, and its job never ends.
 * - `rejected`: not verified; a submit is accepted, and its job ends with `no_match`.
 * - `inconclusive`: not verified; a submit is accepted, and its job ends with `internal_error`.
 * - `unclassified`: not verified; a submit is accepted, and its job ends with an error code the
 *   library does not know.
 * - `offline`: not verified; the submit and the job status requests get no response.
 * - `flaky`: like `pending`, except that the first job status request gets no response, so the
 *   run retries it once with a `verify.retry` warning.
 */
export type Scenario =
  | "verified"
  | "partial"
  | "partial-pending"
  | "partial-rejected"
  | "partial-forgotten"
  | "new"
  | "pending"
  | "rejected"
  | "inconclusive"
  | "unclassified"
  | "offline"
  | "flaky";

/** The scenarios, for checking a name read from the environment. */
export const SCENARIOS: readonly Scenario[] = [
  "verified",
  "partial",
  "partial-pending",
  "partial-rejected",
  "partial-forgotten",
  "new",
  "pending",
  "rejected",
  "inconclusive",
  "unclassified",
  "offline",
  "flaky",
];

/** The recorded job answer of each scenario whose job ends with an error. */
const JOB_ERRORS: Partial<Record<Scenario, string>> = {
  rejected: "sourcify/2026-11-02-job-no-match",
  "partial-rejected": "sourcify/2026-11-02-job-no-match",
  inconclusive: "sourcify/2026-11-02-job-internal-error",
  unclassified: "sourcify/2026-11-02-job-unknown-code",
};

/** One request the fake got. `submit` is true for a request that submits a verification. */
export interface Seen {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly action: string;
  readonly submit: boolean;
  /** Whether the request carried an `apikey` field or header. Never the key itself. */
  readonly keyed: boolean;
}

/** The host of the fake JSON-RPC endpoint. Its answer is an error that repeats the whole URL. */
export const RPC_HOST = "rpc.invalid";

/** The Etherscan-style APIs the fake answers: Etherscan's, and Routescan's for every chain. */
const ETHERSCAN_HOSTS = ["api.etherscan.io", "api.routescan.io"];

/** The job id of the recorded Sourcify submit. */
export const JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";

const FIXTURES = new URL("../../../explorer-verify/test/fixtures/", import.meta.url);

/** The fields of a JSON object; empty for any other value. */
function fields(value: unknown): Map<string, unknown> {
  return new Map(typeof value === "object" && value !== null ? Object.entries(value) : []);
}

/** The recorded status and body in `<backend>/<name>.json`. */
function recordedAnswer(name: string): { status: number; body: unknown } {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"));
  const response = fields(fields(parsed).get("response"));
  return { status: Number(response.get("status")), body: response.get("body") };
}

/** A JSON `Response`. */
function respond(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The recorded response in `<backend>/<name>.json`, as a new `Response`. */
function recorded(name: string): Response {
  const { status, body } = recordedAnswer(name);
  return respond(status, body);
}

/**
 * The recorded job answer `name`, moved to the job and the contract of the recorded submit. The
 * error answers were recorded for another job, and the library checks that a status answer is
 * about the job it asked for.
 */
function jobError(name: string): Response {
  const exact = fields(
    fields(recordedAnswer("sourcify/2026-11-02-job-exact-match").body).get("contract"),
  );
  const { status, body } = recordedAnswer(name);
  return respond(status, {
    ...Object.fromEntries(fields(body)),
    verificationId: JOB,
    contract: {
      match: null,
      creationMatch: null,
      runtimeMatch: null,
      chainId: exact.get("chainId"),
      address: exact.get("address"),
    },
  });
}

/** The URL, the form fields and the `apikey` header of a request. */
async function read(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<{ url: URL; form: URLSearchParams; keyHeader: boolean }> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body = init?.body;
  const form = new URLSearchParams(
    body instanceof URLSearchParams ? body : typeof body === "string" ? body : "",
  );
  for (const [name, value] of url.searchParams) {
    form.append(name, value);
  }
  const keyHeader = new Headers(init?.headers).has("apikey");
  return await Promise.resolve({ url, form, keyHeader });
}

/** The Sourcify answer of `path`, or `undefined` when it is not a Sourcify path. */
function sourcify(scenario: Scenario, method: string, path: string): Response | undefined {
  const lookup = /\/v2\/contract\/(\d+)\/(0x[0-9a-fA-F]{40})$/.exec(path);
  if (lookup !== null) {
    // The answer, moved to the chain asked for: the library checks that it is about that chain.
    const { status, body } = recordedAnswer(
      scenario === "verified"
        ? "sourcify/2026-11-02-lookup-exact-match"
        : scenario.startsWith("partial")
          ? "sourcify/2026-11-02-lookup-match"
          : "sourcify/2026-11-02-lookup-not-verified",
    );
    // The partial answer was recorded for another contract: it is moved to this one too.
    const moved = scenario.startsWith("partial") ? { address: lookup[2] } : {};
    return respond(status, { ...Object.fromEntries(fields(body)), chainId: lookup[1], ...moved });
  }
  if (method === "POST" && /\/v2\/verify\/\d+\/0x[0-9a-fA-F]{40}$/.test(path)) {
    return recorded("sourcify/2026-11-02-submit-accepted");
  }
  if (path.endsWith(`/v2/verify/${JOB}`)) {
    const error = JOB_ERRORS[scenario];
    if (error !== undefined) {
      return jobError(error);
    }
    if (scenario === "partial-forgotten") {
      return recorded("sourcify/2026-11-02-job-not-found");
    }
    return recorded(
      scenario === "pending" || scenario === "flaky" || scenario === "partial-pending"
        ? "sourcify/2026-11-02-job-pending"
        : "sourcify/2026-11-02-job-exact-match",
    );
  }
  return undefined;
}

/** The JSON-RPC error answer of the fake endpoint, which repeats the URL it was sent to. */
function rpcError(url: URL, body: unknown): Response {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : undefined;
  return respond(200, {
    jsonrpc: "2.0",
    id: fields(parsed).get("id") ?? null,
    error: { code: -32000, message: `unknown transaction at ${url.href}` },
  });
}

/**
 * A fake `fetch` for `scenario`. Etherscan and Routescan answer only the lookup, the contract
 * creation (none found) and a job status, which passes; the JSON-RPC endpoint at {@link RPC_HOST} answers an error. Any other request
 * rejects, so a request a test did not expect fails it.
 *
 * @param scenario - What the explorer holds.
 * @param onRequest - Called with each request, before the answer.
 * @returns The fake.
 */
export function fakeExplorer(
  scenario: Scenario,
  onRequest: (seen: Seen) => void = () => undefined,
): typeof fetch {
  let jobRequests = 0;
  return async (input, init) => {
    const { url, form, keyHeader } = await read(input, init);
    const method = init?.method ?? "GET";
    const action = form.get("action") ?? "";
    const path = url.pathname;
    const submit =
      action === "verifysourcecode" || (method === "POST" && /\/v2\/verify\/\d+\//.test(path));
    const keyed = form.has("apikey") || keyHeader;
    onRequest({ method, host: url.host, path, action, submit, keyed });
    const jobRequest = path.endsWith(`/v2/verify/${JOB}`);
    jobRequests += jobRequest ? 1 : 0;
    const dropped = scenario === "flaky" && jobRequest && jobRequests === 1;
    if (dropped || (scenario === "offline" && (submit || jobRequest))) {
      // What a platform fetch throws when the connection fails.
      throw new TypeError("fetch failed");
    }
    if (url.host === RPC_HOST) {
      return rpcError(url, init?.body);
    }
    if (ETHERSCAN_HOSTS.includes(url.host)) {
      if (action === "getsourcecode") {
        return recorded(
          scenario === "verified"
            ? "etherscan/2026-11-04-getsourcecode-sepolia-greeter"
            : "etherscan/2026-11-03-getsourcecode-not-verified",
        );
      }
      if (action === "getcontractcreation") {
        return recorded("etherscan/2026-11-04-getcontractcreation-no-contract");
      }
      if (action === "checkverifystatus") {
        return recorded("etherscan/2026-11-03-checkverifystatus-factory-child-02-pass");
      }
      throw new Error(`the fake Etherscan does not answer ${action}`);
    }
    const answer = sourcify(scenario, method, path);
    if (answer === undefined) {
      throw new Error(`the fake explorer does not answer ${method} ${path}`);
    }
    return answer;
  };
}
