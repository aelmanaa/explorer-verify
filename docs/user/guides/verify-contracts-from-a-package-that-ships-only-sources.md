# Verify contracts from a package that ships only sources

Version: explorer-verify 0.3.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: authors of an SDK or a tool that deploys contracts from another team's npm package, when that
package ships Solidity sources, compiler settings and bytecode, but no build output.

You need: Node.js 22.18 or later, the contracts package in `node_modules`, and the `solc` npm
package at the version the contracts were built with. No API key is needed.

You do not control how the contracts package is built, so you cannot add build-info to it.
`buildVerifyInputFromSources` builds the Standard JSON input from the sources, the settings and the
remappings. You build it once, check it against the package's bytecode, and ship it with your SDK.

## Find out which case the package is in

Look at what the package ships next to its contracts:

| The package ships                                           | Guide                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Build-info, Standard JSON input, or artifacts with metadata | [Verify a contract shipped in an npm package](verify-a-contract-from-an-npm-package.md) |
| Sources, a compiler config such as `foundry.toml`, bytecode | This page                                                                               |
| Nothing yet: you write the contracts and the package        | [Verify contracts your package ships](verify-contracts-your-package-ships.md)           |

Bytecode that ends in a metadata hash also allows another route: the
[bytecode resolver](verify-from-deployed-bytecode.md), when the metadata is published. A build
with `bytecode_hash = "none"` has no hash, so only this page applies.

## Install

Install the core, and solc-js at the contracts' compiler version for the check. The scripts on
this page use `import` and top-level `await`, so set the project to ES modules:

```bash
npm pkg set type=module
npm install explorer-verify
npm install --save-dev solc@0.8.24
```

explorer-verify never compiles. solc-js runs only in your build script, to check the input once.

## Read the settings

The bytecode depends on every compiler setting, so take each one from the package's own config.
For a `foundry.toml`, the keys map to Standard JSON `settings` this way:

| `foundry.toml`          | `settings`                          |
| ----------------------- | ----------------------------------- |
| `optimizer`             | `optimizer.enabled`                 |
| `optimizer_runs`        | `optimizer.runs`                    |
| `via_ir`                | `viaIR`                             |
| `evm_version`           | `evmVersion`                        |
| `bytecode_hash`         | `metadata.bytecodeHash`             |
| `cbor_metadata = false` | `metadata.appendCBOR: false`        |
| `solc_version`          | The compiler version, not a setting |

Look in three more places before you trust the default profile:

- a profile the package's build script selects, such as `FOUNDRY_PROFILE=production`;
- per-contract overrides, such as a build script that compiles one contract with other optimizer
  runs;
- the remappings: `remappings.txt`, the `remappings` key, and the ones Foundry detects in `lib/`.
  `forge remappings` in the package lists all of them.

Pass the full compiler version, with its commit, such as `0.8.24+commit.e11b9ed9`. The
`solc --version` command and solc-js's `solc.version()` print it.

## Build the input

`buildVerifyInputFromSources` starts from the contract's file and follows its `import` directives.
It resolves each import as solc does: a path that starts with `./` or `../` against the importing
file's folder, then the longest matching remapping. Only the files the contract reaches go in the
input, each byte for byte.

Save this script as `build-input.ts` in your SDK's repository, replace `some-contracts` with the
name of the contracts package, and run `node build-input.ts`. It writes the input and a manifest:

```ts [build-input.ts]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { buildVerifyInputFromSources } from "explorer-verify/sources";

const require = createRequire(import.meta.url);
const pkg = path.dirname(require.resolve("some-contracts/package.json"));
const text = await readFile(path.join(pkg, "remappings.txt"), "utf8");

const built = await buildVerifyInputFromSources({
  contract: "src/Vault.sol:Vault",
  compilerVersion: "0.8.24+commit.e11b9ed9",
  // From foundry.toml.
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    metadata: { bytecodeHash: "none" },
  },
  // One remapping per line; trim handles CRLF line endings.
  remappings: text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== ""),
  // Returns undefined for a file the package lacks.
  sources: async (name) =>
    await readFile(path.join(pkg, name), "utf8").catch(() => undefined),
});

const standardJson = JSON.stringify(built.compiler.input);
const manifest = JSON.stringify({
  contract: built.contractName,
  compilerVersion: built.compiler.version,
});
await mkdir("verification", { recursive: true });
await writeFile("verification/Vault.input.json", standardJson);
await writeFile("verification/Vault.manifest.json", manifest);

console.log(Object.keys(built.compiler.input.sources).join("\n"));
const bytes = new TextEncoder().encode(standardJson).length;
console.log(`Vault.input.json: ${String(bytes)} bytes`);
```

On this project's test package, it prints:

