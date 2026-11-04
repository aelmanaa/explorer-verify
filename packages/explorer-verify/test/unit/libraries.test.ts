// Tests for library link addresses (R-IN-4): `VerifyInput.libraries` in validateInput, the merge
// in linkLibraries, and verify(), which sends the input unchanged. The linked contracts are real
// builds: the solc-js and Hardhat 3 fixtures of a contract that calls the library `Tally`, and the
// two contracts of live probe E (2026-11-03), whose Sourcify answers are replayed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { buildVerifyInput, linkLibraries, validateInput, verify } from "../../src/index.ts";
import type { VerifyInput, VerifyResult } from "../../src/index.ts";

/** A JSON file, read relative to this test. */
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

/** `value` as a plain object, failing the test when it is not one. */
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

/** The error a call throws, failing the test when it returns or throws anything else. */
function thrown(run: () => unknown): ExplorerVerifyError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ExplorerVerifyError, "expected an ExplorerVerifyError");
  return caught;
}

/** The issues of an `invalid-input` error, failing the test on any other outcome. */
function issuesOf(run: () => unknown): { field: string; message: string }[] {
  const error = thrown(run);
  assert.ok(error.details.code === "invalid-input", error.message);
  return error.details.issues.map(({ field, message }) => ({ field, message }));
}

// solc-js 0.8.24 build of Counter, compiled with Tally's address already in settings.libraries.
const SOLC = "../fixtures/build-formats/solc-0.8.24-library/";
const TALLY = "0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c";

function solcInput(libraries?: Record<string, unknown>): Record<string, unknown> {
  return {
    chainId: 11155111,
    address: `0x${"1".repeat(40)}`,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: readJson(`${SOLC}input.json`),
    },
    contractName: "src/Counter.sol:Counter",
    ...(libraries === undefined ? {} : { libraries }),
  };
}

/** The same build with `settings.libraries` replaced by `libraries`, as a tool that links later. */
function unlinkedSolcInput(
  settingsLibraries: unknown,
  libraries?: Record<string, unknown>,
): Record<string, unknown> {
  const input = solcInput(libraries);
  const compiler = record(input["compiler"]);
  const standard = record(compiler["input"]);
  const settings = record(standard["settings"]);
  return {
    ...input,
    compiler: {
      ...compiler,
      input: { ...standard, settings: { ...settings, libraries: settingsLibraries } },
    },
  };
}

// Hardhat 3.21.2 build of the same Counter: it links when it deploys, so the input has no libraries.
const HARDHAT = "../../../hardhat/test/fixtures/hardhat-3.21.2/artifacts/";
const HARDHAT_BUILD = "solc-0_8_24-2c15e64bd16481586acae188ce2eaa479a4781e0";

function hardhatInput(): VerifyInput {
  const built = buildVerifyInput([
    readJson(`${HARDHAT}contracts/Counter.sol/Counter.json`),
    readJson(`${HARDHAT}build-info/${HARDHAT_BUILD}.json`),
    readJson(`${HARDHAT}build-info/${HARDHAT_BUILD}.output.json`),
  ]);
  return { chainId: 11155111, address: `0x${"2".repeat(40)}`, ...built };
}

/** `path:Name` of each link reference in the Hardhat 3 artifact, mapped to `address`. */
function hardhatLinks(address: string): Record<string, string> {
  const artifact = record(readJson(`${HARDHAT}contracts/Counter.sol/Counter.json`));
  const links: Record<string, string> = {};
  for (const [path, names] of Object.entries(record(artifact["linkReferences"]))) {
    for (const name of Object.keys(record(names))) {
      links[`${path}:${name}`] = address;
    }
  }
  return links;
}

