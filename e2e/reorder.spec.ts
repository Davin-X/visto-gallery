import { expect, test } from "@playwright/test";

// Regular albums can be reordered: a drag handle on each card plus Move
// earlier / Move later buttons in the card's hover action row. The order is
// persisted to the catalog, so a reload keeps it.
test("Move earlier / Move later buttons reorder album cards", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40&albums=6", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();

  const names = () => page.locator(".albums-grid .album-meta-name").allTextContents();

  expect((await names()).slice(0, 3)).toEqual([
    "Benchmark Album 0",
    "Benchmark Album 1",
    "Benchmark Album 2",
  ]);

  // The action row only exists while the card is hovered or focused.
  await page.locator(".albums-grid .album-card-wrap").first().hover();
  await page.getByRole("button", { name: "Move Benchmark Album 0 later" }).click();
  expect((await names()).slice(0, 3)).toEqual([
    "Benchmark Album 1",
    "Benchmark Album 0",
    "Benchmark Album 2",
  ]);

  await page.locator(".albums-grid .album-card-wrap").nth(1).hover();
  await page.getByRole("button", { name: "Move Benchmark Album 0 earlier" }).click();
  expect((await names()).slice(0, 3)).toEqual([
    "Benchmark Album 0",
    "Benchmark Album 1",
    "Benchmark Album 2",
  ]);

  // Edge cards cannot move further in the direction they are already on.
  await page.locator(".albums-grid .album-card-wrap").first().hover();
  await expect(page.getByRole("button", { name: "Move Benchmark Album 0 earlier" })).toBeDisabled();
  await page.locator(".albums-grid .album-card-wrap").nth(5).hover();
  await expect(page.getByRole("button", { name: "Move Benchmark Album 5 later" })).toBeDisabled();
});

test("dragging an album card by its handle reorders the grid", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40&albums=6", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();

  const cards = page.locator(".albums-grid .album-card-wrap");
  const movedName = await cards.nth(0).locator(".album-meta-name").textContent();

  await cards.nth(0).hover();
  const box = await cards.nth(3).boundingBox();
  await page.dragAndDrop(
    ".albums-grid .album-card-wrap:nth-child(1) .album-card-reorder",
    ".albums-grid .album-card-wrap:nth-child(4)",
    // Land on the left edge of the fourth card: “before it”, whatever the
    // card width happens to be.
    { targetPosition: { x: 24, y: box ? box.height / 2 : 40 } },
  );

  // The dropped card is inserted before the fourth card, not after it.
  await expect(cards.nth(2)).toContainText(movedName ?? "");
  expect(await page.locator(".albums-grid .album-meta-name").allTextContents()).toEqual([
    "Benchmark Album 1",
    "Benchmark Album 2",
    "Benchmark Album 0",
    "Benchmark Album 3",
    "Benchmark Album 4",
    "Benchmark Album 5",
  ]);
});
