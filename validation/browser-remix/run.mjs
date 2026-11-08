import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, cp, rm, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium } from "playwright";
import solc from "solc";
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
}
const tarballs = option("--tarballs");
if (typeof tarballs !== "string" || tarballs.length === 0)
  throw new Error(
    "Usage: node validation/browser-remix/run.mjs --tarballs <directory> [--output <directory>] [--chrome <executable>]",
  );
const output = resolve(option("--output", join(here, "output")));
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "browser-remix-"));
let browser;
const servers = [];
const requests = [];
const result = {
  success: false,
  candidate: "df036c7245c1baefa869478c7a5a00ca5366d8a2",
  scenarios: [],
};
async function serve(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing listen address");
  return `http://127.0.0.1:${address.port}`;
}
try {
  const tarball = join(resolve(tarballs), "explorer-verify-0.1.0.tgz");
  result.package = {
    name: "explorer-verify",
    version: "0.1.0",
    sha256: createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex"),
  };
  await cp(tarball, join(temp, "candidate.tgz"));
  await writeFile(
    join(temp, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "explorer-verify": "file:./candidate.tgz" },
    }),
  );
  const install = spawnSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
    ],
    { cwd: temp, encoding: "utf8" },
  );
  if (install.status !== 0) throw new Error("Temporary packed SDK installation failed");
  const require = createRequire(join(temp, "package.json"));
  const pkg = JSON.parse(
    await readFile(join(temp, "node_modules/explorer-verify/package.json"), "utf8"),
  );
  if (pkg.version !== "0.1.0") throw new Error("Wrong SDK version");
  const source = await readFile(join(here, "Counter.sol"), "utf8");
  const input = {
    language: "Solidity",
    sources: { "contracts/Counter.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": { "*": ["abi", "metadata", "evm.bytecode", "evm.deployedBytecode"], "": ["ast"] },
      },
    },
  };
  const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
  if (compiled.errors?.some((e) => e.severity === "error") === true)
    throw new Error("Compilation failed");
  const version = solc.version().replace(/\.Emscripten\.clang$/, "");
  const buildInfo = { input, output: compiled, solcLongVersion: version };
  await writeFile(join(output, "build-info.json"), JSON.stringify(buildInfo, null, 2) + "\n");
  const explorer = await serve(async (req, res) => {
    if (req.url === "/no-cors") {
      res.end("{}");
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const mode = req.url.split("/")[1];
    requests.push({
      method: req.method,
      mode,
      path: req.url.replace(/^\/[^/]+/, ""),
      body: body ? JSON.parse(body) : undefined,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url.includes("/contract/") === true) {
      res.writeHead(404).end(
        JSON.stringify({
          match: null,
          chainId: "11155111",
          address: "0x1234567890123456789012345678901234567890",
        }),
      );
      return;
    }
    if (req.method === "POST") {
      res
        .writeHead(202)
        .end(JSON.stringify({ verificationId: "00000000-0000-4000-8000-000000000001" }));
      return;
    }
    res.end(
      JSON.stringify(
        mode === "pending"
          ? { isJobCompleted: false, verificationId: "00000000-0000-4000-8000-000000000001" }
          : mode === "rejected"
            ? {
                isJobCompleted: true,
                verificationId: "00000000-0000-4000-8000-000000000001",
                error: { customCode: "compiler_error", message: "Local stand-in rejected source" },
              }
            : {
                isJobCompleted: true,
                verificationId: "00000000-0000-4000-8000-000000000001",
                contract: {
                  match: "exact_match",
                  runtimeMatch: "exact_match",
                  creationMatch: "exact_match",
                },
              },
      ),
    );
  });
  const fixture = {
    buildInfo,
    explorer,
    chainId: 11155111,
    receipt: {
      status: "0x1",
      contractAddress: "0x1234567890123456789012345678901234567890",
      transactionHash: "0x" + "12".repeat(32),
    },
  };
  const built = await build({
    entryPoints: [join(here, "plugin.mjs"), join(here, "host.mjs")],
    outdir: join(temp, "web"),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    metafile: true,
    alias: { "explorer-verify": require.resolve("explorer-verify") },
  });
  const modules = Object.keys(built.metafile.inputs);
  if (modules.some((path) => /packages\/.*\/src|@explorer-verify\/(foundry|hardhat)/.test(path)))
    throw new Error("Non-public browser dependency");
  result.bundle = {
    files: (await readdir(join(temp, "web"))).length,
    inputModules: modules.length,
    sdkFromPackedPackage: true,
  };
  const origin = await serve(async (req, res) => {
    if (req.url === "/fixture.json") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(fixture));
      return;
    }
    if (req.url === "/" || req.url === "/plugin.html") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<html><body><script type="module" src="/${req.url === "/" ? "host" : "plugin"}.js"></script></body></html>`,
      );
      return;
    }
    try {
      res.setHeader("Content-Type", "text/javascript");
      res.end(await readFile(join(temp, "web", req.url.slice(1))));
    } catch {
      res.writeHead(404).end();
    }
  });
  browser = await chromium.launch({
    executablePath: option(
      "--chrome",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ),
    headless: true,
  });
  result.browser = browser.version();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    process.stderr.write(error.message + "\n");
  });
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://127.0.0.1:") ? route.continue() : route.abort(),
  );
  await page.goto(origin);
  await page.waitForSelector("iframe");
  const frame = page.frames().find((candidateFrame) => candidateFrame.parentFrame() !== null);
  if (!frame) throw new Error("No plugin iframe");
  await frame.waitForFunction(() => window.validation, { timeout: 20000 });
  const validation = await frame.evaluate(() => window.validation);
  result.scenarios.push(...validation.scenarios);
  if (validation.success !== true) throw new Error(validation.error ?? "Scenario failed");
  const transport = await page.evaluate(() => window.transport);
  result.scenarios.push({
    name: "real-plugin-webview-transport",
    success:
      transport.some((m) => m.action === "response" && m.key === "handshake") === true &&
      transport.some((m) => m.action === "on" && m.key === "compilationFinished"),
    detail: transport,
  });
  const postsBefore = requests.filter((r) => r.method === "POST").length;
  await frame.goto(origin + "/plugin.html");
  await frame.waitForFunction(() => window.resumeValidation);
  result.scenarios.push(await frame.evaluate(() => window.resumeValidation()));
  const posts = requests.filter((r) => r.method === "POST");
  result.scenarios.push({
    name: "resume-never-resubmits",
    success: posts.length === postsBefore && posts.length === 3,
  });
  result.scenarios.push({
    name: "submission-preserves-source-and-target",
    success: posts.every(
      (r) =>
        r.body.stdJsonInput.sources["contracts/Counter.sol"].content === source &&
        r.body.contractIdentifier === "contracts/Counter.sol:Counter" &&
        r.body.compilerVersion === version &&
        r.body.creationTransactionHash === fixture.receipt.transactionHash,
    ),
    detail: { submissions: posts.length },
  });
  result.scenarios.push({
    name: "no-browser-errors",
    success: errors.length === 0,
    detail: errors,
  });
  const rebuiltOutput = JSON.parse(solc.compile(JSON.stringify(posts[0].body.stdJsonInput)));
  result.scenarios.push({
    name: "metadata-rebuilt-input-recompiles-identically",
    success:
      rebuiltOutput.contracts["contracts/Counter.sol"].Counter.evm.bytecode.object ===
      compiled.contracts["contracts/Counter.sol"].Counter.evm.bytecode.object,
  });
  result.success = result.scenarios.every((s) => s.success === true);
} catch (error) {
  result.error = error.message;
} finally {
  await browser?.close();
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  await rm(temp, { recursive: true, force: true });
  await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
if (!result.success) process.exitCode = 1;
