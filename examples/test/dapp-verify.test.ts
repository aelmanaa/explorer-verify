// The dapp example's verification modules (steps 3, 4, 5 and 7 of the tutorial), run against
// recorded Sourcify and Etherscan answers for the Sepolia Greeter: the input loads from the
// page's own files, Sourcify verifies with no key and the handle is kept for a reload, the resume
// step polls without submitting, and Etherscan is reached only through the dapp's server, which
// adds the key (R-FLOW-5, R-SEC-1).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { ExplorerVerifyError, validateInput } from "explorer-verify";
import type { VerifyInput } from "explorer-verify";

import { createDappServer, dappRoutes } from "../dapp/server.ts";
import { loadVerifyInput } from "../dapp/src/load-input.ts";
import { resumeVerification } from "../dapp/src/resume.ts";
import { verifyOnEtherscan, viaHandler } from "../dapp/src/verify-etherscan.ts";
import { PENDING_KEY, verifyOnSourcify } from "../dapp/src/verify.ts";
import {
  ADDRESS,
  browserNetwork,
  MemoryStorage,
  RECORDED_HANDLE,
  setGlobal,
  settle,
  TX_HASH,
} from "./dapp-browser.ts";
import type { SourcifyAnswer } from "./dapp-browser.ts";
import { answer, ETHERSCAN_API_URL, KEY, recorded } from "./network.ts";

const DEPLOYMENT = { chainId: 11155111, address: ADDRESS, creationTxHash: TX_HASH };
/** Node's own fetch, taken before any test replaces the global. */
const NODE_FETCH = globalThis.fetch;
const VERIFY_FILE = new URL("../dapp/public/contracts/Greeter.verify.json", import.meta.url);
const JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const EXPLORER_URL = `https://repo.sourcify.dev/11155111/${ADDRESS.toLowerCase()}`;

function urlOf(target: RequestInfo | URL): string {
  return target instanceof Request ? target.url : target.toString();
}

/** The browser: storage, and a network with these Sourcify answers and these Etherscan answers. */
function page(
  t: TestContext,
  sourcify: readonly (string | SourcifyAnswer)[] = [],
  etherscan: readonly Response[] = [],
): { storage: MemoryStorage; upstream: string[]; network: ReturnType<typeof browserNetwork> } {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const storage = new MemoryStorage();
  setGlobal(t, "localStorage", storage);
  const upstream: string[] = [];
  const routes = dappRoutes({
    apiKey: KEY,
    fetch: async (target, init) => {
      upstream.push(`${urlOf(target)} ${await new Response(init?.body).text()}`);
      const next = etherscan[upstream.length - 1];
      if (next === undefined) {
        throw new Error("unexpected Etherscan request");
      }
      return next.clone();
    },
  });
  const network = browserNetwork(routes, sourcify);
  setGlobal(t, "fetch", network.fetch);
  return { storage, upstream, network };
}

async function input(t: TestContext): Promise<VerifyInput> {
  return await settle(t, loadVerifyInput(DEPLOYMENT));
}

describe("examples/dapp/src/load-input.ts", () => {
  it("loads the verify file from the page and checks it", async (t) => {
    page(t);
    const loaded = await input(t);
    assert.equal(loaded.contractName, "src/Greeter.sol:Greeter");
    assert.equal(loaded.compiler.version, "0.8.24+commit.e11b9ed9");
    assert.equal(loaded.address, ADDRESS.toLowerCase());
    assert.equal(loaded.creationTxHash, TX_HASH);
  });

  it("throws when the verify file cannot be loaded", async (t) => {
    page(t);
    setGlobal(t, "fetch", async () => new Response("Not found", { status: 404 }));
    await assert.rejects(input(t), {
      message: "Could not load the verification input: HTTP 404",
    });
  });

  it("throws when the verify file is not a JSON object", async (t) => {
    page(t);
    setGlobal(t, "fetch", async () => Response.json(null));
    await assert.rejects(input(t), { message: "The verification input is not a JSON object." });
  });

  it("throws invalid-input for a bad field, before anything is sent", async (t) => {
    page(t);
    await assert.rejects(
      settle(t, loadVerifyInput({ ...DEPLOYMENT, address: "0x12" })),
      (error) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.equal(error.details.code, "invalid-input");
        return true;
      },
    );
  });
});

