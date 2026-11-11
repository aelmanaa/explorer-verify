// `verify` with an RPC URL on the built bin (R-IN-3, R-AX-9, R-SEC-1), checked against
// docs/user/reference/cli.md ("RPC URL"). One local server on 127.0.0.1 is both a standalone
// Etherscan-compatible explorer and a JSON-RPC endpoint, so the bin derives the constructor
// arguments from a creation transaction and the test reads what it submitted. The RPC URL holds
// two dummy secrets, in its path and in its query; no run may print either of them.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";
import type { BinOptions, BinResult } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 30_000 };
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const OWNER = "9d087fc03ae39b088326b67fa3c788236645b717";
const TX = `0x${"ab".repeat(32)}`;
// Plain lower-case dummies: only the CLI's own redaction can remove them.
const PATH_SECRET = "rpcpathsecretqwertyuiop";
const QUERY_SECRET = "rpcquerysecretasdfghjkl";
const SECRETS = [PATH_SECRET, QUERY_SECRET];
const FOUNDRY = [
  "--input",
  "out/build-info/greeter.json",
  "--input",
  "out/Greeter.sol/Greeter.json",
];
const FIXTURES = new URL("../../../explorer-verify/test/fixtures/etherscan/", import.meta.url);

/** A 32-byte word of `hex`, left-padded. */
function word(hex: string): string {
  return hex.padStart(64, "0");
}

// The Greeter's constructor takes (address owner_, string greeting_): here the owner and "hello".
const ARGS = [
  word(OWNER),
  word("40"),
  word("5"),
  Buffer.from("hello").toString("hex").padEnd(64, "0"),
].join("");

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

const ARTIFACT = record(
  JSON.parse(readFileSync(join(PROJECT, "out/Greeter.sol/Greeter.json"), "utf8")),
);
const CREATION = String(record(ARTIFACT["bytecode"])["object"]);

/** The body of a recorded Etherscan answer. */
function recordedBody(name: string): string {
  const body = record(
    record(JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")))["response"],
  )["body"];
  return typeof body === "string" ? body : JSON.stringify(body);
}

const NOT_VERIFIED = recordedBody("2026-11-03-getsourcecode-not-verified");
// The recorded lookup names ProbeAOmitted. The copy names the Greeter of this project, so the
// lookup after the submit finds this source rather than another contract's (decision 0063).
const VERIFIED = recordedBody("2026-11-03-getsourcecode-constructor-args-omitted").replace(
  '"ContractName":"ProbeAOmitted"',
  '"ContractName":"Greeter"',
);

/** What the server saw for one run, by the run's name in the path. */
interface Seen {
  submits: URLSearchParams[];
  rpcMethods: string[];
}

const seen = new Map<string, Seen>();

function seenOf(name: string): Seen {
  const found = seen.get(name) ?? { submits: [], rpcMethods: [] };
  seen.set(name, found);
  return found;
}

/** The answer of the fake JSON-RPC endpoint. `wrongchain` serves chain 1; `echo` repeats the URL. */
function rpcAnswer(kind: string, method: string, url: string): unknown {
  if (kind === "echo") {
    return { jsonrpc: "2.0", id: 1, error: { code: -32_000, message: `bad request to ${url}` } };
  }
  const results: Record<string, unknown> = {
    eth_chainId: kind === "wrongchain" ? "0x1" : "0xaa36a7",
    eth_getTransactionByHash: { hash: TX, to: null, input: `${CREATION}${ARGS}` },
    eth_getTransactionReceipt: { transactionHash: TX, contractAddress: ADDRESS, status: "0x1" },
  };
  return { jsonrpc: "2.0", id: 1, result: results[method] ?? null };
}

/**
 * `/api/<run>` is the explorer: not verified until a submit, which it answers as already
 * verified, so the run ends without a poll. `/rpc/<run>/<kind>/...` is the JSON-RPC endpoint.
 */
function answer(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = req.url ?? "";
  const [, area = "", name = "", kind = ""] = url.split("?")[0]?.split("/") ?? [];
  const run = seenOf(name);
  res.writeHead(200, { "content-type": "application/json" });
  if (area === "rpc") {
    const parsed = record(JSON.parse(body));
    const method = String(parsed["method"]);
    run.rpcMethods.push(method);
    res.end(JSON.stringify(rpcAnswer(kind, method, url)));
    return;
  }
  const form = new URLSearchParams(body);
  const action = form.get("action");
  if (action === "verifysourcecode") {
    run.submits.push(form);
    res.end('{"status":"0","message":"NOTOK","result":"Contract source code already verified"}');
    return;
  }
  res.end(run.submits.length === 0 ? NOT_VERIFIED : VERIFIED);
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Uint8Array) => {
    body += new TextDecoder().decode(chunk);
  });
  req.on("end", () => {
    answer(req, res, body);
  });
});
let base = "";
const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-rpc-url-"));

