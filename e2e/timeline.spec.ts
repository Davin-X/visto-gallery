import { expect, test, type Page } from "@playwright/test";

// 600 items one day apart, newest on 3 Nov 2026: 2026 and most of 2025.
const URL = "/harness.html?benchmark=600&dayStep=1";

async function openTimeline(page: Page) {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Timeline view", exact: true }).click();
  await expect(page.locator("#timeline-month-2026-11")).toBeVisible();
}

const month = (page: Page, key: string) => page.locator(`#timeline-month-${key}`);
const toggle = (page: Page, key: string) => month(page, key).locator(".timeline-month-toggle");

test("timeline months: catalog counts, collapse, whole-month select, jump", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.setViewportSize({ width: 1500, height: 900 });
  await openTimeline(page);

  // Counts come from the catalog: whole months, whatever is loaded.
  await expect(month(page, "2026-11").locator(".timeline-count")).toHaveText("3 items");
  await expect(month(page, "2026-10").locator(".timeline-count")).toHaveText("31 items");
  // The sort menu is locked to date order in the Timeline.
  await expect(page.getByRole("combobox", { name: "Sort library by" })).toBeDisabled();

  // Collapse a month: its tiles give way to a strip of covers.
  await toggle(page, "2026-10").click();
  await expect(toggle(page, "2026-10")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Show 31 items from October 2026" })).toBeVisible();

  // Expand it again from the cover strip.
  await page.getByRole("button", { name: "Show 31 items from October 2026" }).click();
  await expect(toggle(page, "2026-10")).toHaveAttribute("aria-expanded", "true");

  // Select all on a month selects the whole month; a second click clears it.
  const selectOctober = month(page, "2026-10").getByRole("button", { name: /Select all|Selected/ });
  await selectOctober.click();
  await expect(page.getByText("31 selected", { exact: true })).toBeVisible();
  await expect(selectOctober).toHaveAttribute("aria-pressed", "true");
  await selectOctober.click();
  await expect(selectOctober).toHaveAttribute("aria-pressed", "false");

  // One click jumps to the previous year: its newest month opens and scrolls
  // into view, loading the pages in between.
  await page.getByRole("button", { name: "2025", exact: true }).click();
  await expect(toggle(page, "2025-12")).toHaveAttribute("aria-expanded", "true");
  await expect(month(page, "2025-12")).toBeInViewport();
  await expect(month(page, "2025-12").locator(".timeline-count")).toHaveText("31 items");

  // The month menu reaches any month.
  await page.getByRole("combobox", { name: "Jump to month" }).selectOption("2025-06");
  await expect(month(page, "2025-06")).toBeInViewport();
  await expect(toggle(page, "2025-06")).toHaveAttribute("aria-expanded", "true");
  // Older years start folded; jumping opened only the months it went to.
  await expect(toggle(page, "2025-11")).toHaveAttribute("aria-expanded", "false");

  // Option-click folds everything.
  await toggle(page, "2025-06").click({ modifiers: ["Alt"] });
  await expect(toggle(page, "2025-06")).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page, "2026-11")).toHaveAttribute("aria-expanded", "false");

  expect(pageErrors).toEqual([]);
});

test("timeline collapse state survives a relaunch", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await openTimeline(page);
  await toggle(page, "2026-10").click();
  await expect(toggle(page, "2026-10")).toHaveAttribute("aria-expanded", "false");

  await openTimeline(page);
  await expect(toggle(page, "2026-10")).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page, "2026-11")).toHaveAttribute("aria-expanded", "true");
});
