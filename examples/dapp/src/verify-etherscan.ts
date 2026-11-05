import { verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

/** Sends each Etherscan request to the dapp's server, and any other request as it is. */
export const viaHandler: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.etherscan.io") {
    return await fetch(input, init);
  }
  return await fetch(`/api/verify${url.search}`, init);
};

/** Verifies on Etherscan through the dapp's server, which adds the key. */
export async function verifyOnEtherscan(input: VerifyInput): Promise<VerifyResult> {
  return await verify(input, {
    route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" },
    fetch: viaHandler,
  });
}
