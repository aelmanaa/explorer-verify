// readRouteOptions: keys from the environment, a file or stdin, never from a flag (R-AX-9), the
// route options (R-RT-2), and the stream scrub that keeps every key off stdout and stderr
// (R-SEC-1).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";

import { ExplorerVerifyError, verify } from "explorer-verify";
import type { VerifyInput } from "explorer-verify";

import type { OptionValue } from "../../src/arguments.ts";
import {
  KEY_VARIABLES,
  keyProblem,
  keyVariableValues,
  readRouteOptions,
  scrubbing,
} from "../../src/keys.ts";
import type { InputStream } from "../../src/keys.ts";
import { fakeStdin } from "../helpers/fake-io.ts";
import { makeFifo } from "../helpers/spawn-bin.ts";

// Lower-case dummy keys: no generic redaction pattern matches them, so only the CLI's knowledge of
// the keys it read can remove them.
const ETHERSCAN_KEY = "zz9dummyetherscanclikey7xv";
const ROUTESCAN_KEY = "rr4dummyroutescanclikey2pl";
const FLAG_KEY = "ff6dummyflagclikeyqq3mw";
// Real Blockscout keys start with proapi_; this one does too, so redaction is tested on that form.
const BLOCKSCOUT_KEY = "proapi_0d3adbeef5ca1ab1e0c11dummy96";

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-keys-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function keyFile(name: string, contents: string | Uint8Array): string {
  const path = join(DIR, name);
  writeFileSync(path, contents);
  return path;
}

/** Names the backend a key from a flag is for. */
const TO_ETHERSCAN = { backend: "etherscan-v2" } as const;

const NO_STDIN = (): InputStream => {
  throw new Error("stdin must not be opened");
};

async function readWith(
  values: Record<string, OptionValue>,
  env: Record<string, string | undefined> = {},
  stdin: () => InputStream = NO_STDIN,
) {
  return await readRouteOptions({ values: new Map(Object.entries(values)), env, stdin });
}

describe("keyProblem (decision 0016)", () => {
  const cases: readonly [string, string | undefined][] = [
    ["ABCDEFGH", undefined],
    ["dummy-key-0001", undefined],
    ["a.b_c~d-e1", undefined],
    ["short", "must be at least 8 characters"],
    ["x".repeat(1024), undefined],
    ["x".repeat(1025), "must be at most 1024 characters"],
    ["has space1", "must hold only letters, digits, '.', '_', '~' and '-'"],
    ["slash/key/1", "must hold only letters, digits, '.', '_', '~' and '-'"],
    ["ünicodekey", "must hold only letters, digits, '.', '_', '~' and '-'"],
    ["12345678901", "must not be all digits"],
  ];
  for (const [key, expected] of cases) {
    it(`${expected === undefined ? "accepts" : "refuses"} a ${String(key.length)}-character key`, () => {
      assert.equal(keyProblem(key), expected);
    });
  }

  // The CLI checks keys first so an issue names the variable. Both must agree, or a key the CLI
  // accepts would fail later under a library field name.
  it("agrees with the library on every case", async () => {
    const input: VerifyInput = {
      chainId: 0,
      address: "0x0000000000000000000000000000000000000001",
      compiler: {
        kind: "solc",
        version: "0.8.24+commit.e11b9ed9",
        input: { language: "Solidity", sources: {}, settings: {} },
      },
      contractName: "A.sol:A",
    };
    for (const [key, expected] of cases) {
      let fields: string[] = [];
      try {
        await verify(input, {
          apiKeys: { routescan: key },
          fetch: () => Promise.reject(new Error("no")),
        });
      } catch (error) {
        assert.ok(error instanceof ExplorerVerifyError);
        const { details } = error;
        fields = details.code === "invalid-input" ? details.issues.map(({ field }) => field) : [];
      }
      assert.equal(fields.includes("apiKeys.routescan"), expected !== undefined, key.slice(0, 12));
    }
  });
});

