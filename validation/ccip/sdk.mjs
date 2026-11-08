import { readFile } from "node:fs/promises";

import { AbiCoder } from "ethers";
import {
  buildVerifyInput,
  verify,
  checkStatus,
  ExplorerVerifyError,
  formatHandle,
} from "explorer-verify";

export const names = ["CrossChainToken", "BurnMintTokenPool"];
const owner = "0x1111111111111111111111111111111111111111";
export const constructorValues = {
  CrossChainToken: [["Validation CCIP", "VCCIP", 1000000, 100, owner, 18, owner], owner, owner],
  BurnMintTokenPool: [owner, 18, "0x0000000000000000000000000000000000000000", owner, owner],
};
export async function artifact(name) {
  if (!names.includes(name)) throw new Error("Unknown CCIP artifact");
  const load = async (suffix) =>
    JSON.parse(await readFile(new URL(`./artifacts/${name}.${suffix}`, import.meta.url), "utf8"));
  const standardJson = await load("standard-input.json");
  const abi = await load("abi.json");
  const constructor = abi.find((item) => item.type === "constructor");
  const types = constructor.inputs.map((item) =>
    item.type === "tuple"
      ? `tuple(${item.components.map((component) => component.type).join(",")})`
      : item.type,
  );
  const constructorArgs = AbiCoder.defaultAbiCoder().encode(types, constructorValues[name]);
  const bytecodeModule = await readFile(
    new URL(`./artifacts/${name}.bytecode.ts`, import.meta.url),
    "utf8",
  );
  const creationBytecode = bytecodeModule.match(/'(?<code>0x[0-9a-f]+)'/u)?.groups?.code;
  if (!creationBytecode) throw new Error("Missing exact upstream bytecode");
  const folder = name === "CrossChainToken" ? "tokens" : "pools";
  const built = buildVerifyInput([standardJson], {
    contract: `contracts/${folder}/${name}.sol:${name}`,
    compilerVersion: "0.8.26+commit.8a97fa7a",
  });
  return { ...built, constructorArgs, creationBytecode };
}

/** Shared SDK operation used by the consumer CLI and direct callers. Continues after each failure. */
export async function verifyCcipBatch(deployments, options) {
  const results = [];
  for (const deployment of deployments) {
    try {
      const input = await artifact(deployment.name);
      const result = await verify(
        { ...input, chainId: deployment.chainId, address: deployment.address },
        options,
      );
      results.push({ name: deployment.name, ...result });
    } catch (error) {
      if (!(error instanceof ExplorerVerifyError)) throw error;
      results.push({
        name: deployment.name,
        status: error.code === "not-confirmed" ? "pending" : "error",
        code: error.code,
        ...(error.code === "not-confirmed" ? { handle: formatHandle(error.details.handle) } : {}),
      });
    }
  }
  return results;
}
export async function resumeCcip(handle, options) {
  return await checkStatus(handle, options);
}
