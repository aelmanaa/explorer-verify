import { verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

/**
 * Verifies on Etherscan through the dapp's server at /api/verify, which adds the key. Etherscan
 * may need a minute to index a contract deployed moments ago: indexWaitMs waits for it.
 */
export async function verifyOnEtherscan(input: VerifyInput): Promise<VerifyResult> {
  return await verify(input, { handlerUrl: "/api/verify", indexWaitMs: 60_000 });
}
