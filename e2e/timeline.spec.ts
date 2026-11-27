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

  // Even the newest year starts with month cover strips.
  await expect(toggle(page, "2026-10")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Show 31 items from October 2026" })).toBeVisible();

  // Expand it again from the cover strip.
  await page.getByRole("button", { name: "Show 31 items from October 2026" }).click();
  await expect(toggle(page, "2026-10")).toHaveAttribute("aria-expanded", "true");

  // Select all on a month selects the whole month; a second click clears it.
  const selectOctober = month(page, "2026-10").getByRole("button", { name: /Select all|Selected/ });
  await selectOctober.click();
  await expect(page.getByText("31 photos selected", { exact: true })).toBeVisible();
  await expect(selectOctober).toHaveAttribute("aria-pressed", "true");
  await selectOctober.click();
  await expect(selectOctober).toHaveAttribute("aria-pressed", "false");

  // One click jumps to the previous year: its newest month opens and scrolls
  // into view.
  await page.getByRole("button", { name: "Jump to 2025", exact: true }).click();
  await expect(toggle(page, "2025-12")).toHaveAttribute("aria-expanded", "true");
  await expect(month(page, "2025-12")).toBeInViewport();
  await expect(month(page, "2025-12").locator(".timeline-count")).toHaveText("31 items");

  // The month menu reaches any month.
  await page.getByRole("button", { name: "Jump to month" }).click();
  await page.getByRole("combobox", { name: "Year", exact: true }).selectOption("2025");
  await page.getByRole("button", { name: "June 2025", exact: true }).click();
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
  await expect(toggle(page, "2026-10")).toHaveAttribute("aria-expanded", "true");

  await openTimeline(page);
  await expect(toggle(page, "2026-10")).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page, "2026-11")).toHaveAttribute("aria-expanded", "false");
});

test("Hidden timeline counts and selects only hidden items", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.locator(".sidebar").getByRole("button", { name: "Hidden", exact: true }).click();
  await expect(page.locator(".gallery-tile")).toHaveCount(3);
  await page.getByRole("button", { name: "Timeline view", exact: true }).click();

  // The Hidden Timeline describes the hidden collection (three items across
  // two months), not the visible library's month counts.
  await expect(month(page, "2026-11")).toBeVisible();
  await expect(month(page, "2026-11").locator(".timeline-count")).toHaveText("1 item");
  await expect(month(page, "2026-10").locator(".timeline-count")).toHaveText("2 items");

  // Select all in a hidden month selects the hidden item only, never the
  // visible library's items in the same month.
  const selectNovember = month(page, "2026-11").getByRole("button", {
    name: /Select all|Selected/,
  });
  await selectNovember.click();
  await expect(page.getByText("1 photo selected", { exact: true })).toBeVisible();
  await expect(selectNovember).toHaveAttribute("aria-pressed", "true");

  expect(pageErrors).toEqual([]);
});

test("an old month opens and navigates without paging through the catalog", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await openTimeline(page);
  const pages = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __benchmark: { pages: { month?: string; cursor?: string; limit: number }[] };
          }
        ).__benchmark.pages,
    );
  await expect(toggle(page, "2025-06")).toHaveAttribute("aria-expanded", "false");
  expect((await pages()).every((p) => !p.month && !p.cursor && p.limit === 250)).toBe(true);
  await page.getByRole("button", { name: "Jump to month" }).click();
  await page.getByRole("combobox", { name: "Year", exact: true }).selectOption("2025");
  await page.getByRole("button", { name: "June 2025", exact: true }).click();
  const tiles = page
    .locator("#timeline-month-2025-06 ~ .gallery-tile")
    .locator(".tile-open-button");
  await expect(tiles.first()).toBeInViewport();
  const first = await tiles.nth(0).getAttribute("data-item-id");
  const second = await tiles.nth(1).getAttribute("data-item-id");
  await toggle(page, "2025-06").click();
  await toggle(page, "2025-06").click();
  await tiles.first().dblclick();
  const heading = page.locator(".viewer-screen .video-player-title h1");
  await expect(heading).toContainText(first!);
  await page.keyboard.press("k");
  await expect(heading).toContainText(second!);
  await page.getByRole("button", { name: "Edit photo", exact: true }).click();
  await expect(page.locator(".edit-title-group h1")).toContainText(second!);
  const calls = await pages();
  expect(calls.filter((p) => p.month === "2025-06")).toHaveLength(1);
  expect(calls.filter((p) => !p.month && p.cursor)).toEqual([]);
});

test("Hidden loads an older month through its own pager", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(URL + "&hiddenCount=600");
  await page.locator(".sidebar").getByRole("button", { name: "Hidden", exact: true }).click();
  await page.getByRole("button", { name: "Timeline view", exact: true }).click();
  await page.getByRole("button", { name: "Jump to month" }).click();
  await page.getByRole("combobox", { name: "Year", exact: true }).selectOption("2025");
  await page.getByRole("button", { name: "June 2025", exact: true }).click();
  const first = page.locator("#timeline-month-2025-06 + .gallery-tile .tile-open-button");
  await expect(first).toHaveAttribute("data-item-id", /^hidden-/);
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __benchmark: { pages: { month?: string; hidden: boolean; cursor?: string }[] };
        }
      ).__benchmark.pages,
  );
  expect(calls.filter((p) => p.month === "2025-06").map((p) => p.hidden)).toEqual([true]);
  expect(calls.filter((p) => !p.month && p.cursor)).toEqual([]);
});

test("a large partial month continues in scoped pages as its end approaches", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=600");
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Timeline view", exact: true }).click();
  await toggle(page, "2026-11").click();
  const tiles = page.locator(".layout-timeline .gallery-tile");
  await expect(tiles).toHaveCount(250);
  const marker = page.locator(".timeline-continuation");
  await marker.scrollIntoViewIfNeeded();
  await expect(tiles).toHaveCount(500);
  await marker.scrollIntoViewIfNeeded();
  await expect(tiles).toHaveCount(600);
  await expect(marker).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`year bar stays pinned and opaque in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1500, height: 900 });
    await openTimeline(page);
    const bar = page.locator(".timeline-jump");
    await expect(bar).toHaveCSS(
      "background-color",
      scheme === "dark" ? "rgb(11, 13, 18)" : "rgb(255, 255, 255)",
    );
    const scroller = page.locator(".library-grid-container");
    await scroller.evaluate((el) => {
      el.scrollTop = 500;
    });
    const top = (await bar.boundingBox())!.y;
    await scroller.evaluate((el) => {
      el.scrollTop = 1500;
    });
    await expect(bar).toBeInViewport({ ratio: 1 });
    expect((await bar.boundingBox())!.y).toBeCloseTo(top, 0);
  });
}

test("April 2024 starts folded and a date jump does not change its saved default", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  async function open() {
    await page.goto("/harness.html?benchmark=1000&dayStep=1");
    await page.waitForSelector(".gallery-tile");
    await page.getByRole("button", { name: "Timeline view", exact: true }).click();
  }
  await open();
  const april = toggle(page, "2024-04");
  await expect(april).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Jump to month" }).click();
  await page.getByRole("combobox", { name: "Year", exact: true }).selectOption("2024");
  await page.getByRole("button", { name: "April 2024", exact: true }).click();
  await expect(april).toHaveAttribute("aria-expanded", "true");
  await open();
  await expect(april).toHaveAttribute("aria-expanded", "false");
});
