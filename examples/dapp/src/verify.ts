import { ExplorerVerifyError, verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

export const PENDING_KEY = "greeter-verification";

function summary(result: VerifyResult): string {
  if (result.status === "failed") {
    return `Sourcify rejected the source: ${result.reason}`;
  }
  return [result.status, `(${result.match})`, result.explorerUrl].join(" ");
}

/** Verifies on Sourcify, saves the handle for a reload, and shows each step with `show`. */
export async function verifyOnSourcify(
  input: VerifyInput,
  show: (line: string) => void,
): Promise<void> {
  try {
    const result = await verify(input, {
      onEvent: (event) => {
        if (event.type === "verify.submitted") {
          // Saved before the first poll, so a reload can resume the job (step 5).
          localStorage.setItem(PENDING_KEY, event.handle);
          show(`Submitted. Handle: ${event.handle}`);
        }
      },
    });
    localStorage.removeItem(PENDING_KEY);
    show(summary(result));
  } catch (error) {
    if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
      show("Sourcify is still checking. Reload the page later to see the result.");
      return;
    }
    // Every other end leaves nothing to resume.
    localStorage.removeItem(PENDING_KEY);
    if (error instanceof ExplorerVerifyError) {
      show(`${error.details.code}: ${error.hint}`);
      return;
    }
    throw error;
  }
}
