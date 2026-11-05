// The browser side of the Next.js example: verify() with handlerUrl, which sends each Etherscan
// request to the route in app/api/verify/route.ts. The browser holds no key.
// Guide: docs/user/guides/run-the-server-handler.md
import { verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

/**
 * Verifies a contract on Etherscan from the browser, through the route, which adds the key.
 * @param input The contract and its compiler input.
 * @returns The verification result.
 */
export async function verifyFromBrowser(input: VerifyInput): Promise<VerifyResult> {
  return await verify(input, { handlerUrl: "/api/verify" });
}