```text
lib/acl/src/Context.sol
lib/acl/src/Ownable.sol
src/Events.sol
src/Vault.sol
src/VaultMath.sol
Vault.input.json: 2441 bytes
```

The package also holds `src/Unused.sol`. `Vault.sol` names it only in a comment, so it is not in
the input. The reader gets only names that stay inside the package, never an absolute path or
one that climbs above its root.

An import the sources lack throws
[`incomplete-input`](../reference/errors/incomplete-input.md) with `details.field` `sources` and
the missing names in `details.candidates`. Usually a remapping is missing.

Without this function, the steps are the same: read each file's `import` directives, skipping
comments and strings; resolve them as the
[Solidity docs](https://docs.soliditylang.org/en/v0.8.24/path-resolution.html) describe; and put
the reachable files, the settings and the remappings in one Standard JSON input.

## Check the input against the package's bytecode

The explorer compiles the input and compares the result with the deployed code. Do the same once,
before you ship. A wrong setting shows up here, not after a deploy. Save this script as
`check-bytecode.ts`, set `bytecode/Vault.json` to the file the package ships the bytecode in, and
run `node check-bytecode.ts`:

```ts [check-bytecode.ts]
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

interface Output {
  errors?: { severity: string; formattedMessage: string }[];
  contracts?: Record<
    string,
    Record<string, { evm: { bytecode: { object: string } } }>
  >;
}

const require = createRequire(import.meta.url);
// solc-js ships no types: declare the two functions this script calls.
const solc: {
  compile(input: string): string;
  version(): string;
} = require("solc");
const pkg = path.dirname(require.resolve("some-contracts/package.json"));

const input = await readFile("verification/Vault.input.json", "utf8");
const manifest: { contract: string; compilerVersion: string } = JSON.parse(
  await readFile("verification/Vault.manifest.json", "utf8"),
);
if (!solc.version().startsWith(manifest.compilerVersion)) {
  throw new Error(`Install solc ${manifest.compilerVersion}`);
}

const output: Output = JSON.parse(solc.compile(input));
for (const error of output.errors ?? []) {
  if (error.severity === "error") throw new Error(error.formattedMessage);
}
const [file = "", name = ""] = manifest.contract.split(":");
const compiled = output.contracts?.[file]?.[name]?.evm.bytecode.object;
const shipped: { bytecode: string } = JSON.parse(
  await readFile(path.join(pkg, "bytecode/Vault.json"), "utf8"),
);

if (`0x${compiled ?? ""}` === shipped.bytecode) {
  console.log(`${name}: the input compiles to the package's bytecode`);
} else {
  console.error(`${name}: the bytecode differs; check the settings`);
  process.exitCode = 1;
}
```

It prints:

```text
Vault: the input compiles to the package's bytecode
```

When the bytecode differs, it prints `Vault: the bytecode differs; check the settings` and exits 1.
Compare the settings again: the optimizer runs, `viaIR`, the EVM
version and the metadata settings are the usual causes. Two parts of a package's bytecode can
differ for other reasons:

- a contract that links an external library holds a placeholder that starts with `__$` where
  the address goes, until it is linked;
- the creation bytecode holds no constructor arguments; a deploy appends them.

## Ship the input and verify after a deploy

Ship the two files with your SDK and load them only when a verification runs.
[Verify contracts your package ships](verify-contracts-your-package-ships.md#ship-the-files) says
how, and its [Verify after a deployment](verify-contracts-your-package-ships.md#verify-after-a-deployment)
section gives the function that loads them and calls `verify()`.

The input holds only the files the contract imports, so it is often much smaller than a
build-info. Measure it: the build script above prints its size.

Build the files again whenever you update the contracts package, and run the check each time. A
test that runs the check in CI fails before a new package version breaks verification.

## The match to expect

A build with `bytecode_hash = "none"`, as in the example, has no metadata hash. Without it, no
explorer can show that the sources are the exact files compiled. A deployment of it verifies with
this `match`:

| Explorer     | `match`                                 |
| ------------ | --------------------------------------- |
| Etherscan v2 | `exact`                                 |
| Sourcify     | `partial`                               |
| Blockscout   | `partial`                               |
| Routescan    | `partial`, as for every Routescan match |

On Sourcify and Blockscout, `partial` is the best grade for such a build. It is a successful
verification, not a failure. A package built with the default metadata hash can reach `exact`
there too. [Match types](../explanation/match-types.md#builds-without-a-metadata-hash) gives the
explorers' answers.

## Next steps

- [Verify contracts your package ships](verify-contracts-your-package-ships.md): ship the files and
  verify after each deployment.
- [incomplete-input](../reference/errors/incomplete-input.md): the error for a missing file.
- [Match types](../explanation/match-types.md): exact and partial matches.
- [Using explorer-verify from an agent](using-from-an-agent.md): which calls submit.
