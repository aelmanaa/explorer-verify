import type { VerifyInput } from "explorer-verify";

export interface Deployment {
  chainId: number;
  address: string;
  creationTxHash: string;
}

/**
 * Loads explorer-verify and the verify file, and returns the checked input for
 * a deployment.
 */
export async function loadVerifyInput(
  deployment: Deployment,
): Promise<VerifyInput> {
  const { validateInput } = await import("explorer-verify");
  const response = await fetch("/contracts/Greeter.verify.json");
  if (!response.ok) {
    throw new Error(
      `Could not load the verification input: HTTP ${String(response.status)}`,
    );
  }
  const built: unknown = await response.json();
  if (typeof built !== "object" || built === null) {
    throw new Error("The verification input is not a JSON object.");
  }
  // Throws invalid-input, naming each bad field, before anything is sent.
  return validateInput({ ...built, ...deployment });
}
