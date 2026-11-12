// The browser side of the Cloudflare example: verify() in the dapp, with
// handlerUrl, which sends each Etherscan request to the Worker on its own
// origin. The browser holds no key. Guide:
// docs/user/guides/run-the-server-handler.md
import { verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

/** Where the Worker runs. Replace it with your Worker's URL. */
export const WORKER_URL = "https://verify.your-dapp.example/api/verify";

/**
 * Verifies a contract on Etherscan from the browser, through the Worker, which
 * adds the key.
 * @param input The contract and its compiler input.
 * @returns The verification result.
 */
export async function verifyFromBrowser(
  input: VerifyInput,
): Promise<VerifyResult> {
  return await verify(input, { handlerUrl: WORKER_URL });
}