before(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  base = `http://127.0.0.1:${String(address.port)}`;
});
after(() => {
  server.close();
  rmSync(DIR, { recursive: true, force: true });
});

/** The RPC URL of a run, with both secrets. */
function secretUrl(name: string, kind = "ok"): string {
  return `${base}/rpc/${name}/${kind}/${PATH_SECRET}?token=${QUERY_SECRET}`;
}

function file(name: string, text: string): string {
  const path = join(DIR, name);
  writeFileSync(path, text);
  return path;
}

/** The route to the run's explorer on the local server. */
function route(name: string): string[] {
  return ["--backend", "etherscan-compatible", "--api-url", `${base}/api/${name}`];
}

/** Runs `verify` in the Foundry project, at the debug level, with JSON log lines. */
async function verifyRun(
  name: string,
  extra: readonly string[],
  options: BinOptions = {},
): Promise<BinResult> {
  return await runBin(
    [
      "verify",
      ADDRESS,
      "--chain",
      "11155111",
      ...FOUNDRY,
      "--creation-tx",
      TX,
      ...route(name),
      "--json",
      "--verbose",
      "--log-format",
      "json",
      ...extra,
    ],
    { cwd: PROJECT, ...options },
  );
}

/** Asserts that no secret of the RPC URL is on stdout or stderr, in any letter case. */
function assertNoSecret(result: BinResult, label: string): void {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), `${label}: a secret of the RPC URL is in the output`);
  }
}

/** The envelope on stdout, checked against the shipped schema. */
function envelope(result: BinResult): Record<string, unknown> {
  const parsed = oneEnvelope(result.stdout);
  assert.deepEqual(envelopeProblems(parsed), [], result.stdout);
  return record(parsed);
}

/** The `invalid-input` message, after checking exit code 2. */
function usage(result: BinResult): string {
  assert.equal(result.code, 2, result.stderr);
  const error = record(envelope(result)["error"]);
  assert.equal(error["code"], "invalid-input");
  return String(error["message"]);
}

/** The constructor arguments the run submitted, after checking it ended with exit code 0. */
function submittedArgs(name: string, result: BinResult): string | null {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(record(envelope(result)["result"])["status"], "already-verified");
  const [submit, more] = seenOf(name).submits;
  assert.ok(submit !== undefined && more === undefined, "one submit");
  return submit.get("constructorArguements");
}

