import { mkdir, readFile, writeFile } from "node:fs/promises";

import { verifyInputFromFoundry } from "@explorer-verify/foundry";

// The ABI and the creation bytecode, from Foundry's artifact.
const artifact: unknown = JSON.parse(await readFile("out/Greeter.sol/Greeter.json", "utf8"));
if (
  typeof artifact !== "object" ||
  artifact === null ||
  !("abi" in artifact) ||
  !("bytecode" in artifact) ||
  typeof artifact.bytecode !== "object" ||
  artifact.bytecode === null ||
  !("object" in artifact.bytecode)
) {
  throw new Error("out/Greeter.sol/Greeter.json holds no ABI and bytecode.");
}
// The compiler version, the contract name and the Standard JSON input, from the build-info.
const built = await verifyInputFromFoundry({ root: ".", contract: "src/Greeter.sol:Greeter" });

await mkdir("public/contracts", { recursive: true });
await writeFile(
  "public/contracts/Greeter.deploy.json",
  JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode.object }),
);
await writeFile("public/contracts/Greeter.verify.json", JSON.stringify(built));
process.stdout.write(`${built.contractName} ${built.compiler.version}\n`);