describe("examples/dapp/src/verify.ts", () => {
  it("R-FLOW-5: verifies on Sourcify, keeps the handle until the result, and shows both", async (t) => {
    const { storage, network } = page(t, [
      "2026-11-02-lookup-not-verified",
      "2026-11-02-submit-accepted",
      "2026-11-02-job-exact-match",
    ]);
    const loaded = await input(t);
    const lines: string[] = [];
    let storedAtResult: string | null = null;

    await settle(
      t,
      verifyOnSourcify(loaded, (line) => {
        storedAtResult ??= storage.getItem(PENDING_KEY);
        lines.push(line);
      }),
    );

    assert.deepEqual(lines, [
      `Submitted. Handle: ${RECORDED_HANDLE}`,
      `verified (exact) ${EXPLORER_URL}`,
    ]);
    assert.equal(storedAtResult, RECORDED_HANDLE);
    assert.equal(storage.getItem(PENDING_KEY), null);
    assert.equal(network.sourcify.length, 3);
  });

  it("shows already-verified when Sourcify has the contract, and submits nothing", async (t) => {
    const { network } = page(t, ["2026-11-02-lookup-exact-match"]);
    const loaded = await input(t);
    const lines: string[] = [];
    await settle(
      t,
      verifyOnSourcify(loaded, (line) => lines.push(line)),
    );
    assert.deepEqual(lines, [`already-verified (exact) ${EXPLORER_URL}`]);
    assert.equal(network.sourcify.length, 1);
  });

  it("shows the reason when Sourcify rejects the source", async (t) => {
    // The no_match answer of 2026-11-02-job-no-match, for the job and contract of these answers.
    const noMatch: SourcifyAnswer = {
      method: "GET",
      url: `https://sourcify.dev/server/v2/verify/${JOB}`,
      status: 200,
      body: {
        isJobCompleted: true,
        verificationId: JOB,
        contract: { match: null, chainId: "11155111", address: ADDRESS },
        error: {
          customCode: "no_match",
          message: "The deployed and recompiled bytecode don't match.",
        },
      },
    };
    const { storage } = page(t, [
      "2026-11-02-lookup-not-verified",
      "2026-11-02-submit-accepted",
      noMatch,
    ]);
    const loaded = await input(t);
    const lines: string[] = [];
    await settle(
      t,
      verifyOnSourcify(loaded, (line) => lines.push(line)),
    );
    assert.deepEqual(lines, [
      `Submitted. Handle: ${RECORDED_HANDLE}`,
      "Sourcify rejected the source: no_match: The deployed and recompiled bytecode don't match.",
    ]);
    assert.equal(storage.getItem(PENDING_KEY), null);
  });

  it("keeps the handle when Sourcify has not finished in time (not-confirmed)", async (t) => {
    const { storage } = page(t, [
      "2026-11-02-lookup-not-verified",
      "2026-11-02-submit-accepted",
      "2026-11-02-job-pending*",
      "2026-11-02-lookup-not-verified",
    ]);
    const loaded = await input(t);
    const lines: string[] = [];
    await settle(
      t,
      verifyOnSourcify(loaded, (line) => lines.push(line)),
    );
    assert.equal(
      lines.at(-1),
      "Sourcify is still checking. Reload the page later to see the result.",
    );
    assert.equal(storage.getItem(PENDING_KEY), RECORDED_HANDLE);
  });

  it("shows the code and hint of any other error, and forgets the handle", async (t) => {
    const { storage } = page(t, ["2026-11-02-lookup-unsupported-chain"]);
    storage.setItem(PENDING_KEY, "stale");
    const loaded = await input(t);
    const lines: string[] = [];
    await settle(
      t,
      verifyOnSourcify(loaded, (line) => lines.push(line)),
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /^[a-z-]+: \S/);
    assert.equal(storage.getItem(PENDING_KEY), null);
  });

  it("throws an error that is not explorer-verify's, and forgets the handle", async (t) => {
    const { storage } = page(t, ["2026-11-02-lookup-exact-match"]);
    storage.setItem(PENDING_KEY, "stale");
    const loaded = await input(t);
    const broken = new Error("the page is gone");
    await assert.rejects(
      settle(
        t,
        verifyOnSourcify(loaded, () => {
          throw broken;
        }),
      ),
      broken,
    );
    assert.equal(storage.getItem(PENDING_KEY), null);
  });
});