describe("linkLibraries (R-IN-4)", () => {
  it("merges libraries into settings.libraries in Standard JSON shape (R-IN-4)", () => {
    const input = hardhatInput();
    assert.equal(input.compiler.input.settings["libraries"], undefined);
    const links = hardhatLinks(TALLY);
    assert.deepEqual(Object.keys(links), ["project/contracts/Tally.sol:Tally"]);

    const linked = linkLibraries({ ...input, libraries: links });

    assert.deepEqual(linked.compiler.input.settings["libraries"], {
      "project/contracts/Tally.sol": { Tally: TALLY.toLowerCase() },
    });
    assert.deepEqual(linked.libraries, {
      "project/contracts/Tally.sol:Tally": TALLY.toLowerCase(),
    });
    // Every other setting, every source and the caller's object stay as they were.
    const { libraries: _added, ...otherSettings } = linked.compiler.input.settings;
    assert.deepEqual(otherSettings, input.compiler.input.settings);
    assert.deepEqual(linked.compiler.input.sources, input.compiler.input.sources);
    assert.equal(input.compiler.input.settings["libraries"], undefined);
  });

  it("gives back the input solc compiled when the addresses are merged into an unlinked copy (R-IN-4)", () => {
    const original = validateInput(solcInput());
    const linked = linkLibraries(unlinkedSolcInput({}, { "src/Tally.sol:Tally": TALLY }));
    assert.deepEqual(linked.compiler.input.settings["libraries"], {
      "src/Tally.sol": { Tally: TALLY.toLowerCase() },
    });
    const { libraries: _linked, ...linkedSettings } = linked.compiler.input.settings;
    const { libraries: _original, ...originalSettings } = original.compiler.input.settings;
    assert.deepEqual(linkedSettings, originalSettings);
  });

  it("keeps the entries settings.libraries already holds, and is idempotent (R-IN-4)", () => {
    const other = `0x${"a".repeat(40)}`;
    const input = unlinkedSolcInput(
      { "src/Tally.sol": { Other: other }, "src/Counter.sol": "kept as it is" },
      { "src/Tally.sol:Tally": TALLY },
    );
    const linked = linkLibraries(input);
    assert.deepEqual(linked.compiler.input.settings["libraries"], {
      "src/Tally.sol": { Other: other, Tally: TALLY.toLowerCase() },
      "src/Counter.sol": "kept as it is",
    });
    assert.deepEqual(linkLibraries(linked), linked);
  });

  it("adds a library named __proto__ as a key, never as a prototype (R-IN-4)", () => {
    const libraries = JSON.parse(`{"src/Tally.sol:__proto__":"${TALLY}"}`);
    const linked = linkLibraries(unlinkedSolcInput({}, record(libraries)));
    const entry = record(record(linked.compiler.input.settings["libraries"])["src/Tally.sol"]);
    assert.ok(Object.hasOwn(entry, "__proto__"));
    assert.equal(Object.getPrototypeOf(entry), Object.prototype);
  });

  it("leaves the input unchanged when libraries is absent (R-IN-4)", () => {
    const input = hardhatInput();
    const checked = validateInput(input);
    assert.equal(Object.hasOwn(checked, "libraries"), false);
    assert.deepEqual(linkLibraries(input), checked);
    assert.deepEqual(linkLibraries(solcInput()), validateInput(solcInput()));
  });

  it("rejects a conflicting address already in settings.libraries (R-IN-4)", () => {
    const other = `0x${"b".repeat(40)}`;
    for (const run of [validateInput, linkLibraries]) {
      assert.deepEqual(
        issuesOf(() => run(solcInput({ "src/Tally.sol:Tally": other }))),
        [
          {
            field: "libraries.1",
            message: "conflicts with compiler.input.settings.libraries",
          },
        ],
      );
    }
    // The same address in another case is the same address.
    const same = linkLibraries(
      solcInput({ "src/Tally.sol:Tally": TALLY.toUpperCase().replace("0X", "0x") }),
    );
    assert.deepEqual(same.compiler.input.settings["libraries"], {
      "src/Tally.sol": { Tally: TALLY.toLowerCase() },
    });
  });
});

