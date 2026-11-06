// The CLI's words for an error (R-AX-5, R-AX-10, R-SEC-1, R-AX-9): a hint in CLI terms for every
// code, the next command, the issues and candidates under the error line, and no key anywhere.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ERROR_CODES, ERROR_HINTS, ExplorerVerifyError } from "explorer-verify";
import type {
  Envelope,
  ErrorCode,
  ErrorDetails,
  ErrorJson,
  Handle,
  HandleString,
} from "explorer-verify";

import type { Command } from "../../src/command.ts";
import {
  MAX_LISTED,
  cliErrorJson,
  cliHint,
  detailLines,
  hasOwnHint,
  listed,
  nextCommand,
  ownHint,
  inCliWords,
  shellLine,
  visible,
} from "../../src/hints.ts";
import { main } from "../../src/main.ts";
import { cliEnvelope } from "../../src/output.ts";
import { createStderr } from "../../src/stderr.ts";
import { sampleError } from "../helpers/error-samples.ts";
import { fakeIo } from "../helpers/fake-io.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";

// A fake key in lower-case hex, the shape of a Blockscout or Routescan key. Never a real one.
const DUMMY_KEY = "0123456789abcdef0123456789abcdef";
const ADDRESS = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const LINE = `ev1:sourcify:11155111:${ADDRESS}:550e8400-e29b-41d4-a716-446655440000`;
const PAGES = new URL("../../../../docs/user/reference/errors/", import.meta.url);

/** The words R-AX-10 forbids in a CLI hint: they name the library's API. */
const FORBIDDEN = ["()", "details.", "options.", "apiKeys", "route."];

function handle(backend: Handle["backend"] = "sourcify", jobId = DUMMY_KEY): Handle {
  return { version: 1, backend, chainId: 11155111, address: ADDRESS, jobId };
}

// Details for every code with the dummy key planted in every string a caller can reach.
const LEAKY: { readonly [C in ErrorCode]: ErrorDetails } = {
  "invalid-input": {
    code: "invalid-input",
    issues: [
      { field: `route.apiUrl?apikey=${DUMMY_KEY}`, message: `must not hold ${DUMMY_KEY}` },
      { field: "chainId", message: `see ${DUMMY_KEY}` },
    ],
  },
  "not-confirmed": { code: "not-confirmed", handle: handle() },
  "unsupported-chain": { code: "unsupported-chain", chainId: 1, backend: "sourcify" },
  network: { code: "network", backend: "sourcify", attempts: 3 },
  "rate-limited": { code: "rate-limited", backend: "sourcify", retryAfterMs: 2_500 },
  timeout: { code: "timeout", backend: "sourcify", timeoutMs: 1 },
  "unexpected-response": {
    code: "unexpected-response",
    backend: "sourcify",
    status: 500,
    excerpt: `{"key":"${DUMMY_KEY}"}`,
    attempts: 3,
  },
  "in-progress": { code: "in-progress", backend: "sourcify" },
  "unknown-state": { code: "unknown-state", handle: handle(), excerpt: `x ${DUMMY_KEY}` },
  "job-not-found": { code: "job-not-found", handle: handle() },
  cancelled: { code: "cancelled", handles: [handle(), handle("routescan")] },
  "incomplete-input": {
    code: "incomplete-input",
    field: "contract",
    candidates: ["src/A.sol:A", `src/${DUMMY_KEY}.sol:B`],
  },
  "insufficient-artifact": { code: "insufficient-artifact", field: "input" },
  "unsupported-compiler": { code: "unsupported-compiler", field: `x ${DUMMY_KEY}` },
  "verification-inconclusive": {
    code: "verification-inconclusive",
    backend: "sourcify",
    reason: `internal_error ${DUMMY_KEY}`,
  },
  "source-mismatch": {
    code: "source-mismatch",
    path: `src/${DUMMY_KEY}.sol`,
    expected: `0x${"a".repeat(64)}`,
    actual: `0x${"b".repeat(64)}`,
  },
  "missing-api-key": { code: "missing-api-key", backend: "routescan" },
  "api-key-rejected": { code: "api-key-rejected", backend: "routescan" },
  "quota-exceeded": { code: "quota-exceeded", backend: "routescan" },
  "internal-error": { code: "internal-error" },
  "no-metadata-hash": { code: "no-metadata-hash", found: "no-code" },
  "metadata-unavailable": {
    code: "metadata-unavailable",
    hash: `ipfs:${DUMMY_KEY}`,
    attempts: [{ source: "ipfs", outcome: "not-found", status: 404 }],
  },
  "constructor-args-unavailable": { code: "constructor-args-unavailable", reason: "bad-length" },
  "proxy-link-pending": { code: "proxy-link-pending", backend: "routescan" },
  "proxy-link-unknown-state": {
    code: "proxy-link-unknown-state",
    backend: "routescan",
    excerpt: `Error! ${DUMMY_KEY}`,
  },
  "handler-refused": {
    code: "handler-refused",
    backend: "etherscan-v2",
    status: 403,
    handlerCode: `chain-${DUMMY_KEY}`,
    excerpt: `{"error":"${DUMMY_KEY}"}`,
  },
};

