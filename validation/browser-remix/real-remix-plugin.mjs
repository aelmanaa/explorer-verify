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
  window.realRemix = {
    stage: "compiled-and-built-sdk-input",
    success: true,
    compilation,
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
