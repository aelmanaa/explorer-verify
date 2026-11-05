// Tests for the live matrix script (#66, R-QA-2). They run the script against the local fake
// explorer only, with a dummy key: no network call. Where a target has no `apiUrl`, a stub `fetch`
// sends the library's requests for the public hosts to a fake instead. The fake answers at once,
// but the library waits `pollIntervalMs` (at least 1 s) between polls, so a run takes seconds.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalSources, startFake } from "../live-matrix-fake.ts";
import type { Fake, FakeContract } from "../live-matrix-fake.ts";
import {
  CASES,
  PlanError,
  checkOutput,
  describeRequest,
  main,
  noteOf,
  parseContract,
  parsePlan,
  watchFetch,
  withWrongSource,
} from "../live-matrix.ts";
import type { CaseLine, RecordEntry } from "../live-matrix.ts";

const SCRIPT = fileURLToPath(new URL("../live-matrix.ts", import.meta.url));
const FIXTURES = fileURLToPath(new URL("fixtures/live-matrix/", import.meta.url));
const PLAN = path.join(FIXTURES, "plan.json");
const KEY = "dummyKeyForTests01";
const ENV = { LIVE_MATRIX_DUMMY_KEY: KEY };
const work = mkdtempSync(path.join(tmpdir(), "live-matrix-"));
const originalFetch = globalThis.fetch;

after(() => {
  rmSync(work, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the script in a new process with `env` added to this one's. */
async function runScript(args: readonly string[], env: Record<string, string> = {}): Promise<Run> {
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", SCRIPT, ...args],
      { encoding: "utf8", env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr });
      },
    );
  });
}

/** Runs `main` in this process and returns its exit code and lines, by `<target> <case>`. */
async function runMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = ENV,
): Promise<{ code: number; lines: Map<string, Record<string, unknown>>; text: string[] }> {
  const text: string[] = [];
  const code = await main(argv, env, (line) => {
    text.push(line);
  });
  const lines = new Map(
    text.map((line) => {
      const value: unknown = JSON.parse(line);
      assert.ok(typeof value === "object" && value !== null);
      const fields = new Map(Object.entries(value));
      return [
        `${String(fields.get("target"))} ${String(fields.get("case"))}`,
        Object.fromEntries(fields),
      ];
    }),
  );
  return { code, lines, text };
}

/** Writes a plan into the work folder, with contract paths made absolute. */
function writePlan(fileName: string, targets: readonly Record<string, unknown>[]): string {
  const file = path.join(work, fileName);
  const absolute = targets.map((each) => {
    const contracts: unknown = each["contracts"];
    return typeof contracts !== "object" || contracts === null
      ? each
      : {
          ...each,
          contracts: Object.fromEntries(
            Object.entries(contracts).map(([role, relative]) => [
              role,
              path.join(FIXTURES, String(relative)),
            ]),
          ),
        };
  });
  writeFileSync(file, JSON.stringify({ targets: absolute }));
  return file;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8"));
}

/** A target on the fake, changed by `change`. */
function fake(change: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "fake",
    backend: "etherscan-compatible",
    chain: "Local fake",
    chainId: 11155111,
    apiUrl: "fake",
    keyEnv: "LIVE_MATRIX_DUMMY_KEY",
    timeoutMs: 20_000,
    pollIntervalMs: 1000,
    noCode: "0x00000000000000000000000000000000000000c0",
    wrongEdit: { from: "MARK = 660402", to: "MARK = 660403" },
    contracts: { fresh: "fresh.json", resume: "resume.json" },
    cases: [1],
    ...change,
  };
}

/** A plan of one fake target. */
function target(change: Record<string, unknown>): unknown {
  return { targets: [fake(change)] };
}

