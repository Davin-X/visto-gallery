import { expect, test } from "@playwright/test";

test("compact filters keep Save in reach and return to the gallery", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 680 });
  await page.goto("/harness.html?benchmark=200");
  const filters = page.getByRole("button", { name: /^Filters(?: \d+)?$/ });
  await filters.click();
  const panel = page.getByRole("dialog", { name: "Filters" });
  await panel.getByRole("button", { name: "3 stars and up" }).click();
  const save = panel.getByRole("button", { name: "Save", exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(filters).toBeFocused();
  await page.getByRole("button", { name: "View options" }).click();
  await expect(page.getByRole("combobox", { name: "Sort library by" })).toBeVisible();
});

test("Escape dismisses viewer actions before leaving the photo", async ({ page }) => {
  await page.goto("/harness.html?benchmark=10");
  await page.locator(".tile-open-button").first().dblclick();
  const more = page.getByRole("button", { name: "More actions" });
  await more.click();
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".viewer-screen")).toHaveCount(0);
});

test("batch selection lets a user inspect and remove a file past the first ten", async ({
  page,
}) => {
  await page.goto("/harness.html?benchmark=16");
  await page.locator(".gallery-tile").first().waitFor();
  await page.getByRole("button", { name: "Batch", exact: true }).click();
  await page.getByRole("button", { name: "Select all visible", exact: true }).click();
  await page.getByText("View all 16 files", { exact: true }).click();
  const entry = page.locator(".batch-all-files li").filter({ hasText: "benchmark-15.jpg" });
  await expect(entry).toBeVisible();
  await entry.getByRole("button").click();
  await expect(entry).toHaveCount(0);
  await expect(page.getByText("View all 15 files", { exact: true })).toBeVisible();
});
