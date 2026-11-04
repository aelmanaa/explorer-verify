/**
 * Preloaded with `node --import` into each run of a user-docs example (see `user-docs.ts`), after
 * the fake `fetch` of `skill-fetch.ts`.
 *
 * It defines the names an example may use without defining them (`DOC_GLOBALS` in
 * `user-docs.ts`):
 *
 * - `input`: a valid `VerifyInput` for the Greeter at the address the Sourcify fixtures recorded,
 *   built from the core's Foundry build fixture with the build of this package;
 * - `apiKey`, `etherscanKey` and `explorerKey`: dummy keys;
 * - `deployerAddress`: an address no one deploys from;
 * - `built`: the `buildVerifyInput` result for `src/Counter.sol:Counter`, which links the library
 *   `src/Tally.sol:Tally`, from the core's `solc-0.8.24-library` fixture;
 * - `request`: a status poll, as a browser sends it to the server handler, for the Etherscan job
 *   that `etherscan/2026-11-03-checkverifystatus-form-post-key-in-body` recorded;
 * - `localStorage`: an in-memory store, so browser examples run on every Node version.
 */
import { readFileSync } from "node:fs";

import { buildVerifyInput, validateInput } from "explorer-verify";

const fixture = (file: string): string =>
  readFileSync(new URL(`../fixtures/build-formats/${file}`, import.meta.url), "utf8");

const built = buildVerifyInput([JSON.parse(fixture("foundry-1.8.1/Greeter.json"))], {
  sources: {
    "src/Base.sol": fixture("sources/Base.sol"),
    "src/Greeter.sol": fixture("sources/Greeter.sol"),
  },
});

/** The `Storage` methods the examples call, kept in memory for one run. */
class MemoryStorage {
  readonly #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  clear(): void {
    this.#items.clear();
  }
}

const globals: Readonly<Record<string, unknown>> = {
  input: validateInput({
    chainId: 11155111,
    address: "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC",
    ...built,
  }),
  apiKey: "dummy-api-key-for-docs",
  etherscanKey: "dummy-etherscan-key-for-docs",
  explorerKey: "dummy-explorer-key-for-docs",
  deployerAddress: "0x1111111111111111111111111111111111111111",
  built: buildVerifyInput([JSON.parse(fixture("solc-0.8.24-library/input.json"))], {
    contract: "src/Counter.sol:Counter",
    compilerVersion: "0.8.24+commit.e11b9ed9",
  }),
  request: new Request("https://dapp.example/api/verify?chainid=421614", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      module: "contract",
      action: "checkverifystatus",
      guid: "ctzxlls4kl2yziafqgangtjk3hgdbd3xhnzbg5d3tgla9wgsb3",
    }),
  }),
  localStorage: new MemoryStorage(),
};

for (const [name, value] of Object.entries(globals)) {
  // Node 25 and later define `localStorage` themselves; replace it so no run reads a file.
  Reflect.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
