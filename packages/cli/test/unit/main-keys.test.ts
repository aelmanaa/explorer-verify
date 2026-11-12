// The main loop with keys (R-AX-9, R-SEC-1, R-SEC-2): no flag takes a key, a key read from the
// environment, a file or stdin never reaches stdout or stderr in any mode, and stdin is read only
// when a flag asks for it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ExplorerVerifyError, verify } from "explorer-verify";
import type { VerifyInput } from "explorer-verify";

import type { Command, CommandContext, RunCommand } from "../../src/command.ts";
import { REFUSED_KEY_MESSAGE } from "../../src/keys.ts";
import { main } from "../../src/main.ts";
import { fakeIo, jsonLines } from "../helpers/fake-io.ts";
import type { FakeIoOptions } from "../helpers/fake-io.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { WITH_SCRIPTED } from "../helpers/scripted-command.ts";

// Lower-case dummy keys: no generic redaction pattern matches them, so only the CLI's knowledge of
// the keys it read can remove them.
const KEY = "kk7dummyclimainkeyzz4qa";
const OTHER_KEY = "oo2dummyclimainkeyxx8wb";

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-main-keys-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});
const KEY_FILE = join(DIR, "key.txt");
writeFileSync(KEY_FILE, `${KEY}\n`);

async function run(
  argv: readonly string[],
  commands: readonly Command[] | undefined,
  options: FakeIoOptions = {},
) {
  const fake = fakeIo(argv, options);
  const code = await main(fake.io, commands ?? WITH_SCRIPTED);
  return {
    code,
    stdout: fake.stdout(),
    stderr: fake.stderr(),
    stdinOpened: fake.stdinOpened(),
  };
}

function routed(
  name: string,
  body: (context: CommandContext) => Promise<Awaited<ReturnType<RunCommand>>>,
  options: Command["options"] = {},
): Command {
  return {
    name,
    summary: "A test command.",
    usage: "",
    examples: [{ args: "test", description: "Run it." }],
    options,
    maxPositionals: 0,
    routed: true,
    run: body,
  };
}

/** Every key the context holds, read from its route options. */
function keysOf(context: CommandContext): string[] {
  const { apiKeys, route } = context.routeOptions();
  const keys = Object.values(apiKeys ?? {}).filter((key) => key !== undefined);
  return route?.apiKey === undefined ? keys : [...keys, route.apiKey];
}

describe("main: no flag takes a key (R-AX-9)", () => {
  const forms: readonly string[][] = [
    ["--api-key", KEY],
    [`--api-key=${KEY}`],
    ["--apikey", KEY],
    ["--key", KEY],
    [`--key=${KEY}`],
    ["--api_key", KEY],
    ["--etherscan-api-key", KEY],
    [`--etherscan-key=${KEY}`],
    ["--routescan-api-key", KEY],
  ];
  for (const form of forms) {
    for (const command of [["scripted"], []]) {
      it(`refuses ${form.join(" ").replace(KEY, "<key>")} ${command.length === 0 ? "with no command" : "on scripted"}, exit 2, and never echoes the key`, async () => {
        const result = await run([...command, "--json", ...form], undefined);
        assert.equal(result.code, 2);
        const envelope = oneEnvelope(result.stdout);
        assert.deepEqual(envelopeProblems(envelope), []);
        const text = result.stdout + result.stderr;
        assert.ok(!text.includes(KEY), text);
        assert.ok(text.includes(REFUSED_KEY_MESSAGE));
        for (const name of [
          "ETHERSCAN_API_KEY",
          "ROUTESCAN_API_KEY",
          "--api-key-file",
          "--api-key-stdin",
        ]) {
          assert.ok(text.includes(name), name);
        }
        // The key went with the refused option, so it is not read as an argument.
        assert.ok(!text.includes("takes no arguments"));
        assert.equal(result.stdinOpened, 0);
      });
    }
  }

  it("reads the option after a refused one that has no value", async () => {
    const result = await run(["scripted", "--api-key", "--json"], undefined);
    assert.equal(result.code, 2);
    assert.deepEqual(envelopeProblems(oneEnvelope(result.stdout)), []);
  });
});

