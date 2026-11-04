// The RPC URL of `verify` (R-IN-3, R-AX-9, R-SEC-1): its three sources, the forms refused, the
// parts that count as secrets, and the main loop removing them from stdout and stderr.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { OptionValue } from "../../src/arguments.ts";
import type { Command } from "../../src/command.ts";
import type { InputStream } from "../../src/keys.ts";
import { scrubbing, stdinConflict } from "../../src/keys.ts";
import { main } from "../../src/main.ts";
import { readRpcUrl, rpcUrlSecrets, RPC_URL_OPTIONS } from "../../src/rpc-url.ts";
import type { ReadRpcUrl } from "../../src/rpc-url.ts";
import { fakeIo, fakeStdin } from "../helpers/fake-io.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";

// Plain lower-case dummies: only the CLI's own redaction can remove them.
const PATH_SECRET = "unitrpcpathsecretzzqq";
const QUERY_SECRET = "unitrpcquerysecretyyww";
const URL_WITH_KEY = `https://rpc.example.org/v2/${PATH_SECRET}?token=${QUERY_SECRET}`;

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-rpc-url-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function file(name: string, text: string): string {
  const path = join(DIR, name);
  writeFileSync(path, text);
  return path;
}

interface Read {
  result: ReadRpcUrl;
  secrets: string[];
  opened: number;
}

async function read(
  entries: readonly [string, OptionValue][],
  stdin: InputStream = fakeStdin([]),
): Promise<Read> {
  const secrets: string[] = [];
  let opened = 0;
  const result = await readRpcUrl({
    values: new Map(entries),
    stdin: () => {
      opened += 1;
      return stdin;
    },
    addSecrets: (found) => {
      secrets.push(...found);
    },
  });
  return { result, secrets, opened };
}

/** The issues of a read, as `field message` lines. */
function issues(result: ReadRpcUrl): string[] {
  assert.ok(result.issues !== undefined, "issues");
  return result.issues.map(({ field, message }) => `${field} ${message}`);
}

describe("rpcUrlSecrets: the parts of a URL that can hold a key (R-SEC-1)", () => {
  it("takes path segments and query values of 8 or more characters, not the host", () => {
    assert.deepEqual(rpcUrlSecrets(URL_WITH_KEY), [PATH_SECRET, QUERY_SECRET]);
    assert.deepEqual(rpcUrlSecrets("https://averylonghostname.example.org/v2/short"), []);
  });

  it("takes the user name, the password, a bare query part and the fragment", () => {
    assert.deepEqual(
      rpcUrlSecrets(
        "https://usernamelong:passwordlong@rpc.example.org/?barequeryvalue#fragmentlong",
      ),
      ["usernamelong", "passwordlong", "barequeryvalue", "fragmentlong"],
    );
  });

  it("takes each part as written and decoded, and keeps a part that does not decode", () => {
    assert.deepEqual(rpcUrlSecrets("https://rpc.example.org/abc%2Fdefgh?k=%zzbadescape1"), [
      "abc%2Fdefgh",
      "abc/defgh",
      "%zzbadescape1",
    ]);
  });

  it("gives nothing for a text that is not a URL", () => {
    assert.deepEqual(rpcUrlSecrets("not a url at all"), []);
  });

  it("takes a query name of 8 or more characters, with a value, an empty value or none", () => {
    for (const query of ["c0ffee1234abcd99=1", "c0ffee1234abcd99=", "c0ffee1234abcd99"]) {
      assert.deepEqual(rpcUrlSecrets(`http://127.0.0.1:8545/rpc?${query}`), ["c0ffee1234abcd99"]);
    }
  });

  it("takes each part as typed too, where the URL parser encodes a character", () => {
    const secrets = rpcUrlSecrets("https://rpc.example.org/?k=c0ffee'1234%61bcd99");
    for (const form of ["c0ffee'1234%61bcd99", "c0ffee%271234%61bcd99", "c0ffee'1234abcd99"]) {
      assert.ok(secrets.includes(form), form);
    }
  });

  it("takes the typed parts of a text the URL parser refuses", () => {
    assert.deepEqual(rpcUrlSecrets("https://[bad/typedsecretpart"), ["typedsecretpart"]);
  });
});

