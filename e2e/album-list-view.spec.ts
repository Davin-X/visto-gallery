import { expect, test } from "@playwright/test";

// The Albums screen can switch between cards and a dense table list. The order
// is the same stored order in both views, sizes come from the overview query,
// and the rows carry the same reorder affordance as the cards.
test("Albums screen toggles between cards and list view", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40&albums=4", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();

  await expect(page.locator(".albums-grid")).toBeVisible();
  await expect(page.locator(".albums-list-view")).toHaveCount(0);

  await page.getByRole("button", { name: "List view" }).click();

  await expect(page.locator(".albums-grid")).toHaveCount(0);
  const list = page.locator(".albums-list-view");
  await expect(list).toBeVisible();
  await expect(list.getByRole("button", { name: /^Name/ })).toBeVisible();
  await expect(list.locator(".list-view-row")).toHaveCount(4);

  // Each row shows items, a size and an updated date; the first row is the
  // first album from the cards order.
  const first = list.locator(".list-view-row").first();
  await expect(first).toContainText("Benchmark Album 0");
  await expect(first).toContainText("40 items");
  await expect(list.locator(".list-view-row").nth(1)).toContainText("0 items");
  await expect(list.locator(".list-view-row").first()).toContainText("120.0 MB");

  // Toggle back to cards — the same order, the toggle reflects state.
  await page.getByRole("button", { name: "Card view" }).click();
  await expect(page.locator(".albums-grid .album-card-wrap").first()).toContainText(
    "Benchmark Album 0",
  );
  await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("list rows offer the same actions as the cards and reorder in place", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40&albums=4", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await page.getByRole("button", { name: "List view" }).click();

  const rows = page.locator(".albums-list-view .list-view-row");
  await expect(rows.nth(0)).toContainText("Benchmark Album 0");

  await rows.nth(0).getByRole("button", { name: "Move Benchmark Album 0 later" }).click();
  await expect(rows.nth(0)).toContainText("Benchmark Album 1");
  await expect(rows.nth(1)).toContainText("Benchmark Album 0");

  // Toggle to cards and confirm the order follows.
  await page.getByRole("button", { name: "Card view" }).click();
  const cards = page.locator(".albums-grid .album-card-wrap");
  await expect(cards.nth(0)).toContainText("Benchmark Album 1");
  await expect(cards.nth(1)).toContainText("Benchmark Album 0");
});
