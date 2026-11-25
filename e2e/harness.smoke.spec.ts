import { expect, test } from "@playwright/test";

// The app's thumbnail scheduler allows at most 6 concurrent requests
// (CachedThumbnail MAX_CONCURRENT_THUMBNAIL_REQUESTS).
const MAX_ACTIVE_THUMBNAILS = 6;

test("harness renders the library grid within thumbnail bounds", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/harness.html?benchmark=2000", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile", { timeout: 30_000 });

  // First page of synthetic items is present.
  const tiles = page.locator(".gallery-tile");
  expect(await tiles.count()).toBeGreaterThan(0);

  // Let near-viewport thumbnails settle, then verify the app never exceeded
  // its configured concurrent-thumbnail bound.
  await page.waitForTimeout(500);
  const maxActive = await page.evaluate(
    () =>
      (window as unknown as { __benchmark?: { maxActiveThumbnails?: number } }).__benchmark
        ?.maxActiveThumbnails ?? 0,
  );
  expect(maxActive).toBeLessThanOrEqual(MAX_ACTIVE_THUMBNAILS);

  expect(pageErrors, `page errors: ${pageErrors.join("; ")}`).toEqual([]);
});

test("harness General settings exposes the Default apps preview state", async ({ page }) => {
  await page.goto("/harness.html?benchmark=10");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Default apps" })).toBeVisible();
  await expect(page.getByText("Default apps can be set from the installed app.")).toBeVisible();
});

test("Advanced settings opens Storage and shows fixture usage", async ({ page }) => {
  await page.goto("/harness.html?benchmark=10");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Advanced" }).click();
  await expect(page.getByRole("region", { name: "Storage" })).toContainText("8.0 KB");
});
