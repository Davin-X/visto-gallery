import { expect, test } from "@playwright/test";

type PreviewCall = { itemId: string; full: boolean };

test("a RAW file shows a labelled stand-in, then its sharp preview, then full size on zoom", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=10&raw=2", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");

  await page.locator(".gallery-tile .tile-open-button").first().dblclick();
  await expect(page.locator(".viewer-screen")).toBeVisible();

  // The grid thumbnail stands in, and says so, while the preview renders.
  await expect(page.locator(".viewer-lowres-badge")).toHaveText("RAW preview");
  // Then the ImageIO preview replaces it, keeping the RAW preview badge until zoomed.
  await expect(page.locator("img.photo-viewer-image:not(.photo-viewer-backdrop)")).toBeVisible();
  await expect(page.locator(".viewer-lowres-badge")).toHaveText("RAW preview");

  const calls = () =>
    page.evaluate(() => (window as unknown as { __previewCalls: PreviewCall[] }).__previewCalls);
  await expect.poll(async () => (await calls()).map((call) => call.full)).toEqual([false]);

  // Zooming past what the screen-size preview resolves asks for full size.
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByRole("button", { name: "Reset zoom" })).toHaveText("150%");
  await expect.poll(async () => (await calls()).map((call) => call.full)).toEqual([false, true]);
  await expect(page.locator(".viewer-lowres-badge")).toHaveText("Full render");

  expect(pageErrors).toEqual([]);
});

test("a photo the web view cannot load falls back to one screen-size preview", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=10", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.locator(".gallery-tile .tile-open-button").first().dblclick();
  await expect(page.locator("img.photo-viewer-image:not(.photo-viewer-backdrop)")).toBeVisible();
  // The synthetic originals cannot be loaded, so the viewer asks ImageIO for
  // a screen-size preview, once.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __previewCalls: PreviewCall[] }).__previewCalls),
    )
    .toEqual([expect.objectContaining({ full: false })]);
});
