// A fake Sourcify and Etherscan for the CLI tests: a `fetch` that answers from the core package's
// recorded answers for the Greeter on Sepolia, and reports each request it gets. The unit tests
// put it in `globalThis.fetch`, so the CLI injects no `fetch` and the key checks stay on; the bin
// tests load it with `--import` through fake-explorer-preload.ts.
import { readFileSync } from "node:fs";

/**
 * What the explorer holds:
 * - `verified`: the contract is verified, with an exact match.
 * - `new`: not verified; a submit is accepted, and its job ends with an exact match.
 * - `pending`: not verified; a submit is accepted, and its job never ends.
 */
export type Scenario = "verified" | "new" | "pending";

/** The scenarios, for checking a name read from the environment. */
export const SCENARIOS: readonly Scenario[] = ["verified", "new", "pending"];

/** One request the fake got. `submit` is true for a request that submits a verification. */
export interface Seen {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly action: string;
  readonly submit: boolean;
  /** Whether the request carried an `apikey` field. Never the key itself. */
  readonly keyed: boolean;
}

/** The job id of the recorded Sourcify submit. */
export const JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";

const FIXTURES = new URL("../../../explorer-verify/test/fixtures/", import.meta.url);

/** The fields of a JSON object; empty for any other value. */
function fields(value: unknown): Map<string, unknown> {
  return new Map(typeof value === "object" && value !== null ? Object.entries(value) : []);
}

/** The recorded response in `<backend>/<name>.json`, as a new `Response`. */
function recorded(name: string): Response {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"));
  const response = fields(fields(parsed).get("response"));
  const body = response.get("body");
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: Number(response.get("status")),
    headers: { "content-type": "application/json" },
  });
}

/** The URL and the form fields of a request. */
async function read(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<{ url: URL; form: URLSearchParams }> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body = init?.body;
  const form = new URLSearchParams(
    body instanceof URLSearchParams ? body : typeof body === "string" ? body : "",
  );
  for (const [name, value] of url.searchParams) {
    form.append(name, value);
  }
  return await Promise.resolve({ url, form });
}

/** The Sourcify answer of `path`, or `undefined` when it is not a Sourcify path. */
function sourcify(scenario: Scenario, method: string, path: string): Response | undefined {
  if (/\/v2\/contract\/\d+\/0x[0-9a-fA-F]{40}$/.test(path)) {
    return recorded(
      scenario === "verified"
        ? "sourcify/2026-11-02-lookup-exact-match"
        : "sourcify/2026-11-02-lookup-not-verified",
    );
  }
  if (method === "POST" && /\/v2\/verify\/\d+\/0x[0-9a-fA-F]{40}$/.test(path)) {
    return recorded("sourcify/2026-11-02-submit-accepted");
  }
  if (path.endsWith(`/v2/verify/${JOB}`)) {
    return recorded(
      scenario === "pending"
        ? "sourcify/2026-11-02-job-pending"
        : "sourcify/2026-11-02-job-exact-match",
    );
  }
  return undefined;
}

/**
 * A fake `fetch` for `scenario`. Etherscan answers only the lookup; any other request rejects,
 * so a request a test did not expect fails it.
 *
 * @param scenario - What the explorer holds.
 * @param onRequest - Called with each request, before the answer.
 * @returns The fake.
 */
export function fakeExplorer(
  scenario: Scenario,
  onRequest: (seen: Seen) => void = () => undefined,
): typeof fetch {
  return async (input, init) => {
    const { url, form } = await read(input, init);
    const method = init?.method ?? "GET";
    const action = form.get("action") ?? "";
    const path = url.pathname;
    const submit =
      action === "verifysourcecode" || (method === "POST" && /\/v2\/verify\/\d+\//.test(path));
    onRequest({ method, host: url.host, path, action, submit, keyed: form.has("apikey") });
    if (url.host === "api.etherscan.io") {
      if (action === "getsourcecode") {
        return recorded(
          scenario === "verified"
            ? "etherscan/2026-11-04-getsourcecode-sepolia-greeter"
            : "etherscan/2026-11-03-getsourcecode-not-verified",
        );
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