/** The offline fresh contract file, changed by `change`. */
function contractWith(
  change: (input: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  const value: unknown = readJson("fresh.json");
  assert.ok(typeof value === "object" && value !== null);
  return change(Object.fromEntries(Object.entries(value)));
}

/** The fake's view of an offline contract file. */
function fakeContract(file: string): FakeContract {
  const contract = parseContract(readJson(file), file);
  return {
    address: contract.address,
    sources: canonicalSources(contract.input.sources),
    constructorArgs: contract.constructorArgs,
    creationCode: `${contract.creationBytecode}${contract.constructorArgs.slice(2)}`,
  };
}

/** A case line for the note tests. */
function caseLine(change: Partial<CaseLine>): CaseLine {
  return {
    target: "t",
    backend: "sourcify",
    chain: "Sepolia",
    chainId: 11155111,
    case: 1,
    name: CASES[1],
    address: "0xab",
    expected: "verified exact",
    actual: "verified exact",
    ok: true,
    durationMs: 1500,
    requests: ["GET /v2/contract"],
    ...change,
  };
}

/**
 * Sends requests for sourcify.dev and api.etherscan.io to `tables`, and for explorer.example to
 * `standalone`, as if those were the public hosts.
 */
function routeToFakes(tables: Fake, standalone: Fake): void {
  const bases = new Map([
    ["sourcify.dev", tables.url],
    ["api.etherscan.io", `${tables.url}/api`],
    ["explorer.example", `${standalone.url}/api`],
  ]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const base = bases.get(url.host);
    if (base === undefined) {
      return await originalFetch(input, init);
    }
    const rest = url.host === "sourcify.dev" ? url.pathname.replace(/^\/server/, "") : "";
    const answer = await originalFetch(`${base}${rest}${url.search}`, init);
    // A new Response, so the library sees no URL other than the one it asked for.
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  };
}

describe("live matrix against the local fake explorer", () => {
  it("runs every case in new processes, one JSON line per case, with no key in any output (R-SEC-1)", async () => {
    const note = path.join(work, "note.md");
    const record = path.join(work, "record.jsonl");
    const run = await runScript([PLAN, "--note", note, "--record", record], ENV);
    assert.equal(run.code, 0, run.stderr);
    const lines = run.stdout
      .trim()
      .split("\n")
      .map((line): Map<string, unknown> => {
        const value: unknown = JSON.parse(line);
        assert.ok(typeof value === "object" && value !== null);
        return new Map(Object.entries(value));
      });
    assert.deepEqual(
      lines.map((line) => Number(line.get("case"))).toSorted((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    for (const line of lines) {
      assert.equal(line.get("ok"), true, JSON.stringify([...line]));
    }
    const byCase = new Map(lines.map((line) => [line.get("case"), line]));
    assert.equal(
      byCase.get(2)?.get("actual"),
      "already-verified exact without a submit, no explorerUrl",
    );
    assert.equal(byCase.get(6)?.get("detail"), "getcontractcreation requests: 1");
    assert.deepEqual(byCase.get(8)?.get("requests"), []);
    assert.match(String(byCase.get(3)?.get("detail")), /^handle ev1:etherscan-compatible:/);
    const noteText = readFileSync(note, "utf8");
    const recordText = readFileSync(record, "utf8");
    assert.match(noteText, /8 cases, 0 unexpected/);
    assert.match(noteText, /- explorer-verify: \d+\.\d+\.\d+/);
    assert.match(noteText, /\| 3 resume \| `etherscan-compatible` \|/);
    assert.match(recordText, /"request":"POST verifysourcecode"/);
    for (const output of [run.stdout, run.stderr, noteText, recordText]) {
      assert.ok(!output.includes(KEY), "the dummy key must not appear in any output");
    }
  });

  it("goes to the routing table's hosts for a target without apiUrl, with the expected pages", async () => {
    const contracts = ["fresh.json", "resume.json", "cross.json"].map(fakeContract);
    const tables = await startFake({ contracts, key: KEY });
    const standalone = await startFake({ contracts });
    try {
      routeToFakes(tables, standalone);
      const plan = writePlan("tables.json", [
        fake({
          id: "sourcify",
          backend: "sourcify",
          apiUrl: undefined,
          keyEnv: undefined,
          explorerUrl: "https://repo.sourcify.dev/11155111/{address}",
          cases: [1, 2, 5],
        }),
        fake({
          id: "etherscan",
          backend: "etherscan-v2",
          apiUrl: undefined,
          explorerUrl: "https://sepolia.etherscan.io/address/{address}#code",
          contracts: { fresh: "resume.json", cross: "cross.json" },
          // The cross route goes to a fake of its own, which forwards nothing to `tables`.
          cross: { backend: "sourcify", apiUrl: "fake", waitMs: 5, pollMs: 1 },
          cases: [1, 7, 8],
        }),
        // A standalone explorer that takes no key: case 8 gets a result instead of an error.
        fake({ id: "standalone", apiUrl: "https://explorer.example/api", cases: [8] }),
      ]);
      const { code, lines, text } = await runMain([plan]);
      assert.equal(code, 1);
      const address = (file: string): string => parseContract(readJson(file), file).address;
      assert.equal(
        lines.get("sourcify 1")?.["explorerUrl"],
        `https://repo.sourcify.dev/11155111/${address("fresh.json")}`,
      );
      assert.equal(lines.get("sourcify 2")?.["ok"], true);
      assert.equal(lines.get("sourcify 5")?.["actual"], "lookup none");
      assert.equal(
        lines.get("etherscan 1")?.["explorerUrl"],
        `https://sepolia.etherscan.io/address/${address("resume.json")}#code`,
      );
      assert.equal(lines.get("etherscan 1")?.["ok"], true);
      assert.equal(lines.get("etherscan 8")?.["actual"], "threw missing-api-key after 0 requests");
      assert.equal(lines.get("etherscan 8")?.["ok"], true);
      // The forwarding never came: the lookup stayed none, so the second verify submitted.
      assert.equal(lines.get("etherscan 7")?.["ok"], false);
      assert.match(String(lines.get("etherscan 7")?.["actual"]), /then verified exact$/);
      assert.match(String(lines.get("etherscan 7")?.["detail"]), /^lookup none after \d+ ms$/);
      assert.equal(lines.get("standalone 8")?.["actual"], "returned verified");
      assert.ok(text.every((line) => !line.includes(KEY)));
    } finally {
      await tables.close();
      await standalone.close();
    }
  });

  it("resumes on a table route with the key in apiKeys, and reports what checkStatus threw", async () => {
    const tables = await startFake({ contracts: [], key: KEY });
    try {
      routeToFakes(tables, tables);
      const payload = JSON.stringify({
        handle: `ev1:etherscan-v2:11155111:0x${"0".repeat(38)}a1:${"f".repeat(50)}`,
        backend: "etherscan-v2",
        keyEnv: "LIVE_MATRIX_DUMMY_KEY",
        timeoutMs: 20_000,
        pollIntervalMs: 1000,
      });
      const { code, text } = await runMain(["--resume", payload]);
      assert.equal(code, 0);
      const [line = ""] = text;
      assert.match(line, /^\{"status":"threw [a-z-]+: /);
      assert.match(line, /"POST checkverifystatus"/);
      await assert.rejects(
        runMain(["--resume", JSON.stringify({ backend: "etherscan" })]),
        /backend is not a backend name/,
      );
    } finally {
      await tables.close();
    }
  });

  it("returns 1 and marks the case when an explorer verifies a wrong source (R-FLOW-4)", async () => {
    const plan = writePlan("accept-all.json", [fake({ fakeVerdict: "accept-all", cases: [4] })]);
    const { code, lines } = await runMain([plan]);
    assert.equal(code, 1);
    assert.equal(lines.get("fake 4")?.["ok"], false);
    assert.equal(lines.get("fake 4")?.["actual"], "verified exact");
  });

  it("returns 1 when an explorer rejects every submission", async () => {
    const plan = writePlan("reject-all.json", [
      fake({ cases: [1, 3], fakeVerdict: "reject-all" }),
      fake({
        id: "cross",
        backend: "etherscan-v2",
        contracts: { fresh: "fresh.json", cross: "cross.json" },
        cross: { backend: "sourcify", apiUrl: "fake", waitMs: 0, pollMs: 0 },
        fakeVerdict: "reject-all",
        cases: [7],
      }),
    ]);
    const { code, lines } = await runMain([plan]);
    assert.equal(code, 1);
    assert.match(String(lines.get("fake 1")?.["actual"]), /^failed: /);
    assert.match(String(lines.get("fake 3")?.["actual"]), /then failed: .* in a new process$/);
    assert.match(String(lines.get("cross 7")?.["actual"]), /^failed on sourcify: /);
    for (const line of lines.values()) {
      assert.equal(line["ok"], false);
    }
  });

  it("reports a case that cannot run, a second verify that submits nothing and a key asked for late", async () => {
    const plan = writePlan("broken.json", [
      // Sourcify takes no key: the call throws invalid-input, which the case reports.
      fake({ id: "sourcify", backend: "sourcify", cases: [1] }),
      // The resume contract is the one case 1 verified: case 3 gets already-verified, no submit.
      fake({ id: "same", contracts: { fresh: "fresh.json", resume: "fresh.json" }, cases: [1, 3] }),
      // etherscan-compatible needs no key up front; the fake asks for it after the first request.
      fake({ id: "late-key", cases: [8] }),
      // An explorer page that differs from the one expected.
      fake({ id: "page", explorerUrl: "https://example.org/{address}", cases: [1] }),
      // A wrong-source edit that is not in the source.
      fake({ id: "edit", wrongEdit: { from: "absent", to: "x" }, cases: [4] }),
    ]);
    const { code, lines } = await runMain([plan]);
    assert.equal(code, 1);
    assert.match(String(lines.get("sourcify 1")?.["actual"]), /^threw invalid-input: /);
    // A case that throws keeps what it expected and the address it used.
    assert.equal(lines.get("sourcify 1")?.["expected"], "verified exact");
    assert.equal(
      lines.get("sourcify 1")?.["address"],
      parseContract(readJson("fresh.json"), "fresh.json").address,
    );
    assert.equal(lines.get("edit 4")?.["expected"], "failed with the explorer's reason");
    assert.match(
      String(lines.get("same 3")?.["actual"]),
      /returned already-verified instead of rejecting/,
    );
    assert.equal(lines.get("same 1")?.["ok"], true);
    assert.equal(lines.get("late-key 8")?.["actual"], "threw missing-api-key after 1 requests");
    assert.equal(lines.get("late-key 8")?.["ok"], false);
    assert.equal(lines.get("page 1")?.["ok"], false);
    assert.match(
      String(lines.get("edit 4")?.["actual"]),
      /wrongEdit.from is not in src\/OfflineResume.sol/,
    );
  });

  it("rejects a wrong command line or a missing key with a plan error", async () => {
    await assert.rejects(runMain([]), (error: unknown) => error instanceof PlanError);
    await assert.rejects(runMain([PLAN, PLAN]), /usage: /);
    await assert.rejects(runMain([PLAN, "--note"]), /usage: /);
    await assert.rejects(runMain([PLAN, "--fast"]), /unknown option --fast/);
    for (const env of [{}, { LIVE_MATRIX_DUMMY_KEY: "" }]) {
      await assert.rejects(runMain([PLAN], env), /set LIVE_MATRIX_DUMMY_KEY in the environment/);
    }
  });

  it("checks every target's key before any target starts", async () => {
    const plan = writePlan("second-key.json", [
      fake({ id: "first", cases: [1] }),
      fake({ id: "second", keyEnv: "LIVE_MATRIX_SECOND_KEY", cases: [1] }),
    ]);
    const text: string[] = [];
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      requests += 1;
      return await originalFetch(input, init);
    };
    await assert.rejects(
      main([plan], ENV, (line) => {
        text.push(line);
      }),
      /set LIVE_MATRIX_SECOND_KEY in the environment/,
    );
    assert.deepEqual(text, []);
    assert.equal(requests, 0);
  });

  it("runs on a chain outside the testnet list only with --allow-mainnet", async () => {
    const plan = writePlan("mainnet.json", [fake({ chainId: 1, contracts: undefined, cases: [] })]);
    await assert.rejects(runMain([plan]), /chainId 1 is not a known testnet; pass --allow-mainnet/);
    assert.equal((await runMain([plan, "--allow-mainnet"])).code, 0);
  });

  it("exits 2 on a plan error and 1 on any other failure, with no key on stderr (R-SEC-1)", async () => {
    const usage = await runScript([]);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /usage: /);
    const missing = await runScript([path.join(work, "absent.json")]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /ENOENT/);
    // The note cannot be written: the error names the path, which holds the key.
    const plan = writePlan("note-error.json", [fake({ cases: [5] })]);
    const failed = await runScript([plan, "--note", path.join(work, KEY, "note.md")], ENV);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /ENOENT.*\[redacted\]/);
    assert.ok(!failed.stderr.includes(KEY));
  });

  it("redacts a secret the explorer echoes from every line, the note and the record (R-SEC-1)", async () => {
    // The fake echoes a second secret, which the library never sees, in its key errors, failure
    // reasons and answer bodies. Only the script's own redaction can remove it, so removing that
    // redaction from any write makes the write throw and this test fail.
    const echo = "echoSecretValue42";
    const plan = writePlan("echo.json", [
      fake({ id: "form", fakeEcho: "LIVE_MATRIX_ECHO", cases: [1, 4, 8] }),
      fake({
        id: "sourcify",
        backend: "sourcify",
        keyEnv: undefined,
        fakeEcho: "LIVE_MATRIX_ECHO",
        cases: [4],
      }),
    ]);
    const note = path.join(work, "echo-note.md");
    const record = path.join(work, "echo-record.jsonl");
    const run = await runScript([plan, "--note", note, "--record", record], {
      ...ENV,
      LIVE_MATRIX_ECHO: echo,
    });
    // Case 8 on etherscan-compatible sends one request, so it is not as expected.
    assert.equal(run.code, 1, run.stderr);
    assert.equal(run.stdout.trim().split("\n").length, 4);
    const outputs = [
      run.stdout,
      run.stderr,
      readFileSync(note, "utf8"),
      readFileSync(record, "utf8"),
    ];
    for (const output of outputs) {
      assert.ok(!output.includes(echo), "the echoed secret must not appear in any output");
      assert.ok(!output.includes(KEY), "the key must not appear in any output");
    }
    // The echo reached each output and was redacted there.
    assert.match(run.stdout, /Fail - Unable to verify \[redacted\]/);
    assert.match(run.stdout, /don't match\. \[redacted\]/);
    assert.match(readFileSync(note, "utf8"), /\[redacted\]/);
    assert.match(readFileSync(record, "utf8"), /Missing\/Invalid API Key \[redacted\]/);
  });
});

describe("parsePlan", () => {
  it("reads the offline plan", () => {
    const plan = parsePlan(readJson("plan.json"), readJson);
    assert.deepEqual(plan.tools, { forge: "offline fixture" });
    assert.deepEqual(
      plan.targets.map((each) => [each.id, each.backend, each.cases]),
      [
        ["etherscan-compatible/fake", "etherscan-compatible", [1, 2, 3, 4, 5]],
        ["etherscan-v2/fake", "etherscan-v2", [6, 7, 8]],
      ],
    );
    assert.equal(plan.targets[1]?.cross?.route.backend, "sourcify");
    assert.equal(plan.targets[0]?.timeoutMs, 20_000);
  });

  it("uses the defaults, and reads a target with no contracts and no cases", () => {
    const plan = parsePlan(
      target({
        timeoutMs: undefined,
        pollIntervalMs: undefined,
        contracts: { fresh: "fresh.json", cross: "cross.json" },
        cross: { backend: "sourcify" },
        cases: [7],
      }),
      readJson,
    );
    assert.equal(plan.targets[0]?.timeoutMs, 300_000);
    assert.equal(plan.targets[0]?.pollIntervalMs, 5000);
    assert.equal(plan.targets[0]?.fakeVerdict, "honest");
    assert.deepEqual(plan.targets[0]?.cross, {
      route: { backend: "sourcify" },
      waitMs: 300_000,
      pollMs: 15_000,
    });
    const empty = parsePlan({ targets: [fake({ contracts: undefined, cases: [] })] }, readJson);
    assert.deepEqual(empty.targets[0]?.contracts, {});
    assert.deepEqual(empty.tools, {});
    const mainnet = parsePlan(target({ chainId: 1, contracts: undefined, cases: [] }), readJson, {
      allowMainnet: true,
    });
    assert.equal(mainnet.targets[0]?.chainId, 1);
  });

  const errors: [string, unknown, RegExp][] = [
    ["a plan that is not an object", [], /plan must be an object/],
    ["no targets", { targets: [] }, /plan.targets must be a non-empty array/],
    [
      "a tool version that is not text",
      { tools: { forge: 1 }, targets: [fake({})] },
      /plan.tools.forge/,
    ],
    ["a repeated id", { targets: [fake({}), fake({})] }, /id fake is used twice/],
    ["an unknown backend", target({ backend: "etherscan" }), /backend is not a backend name/],
    [
      "an unknown contract role",
      target({ contracts: { other: "fresh.json" } }),
      /contracts.other is not/,
    ],
    ["a case out of range", target({ cases: [9] }), /holds 9, not a case number/],
    ["cases that are not a list", target({ cases: 1 }), /cases must be an array/],
    [
      "a case without its contract",
      target({ contracts: {}, cases: [3] }),
      /runs case 3 but has no contracts.resume/,
    ],
    [
      "case 4 without an edit",
      target({ wrongEdit: undefined, cases: [4] }),
      /runs case 4 but has no wrongEdit/,
    ],
    [
      "case 8 without a key",
      target({ keyEnv: undefined, cases: [8] }),
      /runs case 8 but has no keyEnv/,
    ],
    ["a negative budget", target({ timeoutMs: -1 }), /timeoutMs must be a non-negative integer/],
    ["an address that is not hex", target({ noCode: "c0" }), /noCode must be 0x-prefixed hex/],
    ["an empty chain name", target({ chain: "" }), /chain must be a non-empty string/],
    [
      "an unknown cross backend",
      target({ cross: { backend: "nope" } }),
      /cross.backend is not a backend name/,
    ],
    ["an unknown fake verdict", target({ fakeVerdict: "lenient" }), /fakeVerdict must be honest/],
    [
      "a contract on another chain than its target",
      target({ chainId: 421614 }),
      /contracts.fresh is on chain 11155111, not 421614/,
    ],
    [
      "a chain outside the testnet list",
      target({ chainId: 1, contracts: undefined, cases: [] }),
      /chainId 1 is not a known testnet; pass --allow-mainnet to run on it/,
    ],
  ];
  for (const [name, plan, message] of errors) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => parsePlan(plan, readJson),
        (error: unknown) => error instanceof PlanError && message.test(error.message),
      );
    });
  }
});