describe("readRouteOptions: the environment (R-AX-9)", () => {
  it("maps ETHERSCAN_API_KEY and ROUTESCAN_API_KEY to apiKeys", async () => {
    const read = await readWith(
      {},
      { ETHERSCAN_API_KEY: ETHERSCAN_KEY, ROUTESCAN_API_KEY: ROUTESCAN_KEY },
    );
    assert.deepEqual(read.issues, []);
    assert.deepEqual(read.options, {
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY },
    });
    assert.deepEqual(read.secrets, [ETHERSCAN_KEY, ROUTESCAN_KEY]);
  });

  it("names exactly the three variables, each with its one host", () => {
    assert.deepEqual(
      KEY_VARIABLES.map(({ name, backend, host }) => `${name}=${backend}@${host}`),
      [
        "ETHERSCAN_API_KEY=etherscan-v2@api.etherscan.io",
        "ROUTESCAN_API_KEY=routescan@api.routescan.io",
        "BLOCKSCOUT_API_KEY=blockscout-hosted@api.blockscout.com",
      ],
    );
  });

  it("maps BLOCKSCOUT_API_KEY to apiKeys.blockscout-hosted, never to the instance backend (decision 0041)", async () => {
    const read = await readWith(
      { backend: "blockscout-hosted" },
      { BLOCKSCOUT_API_KEY: BLOCKSCOUT_KEY },
    );
    assert.deepEqual(read.issues, []);
    assert.deepEqual(read.options, {
      apiKeys: { "blockscout-hosted": BLOCKSCOUT_KEY },
      route: { backend: "blockscout-hosted" },
    });
    assert.deepEqual(read.secrets, [BLOCKSCOUT_KEY]);
    assert.deepEqual(keyVariableValues({ BLOCKSCOUT_API_KEY: BLOCKSCOUT_KEY }), [BLOCKSCOUT_KEY]);
  });

  it("fills apiKeys.blockscout-hosted from --api-key-file with --backend blockscout-hosted", async () => {
    const path = keyFile("blockscout.txt", `${FLAG_KEY}\n`);
    const read = await readWith({ backend: "blockscout-hosted", "api-key-file": path });
    assert.deepEqual(read.issues, []);
    assert.deepEqual(read.options, {
      apiKeys: { "blockscout-hosted": FLAG_KEY },
      route: { backend: "blockscout-hosted" },
    });
  });

  it("counts an empty value as unset", async () => {
    const read = await readWith({}, { ETHERSCAN_API_KEY: "", ROUTESCAN_API_KEY: undefined });
    assert.deepEqual(read, { options: {}, secrets: [], issues: [] });
  });

  it("names the variable of a bad key, never the key, and keeps it as a secret", async () => {
    const bad = "bad key with spaces";
    const read = await readWith({}, { ETHERSCAN_API_KEY: bad });
    assert.equal(read.options, undefined);
    assert.deepEqual(read.issues, [
      {
        field: "ETHERSCAN_API_KEY",
        message: "must hold only letters, digits, '.', '_', '~' and '-'",
      },
    ]);
    assert.deepEqual(read.secrets, [bad]);
    assert.ok(!JSON.stringify(read.issues).includes("spaces"));
  });

  it("ignores other variables that hold keys, such as API_KEY", async () => {
    const read = await readWith({}, { API_KEY: FLAG_KEY });
    assert.deepEqual(read.options, {});
  });
});