describe("validateInput libraries (R-IN-4, R-IN-6)", () => {
  it("rejects any other value settings.libraries already holds for the library under its path (R-IN-4)", () => {
    const links = { "src/Tally.sol:Tally": TALLY };
    const other = `0x${"c".repeat(40)}`;
    const held: unknown[] = [
      { "src/Tally.sol": { Tally: 5 } },
      { "src/Tally.sol": { Tally: [TALLY] } },
      { "src/Tally.sol": { Tally: null } },
      { "src/Tally.sol": { Tally: other } },
    ];
    for (const settingsLibraries of held) {
      for (const run of [validateInput, linkLibraries]) {
        assert.deepEqual(
          issuesOf(() => run(unlinkedSolcInput(settingsLibraries, links))),
          [{ field: "libraries.1", message: "conflicts with compiler.input.settings.libraries" }],
          JSON.stringify(settingsLibraries),
        );
      }
    }
  });

  it("compares an entry under the empty path in linkLibraries, not in validateInput (R-IN-4)", () => {
    const links = { "src/Tally.sol:Tally": TALLY, "src/Counter.sol:Other": TALLY };
    const other = `0x${"c".repeat(40)}`;
    for (const shared of [{ Tally: other }, { Tally: 5 }, { Tally: null }]) {
      // validateInput leaves the empty path to the compiler: verify() sends the input unchanged.
      assert.deepEqual(validateInput(unlinkedSolcInput({ "": shared }, links)).libraries, {
        "src/Tally.sol:Tally": TALLY.toLowerCase(),
        "src/Counter.sol:Other": TALLY.toLowerCase(),
      });
      assert.deepEqual(
        issuesOf(() => linkLibraries(unlinkedSolcInput({ "": shared }, links))),
        [{ field: "libraries.1", message: "conflicts with compiler.input.settings.libraries" }],
        JSON.stringify(shared),
      );
    }
    // The same address under the empty path, in any case, is accepted, and the path entry is added.
    const upper = TALLY.toUpperCase().replace("0X", "0x");
    const linked = linkLibraries(unlinkedSolcInput({ "": { Tally: upper } }, links));
    assert.deepEqual(linked.compiler.input.settings["libraries"], {
      "": { Tally: upper },
      "src/Tally.sol": { Tally: TALLY.toLowerCase() },
      "src/Counter.sol": { Other: TALLY.toLowerCase() },
    });
    // An empty-path entry that is not an object names no library, and is copied as it is.
    const kept = linkLibraries(unlinkedSolcInput({ "": "kept" }, links));
    assert.equal(record(kept.compiler.input.settings["libraries"])[""], "kept");
  });

  it("keeps libraries with each address in lower case (R-IN-1, R-IN-4)", () => {
    const checked = validateInput(unlinkedSolcInput({}, { "src/Tally.sol:Tally": TALLY }));
    assert.deepEqual(checked.libraries, { "src/Tally.sol:Tally": TALLY.toLowerCase() });
    // The input is not changed: verify() sends it as it is.
    assert.deepEqual(checked.compiler.input.settings["libraries"], {});
    assert.deepEqual(validateInput(solcInput({})).libraries, {});
  });

  it("rejects a library key with an absolute or home path, without echoing it (R-IN-4, R-IN-7 rule)", () => {
    const keys = [
      "/home/alice/project/src/Tally.sol:Tally",
      "~/project/src/Tally.sol:Tally",
      "~alice/src/Tally.sol:Tally",
      "C:\\Users\\alice\\Tally.sol:Tally",
      "file:///home/alice/Tally.sol:Tally",
      "../alice/Tally.sol:Tally",
      "src/../../alice/Tally.sol:Tally",
    ];
    const libraries = Object.fromEntries(keys.map((key) => [key, TALLY]));
    const error = thrown(() => validateInput(unlinkedSolcInput({}, libraries)));
    assert.ok(error.details.code === "invalid-input");
    assert.deepEqual(
      error.details.issues.map(({ field }) => field),
      keys.map((_key, index) => `libraries.${String(index + 1)}`),
    );
    for (const issue of error.details.issues) {
      assert.equal(issue.message, "must not be keyed by a local path");
    }
    const shown = JSON.stringify([error.message, error.details, error.hint, error.toJSON()]);
    assert.equal(shown.includes("alice"), false, shown);
  });

  it("names each bad entry by position, never by key (R-IN-4)", () => {
    const secretPath = "src/private-name/Tally.sol";
    const libraries = {
      "src/Tally.sol:Tally": TALLY,
      Tally: TALLY,
      "src/Tally.sol:9bad": TALLY,
      ":Tally": TALLY,
      [`${secretPath}:Tally`]: TALLY,
      "src/Counter.sol:Tally": "0x1234",
      "src/Counter.sol:Other": 42,
      "src/bad\u0007.sol:Tally": TALLY,
      "src/bidi\u202e.sol:Tally": TALLY,
      [`${"a".repeat(1025)}:Tally`]: TALLY,
    };
    const error = thrown(() => validateInput(unlinkedSolcInput({}, libraries)));
    assert.ok(error.details.code === "invalid-input");
    // A bad key, a path with control characters or over 1024 characters, and a path that is not a
    // source share one message.
    const key = "must be keyed by path:Name of compiler.input.sources";
    assert.deepEqual(error.details.issues, [
      { field: "libraries.2", message: key },
      { field: "libraries.3", message: key },
      { field: "libraries.4", message: key },
      { field: "libraries.5", message: key },
      { field: "libraries.6", message: "must be 0x followed by 40 hex digits" },
      { field: "libraries.7", message: "must be 0x followed by 40 hex digits" },
      { field: "libraries.8", message: key },
      { field: "libraries.9", message: key },
      { field: "libraries.10", message: key },
    ]);
    assert.equal(JSON.stringify(error.toJSON()).includes("private-name"), false);
    assert.equal(error.message.includes("private-name"), false);
  });

  it("rejects libraries that are not an object of addresses (R-IN-4)", () => {
    for (const value of [null, "src/Tally.sol:Tally", [TALLY], 1]) {
      assert.deepEqual(
        issuesOf(() => validateInput({ ...solcInput(), libraries: value })),
        [{ field: "libraries", message: "must be an object" }],
      );
    }
  });

  it("rejects in linkLibraries a settings.libraries that cannot hold the addresses (R-IN-4)", () => {
    const links = { "src/Tally.sol:Tally": TALLY, "src/Counter.sol:Other": TALLY };
    assert.deepEqual(
      issuesOf(() => linkLibraries(unlinkedSolcInput("none", links))),
      [{ field: "compiler.input.settings.libraries", message: "must be an object" }],
    );
    assert.deepEqual(
      issuesOf(() =>
        linkLibraries(unlinkedSolcInput({ "src/Counter.sol": [TALLY], "src/Tally.sol": 1 }, links)),
      ),
      [
        { field: "libraries.1", message: "conflicts with compiler.input.settings.libraries" },
        { field: "libraries.2", message: "conflicts with compiler.input.settings.libraries" },
      ],
    );
    // validateInput passes such settings on unchanged: they are the compiler's concern, and
    // verify() does not merge.
    const checked = validateInput(unlinkedSolcInput("none", links));
    assert.equal(checked.compiler.input.settings["libraries"], "none");
    assert.equal(
      validateInput(unlinkedSolcInput("none")).compiler.input.settings["libraries"],
      "none",
    );
  });

  it("checks libraries against the sources only when the sources were read (R-IN-4)", () => {
    const input = { ...solcInput({ "src/Tally.sol:Tally": TALLY }), compiler: "not an object" };
    assert.deepEqual(
      issuesOf(() => validateInput(input)),
      [{ field: "compiler", message: "must be an object with kind, version and input" }],
    );
  });
});

