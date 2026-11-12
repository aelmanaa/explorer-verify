import { readFile } from "node:fs/promises";

import {
  buildVerifyInput,
  verify,
  checkStatus,
  ExplorerVerifyError,
  formatHandle,
} from "explorer-verify";

/**
 * What the caller adds to a deploy result: the build behind each contract, keyed by
 * `<contract>@<pool version>`. The deploy result names the contract and holds the constructor
 * arguments; it holds neither the Standard JSON nor the compiler version. `contract`, as
 * `path:Name`, is optional: it settles a name that several sources define.
 */
export const localBuilds = {
  "CrossChainToken@2.0.0": {
    standardJson: () => loadJson("CrossChainToken.standard-input.json"),
    compilerVersion: "0.8.26+commit.8a97fa7a",
  },
  "BurnMintTokenPool@2.0.0": {
    standardJson: () => loadJson("BurnMintTokenPool.standard-input.json"),
    compilerVersion: "0.8.26+commit.8a97fa7a",
  },
};
async function loadJson(file) {
  return JSON.parse(await readFile(new URL(`./artifacts/${file}`, import.meta.url), "utf8"));
}

/**
 * Maps the unqualified name of a deploy result to the `path:Name` that `buildVerifyInput` needs,
 * by finding the source files of the Standard JSON that declare `contract Name`. Comments are
 * removed first. No file, or more than one, throws with the candidates; the caller then sets
 * `contract` in the build.
 */
export function qualifiedName(standardJson, name) {
  if (!/^[A-Za-z_$][\w$]*$/u.test(name)) throw new Error(`Not a contract name: ${name}`);
  const declaration = new RegExp(`(?:^|[\\s;{}])(?:abstract\\s+)?contract\\s+${name}\\b`, "u");
  const files = Object.entries(standardJson.sources ?? {})
    .filter(([, source]) =>
      declaration.test(
        String(source.content ?? "").replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, " "),
      ),
    )
    .map(([path]) => `${path}:${name}`)
    .toSorted();
  if (files.length === 1) return files[0];
  throw new Error(
    files.length === 0
      ? `No source declares contract ${name}`
      : `Several sources declare contract ${name}; set contract to one of: ${files.join(", ")}`,
  );
}

/** Builds the `verify()` input from one deploy result, its chain id and its pool version. */
export async function inputFromDeployResult(
  { chainId, version = "2.0.0", deploy },
  builds = localBuilds,
) {
  const { contract, encodedConstructorArgs } = deploy.verification;
  const build = builds[`${contract}@${version}`];
  if (!build) throw new Error(`No build for ${contract}@${version}`);
  const standardJson =
    typeof build.standardJson === "function" ? await build.standardJson() : build.standardJson;
  const built = buildVerifyInput([standardJson], {
    contract: build.contract ?? qualifiedName(standardJson, contract),
    compilerVersion: build.compilerVersion,
  });
  return {
    ...built,
    chainId,
    address: deploy.contractAddress,
    ...(encodedConstructorArgs === "0x" ? {} : { constructorArgs: encodedConstructorArgs }),
  };
}

/**
 * Verifies each deploy result in turn and returns one result per deployment, after a rejection
 * or an error too. Right after a deploy, the explorer may not have indexed the contract:
 * `indexWaitMs` keeps sending the submit for up to two minutes. A result with `storedContract`
 * means the explorer holds another contract's source for the address. `submitOverPartial` and
 * every other `verify()` option pass through.
 */
export async function verifyDeployResults(deployments, options = {}, builds = localBuilds) {
  const results = [];
  for (const deployment of deployments) {
    const contract = deployment.deploy.verification.contract;
    const address = deployment.deploy.contractAddress;
    try {
      const input = await inputFromDeployResult(deployment, builds);
      const result = await verify(input, { indexWaitMs: 120_000, timeoutMs: 300_000, ...options });
      results.push({ contract, address, ...result });
    } catch (error) {
      if (!(error instanceof ExplorerVerifyError)) throw error;
      const pending = error.code === "not-confirmed";
      results.push({
        contract,
        address,
        status: pending ? "pending" : "error",
        code: error.code,
        ...(pending ? { handle: formatHandle(error.details.handle) } : {}),
      });
    }
  }
  return results;
}

export async function resumeCcip(handle, options) {
  return await checkStatus(handle, options);
}