describe("main: route options reach the command (R-AX-9, R-RT-2)", () => {
  it("gives a routed command the keys, and printing its context shows none", async () => {
    let seen: string[] = [];
    let printed = "";
    const result = await run(
      ["check", "--backend", "routescan"],
      [
        routed("check", async (context) => {
          seen = keysOf(context);
          printed = JSON.stringify(context);
          return await Promise.resolve({ status: "verified", backend: "sourcify", match: "exact" });
        }),
      ],
      { env: { ETHERSCAN_API_KEY: KEY, ROUTESCAN_API_KEY: OTHER_KEY } },
    );
    assert.equal(result.code, 0);
    assert.deepEqual(seen, [KEY, OTHER_KEY]);
    assert.ok(!printed.includes(KEY) && !printed.includes(OTHER_KEY));
  });

  it("scrubs the key variables on every path, a command that is not routed included", async () => {
    const plain: Command = {
      name: "plain",
      summary: "A test command.",
      usage: "",
      examples: [{ args: "test", description: "Run it." }],
      options: {},
      maxPositionals: 0,
      run: () => {
        throw new Error(`boom ${KEY.toUpperCase()} ${OTHER_KEY}`);
      },
    };
    const result = await run(["plain", "--json", "--verbose"], [plain], {
      env: { ETHERSCAN_API_KEY: KEY, ROUTESCAN_API_KEY: OTHER_KEY },
    });
    assert.equal(result.code, 6);
    const text = (result.stdout + result.stderr).toLowerCase();
    assert.ok(!text.includes(KEY) && !text.includes(OTHER_KEY), text);
  });

  it("gives a command that is not routed no keys, no route options and no stdin", async () => {
    let seen: object | undefined;
    const plain: Command = {
      name: "plain",
      summary: "A test command.",
      usage: "",
      examples: [{ args: "test", description: "Run it." }],
      options: {},
      maxPositionals: 0,
      run: async (context) => {
        seen = context.routeOptions();
        return await Promise.resolve({ status: "verified", backend: "sourcify", match: "exact" });
      },
    };
    const ok = await run(["plain"], [plain], { env: { ETHERSCAN_API_KEY: "bad key" } });
    assert.equal(ok.code, 0);
    assert.deepEqual(seen, {});
    const refused = await run(
      ["plain", "--json", "--api-key-stdin"],
      [plain, routed("other", NEVER)],
    );
    assert.equal(refused.code, 2);
    assert.match(refused.stdout, /--api-key-stdin is not an option of plain/);
    assert.equal(refused.stdinOpened, 0);
  });

  it("exits 2 when a key file has no --backend or --api-url to name where it goes", async () => {
    const result = await run(["scripted", "--json", "--api-key-file", KEY_FILE], undefined);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /--api-key-file needs --backend, to name where the key goes/);
  });

  it("exits 2 naming the variable of a bad key, without the key", async () => {
    const bad = "bad-key/with-a-slash";
    const result = await run(["scripted", "--json"], undefined, {
      env: { ROUTESCAN_API_KEY: bad },
    });
    assert.equal(result.code, 2);
    assert.match(result.stdout, /ROUTESCAN_API_KEY must hold only letters/);
    assert.ok(!(result.stdout + result.stderr).includes(bad));
  });
});

const NEVER: RunCommand = async () => {
  throw new Error("must not run");
};

