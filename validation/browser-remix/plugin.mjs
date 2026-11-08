import { PluginClient } from "@remixproject/plugin";
import { createClient } from "@remixproject/plugin-webview";
import { buildVerifyInput, validateInput, verify, checkStatus } from "explorer-verify";
const client = createClient(
  new PluginClient({ customTheme: true, allowOrigins: [location.origin] }),
);
const scenarios = [];
function check(name, condition, detail) {
  scenarios.push({ name, success: Boolean(condition), detail });
  if (condition !== true) throw new Error(name + ": " + JSON.stringify(detail));
}
async function run(file, sources, version, output) {
  const config = await (await fetch("/fixture.json")).json();
  // Remix's event output contains metadata, not the complete Standard JSON settings.
  const metadata = JSON.parse(output.contracts[file].Counter.metadata);
  const contents = Object.fromEntries(
    Object.entries(sources).map(([path, value]) => [path, value.content]),
  );
  const built = buildVerifyInput([metadata], { sources: contents });
  const receipt = config.receipt;
  if (receipt.status !== "0x1" || typeof receipt.contractAddress !== "string")
    throw new Error("Unsuccessful deployment receipt");
  const input = validateInput({
    ...built,
    chainId: config.chainId,
    address: receipt.contractAddress,
    creationTxHash: receipt.transactionHash,
  });
  check(
    "remix-compilation-to-receipt",
    built.compiler.version === version && input.contractName === "contracts/Counter.sol:Counter",
    { compiler: built.compiler.version, contract: input.contractName, address: input.address },
  );
  check(
    "build-info-equivalence",
    buildVerifyInput([config.buildInfo]).contractName === input.contractName,
    "Same solc build, locally assembled build-info envelope",
  );
  try {
    buildVerifyInput([metadata]);
    check("incomplete-input", false);
  } catch (error) {
    check("incomplete-input", error.code === "incomplete-input", {
      code: error.code,
      field: error.details?.field,
      hint: error.hint,
    });
  }
  try {
    buildVerifyInput([metadata], { sources: { [file]: contents[file] + "\n// changed" } });
    check("source-mismatch", false);
  } catch (error) {
    check("source-mismatch", error.code === "source-mismatch", { code: error.code });
  }
  try {
    buildVerifyInput([{ output }]);
    check("output-only-incomplete", false);
  } catch (error) {
    check("output-only-incomplete", error.code === "incomplete-input", {
      code: error.code,
      field: error.details?.field,
    });
  }
  try {
    await fetch(config.explorer + "/no-cors");
    check("browser-enforces-cors", false);
  } catch (error) {
    check(
      "browser-enforces-cors",
      error instanceof TypeError,
      "Cross-origin response without CORS blocked",
    );
  }
  const recovered = buildVerifyInput([metadata], { sources: contents });
  check(
    "source-recovery",
    recovered.contractName === built.contractName,
    "Restored exact source contents; no bytecode-only recovery attempted",
  );
  for (const mode of ["accepted", "rejected", "pending"]) {
    const options = {
      route: { backend: "sourcify", apiUrl: config.explorer + "/" + mode },
      pollIntervalMs: 10,
      timeoutMs: mode === "pending" ? 150 : 3000,
      onEvent(event) {
        if (event.type === "verify.submitted") localStorage.setItem("pending-handle", event.handle);
      },
    };
    try {
      const result = await verify(input, options);
      check(mode, result.status === (mode === "rejected" ? "failed" : "verified"), result);
    } catch (error) {
      check(
        "pending",
        mode === "pending" &&
          error.code === "not-confirmed" &&
          Boolean(localStorage.getItem("pending-handle")),
        { code: error.code },
      );
    }
  }
  window.validation = { success: scenarios.every((s) => s.success === true), scenarios };
}
await client.onload();
client.on("solidity", "compilationFinished", (...args) => {
  void run(...args).catch((error) => {
    window.validation = { success: false, scenarios, error: error.message };
  });
});
window.resumeValidation = async () => {
  const config = await (await fetch("/fixture.json")).json();
  const handle = localStorage.getItem("pending-handle");
  const result = await checkStatus(handle, {
    route: { backend: "sourcify", apiUrl: config.explorer + "/resume" },
    timeoutMs: 3000,
    pollIntervalMs: 10,
  });
  localStorage.removeItem("pending-handle");
  return {
    name: "pending-resume-after-reload",
    success: result.status === "verified",
    detail: result,
  };
};
