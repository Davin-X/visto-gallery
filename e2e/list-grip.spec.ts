import { expect, test } from "@playwright/test";

// Ad-hoc regression: the leading grip in the Albums list must be draggable.
test("drag the list-row grip reorders the list", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40&albums=6", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await page.getByRole("button", { name: "List view" }).click();
  const rows = page.locator(".albums-list-view .list-view-row");
  await expect(rows.nth(0)).toContainText("Benchmark Album 0");

  const handle = rows.nth(0).locator(".albums-list-grip");
  const targetBox = await rows.nth(2).boundingBox();
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + 30, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();

  // Dropping the first row onto the left edge of the third row lands it
  // before it: 1, 0, 2, …
  await expect(rows.nth(0)).toContainText("Benchmark Album 1");
  await expect(rows.nth(1)).toContainText("Benchmark Album 0");
  await expect(rows.nth(2)).toContainText("Benchmark Album 2");
});