describe("main: --api-key-stdin (R-AX-9)", () => {
  it("exits 2 at once when stdin is a terminal, without running the command", async () => {
    const result = await run(
      ["scripted", "--json", "--backend", "etherscan-v2", "--api-key-stdin"],
      undefined,
      {
        stdinIsTerminal: true,
        stdin: [KEY],
      },
    );
    assert.equal(result.code, 2);
    assert.match(
      result.stdout,
      /--api-key-stdin needs the key piped on stdin, and stdin is a terminal/,
    );
  });

  it("exits 2 with --input-json - and never opens stdin", async () => {
    const result = await run(
      ["check", "--json", "--api-key-stdin", "--input-json", "-"],
      [routed("check", NEVER, { "input-json": { type: "string", description: "The input." } })],
      { stdin: [KEY] },
    );
    assert.equal(result.code, 2);
    assert.match(result.stdout, /cannot be combined with --input-json -/);
    assert.equal(result.stdinOpened, 0);
  });

  it("opens stdin only for --api-key-stdin", async () => {
    const without = await run(["scripted"], undefined, { stdin: [KEY] });
    assert.equal(without.stdinOpened, 0);
    const withFlag = await run(
      ["scripted", "--api-key-stdin", "--backend", "routescan"],
      undefined,
      {
        stdin: [KEY],
      },
    );
    assert.equal(withFlag.code, 0);
    assert.equal(withFlag.stdinOpened, 1);
  });
});

/** How a test command tries to leak the key it was given. */
const LEAKS: readonly {
  name: string;
  run: (key: string, context: CommandContext) => Promise<never> | never;
}[] = [
  {
    name: "an internal error",
    run: (key) => {
      throw new Error(`boom ${key}`);
    },
  },
  {
    name: "a library error built without the key as a secret",
    run: (key) => {
      throw new ExplorerVerifyError(
        { code: "network", backend: "routescan", attempts: 1 },
        `down ${key}`,
        {
          secrets: [],
        },
      );
    },
  },
  {
    name: "a usage error",
    run: (key) => {
      throw new ExplorerVerifyError(
        { code: "invalid-input", issues: [{ field: key, message: `bad ${key}` }] },
        `bad ${key}`,
        { secrets: [] },
      );
    },
  },
];

/** Where a key comes from, as argv and the fake process's environment and stdin. */
const SOURCES: readonly { name: string; argv: string[]; options: FakeIoOptions }[] = [
  { name: "ETHERSCAN_API_KEY", argv: [], options: { env: { ETHERSCAN_API_KEY: KEY } } },
  { name: "ROUTESCAN_API_KEY", argv: [], options: { env: { ROUTESCAN_API_KEY: KEY } } },
  {
    name: "--api-key-file",
    argv: ["--api-key-file", KEY_FILE, "--backend", "routescan"],
    options: {},
  },
  {
    name: "--api-key-stdin",
    argv: ["--backend", "etherscan-v2", "--api-key-stdin"],
    options: { stdin: [`${KEY}\n`] },
  },
  {
    name: "--api-key-file with --api-url",
    argv: [
      "--api-key-file",
      KEY_FILE,
      "--backend",
      "etherscan-compatible",
      "--api-url",
      "https://explorer.example.org/api",
    ],
    options: {},
  },
];

const MODES: readonly string[][] = [
  ["--json"],
  ["--json", "--verbose", "--log-format", "json"],
  ["--verbose", "--log-format", "json"],
  ["--verbose"],
  ["--quiet"],
];

