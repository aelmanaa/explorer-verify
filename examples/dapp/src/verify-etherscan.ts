import { verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

/** Verifies on Etherscan through the dapp's server at /api/verify, which adds the key. */
export async function verifyOnEtherscan(input: VerifyInput): Promise<VerifyResult> {
  return await verify(input, { handlerUrl: "/api/verify" });
}