// Live probe E, Arbitrum Sepolia, 2026-11-03: two contracts compiled by forge without libraries and
// linked to ProbeELib afterwards. E1 was submitted with the address in settings.libraries, E2 without.
const SOURCIFY = "../fixtures/sourcify/2026-11-03-";
const PROBE_E_LIBRARY = "src/ProbeELib.sol:ProbeELib";
const PROBE_E_ADDRESS = "0xd0B737fC4e4195144824eB07b2d1bb778525b86B";

interface Recorded {
  readonly url: string;
  readonly body: unknown;
  readonly response: Response;
}

function recorded(name: string): Recorded {
  const fixture = record(readJson(`${SOURCIFY}${name}.json`));
  const request = record(fixture["request"]);
  const response = record(fixture["response"]);
  const status = response["status"];
  assert.ok(typeof status === "number");
  const headers = new Headers();
  for (const [header, value] of Object.entries(record(response["headers"]))) {
    headers.set(header, String(value));
  }
  // A GET records no body.
  const body = request["body"] == null ? undefined : record(request["body"])["json"];
  return {
    url: String(request["url"]),
    body,
    response: new Response(JSON.stringify(response["body"]), { status, headers }),
  };
}

/** The VerifyInput a recorded submit body was built from, with `libraries` added. */
function probeInput(submit: Recorded, settingsLibraries: unknown): VerifyInput {
  const body = record(submit.body);
  const standard = record(body["stdJsonInput"]);
  const settings = record(standard["settings"]);
  const address = /\/verify\/421614\/(0x[0-9a-fA-F]{40})$/.exec(submit.url)?.[1];
  assert.ok(address !== undefined);
  return validateInput({
    chainId: 421614,
    address,
    compiler: {
      kind: "solc",
      version: body["compilerVersion"],
      input: { ...standard, settings: { ...settings, libraries: settingsLibraries } },
    },
    contractName: body["contractIdentifier"],
    libraries: { [PROBE_E_LIBRARY]: PROBE_E_ADDRESS },
  });
}

