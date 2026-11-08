import { PluginClient } from "@remixproject/plugin";
import { createClient } from "@remixproject/plugin-webview";
import { buildVerifyInput } from "explorer-verify";

window.realRemix = { stage: "awaiting-real-host-handshake" };
const client = createClient(
  new PluginClient({
    customTheme: true,
    allowOrigins: ["https://remix.ethereum.org", "https://app.remix.live"],
  }),
);
await client.onload();
window.realRemix = { stage: "real-host-connected" };
try {
  let compilationEvent;
  client.on("solidity", "compilationFinished", (fileName, sources, languageVersion, data) => {
    compilationEvent = { fileName, sources, languageVersion, data };
  });
  const source = await (await fetch("/Counter.sol")).text();
  const sources = { "contracts/Counter.sol": { content: source } };
  window.realRemix = { stage: "requesting-real-compiler" };
  const compilation = await client.call("solidity", "compileWithParameters", sources, {
    language: "Solidity",
    optimize: true,
    version: "0.8.24+commit.e11b9ed9",
  });
  const output = compilation.data;
  const metadata = JSON.parse(output.contracts["contracts/Counter.sol"].Counter.metadata);
  const built = buildVerifyInput([metadata], { sources: { "contracts/Counter.sol": source } });
  const buildInfo = {
    input: compilation.input,
    output,
    solcLongVersion: compilation.languageversion,
  };
  const builtFromBuildInfo = buildVerifyInput([buildInfo]);
  if (
    built.compiler.version !== "0.8.24+commit.e11b9ed9" ||
    builtFromBuildInfo.contractName !== built.contractName ||
    builtFromBuildInfo.compiler.version !== built.compiler.version
  )
    throw new Error("Real compiler/build-info identity did not match the requested build");
  window.realRemix = {
    stage: "compiled-and-built-sdk-input",
    success: true,
    compilation,
    compilationEvent: compilationEvent ?? null,
    buildInfo,
    builtFromBuildInfo,
    metadata,
    built,
    compiler: metadata.compiler.version,
  };
} catch (error) {
  window.realRemix = {
    stage: "real-compiler-request-failed",
    success: false,
    error: error.message,
  };
}
