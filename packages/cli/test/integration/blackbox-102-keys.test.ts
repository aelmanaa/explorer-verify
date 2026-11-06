// Black-box regression tests for #102 (R-AX-9, R-SEC-1, R-SEC-2), written from the public docs
// only: docs/user/reference/cli.md ("API keys and route options") and
// docs/user/reference/api-keys.md ("From the CLI"). Each test spawns the built bin. Independent
// spawns run concurrently so the file stays fast on CI.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";

import { hasPty, makeFifo, runBin } from "../helpers/spawn-bin.ts";
import type { BinOptions, BinResult } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 30_000 };
const CONCURRENT = { concurrency: true };
// 32 lower-case letters: no generic redaction pattern would catch it.
const KEY = "qwertyuiopasdfghjklzxcvbnmqwerty";
const KEY2 = "zxcvbnmlkjhgfdsapoiuytrewqzxcvbn";
const API_URL = "https://explorer.example.org/api";
const NOT_UNIX = process.platform === "win32" ? "needs a Unix file system" : false;

const DIR = mkdtempSync(join(tmpdir(), "bb102-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function file(name: string, content: string | Uint8Array): string {
  const path = join(DIR, name);
  writeFileSync(path, content);
  return path;
}

function assertNoKey(result: BinResult, label: string, keys: readonly string[] = [KEY]): void {
  for (const key of keys) {
    const text = (result.stdout + result.stderr).toLowerCase();
    assert.ok(!text.includes(key.toLowerCase()), `${label}: key in the output`);
  }
}

/** A status run on an Etherscan handle: with the key set, the fake Etherscan answers verified. */
const STATUS = [
  "status",
  "ev1:etherscan-v2:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:cqmxkhtaudvs5yhbzgv5nryiczguab4g3ppjj6mb3gakhzxjcn",
];
/** An Etherscan-style handle of `backend` for the Greeter. */
function handle(backend: string): string {
  return `ev1:${backend}:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:cqmxkhtaudvs5yhbzgv5nryiczguab4g3ppjj6mb3gakhzxjcn`;
}
/** A status run on a Sourcify handle, which needs no key. */
const SOURCIFY_STATUS = [
  "status",
  "ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718",
];

/**
 * Runs the bin against the fake explorer, so no request leaves the machine. `bug` makes the
 * command throw an Error with that message once it has read its keys: an internal error.
 */
async function bin(
  args: readonly string[],
  options: BinOptions = {},
  bug?: string,
): Promise<BinResult> {
  return await runBin(args, { ...options, fake: bug === undefined ? {} : { bug } });
}

async function runFile(path: string, bug?: string): Promise<BinResult> {
  return await bin(
    [...STATUS, "--json", "--backend", "etherscan-v2", "--api-key-file", path],
    {},
    bug,
  );
}

/** Where a key comes from: extra arguments and the spawn options. */
interface Source {
  readonly name: string;
  readonly args: readonly string[];
  readonly options: BinOptions;
}

const SOURCES: readonly Source[] = [
  { name: "ETHERSCAN_API_KEY", args: [], options: { env: { ETHERSCAN_API_KEY: KEY } } },
  { name: "ROUTESCAN_API_KEY", args: [], options: { env: { ROUTESCAN_API_KEY: KEY } } },
  {
    name: "--api-key-file with --backend etherscan-v2",
    args: ["--backend", "etherscan-v2", "--api-key-file", file("k-lf.txt", `${KEY}\n`)],
    options: {},
  },
  {
    name: "--api-key-file with --backend routescan",
    args: ["--backend", "routescan", "--api-key-file", file("k-plain.txt", KEY)],
    options: {},
  },
  {
    name: "--api-key-file with --api-url",
    args: [
      "--backend",
      "etherscan-compatible",
      "--api-url",
      API_URL,
      "--api-key-file",
      file("k-crlf.txt", `${KEY}\r\n`),
    ],
    options: {},
  },
  {
    name: "--api-key-stdin with --backend etherscan-v2",
    args: ["--backend", "etherscan-v2", "--api-key-stdin"],
    options: { stdin: { text: `${KEY}\n` } },
  },
  {
    name: "--api-key-stdin with CRLF and --api-url",
    args: ["--backend", "etherscan-compatible", "--api-url", API_URL, "--api-key-stdin"],
    options: { stdin: { text: `${KEY}\r\n` } },
  },
];

const ALL_MODES: readonly (readonly string[])[] = [
  [],
  ["--json"],
  ["--verbose"],
  ["--quiet"],
  ["--verbose", "--log-format", "json"],
  ["--json", "--verbose", "--log-format", "json"],
  ["--json", "--quiet", "--log-format", "json"],
];
const SOME_MODES: readonly (readonly string[])[] = [
  ["--json", "--verbose", "--log-format", "json"],
  ["--verbose"],
];

// The internal error echoes the key in upper case, so the scrub must ignore letter case.
const LEAK = `boom ${KEY.toUpperCase()} boom`;
const OUTCOMES: readonly { args: readonly string[]; bug?: string; code: number }[] = [
  { args: [], code: 0 },
  // ETHERSCAN_API_KEY goes only to Etherscan's own API, so with --api-url on another host it is
  // not used (#244).
  {
    args: ["--backend", "etherscan-v2", "--api-url", "https://proxy.example.org/v2/api"],
    code: 3,
  },
  // Etherscan's own API given as --api-url takes ETHERSCAN_API_KEY (#244).
  {
    args: ["--backend", "etherscan-v2", "--api-url", "https://API.etherscan.io:443/v2/api/"],
    code: 0,
  },
  { args: [], bug: LEAK, code: 6 },
];

describe("blackbox #102: each key source never reaches stdout or stderr", CONCURRENT, () => {
  for (const source of SOURCES) {
    it(`${source.name}: an internal error that echoes the key`, TIMEOUT, async () => {
      const results = await Promise.all(
        SOME_MODES.map(
          async (mode) => await bin([...STATUS, ...mode, ...source.args], source.options, LEAK),
        ),
      );
      for (const [index, result] of results.entries()) {
        const label = `${source.name} ${(SOME_MODES[index] ?? []).join(" ")}`;
        assert.equal(result.code, 6, `${label}: ${result.stderr}`);
        assertNoKey(result, label);
        assert.match(result.stderr, /\[redacted\]/);
      }
    });
  }

  it("ETHERSCAN_API_KEY: every mode and outcome", { timeout: 60_000 }, async () => {
    const runs = ALL_MODES.flatMap((mode) => OUTCOMES.map((outcome) => ({ mode, outcome })));
    const results = await Promise.all(
      runs.map(
        async ({ mode, outcome }) =>
          await bin(
            [...STATUS, ...mode, ...outcome.args],
            { env: { ETHERSCAN_API_KEY: KEY } },
            outcome.bug,
          ),
      ),
    );
    for (const [index, result] of results.entries()) {
      const run = runs[index];
      assert.ok(run !== undefined);
      const label = [...run.mode, ...run.outcome.args, `exit ${String(run.outcome.code)}`].join(
        " ",
      );
      assert.equal(result.code, run.outcome.code, `${label}: ${result.stderr}`);
      assertNoKey(result, label);
    }
  });

  it("redacts both variables at once", TIMEOUT, async () => {
    const result = await bin(
      [...STATUS, "--json"],
      { env: { ETHERSCAN_API_KEY: KEY, ROUTESCAN_API_KEY: KEY2 } },
      `${KEY} ${KEY2}`,
    );
    assert.equal(result.code, 6);
    assertNoKey(result, "two keys", [KEY, KEY2]);
  });

  it("treats an empty variable as unset", TIMEOUT, async () => {
    // With no key, chain 11155111 routes to Sourcify, so the Sourcify handle is polled.
    const result = await bin([...SOURCIFY_STATUS, "--json"], {
      env: { ETHERSCAN_API_KEY: "", ROUTESCAN_API_KEY: "" },
    });
    assert.equal(result.code, 0, result.stderr);
  });
});

describe("blackbox #102: a bad key in a variable is a usage error naming it", () => {
  const bad = [`${KEY}&x`, "short", "1234567890123", `${KEY} `, `${KEY}/x`];
  it("exits 2 naming the variable, never the value", TIMEOUT, async () => {
    const runs = bad.map((value, index) => ({
      value,
      name: index % 2 === 0 ? "ETHERSCAN_API_KEY" : "ROUTESCAN_API_KEY",
    }));
    const results = await Promise.all(
      runs.map(
        async ({ value, name }) =>
          await bin([...SOURCIFY_STATUS, "--json", "--backend", "sourcify"], {
            env: { [name]: value },
          }),
      ),
    );
    for (const [index, result] of results.entries()) {
      const run = runs[index];
      assert.ok(run !== undefined);
      assert.equal(result.code, 2, result.stderr);
      assert.ok(result.stdout.includes(run.name), result.stdout);
      assert.ok(result.stderr.includes(run.name), result.stderr);
      assertNoKey(result, run.name, [run.value]);
    }
  });
});

describe("blackbox #102: key flags are refused, the value never echoed", () => {
  const forms: readonly (readonly string[])[] = [
    ["--api-key", KEY],
    ["--apikey", KEY],
    ["--api_key", KEY],
    ["--key", KEY],
    ["--etherscan-api-key", KEY],
    ["--etherscan-key", KEY],
    ["--routescan-api-key", KEY],
    [`--api-key=${KEY}`],
    [`--apikey=${KEY}`],
    [`--key=${KEY}`],
  ];
  it("exits 2 in both argument orders, with the hint", TIMEOUT, async () => {
    const runs = forms.flatMap((form) => [
      [...STATUS, "--json", ...form],
      [...form, ...STATUS, "--verbose"],
    ]);
    const results = await Promise.all(runs.map(async (args) => await bin(args)));
    for (const [index, result] of results.entries()) {
      const label = (runs[index] ?? []).join(" ").replace(KEY, "<KEY>");
      assert.equal(result.code, 2, `${label}: ${result.stderr}`);
      assertNoKey(result, label);
      const out = result.stderr + result.stdout;
      for (const word of ["ETHERSCAN_API_KEY", "--api-key-file", "--api-key-stdin"]) {
        assert.ok(out.includes(word), `${label}: the hint lacks ${word}`);
      }
    }
  });

  it("does not echo the value with a valid key also set", TIMEOUT, async () => {
    const result = await bin([...STATUS, "--json", "--api-key", KEY2], {
      env: { ETHERSCAN_API_KEY: KEY },
    });
    assert.equal(result.code, 2);
    assertNoKey(result, "both", [KEY, KEY2]);
  });
});

describe("blackbox #102: --api-key-file edge cases", CONCURRENT, () => {
  it("missing file: exit 2, path not named", TIMEOUT, async () => {
    // The path itself looks like a key: a key typed in place of a path must not be echoed.
    const [inDir, bare] = await Promise.all([runFile(join(DIR, KEY)), runFile(KEY)]);
    assert.ok(inDir !== undefined && bare !== undefined);
    assert.equal(inDir.code, 2);
    assertNoKey(inDir, "missing");
    assert.equal(bare.code, 2);
    assertNoKey(bare, "missing bare");
  });

  it("an empty file or a lone newline: exit 2", TIMEOUT, async () => {
    for (const result of await Promise.all([
      runFile(file("empty.txt", "")),
      runFile(file("nl.txt", "\n")),
    ])) {
      assert.equal(result.code, 2);
    }
  });

  it("a directory: exit 2, path not named", TIMEOUT, async () => {
    const path = join(DIR, `${KEY}-dir`);
    mkdirSync(path);
    const result = await runFile(path);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /must name a regular file/);
    assertNoKey(result, "dir");
  });

  it("a FIFO with no writer: exit 2 at once", { ...TIMEOUT, skip: NOT_UNIX }, async () => {
    const fifo = join(DIR, "key.fifo");
    makeFifo(fifo);
    const result = await runFile(fifo);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /must name a regular file; pipe the key with --api-key-stdin/);
  });

  it("a device (/dev/null, /dev/zero): exit 2", { ...TIMEOUT, skip: NOT_UNIX }, async () => {
    for (const result of await Promise.all([runFile("/dev/null"), runFile("/dev/zero")])) {
      assert.equal(result.code, 2);
      assert.match(result.stdout, /must name a regular file/);
    }
  });

  it("a trailing CRLF is removed, and the key is redacted", TIMEOUT, async () => {
    const result = await runFile(file("crlf.txt", `${KEY}\r\n`), `x ${KEY} y`);
    assert.equal(result.code, 6, result.stderr);
    assert.match(result.stdout, /\[redacted\]/);
    assertNoKey(result, "crlf");
  });

  it("bad contents: exit 2, never echoed", TIMEOUT, async () => {
    const contents = [`${KEY}\n\n`, `${KEY}\r`, `${KEY}&`, `${KEY}\n${KEY2}\n`, "a".repeat(1025)];
    const results = await Promise.all(
      contents.map(async (text, index) => await runFile(file(`bad-${String(index)}.txt`, text))),
    );
    for (const result of results) {
      assert.equal(result.code, 2);
      assertNoKey(result, "bad contents", [KEY, KEY2]);
    }
  });

  it("an oversized file (16 MiB): exit 2 without repeating it", TIMEOUT, async () => {
    const result = await runFile(file("huge.txt", new Uint8Array(16 * 1024 * 1024).fill(0x61)));
    assert.equal(result.code, 2);
    assert.ok(result.stdout.length < 10_000, "the output repeats the contents");
  });

  it("refuses a key with no place to go", TIMEOUT, async () => {
    const key = file("k.txt", KEY);
    const cases: readonly (readonly string[])[] = [
      [],
      ["--backend", "sourcify"],
      ["--backend", "blockscout"],
      ["--api-url", API_URL],
      ["--backend", "sourcify", "--api-url", API_URL],
      ["--backend", "blockscout", "--api-url", API_URL],
    ];
    const results = await Promise.all(
      cases.map(async (args) => await bin([...STATUS, "--json", ...args, "--api-key-file", key])),
    );
    for (const [index, result] of results.entries()) {
      const label = (cases[index] ?? []).join(" ");
      assert.equal(result.code, 2, `${label}: ${result.stdout}`);
      // status with --api-url alone exits 2 before the key is read, as verify does (#225).
      assert.match(
        result.stdout,
        /--api-key-file (needs|cannot be used)|--api-url needs --backend/,
        label,
      );
      assertNoKey(result, label);
    }
  });

  it(
    "binds a key with --backend etherscan-compatible alone to the row's standalone host, and Sepolia has none (decision 0039)",
    TIMEOUT,
    async () => {
      const key = file("k-standalone.txt", KEY);
      const result = await bin([
        ...STATUS,
        "--json",
        "--backend",
        "etherscan-compatible",
        "--api-key-file",
        key,
      ]);
      assert.doesNotMatch(result.stdout, /--api-key-file (needs|cannot be used)/);
      assert.match(result.stdout, /"code":"unsupported-chain"/);
      assertNoKey(result, "--backend etherscan-compatible");
    },
  );

  it(
    "exits 2 on Bitlayer, whose table explorer takes no key, before any request (decision 0039)",
    TIMEOUT,
    async () => {
      const key = file("k-bitlayer.txt", KEY);
      const result = await bin([
        "status",
        "ev1:etherscan-compatible:200901:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:cqmxkhtaudvs5yhbzgv5nryiczguab4g3ppjj6mb3gakhzxjcn",
        "--json",
        "--backend",
        "etherscan-compatible",
        "--api-key-file",
        key,
      ]);
      assert.equal(result.code, 2, result.stdout);
      assert.match(result.stdout, /"code":"invalid-input"/);
      assert.match(result.stdout, /route\.apiKey/);
      assertNoKey(result, "bitlayer");
    },
  );
});