describe("readRouteOptions: --api-key-file (R-AX-9)", () => {
  it("fills the apiKeys entry of --backend and wins over its variable", async () => {
    const path = keyFile("key.txt", `${FLAG_KEY}\n`);
    const env = { ETHERSCAN_API_KEY: ETHERSCAN_KEY, ROUTESCAN_API_KEY: ROUTESCAN_KEY };
    const read = await readWith({ ...TO_ETHERSCAN, "api-key-file": path }, env);
    assert.deepEqual(read.issues, []);
    assert.deepEqual(read.options, {
      apiKeys: { "etherscan-v2": FLAG_KEY, routescan: ROUTESCAN_KEY },
      route: { backend: "etherscan-v2" },
    });
    assert.deepEqual(read.secrets, [ETHERSCAN_KEY, ROUTESCAN_KEY, FLAG_KEY]);
    const routescan = await readWith({ backend: "routescan", "api-key-file": path }, env);
    assert.deepEqual(routescan.options?.apiKeys, {
      "etherscan-v2": ETHERSCAN_KEY,
      routescan: FLAG_KEY,
    });
  });

  // The routing table picks a backend partly by the keys it has, so an unnamed key could reach
  // a backend it was not meant for, such as a Routescan key sent to Etherscan (R-SEC-2).
  const unnamed: readonly [string, Record<string, OptionValue>, string][] = [
    ["no --backend", {}, "needs --backend or --api-url, to name where the key goes"],
    [
      "--backend sourcify",
      { backend: "sourcify" },
      "cannot be used with --backend sourcify: it takes no API key",
    ],
    [
      "--backend blockscout",
      { backend: "blockscout" },
      "cannot be used with --backend blockscout: it takes no API key",
    ],
    [
      "--api-url and no --backend",
      { "api-url": "https://explorer.example.org/api" },
      "needs --backend etherscan-v2, routescan, blockscout-hosted or etherscan-compatible with --api-url",
    ],
    [
      "--api-url and --backend sourcify",
      { backend: "sourcify", "api-url": "https://explorer.example.org/api" },
      "cannot be used with --backend sourcify: it takes no API key",
    ],
    [
      "--api-url and --backend blockscout",
      { backend: "blockscout", "api-url": "https://explorer.example.org/api" },
      "cannot be used with --backend blockscout: it takes no API key",
    ],
  ];
  for (const [label, values, message] of unnamed) {
    it(`refuses a key with ${label}, without reading the file or stdin`, async () => {
      const file = await readWith({ ...values, "api-key-file": join(DIR, "never-read") });
      assert.deepEqual(file.issues, [{ field: "--api-key-file", message }]);
      let pulled = false;
      const stdin: InputStream = {
        [Symbol.asyncIterator]: () => {
          pulled = true;
          return fakeStdin([FLAG_KEY])[Symbol.asyncIterator]();
        },
      };
      const piped = await readWith({ ...values, "api-key-stdin": true }, {}, () => stdin);
      assert.deepEqual(piped.issues, [{ field: "--api-key-stdin", message }]);
      assert.equal(pulled, false);
      assert.deepEqual(piped.secrets, []);
    });
  }

  it("reports only --backend when its value is not a backend", async () => {
    const read = await readWith({ backend: "nope", "api-key-file": join(DIR, "never-read") });
    assert.deepEqual(
      read.issues.map(({ field }) => field),
      ["--backend"],
    );
  });

  it("reports both a missing destination and a terminal stdin", async () => {
    const read = await readWith({ "api-key-stdin": true }, {}, () => fakeStdin([], true));
    assert.deepEqual(
      read.issues.map(({ field }) => field),
      ["--api-key-stdin", "--api-key-stdin"],
    );
  });

  it("puts the key in route.apiKey with --api-url, and keeps the variables in apiKeys", async () => {
    const path = keyFile("route.txt", FLAG_KEY);
    const read = await readWith(
      {
        "api-key-file": path,
        backend: "etherscan-compatible",
        "api-url": "https://explorer.example.org/api",
      },
      { ETHERSCAN_API_KEY: ETHERSCAN_KEY },
    );
    assert.deepEqual(read.options, {
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
      route: {
        backend: "etherscan-compatible",
        apiUrl: "https://explorer.example.org/api",
        apiKey: FLAG_KEY,
      },
    });
  });

  it("puts the key in route.apiKey with --backend etherscan-compatible alone, for the row's host (decision 0039)", async () => {
    const path = keyFile("standalone.txt", FLAG_KEY);
    const read = await readWith({ "api-key-file": path, backend: "etherscan-compatible" });
    assert.deepEqual(read.issues, []);
    assert.deepEqual(read.options, {
      route: { backend: "etherscan-compatible", apiKey: FLAG_KEY },
    });
  });

  it("removes one trailing CRLF, and only one newline", async () => {
    const crlf = await readWith({
      ...TO_ETHERSCAN,
      "api-key-file": keyFile("crlf.txt", `${FLAG_KEY}\r\n`),
    });
    assert.deepEqual(crlf.options?.apiKeys?.["etherscan-v2"], FLAG_KEY);
    const two = await readWith({
      ...TO_ETHERSCAN,
      "api-key-file": keyFile("two.txt", `${FLAG_KEY}\n\n`),
    });
    assert.deepEqual(two.issues, [
      { field: "--api-key-file", message: "must hold only letters, digits, '.', '_', '~' and '-'" },
    ]);
  });

  it("refuses an empty file", async () => {
    const read = await readWith({ ...TO_ETHERSCAN, "api-key-file": keyFile("empty.txt", "\n") });
    assert.deepEqual(read.issues, [{ field: "--api-key-file", message: "gave an empty key" }]);
    assert.deepEqual(read.secrets, []);
  });

  it("refuses a file longer than any key without reading all of it", async () => {
    const read = await readWith({
      ...TO_ETHERSCAN,
      "api-key-file": keyFile("long.txt", "k".repeat(100_000)),
    });
    assert.deepEqual(read.issues, [
      { field: "--api-key-file", message: "must be at most 1024 characters" },
    ]);
    assert.equal(read.secrets[0]?.length, 1028);
  });

  it("names neither the path nor the contents of a file that cannot be read", async () => {
    // A path typed by mistake can be a key.
    const read = await readWith({ ...TO_ETHERSCAN, "api-key-file": join(DIR, FLAG_KEY) });
    assert.deepEqual(read.issues, [
      { field: "--api-key-file", message: "names a file that cannot be read (ENOENT)" },
    ]);
    const directory = await readWith({ ...TO_ETHERSCAN, "api-key-file": DIR });
    assert.equal(directory.issues[0]?.field, "--api-key-file");
    assert.equal(
      directory.issues[0]?.message,
      "must name a regular file; pipe the key with --api-key-stdin",
    );
    assert.ok(!JSON.stringify([read, directory]).includes(DIR));
  });

  it("refuses --api-key-file with --api-key-stdin", async () => {
    const read = await readWith({ ...TO_ETHERSCAN, "api-key-file": "x", "api-key-stdin": true });
    assert.deepEqual(read.issues, [
      { field: "--api-key-stdin", message: "cannot be combined with --api-key-file" },
    ]);
  });
});