/** Runs verify() against `steps` on mock timers, and returns the result and each request body. */
async function replayVerify(
  t: TestContext,
  input: VerifyInput,
  steps: readonly Response[],
): Promise<{ result: VerifyResult; bodies: unknown[] }> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const bodies: unknown[] = [];
  const fake = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body;
    bodies.push(typeof body === "string" ? JSON.parse(body) : undefined);
    const step = steps[bodies.length - 1];
    if (step === undefined) {
      throw new Error(`unexpected request ${String(bodies.length)}`);
    }
    return step.clone();
  };
  const state: { result?: VerifyResult; error?: unknown } = {};
  const promise = (async (): Promise<void> => {
    try {
      state.result = await verify(input, { fetch: fake });
    } catch (error) {
      state.error = error;
    }
  })();
  for (
    let round = 0;
    round < 3_000 && state.result === undefined && state.error === undefined;
    round++
  ) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    t.mock.timers.runAll();
  }
  await promise;
  assert.equal(state.error, undefined);
  assert.ok(state.result !== undefined, "verify() did not settle");
  return { result: state.result, bodies };
}

/** A "not verified" lookup answer, in the shape Sourcify sends before a contract is verified. */
function notVerified(address: string): Response {
  return new Response(
    JSON.stringify({
      match: null,
      creationMatch: null,
      runtimeMatch: null,
      chainId: "421614",
      address,
    }),
    { status: 404, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

describe("verify() with libraries, replaying live probe E (R-IN-4)", () => {
  it("sends the input unchanged and returns the recorded exact match (R-IN-4)", async (t) => {
    const submit = recorded("verify-linked-without-libraries-submit");
    const input = probeInput(submit, {});
    const { result, bodies } = await replayVerify(t, input, [
      notVerified(input.address),
      submit.response,
      recorded("verify-job-linked-without-libraries-exact-match").response,
    ]);
    assert.equal(result.status, "verified");
    assert.ok(result.status === "verified");
    assert.equal(result.match, "exact");
    // The submit body is the recorded E2 body: settings.libraries stays empty.
    assert.deepEqual(bodies[1], submit.body);
  });

  it("sends the linked input from linkLibraries and returns the recorded partial match (R-IN-4)", async (t) => {
    const submit = recorded("verify-linked-with-libraries-submit");
    const input = linkLibraries(probeInput(submit, {}));
    const { result, bodies } = await replayVerify(t, input, [
      notVerified(input.address),
      submit.response,
      recorded("verify-job-linked-with-libraries-match").response,
    ]);
    assert.ok(result.status === "verified");
    assert.equal(result.match, "partial");
    // The submit body is the recorded E1 body, with the address in lower case.
    const sent = record(bodies[1]);
    const expected = record(submit.body);
    const expectedInput = record(expected["stdJsonInput"]);
    assert.deepEqual(sent, {
      ...expected,
      stdJsonInput: {
        ...expectedInput,
        settings: {
          ...record(expectedInput["settings"]),
          libraries: { "src/ProbeELib.sol": { ProbeELib: PROBE_E_ADDRESS.toLowerCase() } },
        },
      },
    });
  });
});
