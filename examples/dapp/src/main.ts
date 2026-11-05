// The page's entry module: the button code of step 4 of the tutorial
// docs/user/tutorials/deploy-and-verify-from-a-dapp.md, with the resume step (step 5) on load and
// the Etherscan step (step 7) when the user ticks the box with the id `etherscan`.
import { deployGreeter, resumeDeployment } from "./deploy.ts";
import type { Deployment } from "./deploy.ts";
import { loadVerifyInput } from "./load-input.ts";
import { resumeVerification } from "./resume.ts";
import { verifyOnEtherscan } from "./verify-etherscan.ts";
import { verifyOnSourcify } from "./verify.ts";

const status = document.querySelector("#status");

function show(line: string): void {
  const paragraph = document.createElement("p");
  paragraph.textContent = line;
  status?.append(paragraph);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether the user asked to verify on Etherscan too, through the dapp's server. */
function onEtherscanToo(): boolean {
  const box = document.querySelector("#etherscan");
  return box instanceof HTMLInputElement && box.checked;
}

async function verifyDeployment(deployment: Deployment): Promise<void> {
  show(`Deployed at ${deployment.address} in transaction ${deployment.creationTxHash}`);
  const input = await loadVerifyInput(deployment);
  show(`Loaded ${input.contractName}, compiled with ${input.compiler.version}`);
  await verifyOnSourcify(input, show);
  if (onEtherscanToo()) {
    const result = await verifyOnEtherscan(input);
    show(`Etherscan: ${result.status}`);
  }
}

document.querySelector("#deploy")?.addEventListener("click", () => {
  deployGreeter("Hello, Sepolia")
    .then(verifyDeployment)
    .catch((error: unknown) => {
      show(message(error));
    });
});

try {
  await resumeVerification(show);
  const pending = await resumeDeployment();
  if (pending !== undefined) {
    await verifyDeployment(pending);
  }
} catch (error) {
  show(message(error));
}
