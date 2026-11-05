// A local fake explorer for the live matrix (#66): the `etherscan-compatible` row, and the unit
// test that runs the whole matrix offline. It speaks the Etherscan form API on `/api` and the
// Sourcify v2 API on `/v2/`, and keeps one verified state per address for both, as an explorer
// that forwards Sourcify verifications to an Etherscan-family explorer does.
import { createServer } from "node:http";

/** A contract the fake knows: what a correct submission holds. */
export interface FakeContract {
  /** The contract address, in any case. */
  readonly address: string;
  /** The Standard JSON `sources`, as `canonicalSources` writes them. */
  readonly sources: string;
  /** The ABI-encoded constructor arguments, `0x` prefixed. */
  readonly constructorArgs: string;
  /** The creation code the chain holds: the compiled creation bytecode and the arguments. */
  readonly creationCode: string;
}

/** How the fake judges submissions. */
export type FakeVerdict = "honest" | "accept-all" | "reject-all";

/** How the fake behaves. */
export interface FakeOptions {
  /** The contracts a submission can verify. A submission for another address fails. */
  readonly contracts: readonly FakeContract[];
  /** The key the Etherscan form API requires; without one, it requires none. */
  readonly key?: string | undefined;
  /**
   * How submissions are judged. `honest`, the default, verifies a submission whose sources and
   * arguments are the contract's. For tests of the matrix itself, `accept-all` verifies every
   * submission and `reject-all` none: two broken explorers.
   */
  readonly verdict?: FakeVerdict | undefined;
  /**
   * A secret the fake copies into its key errors, its failure reasons and every answer body, as a
   * careless explorer might echo a key. The matrix test sets it to prove that the script's own
   * redaction removes it (R-SEC-1).
   */
  readonly echo?: string | undefined;
}

/** A running fake. */
export interface Fake {
  /** The base URL, `http://127.0.0.1:<port>`, without a trailing slash. */
  readonly url: string;
  /** Stops the server. */
  readonly close: () => Promise<void>;
}

/** The members of a parsed JSON object; none for any other value. */
function membersOf(value: unknown): Map<string, unknown> {
  return typeof value === "object" && value !== null
    ? new Map(Object.entries(value))
    : new Map<string, unknown>();
}

/**
 * The Standard JSON sources as one string, in path order, so two inputs compare equal when their
 * source texts do. A source without text is written as `null`.
 *
 * @param sources - The `sources` member of a Standard JSON input.
 * @returns The canonical text.
 * @example
 * ```ts
 * canonicalSources({ "a.sol": { content: "x" } }); // '[["a.sol","x"]]'
 * ```
 */
export function canonicalSources(sources: unknown): string {
  const pairs = [...membersOf(sources)].map(([file, entry]): [string, string | null] => {
    const content = membersOf(entry).get("content");
    return [file, typeof content === "string" ? content : null];
  });
  pairs.sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(pairs);
}

/**
 * Starts the fake on `127.0.0.1` on a free port.
 *
 * @param options - The contracts and the behaviour.
 * @returns The base URL and a `close` function.
 * @example
 * ```ts
 * const fake = await startFake({ contracts: [], key: "dummy-key-1" });
 * // route: { backend: "etherscan-compatible", apiUrl: `${fake.url}/api`, apiKey: "dummy-key-1" }
 * await fake.close();
 * ```
 */
