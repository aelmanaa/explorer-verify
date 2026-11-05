// The dapp example's entry module, src/main.ts, run on a fake page: a click deploys with the fake
// wallet, verifies on Sourcify and, when the box is ticked, on Etherscan through the dapp's server;
// a reload resumes a saved verification and a pending deployment (R-FLOW-5).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { dappRoutes } from "../dapp/server.ts";
import {
  ADDRESS,
  browserNetwork,
  drive,
  fakeWallet,
  MemoryStorage,
  RECORDED_HANDLE,
  setGlobal,
  settle,
  TX_HASH,
} from "./dapp-browser.ts";
import { answer, KEY, recorded } from "./network.ts";

/** The checkbox, as `instanceof HTMLInputElement` sees it. */
class FakeInput {
  checked = false;
}

/** What the page showed in `#status`, the click listeners of `#deploy`, and its storage. */
interface FakePage {
  readonly lines: string[];
  readonly clicks: (() => void)[];
  readonly storage: MemoryStorage;
}

/**
 * The page: whether it has its elements and the box ticked, Sourcify's answers, a `fetch` in
 * place of the network, and what `localStorage` holds from a previous load.
 */
interface PageOptions {
  readonly elements?: boolean;
  readonly etherscan?: boolean;
  readonly sourcify?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly storage?: Readonly<Record<string, string>>;
}

let loads = 0;

/** Sets up the page and loads src/main.ts on it, as a fresh page load. */
async function load(t: TestContext, options: PageOptions = {}): Promise<FakePage> {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const lines: string[] = [];
  const clicks: (() => void)[] = [];
  const box = new FakeInput();
  box.checked = options.etherscan === true;
  const elements = new Map<string, unknown>(
    options.elements === false
      ? []
      : [
          [
            "#status",
            { append: (child: { textContent: string }) => lines.push(child.textContent) },
          ],
          [
            "#deploy",
            { addEventListener: (_type: string, listener: () => void) => clicks.push(listener) },
          ],
          ["#etherscan", box],
        ],
  );
  // The module's first statement reads the page, so the first query marks the moment its code
  // starts: its imports are loaded and no more files are read.
  const page = { started: (): void => undefined };
  const started = new Promise<void>((resolve) => {
    page.started = resolve;
  });
  setGlobal(t, "HTMLInputElement", FakeInput);
  setGlobal(t, "document", {
    querySelector: (selector: string) => {
      page.started();
      return elements.get(selector) ?? null;
    },
    createElement: () => ({ textContent: "" }),
  });
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(options.storage ?? {})) {
    storage.setItem(key, value);
  }
  setGlobal(t, "localStorage", storage);
  setGlobal(t, "window", { ethereum: fakeWallet().provider });
  const getsourcecode = recorded("2026-11-04-getsourcecode-sepolia-greeter");
  const routes = dappRoutes({ apiKey: KEY, fetch: async () => answer(getsourcecode.body) });
  setGlobal(t, "fetch", options.fetch ?? browserNetwork(routes, options.sourcify).fetch);

  // A new URL loads the module again, as a page load does; its top-level code resumes.
  // The clock moves only once the module runs: reading its file is real I/O.
  loads += 1;
  const loaded = import(`../dapp/src/main.ts?load=${String(loads)}`);
  await Promise.race([started, loaded]);
  await settle(t, loaded);
  return { lines, clicks, storage };
}

/** Drives the mock clock until `done` returns true, as the page works after a click. */
async function until(t: TestContext, done: () => boolean): Promise<void> {
  assert.ok(await drive(t, done), "the page did not finish within the mock-time bound");
}

describe("examples/dapp/src/main.ts", () => {
  it("deploys and verifies on Sourcify, then on Etherscan when the box is ticked", async (t) => {
    const page = await load(t, {
      etherscan: true,
      sourcify: [
        "2026-11-02-lookup-not-verified",
        "2026-11-02-submit-accepted",
        "2026-11-02-job-exact-match",
      ],
    });
    assert.deepEqual(page.lines, []);
    assert.equal(page.clicks.length, 1);

    page.clicks[0]?.();
    await until(t, () => page.lines.at(-1)?.startsWith("Etherscan:") === true);

    assert.deepEqual(page.lines, [
      `Deployed at ${ADDRESS} in transaction ${TX_HASH}`,
      "Loaded src/Greeter.sol:Greeter, compiled with 0.8.24+commit.e11b9ed9",
      `Submitted. Handle: ${RECORDED_HANDLE}`,
      `verified (exact) https://repo.sourcify.dev/11155111/${ADDRESS.toLowerCase()}`,
      "Etherscan: already-verified",
    ]);
  });

  it("R-FLOW-5: on load, resumes the saved verification and the pending deployment", async (t) => {
    const page = await load(t, {
      storage: {
        "greeter-verification": RECORDED_HANDLE,
        "greeter-creation-tx": TX_HASH,
      },
      sourcify: ["2026-11-02-job-exact-match", "2026-11-02-lookup-exact-match"],
    });
    assert.deepEqual(page.lines, [
      `Resuming ${RECORDED_HANDLE}`,
      "verified",
      `Deployed at ${ADDRESS} in transaction ${TX_HASH}`,
      "Loaded src/Greeter.sol:Greeter, compiled with 0.8.24+commit.e11b9ed9",
      `already-verified (exact) https://repo.sourcify.dev/11155111/${ADDRESS.toLowerCase()}`,
    ]);
    assert.equal(page.storage.getItem("greeter-verification"), null);
    assert.equal(page.storage.getItem("greeter-creation-tx"), null);
  });

  it("shows an error the resume step throws on load", async (t) => {
    const page = await load(t, { storage: { "greeter-verification": "not a handle" } });
    assert.equal(page.lines.length, 2);
    assert.match(page.lines[1] ?? "", /handle/i);
  });

  it("shows a failed deployment, whatever was thrown", async (t) => {
    const page = await load(t, {
      // A rejection that is not an Error, as a broken polyfill may give.
      fetch: async () => await Promise.reject("offline"),
    });
    page.clicks[0]?.();
    await until(t, () => page.lines.length > 0);
    assert.deepEqual(page.lines, ["offline"]);
  });

  it("loads on a page without the elements", async (t) => {
    const page = await load(t, { elements: false, storage: { "greeter-verification": "bad" } });
    assert.deepEqual(page.lines, []);
    assert.deepEqual(page.clicks, []);
  });
});
