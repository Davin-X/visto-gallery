import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const PORT = Number(process.env.LIBRARY_BENCHMARK_PORT || 4173);
const ITEMS = Number(process.env.LIBRARY_BENCHMARK_ITEMS || 10_000);
// When an external server is provided (e.g. CI with its own vite preview), reuse it.
const EXTERNAL_ORIGIN = process.env.LIBRARY_BENCHMARK_ORIGIN;
const ORIGIN = EXTERNAL_ORIGIN || `http://127.0.0.1:${PORT}`;

async function waitForServer(origin, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/harness.html`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Harness did not become ready at " + origin);
}

async function metrics(page, client) {
  const response = await client.send("Performance.getMetrics");
  const values = Object.fromEntries(
    response.metrics.map(({ name, value }) => [name, value]),
  );
  return {
    jsHeapUsedBytes: values.JSHeapUsedSize,
    nodes: values.Nodes,
    jsEventListeners: values.JSEventListeners,
  };
}

export async function runLibraryHarnessBenchmark({
  items = ITEMS,
  origin = ORIGIN,
} = {}) {
  await waitForServer(origin);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send("Performance.enable");

    const started = performance.now();
    await page.goto(`${origin}/harness.html?benchmark=${items}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector(".gallery-tile", { timeout: 60_000 });
    const firstUsefulScreenMs = performance.now() - started;
    // Let near-viewport thumbnails and the initial React commit settle.
    await page.waitForTimeout(500);
    const firstScreenMemory = await metrics(page, client);
    const mountedTiles = await page.locator(".gallery-tile").count();

    const callsAfterLibrary = await page.evaluate(
      () => ({ ...(window.__benchmark?.calls || {}) }),
    );

    const albumsStarted = performance.now();
    await page.getByRole("button", { name: /^Albums$/ }).click();
    await page.waitForSelector(".album-card", { timeout: 60_000 });
    const albumsOverviewMs = performance.now() - albumsStarted;
    await page.waitForTimeout(200);

    const callsAfterAlbums = await page.evaluate(
      () => ({ ...(window.__benchmark?.calls || {}) }),
    );
    const albumsMemory = await metrics(page, client);

    const maxActiveThumbnails = await page.evaluate(
      () => window.__benchmark?.maxActiveThumbnails || 0,
    );
    const albumCards = await page.locator(".album-card").count();

    return {
      harness: "Chromium browser proxy; not a signed native/WebKit measurement",
      items,
      viewport: "1440x900",
      firstUsefulScreenMs: Number(firstUsefulScreenMs.toFixed(1)),
      albumsOverviewMs: Number(albumsOverviewMs.toFixed(1)),
      mountedTiles,
      albumCards,
      callsAfterLibrary,
      callsAfterAlbums,
      maxActiveThumbnails,
      firstScreenMemory,
      albumsMemory,
      thumbnailNote:
        "Synthetic in-memory invoke handler; it measures the app's configured 6-request thumbnail window, not real disk/ImageIO latency.",
      memoryNote:
        "JSHeapUsedSize is the Chromium JavaScript heap metric, not total native process RSS.",
    };
  } finally {
    await browser.close();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  let preview = null;
  if (!EXTERNAL_ORIGIN) {
    preview = spawn(
      "npx",
      [
        "vite",
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(PORT),
        "--strictPort",
      ],
      { stdio: "ignore" },
    );
  }
  try {
    const result = await runLibraryHarnessBenchmark({ items: ITEMS, origin: ORIGIN });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    preview?.kill("SIGTERM");
  }
}