describe("readRpcUrl: where the URL comes from (R-AX-9)", () => {
  it("gives no URL when no option is set", async () => {
    const { result, opened } = await read([]);
    assert.deepEqual(result, { rpcUrl: undefined });
    assert.equal(opened, 0);
  });

  it("--rpc-url takes a URL with no part that can hold a key", async () => {
    const { result, secrets } = await read([["rpc-url", "https://rpc.example.org/v2"]]);
    assert.deepEqual(result, { rpcUrl: "https://rpc.example.org/v2" });
    assert.deepEqual(secrets, []);
  });

  it("--rpc-url refuses a part that can hold a key, and makes it a secret first", async () => {
    const { result, secrets } = await read([["rpc-url", URL_WITH_KEY]]);
    assert.deepEqual(issues(result), [
      "--rpc-url has a part that can hold a key, and a flag value shows in the process list and the shell history; use --rpc-url-file or --rpc-url-stdin",
    ]);
    assert.deepEqual(secrets, [PATH_SECRET, QUERY_SECRET]);
  });

  it("--rpc-url refuses a query name that can hold a key (R-AX-9)", async () => {
    for (const query of ["c0ffee1234abcd99=1", "c0ffee1234abcd99=", "c0ffee1234abcd99"]) {
      const { result } = await read([["rpc-url", `http://127.0.0.1:8545/rpc?${query}`]]);
      assert.match(issues(result).join(), /--rpc-url has a part that can hold a key/, query);
    }
  });

  it("--rpc-url refuses a character a URL does not allow", async () => {
    const { result } = await read([["rpc-url", 'https://rpc.example.org/"x"']]);
    assert.deepEqual(issues(result), [
      "--rpc-url must hold only the characters a URL allows, with no space or quote",
    ]);
  });

  it("--rpc-url-file reads a URL with a key and removes one trailing newline", async () => {
    const path = file("url-crlf.txt", `${URL_WITH_KEY}\r\n`);
    const { result, secrets } = await read([["rpc-url-file", path]]);
    assert.deepEqual(result, { rpcUrl: URL_WITH_KEY });
    assert.deepEqual(secrets, [PATH_SECRET, QUERY_SECRET]);
  });

  it("--rpc-url-file refuses an empty file, a missing file and a directory", async () => {
    const empty = await read([["rpc-url-file", file("empty.txt", "\n")]]);
    assert.deepEqual(issues(empty.result), ["--rpc-url-file gave an empty URL"]);
    const missing = await read([["rpc-url-file", join(DIR, "missing.txt")]]);
    assert.deepEqual(issues(missing.result), [
      "--rpc-url-file names a file that cannot be read (ENOENT)",
    ]);
    const folder = await read([["rpc-url-file", DIR]]);
    assert.deepEqual(issues(folder.result), [
      "--rpc-url-file must name a regular file; pipe the URL with --rpc-url-stdin",
    ]);
  });

  it("--rpc-url-file refuses a URL longer than 8192 characters", async () => {
    const path = file("long.txt", `https://rpc.example.org/${"a".repeat(8200)}`);
    const { result, secrets } = await read([["rpc-url-file", path]]);
    assert.deepEqual(issues(result), ["--rpc-url-file must be at most 8192 characters"]);
    // Read up to the limit, the long path segment is a secret all the same.
    assert.equal(secrets.length, 1);
  });

  it("--rpc-url-stdin reads the piped URL, in chunks of text or bytes", async () => {
    const half = URL_WITH_KEY.length >> 1;
    const stdin = fakeStdin([
      URL_WITH_KEY.slice(0, half),
      new TextEncoder().encode(`${URL_WITH_KEY.slice(half)}\n`),
    ]);
    const { result, secrets, opened } = await read([["rpc-url-stdin", true]], stdin);
    assert.deepEqual(result, { rpcUrl: URL_WITH_KEY });
    assert.deepEqual(secrets, [PATH_SECRET, QUERY_SECRET]);
    assert.equal(opened, 1);
  });

  it("--rpc-url-stdin refuses a terminal at once, and a stream that fails", async () => {
    const terminal = await read([["rpc-url-stdin", true]], fakeStdin([], true));
    assert.deepEqual(issues(terminal.result), [
      "--rpc-url-stdin needs the URL piped on stdin, and stdin is a terminal",
    ]);
    const error = Object.assign(new Error(URL_WITH_KEY), { code: "EIO" });
    const failed = await read([["rpc-url-stdin", true]], fakeStdin([], false, error));
    assert.deepEqual(issues(failed.result), ["--rpc-url-stdin could not read stdin (EIO)"]);
  });

  it("--rpc-url-stdin refuses another reader of stdin before it opens stdin", async () => {
    const withKey = await read([
      ["rpc-url-stdin", true],
      ["api-key-stdin", true],
    ]);
    assert.deepEqual(issues(withKey.result), [
      "--rpc-url-stdin cannot be combined with --api-key-stdin: both would read stdin",
    ]);
    const withJson = await read([
      ["rpc-url-stdin", true],
      ["input-json", "-"],
    ]);
    assert.deepEqual(issues(withJson.result), [
      "--rpc-url-stdin cannot be combined with --input-json -: both would read stdin",
    ]);
    assert.equal(withKey.opened + withJson.opened, 0);
  });

  it("refuses two sources at once, and still makes the flag's parts secrets", async () => {
    const { result, secrets, opened } = await read([
      ["rpc-url", URL_WITH_KEY],
      ["rpc-url-stdin", true],
    ]);
    assert.deepEqual(issues(result), ["--rpc-url-stdin cannot be combined with --rpc-url"]);
    assert.deepEqual(secrets, [PATH_SECRET, QUERY_SECRET]);
    assert.equal(opened, 0);
    const both = await read([
      ["rpc-url-file", "a.txt"],
      ["rpc-url-stdin", true],
    ]);
    assert.deepEqual(issues(both.result), [
      "--rpc-url-stdin cannot be combined with --rpc-url-file",
    ]);
  });
});