describe("main: a key never reaches stdout or stderr (R-AX-9, R-SEC-1)", () => {
  for (const source of SOURCES) {
    for (const leak of LEAKS) {
      it(`from ${source.name}, through ${leak.name}, in every mode`, async () => {
        for (const mode of MODES) {
          let given: string[] = [];
          const command = routed("leak", async (context) => {
            given = keysOf(context);
            context.logger.debug(`debug ${KEY}`, { key: KEY, nested: `x ${KEY} y` });
            context.logger.error(`error ${KEY}`);
            context.onEvent({ type: "verify.routed", backend: "routescan", apiHost: KEY });
            await Promise.resolve();
            return await leak.run(KEY, context);
          });
          const result = await run(["leak", ...mode, ...source.argv], [command], source.options);
          const label = `${source.name} ${mode.join(" ")}`;
          assert.ok(given.includes(KEY), label);
          assert.notEqual(result.code, 0, label);
          const text = result.stdout + result.stderr;
          assert.ok(!text.includes(KEY), `${label}\n${text}`);
          assert.ok(!text.includes(KEY.slice(0, 12)), label);
          if (mode.includes("--json")) {
            assert.deepEqual(envelopeProblems(oneEnvelope(result.stdout)), [], label);
          }
          if (mode.includes("json")) {
            assert.ok(jsonLines(result.stderr).length > 0, label);
          }
          assert.ok(text.includes("[redacted]"), label);
        }
      });
    }
  }

  it("keeps the key out of a result's reason", async () => {
    const result = await run(
      ["leak", "--json"],
      [
        routed(
          "leak",
          async () =>
            await Promise.resolve({
              status: "failed",
              backend: "routescan",
              reason: `no ${KEY}`,
              reasonCode: "unknown",
            }),
        ),
      ],
      { env: { ROUTESCAN_API_KEY: KEY } },
    );
    assert.equal(result.code, 1);
    assert.ok(!result.stdout.includes(KEY));
    assert.match(result.stdout, /no \[redacted\]/);
  });

  it("keeps a bad key out of the output too", async () => {
    const bad = "bad-key/kk7dummy-zz4qa";
    const result = await run(["scripted", "--json", "--verbose"], undefined, {
      env: { ETHERSCAN_API_KEY: bad },
    });
    assert.equal(result.code, 2);
    assert.ok(!(result.stdout + result.stderr).includes(bad));
  });
});

// A Sourcify-shaped fake explorer that echoes everything it receives, through the library's own
// `verify()`. Every key the CLI read is in the library's options, so the library removes it, and
// the CLI's stream scrub is the second guard.
describe("main: through the library with a fake explorer that echoes the key (R-SEC-1, R-SEC-2)", () => {
  const input: VerifyInput = {
    chainId: 11155111,
    address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Tiny.sol": { content: "contract Tiny {}" } },
        settings: { optimizer: { enabled: false, runs: 200 } },
      },
    },
    contractName: "contracts/Tiny.sol:Tiny",
  };

  for (const mode of MODES) {
    it(`sends no key to an --api-url on another host, and prints none, with ${mode.join(" ")}`, async () => {
      const sent: string[] = [];
      const echo: typeof fetch = async (target, init) => {
        const request = new Request(target, init);
        const text = `${request.method} ${request.url} ${JSON.stringify([...request.headers])} ${await request.text()}`;
        sent.push(text);
        return new Response(JSON.stringify({ error: `refused ${KEY} ${OTHER_KEY} ${text}` }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      };
      const command = routed(
        "check",
        async (context) =>
          await verify(input, {
            ...context.routeOptions(),
            fetch: echo,
            logger: context.logger,
            onEvent: context.onEvent,
            signal: context.signal,
          }),
      );
      const result = await run(
        ["check", ...mode, "--api-url", "https://explorer.example.org"],
        [command],
        { env: { ETHERSCAN_API_KEY: KEY, ROUTESCAN_API_KEY: OTHER_KEY } },
      );
      assert.ok(sent.length > 0);
      for (const request of sent) {
        assert.ok(!request.includes(KEY) && !request.includes(OTHER_KEY), request);
      }
      const text = result.stdout + result.stderr;
      assert.ok(!text.includes(KEY) && !text.includes(OTHER_KEY), text);
      // Not 0, and not 2: the library sent the requests and the explorer's answer failed the run.
      assert.ok(result.code !== 0 && result.code !== 2, String(result.code));
      if (mode.includes("--json")) {
        const envelope = oneEnvelope(result.stdout);
        assert.deepEqual(envelopeProblems(envelope), []);
        assert.equal(envelope["ok"], false);
      }
    });
  }
});
