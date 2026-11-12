// The published packages declare only a Node floor that CI tests (decision 0071): the node-floor
// job of .github/workflows/ci.yml runs test/node-floor/smoke.mjs on NODE_FLOOR, and each published
// package's engines.node must name that same version.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLISHED = ["explorer-verify", "cli", "foundry", "hardhat"];

function read(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

function enginesNode(file: string): unknown {
  const manifest: unknown = JSON.parse(read(file));
  const engines: unknown = Reflect.get(Object(manifest), "engines");
  return Reflect.get(Object(engines), "node");
}

describe("the Node floor of the published packages (decision 0071)", () => {
  const ci = read(".github/workflows/ci.yml");
  const floor = /^ {6}NODE_FLOOR: "(\d+\.\d+\.\d+)"$/m.exec(ci)?.[1];

  it("the node-floor job names one exact version and runs the smoke test", () => {
    assert.ok(floor !== undefined, "ci.yml sets no NODE_FLOOR");
    assert.match(ci, /^ {2}node-floor:$/m);
    assert.match(ci, /node-version: \$\{\{ env\.NODE_FLOOR \}\}/);
    assert.match(ci, /node smoke\.mjs "\$GITHUB_WORKSPACE"/);
    assert.match(read("test/node-floor/smoke.mjs"), /^import /m);
  });

  for (const name of PUBLISHED) {
    it(`packages/${name} declares engines.node >=NODE_FLOOR`, () => {
      assert.equal(enginesNode(`packages/${name}/package.json`), `>=${String(floor)}`);
    });
  }

  it("the repository itself keeps the 22.18.0 floor of its TypeScript scripts", () => {
    assert.equal(enginesNode("package.json"), ">=22.18.0");
  });
});