describe("blackbox #102: --api-key-stdin", CONCURRENT, () => {
  it("with --input-json - exits 2, in either order", TIMEOUT, async () => {
    const orders = [
      ["--input-json", "-", "--api-key-stdin"],
      ["--api-key-stdin", "--input-json", "-"],
    ];
    const results = await Promise.all(
      orders.map(
        async (args) =>
          await bin([...STATUS, "--json", "--backend", "etherscan-v2", ...args], {
            stdin: { text: `${KEY}\n` },
          }),
      ),
    );
    for (const result of results) {
      assert.equal(result.code, 2);
      assertNoKey(result, "input-json");
    }
  });

  it(
    "with stdin a terminal exits 2 without waiting",
    { ...TIMEOUT, skip: hasPty() ? false : "needs python3 with its pty module" },
    async () => {
      const result = await bin(
        [...STATUS, "--json", "--backend", "etherscan-v2", "--api-key-stdin"],
        { stdinTerminal: true },
      );
      assert.equal(result.code, 2);
    },
  );

  it("exits 2 when empty, combined with --api-key-file, unnamed or bad", TIMEOUT, async () => {
    const results = await Promise.all([
      bin([...STATUS, "--json", "--backend", "etherscan-v2", "--api-key-stdin"], {
        stdin: "ended",
      }),
      bin(
        [
          ...STATUS,
          "--json",
          "--backend",
          "etherscan-v2",
          "--api-key-stdin",
          "--api-key-file",
          file("k2.txt", KEY),
        ],
        { stdin: { text: KEY } },
      ),
      bin([...STATUS, "--json", "--api-key-stdin"], { stdin: { text: KEY } }),
      bin([...STATUS, "--json", "--verbose", "--backend", "etherscan-v2", "--api-key-stdin"], {
        stdin: { text: `${KEY}<x>\n` },
      }),
    ]);
    for (const result of results) {
      assert.equal(result.code, 2);
      assertNoKey(result, "stdin");
    }
  });
});