describe("readRouteOptions: --api-key-stdin (R-AX-9)", () => {
  it("reads text and byte chunks and removes one trailing newline", async () => {
    const half = FLAG_KEY.length / 2;
    const bytes = new TextEncoder().encode(FLAG_KEY.slice(half));
    const read = await readWith({ ...TO_ETHERSCAN, "api-key-stdin": true }, {}, () =>
      fakeStdin([FLAG_KEY.slice(0, half), bytes, "\n"]),
    );
    assert.deepEqual(read.options, {
      apiKeys: { "etherscan-v2": FLAG_KEY },
      route: { backend: "etherscan-v2" },
    });
  });

  it("exits at once when stdin is a terminal, without reading it", async () => {
    let read = false;
    const terminal: InputStream = {
      isTTY: true,
      [Symbol.asyncIterator]: () => {
        read = true;
        return fakeStdin([])[Symbol.asyncIterator]();
      },
    };
    const result = await readWith({ ...TO_ETHERSCAN, "api-key-stdin": true }, {}, () => terminal);
    assert.equal(read, false);
    assert.deepEqual(result.issues, [
      {
        field: "--api-key-stdin",
        message: "needs the key piped on stdin, and stdin is a terminal",
      },
    ]);
  });

  it("refuses --input-json - without opening stdin", async () => {
    const read = await readWith({ ...TO_ETHERSCAN, "api-key-stdin": true, "input-json": "-" });
    assert.deepEqual(read.issues, [
      {
        field: "--api-key-stdin",
        message: "cannot be combined with --input-json -: both would read stdin",
      },
    ]);
  });

  it("accepts --input-json with a file", async () => {
    const read = await readWith(
      { ...TO_ETHERSCAN, "api-key-stdin": true, "input-json": "in.json" },
      {},
      () => fakeStdin([FLAG_KEY]),
    );
    assert.deepEqual(read.issues, []);
  });

  it("stops reading once more than a key's length has arrived", async () => {
    let pulled = 0;
    const endless: InputStream = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          pulled += 1;
          return await Promise.resolve({ done: false, value: "k".repeat(512) });
        },
      }),
    };
    const read = await readWith({ ...TO_ETHERSCAN, "api-key-stdin": true }, {}, () => endless);
    assert.equal(pulled, 3);
    assert.deepEqual(read.issues, [
      { field: "--api-key-stdin", message: "must be at most 1024 characters" },
    ]);
  });

  it("reports a read error by its code only", async () => {
    const failure = Object.assign(new Error(`EIO reading ${FLAG_KEY}`), { code: "EIO" });
    const read = await readWith({ ...TO_ETHERSCAN, "api-key-stdin": true }, {}, () =>
      fakeStdin([], false, failure),
    );
    assert.deepEqual(read.issues, [
      { field: "--api-key-stdin", message: "could not read stdin (EIO)" },
    ]);
    const plain = await readWith({ ...TO_ETHERSCAN, "api-key-stdin": true }, {}, () =>
      fakeStdin([], false, new Error("boom")),
    );
    assert.deepEqual(plain.issues, [{ field: "--api-key-stdin", message: "could not read stdin" }]);
    const odd = await readWith({ ...TO_ETHERSCAN, "api-key-stdin": true }, {}, () =>
      fakeStdin([], false, Object.assign(new Error("odd"), { code: "not a code" })),
    );
    assert.deepEqual(odd.issues, [{ field: "--api-key-stdin", message: "could not read stdin" }]);
  });

  it("refuses a chunk that is neither text nor bytes", async () => {
    const read = await readWith({ ...TO_ETHERSCAN, "api-key-stdin": true }, {}, () =>
      fakeStdin([42]),
    );
    assert.deepEqual(read.issues, [{ field: "--api-key-stdin", message: "could not read stdin" }]);
  });

  it("refuses an empty stdin", async () => {
    const read = await readWith({ ...TO_ETHERSCAN, "api-key-stdin": true }, {}, () =>
      fakeStdin([]),
    );
    assert.deepEqual(read.issues, [{ field: "--api-key-stdin", message: "gave an empty key" }]);
  });
});

