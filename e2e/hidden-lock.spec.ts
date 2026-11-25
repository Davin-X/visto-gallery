import { expect, test, type Page } from "@playwright/test";

async function openApp(page: Page, query: string) {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`/harness.html?benchmark=20${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  const stats = page.locator(".sidebar-library-stats");
  await expect(stats).not.toHaveAttribute("open", "");
  await stats.locator("summary").click();
}

const hiddenNav = (page: Page) =>
  page.locator(".sidebar").getByRole("button", { name: "Hidden", exact: true });
const hiddenStat = (page: Page) => page.locator(".stat-row.hidden");

test("a locked Hidden asks for Touch ID and keeps its count out of the sidebar", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page, "&lock=1");

  // While locked, the sidebar does not show how much is hidden.
  await expect(hiddenStat(page)).toHaveCount(0);

  await hiddenNav(page).click();
  await expect(page.getByRole("region", { name: "Hidden is locked" })).toBeVisible();
  const unlock = page.getByRole("button", { name: "Unlock with Touch ID" });
  await expect(unlock).toBeVisible();
  // Nothing hidden is listed behind the lock.
  await expect(page.locator(".gallery-tile")).toHaveCount(0);

  await unlock.click();
  await expect(page.getByRole("region", { name: "Hidden is locked" })).toHaveCount(0);
  await expect(hiddenStat(page)).toBeVisible();
  await expect(hiddenStat(page)).toContainText("7");

  // Unlocked by its owner, Hidden shows its items plainly: no veil and no
  // hold-to-reveal on top of Touch ID.
  await expect(page.locator(".gallery-tile")).toHaveCount(3);
  await expect(page.locator(".gallery-tile.hidden-obscured")).toHaveCount(0);

  // Lock now: the header button locks at once, and the count goes too.
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page.getByRole("region", { name: "Hidden is locked" })).toBeVisible();
  await expect(page.locator(".gallery-tile")).toHaveCount(0);
  await expect(hiddenStat(page)).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("Hidden opens directly when the lock is off", async ({ page }) => {
  await openApp(page, "");
  await expect(hiddenStat(page)).toBeVisible();
  await hiddenNav(page).click();
  await expect(page.getByRole("region", { name: "Hidden is locked" })).toHaveCount(0);
  // Without the lock, hidden items stay veiled behind hold-to-reveal.
  await expect(page.locator(".gallery-tile")).toHaveCount(3);
  await expect(page.locator(".gallery-tile.hidden-obscured")).toHaveCount(3);
});