/** The CLI hint of `rate-limited` with the wait the explorer asked for. */
function wait(retryAfterMs?: number): string {
  return cliHint({
    ...sampleError("rate-limited"),
    code: "rate-limited",
    details: {
      code: "rate-limited",
      backend: "sourcify",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  });
}

/** A command table whose one command throws `thrown`. */
function throwing(thrown: unknown): Command[] {
  return [
    {
      name: "custom",
      summary: "A test command.",
      usage: "",
      examples: [{ args: "custom", description: "Run it." }],
      options: {},
      maxPositionals: 0,
      run: async () => await Promise.reject(thrown),
    },
  ];
}

/** The stderr text of one error block, as the CLI writes it. */
function errorText(error: ErrorJson, next?: readonly string[], format: "text" | "json" = "text") {
  let text = "";
  const stderr = createStderr({
    stream: {
      write: (chunk) => {
        text += chunk;
      },
    },
    level: "info",
    format,
    color: false,
    spinner: false,
  });
  stderr.error(error, next);
  return text;
}

/** The paragraph of a page that starts with `label`, with its lines joined and code marks gone. */
function paragraph(text: string, label: string): string | undefined {
  const start = text.search(new RegExp(`^${label} `, "m"));
  if (start === -1) {
    return undefined;
  }
  const end = text.indexOf("\n\n", start);
  return text
    .slice(start + label.length, end === -1 ? undefined : end)
    .replace(/\s+/g, " ")
    .replaceAll("`", "")
    .trim();
}

describe("CLI hints (R-AX-10)", () => {
  for (const code of ERROR_CODES) {
    it(`${code}: the CLI renderer gives a hint without the library's API words`, () => {
      const error = cliErrorJson(sampleError(code));
      const rendered = [error.hint, errorText(error, nextCommand(error, { json: true }))];
      for (const text of rendered) {
        for (const word of FORBIDDEN) {
          assert.ok(!text.includes(word), `${code}: ${word}`);
        }
      }
      assert.ok(error.hint.trim().length > 0);
    });
  }

  it("replaces every default hint of the library that names its API (R-AX-10)", () => {
    for (const code of ERROR_CODES) {
      const json = sampleError(code);
      const hint = cliErrorJson(json).hint;
      if (inCliWords(ERROR_HINTS[code]) === undefined) {
        assert.notEqual(hint, ERROR_HINTS[code], code);
      }
      for (const word of FORBIDDEN) {
        assert.ok(!hint.includes(word), `${code}: ${word}`);
      }
    }
  });

  it("states the CLI hint on each code's page, on its From the CLI line", () => {
    for (const code of ERROR_CODES) {
      const page = readFileSync(new URL(`${code}.md`, PAGES), "utf8");
      assert.equal(paragraph(page, "From the CLI:"), cliHint(sampleError(code)), code);
    }
  });

  it("keeps a specific library hint in plain words, and the hint of an error the CLI built", () => {
    const plain = { ...sampleError("unsupported-compiler"), hint: "Rebuild with solc." };
    assert.equal(cliErrorJson(plain).hint, "Rebuild with solc.");
    const own = { ...sampleError("invalid-input"), hint: "Set route.backend in the request." };
    assert.equal(cliErrorJson(own, { own: true }).hint, "Set route.backend in the request.");
    assert.notEqual(cliErrorJson(own).hint, own.hint);
  });

  it("marks only the errors the CLI built", () => {
    const error = new ExplorerVerifyError({ code: "internal-error" }, "m", { secrets: [] });
    assert.equal(hasOwnHint(error), false);
    assert.equal(ownHint(error), error);
    assert.equal(hasOwnHint(error), true);
    assert.equal(hasOwnHint(undefined), false);
    assert.equal(hasOwnHint("x"), false);
  });

  it("names ETHERSCAN_API_KEY or ROUTESCAN_API_KEY and --api-key-file for missing-api-key", () => {
    const etherscan = cliHint(sampleError("missing-api-key"));
    assert.match(etherscan, /ETHERSCAN_API_KEY/);
    assert.match(etherscan, /--api-key-file/);
    const routescan = cliHint({
      ...sampleError("missing-api-key"),
      code: "missing-api-key",
      details: { code: "missing-api-key", backend: "routescan" },
    });
    assert.match(routescan, /ROUTESCAN_API_KEY/);
    assert.match(routescan, /--api-key-file/);
    const standalone = cliHint({
      ...sampleError("missing-api-key"),
      code: "missing-api-key",
      details: { code: "missing-api-key", backend: "etherscan-compatible" },
    });
    assert.match(standalone, /pass --api-key-file <path> or --api-key-stdin .* and --api-url/);
  });

  it("names where the refused key came from: the variable, the key file or stdin, or the key passed", () => {
    const base = sampleError("api-key-rejected");
    assert.match(cliHint(base), /ETHERSCAN_API_KEY/);
    assert.match(cliHint(base, { keyFlag: true }), /the key file or stdin you passed/);
    assert.doesNotMatch(cliHint(base, { keyFlag: true }), /ETHERSCAN_API_KEY/);
    const other = cliHint({
      ...base,
      code: "api-key-rejected",
      details: { code: "api-key-rejected", backend: "etherscan-compatible" },
    });
    assert.match(other, /the key you passed/);
  });

  it("fills in the candidates, the source path and the wait", () => {
    const base = sampleError("incomplete-input");
    const names = Array.from(
      { length: MAX_LISTED + 2 },
      (_, index) => `src/C${String(index)}.sol:C`,
    );
    const withField = (
      field: "input" | "compilerVersion" | "contract" | "sources",
      list: string[],
    ) =>
      cliHint({
        ...base,
        code: "incomplete-input",
        details: { code: "incomplete-input", field, candidates: list },
      });
    assert.match(
      withField("contract", names),
      /--contract with one of: src\/C0\.sol:C, .* and 2 more\./,
    );
    assert.match(withField("contract", []), /--contract as path:Name/);
    assert.match(withField("compilerVersion", []), /--compiler-version/);
    assert.match(withField("sources", ["a.sol"]), /build-info file of the same build/);
    assert.match(withField("input", []), /forge build --build-info/);
    assert.equal(listed(["a", "b"]), "a, b");
    assert.match(wait(2_500), /Wait 3 s,/);
    assert.match(wait(), /Wait a few seconds,/);
    assert.match(wait(0), /Wait a few seconds,/);
    assert.match(wait(Number.NaN), /Wait a few seconds,/);
    assert.match(cliHint(sampleError("source-mismatch")), /source file <path> exactly/);
  });

  it("tells cancelled runs to resume each handle, or to run again when none was accepted", () => {
    const one = sampleError("cancelled");
    assert.match(
      cliHint(one),
      /explorer-verify status ev1:sourcify:11155111:0x<address>:<job> instead/,
    );
    const several: ErrorJson = {
      code: "cancelled",
      message: "m",
      hint: ERROR_HINTS.cancelled,
      docsUrl: one.docsUrl,
      retryable: false,
      handles: [{ backend: "sourcify", handle: LINE }],
      details: { code: "cancelled", handles: [LINE] },
    };
    assert.match(cliHint(several), /Resume each handle listed/);
    const none: ErrorJson = { ...several, details: { code: "cancelled" } };
    delete none.handles;
    assert.match(cliHint(none), /before any explorer accepted a submission/);
  });

  it("asks for --api-url when a not-confirmed handle is etherscan-compatible", () => {
    const line = `ev1:etherscan-compatible:1:${ADDRESS}:job`;
    const error: ErrorJson = {
      ...sampleError("not-confirmed"),
      code: "not-confirmed",
      handle: line,
      details: { code: "not-confirmed", handle: line },
    };
    assert.match(cliHint(error), /--api-url <the same URL>/);
    assert.equal(nextCommand(error, { json: true }), undefined);
  });
});

describe("nextCommand (R-AX-5)", () => {
  it("resumes not-confirmed and a cancelled run with one handle with status, never verify", () => {
    const pending: ErrorJson = {
      ...sampleError("not-confirmed"),
      code: "not-confirmed",
      handle: LINE,
      details: { code: "not-confirmed", handle: LINE },
    };
    assert.deepEqual(nextCommand(pending, { json: true }), [
      "explorer-verify",
      "status",
      LINE,
      "--json",
    ]);
    assert.deepEqual(nextCommand(pending, { json: false }), ["explorer-verify", "status", LINE]);
    const cancelled: ErrorJson = {
      ...sampleError("cancelled"),
      code: "cancelled",
      handle: LINE,
      details: { code: "cancelled", handle: LINE },
    };
    assert.deepEqual(nextCommand(cancelled, { json: false }), ["explorer-verify", "status", LINE]);
    for (const code of ERROR_CODES) {
      if (code !== "not-confirmed" && code !== "cancelled") {
        assert.equal(nextCommand(sampleError(code), { json: true }), undefined, code);
      }
    }
    const none: ErrorJson = { ...cancelled, details: { code: "cancelled" } };
    delete none.handle;
    assert.equal(nextCommand(none, { json: true }), undefined);
  });

  it("runs as is: a not-confirmed run's nextCommand calls status, never verify", async () => {
    const pending = new ExplorerVerifyError(
      { code: "not-confirmed", handle: handle("sourcify", "550e8400-e29b-41d4-a716-446655440000") },
      "Still verifying.",
      { hint: ERROR_HINTS["not-confirmed"], secrets: [] },
    );
    const first = fakeIo(["custom", "--json"]);
    assert.equal(await main(first.io, throwing(pending)), 4);
    const next: unknown = Reflect.get(oneEnvelope(first.stdout()), "nextCommand");
    assert.ok(Array.isArray(next));
    const argv = next.map(String);
    assert.equal(argv[0], "explorer-verify");
    const ran: string[] = [];
    const stub = (name: string): Command => ({
      name,
      summary: "A stub.",
      usage: "<handle>",
      examples: [{ args: name, description: "Run it." }],
      options: {},
      maxPositionals: 1,
      run: ({ positionals }) => {
        ran.push(name, ...positionals);
        return Promise.resolve({ status: "verified", backend: "sourcify", match: "exact" });
      },
    });
    const second = fakeIo(argv.slice(1));
    assert.equal(await main(second.io, [stub("verify"), stub("status")]), 0);
    assert.deepEqual(ran, ["status", LINE]);
  });

  it("is added after error in the CLI envelope, which the schema accepts", () => {
    const pending: ErrorJson = {
      ...sampleError("not-confirmed"),
      code: "not-confirmed",
      handle: LINE,
      details: { code: "not-confirmed", handle: LINE },
    };
    const envelope = cliEnvelope({ schemaVersion: 1, ok: false, error: pending }, { json: true });
    assert.deepEqual(Object.keys(envelope), ["schemaVersion", "ok", "error", "nextCommand"]);
    assert.deepEqual(envelopeProblems(JSON.parse(JSON.stringify(envelope))), []);
    const plain = cliEnvelope(
      { schemaVersion: 1, ok: false, error: sampleError("network") },
      { json: true },
    );
    assert.deepEqual(Object.keys(plain), ["schemaVersion", "ok", "error"]);
  });

  it("gives each failed backend of a run on several backends the CLI hint", () => {
    const envelope = cliEnvelope(
      {
        schemaVersion: 1,
        ok: false,
        result: {
          outcomes: [
            {
              backend: "sourcify",
              ok: true,
              result: { status: "verified", backend: "sourcify", match: "exact" },
            },
            { backend: "etherscan-v2", ok: false, error: sampleError("missing-api-key") },
          ],
        },
      },
      {},
    );
    assert.ok("result" in envelope && "outcomes" in envelope.result);
    const failed = envelope.result.outcomes[1];
    assert.ok(failed !== undefined && "error" in failed);
    assert.match(failed.error.hint, /ETHERSCAN_API_KEY/);
    const verified: Envelope = {
      schemaVersion: 1,
      ok: true,
      result: { status: "verified", backend: "sourcify", match: "exact" },
    };
    assert.equal(cliEnvelope(verified, {}), verified);
  });
});

describe("the error block on stderr (R-AX-6, R-AX-14)", () => {
  it("lists the issues the message does not state, and the candidates", () => {
    const invalid: ErrorJson = {
      ...sampleError("invalid-input"),
      code: "invalid-input",
      message: "The input is invalid: address must be 0x followed by 40 hex digits; also chainId.",
      details: {
        code: "invalid-input",
        issues: [
          { field: "address", message: "must be 0x followed by 40 hex digits" },
          { field: "chainId", message: "must be a positive integer" },
        ],
      },
    };
    assert.deepEqual(detailLines(invalid), ["issue: chainId must be a positive integer"]);
    const text = errorText(cliErrorJson(invalid));
    assert.match(
      text,
      /^error: The input is invalid: .*\n {2}issue: chainId must be a positive integer\n {2}hint: /,
    );
    assert.deepEqual(detailLines(sampleError("incomplete-input")), ["candidates: <names>"]);
    const sources: ErrorJson = {
      ...sampleError("incomplete-input"),
      code: "incomplete-input",
      details: { code: "incomplete-input", field: "sources", candidates: ["a.sol", "b.sol"] },
    };
    assert.deepEqual(detailLines(sources), ["missing sources: a.sol, b.sol"]);
    const none: ErrorJson = {
      ...sources,
      code: "incomplete-input",
      details: { code: "incomplete-input", field: "input", candidates: [] },
    };
    assert.deepEqual(detailLines(none), []);
    assert.deepEqual(detailLines(sampleError("network")), []);
  });

  it("prints the next command on a next: line, and as nextCommand in a JSON line", () => {
    const pending = cliErrorJson({
      ...sampleError("not-confirmed"),
      code: "not-confirmed",
      handle: LINE,
      details: { code: "not-confirmed", handle: LINE },
    });
    const next = nextCommand(pending, { json: false });
    assert.match(
      errorText(pending, next),
      new RegExp(`\\n {2}next: explorer-verify status ${LINE}\\n$`),
    );
    const line: unknown = JSON.parse(errorText(pending, next, "json"));
    assert.equal(Reflect.get(Object(line), "nextCommand"), `explorer-verify status ${LINE}`);
    assert.ok(!errorText(pending).includes("next:"));
  });
});

describe("no key in the CLI's error output (R-SEC-1, R-AX-9)", () => {
  for (const code of ERROR_CODES) {
    it(`${code}: no lower-case hex dummy key on stdout or stderr, in text or JSON`, async () => {
      for (const argv of [
        ["custom", "--json"],
        ["custom", "--log-format", "json", "--verbose"],
        ["custom"],
      ]) {
        const error = new ExplorerVerifyError(LEAKY[code], `failed with ${DUMMY_KEY}`, {
          hint: ERROR_HINTS[code],
          secrets: [DUMMY_KEY],
          cause: new Error(`inner ${DUMMY_KEY}`),
        });
        const fake = fakeIo(argv);
        await main(fake.io, throwing(error));
        assert.ok(!fake.stdout().includes(DUMMY_KEY), `${code} ${argv.join(" ")}: stdout`);
        assert.ok(!fake.stderr().includes(DUMMY_KEY), `${code} ${argv.join(" ")}: stderr`);
        if (argv.includes("--json")) {
          const envelope = oneEnvelope(fake.stdout());
          assert.deepEqual(envelopeProblems(envelope), [], code);
          const json: unknown = Reflect.get(envelope, "error");
          assert.equal(Reflect.get(Object(Reflect.get(Object(json), "details")), "code"), code);
        }
      }
    });
  }

  it("prints issues and candidates in --json under error.details (R-AX-5)", async () => {
    const issues = new ExplorerVerifyError(
      {
        code: "invalid-input",
        issues: [{ field: "address", message: "must be 0x followed by 40 hex digits" }],
      },
      "The input is invalid: address must be 0x followed by 40 hex digits.",
      { hint: ERROR_HINTS["invalid-input"], secrets: [] },
    );
    const fake = fakeIo(["custom", "--json"]);
    assert.equal(await main(fake.io, throwing(issues)), 2);
    const envelope = oneEnvelope(fake.stdout());
    assert.deepEqual(Reflect.get(Object(Reflect.get(envelope, "error")), "details"), {
      code: "invalid-input",
      issues: [{ field: "address", message: "must be 0x followed by 40 hex digits" }],
    });
    assert.equal(Reflect.get(envelope, "nextCommand"), undefined);
  });
});

/** A not-confirmed error object with the one-line handle `line`. */
function pendingError(line: HandleString): ErrorJson {
  return {
    ...sampleError("not-confirmed"),
    code: "not-confirmed",
    handle: line,
    details: { code: "not-confirmed", handle: line },
  };
}

describe("nextCommand runs as it is, or is left out (R-AX-5, R-SEC-1)", () => {
  it("is left out when the key came from --api-key-file or --api-key-stdin, and the hint says so", () => {
    const error = pendingError(LINE);
    assert.equal(nextCommand(error, { keyFlag: true }), undefined);
    assert.match(
      cliHint(error, { keyFlag: true }),
      new RegExp(`status ${LINE} with the same key flag later`),
    );
    assert.deepEqual(nextCommand(error, { keyFlag: false }), ["explorer-verify", "status", LINE]);
  });

  it("is left out for a handle whose job id was redacted, as a job id holding the key is (D2)", () => {
    const redacted = `ev1:sourcify:11155111:${ADDRESS}:[redacted]`;
    assert.equal(nextCommand(pendingError(redacted), { json: true }), undefined);
    const error = new ExplorerVerifyError(
      { code: "not-confirmed", handle: handle("sourcify", `job-${DUMMY_KEY}`) },
      "Still verifying.",
      { hint: ERROR_HINTS["not-confirmed"], secrets: [DUMMY_KEY] },
    );
    const json = error.toJSON();
    assert.ok(!JSON.stringify(json).includes(DUMMY_KEY));
    assert.equal(nextCommand(cliErrorJson(json), { json: true }), undefined);
  });

  it("names --api-url for an Etherscan-compatible handle, without a stray comma", () => {
    const line = `ev1:etherscan-compatible:1:${ADDRESS}:job`;
    const hint = cliHint(pendingError(line), { keyFlag: true });
    assert.match(hint, / with --api-url <the same URL> and the same key flag later /);
  });
});

describe("the CLI's own hints (R-AX-10, D3)", () => {
  it("rewrites the library's hint for a chain without a row as a whole, in the one table", () => {
    assert.equal(
      inCliWords("Set allowSourcifyFallback: true, or set route.apiUrl and route.backend."),
      "Pass --allow-sourcify-fallback to verify on the public Sourcify API, or pass --api-url with --backend.",
    );
  });

  it("keeps a usage error's hint, which has none of the library's words", async () => {
    const fake = fakeIo(["verify", "--nope", "--json"]);
    assert.equal(await main(fake.io), 2);
    const hint = String(
      Reflect.get(Object(Reflect.get(oneEnvelope(fake.stdout()), "error")), "hint"),
    );
    assert.match(hint, /explorer-verify --help lists every command and option\./);
    for (const word of FORBIDDEN) {
      assert.ok(!hint.includes(word), word);
    }
  });

  it("says what is missing in a missing-api-key message that names the library's options", () => {
    const json: ErrorJson = {
      ...sampleError("missing-api-key"),
      code: "missing-api-key",
      message:
        "etherscan-v2 needs an API key and none is set for api.etherscan.io: set apiKeys.etherscan-v2, or handlerUrl.",
      details: { code: "missing-api-key", backend: "etherscan-v2" },
    };
    assert.equal(cliErrorJson(json).message, "etherscan-v2 needs an API key and none is set.");
    for (const reason of [
      "apiKeys.etherscan-v2 goes only to Etherscan's own API; set route.apiKey for this route.apiUrl",
      "a route with route.apiUrl takes no key from apiKeys.etherscan-v2; set route.apiKey",
    ]) {
      const routed: ErrorJson = {
        ...json,
        message: `etherscan-v2 needs an API key and none is set for x.example: ${reason}.`,
      };
      assert.equal(
        cliErrorJson(routed).message,
        "etherscan-v2 needs an API key for this --api-url and none is set.",
      );
    }
    const standalone: ErrorJson = {
      ...json,
      message:
        "etherscan-compatible needs an API key and none is set for x.example: set route.apiKey.",
    };
    assert.equal(
      cliErrorJson(standalone).message,
      "etherscan-v2 needs an API key and none is set.",
    );
    const plain = { ...json, message: "The explorer answered that the key is missing." };
    assert.equal(cliErrorJson(plain).message, plain.message);
    assert.equal(cliErrorJson(json, { own: true }), json);
  });
});

describe("terminal safety of the error block (R-AX-6)", () => {
  it("escapes control characters, so a value cannot forge a next: line or send ANSI or OSC", () => {
    assert.equal(visible("a\nb\u001B[31mc\u009Bd\u007F"), "a\\u000ab\\u001b[31mc\\u009bd\\u007f");
    const bidi = "\u061C\u200E\u200F\u202A\u202E\u2066\u2069\u2028\u2029\uFEFF";
    assert.equal(
      visible(`a${bidi}b`),
      "a\\u061c\\u200e\\u200f\\u202a\\u202e\\u2066\\u2069\\u2028\\u2029\\ufeffb",
    );
    assert.equal(visible("\u202Dx\u2065\u2030"), "\\u202dx\u2065\u2030");
    const forged = "x\n  next: explorer-verify verify --backend etherscan-v2\u001B]0;title\u0007";
    const error: ErrorJson = {
      ...sampleError("incomplete-input"),
      code: "incomplete-input",
      message: `Bad ${forged}`,
      hint: `Do ${forged}`,
      details: { code: "incomplete-input", field: "contract", candidates: [`a.sol:${forged}`] },
    };
    const text = errorText(error);
    assert.equal(text.split("\n").filter((line) => line.startsWith("  next:")).length, 0);
    assert.ok(!text.includes("\u001B"));
    assert.ok(!text.includes("\u0007"));
    const invalid: ErrorJson = {
      ...sampleError("invalid-input"),
      code: "invalid-input",
      details: { code: "invalid-input", issues: [{ field: "x", message: forged }] },
    };
    assert.equal(
      errorText(invalid)
        .split("\n")
        .filter((line) => line.startsWith("  next:")).length,
      0,
    );
  });

  it("quotes the words of the next: line that a shell would read otherwise", () => {
    assert.equal(
      shellLine(["explorer-verify", "status", LINE, "--json"]),
      `explorer-verify status ${LINE} --json`,
    );
    assert.equal(shellLine(["a b", "it's", "$(x)"]), `'a b' 'it'\\''s' '$(x)'`);
  });
});