describe(
  "bin: verify derives constructor arguments through an RPC URL (R-IN-3)",
  {
    concurrency: true,
  },
  () => {
    it("--rpc-url-file: derives and submits the arguments; prints no secret", TIMEOUT, async () => {
      const result = await verifyRun("file", [
        "--rpc-url-file",
        file("rpc.txt", `${secretUrl("file")}\n`),
      ]);
      assert.equal(submittedArgs("file", result), ARGS);
      assert.deepEqual(seenOf("file").rpcMethods, [
        "eth_chainId",
        "eth_getTransactionByHash",
        "eth_getTransactionReceipt",
      ]);
      assertNoSecret(result, "file");
    });

    it("--rpc-url-stdin: derives the arguments from a piped URL", TIMEOUT, async () => {
      const result = await verifyRun("stdin", ["--rpc-url-stdin"], {
        stdin: { text: `${secretUrl("stdin")}\r\n` },
      });
      assert.equal(submittedArgs("stdin", result), ARGS);
      assertNoSecret(result, "stdin");
    });

    it("--rpc-url: takes a URL with no part that can hold a key", TIMEOUT, async () => {
      const result = await verifyRun("flag", ["--rpc-url", `${base}/rpc/flag/ok`]);
      assert.equal(submittedArgs("flag", result), ARGS);
    });

    it(
      "--input-json with --rpc-url-file derives the same arguments (R-AX-16)",
      TIMEOUT,
      async () => {
        const request = record(
          JSON.parse(readFileSync(join(PROJECT, "verify-input.json"), "utf8")),
        );
        const requestFile = file(
          "request.json",
          JSON.stringify({
            ...request,
            creationTxHash: TX,
            creationBytecode: CREATION,
            route: { backend: "etherscan-compatible", apiUrl: `${base}/api/json` },
          }),
        );
        const result = await runBin([
          "verify",
          "--input-json",
          requestFile,
          "--rpc-url-file",
          file("rpc-json.txt", secretUrl("json")),
          "--json",
          "--verbose",
        ]);
        assert.equal(submittedArgs("json", result), ARGS);
        assertNoSecret(result, "input-json");
      },
    );

    it("--dry-run checks the URL and sends no JSON-RPC request (R-AX-8)", TIMEOUT, async () => {
      const result = await verifyRun("dry", [
        "--dry-run",
        "--rpc-url-file",
        file("rpc-dry.txt", secretUrl("dry")),
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(record(envelope(result)["result"])["status"], "dry-run");
      assert.deepEqual(seenOf("dry"), { submits: [], rpcMethods: [] });
      assertNoSecret(result, "dry-run");
    });

    it(
      "a URL holding the output's own words keeps the envelope and log lines whole (R-AX-5)",
      TIMEOUT,
      async () => {
        // Each word is a path segment of 8 or more characters, so each counts as a secret part.
        const words = "schemaVersion/etherscan-compatible/already-verified/verify";
        const url = `${base}/rpc/words/ok/${words}/${PATH_SECRET}`;
        const result = await verifyRun("words", ["--rpc-url-file", file("rpc-words.txt", url)]);
        assert.equal(submittedArgs("words", result), ARGS);
        const parsed = envelope(result);
        assert.equal(parsed["schemaVersion"], 1);
        assert.deepEqual(record(parsed["result"]), {
          status: "already-verified",
          backend: "etherscan-compatible",
          match: "exact",
        });
        for (const line of result.stderr.split("\n").filter(Boolean)) {
          assert.doesNotMatch(Object.keys(record(JSON.parse(line))).join(), /redacted/, line);
        }
        assertNoSecret(result, "words");
      },
    );
  },
);

describe(
  "bin: no secret of the RPC URL reaches any output (R-SEC-1, R-AX-9)",
  {
    concurrency: true,
  },
  () => {
    it(
      "refuses --rpc-url with a part that can hold a key, before any request",
      TIMEOUT,
      async () => {
        const results = await Promise.all([
          verifyRun("refused-path", ["--rpc-url", `${base}/rpc/refused/ok/${PATH_SECRET}`]),
          verifyRun("refused-query", ["--rpc-url", `${base}/rpc/refused/ok?token=${QUERY_SECRET}`]),
        ]);
        for (const result of results) {
          assert.match(usage(result), /--rpc-url has a part that can hold a key/);
          assertNoSecret(result, "refused");
        }
        assert.deepEqual(seenOf("refused"), { submits: [], rpcMethods: [] });
        assert.deepEqual(seenOf("refused-path"), { submits: [], rpcMethods: [] });
      },
    );

    it(
      "an endpoint of another chain exits 2 naming rpcUrl, before the submit",
      TIMEOUT,
      async () => {
        const result = await verifyRun("wrongchain", ["--rpc-url-stdin"], {
          stdin: { text: secretUrl("wrongchain", "wrongchain") },
        });
        assert.match(usage(result), /rpcUrl/);
        assert.equal(seenOf("wrongchain").submits.length, 0);
        assertNoSecret(result, "wrong chain");
      },
    );

    it("an endpoint that repeats its URL in an answer is not printed", TIMEOUT, async () => {
      const result = await verifyRun("echo", [
        "--rpc-url-file",
        file("rpc-echo.txt", secretUrl("echo", "echo")),
      ]);
      // No transaction was read, so the submit carries no arguments.
      assert.equal(submittedArgs("echo", result), null);
      assertNoSecret(result, "echo");
    });

    it("a URL the library refuses names rpcUrl and prints no secret", TIMEOUT, async () => {
      const results = await Promise.all([
        verifyRun("plain-http", [
          "--rpc-url-file",
          file("rpc-http.txt", `http://rpc.example.org/${PATH_SECRET}?token=${QUERY_SECRET}`),
        ]),
        verifyRun("userinfo", [
          "--rpc-url-file",
          file(
            "rpc-user.txt",
            `https://user:${PATH_SECRET}@rpc.example.org/?token=${QUERY_SECRET}`,
          ),
        ]),
        verifyRun("fragment", [
          "--rpc-url-file",
          file("rpc-fragment.txt", `https://rpc.example.org/${PATH_SECRET}#${QUERY_SECRET}`),
        ]),
      ]);
      for (const result of results) {
        assert.match(usage(result), /rpcUrl/);
        assertNoSecret(result, "refused by the library");
      }
    });

    it("a URL with a space is refused and not printed", TIMEOUT, async () => {
      const result = await verifyRun("space", [
        "--rpc-url-file",
        file("rpc-space.txt", `${secretUrl("space")} ${PATH_SECRET}`),
      ]);
      assert.match(usage(result), /--rpc-url-file must hold only the characters a URL allows/);
      assertNoSecret(result, "space");
    });
  },
);
