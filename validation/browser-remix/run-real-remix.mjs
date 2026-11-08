import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
}
const tarballs = option("--tarballs");
if (typeof tarballs !== "string")
  throw new Error("Use --tarballs <directory> [--output <directory>] [--chrome <executable>]");
const output = resolve(option("--output", join(here, "output/real-remix")));
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "real-remix-"));
const result = {
  startedAt: new Date().toISOString(),
  target: "https://remix.ethereum.org",
  optional: true,
  success: false,
  status: "blocked",
  stage: "install-packed-sdk",
  scenarios: [],
  constraints: {
    freshBrowserContext: true,
    walletConnected: false,
    deploymentAttempted: false,
    explorerSubmissionAttempted: false,
  },
};
let browser;
let server;
const networkFailures = [];
try {
  const packed = await readFile(join(resolve(tarballs), "explorer-verify-0.1.0.tgz"));
  result.package = {
    name: "explorer-verify",
    version: "0.1.0",
    sha256: createHash("sha256").update(packed).digest("hex"),
  };
  await writeFile(join(temp, "candidate.tgz"), packed);
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
    { cwd: temp, encoding: "utf8", timeout: 60000 },
  );
  if (install.status !== 0) throw new Error("Temporary public package installation failed");
  const require = createRequire(join(temp, "package.json"));
  const pkg = JSON.parse(
    await readFile(join(temp, "node_modules/explorer-verify/package.json"), "utf8"),
  );
  if (pkg.version !== "0.1.0") throw new Error("Expected packed SDK 0.1.0");
  await build({
    entryPoints: [join(here, "real-remix-plugin.mjs")],
    outfile: join(temp, "plugin.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    alias: { "explorer-verify": require.resolve("explorer-verify") },
  });
  server = createServer((req, res) => {
    const path =
      req.url === "/plugin.js"
        ? join(temp, "plugin.js")
        : req.url === "/Counter.sol"
          ? join(here, "Counter.sol")
          : undefined;
    if (path === undefined) {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<html><body>Optional real Remix SDK compilation smoke<script type="module" src="/plugin.js"></script></body></html>',
      );
      return;
    }
    res.setHeader("Content-Type", req.url === "/plugin.js" ? "text/javascript" : "text/plain");
    void readFile(path)
      .then((data) => res.end(data))
      .catch(() => res.writeHead(500).end());
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No local plugin port");
  const pluginUrl = `http://127.0.0.1:${address.port}`;
  result.stage = "navigate-real-ide";
  browser = await chromium.launch({
    executablePath: option(
      "--chrome",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ),
    headless: true,
  });
  result.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.grantPermissions(["local-network-access"], {
    origin: "https://remix.ethereum.org",
  });
  await context.grantPermissions(["local-network-access"], { origin: "https://app.remix.live" });
  result.localNetworkPermission = "granted-to-remix-origins-in-fresh-context";
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  result.promotionsDismissed = 0;
  await page.addLocatorHandler(page.locator(".nudge-widget-title"), async (title) => {
    const widget = title.locator("xpath=ancestor::div[.//button][1]");
    await writeFile(
      join(output, "promotion-dom.html"),
      await widget.evaluate((element) => element.outerHTML),
    );
    const close = widget.locator(
      'button[class*="close"], button[class*="dismiss"], [aria-label="Close"], [aria-label="Dismiss"]',
    );
    await close.first().click();
    result.promotionsDismissed += 1;
  });
  page.on("requestfailed", (request) => {
    // Keep only host/path, never query parameters, headers, bodies or credentials.
    const url = new URL(request.url());
    networkFailures.push({
      resource: url.origin + url.pathname,
      error: request.failure()?.errorText,
    });
  });
  const response = await page.goto(result.target, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  result.httpStatus = response?.status();
  result.finalUrl = page.url();
  result.scenarios.push({ name: "real-remix-navigation", success: response?.status() === 200 });
  result.stage = "dismiss-onboarding";
  await page
    .getByRole("button", { name: "Manage Preferences", exact: true })
    .click({ timeout: 45000 });
  const performanceToggle = page.locator("#matomoPerfAnalyticsToggle");
  if (await performanceToggle.isVisible()) {
    if ((await performanceToggle.locator(".fa-toggle-on").count()) > 0)
      await performanceToggle.click();
    result.performanceAnalytics =
      (await performanceToggle.locator(".fa-toggle-off").count()) > 0 ? "disabled" : "unconfirmed";
    if (result.performanceAnalytics !== "disabled")
      throw new Error("Performance analytics toggle did not turn off");
  } else result.performanceAnalytics = "control-unavailable";
  await page.getByRole("button", { name: "Save Preferences", exact: true }).click();
  result.stage = "open-plugin-manager";
  await page.getByText("Plugins", { exact: true }).first().click();
  await page.getByText("Connect to an external plugin", { exact: true }).click();
  result.stage = "configure-external-plugin";
  // Form selectors intentionally follow the website UI; changed labels produce a blocked run.
  const modal = page.locator(".modal-content").filter({ has: page.locator("#local-plugin-form") });
  await writeFile(join(output, "plugin-form.txt"), await modal.innerText());
  await modal.locator("#plugin-name").fill("explorerVerifySmoke");
  await modal.locator("#plugin-url").fill(pluginUrl);
  await modal.locator("#plugin-canactivate").fill("solidity");
  const frameAttached = page.waitForEvent("frameattached", { timeout: 20000 });
  await modal.getByRole("button", { name: "OK", exact: true }).click();
  result.stage = "await-real-host-compilation";
  const handle = await frameAttached;
  await handle.waitForURL(pluginUrl + "/**", { timeout: 20000 });
  // Only this compilation permission may be granted. Never approve wallet or deployment access.
  const permission = page
    .locator(".modal-content:visible")
    .filter({ hasText: "compileWithParameters" });
  const compilationDeadline = Date.now() + 60000;
  while (Date.now() < compilationDeadline) {
    if (await permission.isVisible()) {
      await writeFile(join(output, "compiler-permission.txt"), await permission.innerText());
      await permission.getByRole("button", { name: /accept|allow/i }).click();
    }
    if (await handle.evaluate(() => window.realRemix?.success !== undefined)) break;
    await handle
      .waitForFunction(() => window.realRemix?.success !== undefined, undefined, { timeout: 1000 })
      .catch(() => undefined);
  }
  const observed = await handle.evaluate(() => window.realRemix);
  result.pluginStage = observed.stage;
  if (observed.success !== true) throw new Error(observed.error ?? "Real compiler did not succeed");
  await writeFile(
    join(output, "compilation.json"),
    JSON.stringify(observed.compilation, null, 2) + "\n",
  );
  await writeFile(
    join(output, "sdk-built-input.json"),
    JSON.stringify(observed.built, null, 2) + "\n",
  );
  await writeFile(join(output, "metadata.json"), JSON.stringify(observed.metadata, null, 2) + "\n");
  await writeFile(
    join(output, "build-info.json"),
    JSON.stringify(observed.buildInfo, null, 2) + "\n",
  );
  await writeFile(
    join(output, "sdk-built-from-build-info.json"),
    JSON.stringify(observed.builtFromBuildInfo, null, 2) + "\n",
  );
  if (observed.compilationEvent !== null)
    await writeFile(
      join(output, "compilation-event.json"),
      JSON.stringify(observed.compilationEvent, null, 2) + "\n",
    );
  result.compilationEventCaptured = observed.compilationEvent !== null;
  result.scenarios.push({
    name: "authentic-remix-build-info-to-sdk",
    success: true,
    contract: observed.builtFromBuildInfo.contractName,
  });
  result.scenarios.push({
    name: "actual-remix-host-compiler-to-public-sdk",
    success: true,
    compiler: observed.compiler,
  });
  result.success = true;
  result.status = "passed";
  result.stage = "complete";
  result.networkFailures = networkFailures;
} catch (error) {
  result.error = error.message.replaceAll(temp, "<temporary-consumer>");
  if (browser !== undefined) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages[0];
    if (page !== undefined) {
      // Fresh context, no wallet/deploy screens opened; capture UI only, never browser storage.
      const pluginFrame = page
        .frames()
        .find((frame) => frame.url().startsWith("http://127.0.0.1:"));
      if (pluginFrame !== undefined)
        result.pluginObservation = await pluginFrame
          .evaluate(() => window.realRemix)
          .catch(() => undefined);
      result.title = await page.title().catch(() => "unavailable");
      await page.screenshot({ path: join(output, "blocked.png") }).catch(() => undefined);
      await writeFile(
        join(output, "blocked-ui.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable"),
      );
    }
  }
} finally {
  await browser?.close();
  if (server !== undefined) await new Promise((done) => server.close(done));
  await rm(temp, { recursive: true, force: true });
  result.networkFailures = networkFailures;
  result.finishedAt = new Date().toISOString();
  await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
if (result.status !== "passed") process.exitCode = 1;