describe("stdinConflict: one reader of stdin (R-AX-9)", () => {
  it("names the later option of each pair", () => {
    assert.deepEqual(
      stdinConflict(
        new Map<string, OptionValue>([
          ["api-key-stdin", true],
          ["input-json", "-"],
        ]),
      ),
      {
        field: "--api-key-stdin",
        message: "cannot be combined with --input-json -: both would read stdin",
      },
    );
    assert.equal(
      stdinConflict(new Map<string, OptionValue>([["input-json", "file.json"]])),
      undefined,
    );
    assert.equal(stdinConflict(new Map<string, OptionValue>([["rpc-url-stdin", true]])), undefined);
  });
});

describe("main: the parts of an RPC URL never reach stdout or stderr (R-SEC-1)", () => {
  // A command that reads the URL as verify does, then logs it and throws it, as a bug might.
  const leaky: Command = {
    name: "leaky",
    summary: "A test command.",
    usage: "",
    examples: [{ args: "leaky", description: "Run it." }],
    options: RPC_URL_OPTIONS,
    maxPositionals: 0,
    prepare: async (context) => {
      const found = await readRpcUrl(context);
      return {
        values: context.values,
        run: async (run) => {
          const url = found.issues === undefined ? String(found.rpcUrl) : "none";
          run.logger.info(`the URL is ${url}`, { url });
          return await Promise.reject(new Error(`failed at ${url.toUpperCase()}`));
        },
      };
    },
  };

  for (const format of ["text", "json"]) {
    it(`removes them in every case, with --log-format ${format}`, async () => {
      const fake = fakeIo(
        ["leaky", "--rpc-url-stdin", "--json", "--verbose", "--log-format", format],
        {
          stdin: [URL_WITH_KEY],
        },
      );
      const code = await main(fake.io, [leaky]);
      assert.equal(code, 6);
      const output = `${fake.stdout()}${fake.stderr()}`.toLowerCase();
      assert.ok(!output.includes(PATH_SECRET) && !output.includes(QUERY_SECRET), output);
      assert.match(fake.stderr(), /\[redacted\]/);
      const envelope = oneEnvelope(fake.stdout());
      assert.match(JSON.stringify(envelope), /\[redacted\]/);
    });
  }

  it("removes a part as typed, where the URL parser encodes a character", async () => {
    const typed = "c0ffee'1234%61bcd99";
    const path = file("url-quote.txt", `https://rpc.example.org/?k=${typed}`);
    const fake = fakeIo(["leaky", "--rpc-url-file", path, "--json", "--verbose"]);
    assert.equal(await main(fake.io, [leaky]), 6);
    const output = `${fake.stdout()}${fake.stderr()}`.toLowerCase();
    for (const form of [typed, "c0ffee%271234%61bcd99", "c0ffee'1234abcd99"]) {
      assert.ok(!output.includes(form), `${form} in ${output}`);
    }
  });
});

