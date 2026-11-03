import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";

const PORT = Number(process.env.LIBRARY_BENCHMARK_PORT || 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ITEMS = Number(process.env.LIBRARY_BENCHMARK_ITEMS || 10_000);
const PREVIEW = spawn(
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

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/harness.html`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Vite preview did not start on " + ORIGIN);
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

try {
  await waitForServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send("Performance.enable");

    const started = performance.now();
    await page.goto(`${ORIGIN}/harness.html?benchmark=${ITEMS}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector(".gallery-tile", { timeout: 30_000 });
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
    await page.waitForSelector(".album-card", { timeout: 30_000 });
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

    console.log(
      JSON.stringify(
        {
          harness: "Chromium browser proxy; not a signed native/WebKit measurement",
          items: ITEMS,
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
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
} finally {
  PREVIEW.kill("SIGTERM");
}
