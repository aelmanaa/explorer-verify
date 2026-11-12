// Renders the PNG images of the docs site from their SVG sources in site/static/ (#373): the
// 32 px favicon, the 180 px Apple touch icon and the 1280×640 social image. The PNGs are
// committed, so the images look the same in every browser and on every social network. Run it
// after editing an SVG source, then optimise the PNGs if a tool is at hand and commit them.
//
// It renders in Chromium through Playwright. When Playwright's own Chromium is not installed, pass
// the path of a Chrome or Chromium binary.
//
// Usage: node site/render-images.ts [browser-path]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "static");

/** Each PNG, its SVG source and its size in pixels. */
const IMAGES = [
  { png: "favicon-32.png", svg: "favicon.svg", width: 32, height: 32 },
  { png: "apple-touch-icon.png", svg: "apple-touch-icon.svg", width: 180, height: 180 },
  { png: "og-image.png", svg: "og-image.svg", width: 1280, height: 640 },
];

const [executablePath] = process.argv.slice(2);
const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
try {
  for (const { png, svg, width, height } of IMAGES) {
    const page = await browser.newPage({ viewport: { width, height } });
    const data = Buffer.from(readFileSync(path.join(dir, svg))).toString("base64");
    await page.setContent(
      `<body style="margin:0"><img src="data:image/svg+xml;base64,${data}" width="${width}" height="${height}" style="display:block"></body>`,
    );
    await page.locator("img").evaluate((image) => {
      if (!(image instanceof HTMLImageElement)) {
        throw new Error("no image");
      }
      return image.decode();
    });
    await page.screenshot({ path: path.join(dir, png), omitBackground: true });
    await page.close();
    process.stdout.write(`render-images: wrote site/static/${png}\n`);
  }
} finally {
  await browser.close();
}