describe("parseContract", () => {
  it("reads a contract file", () => {
    const parsed = parseContract(readJson("fresh.json"), "fresh.json");
    assert.equal(parsed.contractName, "src/OfflineFresh.sol:OfflineFresh");
    assert.deepEqual(Object.keys(parsed.input.sources), ["src/OfflineFresh.sol"]);
  });

  it("rejects an input that is not Solidity", () => {
    assert.throws(
      () =>
        parseContract(
          contractWith((value) => ({ ...value, input: { language: "Vyper" } })),
          "c",
        ),
      /c input.language must be Solidity/,
    );
  });

  it("rejects a source without text", () => {
    assert.throws(
      () =>
        parseContract(
          contractWith((value) => ({
            ...value,
            input: { language: "Solidity", sources: { "a.sol": { content: 1 } }, settings: {} },
          })),
          "c",
        ),
      /c input.sources.a.sol.content must be a string/,
    );
  });
});

describe("helpers", () => {
  it("names a request by its action or Sourcify path, without values", () => {
    const form = new URLSearchParams({ action: "verifysourcecode", apikey: KEY });
    assert.equal(
      describeRequest(new URL("https://api.etherscan.io/v2/api"), "POST", form),
      "POST verifysourcecode",
    );
    assert.equal(
      describeRequest(
        new URL("https://x.example/api?module=contract&action=getsourcecode"),
        "GET",
        undefined,
      ),
      "GET getsourcecode",
    );
    assert.equal(
      describeRequest(new URL("https://sourcify.dev/server/v2/verify/ab-12"), "GET", undefined),
      "GET /v2/verify",
    );
    assert.equal(describeRequest(new URL("https://x.example/other"), "GET", "body"), "GET other");
  });

  it("records a request outside a case as received, and puts the fetch back", async () => {
    globalThis.fetch = async () => await Promise.resolve(new Response(`{"key":"${KEY}"}`));
    const record: RecordEntry[] = [];
    const restore = watchFetch(record);
    await fetch(new Request(`https://x.example/api?action=getsourcecode&apikey=${KEY}`));
    restore();
    assert.equal(record.length, 1);
    assert.equal(record[0]?.case, "outside a case");
    assert.equal(record[0]?.request, "GET getsourcecode");
    // The record keeps the answer as received; only its write redacts and checks it.
    assert.throws(() => checkOutput(JSON.stringify(record), [KEY]), /a secret is in the output/);
  });

  it("refuses to write text that holds a secret, and passes text without one (R-SEC-1)", () => {
    assert.throws(
      () => checkOutput(`reason: Invalid API Key ${KEY}`, [KEY]),
      /nothing was written/,
    );
    assert.equal(
      checkOutput("reason: Invalid API Key [redacted]", [KEY]),
      "reason: Invalid API Key [redacted]",
    );
    assert.equal(checkOutput("anything", []), "anything");
  });

  it("changes the source of the contract's own file only", () => {
    const contract = parseContract(readJson("resume.json"), "resume.json");
    const input = {
      chainId: contract.chainId,
      address: contract.address,
      compiler: { kind: "solc" as const, version: contract.compilerVersion, input: contract.input },
      contractName: contract.contractName,
    };
    const wrong = withWrongSource(input, { from: "MARK = 660402", to: "MARK = 660403" });
    assert.match(
      wrong.compiler.input.sources["src/OfflineResume.sol"]?.content ?? "",
      /MARK = 660403/,
    );
    assert.throws(
      () => withWrongSource({ ...input, contractName: "other.sol:X" }, { from: "a", to: "b" }),
      PlanError,
    );
  });

  it("writes failed rows in bold and links an explorer page", () => {
    const text = noteOf(
      [
        caseLine({ explorerUrl: "https://repo.sourcify.dev/11155111/0xab" }),
        caseLine({
          case: 4,
          name: CASES[4],
          ok: false,
          actual: "a | b",
          detail: "reason: x",
          requests: [],
        }),
        caseLine({ address: "" }),
      ],
      { started: "s", finished: "f", versions: { node: "v24" } },
    );
    assert.match(text, /Run from s to f\. 3 cases, 1 unexpected\./);
    assert.match(text, /- node: v24/);
    assert.match(text, /\[`0xab`\]\(https:\/\/repo.sourcify.dev\/11155111\/0xab\)/);
    assert.match(text, /\| a \\\| b \| \*\*no\*\* \| 1\.5 \| reason: x \|/);
    assert.match(text, /\| 1 verify \| `sourcify` \| Sepolia \(11155111\) \|  \|/);
  });

  it("writes sources in path order, and null for a source without text", () => {
    assert.equal(
      canonicalSources({ "b.sol": { content: "2" }, "a.sol": { content: "1" } }),
      '[["a.sol","1"],["b.sol","2"]]',
    );
    assert.equal(canonicalSources({ "a.sol": {} }), '[["a.sol",null]]');
    assert.equal(canonicalSources(null), "[]");
  });

  it("answers a wrong key, an unknown action, guid, creation or Sourcify job", async () => {
    const server = await startFake({ contracts: [], key: KEY });
    const post = async (fields: Record<string, string>): Promise<unknown> =>
      await (
        await fetch(`${server.url}/api`, { method: "POST", body: new URLSearchParams(fields) })
      ).json();
    try {
      assert.deepEqual(await post({ action: "getsourcecode", apikey: "wrongKeyValue1" }), {
        status: "0",
        message: "NOTOK",
        result: "Invalid API Key",
      });
      const unknown = { status: "0", message: "NOTOK", result: "Error! Invalid action or guid" };
      assert.deepEqual(await post({ apikey: KEY }), unknown);
      assert.deepEqual(
        await post({ action: "checkverifystatus", guid: "x", apikey: KEY }),
        unknown,
      );
      assert.deepEqual(
        await post({ action: "getcontractcreation", contractaddresses: "0xab", apikey: KEY }),
        { status: "0", message: "No data found", result: null },
      );
      const job = await fetch(`${server.url}/v2/verify/unknown`);
      assert.equal(job.status, 404);
    } finally {
      await server.close();
    }
  });

  it("answers already verified to a second submit on either API", async () => {
    const contract = fakeContract("fresh.json");
    const server = await startFake({ contracts: [contract] });
    const submit = async (): Promise<Response> =>
      await fetch(`${server.url}/v2/verify/11155111/${contract.address}`, {
        method: "POST",
        body: JSON.stringify({ stdJsonInput: { sources: readJson("fresh.json") } }),
      });
    try {
      const first: unknown = await (await submit()).json();
      assert.ok(typeof first === "object" && first !== null);
      const id = String(new Map(Object.entries(first)).get("verificationId"));
      await fetch(`${server.url}/v2/verify/${id}`);
      // The sources sent were wrong, so nothing is verified yet: the form API submits.
      const form = new URLSearchParams({
        action: "verifysourcecode",
        contractaddress: contract.address,
        sourceCode: JSON.stringify({
          sources: parseContract(readJson("fresh.json"), "f").input.sources,
        }),
      });
      const guid: unknown = await (
        await fetch(`${server.url}/api`, { method: "POST", body: form })
      ).json();
      assert.ok(typeof guid === "object" && guid !== null);
      const status = new URLSearchParams({
        action: "checkverifystatus",
        guid: String(new Map(Object.entries(guid)).get("result")),
      });
      await fetch(`${server.url}/api?${status.toString()}`);
      assert.equal((await submit()).status, 409);
      assert.deepEqual(
        await (await fetch(`${server.url}/api`, { method: "POST", body: form })).json(),
        {
          status: "0",
          message: "NOTOK",
          result: "Contract source code already verified",
        },
      );
      assert.equal(
        (await fetch(`${server.url}/v2/contract/11155111/${contract.address}`)).status,
        200,
      );
    } finally {
      await server.close();
    }
  });
});