export async function startFake(options: FakeOptions): Promise<Fake> {
  const contracts = new Map(options.contracts.map((each) => [each.address.toLowerCase(), each]));
  const verified = new Set<string>();
  const jobs = new Map<string, { readonly address: string; readonly pass: boolean }>();
  let next = 0;
  // Job ids of `width` hex digits: 50 for Etherscan, 12 for the last group of a Sourcify UUID.
  const jobId = (width: number): string => {
    next += 1;
    return `${"f".repeat(width - 12)}${String(next).padStart(12, "0")}`;
  };
  // The verdict on one submission: whether its sources (and arguments, when sent) are the
  // contract's.
  const passes = (address: string, sources: unknown, args: string | null): boolean => {
    const contract = contracts.get(address);
    if (options.verdict === "accept-all" || options.verdict === "reject-all") {
      return options.verdict === "accept-all";
    }
    return (
      contract !== undefined &&
      canonicalSources(sources) === contract.sources &&
      (args === null || `0x${args.replace(/^0x/, "")}` === contract.constructorArgs)
    );
  };

  // The echoed secret with a leading space, or nothing.
  const echo = options.echo === undefined ? "" : ` ${options.echo}`;
  const etherscan = (params: URLSearchParams): unknown => {
    const key = params.get("apikey");
    if (options.key !== undefined && key !== options.key) {
      return {
        status: "0",
        message: "NOTOK",
        result: `${key === null ? "Missing/Invalid API Key" : "Invalid API Key"}${echo}`,
      };
    }
    const address = String(params.get("address") ?? params.get("contractaddress")).toLowerCase();
    const action = params.get("action");
    if (action === "getsourcecode") {
      const done = verified.has(address);
      return {
        status: "1",
        message: "OK",
        result: [
          {
            SourceCode: done ? "{}" : "",
            ABI: done ? "[]" : "Contract source code not verified",
            ContractName: "",
            SimilarMatch: "",
          },
        ],
      };
    }
    if (action === "getcontractcreation") {
      const wanted = String(params.get("contractaddresses")).toLowerCase();
      const contract = contracts.get(wanted);
      return contract === undefined
        ? { status: "0", message: "No data found", result: null }
        : {
            status: "1",
            message: "OK",
            result: [{ contractAddress: wanted, creationBytecode: contract.creationCode }],
          };
    }
    if (action === "verifysourcecode") {
      if (verified.has(address)) {
        return { status: "0", message: "NOTOK", result: "Contract source code already verified" };
      }
      const input: unknown = JSON.parse(String(params.get("sourceCode")));
      const guid = jobId(50);
      const sources = membersOf(input).get("sources");
      jobs.set(guid, {
        address,
        pass: passes(address, sources, params.get("constructorArguements")),
      });
      return { status: "1", message: "OK", result: guid };
    }
    const job = action === "checkverifystatus" ? jobs.get(String(params.get("guid"))) : undefined;
    if (job === undefined) {
      return { status: "0", message: "NOTOK", result: "Error! Invalid action or guid" };
    }
    if (job.pass) {
      verified.add(job.address);
    }
    return job.pass
      ? { status: "1", message: "OK", result: "Pass - Verified" }
      : { status: "0", message: "NOTOK", result: `Fail - Unable to verify${echo}` };
  };

  const sourcify = (method: string, parts: readonly string[], body: string): [number, unknown] => {
    const [kind = "", first = "", second = ""] = parts;
    const address = second.toLowerCase();
    if (method === "GET" && kind === "contract") {
      const match = verified.has(address) ? "exact_match" : null;
      return [
        match === null ? 404 : 200,
        { match, creationMatch: match, runtimeMatch: match, chainId: first, address: second },
      ];
    }
    if (method === "POST" && kind === "verify") {
      if (verified.has(address)) {
        return [409, { customCode: "already_verified", message: "already verified" }];
      }
      const input = membersOf(JSON.parse(body)).get("stdJsonInput");
      const id = `00000000-0000-4000-8000-${jobId(12)}`;
      jobs.set(id, { address, pass: passes(address, membersOf(input).get("sources"), null) });
      return [202, { verificationId: id }];
    }
    const job = jobs.get(first);
    if (job === undefined) {
      return [404, { customCode: "not_found", message: "Not found" }];
    }
    if (job.pass) {
      verified.add(job.address);
    }
    const match = job.pass ? "exact_match" : null;
    const error = {
      customCode: "no_match",
      message: `The deployed and recompiled bytecode don't match.${echo}`,
    };
    return [
      200,
      {
        isJobCompleted: true,
        verificationId: first,
        contract: { match, creationMatch: match, runtimeMatch: match, address: job.address },
        ...(job.pass ? {} : { error }),
      },
    ];
  };

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const url = new URL(String(request.url), "http://127.0.0.1");
      const method = String(request.method);
      const [status, answer] = url.pathname.startsWith("/v2/")
        ? sourcify(method, url.pathname.slice(4).split("/"), body)
        : [
            200,
            etherscan(new URLSearchParams([...url.searchParams, ...new URLSearchParams(body)])),
          ];
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      // Every answer is an object; with an echo, it carries the secret in one more member.
      response.end(
        JSON.stringify({
          ...Object.fromEntries(membersOf(answer)),
          ...(echo === "" ? {} : { echo }),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