/** What the scrubbing stream writes for one write of `text`. */
function scrub(text: string, secrets: readonly string[]): string {
  let written = "";
  scrubbing(
    {
      write: (chunk) => {
        written += chunk;
      },
    },
    secrets,
  ).write(text);
  return written;
}

describe("scrubbing: a JSON line keeps its keys and structure (R-SEC-1, R-AX-5)", () => {
  it("scrubs only string values, and keeps the output contract's own words", () => {
    const result = {
      status: "dry-run",
      backend: "etherscan-compatible",
      apiHost: "127.0.0.1:1",
      lookup: "none",
    };
    const envelope = { schemaVersion: 1, ok: true, result };
    const secrets = ["schemaVersion", "etherscan-compatible", "127.0.0.1:1", "notpresent"];
    const out = scrub(`${JSON.stringify(envelope)}\n`, secrets);
    const parsed: unknown = JSON.parse(out);
    assert.deepEqual(parsed, { ...envelope, result: { ...result, apiHost: "[redacted]" } });
    assert.deepEqual(envelopeProblems(parsed), []);
    assert.ok(out.endsWith("}\n"));
  });

  it("removes a secret that is a property name or part of one (R-SEC-1)", () => {
    const secret = "propertynamesecret";
    const line = {
      details: { [secret]: 1, [`x-${secret}-y`]: { [secret]: "v" } },
      schemaVersion: 1,
    };
    const out = scrub(`${JSON.stringify(line)}\n`, [secret, "schemaVersion"]);
    assert.ok(!out.toLowerCase().includes(secret), out);
    assert.deepEqual(JSON.parse(out), {
      details: { "[redacted]": 1, "x-[redacted]-y": { "[redacted]": "v" } },
      schemaVersion: 1,
    });
  });

  it("walks arrays, and leaves numbers, booleans and null alone", () => {
    const text = `${JSON.stringify({ list: ["a-secret-word!", 2, null, false] })}\n`;
    assert.equal(scrub(text, ["a-secret-word"]), '{"list":["[redacted]!",2,null,false]}\n');
  });

  it("scrubs plain text, and text that only looks like JSON, as text", () => {
    const secrets = ["schemaVersion"];
    assert.equal(scrub("see schemaVersion here\n", secrets), "see [redacted] here\n");
    assert.equal(scrub('{"schemaVersion": no}\n', secrets), '{"[redacted]": no}\n');
    assert.equal(
      scrub('{"a":"x"}\n{"b":"schemaVersion"}\n', secrets),
      '{"a":"x"}\n{"b":"[redacted]"}\n',
    );
    assert.equal(scrub('{"b":"schemaVersion"}', secrets), '{"b":"[redacted]"}');
  });
});