describe("blackbox #102: a key with --api-url goes only to that host (R-SEC-2)", () => {
  const seen: string[] = [];
  let base = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Uint8Array) => {
      body += new TextDecoder().decode(chunk);
    });
    req.on("end", () => {
      const line = `${req.method ?? ""} ${req.url ?? ""} ${JSON.stringify(req.headers)} ${body}`;
      seen.push(line);
      // Echo everything back, as a hostile explorer might.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "0", message: "NOTOK", result: line }));
    });
  });
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
  });

  // These runs load no fake explorer: the bin's own fetch talks to the local server above.
  it("a variable is never sent to --api-url, and a key file goes only there", TIMEOUT, async () => {
    const results = await Promise.all([
      ...["etherscan-v2", "etherscan-compatible"].map(
        async (backend) =>
          await runBin(
            [
              "status",
              handle(backend),
              "--json",
              "--verbose",
              "--backend",
              backend,
              "--api-url",
              `${base}/api`,
            ],
            { env: { ETHERSCAN_API_KEY: KEY } },
          ),
      ),
      runBin(
        [
          "status",
          handle("etherscan-compatible"),
          "--json",
          "--verbose",
          "--backend",
          "etherscan-compatible",
          "--api-url",
          `${base}/api`,
          "--api-key-file",
          file("k3.txt", KEY2),
        ],
        { env: { ETHERSCAN_API_KEY: KEY } },
      ),
    ]);
    // The variable's key is sent nowhere: etherscan-v2 needs a key, so it exits 3 before any
    // request, and etherscan-compatible polls the host without one.
    const [v2] = results;
    assert.equal(v2?.code, 3, v2?.stdout);
    assert.match(v2?.stdout ?? "", /"code":"missing-api-key"/);
    // The server echoes every request back, the key file's key included; the CLI removes it.
    for (const result of results) {
      assertNoKey(result, "api-url", [KEY, KEY2]);
    }
    assert.ok(
      seen.every((line) => !line.includes(KEY)),
      "the variable's key reached the host",
    );
    assert.ok(
      seen.some((line) => line.includes(KEY2)),
      "the key file's key never reached the host",
    );
  });
});