describe("readRouteOptions: --backend and --api-url (R-RT-2)", () => {
  it("maps both to route and leaves the URL checks to the library", async () => {
    const read = await readWith({ backend: "routescan", "api-url": "not a url" });
    assert.deepEqual(read.options, { route: { backend: "routescan", apiUrl: "not a url" } });
  });

  it("refuses an unknown backend without repeating it", async () => {
    const read = await readWith({ backend: FLAG_KEY });
    assert.equal(read.issues[0]?.field, "--backend");
    assert.match(read.issues[0]?.message ?? "", /^must be one of etherscan-v2, /);
    assert.ok(!JSON.stringify(read).includes(FLAG_KEY));
  });

  it("collects every issue at once", async () => {
    const read = await readWith(
      { backend: "nope", "api-key-file": join(DIR, "missing") },
      { ROUTESCAN_API_KEY: "short" },
    );
    assert.deepEqual(
      read.issues.map(({ field }) => field),
      ["ROUTESCAN_API_KEY", "--backend"],
    );
  });
});

describe("readRouteOptions: a key file that is not a regular file (R-AX-9)", () => {
  const REGULAR = "must name a regular file; pipe the key with --api-key-stdin";

  it(
    "refuses a FIFO with no writer at once instead of blocking",
    { skip: process.platform === "win32" ? "no FIFOs" : false },
    async () => {
      const fifo = join(DIR, "key.fifo");
      makeFifo(fifo);
      const read = await readWith({ ...TO_ETHERSCAN, "api-key-file": fifo });
      assert.deepEqual(read.issues, [{ field: "--api-key-file", message: REGULAR }]);
      assert.ok(!JSON.stringify(read).includes(DIR));
    },
  );

  it(
    "refuses a character device such as /dev/null",
    { skip: process.platform === "win32" ? "no /dev/null" : false },
    async () => {
      const read = await readWith({ ...TO_ETHERSCAN, "api-key-file": "/dev/null" });
      assert.deepEqual(read.issues, [{ field: "--api-key-file", message: REGULAR }]);
    },
  );
});

describe("keyVariableValues (R-SEC-1)", () => {
  it("returns the set, non-empty key variables only", () => {
    assert.deepEqual(
      keyVariableValues({
        ETHERSCAN_API_KEY: ETHERSCAN_KEY,
        ROUTESCAN_API_KEY: "",
        OTHER: FLAG_KEY,
      }),
      [ETHERSCAN_KEY],
    );
  });
});

describe("scrubbing (R-SEC-1)", () => {
  it("removes a key in any letter case, and keys with pattern characters", () => {
    let out = "";
    const dotted = "a.b+c(d)e*f";
    const stream = scrubbing({ write: (text) => (out += text) }, [FLAG_KEY, dotted]);
    stream.write(`${FLAG_KEY.toUpperCase()} ${dotted} aXb+c(d)e*f\n`);
    assert.equal(out, "[redacted] [redacted] aXb+c(d)e*f\n");
  });

  it("removes each key, the longest first, and reads keys added later", () => {
    let out = "";
    const secrets: string[] = [];
    const stream = scrubbing({ write: (text) => (out += text), isTTY: true }, secrets);
    assert.equal(stream.isTTY, true);
    stream.write(`a ${FLAG_KEY}\n`);
    secrets.push("ff6dummy", FLAG_KEY, "short");
    stream.write(`b ${FLAG_KEY} ff6dummy short\n`);
    assert.equal(out, `a ${FLAG_KEY}\nb [redacted] [redacted] short\n`);
  });
});
