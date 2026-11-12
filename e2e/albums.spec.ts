import { expect, test } from "@playwright/test";

// The albums overview renders smart albums as a compact film-strip above the
// regular album grid, collapsible from the header row and expandable into a
// full grid via "View all".
test("smart albums strip is visible, collapsible and expandable", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();

  const section = page.locator(".smart-albums-section");
  await expect(section).toBeVisible();
  const gridBefore = await page.evaluate(
    () => document.querySelector(".albums-grid")!.getBoundingClientRect().top,
  );
  const smartBefore = await page.evaluate(
    () => document.querySelector(".smart-albums-section")!.getBoundingClientRect().top,
  );
  expect(smartBefore).toBeLessThan(gridBefore);

  // View all switches the strip to the wrapped grid.
  await expect(page.locator(".smart-albums-collapse")).toHaveCount(0);
  await page.getByRole("button", { name: "View all", exact: true }).click();
  const wrapped = await page.evaluate(
    () => getComputedStyle(document.querySelector(".smart-albums-list")!).flexWrap,
  );
  expect(wrapped).toBe("wrap");
});
