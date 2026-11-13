import { expect, test } from "@playwright/test";

// Smart Albums are edited from the Albums screen: the head row owns creation,
// and each tile reveals edit/delete on hover or focus. The dialog is the only
// editor — no window.prompt.
test("smart album tiles reveal edit and delete actions on hover", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();

  const tile = page.locator(".smart-album-item").first();
  await expect(tile.locator(".smart-album-actions")).toBeHidden();

  await tile.hover();
  await expect(tile.locator(".smart-album-actions")).toBeVisible();
  await expect(tile.getByRole("button", { name: /^Edit / })).toBeVisible();
  await expect(tile.getByRole("button", { name: /^Delete / })).toBeVisible();
});

test("editing a smart album keeps its tile and applies the new definition", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();

  const tile = page.locator(".smart-album-item", { hasText: "Autumn shots" });
  await tile.hover();
  await tile.getByRole("button", { name: "Edit Autumn shots" }).click();

  const dialog = page.getByRole("dialog", { name: "Edit Smart Album" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveValue("Autumn shots");
  // The saved definition is loaded, not a blank form.
  await expect(dialog.getByLabel("Contains text")).toHaveValue("autumn");

  await dialog.getByLabel("Name").fill("Autumn 2026");
  await dialog.getByRole("button", { name: "5 stars and up" }).click();
  await dialog.getByRole("button", { name: "Save changes" }).click();

  await expect(dialog).toHaveCount(0);
  // Same tile, renamed in place — editing never recreates the album.
  const renamed = page.locator(".smart-album-item", { hasText: "Autumn 2026" });
  await expect(renamed).toHaveCount(1);

  await renamed.hover();
  await renamed.getByRole("button", { name: "Edit Autumn 2026" }).click();
  await expect(page.getByRole("dialog").getByLabel("Contains text")).toHaveValue("autumn");
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "5 stars and up" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("the head row creates a smart album without leaving the page", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();

  await page.getByRole("button", { name: "New smart album" }).click();

  const dialog = page.getByRole("dialog", { name: "New Smart Album" });
  await expect(dialog.getByRole("button", { name: "Create Smart Album" })).toBeDisabled();

  await dialog.getByLabel("Name").fill("Recent RAW");
  await dialog.getByRole("button", { name: "RAW" }).click();
  await expect(dialog.getByRole("button", { name: "Create Smart Album" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Create Smart Album" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".smart-album-item", { hasText: "Recent RAW" })).toHaveCount(1);
});

test("an empty Albums page offers both create paths exactly once", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=1&smartAlbums=0&albums=0", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();

  // The page-level empty state already carries both creates, so the Smart
  // Albums section does not repeat them above it.
  await expect(page.locator(".smart-albums-section")).toHaveCount(0);
  const emptyActions = page.locator(".empty-state-actions");
  await expect(emptyActions.getByRole("button", { name: "Create album" })).toBeVisible();
  await expect(emptyActions.getByRole("button", { name: "New smart album" })).toBeVisible();

  await emptyActions.getByRole("button", { name: "New smart album" }).click();
  await expect(page.getByRole("dialog", { name: "New Smart Album" })).toBeVisible();
});

test("the Smart Albums hint appears when only regular albums exist", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40&smartAlbums=0", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();

  const section = page.getByRole("region", { name: "Smart Albums" });
  await expect(section.locator(".smart-albums-empty")).toBeVisible();
  await expect(section.locator(".smart-albums-count")).toHaveCount(0);

  await section.getByRole("button", { name: "New smart album" }).click();
  const dialog = page.getByRole("dialog", { name: "New Smart Album" });
  await dialog.getByLabel("Name").fill("Five stars");
  await dialog.getByRole("button", { name: "5 stars and up" }).click();
  await dialog.getByRole("button", { name: "Create Smart Album" }).click();

  await expect(page.locator(".smart-albums-empty")).toHaveCount(0);
  await expect(page.locator(".smart-album-item", { hasText: "Five stars" })).toHaveCount(1);
  await expect(section.locator(".smart-albums-count")).toHaveText("1 album");
});
