import { expect, test } from "@playwright/test";

// The album header trim: the breadcrumb row collapsed into the detail head and
// the item count merged into the h1 line, so the header is compact again.
test("open album header is compact and still navigates back", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await page.waitForSelector(".album-card");
  await page.locator(".album-card").first().click();
  await page.waitForSelector(".album-detail-top");

  await expect(page.locator(".album-breadcrumb")).toHaveCount(0);
  await expect(page.locator(".album-back-button")).toHaveCount(1);
  await expect(page.locator(".album-count-inline")).toHaveText(/4 items/);

  const header = await page.locator(".page-heading").evaluate((element) => ({
    height: Math.round(element.getBoundingClientRect().height),
  }));
  expect(header.height, "album header must stay compact").toBeLessThanOrEqual(90);

  const firstTile = page.locator(".gallery-tile").first();
  await firstTile.hover();
  await firstTile.getByTitle("Add to selection").check();
  const selection = page.getByRole("toolbar", { name: "Selection actions" });
  await expect(selection).toContainText("1 photo selected");
  await selection.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(selection.getByRole("button", { name: "Clear selection" })).toHaveCount(0);
  await expect(selection.getByRole("button", { name: "Move to Trash" })).toBeVisible();
  await selection.getByRole("button", { name: "More selection actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Unfavorite", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await selection.getByRole("button", { name: "Deselect all" }).click();
  await expect(selection).toHaveCount(0);

  // The inline back action returns to the albums overview.
  await page.locator(".album-back-button").click();
  await expect(page.locator(".album-card").first()).toBeVisible();
});