describe("examples/dapp/src/resume.ts", () => {
  it("does nothing when no handle is saved", async (t) => {
    const { network } = page(t);
    const lines: string[] = [];
    await resumeVerification((line) => lines.push(line));
    assert.deepEqual(lines, []);
    assert.deepEqual(network.sourcify, []);
  });

  it("R-FLOW-5: polls the saved job after a reload, without submitting", async (t) => {
    const { storage, network } = page(t, ["2026-11-02-job-exact-match"]);
    storage.setItem(PENDING_KEY, RECORDED_HANDLE);
    const lines: string[] = [];
    await settle(
      t,
      resumeVerification((line) => lines.push(line)),
    );
    assert.deepEqual(lines, [`Resuming ${RECORDED_HANDLE}`, "verified"]);
    assert.equal(storage.getItem(PENDING_KEY), null);
    assert.ok(network.sourcify.every((request) => request.startsWith("GET ")));
  });

  it("keeps the handle when the job is still running", async (t) => {
    const { storage } = page(t, ["2026-11-02-job-pending*", "2026-11-02-lookup-not-verified"]);
    storage.setItem(PENDING_KEY, RECORDED_HANDLE);
    const lines: string[] = [];
    await settle(
      t,
      resumeVerification((line) => lines.push(line)),
    );
    assert.equal(lines.at(-1), "Still checking. The handle stays saved for the next load.");
    assert.equal(storage.getItem(PENDING_KEY), RECORDED_HANDLE);
  });

  it("forgets a handle that cannot be resumed, and throws", async (t) => {
    const { storage } = page(t);
    storage.setItem(PENDING_KEY, "not a handle");
    await assert.rejects(
      settle(
        t,
        resumeVerification(() => undefined),
      ),
      (error) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.equal(error.details.code, "invalid-input");
        return true;
      },
    );
    assert.equal(storage.getItem(PENDING_KEY), null);
  });
});

describe("examples/dapp/src/verify-etherscan.ts", () => {
  it("R-SEC-1: verifies through the dapp's server, which adds the key", async (t) => {
    const getsourcecode = recorded("2026-11-04-getsourcecode-sepolia-greeter");
    const { upstream, network } = page(t, [], [answer(getsourcecode.body)]);
    const loaded = await input(t);

    const result = await settle(t, verifyOnEtherscan(loaded));

    assert.equal(result.status, "already-verified");
    assert.equal(result.backend, "etherscan-v2");
    assert.equal(upstream.length, 1);
    const [sent = ""] = upstream;
    assert.ok(sent.startsWith(`${ETHERSCAN_API_URL}?chainid=11155111 `));
    assert.ok(sent.includes(new URLSearchParams({ apikey: KEY }).toString()));
    assert.deepEqual(network.sourcify, []);
  });

  it(
    // A real fetch gives the handler's answer the dapp's URL; verify() reads it since #183.
    "verifies through the dapp's server over HTTP, as a browser does (#183)",
    async (t) => {
      const getsourcecode = recorded("2026-11-04-getsourcecode-sepolia-greeter");
      const server = createDappServer({
        apiKey: KEY,
        fetch: async () => answer(getsourcecode.body),
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => server.close());
      const address = server.address();
      const origin =
        typeof address === "object" && address !== null
          ? `http://127.0.0.1:${String(address.port)}`
          : "";
      setGlobal(t, "fetch", async (target: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(target);
        return await NODE_FETCH(url.startsWith("/") ? `${origin}${url}` : url, init);
      });
      const loaded = validateInput({
        ...Object(JSON.parse(readFileSync(VERIFY_FILE, "utf8"))),
        ...DEPLOYMENT,
      });
      // Real timers: the requests go over loopback, and a mock clock would race them.
      const result = await verifyOnEtherscan(loaded);
      assert.equal(result.status, "already-verified");
    },
  );

  it("sends a Request for Etherscan to the server, and any other request as it is", async (t) => {
    const seen: string[] = [];
    setGlobal(t, "fetch", async (target: RequestInfo | URL) => {
      seen.push(urlOf(target));
      return new Response("ok");
    });
    await viaHandler(new Request(`${ETHERSCAN_API_URL}?chainid=11155111`));
    await viaHandler("https://sourcify.dev/server/v2/contract/11155111/0x00");
    assert.deepEqual(seen, [
      "/api/verify?chainid=11155111",
      "https://sourcify.dev/server/v2/contract/11155111/0x00",
    ]);
  });
});
