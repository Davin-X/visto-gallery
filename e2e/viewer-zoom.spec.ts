import { expect, test, type Page } from "@playwright/test";

async function openViewer(page: Page) {
  // The harness has catalog paths but no original files. Supply a square image
  // so the zoom measurement cannot race a broken-image fallback.
  await page.route("**/synthetic/benchmark-*.jpg*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><rect width="900" height="900" fill="gray"/></svg>',
    }),
  );
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=10", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.locator(".gallery-tile .tile-open-button").first().dblclick();
  await expect(page.locator(".viewer-screen")).toBeVisible();
  await expect(page.locator(".photo-viewer-image")).toBeVisible();
}

const zoomLabel = (page: Page) => page.getByRole("button", { name: "Reset zoom" });
const percent = async (page: Page) =>
  Number((await zoomLabel(page).textContent())?.replace("%", ""));
const imageBox = async (page: Page) => (await page.locator(".photo-viewer-image").boundingBox())!;

test("pinch zoom keeps the point under the pointer fixed, and scrolling pans", async ({ page }) => {
  await openViewer(page);
  const stage = (await page.locator(".viewer-stage").boundingBox())!;
  const pointer = { x: stage.x + stage.width / 2 + 160, y: stage.y + stage.height / 2 + 70 };

  const before = await imageBox(page);
  const fraction = (box: { x: number; y: number; width: number; height: number }) => ({
    x: (pointer.x - box.x) / box.width,
    y: (pointer.y - box.y) / box.height,
  });
  const start = fraction(before);

  // A trackpad pinch arrives as Ctrl+wheel in Chromium.
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.down("Control");
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -40);
  await page.keyboard.up("Control");

  await expect.poll(() => percent(page)).toBeGreaterThan(200);
  await expect
    .poll(async () => {
      const now = fraction(await imageBox(page));
      // The square test photo is letterboxed sideways, so it stays centred
      // horizontally until it overflows; vertically it overflows at once and
      // the point under the pointer must stay put.
      return Math.abs(now.y - start.y);
    })
    .toBeLessThan(0.01);

  // Two-finger scroll moves around the zoomed photo.
  const zoomedTop = (await imageBox(page)).y;
  await page.mouse.wheel(0, 60);
  await expect.poll(async () => (await imageBox(page)).y).toBeLessThan(zoomedTop - 30);

  // ⌘-scroll zooms back out and stops at the minimum.
  await page.keyboard.down("Meta");
  for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, 100);
  await page.keyboard.up("Meta");
  await expect.poll(() => percent(page)).toBe(25);
});

test("zoom buttons and arrow keys use finer steps", async ({ page }) => {
  await openViewer(page);
  await expect(zoomLabel(page)).toHaveText("100%");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoomLabel(page)).toHaveText("125%");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoomLabel(page)).toHaveText("150%");
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect(zoomLabel(page)).toHaveText("125%");
  await page.keyboard.press("ArrowDown");
  await expect(zoomLabel(page)).toHaveText("100%");
  await page.keyboard.press("ArrowDown");
  await expect(zoomLabel(page)).toHaveText("75%");
  await zoomLabel(page).click();
  await expect(zoomLabel(page)).toHaveText("100%");
});
