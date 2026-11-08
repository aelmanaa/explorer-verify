import { buildVerifyInputFromHardhat } from "@explorer-verify/hardhat";
import {
  checkStatus,
  formatHandle,
  tryParseHandle,
  ExplorerVerifyError,
  validateInput,
  verify,
} from "explorer-verify";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

interface Arguments {
  apiUrl: string;
  address: string;
  contract: string;
  resume: string;
}

export default async function action(args: Arguments, hre: HardhatRuntimeEnvironment) {
  const options = {
    route: { backend: "sourcify", apiUrl: args.apiUrl },
    timeoutMs: 2500,
    pollIntervalMs: 1000,
  } satisfies NonNullable<Parameters<typeof verify>[1]>;
  try {
    const result =
      args.resume === ""
        ? await verify(
            validateInput({
              ...(await buildVerifyInputFromHardhat({
                root: hre.config.paths.root,
                outDir: hre.config.paths.artifacts,
                contract: args.contract,
              })),
              chainId: 31337,
              address: args.address,
              constructorArgs: "0x" + "0".repeat(63) + "7",
            }),
            options,
          )
        : await checkStatus(args.resume, options);
    console.log(JSON.stringify({ schemaVersion: 1, result }));
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof ExplorerVerifyError)) throw error;
    const handle = tryParseHandle("handle" in error.details ? error.details.handle : undefined);
    console.log(
      JSON.stringify({
        ...(handle === undefined ? {} : { resumeHandle: formatHandle(handle) }),
        schemaVersion: 1,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      }),
    );
    process.exitCode = 1;
  }
}
